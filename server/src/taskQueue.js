/**
 * server/src/taskQueue.js
 * 
 * Manages task queuing and batch planning for:
 *   - MOLECULE_SCREEN: splits a molecule library into fixed-size batches
 *   - INFERENCE_PIPELINE: plans stages across available nodes
 */

const { LLM_MAX_STAGES, MOLECULE_BATCH_SIZE } = require('../../shared/constants');

/**
 * Computes a fresh pipeline stage plan based on available nodes.
 * @param {number} numLayers Total layers in the model (e.g. 22)
 * @param {number} numNodes Number of healthy connected nodes
 * @returns {Array} Array of stage objects: { stageIndex, layerRange: [start, end], role }
 */
function planStages(numLayers, numNodes) {
  const stageCount = Math.max(1, Math.min(numNodes, LLM_MAX_STAGES));
  
  // Divide layers as evenly as possible (differing by at most 1).
  const base = Math.floor(numLayers / stageCount);
  const remainder = numLayers % stageCount;
  
  const stages = [];
  let currentStart = 0;
  
  for (let i = 0; i < stageCount; i++) {
    // Distribute the remainder across the first 'remainder' stages
    const count = base + (i < remainder ? 1 : 0);
    
    // Assign roles based on position
    let role = 'hidden';
    if (stageCount === 1) {
      role = 'all';
    } else if (i === 0) {
      role = 'embedding';
    } else if (i === stageCount - 1) {
      role = 'lm_head';
    }
    
    stages.push({
      stageIndex: i,
      // Layer range is inclusive [start, end]
      layerRange: [currentStart, currentStart + count - 1],
      role: role
    });
    
    currentStart += count;
  }
  
  return stages;
}

/**
 * Split a molecule library into fixed-size batches for distributed screening.
 *
 * @param {Array<object>} moleculeLibrary - Array of molecule objects from molecule_library.json
 * @param {number} [batchSize=MOLECULE_BATCH_SIZE] - Number of molecules per batch
 * @returns {Array<{ batchId: string, molecules: Array<object> }>}
 */
function planMoleculeBatches(moleculeLibrary, batchSize = MOLECULE_BATCH_SIZE) {
  const batches = [];

  for (let i = 0; i < moleculeLibrary.length; i += batchSize) {
    const slice = moleculeLibrary.slice(i, i + batchSize);
    batches.push({
      batchId: `batch_${String(batches.length).padStart(4, '0')}`,
      molecules: slice,
    });
  }

  console.log(
    `[taskQueue] Planned ${batches.length} batches ` +
    `(${moleculeLibrary.length} molecules, ${batchSize}/batch)`
  );

  return batches;
}

module.exports = {
  planStages,
  planMoleculeBatches,
};
