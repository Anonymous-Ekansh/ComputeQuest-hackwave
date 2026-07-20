/**
 * server/src/taskQueue.js
 * 
 * Manages task queuing and batch planning for:
 *   - MOLECULE_SCREEN: splits a molecule library into chunks, assigns each to k=3 nodes
 *   - INFERENCE_PIPELINE: plans stages across available nodes
 *
 * Chunk state machine:
 *   unassigned → assigned (≤k nodes) → partial (1+ results in)
 *     → consensus_reached (2-of-k agree) → DONE
 *     → consensus_failed → requeued (to k different nodes)
 */

const { LLM_MAX_STAGES, SCREENING_CHUNK_SIZE, CONSENSUS_K } = require('../../shared/constants');

// ── Chunk State Machine ──────────────────────────────────────────────────────

/**
 * @typedef {Object} ChunkState
 * @property {string} chunkId
 * @property {Array<{smiles: string, id?: string, name?: string}>} molecules
 * @property {'unassigned'|'assigned'|'partial'|'consensus_reached'|'consensus_failed'|'requeued'} status
 * @property {Map<string, string>} assignedNodes - socketId -> userId
 * @property {Array<{nodeUserId: string, nodeSocketId: string, scores: Array, wallClockMs: number, modelVersion: string}>} results
 * @property {number} retries
 * @property {Set<string>} excludedNodes - nodes that already tried this chunk (for requeue)
 */

class ChunkManager {
  constructor() {
    /** @type {Map<string, ChunkState>} */
    this.chunks = new Map();

    /** @type {string[]} FIFO queue of chunk IDs waiting for assignment */
    this.unassignedQueue = [];

    /** @type {number} Total chunks in this screening run */
    this.totalChunks = 0;

    /** @type {number} Chunks that reached consensus */
    this.completedChunks = 0;

    /** @type {string} Current run ID */
    this.runId = null;
  }

  /**
   * Initialize a new screening run from a molecule library.
   *
   * @param {Array<object>} moleculeLibrary - full molecule list
   * @param {number} chunkSize - molecules per chunk
   * @param {string} runId - unique run identifier
   */
  initRun(moleculeLibrary, chunkSize = SCREENING_CHUNK_SIZE, runId = null) {
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
        assignedNodes: new Map(),
        results: [],
        retries: 0,
        excludedNodes: new Set(),
      });

      this.unassignedQueue.push(chunkId);
    }

    this.totalChunks = this.chunks.size;

    console.log(
      `[taskQueue] Initialized run ${this.runId}: ${this.totalChunks} chunks, ` +
      `${moleculeLibrary.length} molecules, ${chunkSize}/chunk, k=${CONSENSUS_K}`
    );
  }

  /**
   * Get the next chunk that needs a node assignment.
   * Returns null if no chunks need more nodes.
   *
   * @param {string} socketId - the node to potentially assign
   * @param {string|null} userId - the node's user ID
   * @returns {ChunkState|null}
   */
  getNextChunkForNode(socketId, userId) {
    // First: look for chunks that are assigned but need more nodes (< k)
    for (const [chunkId, chunk] of this.chunks) {
      if (
        (chunk.status === 'assigned' || chunk.status === 'partial') &&
        chunk.assignedNodes.size < CONSENSUS_K &&
        !chunk.assignedNodes.has(socketId) &&
        !chunk.excludedNodes.has(socketId)
      ) {
        return chunk;
      }
    }

    // Second: look for unassigned chunks in the queue
    while (this.unassignedQueue.length > 0) {
      const chunkId = this.unassignedQueue[0];
      const chunk = this.chunks.get(chunkId);

      if (!chunk || chunk.status !== 'unassigned') {
        this.unassignedQueue.shift(); // stale entry
        continue;
      }

      if (chunk.excludedNodes.has(socketId)) {
        // This node was excluded (e.g., failed consensus before) — skip for now
        // Move to end of queue
        this.unassignedQueue.shift();
        this.unassignedQueue.push(chunkId);
        continue;
      }

      this.unassignedQueue.shift();
      return chunk;
    }

    return null;
  }

  /**
   * Assign a node to a chunk.
   *
   * @param {string} chunkId
   * @param {string} socketId
   * @param {string|null} userId
   */
  assignNode(chunkId, socketId, userId) {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return;

    chunk.assignedNodes.set(socketId, userId || 'anonymous');

    if (chunk.status === 'unassigned') {
      chunk.status = 'assigned';
    }

    console.log(
      `[taskQueue] Assigned ${socketId} to ${chunkId} ` +
      `(${chunk.assignedNodes.size}/${CONSENSUS_K} nodes)`
    );
  }

  /**
   * Record a result from a node for a chunk.
   *
   * @param {string} chunkId
   * @param {string} socketId
   * @param {string|null} userId
   * @param {Array<{smiles: string, similarity: number}>} scores
   * @param {number} wallClockMs
   * @param {string} modelVersion
   * @returns {'partial'|'ready_for_consensus'|'ignored'}
   */
  recordResult(chunkId, socketId, userId, scores, wallClockMs, modelVersion) {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return 'ignored';

    // Reject if chunk is already done
    if (chunk.status === 'consensus_reached') return 'ignored';

    // Reject if this node wasn't assigned
    if (!chunk.assignedNodes.has(socketId)) {
      console.log(`[taskQueue] Ignoring result from unassigned node ${socketId} for ${chunkId}`);
      return 'ignored';
    }

    // Reject duplicate results from the same node
    if (chunk.results.some(r => r.nodeSocketId === socketId)) {
      console.log(`[taskQueue] Ignoring duplicate result from ${socketId} for ${chunkId}`);
      return 'ignored';
    }

    chunk.results.push({
      nodeUserId: userId || 'anonymous',
      nodeSocketId: socketId,
      scores,
      wallClockMs,
      modelVersion,
    });

    if (chunk.status === 'assigned') {
      chunk.status = 'partial';
    }

    console.log(
      `[taskQueue] Result from ${socketId} for ${chunkId}: ` +
      `${scores.length} scores, ${wallClockMs}ms ` +
      `(${chunk.results.length}/${CONSENSUS_K} results in)`
    );

    // Check if we have enough results for consensus
    if (chunk.results.length >= 2) {
      return 'ready_for_consensus';
    }

    return 'partial';
  }

  /**
   * Mark a chunk as consensus reached.
   * @param {string} chunkId
   */
  markConsensusReached(chunkId) {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return;
    chunk.status = 'consensus_reached';
    this.completedChunks++;
  }

  /**
   * Mark a chunk as consensus failed and requeue to different nodes.
   * @param {string} chunkId
   */
  requeueChunk(chunkId) {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return;

    chunk.retries++;
    if (chunk.retries > 3) {
      console.error(`[taskQueue] Chunk ${chunkId} exceeded max retries, giving up`);
      chunk.status = 'consensus_failed';
      this.completedChunks++; // count as done to avoid blocking
      return;
    }

    // Exclude all nodes that participated in the failed consensus
    for (const socketId of chunk.assignedNodes.keys()) {
      chunk.excludedNodes.add(socketId);
    }

    // Reset for re-assignment
    chunk.assignedNodes.clear();
    chunk.results = [];
    chunk.status = 'unassigned';
    this.unassignedQueue.push(chunkId);

    console.log(
      `[taskQueue] Requeued ${chunkId} (retry ${chunk.retries}, ` +
      `${chunk.excludedNodes.size} nodes excluded)`
    );
  }

  /**
   * Handle a node disconnecting — remove it from any assigned chunks.
   * @param {string} socketId
   */
  handleNodeDisconnect(socketId) {
    for (const [chunkId, chunk] of this.chunks) {
      if (chunk.assignedNodes.has(socketId)) {
        chunk.assignedNodes.delete(socketId);
        // Don't change status — other nodes may still return results
        console.log(`[taskQueue] Removed disconnected node ${socketId} from ${chunkId}`);
      }
    }
  }

  /**
   * Get screening progress stats.
   * @returns {object}
   */
  getProgress() {
    let inFlight = 0;
    let awaitingConsensus = 0;

    for (const chunk of this.chunks.values()) {
      if (chunk.status === 'assigned' || chunk.status === 'partial') {
        inFlight++;
        if (chunk.results.length >= 2) awaitingConsensus++;
      }
    }

    return {
      runId: this.runId,
      totalChunks: this.totalChunks,
      completedChunks: this.completedChunks,
      inFlight,
      awaitingConsensus,
      queuedChunks: this.unassignedQueue.length,
      percentComplete: this.totalChunks > 0
        ? Math.round((this.completedChunks / this.totalChunks) * 100)
        : 0,
      totalMolecules: this.totalChunks * SCREENING_CHUNK_SIZE,
      moleculesVerified: this.completedChunks * SCREENING_CHUNK_SIZE,
    };
  }

  /**
   * Check if the current run is complete.
   * @returns {boolean}
   */
  isRunComplete() {
    return this.completedChunks >= this.totalChunks && this.unassignedQueue.length === 0;
  }
}

// ── LLM Pipeline Planning (unchanged) ────────────────────────────────────────

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
  ChunkManager,
  planStages,
};
