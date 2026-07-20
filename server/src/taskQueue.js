/**
 * server/src/taskQueue.js
 * 
 * Manages task queuing and batch planning for:
 *   - MOLECULE_SCREEN: splits a molecule library into chunks, assigns each to 1 node
 *   - INFERENCE_PIPELINE: plans stages across available nodes
 */

const { LLM_MAX_STAGES, SCREENING_CHUNK_SIZE, DOCKING_TIMEOUT_MS, CONSENSUS_K } = require('../../shared/constants');

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
        status: 'unassigned', // unassigned | in_progress | done
        assignedNodes: new Map(), // socketId -> { userId, timeout, status: 'pending'|'done' }
        results: [],
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

    // Find the first chunk that hasn't been assigned to this user and needs more assignments
    for (let i = 0; i < this.unassignedQueue.length; i++) {
      const chunkId = this.unassignedQueue[i];
      const chunk = this.chunks.get(chunkId);
      
      if (!chunk || chunk.status === 'done') {
        this.unassignedQueue.splice(i, 1);
        i--;
        continue;
      }
      
      let userAlreadyAssigned = false;
      for (const [sId, info] of chunk.assignedNodes.entries()) {
        if (info.userId === userId || sId === socketId) {
          userAlreadyAssigned = true;
          break;
        }
      }
      
      if (!userAlreadyAssigned) {
        // If assigning this node will reach CONSENSUS_K, remove it from unassigned queue
        if (chunk.assignedNodes.size + 1 >= CONSENSUS_K) {
          this.unassignedQueue.splice(i, 1);
        }
        return chunk;
      }
    }
    
    return null; // No available chunks for this user
  }

  assignNode(chunkId, socketId, userId) {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return;

    chunk.status = 'in_progress';
    
    const timeout = setTimeout(() => {
      this.handleTimeout(chunkId, socketId);
    }, DOCKING_TIMEOUT_MS);
    
    chunk.assignedNodes.set(socketId, { userId, timeout, status: 'pending' });

    console.log(`[taskQueue] Assigned ${socketId} to ${chunkId}`);
  }

  handleTimeout(chunkId, socketId) {
    const chunk = this.chunks.get(chunkId);
    if (!chunk || chunk.status === 'done') return;
    
    const nodeInfo = chunk.assignedNodes.get(socketId);
    if (!nodeInfo || nodeInfo.status !== 'pending') return;
    
    chunk.assignedNodes.delete(socketId);
    chunk.retries++;
    
    if (chunk.retries > (CONSENSUS_K * 3)) {
      console.error(`[taskQueue] Chunk ${chunkId} exceeded max retries, dropping.`);
      chunk.status = 'done';
      this.completedChunks++;
    } else {
      // Re-add to unassigned queue if it was removed
      if (!this.unassignedQueue.includes(chunkId)) {
        this.unassignedQueue.push(chunkId);
      }
      console.log(`[taskQueue] Requeued ${chunkId} due to timeout (retry ${chunk.retries})`);
    }
  }

  recordResult(chunkId, socketId, resultsPayload, userId) {
    const chunk = this.chunks.get(chunkId);
    if (!chunk || chunk.status === 'done') return { status: 'ignored' };
    
    const nodeInfo = chunk.assignedNodes.get(socketId);
    if (!nodeInfo) {
      console.log(`[taskQueue] Ignoring result from unassigned node ${socketId} for ${chunkId}`);
      return { status: 'ignored' };
    }

    if (nodeInfo.timeout) {
      clearTimeout(nodeInfo.timeout);
      nodeInfo.timeout = null;
    }
    
    nodeInfo.status = 'done';
    chunk.results.push({ socketId, userId, payload: resultsPayload });

    if (chunk.results.length >= CONSENSUS_K) {
      chunk.status = 'done';
      this.completedChunks++;
      
      // Remove from unassigned queue if it's still there
      const idx = this.unassignedQueue.indexOf(chunkId);
      if (idx !== -1) this.unassignedQueue.splice(idx, 1);
      
      return { status: 'consensus_ready', chunk };
    }
    
    return { status: 'accepted_partial' };
  }

  handleNodeDisconnect(socketId) {
    for (const [chunkId, chunk] of this.chunks) {
      const nodeInfo = chunk.assignedNodes.get(socketId);
      if (nodeInfo && nodeInfo.status === 'pending') {
        if (nodeInfo.timeout) clearTimeout(nodeInfo.timeout);
        this.handleTimeout(chunkId, socketId); // forcibly timeout to requeue
      }
    }
  }

  getProgress() {
    let inFlight = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.status === 'in_progress') inFlight += chunk.assignedNodes.size;
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
