const { MATRIX_SIZE, TASK_INTERVAL, TASK_TYPES } = require('../../shared/constants');

// track all connected nodes: socketId -> { id, connectedAt, tasksCompleted, credits }
const nodes = new Map();

// per-node historical compute speed (ms per row) — used for weighted chunk sizing
const nodePerformance = new Map();

// in-flight tasks awaiting chunk results:
//   taskId -> { matrixA, matrixB, totalRows, chunks: Map<chunkId, { socketId, startRow, rowCount }>,
//               results: Map<chunkId, { rows, computeMs }>, dispatchedAt }
const pendingTasks = new Map();

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

// ── dispatch ─────────────────────────────────────────────────────────────────

function dispatchTask(io) {
  if (nodes.size === 0) return;

  const taskId = `task_${Date.now()}`;
  const matrixA = randomMatrix(MATRIX_SIZE);
  const matrixB = randomMatrix(MATRIX_SIZE);
  const totalRows = MATRIX_SIZE;

  const nodeIds = [...nodes.keys()];
  const allocation = allocateRows(totalRows, nodeIds);

  // build pending-task record
  const chunks = new Map();
  let chunkIdx = 0;

  for (const [socketId, { startRow, rowCount }] of allocation) {
    const chunkId = `${taskId}_chunk_${chunkIdx}`;
    chunks.set(chunkId, { socketId, startRow, rowCount });

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

    io.to(socketId).emit('task_chunk', payload);
    chunkIdx++;
  }

  pendingTasks.set(taskId, {
    matrixA,
    matrixB,
    totalRows,
    chunks,
    results: new Map(),
    dispatchedAt: Date.now(),
  });

  console.log(
    `[dispatch] Task ${taskId} → ${chunks.size} chunk(s) across ${allocation.size} node(s)`
  );
}

// ── reassembly & credits ─────────────────────────────────────────────────────

function tryReassemble(taskId, io) {
  const task = pendingTasks.get(taskId);
  if (!task) return;

  // have all chunks reported back?
  if (task.results.size < task.chunks.size) return;

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
        .join(', ')
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
}

// ── socket setup ─────────────────────────────────────────────────────────────

function setupSocketHandler(io) {
  io.on('connection', (socket) => {
    // register this node
    nodes.set(socket.id, {
      id: socket.id,
      connectedAt: new Date(),
      tasksCompleted: 0,
      credits: 0,
    });

    console.log(`[node+] ${socket.id} connected (${nodes.size} total)`);

    // tell everyone the updated count
    io.emit('node_count', nodes.size);

    // handle compute results coming back from a browser
    socket.on('chunk_result', (data) => {
      const { taskId, chunkId, resultRows, computeMs } = data;

      // ── update performance map ──
      const task = pendingTasks.get(taskId);
      if (task) {
        const chunkMeta = task.chunks.get(chunkId);
        if (chunkMeta) {
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
        `[result] ${socket.id} finished chunk ${chunkId} of ${taskId} in ${computeMs}ms`
      );

      tryReassemble(taskId, io);
    });

    socket.on('disconnect', () => {
      nodes.delete(socket.id);
      nodePerformance.delete(socket.id);
      console.log(`[node-] ${socket.id} disconnected (${nodes.size} total)`);
      io.emit('node_count', nodes.size);
    });
  });

  // dispatch tasks on an interval
  setInterval(() => dispatchTask(io), TASK_INTERVAL);
}

module.exports = setupSocketHandler;
