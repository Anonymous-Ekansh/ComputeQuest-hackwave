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

// Pipeline State
// sessionId -> { device, embedding, layers: [ { weights, kvCache } ], finalHead }
const pipelineSessions = new Map();

const MODEL_BASE_URL = import.meta.env.VITE_MODEL_URL || 'http://localhost:3001/models';

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

  if (type === 'stage_assign') {
    // ── PIPELINE STAGE INITIALIZATION ──
    try {
      const { sessionId, stageIndex, layerRange, role } = data;
      
      if (!navigator.gpu) throw new Error("WebGPU not supported");
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
      const files = rawManifest.files;  // array of { filename, tensors, size_bytes, ... }
      const vocabSize = rawManifest.vocab_size || 32000;

      // Helper: find a file entry by filename
      const getFileEntry = (fname) => {
        const entry = files.find(f => f.filename === fname);
        if (!entry) throw new Error(`File not found in manifest: ${fname}`);
        console.log(`[Worker] Loaded ${fname}: ${entry.tensors.length} tensors`);
        return entry;
      };

      const sessionData = {
        device,
        embedding: null,
        layers: [],
        finalHead: null,
        role,
        layerRange,
        vocabSize
      };

      if (role === 'embedding' || role === 'all') {
        const entry = getFileEntry('embedding.bin');
        self.postMessage({ type: 'stage_progress', sessionId, detail: `Downloading embedding.bin…` });
        const embedBuf = await readBin('embedding.bin', entry.size_bytes);
        sessionData.embedding = loadEmbeddingWeights(device, embedBuf, entry.tensors);
      }

      for (let i = layerRange[0]; i <= layerRange[1]; i++) {
        const layerFile = `layers/layer_${i.toString().padStart(2, '0')}.bin`;
        const entry = getFileEntry(layerFile);
        self.postMessage({ type: 'stage_progress', sessionId, detail: `Downloading ${layerFile}…` });
        const lBuf = await readBin(layerFile, entry.size_bytes);
        
        // Initial empty kvCache for this layer
        const kvCache = { length: 0 };

        sessionData.layers.push({
          weights: loadLayerWeights(device, lBuf, entry.tensors),
          kvCache
        });
      }

      if (role === 'lm_head' || role === 'all') {
        const entry = getFileEntry('final_head.bin');
        self.postMessage({ type: 'stage_progress', sessionId, detail: `Downloading final_head.bin…` });
        const finalBuf = await readBin('final_head.bin', entry.size_bytes);
        sessionData.finalHead = loadFinalHeadWeights(device, finalBuf, entry.tensors);
      }

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
    // ── PIPELINE COMPUTE PASS ──
    try {
      const { sessionId, stageIndex, hiddenStates: rawHiddenStates, positionId, tokenIndex } = data;
      const hiddenStates = rawHiddenStates ? Float32Array.from(rawHiddenStates) : null;
      const session = pipelineSessions.get(sessionId);
      if (!session) throw new Error("Unknown session");

      const { device } = session;
      // currentState starts as either Float32Array from network or undefined (if prefill)
      let currentStateBuf = null;

      // 1. Embedding (if stage 0)
      if (session.role === 'embedding' || session.role === 'all') {
        // tokenIndex is an array of token IDs for prefill, or [tokenId] for autoregressive
        const tokens = Array.isArray(tokenIndex) ? tokenIndex : [tokenIndex];
        // runEmbedding returns a GPUBuffer
        currentStateBuf = runEmbedding(device, session.embedding, tokens, session.vocabSize);
      } else {
        // Not stage 0: upload the incoming float32 array to a GPUBuffer
        currentStateBuf = uploadBuf(device, hiddenStates);
      }

      // 2. Decoder Layers
      // Determine how many tokens we are processing (seqLen)
      // If it's stage 0, hiddenStates is null.
      const seqLen = (session.role === 'embedding' || session.role === 'all') 
          ? (Array.isArray(tokenIndex) ? tokenIndex.length : 1) 
          : hiddenStates.length / 2048;

      for (let i = 0; i < session.layers.length; i++) {
        const layer = session.layers[i];
        // runDecoderLayer returns { hiddenStates: GPUBuffer, kvCache: Object }
        const res = runDecoderLayer(device, layer.weights, currentStateBuf, seqLen, layer.kvCache, positionId);
        
        // Destroy intermediate buffer if it's not the initial one uploaded
        if (i > 0) currentStateBuf.destroy();
        
        currentStateBuf = res.hiddenStates;
        layer.kvCache = res.kvCache;
      }

      // 3. Final Head (if last stage)
      if (session.role === 'lm_head' || session.role === 'all') {
        const logitsBuf = runFinalHead(device, session.finalHead, currentStateBuf, seqLen, session.vocabSize);
        const logits = await readBuffer(device, logitsBuf, seqLen * session.vocabSize);
        logitsBuf.destroy();
        currentStateBuf.destroy();
        
        // Argmax only on the last token's logits
        let maxVal = -Infinity;
        let maxIdx = 0;
        const offset = (seqLen - 1) * session.vocabSize;
        for (let i = 0; i < session.vocabSize; i++) {
          if (logits[offset + i] > maxVal) {
            maxVal = logits[offset + i];
            maxIdx = i;
          }
        }
        
        self.postMessage({
          type: 'forward_response',
          sessionId,
          stageIndex,
          tokenId: maxIdx
        });
      } else {
        // Pass hidden state to next stage
        const nextStageHiddenStates = await readBuffer(device, currentStateBuf, seqLen * 2048);
        currentStateBuf.destroy();
        
        self.postMessage({
          type: 'forward_response',
          sessionId,
          stageIndex,
          hiddenStates: nextStageHiddenStates // sending Float32Array over postMessage
        });
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
    // ── CLEANUP VRAM ──
    const { sessionId } = data;
    const session = pipelineSessions.get(sessionId);
    if (session) {
      // Destroy kvCaches to prevent VRAM memory fragmentation
      for (const layer of session.layers) {
        if (layer.kvCache && layer.kvCache.k) {
          layer.kvCache.k.destroy();
          layer.kvCache.v.destroy();
        }
      }
      pipelineSessions.delete(sessionId);
      console.log(`[Worker] Destroyed session ${sessionId} KV caches`);
    }
    return;
  }
};
