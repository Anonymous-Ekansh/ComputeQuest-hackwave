// Web Worker for distributed matrix multiplication & Inference Pipeline

import {
  runEmbedding,
  runDecoderLayer,
  runFinalHead,
  loadEmbeddingWeights,
  loadLayerWeights,
  loadFinalHeadWeights,
  uploadBuf,
  readBuffer
} from '../llm/webgpu-kernels.js';

// Global cache for model weights (Fixes Bug 2: VRAM leak on clear_session)
let cachedModel = null;
let loadingPromise = null;

async function ensureModelLoaded(onProgress) {
  if (cachedModel) return cachedModel;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();

      const manifestController = new AbortController();
      const manifestTimer = setTimeout(() => manifestController.abort(), 15000);
      let rawManifest;
      try {
        const manifestRes = await fetch(`${MODEL_BASE_URL}/manifest.json`, { signal: manifestController.signal });
        if (!manifestRes.ok) throw new Error(`HTTP ${manifestRes.status}`);
        rawManifest = await manifestRes.json();
      } finally {
        clearTimeout(manifestTimer);
      }
      const files = rawManifest.files;
      const vocabSize = rawManifest.vocab_size || 32000;

      let totalBytes = 0;
      for (const f of files) {
        totalBytes += f.size_bytes;
      }
      
      let loadedBytes = 0;
      const getFileEntry = (fname) => {
        const entry = files.find(f => f.filename === fname);
        if (!entry) throw new Error(`File not found in manifest: ${fname}`);
        return entry;
      };

      const loadFile = async (fname, entry) => {
        const buf = await readBin(fname, entry.size_bytes);
        loadedBytes += entry.size_bytes;
        if (onProgress) {
          onProgress(loadedBytes, totalBytes, `Loaded ${fname}`);
        }
        return buf;
      };

      const model = {
        device,
        embedding: null,
        layers: [],
        finalHead: null,
        vocabSize
      };

      const embedEntry = getFileEntry('embedding.bin');
      const headEntry = getFileEntry('final_head.bin');
      const layerEntries = [];
      for (let i = 0; i <= 21; i++) {
        const fname = `layers/layer_${i.toString().padStart(2, '0')}.bin`;
        layerEntries.push({ fname, i, entry: getFileEntry(fname) });
      }

      const allPromises = [];
      
      const pEmbed = loadFile('embedding.bin', embedEntry).then(buf => {
        model.embedding = loadEmbeddingWeights(device, buf, embedEntry.tensors);
      });
      allPromises.push(pEmbed);

      const pHead = loadFile('final_head.bin', headEntry).then(buf => {
        model.finalHead = loadFinalHeadWeights(device, buf, headEntry.tensors);
      });
      allPromises.push(pHead);

      const layerResults = [];
      for (const { fname, i, entry } of layerEntries) {
        const pLayer = loadFile(fname, entry).then(buf => {
          layerResults.push({ i, buf, entry });
        });
        allPromises.push(pLayer);
      }

      await Promise.all(allPromises);

      layerResults.sort((a, b) => a.i - b.i);
      for (const res of layerResults) {
        model.layers.push({
          weights: loadLayerWeights(device, res.buf, res.entry.tensors)
        });
      }

      cachedModel = model;
      loadingPromise = null;
      return model;
    } catch (err) {
      loadingPromise = null;
      throw err;
    }
  })();

  return loadingPromise;
}

// Pipeline State
// sessionId -> { kvCaches: [] }
const pipelineSessions = new Map();

const MODEL_BASE_URL = import.meta.env.VITE_MODEL_URL || 'https://huggingface.co/datasets/iamekansh/hackwave/resolve/main';

async function readBin(filename, size_bytes = 0) {
  const timeoutMs = Math.max(20000, ((size_bytes / 1000000) * 1000) + 15000);
  let attempt = 0;
  let lastErr = null;
  while (attempt < 2) {
    attempt++;
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${MODEL_BASE_URL}/${filename}`, { signal: controller.signal });
      clearTimeout(timerId);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.arrayBuffer();
    } catch (err) {
      clearTimeout(timerId);
      lastErr = err;
      if (attempt < 2) {
        console.warn(`[Worker] Retrying ${filename} (attempt ${attempt + 1})...`);
      }
    }
  }
  throw new Error(`Failed to load ${filename} after 2 attempts: ${lastErr.message}`);
}

self.onmessage = async function (e) {
  const data = e.data;
  const type = data.type || 'MATRIX_MULTIPLY';

  if (type === 'MATRIX_MULTIPLY') {
    // ── LEGACY MATRIX MULTIPLY ROUTE ──
    const { taskId, chunkId, chunkData, startRow, rowCount, totalRows } = data;
    const { rowsA, matrixB } = chunkData;

    const cols = matrixB[0].length;
    const inner = matrixB.length;

    const startTime = Date.now();

    const resultRows = [];
    for (let i = 0; i < rowsA.length; i++) {
      const row = [];
      for (let j = 0; j < cols; j++) {
        let sum = 0;
        for (let k = 0; k < inner; k++) {
          sum += rowsA[i][k] * matrixB[k][j];
        }
        row.push(sum);
      }
      resultRows.push(row);
    }

    const computeMs = Date.now() - startTime;

    self.postMessage({
      type: 'chunk_result',
      taskId,
      chunkId,
      resultRows,
      computeMs,
      startRow,
      rowCount,
      totalRows,
    });
    return;
  }

    if (type === 'start_background_warmup') {
      if (cachedModel) {
        self.postMessage({ type: 'node_warm_ready' });
        return;
      }
      
      ensureModelLoaded((loadedBytes, totalBytes, label) => {
        const percentComplete = Math.round((loadedBytes / totalBytes) * 100);
        self.postMessage({ 
          type: 'node_warm_progress', 
          percent: percentComplete,
          loadedBytes,
          totalBytes,
          label
        });
      }).then(() => {
        self.postMessage({ type: 'node_warm_ready' });
      }).catch(err => {
        console.error("[Worker] Background warmup failed:", err);
      });
      return;
    }

  if (type === 'stage_assign') {
    // ── PIPELINE INITIALIZATION ──
    try {
      const { sessionId, stageIndex, layerRange, role } = data; // role='all', layerRange=[0, 21]
      
      if (!navigator.gpu) throw new Error("WebGPU not supported");

      // Load model globally once
      await ensureModelLoaded((loadedBytes, totalBytes, label) => {
        const percentComplete = Math.round((loadedBytes / totalBytes) * 100);
        self.postMessage({ 
          type: 'node_warm_progress', 
          percent: percentComplete,
          loadedBytes,
          totalBytes,
          label
        });
      });
      
      self.postMessage({ type: 'node_warm_ready' });

      // Initialize KV caches for this session
      const sessionData = {
        kvCaches: cachedModel.layers.map(() => ({ length: 0 }))
      };
      pipelineSessions.set(sessionId, sessionData);

      self.postMessage({
        type: 'stage_ready',
        sessionId,
        stageIndex
      });
    } catch (err) {
      console.error("[Worker] Pipeline Init Error:", err);
      self.postMessage({
        type: 'stage_error',
        sessionId: data.sessionId,
        error: err.message
      });
    }
    return;
  }

  if (type === 'forward_request') {
    // ── REQUEST-PARALLEL COMPUTE PASS ──
    try {
      const { sessionId, tokenIndex } = data;
      const session = pipelineSessions.get(sessionId);
      if (!session) throw new Error("Unknown session");

      const { device, vocabSize, embedding, layers, finalHead } = cachedModel;
      
      let positionId = 0;
      let currentTokens = Array.isArray(tokenIndex) ? tokenIndex : [tokenIndex];
      let isGenerating = true;

      while (isGenerating) {
        // Yield to event loop to process clear_session messages
        await new Promise(r => setTimeout(r, 0));
        if (!pipelineSessions.has(sessionId)) break;

        const seqLen = currentTokens.length;
        let currentStateBuf = runEmbedding(device, embedding, currentTokens, vocabSize);

        for (let i = 0; i < layers.length; i++) {
          const layer = layers[i];
          const kvCache = session.kvCaches[i];
          const res = runDecoderLayer(device, layer.weights, currentStateBuf, seqLen, kvCache, positionId);
          
          currentStateBuf.destroy(); // Always destroy since it's the result of runEmbedding or previous runDecoderLayer
          
          currentStateBuf = res.hiddenStates;
          session.kvCaches[i] = res.kvCache;
        }

        const logitsBuf = runFinalHead(device, finalHead, currentStateBuf, seqLen, vocabSize);
        
        // Fix Bug 3: readBuffer out-of-bounds crash
        const logits = await readBuffer(device, logitsBuf, vocabSize);
        logitsBuf.destroy();
        currentStateBuf.destroy();
        
        let maxVal = -Infinity;
        let maxIdx = 0;
        for (let i = 0; i < vocabSize; i++) {
          if (logits[i] > maxVal) {
            maxVal = logits[i];
            maxIdx = i;
          }
        }
        
        const generatedTokenId = maxIdx;

        self.postMessage({
          type: 'forward_response',
          sessionId,
          stageIndex: 0,
          tokenId: generatedTokenId
        });

        positionId += seqLen;
        currentTokens = [generatedTokenId];

        // Break if we hit EOS or if we generate too many tokens as a safeguard
        if (generatedTokenId === 2) {
          isGenerating = false;
        }
      }

    } catch (err) {
      console.error("[Worker] Forward pass error:", err);
      self.postMessage({
        type: 'stage_error',
        sessionId: data.sessionId,
        error: err.message
      });
    }
    return;
  }

  if (type === 'clear_session') {
    // ── CLEANUP SESSION VRAM ──
    const { sessionId } = data;
    const session = pipelineSessions.get(sessionId);
    if (session) {
      // Destroy kvCaches to prevent VRAM memory fragmentation
      for (const cache of session.kvCaches) {
        if (cache && cache.k) {
          cache.k.destroy();
          cache.v.destroy();
        }
      }
      pipelineSessions.delete(sessionId);
      console.log(`[Worker] Destroyed session ${sessionId} KV caches`);
    }
    return;
  }
};
