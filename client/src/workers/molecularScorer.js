// ─────────────────────────────────────────────────────────────────────────────
// molecularScorer.js — ChemBERTa embedding + cosine similarity scoring
//
// Uses DeepChem/ChemBERTa-77M-MTR via Transformers.js to embed molecules,
// then scores each candidate by cosine similarity to known reference antibiotics.
//
// This is a structural-similarity proxy for bioactivity — not a trained
// antibacterial classifier. It captures molecular structure/property patterns
// and finds candidates that "look like" known antibiotics in embedding space.
//
// All inference runs in a Web Worker — no main thread blocking.
// The model is cached by Transformers.js in the browser after first download.
// ─────────────────────────────────────────────────────────────────────────────

import { pipeline, env } from '@huggingface/transformers';

// ── Configuration ────────────────────────────────────────────────────────────

// Allow loading from HuggingFace Hub (Transformers.js caches automatically)
env.allowLocalModels = false;

const MODEL_ID = 'iamekansh/chemberta-77m-mtr-onnx';

// ── Model Pipeline Singleton ─────────────────────────────────────────────────

let extractor = null;
let extractorPromise = null;

/**
 * Lazily initialize the ChemBERTa feature extraction pipeline.
 * Follows the same singleton pattern as the old RDKit loader.
 *
 * @param {(progress: object) => void} [onProgress] - optional progress callback
 * @returns {Promise<object>} The initialized pipeline
 */
export async function ensureModel(onProgress) {
  if (extractor) return extractor;
  if (extractorPromise) return extractorPromise;

  console.log('[MolecularScorer] Loading ChemBERTa-77M-MTR...');
  extractorPromise = (async () => {
    try {
      const pipe = await pipeline('feature-extraction', MODEL_ID, {
        dtype: 'fp32',
        progress_callback: (progress) => {
          if (onProgress && progress.status === 'progress') {
            onProgress({
              progress: progress.progress / 100,
              text: progress.file ? `Loading ${progress.file}...` : 'Loading model...',
            });
          }
        },
      });
      extractor = pipe;
      extractorPromise = null;
      console.log('[MolecularScorer] ChemBERTa ready.');
      return pipe;
    } catch (err) {
      extractorPromise = null;
      throw err;
    }
  })();

  return extractorPromise;
}

// ── Embedding Cache ──────────────────────────────────────────────────────────

// Cache embeddings for reference antibiotics (computed once per session)
let referenceEmbeddingCache = null;

/**
 * Compute the embedding for a single SMILES string.
 * Uses mean pooling over all token embeddings.
 *
 * @param {string} smiles - SMILES string
 * @returns {Promise<Float32Array|null>} Embedding vector or null on failure
 */
async function embedSmiles(smiles) {
  try {
    const pipe = await ensureModel();

    // Run feature extraction — returns nested arrays [batch][tokens][hidden]
    const output = await pipe(smiles, { pooling: 'mean', normalize: true });

    // output.data is a Float32Array of the pooled embedding
    return output.data;
  } catch (err) {
    console.error(`[MolecularScorer] Error embedding "${smiles}":`, err?.message || err);
    return null;
  }
}

/**
 * Compute embeddings for a batch of SMILES strings.
 *
 * @param {string[]} smilesList - Array of SMILES strings
 * @returns {Promise<Array<Float32Array|null>>} Array of embeddings
 */
async function embedBatch(smilesList) {
  // Process sequentially to avoid OOM in the worker
  const embeddings = [];
  for (const smiles of smilesList) {
    const emb = await embedSmiles(smiles);
    embeddings.push(emb);
  }
  return embeddings;
}

// ── Cosine Similarity ────────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 *
 * @param {Float32Array|number[]} a
 * @param {Float32Array|number[]} b
 * @returns {number} Cosine similarity in [-1, 1]
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Score a candidate molecule by max cosine similarity to the reference set.
 *
 * @param {Float32Array} candidateEmbedding
 * @param {Array<{name: string, embedding: Float32Array|number[]}>} references
 * @returns {{ similarity: number, closestRef: string }}
 */
function scoreAgainstReferences(candidateEmbedding, references) {
  if (!candidateEmbedding || !references || references.length === 0) {
    return { similarity: 0, closestRef: 'none' };
  }

  let maxSim = -1;
  let closestRef = 'none';

  for (const ref of references) {
    const sim = cosineSimilarity(candidateEmbedding, ref.embedding);
    if (sim > maxSim) {
      maxSim = sim;
      closestRef = ref.name;
    }
  }

  return {
    similarity: Math.round(maxSim * 10000) / 10000,
    closestRef,
  };
}

// ── Main Scoring Functions ───────────────────────────────────────────────────

/**
 * Prepare reference embeddings from pre-computed data or compute fresh.
 * Called once per session when the first batch arrives.
 *
 * @param {Array<{name: string, smiles: string}>} referenceAntibiotics
 * @param {Array<{name: string, embedding: number[]}>|null} precomputed - server-provided embeddings
 */
export async function prepareReferenceEmbeddings(referenceAntibiotics, precomputed) {
  if (referenceEmbeddingCache) return referenceEmbeddingCache;

  if (precomputed && precomputed.length > 0) {
    // Use server-provided pre-computed embeddings
    console.log(`[MolecularScorer] Using ${precomputed.length} pre-computed reference embeddings`);
    referenceEmbeddingCache = precomputed.map(p => ({
      name: p.name,
      embedding: p.embedding instanceof Float32Array ? p.embedding : new Float32Array(p.embedding),
    }));
    return referenceEmbeddingCache;
  }

  // Compute reference embeddings locally (first time only)
  console.log(`[MolecularScorer] Computing ${referenceAntibiotics.length} reference embeddings locally...`);
  const refs = [];
  for (const antibiotic of referenceAntibiotics) {
    const embedding = await embedSmiles(antibiotic.smiles);
    if (embedding) {
      refs.push({ name: antibiotic.name, embedding });
      console.log(`  ✓ ${antibiotic.name}`);
    } else {
      console.warn(`  ✗ Failed to embed ${antibiotic.name}`);
    }
  }

  referenceEmbeddingCache = refs;
  return referenceEmbeddingCache;
}

/**
 * Score a batch of candidate molecules against reference antibiotics.
 * This is the main entry point called by computeWorker.js.
 *
 * @param {Array<{smiles: string, id?: string, name?: string}>} molecules
 * @param {Array<{name: string, smiles: string}>} referenceAntibiotics
 * @param {Array<{name: string, embedding: number[]}>|null} precomputedEmbeddings
 * @returns {Promise<Array<{smiles: string, similarity: number, closestRef: string}|null>>}
 */
export async function scoreMoleculeBatch(molecules, referenceAntibiotics, precomputedEmbeddings) {
  // Ensure reference embeddings are ready
  const references = await prepareReferenceEmbeddings(referenceAntibiotics, precomputedEmbeddings);

  if (references.length === 0) {
    console.error('[MolecularScorer] No reference embeddings available — cannot score');
    return molecules.map(() => null);
  }

  const results = [];

  for (const mol of molecules) {
    if (!mol || !mol.smiles) {
      results.push(null);
      continue;
    }

    try {
      const embedding = await embedSmiles(mol.smiles);
      if (!embedding) {
        results.push(null);
        continue;
      }

      const { similarity, closestRef } = scoreAgainstReferences(embedding, references);

      results.push({
        smiles: mol.smiles,
        similarity,
        closestRef,
      });
    } catch (err) {
      console.error(`[MolecularScorer] Error scoring ${mol.smiles}:`, err?.message);
      results.push(null);
    }
  }

  return results;
}
