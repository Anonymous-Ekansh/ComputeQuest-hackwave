const { MATRIX_SIZE, TASK_TYPES } = require('../../shared/constants');

// ── state stores ─────────────────────────────────────────────────────────────

// track all connected nodes: socketId -> { id, connectedAt, tasksCompleted, credits, status }
const nodes = new Map();

// per-node historical compute speed (ms per row) — used for weighted chunk sizing
const nodePerformance = new Map();

// in-flight tasks awaiting chunk results:
//   taskId -> { matrixA, matrixB, totalRows, complexity,
//               chunks: Map<chunkId, { socketId, startRow, rowCount, timeoutHandle }>,
//               results: Map<chunkId, { rows, computeMs }>, dispatchedAt }
const pendingTasks = new Map();

// FIFO queue of pre-generated tasks waiting for idle nodes
const taskQueue = [];

// base timeout in ms — scaled by complexity and node speed
const BASE_TIMEOUT_MS = 30_000;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Generate a random matrix of given size */
function randomMatrix(size) {
  const matrix = [];
  for (let i = 0; i < size; i++) {
    const row = [];
    for (let j = 0; j < size; j++) {
      row.push(Math.floor(Math.random() * 10));
    }
    matrix.push(row);
  }
  return matrix;
}

/** Get all node IDs that are currently idle */
function getIdleNodeIds() {
  const idle = [];
  for (const [id, node] of nodes) {
    if (node.status === 'idle') idle.push(id);
  }
  return idle;
}

/** Mark a node as busy */
function markBusy(socketId) {
  const node = nodes.get(socketId);
  if (node) node.status = 'busy';
}

/** Mark a node as idle and trigger the dispatch check */
function markIdle(socketId, io) {
  const node = nodes.get(socketId);
  if (node) node.status = 'idle';
  // demand-driven: immediately check if there's work to hand out
  tryDispatchNext(io);
}

/** Get the fastest idle node by avgMsPerRow (lowest = fastest) */
function getFastestIdleNode() {
  const idle = getIdleNodeIds();
  if (idle.length === 0) return null;

  let best = idle[0];
  let bestSpeed = Infinity;

  for (const id of idle) {
    const perf = nodePerformance.get(id);
    const speed = perf ? perf.avgMsPerRow : Infinity;
    if (speed < bestSpeed) {
      bestSpeed = speed;
      best = id;
    }
  }
  return best;
}

/**
 * Calculate the per-node timeout for a chunk, scaled by complexity and the
 * node's historical speed.
 *   timeout = BASE_TIMEOUT_MS * (complexity / 64) * max(avgMsPerRow, 1)
 * Clamped to [5 000, 120 000] ms.
 */
function chunkTimeout(socketId, complexity) {
  const perf = nodePerformance.get(socketId);
  const msPerRow = perf ? Math.max(perf.avgMsPerRow, 0.1) : 1;
  const scaled = BASE_TIMEOUT_MS * (complexity / 64) * msPerRow;
  return Math.max(5_000, Math.min(120_000, scaled));
}

/**
 * Split `totalRows` across `nodeIds` weighted by inverse of their average
 * ms-per-row.  Nodes with no history get the median weight so they aren't
 * starved.  Returns Map<socketId, { startRow, rowCount }>.
 */
function allocateRows(totalRows, nodeIds) {
  // gather raw speeds (lower ms/row → faster → should get MORE rows)
  const speeds = nodeIds.map((id) => {
    const perf = nodePerformance.get(id);
    return perf ? perf.avgMsPerRow : null;
  });

  // median of known speeds, or fallback 1
  const known = speeds.filter((s) => s !== null);
  const median =
    known.length > 0
      ? known.sort((a, b) => a - b)[Math.floor(known.length / 2)]
      : 1;

  // weight = 1 / speed  (faster nodes get bigger weight)
  const weights = speeds.map((s) => 1 / (s ?? median));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const allocation = new Map();
  let cursor = 0;
  let remaining = totalRows;

  for (let i = 0; i < nodeIds.length; i++) {
    const isLast = i === nodeIds.length - 1;
    // proportional share, at least 1 row, integer
    let rowCount = isLast
      ? remaining
      : Math.max(1, Math.round((weights[i] / totalWeight) * totalRows));

    // clamp so we don't exceed remaining
    rowCount = Math.min(rowCount, remaining);
    if (rowCount <= 0) continue;

    allocation.set(nodeIds[i], { startRow: cursor, rowCount });
    cursor += rowCount;
    remaining -= rowCount;
  }

  return allocation;
}

// ── demand-driven dispatch ───────────────────────────────────────────────────

/**
 * Create a new task and push it onto the task queue.
 * Does NOT send it to nodes — that's tryDispatchNext()'s job.
 */
function enqueueTask() {
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const matrixA = randomMatrix(MATRIX_SIZE);
  const matrixB = randomMatrix(MATRIX_SIZE);
  const complexity = MATRIX_SIZE * MATRIX_SIZE;

  taskQueue.push({ taskId, matrixA, matrixB, complexity });
  return taskId;
}

/**
 * Core scheduling loop — called after every state change (node idle, node
 * connect, chunk result, timeout reassignment).
 *
 * Rules:
 *   1. There must be idle nodes.
 *   2. There must be no in-flight task (previous must be complete or timed out)
 *      OR there's a queued task ready to go.
 *   3. If the queue is empty, generate a fresh task automatically.
 */
function tryDispatchNext(io) {
  const idle = getIdleNodeIds();
  if (idle.length === 0) return;

  // don't stack tasks — wait until the current one finishes or times out
  if (pendingTasks.size > 0) return;

  // grab or create a task
  if (taskQueue.length === 0) {
    enqueueTask();
  }
  const task = taskQueue.shift();
  dispatchTask(io, task, idle);
}

/**
 * Dispatch a prepared task to the given idle node IDs.
 */
function dispatchTask(io, task, idleNodeIds) {
  const { taskId, matrixA, matrixB, complexity } = task;
  const totalRows = MATRIX_SIZE;

  const allocation = allocateRows(totalRows, idleNodeIds);

  // build pending-task record
  const chunks = new Map();
  let chunkIdx = 0;

  for (const [socketId, { startRow, rowCount }] of allocation) {
    const chunkId = `${taskId}_chunk_${chunkIdx}`;

    // per-chunk timeout — complexity-aware
    const timeout = chunkTimeout(socketId, complexity);
    const timeoutHandle = setTimeout(
      () => handleChunkTimeout(taskId, chunkId, io),
      timeout,
    );

    chunks.set(chunkId, { socketId, startRow, rowCount, timeoutHandle });

    // slice rows for this node
    const rowsA = matrixA.slice(startRow, startRow + rowCount);

    const payload = {
      taskId,
      chunkId,
      type: TASK_TYPES.MATRIX_MULTIPLY,
      chunkData: { rowsA, matrixB },
      startRow,
      rowCount,
      totalRows,
    };

    markBusy(socketId);
    io.to(socketId).emit('task_chunk', payload);
    chunkIdx++;
  }

  pendingTasks.set(taskId, {
    matrixA,
    matrixB,
    totalRows,
    complexity,
    chunks,
    results: new Map(),
    dispatchedAt: Date.now(),
  });

  console.log(
    `[dispatch] Task ${taskId} (complexity ${complexity}) → ` +
      `${chunks.size} chunk(s) across ${allocation.size} node(s)`,
  );
}

// ── timeout & reassignment ───────────────────────────────────────────────────

/**
 * Called when a chunk's per-node timeout fires.
 * Reassign the timed-out chunk to the fastest idle node, or mark the task
 * failed if no one is available.
 */
function handleChunkTimeout(taskId, chunkId, io) {
  const task = pendingTasks.get(taskId);
  if (!task) return;

  // already received?
  if (task.results.has(chunkId)) return;

  const chunkMeta = task.chunks.get(chunkId);
  if (!chunkMeta) return;

  const oldSocket = chunkMeta.socketId;
  console.log(
    `[timeout] Chunk ${chunkId} on ${oldSocket} timed out — attempting reassignment`,
  );

  // mark the old node idle (it's apparently stuck; the result will be ignored
  // if it arrives late)
  markIdleSilent(oldSocket);

  // find the fastest idle node
  const replacement = getFastestIdleNode();
  if (!replacement) {
    console.log(`[timeout] No idle node available to reassign ${chunkId}`);
    return;
  }

  // update chunk metadata to point to the new node
  const newTimeout = chunkTimeout(replacement, task.complexity);
  chunkMeta.socketId = replacement;
  chunkMeta.timeoutHandle = setTimeout(
    () => handleChunkTimeout(taskId, chunkId, io),
    newTimeout,
  );

  // send the chunk to the replacement
  const rowsA = task.matrixA.slice(
    chunkMeta.startRow,
    chunkMeta.startRow + chunkMeta.rowCount,
  );

  const payload = {
    taskId,
    chunkId,
    type: TASK_TYPES.MATRIX_MULTIPLY,
    chunkData: { rowsA, matrixB: task.matrixB },
    startRow: chunkMeta.startRow,
    rowCount: chunkMeta.rowCount,
    totalRows: task.totalRows,
  };

  markBusy(replacement);
  io.to(replacement).emit('task_chunk', payload);

  console.log(
    `[reassign] Chunk ${chunkId} reassigned to ${replacement} (timeout ${newTimeout}ms)`,
  );
}

/** Mark idle without triggering dispatch (used inside timeout handler) */
function markIdleSilent(socketId) {
  const node = nodes.get(socketId);
  if (node) node.status = 'idle';
}

// ── reassembly & credits ─────────────────────────────────────────────────────

function tryReassemble(taskId, io) {
  const task = pendingTasks.get(taskId);
  if (!task) return;

  // have all chunks reported back?
  if (task.results.size < task.chunks.size) return;

  // clear any remaining timeout handles
  for (const [, meta] of task.chunks) {
    if (meta.timeoutHandle) clearTimeout(meta.timeoutHandle);
  }

  // sort chunks by startRow so we can concatenate in order
  const ordered = [...task.chunks.entries()]
    .map(([chunkId, meta]) => ({
      chunkId,
      ...meta,
      result: task.results.get(chunkId),
    }))
    .sort((a, b) => a.startRow - b.startRow);

  // concatenate result rows
  const fullResult = [];
  for (const { result } of ordered) {
    fullResult.push(...result.rows);
  }

  // per-node contribution stats & credit awarding
  const contributions = ordered.map(({ chunkId, socketId, startRow, rowCount, result }) => {
    // credits proportional to rows computed
    const credits = rowCount;
    const node = nodes.get(socketId);
    if (node) {
      node.credits = (node.credits || 0) + credits;
      node.tasksCompleted++;
    }

    return {
      chunkId,
      socketId,
      startRow,
      rowCount,
      computeMs: result.computeMs,
      creditsAwarded: credits,
      totalCredits: node ? node.credits : 0,
    };
  });

  const elapsed = Date.now() - task.dispatchedAt;

  console.log(
    `[complete] Task ${taskId} reassembled in ${elapsed}ms — ` +
      contributions
        .map((c) => `${c.socketId.slice(0, 6)}… ${c.rowCount}r/${c.computeMs}ms/+${c.creditsAwarded}cr`)
        .join(', '),
  );

  // broadcast the completed task to all clients
  io.emit('task:complete', {
    taskId,
    matrixA: task.matrixA,
    matrixB: task.matrixB,
    result: fullResult,
    totalTimeMs: elapsed,
    contributions,
  });

  pendingTasks.delete(taskId);

  // task done → check if we should immediately dispatch the next one
  tryDispatchNext(io);
}

// ── socket setup ─────────────────────────────────────────────────────────────

function setupSocketHandler(io) {
  io.on('connection', (socket) => {
    // register this node as idle
    nodes.set(socket.id, {
      id: socket.id,
      connectedAt: new Date(),
      tasksCompleted: 0,
      credits: 0,
      status: 'idle',
    });

    console.log(`[node+] ${socket.id} connected (${nodes.size} total)`);

    // tell everyone the updated count
    io.emit('node_count', nodes.size);

    // a new idle node just appeared — maybe we can dispatch work now
    tryDispatchNext(io);

    // handle compute results coming back from a browser
    socket.on('chunk_result', (data) => {
      const { taskId, chunkId, resultRows, computeMs } = data;

      // ── update performance map ──
      const task = pendingTasks.get(taskId);
      if (task) {
        const chunkMeta = task.chunks.get(chunkId);
        if (chunkMeta) {
          // ignore results from a node that was already reassigned away
          if (chunkMeta.socketId !== socket.id) {
            console.log(
              `[result] Ignoring late result from ${socket.id} for ${chunkId} (reassigned to ${chunkMeta.socketId})`,
            );
            markIdle(socket.id, io);
            return;
          }

          // clear the timeout for this chunk
          if (chunkMeta.timeoutHandle) {
            clearTimeout(chunkMeta.timeoutHandle);
            chunkMeta.timeoutHandle = null;
          }

          const msPerRow = computeMs / chunkMeta.rowCount;
          const prev = nodePerformance.get(socket.id);
          if (prev) {
            // exponential moving average (α = 0.3)
            prev.avgMsPerRow = prev.avgMsPerRow * 0.7 + msPerRow * 0.3;
            prev.samples++;
          } else {
            nodePerformance.set(socket.id, { avgMsPerRow: msPerRow, samples: 1 });
          }

          // store result rows for reassembly
          task.results.set(chunkId, { rows: resultRows, computeMs });
        }
      }

      console.log(
        `[result] ${socket.id} finished chunk ${chunkId} of ${taskId} in ${computeMs}ms`,
      );

      // node is now idle — this also triggers tryDispatchNext via markIdle
      markIdle(socket.id, io);

      tryReassemble(taskId, io);
    });

    socket.on('disconnect', () => {
      // clean up any in-flight chunk timeouts assigned to this node
      for (const [taskId, task] of pendingTasks) {
        for (const [chunkId, meta] of task.chunks) {
          if (meta.socketId === socket.id && !task.results.has(chunkId)) {
            // the node left before finishing — trigger timeout immediately
            if (meta.timeoutHandle) clearTimeout(meta.timeoutHandle);
            handleChunkTimeout(taskId, chunkId, io);
          }
        }
      }

      nodes.delete(socket.id);
      nodePerformance.delete(socket.id);
      console.log(`[node-] ${socket.id} disconnected (${nodes.size} total)`);
      io.emit('node_count', nodes.size);
    });
  });

  // No setInterval — dispatch is entirely demand-driven.
  // Seed the first task so work begins as soon as a node connects.
  enqueueTask();
}

module.exports = setupSocketHandler;
