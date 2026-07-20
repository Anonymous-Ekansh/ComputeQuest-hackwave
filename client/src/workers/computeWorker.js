// Web Worker for distributed molecular screening & AI Inference via WebLLM
// 
// Molecule Screening:
//   Uses ChemBERTa-77M-MTR (via Transformers.js) to embed SMILES strings
//   and score them by cosine similarity to reference antibiotics.
//   Each node does real ML inference — the work is genuinely distributed
//   across multiple browser tabs.
//
// AI Inference:
//   Each browser tab loads the full TinyLlama model via WebLLM.
//   The server routes user prompts to idle (preferably warm) nodes.
//   Each node performs full text generation locally and streams tokens back.

import { CreateMLCEngine } from '@mlc-ai/web-llm';
import { scoreMoleculeBatch, ensureModel } from './molecularScorer.js';

// ── WebLLM Engine (singleton) ────────────────────────────────────────────────
let engine = null;
let enginePromise = null;

const MODEL_ID = 'TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC';

async function ensureEngine(onProgress) {
  if (engine) return engine;
  if (enginePromise) return enginePromise;

  console.log('[Worker] Initializing WebLLM engine...');
  enginePromise = (async () => {
    try {
      const eng = await CreateMLCEngine(MODEL_ID, {
        initProgressCallback: (report) => {
          if (onProgress) {
            onProgress(report);
          }
        }
      });
      engine = eng;
      enginePromise = null;
      console.log('[Worker] WebLLM engine ready.');
      return eng;
    } catch (err) {
      enginePromise = null;
      throw err;
    }
  })();

  return enginePromise;
}

// ── Active generation sessions (to support cancellation) ─────────────────────
const activeSessions = new Set();

// ── ChemBERTa model preloading ───────────────────────────────────────────────
let chemBertaLoading = false;

// ── Message Handler ──────────────────────────────────────────────────────────
self.onmessage = async function (e) {
  const data = e.data;
  const type = data.type;

  // ── MOLECULE SCREENING — ChemBERTa + cosine similarity ─────────────
  if (type === 'molecule_batch') {
    const { taskId, batchId, molecules, modelVersion, referenceAntibiotics, referenceEmbeddings } = data;

    // Report ChemBERTa loading progress (first time only)
    if (!chemBertaLoading) {
      chemBertaLoading = true;
      ensureModel((progress) => {
        self.postMessage({
          type: 'chemberta_progress',
          percent: Math.round(progress.progress * 100),
          label: progress.text || 'Loading ChemBERTa...',
        });
      }).catch(() => {});
    }

    const startTime = Date.now();

    // Score the batch — each molecule gets embedded by ChemBERTa
    // and scored by cosine similarity to reference antibiotics
    const results = await scoreMoleculeBatch(
      molecules,
      referenceAntibiotics || [],
      referenceEmbeddings || null
    );

    const computeMs = Date.now() - startTime;

    self.postMessage({
      type: 'molecule_batch_result',
      taskId,
      batchId,
      results,
      computeMs,
      modelVersion: modelVersion || 'v1',
    });
    return;
  }

  // ── BACKGROUND WARMUP ──────────────────────────────────────────────────
  if (type === 'start_background_warmup') {
    if (engine) {
      self.postMessage({ type: 'node_warm_ready' });
      return;
    }

    ensureEngine((report) => {
      const percent = Math.round(report.progress * 100);
      self.postMessage({
        type: 'node_warm_progress',
        percent,
        loadedBytes: 0,
        totalBytes: 0,
        label: report.text || 'Loading model...'
      });
    }).then(() => {
      self.postMessage({ type: 'node_warm_ready' });
    }).catch(err => {
      console.error('[Worker] Background warmup failed:', err);
    });
    return;
  }

  // ── PIPELINE INITIALIZATION (stage_assign) ─────────────────────────────
  if (type === 'stage_assign') {
    const { sessionId, stageIndex } = data;
    try {
      if (!navigator.gpu) throw new Error('WebGPU not supported');

      await ensureEngine((report) => {
        const percent = Math.round(report.progress * 100);
        self.postMessage({
          type: 'node_warm_progress',
          percent,
          loadedBytes: 0,
          totalBytes: 0,
          label: report.text || 'Loading model...'
        });
      });

      self.postMessage({ type: 'node_warm_ready' });
      self.postMessage({ type: 'stage_ready', sessionId, stageIndex });
    } catch (err) {
      console.error('[Worker] Pipeline init error:', err);
      self.postMessage({ type: 'stage_error', sessionId, error: err.message });
    }
    return;
  }

  // ── TEXT GENERATION (forward_request) ───────────────────────────────────
  if (type === 'forward_request') {
    const { sessionId, prompt } = data;
    activeSessions.add(sessionId);

    try {
      const eng = await ensureEngine();

      // Reset chat so each prompt is independent
      await eng.resetChat();

      const stream = await eng.chat.completions.create({
        messages: [
          { role: 'system', content: 'You are a helpful AI assistant.' },
          { role: 'user', content: prompt }
        ],
        stream: true,
        max_tokens: 256,
        temperature: 0.7,
        top_p: 0.9
      });

      for await (const chunk of stream) {
        // Check if session was cancelled
        if (!activeSessions.has(sessionId)) break;

        const text = chunk.choices[0]?.delta?.content || '';
        if (text) {
          self.postMessage({
            type: 'forward_response',
            sessionId,
            tokenText: text
          });
        }
      }

      // Signal generation complete
      if (activeSessions.has(sessionId)) {
        self.postMessage({
          type: 'forward_response',
          sessionId,
          tokenText: '',
          isComplete: true
        });
      }

      activeSessions.delete(sessionId);
    } catch (err) {
      console.error('[Worker] Generation error:', err);
      activeSessions.delete(sessionId);
      self.postMessage({
        type: 'stage_error',
        sessionId,
        error: err.message
      });
    }
    return;
  }

  // ── SESSION CLEANUP ────────────────────────────────────────────────────
  if (type === 'clear_session') {
    const { sessionId } = data;
    activeSessions.delete(sessionId);
    if (engine) {
      try { await engine.resetChat(); } catch (e) { /* ignore */ }
    }
    return;
  }
};
