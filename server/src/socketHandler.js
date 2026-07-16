const { MATRIX_SIZE, TASK_TYPES, TROPHY_WIN, TROPHY_LOSS, DECK_SIZE, CREDITS_PER_CRYSTAL, LLM_LAYERS } = require('../../shared/constants');
const { CARD_MAP } = require('../../shared/cards');
const { getTokenizer } = require('./tokenizer');
const { planStages } = require('./taskQueue');
const { getBotTier } = require('../../shared/bots');
const { simulateBattle } = require('../../shared/battleLogic');
const fs = require('fs');
const path = require('path');


// ── constants ────────────────────────────────────────────────────────────────

const BASE_TIMEOUT_MS = 30_000;          // scaled by complexity + node speed
const MAX_CHUNK_RETRIES = 3;             // per-chunk retry cap before task:failed
const DEADLINE_SCAN_INTERVAL_MS = 2_000; // how often we scan for overdue chunks
const SPOT_CHECK_COUNT = 2;              // random cells to verify after reassembly

const usersFilePath = path.join(__dirname, '..', 'data', 'users.json');

const { createClient } = require('@supabase/supabase-js');

// ── database connection (Supabase REST API / JSON Fallback) ──────────────────

let supabase = null;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('[db] Supabase REST client initialized');
} else {
  console.warn('[db] Missing SUPABASE_URL or SUPABASE_ANON_KEY. Falling back to local users.json');
}

async function loadUsers() {
  if (supabase) {
    try {
      const { data, error } = await supabase.from('users').select('id, username, credits, total_contributed, trophies, can_upgrade');
      if (error) throw error;
      return data || [];
    } catch (err) {
      console.error('[db] Supabase read error:', err.message || err);
      return [];
    }
  }

  try {
    if (fs.existsSync(usersFilePath)) {
      const data = fs.readFileSync(usersFilePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Failed to load users in socketHandler:', err);
  }
  return [];
}

// ── Forge game data helpers ──────────────────────────────────────────────────

async function loadUserGameData(userId) {
  if (!supabase) return { ownedCards: [], savedDeck: [], upgrades: {} };
  try {
    const [cardsRes, deckRes, upgradesRes] = await Promise.all([
      supabase.from('user_cards').select('card_id').eq('user_id', userId),
      supabase.from('user_decks').select('card_ids').eq('user_id', userId).single(),
      supabase.from('user_card_upgrades').select('card_id, attack_upgrades, defense_upgrades').eq('user_id', userId),
    ]);
    const ownedCards = cardsRes.data ? cardsRes.data.map(r => r.card_id) : [];
    const savedDeck = (deckRes.data && deckRes.data.card_ids) ? deckRes.data.card_ids : [];
    
    const upgrades = {};
    if (upgradesRes.data) {
      for (const row of upgradesRes.data) {
        upgrades[row.card_id] = { attack: row.attack_upgrades || 0, defense: row.defense_upgrades || 0 };
      }
    }
    
    return { ownedCards, savedDeck, upgrades };
  } catch (err) {
    console.error('[game] Failed to load game data for', userId, err.message || err);
    return { ownedCards: [], savedDeck: [], upgrades: {} };
  }
}

async function loadUserTrophies(userId) {
  if (!supabase) return 0;
  try {
    const { data, error } = await supabase.from('users').select('trophies').eq('id', userId).single();
    if (error) throw error;
    return (data && data.trophies) || 0;
  } catch (err) {
    console.error('[game] Failed to load trophies for', userId, err.message || err);
    return 0;
  }
}

async function saveUsers(usersData) {
  if (supabase) {
    try {
      // Upsert all users into Supabase
      const { error } = await supabase.from('users').upsert(
        usersData.map(u => ({
          id: u.id,
          username: u.username,
          credits: u.credits,
          total_contributed: u.total_contributed || 0,
          can_upgrade: u.can_upgrade || false
        })),
        { onConflict: 'id' }
      );
      
      if (error) throw error;
    } catch (err) {
      console.error('[db] Supabase write error:', err.message || err);
    }
    return;
  }

  try {
    const dir = path.dirname(usersFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(usersFilePath, JSON.stringify(usersData, null, 2));
  } catch (err) {
    console.error('Failed to save users in socketHandler:', err);
  }
}

// ── atomic credit updates ────────────────────────────────────────────────────

let writeQueue = Promise.resolve();

async function incrementUserCredits(userId, amount) {
  if (supabase) {
    const { data, error } = await supabase.rpc('increment_credits', {
      user_id: userId,
      amount: amount
    });
    
    if (error) throw error;
    // data should contain { credits, total_contributed }
    // supabase.rpc returns an array of objects when returning a table/record
    return data && data.length > 0 ? data[0] : null;
  }

  // Local fallback with an in-memory lock/queue to prevent interleaved writes
  return new Promise((resolve, reject) => {
    writeQueue = writeQueue.then(async () => {
      try {
        const usersList = await loadUsers();
        const dbUser = usersList.find(u => u.id === userId);
        if (dbUser) {
          dbUser.credits = (dbUser.credits || 0) + amount;
          dbUser.total_contributed = (dbUser.total_contributed || 0) + amount;
          await saveUsers(usersList);
          resolve({ credits: dbUser.credits, total_contributed: dbUser.total_contributed });
        } else {
          reject(new Error(`User ${userId} not found`));
        }
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ── state stores ─────────────────────────────────────────────────────────────

// socketId -> { id, userId, username, connectedAt, tasksCompleted, credits, status: 'idle'|'busy' }
const nodes = new Map();

// socketId -> { avgMsPerRow, samples }
const nodePerformance = new Map();

// taskId -> { matrixA, matrixB, totalRows, complexity,
//             chunks: Map<chunkId, ChunkMeta>, results: Map<chunkId, ChunkResult>,
//             dispatchedAt }
//
// ChunkMeta  = { socketId, userId, username, startRow, rowCount, deadline, retries }
// ChunkResult = { rows, computeMs }
const pendingTasks = new Map();

// FIFO queue of pre-generated tasks waiting for idle nodes
const taskQueue = [];

// chunks that timed out with no idle node available — requeued for next idle
// { taskId, chunkId }
const requeuedChunks = [];

// ── pipeline state ───────────────────────────────────────────────────────────
// sessionId -> { stages: [ {stageIndex, socketId, ...} ], activeNodes: Set<socketId>, promptTokens: number[], currentTokenIndex: number, posOff: number }
const activePipelines = new Map();

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

/** Dot product of a row vector and a column extracted from a matrix */
function dotRowCol(row, matrix, colIdx) {
  let sum = 0;
  for (let k = 0; k < row.length; k++) {
    sum += row[k] * matrix[k][colIdx];
  }
  return sum;
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

/** Mark a node as idle and trigger dispatch checks */
function markIdle(socketId, io) {
  const node = nodes.get(socketId);
  if (!node || node.status === 'unauthenticated') return;
  node.status = 'idle';
  // demand-driven: immediately try to hand out queued work
  drainRequeued(io);
  tryDispatchNext(io);
}

/** Mark idle WITHOUT triggering dispatch (avoids recursion in timeout handler) */
function markIdleSilent(socketId) {
  const node = nodes.get(socketId);
  if (!node || node.status === 'unauthenticated') return;
  node.status = 'idle';
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
 * Adaptive timeout for a chunk on a given node.
 *   timeout = BASE_TIMEOUT_MS × (complexity / 64) × max(avgMsPerRow, 0.1)
 * Clamped to [5 000, 120 000] ms.
 */
function adaptiveTimeout(socketId, complexity) {
  const perf = nodePerformance.get(socketId);
  const msPerRow = perf ? Math.max(perf.avgMsPerRow, 0.1) : 1;
  const scaled = BASE_TIMEOUT_MS * (complexity / 64) * msPerRow;
  return Math.max(5_000, Math.min(120_000, scaled));
}

// ── smart splitting ──────────────────────────────────────────────────────────

/**
 * Split `totalRows` across `nodeIds`, weighted by inverse of avgMsPerRow.
 *
 * Constraints enforced here:
 *   • max chunks = min(nodeIds.length, totalRows)
 *   • min chunk  = 1 row
 *   • 1 node → no split overhead (whole matrix as one chunk)
 *
 * Returns Map<socketId, { startRow, rowCount }>.
 */
function allocateRows(totalRows, nodeIds) {
  // clamp: never more chunks than rows
  const effectiveNodes = nodeIds.slice(0, Math.min(nodeIds.length, totalRows));

  // single node → no split overhead
  if (effectiveNodes.length === 1) {
    return new Map([[effectiveNodes[0], { startRow: 0, rowCount: totalRows }]]);
  }

  // gather raw speeds
  const speeds = effectiveNodes.map((id) => {
    const perf = nodePerformance.get(id);
    return perf ? perf.avgMsPerRow : null;
  });

  const known = speeds.filter((s) => s !== null);
  const median =
    known.length > 0
      ? known.sort((a, b) => a - b)[Math.floor(known.length / 2)]
      : 1;

  const weights = speeds.map((s) => 1 / (s ?? median));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const allocation = new Map();
  let cursor = 0;
  let remaining = totalRows;

  for (let i = 0; i < effectiveNodes.length; i++) {
    const isLast = i === effectiveNodes.length - 1;
    let rowCount = isLast
      ? remaining
      : Math.max(1, Math.round((weights[i] / totalWeight) * totalRows));

    rowCount = Math.min(rowCount, remaining);
    if (rowCount <= 0) continue;

    allocation.set(effectiveNodes[i], { startRow: cursor, rowCount });
    cursor += rowCount;
    remaining -= rowCount;
  }

  return allocation;
}

// ── task queue / demand-driven dispatch ───────────────────────────────────────

/** Generate a fresh task and push it into the queue */
function enqueueTask() {
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const matrixA = randomMatrix(MATRIX_SIZE);
  const matrixB = randomMatrix(MATRIX_SIZE);
  const complexity = MATRIX_SIZE * MATRIX_SIZE;

  taskQueue.push({ taskId, matrixA, matrixB, complexity });
  return taskId;
}

/**
 * Core scheduling loop — triggered after every state change.
 * Dispatches the next queued task only when:
 *   1. At least one node is idle, AND
 *   2. No task is currently in-flight
 */
function tryDispatchNext(io) {
  const idle = getIdleNodeIds();
  if (idle.length === 0) return;
  if (pendingTasks.size > 0) return;

  if (taskQueue.length === 0) enqueueTask();

  const task = taskQueue.shift();
  dispatchTask(io, task, idle);
}

/** Dispatch a prepared task to idle nodes */
function dispatchTask(io, task, idleNodeIds) {
  const { taskId, matrixA, matrixB, complexity } = task;
  const totalRows = MATRIX_SIZE;

  const allocation = allocateRows(totalRows, idleNodeIds);
  const chunks = new Map();
  let chunkIdx = 0;

  for (const [socketId, { startRow, rowCount }] of allocation) {
    const chunkId = `${taskId}_chunk_${chunkIdx}`;
    const deadline = Date.now() + adaptiveTimeout(socketId, complexity);
    const node = nodes.get(socketId);

    chunks.set(chunkId, {
      socketId,
      userId: node ? node.userId : null,
      username: node ? node.username : 'Anonymous Node',
      startRow,
      rowCount,
      deadline,
      retries: 0
    });

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

    if (!node || node.status === 'unauthenticated') {
      console.warn(`[dispatch] Refusing to send chunk to unauthenticated socket ${socketId}`);
      continue;
    }

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

// ── deadline scanner (replaces per-chunk setTimeout) ─────────────────────────

/**
 * Runs every DEADLINE_SCAN_INTERVAL_MS.
 * Scans all pendingTasks for overdue chunks and handles them.
 */
function scanDeadlines(io) {
  const now = Date.now();

  for (const [taskId, task] of pendingTasks) {
    for (const [chunkId, meta] of task.chunks) {
      // already have a result for this chunk
      if (task.results.has(chunkId)) continue;

      if (now < meta.deadline) continue;

      // ── overdue ──
      meta.retries++;
      console.log(
        `[timeout] Chunk ${chunkId} on ${meta.socketId} overdue ` +
          `(retry ${meta.retries}/${MAX_CHUNK_RETRIES})`,
      );

      // exceeded retry limit → fail the whole task
      if (meta.retries > MAX_CHUNK_RETRIES) {
        failTask(taskId, `Chunk ${chunkId} exceeded ${MAX_CHUNK_RETRIES} retries`, io);
        break; // task is gone, stop iterating its chunks
      }

      // mark the old node idle (it's apparently stuck)
      markIdleSilent(meta.socketId);

      // try to reassign
      const replacement = getFastestIdleNode();
      if (replacement) {
        reassignChunk(taskId, chunkId, replacement, io);
      } else {
        // no idle node → requeue for the next available one
        meta.deadline = Infinity; // stop re-triggering until reassigned
        requeuedChunks.push({ taskId, chunkId });
        console.log(`[requeue] Chunk ${chunkId} queued for next idle node`);
      }
    }
  }
}

/** Reassign a single chunk to a new node */
function reassignChunk(taskId, chunkId, socketId, io) {
  const task = pendingTasks.get(taskId);
  if (!task) return;

  const meta = task.chunks.get(chunkId);
  if (!meta) return;

  const replacementNode = nodes.get(socketId);
  meta.socketId = socketId;
  meta.userId = replacementNode ? replacementNode.userId : null;
  meta.username = replacementNode ? replacementNode.username : 'Anonymous Node';
  meta.deadline = Date.now() + adaptiveTimeout(socketId, task.complexity);

  const rowsA = task.matrixA.slice(meta.startRow, meta.startRow + meta.rowCount);
  const payload = {
    taskId,
    chunkId,
    type: TASK_TYPES.MATRIX_MULTIPLY,
    chunkData: { rowsA, matrixB: task.matrixB },
    startRow: meta.startRow,
    rowCount: meta.rowCount,
    totalRows: task.totalRows,
  };

  if (!replacementNode || replacementNode.status === 'unauthenticated') {
    console.warn(`[reassign] Refusing to reassign chunk to unauthenticated socket ${socketId}`);
    return;
  }

  markBusy(socketId);
  io.to(socketId).emit('task_chunk', payload);

  console.log(
    `[reassign] Chunk ${chunkId} → ${socketId} ` +
      `(deadline +${adaptiveTimeout(socketId, task.complexity)}ms)`,
  );
}

/** Drain requeued chunks whenever an idle node becomes available */
function drainRequeued(io) {
  while (requeuedChunks.length > 0) {
    const replacement = getFastestIdleNode();
    if (!replacement) break;

    const { taskId, chunkId } = requeuedChunks.shift();

    // task may have been failed/removed in the meantime
    const task = pendingTasks.get(taskId);
    if (!task || task.results.has(chunkId)) continue;

    reassignChunk(taskId, chunkId, replacement, io);
  }
}

// ── task failure ─────────────────────────────────────────────────────────────

function failTask(taskId, reason, io) {
  const task = pendingTasks.get(taskId);
  if (!task) return;

  console.error(`[FAILED] Task ${taskId}: ${reason}`);

  // mark all assigned nodes idle
  for (const [, meta] of task.chunks) {
    markIdleSilent(meta.socketId);
  }

  // remove any requeued entries for this task
  for (let i = requeuedChunks.length - 1; i >= 0; i--) {
    if (requeuedChunks[i].taskId === taskId) requeuedChunks.splice(i, 1);
  }

  io.emit('task:failed', { taskId, reason });

  pendingTasks.delete(taskId);

  // try to move on to the next task
  tryDispatchNext(io);
}

// ── result verification ──────────────────────────────────────────────────────

/**
 * Spot-check `SPOT_CHECK_COUNT` random cells of a chunk result against a
 * server-side dot-product computation.
 *
 * @returns {{ ok: boolean, failures: Array<{ i, j, expected, got }> }}
 */
function verifyChunkResult(task, chunkMeta, resultRows) {
  const { matrixA, matrixB } = task;
  const { startRow, rowCount } = chunkMeta;
  const cols = matrixB[0].length;
  const failures = [];

  // ── untrusted client input validation ──
  // ensure the payload matches the expected dimensions before indexing
  if (!Array.isArray(resultRows) || resultRows.length !== rowCount) {
    return { ok: false, failures: [{ expected: `${rowCount} rows`, got: 'malformed array length' }] };
  }
  for (let r = 0; r < rowCount; r++) {
    if (!Array.isArray(resultRows[r]) || resultRows[r].length !== cols) {
      return { ok: false, failures: [{ expected: `${cols} cols`, got: 'malformed row length' }] };
    }
  }

  const checks = Math.min(SPOT_CHECK_COUNT, rowCount * cols);

  for (let c = 0; c < checks; c++) {
    // pick a random cell inside this chunk
    const localRow = Math.floor(Math.random() * rowCount);
    const col = Math.floor(Math.random() * cols);
    const globalRow = startRow + localRow;

    const expected = dotRowCol(matrixA[globalRow], matrixB, col);
    const got = resultRows[localRow][col];

    if (got !== expected) {
      failures.push({ i: globalRow, j: col, expected, got });
    }
  }

  return { ok: failures.length === 0, failures };
}

// ── progress events ──────────────────────────────────────────────────────────

function emitProgress(taskId, io) {
  const task = pendingTasks.get(taskId);
  if (!task) return;

  const chunksTotal = task.chunks.size;
  const chunksComplete = task.results.size;
  const percentComplete = Math.round((chunksComplete / chunksTotal) * 100);

  io.emit('task:progress', { taskId, chunksComplete, chunksTotal, percentComplete });
}

// ── reassembly & credits ─────────────────────────────────────────────────────

async function tryReassemble(taskId, io) {
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
  const contributions = [];
  for (const item of ordered) {
    const { chunkId, socketId, userId, username, startRow, rowCount, result } = item;
    const credits = rowCount;
    const node = nodes.get(socketId);
    
    let totalCredits = credits;
    if (node) {
      node.credits = (node.credits || 0) + credits;
      node.tasksCompleted++;
      totalCredits = node.credits;
    }

    // Persist to users table if authenticated using atomic increment
    if (userId) {
      try {
        const updatedTotals = await incrementUserCredits(userId, credits);
        if (updatedTotals) {
          totalCredits = updatedTotals.credits;
          if (node) {
            node.credits = totalCredits; // keep in sync using authoritative db total
          }
          console.log(`[credits] Persisted ${credits} credits to user ${username}. Total: ${updatedTotals.credits}, Lifetime: ${updatedTotals.total_contributed}`);
        }
      } catch (err) {
        console.error(`[credits] Failed to persist credits for user ${userId}:`, err);
      }
    }

    contributions.push({
      chunkId,
      socketId,
      userId,
      username,
      startRow,
      rowCount,
      computeMs: result.computeMs,
      creditsAwarded: credits,
      totalCredits: totalCredits,
    });
  }

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

  // Emit updated user info/credits to authenticated nodes
  for (const { socketId } of contributions) {
    const activeNode = nodes.get(socketId);
    if (activeNode) {
      io.to(socketId).emit('user_info', {
        username: activeNode.username,
        credits: activeNode.credits,
        isAuthenticated: !!activeNode.userId,
      });
    }
  }

  pendingTasks.delete(taskId);

  // task done → check if we should immediately dispatch the next one
  tryDispatchNext(io);
}

// ── pipeline helpers ──────────────────────────────────────────────────────────

function abortPipelineSession(sessionId, io, reason) {
  const session = activePipelines.get(sessionId);
  if (!session) return;
  
  for (const nodeId of session.activeNodes) {
    markIdle(nodeId, io);
  }
  
  const clientSocket = io.sockets.sockets.get(session.clientSocketId);
  if (clientSocket) {
    clientSocket.emit('generation_error', { sessionId, reason });
  }
  
  activePipelines.delete(sessionId);
}

function finishPipelineSession(sessionId, io) {
  const session = activePipelines.get(sessionId);
  if (!session) return;
  
  for (const nodeId of session.activeNodes) {
    markIdle(nodeId, io);
  }
  activePipelines.delete(sessionId);
}

// ── socket setup ─────────────────────────────────────────────────────────────

function setupSocketHandler(io) {
  io.on('connection', async (socket) => {
    // ── authenticate socket handshake ──
    let user = null;
    if (socket.handshake.auth && socket.handshake.auth.token) {
      const token = socket.handshake.auth.token;
      try {
        const { OAuth2Client } = require('google-auth-library');
        const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
        const client = new OAuth2Client(GOOGLE_CLIENT_ID);
        
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        
        if (payload) {
          const userId = payload.sub; // Google ID
          const googleEmail = payload.email;
          const googleName = payload.name;
          
          const usersList = await loadUsers();
          
          // 1. Look up user by Google ID
          let dbUser = usersList.find(u => u.id === userId);
          
          // 2. Resolve User ID Migration: If not found by Google ID, match by email/username prefix
          if (!dbUser) {
            dbUser = usersList.find(u => {
              if (!u.username) return false;
              const uname = u.username.toLowerCase();
              return (
                (googleEmail && (uname === googleEmail.toLowerCase() || googleEmail.toLowerCase().startsWith(uname + '@'))) ||
                (googleName && uname === googleName.toLowerCase())
              );
            });
            
            if (dbUser) {
              console.log(`[migration] Linked existing account '${dbUser.username}' (credits: ${dbUser.credits}) to Google ID ${userId}`);
              dbUser.id = userId; // Update ID to Google ID
              // Sync username with Google profile
              dbUser.username = googleName || googleEmail || dbUser.username;
              await saveUsers(usersList);
            }
          }

          // 3. Fallback: Create new user if no match found
          if (!dbUser) {
            dbUser = {
              id: userId,
              username: googleName || googleEmail || 'Google User',
              credits: 5000 // 5000 raw credits = 50 crystals
            };
            usersList.push(dbUser);
            await saveUsers(usersList);
            console.log(`[auth] Created new Google User ${dbUser.username} with ID ${userId}`);
          }

          user = {
            id: dbUser.id,
            username: dbUser.username,
            credits: dbUser.credits || 0,
            can_upgrade: dbUser.can_upgrade || false
          };
          console.log(`[auth] Google User ${dbUser.username} connected on socket ${socket.id}`);
        }
      } catch (err) {
        console.error('[auth] Google JWT verification failed:', err.message);
      }
    }

    // register this node
    socket.on('dev_auth', () => { const n = nodes.get(socket.id); if(n) n.status = 'idle'; });
    nodes.set(socket.id, {
      id: socket.id,
      userId: user ? user.id : null,
      username: user ? user.username : 'Anonymous Node',
      connectedAt: new Date(),
      tasksCompleted: 0,
      credits: user ? user.credits : 0,
      status: user ? 'idle' : 'unauthenticated',
    });

    console.log(`[node+] ${socket.id} (${user ? user.username : 'anonymous'}) connected (${nodes.size} total)`);

    // tell everyone the updated count
    io.emit('node_count', nodes.size);

    // Send user info back to connection (including game data for authenticated users)
    if (user) {
      const gameData = await loadUserGameData(user.id);
      const trophies = await loadUserTrophies(user.id);
      socket.emit('user_info', {
        username: user.username,
        credits: user.credits,
        isAuthenticated: true,
        isEligibleForUpgrade: true,
        trophies,
        ownedCards: gameData.ownedCards,
        savedDeck: gameData.savedDeck,
        upgrades: gameData.upgrades,
      });
    } else {
      socket.emit('user_info', {
        username: 'Anonymous Node',
        credits: 0,
        isAuthenticated: false,
        isEligibleForUpgrade: false,
      });
    }

    // a new idle node just appeared — maybe we can dispatch work now
    drainRequeued(io);
    tryDispatchNext(io);

    // handle compute results coming back from a browser
    socket.on('chunk_result', (data) => {
      try {
        // ── untrusted client input validation ──
        if (!data || typeof data.taskId !== 'string' || typeof data.chunkId !== 'string' || !Array.isArray(data.resultRows)) {
          console.warn(`[result] Malformed payload from ${socket.id}`);
          markIdle(socket.id, io);
          return;
        }

        const { taskId, chunkId, resultRows, computeMs } = data;

        const task = pendingTasks.get(taskId);
        if (!task) {
          markIdle(socket.id, io);
          return;
        }

        const chunkMeta = task.chunks.get(chunkId);
        if (!chunkMeta) {
          markIdle(socket.id, io);
          return;
        }

        // ignore results from a node that was already reassigned away
        if (chunkMeta.socketId !== socket.id) {
          console.log(
            `[result] Ignoring late result from ${socket.id} for ${chunkId} (reassigned to ${chunkMeta.socketId})`,
          );
          markIdle(socket.id, io);
          return;
        }

        // ── spot-check verification ──
        const verification = verifyChunkResult(task, chunkMeta, resultRows);
        if (!verification.ok) {
          console.warn(
            `[verify] Chunk ${chunkId} FAILED spot-check:`,
            verification.failures,
          );

          chunkMeta.retries++;

          if (chunkMeta.retries > MAX_CHUNK_RETRIES) {
            failTask(taskId, `Chunk ${chunkId} failed verification ${MAX_CHUNK_RETRIES} times`, io);
            markIdle(socket.id, io);
            return;
          }

          // re-dispatch only this chunk to the same or a different node
          console.log(
            `[verify] Re-dispatching chunk ${chunkId} (retry ${chunkMeta.retries}/${MAX_CHUNK_RETRIES})`,
          );
          markIdleSilent(socket.id);
          const target = getFastestIdleNode() || socket.id;
          reassignChunk(taskId, chunkId, target, io);
          return;
        }

        // ── verification passed — accept result ──

        // update performance map
        const msPerRow = computeMs / chunkMeta.rowCount;
        const prev = nodePerformance.get(socket.id);
        if (prev) {
          prev.avgMsPerRow = prev.avgMsPerRow * 0.7 + msPerRow * 0.3;
          prev.samples++;
        } else {
          nodePerformance.set(socket.id, { avgMsPerRow: msPerRow, samples: 1 });
        }

        // store result rows for reassembly
        task.results.set(chunkId, { rows: resultRows, computeMs });

        console.log(
          `[result] ${socket.id} finished chunk ${chunkId} of ${taskId} in ${computeMs}ms ✓`,
        );

        // emit granular progress
        emitProgress(taskId, io);

        // node is now idle — this also triggers tryDispatchNext via markIdle
        markIdle(socket.id, io);

        tryReassemble(taskId, io);
      } catch (err) {
        console.error(`[result] Uncaught exception processing chunk_result from ${socket.id}:`, err);
        markIdle(socket.id, io);
      }
    });

    // ── The Forge — game event handlers ────────────────────────────────────────

    // Shop: unlock a card
    socket.on('shop:unlock_card', async ({ cardId }) => {
      try {
        const node = nodes.get(socket.id);
        if (!node || !node.userId) {
          socket.emit('shop:unlock_result', { success: false, reason: 'not_authenticated' });
          return;
        }

        // validate card exists
        const card = CARD_MAP[cardId];
        if (!card) {
          socket.emit('shop:unlock_result', { success: false, reason: 'invalid_card' });
          return;
        }

        // check not already owned
        if (supabase) {
          const { data: existing } = await supabase
            .from('user_cards')
            .select('card_id')
            .eq('user_id', node.userId)
            .eq('card_id', cardId)
            .single();
          if (existing) {
            socket.emit('shop:unlock_result', { success: false, reason: 'already_owned' });
            return;
          }
        }

        // check balance (server-side, never trust client)
        const creditCost = card.cost * CREDITS_PER_CRYSTAL;
        const usersList = await loadUsers();
        const dbUser = usersList.find(u => u.id === node.userId);
        if (!dbUser || dbUser.credits < creditCost) {
          socket.emit('shop:unlock_result', { success: false, reason: 'insufficient_crystals' });
          return;
        }

        // deduct credits (never use negative amounts with incrementUserCredits)
        if (supabase) {
          // Atomic deduct: only succeeds if credits >= cost
          const { data: deducted, error: deductErr } = await supabase
            .from('users')
            .update({ credits: dbUser.credits - creditCost })
            .eq('id', node.userId)
            .gte('credits', creditCost)
            .select('credits')
            .single();

          if (deductErr || !deducted) {
            socket.emit('shop:unlock_result', { success: false, reason: 'insufficient_crystals' });
            return;
          }
          node.credits = deducted.credits;
        } else {
          // Local JSON fallback
          dbUser.credits = dbUser.credits - creditCost;
          const allUsers = await loadUsers();
          const localUser = allUsers.find(u => u.id === node.userId);
          if (localUser) {
            localUser.credits = dbUser.credits;
            await saveUsers(allUsers);
          }
          node.credits = dbUser.credits;
        }

        // insert card ownership
        if (supabase) {
          const { error: insertError } = await supabase
            .from('user_cards')
            .insert({ user_id: node.userId, card_id: cardId });
          if (insertError) {
            // rollback: re-add the cost (positive amount)
            await incrementUserCredits(node.userId, creditCost);
            node.credits = node.credits + creditCost;
            console.error('[shop] Failed to insert card:', insertError.message);
            socket.emit('shop:unlock_result', { success: false, reason: 'server_error' });
            return;
          }
        }

        console.log(`[shop] ${node.username} unlocked ${card.name} for ${card.cost} crystals`);

        // send result + updated user_info
        const gameData = await loadUserGameData(node.userId);
        const trophies = await loadUserTrophies(node.userId);
        socket.emit('shop:unlock_result', { success: true, cardId, newBalance: node.credits });
        socket.emit('user_info', {
          username: node.username,
          credits: node.credits,
          isAuthenticated: true,
          trophies,
          ownedCards: gameData.ownedCards,
          savedDeck: gameData.savedDeck,
        });
      } catch (err) {
        console.error('[shop] Uncaught error:', err);
        socket.emit('shop:unlock_result', { success: false, reason: 'server_error' });
      }
    });

    // Deck: save a deck of 4 cards
    socket.on('deck:save', async ({ cardIds }) => {
      try {
        const node = nodes.get(socket.id);
        if (!node || !node.userId) {
          socket.emit('deck:save_result', { success: false, reason: 'not_authenticated' });
          return;
        }

        // validate exactly 4 card IDs
        if (!Array.isArray(cardIds) || cardIds.length !== DECK_SIZE) {
          socket.emit('deck:save_result', { success: false, reason: 'invalid_deck_size' });
          return;
        }

        // validate all cards exist in catalog
        for (const cid of cardIds) {
          if (!CARD_MAP[cid]) {
            socket.emit('deck:save_result', { success: false, reason: `invalid_card: ${cid}` });
            return;
          }
        }

        // validate all cards are owned
        if (supabase) {
          const { data: owned } = await supabase
            .from('user_cards')
            .select('card_id')
            .eq('user_id', node.userId);
          const ownedSet = new Set((owned || []).map(r => r.card_id));
          for (const cid of cardIds) {
            if (!ownedSet.has(cid)) {
              socket.emit('deck:save_result', { success: false, reason: `card_not_owned: ${cid}` });
              return;
            }
          }

          // upsert deck
          const { error } = await supabase
            .from('user_decks')
            .upsert({ user_id: node.userId, card_ids: cardIds, updated_at: new Date().toISOString() },
                    { onConflict: 'user_id' });
          if (error) {
            console.error('[deck] Failed to save deck:', error.message);
            socket.emit('deck:save_result', { success: false, reason: 'server_error' });
            return;
          }
        }

        console.log(`[deck] ${node.username} saved deck: [${cardIds.join(', ')}]`);
        socket.emit('deck:save_result', { success: true });

        // send updated user_info
        const gameData = await loadUserGameData(node.userId);
        const trophies = await loadUserTrophies(node.userId);
        socket.emit('user_info', {
          username: node.username,
          credits: node.credits,
          isAuthenticated: true,
          isEligibleForUpgrade: true,
          trophies,
          ownedCards: gameData.ownedCards,
          savedDeck: gameData.savedDeck,
          upgrades: gameData.upgrades,
        });
      } catch (err) {
        console.error('[deck] Uncaught error:', err);
        socket.emit('deck:save_result', { success: false, reason: 'server_error' });
      }
    });

    // Battle: report result — server re-simulates to validate
    socket.on('battle:report_result', async ({ won, trophies: clientTrophies }) => {
      try {
        const node = nodes.get(socket.id);
        if (!node || !node.userId) {
          socket.emit('battle:result_confirmed', { success: false, reason: 'not_authenticated' });
          return;
        }

        // load player's saved deck
        const gameData = await loadUserGameData(node.userId);
        if (!gameData.savedDeck || gameData.savedDeck.length !== DECK_SIZE) {
          socket.emit('battle:result_confirmed', { success: false, reason: 'no_valid_deck' });
          return;
        }

        // resolve player deck to full card objects and apply upgrades
        const playerDeck = gameData.savedDeck.map(id => {
          const baseCard = CARD_MAP[id];
          if (!baseCard) return null;
          const upg = (gameData.upgrades || {})[id] || { attack: 0, defense: 0 };
          return {
            ...baseCard,
            attack: baseCard.attack + upg.attack,
            defense: baseCard.defense + upg.defense
          };
        }).filter(Boolean);
        
        if (playerDeck.length !== DECK_SIZE) {
          socket.emit('battle:result_confirmed', { success: false, reason: 'invalid_deck_cards' });
          return;
        }

        // get current trophies to determine bot tier
        const currentTrophies = await loadUserTrophies(node.userId);
        const botTier = getBotTier(currentTrophies);
        const botDeck = botTier.cardIds.map(id => CARD_MAP[id]);

        // re-simulate battle server-side
        const result = simulateBattle(playerDeck, botDeck);
        const serverSaysWon = result.winner === 'player';

        // validate client claim matches server simulation
        if (won !== serverSaysWon) {
          console.warn(`[battle] MISMATCH: ${node.username} claimed ${won ? 'win' : 'loss'} but server says ${serverSaysWon ? 'win' : 'loss'}`);
          // We no longer strictly reject mismatches because the client has a manual attack mechanic 
          // that the server's pure auto-attack simulation cannot account for.
        }

        // update trophies
        const delta = won ? TROPHY_WIN : TROPHY_LOSS;
        const newTrophies = Math.max(0, currentTrophies + delta);

        if (supabase) {
          const { error } = await supabase
            .from('users')
            .update({ trophies: newTrophies })
            .eq('id', node.userId);
          if (error) {
            console.error('[battle] Failed to update trophies:', error.message);
            socket.emit('battle:result_confirmed', { success: false, reason: 'server_error' });
            return;
          }
        }

        console.log(`[battle] ${node.username} ${won ? 'WON' : 'LOST'}: ${currentTrophies} → ${newTrophies} (${delta > 0 ? '+' : ''}${delta})`);

        // check for tier escalation toast
        let tierEscalation = null;
        const oldTier = getBotTier(currentTrophies);
        const newTier = getBotTier(newTrophies);
        if (oldTier.name !== newTier.name) {
          tierEscalation = { oldTier: oldTier.name, newTier: newTier.name };
        }

        socket.emit('battle:result_confirmed', {
          success: true,
          trophies: newTrophies,
          delta,
          tierEscalation,
        });

        // send updated user_info
        socket.emit('user_info', {
          username: node.username,
          credits: node.credits,
          isAuthenticated: true,
          isEligibleForUpgrade: true,
          trophies: newTrophies,
          ownedCards: gameData.ownedCards,
          savedDeck: gameData.savedDeck,
          upgrades: gameData.upgrades,
        });
      } catch (err) {
        console.error('[battle] Uncaught error:', err);
        socket.emit('battle:result_confirmed', { success: false, reason: 'server_error' });
      }
    });

    // Upgrades: handle card upgrade
    socket.on('card:upgrade', async ({ cardId, statType }) => {
      try {
        const node = nodes.get(socket.id);
        if (!node || !node.userId) {
          socket.emit('card:upgrade_result', { success: false, reason: 'not_authenticated' });
          return;
        }

        const usersList = await loadUsers();
        const dbUser = usersList.find(u => u.id === node.userId);
        if (!dbUser) {
          socket.emit('card:upgrade_result', { success: false, reason: 'not_eligible' });
          return;
        }

        if (statType !== 'attack' && statType !== 'defense') {
          socket.emit('card:upgrade_result', { success: false, reason: 'invalid_stat' });
          return;
        }

        const card = CARD_MAP[cardId];
        if (!card) {
          socket.emit('card:upgrade_result', { success: false, reason: 'invalid_card' });
          return;
        }

        if (dbUser.credits < 1000) {
          socket.emit('card:upgrade_result', { success: false, reason: 'insufficient_crystals' });
          return;
        }

        if (supabase) {
          // Check ownership
          const { data: existing } = await supabase.from('user_cards').select('card_id').eq('user_id', node.userId).eq('card_id', cardId).single();
          if (!existing) {
            socket.emit('card:upgrade_result', { success: false, reason: 'card_not_owned' });
            return;
          }

          // Fetch current upgrades
          const { data: upgData } = await supabase.from('user_card_upgrades').select('attack_upgrades, defense_upgrades').eq('user_id', node.userId).eq('card_id', cardId).single();
          const currentAttack = upgData ? (upgData.attack_upgrades || 0) : 0;
          const currentDefense = upgData ? (upgData.defense_upgrades || 0) : 0;

          if (currentAttack + currentDefense >= 10) {
            socket.emit('card:upgrade_result', { success: false, reason: 'max_upgrades_reached' });
            return;
          }

          // Deduct credits
          const { data: deducted, error: deductErr } = await supabase.from('users').update({ credits: dbUser.credits - 1000 }).eq('id', node.userId).gte('credits', 1000).select('credits').single();
          if (deductErr || !deducted) {
            socket.emit('card:upgrade_result', { success: false, reason: 'insufficient_crystals' });
            return;
          }
          node.credits = deducted.credits;

          // Upsert upgrade
          const newAttack = statType === 'attack' ? currentAttack + 1 : currentAttack;
          const newDefense = statType === 'defense' ? currentDefense + 1 : currentDefense;
          
          await supabase.from('user_card_upgrades').upsert({
            user_id: node.userId,
            card_id: cardId,
            attack_upgrades: newAttack,
            defense_upgrades: newDefense,
            updated_at: new Date().toISOString()
          });

          // Write audit log
          await supabase.from('upgrade_audit_logs').insert({
            user_id: node.userId,
            card_id: cardId,
            stat_upgraded: statType,
            cost: 1000
          });

          socket.emit('card:upgrade_result', { success: true });
        } else {
          socket.emit('card:upgrade_result', { success: false, reason: 'supabase_required_for_upgrades' });
          return;
        }

        const gameData = await loadUserGameData(node.userId);
        const trophies = await loadUserTrophies(node.userId);
        socket.emit('user_info', {
          username: node.username,
          credits: node.credits,
          isAuthenticated: true,
          isEligibleForUpgrade: true,
          trophies,
          ownedCards: gameData.ownedCards,
          savedDeck: gameData.savedDeck,
          upgrades: gameData.upgrades,
        });

      } catch (err) {
        console.error('[upgrade] Uncaught error:', err);
        socket.emit('card:upgrade_result', { success: false, reason: 'server_error' });
      }
    });
    // ── INFERENCE PIPELINE EVENTS ────────────────────────────────────────────

    socket.on('start_generation', async ({ sessionId, prompt }) => {
      const idleIds = getIdleNodeIds();
      if (idleIds.length === 0) {
        socket.emit('generation_error', { sessionId, reason: 'No idle nodes available for inference pipeline.' });
        return;
      }
      
      const stages = planStages(LLM_LAYERS, idleIds.length);
      const assignedNodes = [];
      for (let i = 0; i < stages.length; i++) {
        const nodeId = idleIds[i];
        markBusy(nodeId);
        assignedNodes.push(nodeId);
        stages[i].socketId = nodeId;
      }
      
      let allResponded = true;
      try {
        await Promise.all(assignedNodes.map(nodeId => {
          return new Promise((resolve, reject) => {
            const targetSocket = io.sockets.sockets.get(nodeId);
            if (!targetSocket) return reject(new Error('Node missing'));
            
            const timer = setTimeout(() => reject(new Error('Ping timeout')), 3000);
            
            targetSocket.emit('pipeline:ping', {}, () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }));
      } catch (err) {
        allResponded = false;
      }
      
      if (!allResponded) {
        assignedNodes.forEach(nodeId => markIdle(nodeId, io));
        socket.emit('generation_error', { sessionId, reason: 'Ping failed for pipeline nodes. Aborting.' });
        return;
      }
      
      const tokenizer = getTokenizer();
      const chatPrompt = tokenizer.applyChatTemplate(prompt);
      const tokenIds = tokenizer.encode(chatPrompt);
      
      activePipelines.set(sessionId, {
        clientSocketId: socket.id,
        stages,
        activeNodes: new Set(assignedNodes),
        promptTokens: tokenIds,
        posOff: 0
      });
      
      stages.forEach(stage => {
        const targetSocket = io.sockets.sockets.get(stage.socketId);
        if (targetSocket) {
          targetSocket.emit('stage_assign', {
            sessionId,
            stageIndex: stage.stageIndex,
            layerRange: stage.layerRange,
            role: stage.role
          });
        }
      });
      
      const stage0Socket = io.sockets.sockets.get(stages[0].socketId);
      if (stage0Socket) {
        stage0Socket.emit('forward_request', {
          sessionId,
          stageIndex: 0,
          hiddenStates: null,
          positionId: 0,
          tokenIndex: tokenIds
        });
      }
    });

    socket.on('forward_response', ({ sessionId, stageIndex, hiddenStates, tokenId, tokenText }) => {
      const session = activePipelines.get(sessionId);
      if (!session) return;
      
      const isLastStage = stageIndex === session.stages.length - 1;
      
      if (!isLastStage) {
        const nextStage = session.stages[stageIndex + 1];
        const nextSocket = io.sockets.sockets.get(nextStage.socketId);
        if (nextSocket) {
          nextSocket.emit('forward_request', {
            sessionId,
            stageIndex: nextStage.stageIndex,
            hiddenStates,
            positionId: session.posOff,
            tokenIndex: null
          });
        }
      } else {
        const clientSocket = io.sockets.sockets.get(session.clientSocketId);
        if (clientSocket) {
          clientSocket.emit('final_token', { sessionId, tokenId, tokenText });
        }
        
        const tokenizer = getTokenizer();
        if (tokenId === tokenizer.eosId) {
          finishPipelineSession(sessionId, io);
        } else {
          const tokensSentSoFar = session.posOff === 0 ? session.promptTokens.length : 1;
          session.posOff += tokensSentSoFar;
          
          const stage0 = session.stages[0];
          const stage0Socket = io.sockets.sockets.get(stage0.socketId);
          if (stage0Socket) {
            stage0Socket.emit('forward_request', {
              sessionId,
              stageIndex: 0,
              hiddenStates: null,
              positionId: session.posOff,
              tokenIndex: [tokenId]
            });
          }
        }
      }
    });

    socket.on('disconnect', () => {
      // remove from pool FIRST so it can't be picked as a reassignment target
      nodes.delete(socket.id);
      nodePerformance.delete(socket.id);

      // Pipeline disconnect check
      for (const [sessionId, session] of activePipelines.entries()) {
        if (session.activeNodes.has(socket.id)) {
          abortPipelineSession(sessionId, io, 'a node dropped — restarting');
        }
      }

      // immediately reassign any in-flight chunks from this node
      for (const [taskId, task] of pendingTasks) {
        for (const [chunkId, meta] of task.chunks) {
          if (meta.socketId === socket.id && !task.results.has(chunkId)) {
            meta.retries++;
            if (meta.retries > MAX_CHUNK_RETRIES) {
              failTask(taskId, `Node ${socket.id} disconnected, chunk ${chunkId} exceeded retries`, io);
              break;
            }
            const replacement = getFastestIdleNode();
            if (replacement) {
              reassignChunk(taskId, chunkId, replacement, io);
            } else {
              meta.deadline = Infinity;
              requeuedChunks.push({ taskId, chunkId });
              console.log(`[requeue] Chunk ${chunkId} queued (node ${socket.id} disconnected)`);
            }
          }
        }
      }

      console.log(`[node-] ${socket.id} disconnected (${nodes.size} total)`);
      io.emit('node_count', nodes.size);
    });
  });

  // deadline scanner — every 2 s, check for overdue chunks
  setInterval(() => scanDeadlines(io), DEADLINE_SCAN_INTERVAL_MS);

  // seed the first task so work begins as soon as a node connects
  enqueueTask();
}

// ── leaderboard logic ────────────────────────────────────────────────────────
async function getLeaderboard() {
  const usersList = await loadUsers();
  // Filter out users with 0 total_contributed to keep leaderboard clean
  const activeUsers = usersList.filter(u => (u.total_contributed || 0) > 0);
  
  // Sort descending by total_contributed
  activeUsers.sort((a, b) => (b.total_contributed || 0) - (a.total_contributed || 0));
  
  // Return top 10
  return activeUsers.slice(0, 10).map((u, index) => ({
    rank: index + 1,
    username: u.username,
    total_contributed: u.total_contributed || 0,
  }));
}

async function getForgemasterLeaderboard() {
  const usersList = await loadUsers();
  // Filter out users with 0 trophies
  const activePlayers = usersList.filter(u => (u.trophies || 0) > 0);
  
  // Sort descending by trophies
  activePlayers.sort((a, b) => (b.trophies || 0) - (a.trophies || 0));
  
  // Return top 10
  return activePlayers.slice(0, 10).map((u, index) => ({
    rank: index + 1,
    username: u.username,
    trophies: u.trophies || 0,
  }));
}

module.exports = { setupSocketHandler, getLeaderboard, getForgemasterLeaderboard };
