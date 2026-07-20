/**
 * server/src/taskQueue.js
 * 
 * Manages task queuing and batch planning for:
 *   - MOLECULE_SCREEN: splits a molecule library into chunks, assigns each to 1 node
 *   - INFERENCE_PIPELINE: plans stages across available nodes
 */

const { LLM_MAX_STAGES, SCREENING_CHUNK_SIZE, DOCKING_TIMEOUT_MS } = require('../../shared/constants');

class ChunkManager {
  constructor() {
    this.chunks = new Map();
    this.unassignedQueue = [];
    this.totalChunks = 0;
    this.completedChunks = 0;
    this.runId = null;
  }

  initRun(moleculeLibrary, chunkSize = SCREENING_CHUNK_SIZE, runId = null) {
    // Clear any existing timeouts
    for (const chunk of this.chunks.values()) {
      if (chunk.timeout) clearTimeout(chunk.timeout);
    }
    
    this.chunks.clear();
    this.unassignedQueue = [];
    this.completedChunks = 0;
    this.runId = runId || `screen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    for (let i = 0; i < moleculeLibrary.length; i += chunkSize) {
      const slice = moleculeLibrary.slice(i, i + chunkSize);
      const chunkId = `chunk_${String(this.chunks.size).padStart(5, '0')}`;

      this.chunks.set(chunkId, {
        chunkId,
        molecules: slice,
        status: 'unassigned',
        assignedNode: null,
        timeout: null,
        retries: 0
      });

      this.unassignedQueue.push(chunkId);
    }

    this.totalChunks = this.chunks.size;

    console.log(
      `[taskQueue] Initialized run ${this.runId}: ${this.totalChunks} chunks, ` +
      `${moleculeLibrary.length} molecules, ${chunkSize}/chunk`
    );
  }

  getNextChunkForNode(socketId, userId) {
    if (this.unassignedQueue.length === 0) return null;

    const chunkId = this.unassignedQueue.shift();
    const chunk = this.chunks.get(chunkId);

    if (!chunk || chunk.status !== 'unassigned') {
      return this.getNextChunkForNode(socketId, userId); // recursive call to skip stale
    }

    return chunk;
  }

  assignNode(chunkId, socketId, userId) {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return;

    chunk.status = 'assigned';
    chunk.assignedNode = socketId;
    
    chunk.timeout = setTimeout(() => {
      this.handleTimeout(chunkId);
    }, DOCKING_TIMEOUT_MS);

    console.log(`[taskQueue] Assigned ${socketId} to ${chunkId}`);
  }

  handleTimeout(chunkId) {
    const chunk = this.chunks.get(chunkId);
    if (!chunk || chunk.status !== 'assigned') return;
    
    chunk.retries++;
    chunk.status = 'unassigned';
    chunk.assignedNode = null;
    chunk.timeout = null;
    
    if (chunk.retries > 3) {
      console.error(`[taskQueue] Chunk ${chunkId} exceeded max retries, dropping.`);
      chunk.status = 'done';
      this.completedChunks++;
    } else {
      this.unassignedQueue.push(chunkId);
      console.log(`[taskQueue] Requeued ${chunkId} due to timeout (retry ${chunk.retries})`);
    }
  }

  recordResult(chunkId, socketId) {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return 'ignored';
    if (chunk.status === 'done') return 'ignored';
    
    if (chunk.assignedNode !== socketId) {
      console.log(`[taskQueue] Ignoring result from unassigned node ${socketId} for ${chunkId}`);
      return 'ignored';
    }

    if (chunk.timeout) {
      clearTimeout(chunk.timeout);
      chunk.timeout = null;
    }

    chunk.status = 'done';
    this.completedChunks++;
    return 'accepted';
  }

  handleNodeDisconnect(socketId) {
    for (const [chunkId, chunk] of this.chunks) {
      if (chunk.assignedNode === socketId && chunk.status === 'assigned') {
        if (chunk.timeout) clearTimeout(chunk.timeout);
        this.handleTimeout(chunkId); // forcibly timeout to requeue
      }
    }
  }

  getProgress() {
    let inFlight = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.status === 'assigned') inFlight++;
    }

    return {
      runId: this.runId,
      totalChunks: this.totalChunks,
      completedChunks: this.completedChunks,
      inFlight,
      queuedChunks: this.unassignedQueue.length,
      percentComplete: this.totalChunks > 0
        ? Math.round((this.completedChunks / this.totalChunks) * 100)
        : 0,
      totalMolecules: this.totalChunks * SCREENING_CHUNK_SIZE,
      moleculesVerified: this.completedChunks * SCREENING_CHUNK_SIZE,
    };
  }

  isRunComplete() {
    return this.completedChunks >= this.totalChunks && this.unassignedQueue.length === 0;
  }
}

// ── LLM Pipeline Planning (unchanged) ────────────────────────────────────────

function planStages(numLayers, numNodes) {
  const stageCount = Math.max(1, Math.min(numNodes, LLM_MAX_STAGES));
  
  const base = Math.floor(numLayers / stageCount);
  const remainder = numLayers % stageCount;
  
  const stages = [];
  let currentStart = 0;
  
  for (let i = 0; i < stageCount; i++) {
    const count = base + (i < remainder ? 1 : 0);
    
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
      layerRange: [currentStart, currentStart + count - 1],
      role: role
    });
    
    currentStart += count;
  }
  
  return stages;
}

module.exports = {
  ChunkManager,
  planStages,
};
