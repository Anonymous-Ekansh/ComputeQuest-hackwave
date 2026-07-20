/**
 * server/src/modelRegistry.js — Tracks active model version, serves info to clients
 *
 * The model registry ensures all nodes use the same model version so
 * their scores are comparable and consensus is meaningful.
 */

const fs = require('fs');
const path = require('path');

// ── Model Config ─────────────────────────────────────────────────────────────

let modelConfig = null;
let referenceEmbeddings = null;

/**
 * Load model configuration and reference data from disk.
 * Called once at server startup.
 */
function loadModelConfig() {
  // Load reference antibiotics config
  const refPath = path.join(__dirname, '..', 'data', 'reference_antibiotics.json');
  try {
    modelConfig = JSON.parse(fs.readFileSync(refPath, 'utf-8'));
    console.log(`[modelRegistry] Loaded model config: ${modelConfig.model_id} (${modelConfig.model_version})`);
    console.log(`[modelRegistry] ${modelConfig.reference_antibiotics.length} reference antibiotics defined`);
  } catch (err) {
    console.error('[modelRegistry] Failed to load reference_antibiotics.json:', err.message);
    modelConfig = {
      model_id: 'iamekansh/chemberta-77m-mtr-onnx',
      model_version: 'v1',
      embedding_dim: 384,
      scoring_method: 'cosine_similarity_to_references',
      reference_antibiotics: [],
    };
  }

  // Try to load pre-computed reference embeddings
  const embPath = path.join(__dirname, '..', 'data', 'reference_embeddings.json');
  try {
    referenceEmbeddings = JSON.parse(fs.readFileSync(embPath, 'utf-8'));
    console.log(`[modelRegistry] Loaded ${referenceEmbeddings.embeddings.length} pre-computed reference embeddings (${referenceEmbeddings.embedding_dim}d)`);
  } catch {
    console.log('[modelRegistry] No pre-computed reference embeddings found — nodes will compute locally');
    referenceEmbeddings = null;
  }
}

/**
 * Get model info to send to clients.
 * Clients use this to know which model to load and what reference data to use.
 *
 * @returns {object} Model info for client consumption
 */
function getModelInfo() {
  return {
    modelId: modelConfig?.model_id || 'iamekansh/chemberta-77m-mtr-onnx',
    modelVersion: modelConfig?.model_version || 'v1',
    embeddingDim: modelConfig?.embedding_dim || 384,
    scoringMethod: modelConfig?.scoring_method || 'cosine_similarity_to_references',
    referenceAntibiotics: (modelConfig?.reference_antibiotics || []).map(a => ({
      name: a.name,
      smiles: a.smiles,
      class: a.class,
    })),
    // Include pre-computed embeddings if available (saves client compute)
    referenceEmbeddings: referenceEmbeddings?.embeddings?.map(e => ({
      name: e.name,
      smiles: e.smiles,
      embedding: e.embedding,
    })) || null,
  };
}

/**
 * Get the current active model version string.
 * @returns {string}
 */
function getModelVersion() {
  return modelConfig?.model_version || 'v1';
}

/**
 * Get reference antibiotic SMILES list (for inclusion in chunk assignments).
 * @returns {Array<{name: string, smiles: string, class: string}>}
 */
function getReferenceAntibiotics() {
  return (modelConfig?.reference_antibiotics || []).map(a => ({
    name: a.name,
    smiles: a.smiles,
    class: a.class,
  }));
}

module.exports = {
  loadModelConfig,
  getModelInfo,
  getModelVersion,
  getReferenceAntibiotics,
};
