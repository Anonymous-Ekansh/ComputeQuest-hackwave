/**
 * server/src/modelRegistry.js — Tracks active model version
 *
 * For Webina docking, we just define the version.
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
