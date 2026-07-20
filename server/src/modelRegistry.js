/**
 * server/src/modelRegistry.js — Tracks active model version
 *
 * For Webina docking, we don't have ChemBERTa model configs or reference embeddings,
 * but we still provide basic versioning info.
 */

function loadModelConfig() {
  console.log(`[modelRegistry] Using Webina Docking`);
}

function getModelInfo() {
  return {
    modelId: 'webina-1.0',
    modelVersion: '1.0',
    scoringMethod: 'docking_binding_affinity',
  };
}

function getModelVersion() {
  return 'Webina-1.0';
}

function getReferenceAntibiotics() {
  return [];
}

module.exports = {
  loadModelConfig,
  getModelInfo,
  getModelVersion,
  getReferenceAntibiotics,
};
