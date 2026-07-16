/**
 * server/src/taskQueue.js
 * 
 * Manages the task queuing and stage planning for INFERENCE_PIPELINE tasks.
 * (MATRIX_MULTIPLY tasks remain inside socketHandler.js for now).
 */

const { LLM_MAX_STAGES } = require('../../shared/constants');

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

module.exports = {
  planStages
};
