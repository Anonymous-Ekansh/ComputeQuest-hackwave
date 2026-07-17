const { MOLECULE_BATCH_SIZE, TASK_TYPES, TROPHY_WIN, TROPHY_LOSS, DECK_SIZE, CREDITS_PER_CRYSTAL, LLM_LAYERS } = require('../../shared/constants');
const { CARD_MAP } = require('../../shared/cards');
const { getTokenizer } = require('./tokenizer');
const { planStages, planMoleculeBatches } = require('./taskQueue');
const { scoreMolecule } = require('./molecularScorer');
const { getBotTier } = require('../../shared/bots');
const { simulateBattle } = require('../../shared/battleLogic');
const fs = require('fs');
const path = require('path');


// ── constants ────────────────────────────────────────────────────────────────

const BASE_TIMEOUT_MS = 30_000;          // scaled by complexity + node speed
const MAX_CHUNK_RETRIES = 3;             // per-batch retry cap before task:failed
const DEADLINE_SCAN_INTERVAL_MS = 2_000; // how often we scan for overdue batches
const SPOT_CHECK_TOLERANCE = 0.01;       // max allowed score delta for spot-checks

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
          can_upgrade: u.can_upgrade ?? true
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

// socketId -> { avgMsPerBatch, samples }
const nodePerformance = new Map();

// ── molecule screening state ─────────────────────────────────────────────────

// Loaded once at startup from server/data/
let moleculeLibrary = [];
let targetConfig = {};

// The current screening run
let currentRunId = null;
// FIFO queue of batches waiting for idle nodes: { batchId, molecules }
let batchQueue = [];
// Total batches in the current run (for progress tracking)
let totalBatchCount = 0;

// batchId -> { socketId, userId, username, deadline, retries, molecules }
const pendingBatches = new Map();

// batches that timed out with no idle node — requeued for next idle
// { batchId }
const requeuedBatches = [];

// Completed batch count for current run
let completedBatchCount = 0;

// Top-100 molecule leaderboard (in-memory, persisted to Supabase)
// Array of { smiles, name, id, composite_score, mw, logp, hbd, hba, rotatable_bonds, druglikeness_score, complementarity_score }
let topMolecules = [];
const TOP_MOLECULES_LIMIT = 100;

// ── pipeline state ───────────────────────────────────────────────────────────
// sessionId -> { stages: [ {stageIndex, socketId, ...} ], activeNodes: Set<socketId>, promptTokens: number[], currentTokenIndex: number, posOff: number }
const activePipelines = new Map();

// ── helpers ──────────────────────────────────────────────────────────────────

/** Get all node IDs that are currently idle */
function getIdleNodeIds(requireInference = false) {
  const idle = [];
  for (const [id, node] of nodes) {
    if (node.status === 'idle') {
      if (requireInference && !node.supportsInference) continue;
      idle.push(id);
    }
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

/** Get the fastest idle node by avgMsPerBatch (lowest = fastest) */
function getFastestIdleNode(customIds = null) {
  const idle = customIds || getIdleNodeIds();
  if (idle.length === 0) return null;

  let best = idle[0];
  let bestSpeed = Infinity;
  for (const id of idle) {
    const perf = nodePerformance.get(id);
    const speed = perf ? perf.avgMsPerBatch : Infinity;
    if (speed < bestSpeed) {
      bestSpeed = speed;
      best = id;
    }
  }
  return best;
}

/**
 * Adaptive timeout for a batch on a given node.
 * Clamped to [5_000, 120_000] ms.
 */
function adaptiveTimeout(socketId) {
  const perf = nodePerformance.get(socketId);
  const avgMs = perf ? Math.max(perf.avgMsPerBatch, 100) : BASE_TIMEOUT_MS;
  // Give 3× the average observed time, or the base timeout, whichever is larger
  const scaled = Math.max(BASE_TIMEOUT_MS, avgMs * 3);
  return Math.max(5_000, Math.min(120_000, scaled));
}

// ── molecule screening lifecycle ─────────────────────────────────────────────

/**
 * Load molecule library and target config from disk.
 * Called once at server startup.
 */
function loadScreeningData() {
  const libPath = path.join(__dirname, '..', 'data', 'molecule_library.json');
  const targetPath = path.join(__dirname, '..', 'data', 'target.json');

  try {
    const libRaw = JSON.parse(fs.readFileSync(libPath, 'utf-8'));
    moleculeLibrary = libRaw.molecules || [];
    console.log(`[screening] Loaded ${moleculeLibrary.length} molecules from molecule_library.json`);
  } catch (err) {
    console.error('[screening] Failed to load molecule_library.json:', err.message);
    moleculeLibrary = [];
  }

  try {
    targetConfig = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
    console.log(`[screening] Loaded target: ${targetConfig.target_name} (${targetConfig.pdb_id})`);
  } catch (err) {
    console.error('[screening] Failed to load target.json:', err.message);
    targetConfig = {};
  }
}

/**
 * Start (or restart) a screening run.
 * Builds the batch queue from the full molecule library.
 */
function startScreeningRun(io) {
  currentRunId = `screen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const batches = planMoleculeBatches(moleculeLibrary, MOLECULE_BATCH_SIZE);
  batchQueue = [...batches];
  totalBatchCount = batches.length;
  completedBatchCount = 0;

  console.log(`[screening] Started run ${currentRunId}: ${totalBatchCount} batches, ${moleculeLibrary.length} molecules`);

  io.emit('screening:status', {
    runId: currentRunId,
    totalBatches: totalBatchCount,
    completedBatches: 0,
    totalMolecules: moleculeLibrary.length,
    status: 'running',
  });
}

/**
 * Core scheduling loop — triggered after every state change.
 * Dispatches the next queued batch to an idle node.
 * Unlike MATRIX_MULTIPLY, multiple batches can be in-flight simultaneously
 * (one per idle node).
 */
function tryDispatchNext(io) {
  // Keep dispatching while we have both idle nodes and pending batches
  while (true) {
    if (batchQueue.length === 0) break;

    const idleNode = getFastestIdleNode();
    if (!idleNode) break;

    const node = nodes.get(idleNode);
    if (!node || node.status === 'unauthenticated') break;

    const batch = batchQueue.shift();
    dispatchBatch(io, batch, idleNode);
  }
}

/** Dispatch a single batch to a specific node */
function dispatchBatch(io, batch, socketId) {
  const { batchId, molecules } = batch;
  const node = nodes.get(socketId);
  const deadline = Date.now() + adaptiveTimeout(socketId);

  pendingBatches.set(batchId, {
    socketId,
    userId: node ? node.userId : null,
    username: node ? node.username : 'Anonymous Node',
    deadline,
    retries: 0,
    molecules,
  });

  markBusy(socketId);

  io.to(socketId).emit('molecule_batch', {
    taskId: currentRunId,
    batchId,
    molecules,
    target: targetConfig,
  });

  console.log(
    `[dispatch] Batch ${batchId} (${molecules.length} mols) → ${socketId} ` +
    `(${node ? node.username : 'anon'})`,
  );
}

// ── deadline scanner ─────────────────────────────────────────────────────────

function scanDeadlines(io) {
  const now = Date.now();

  for (const [batchId, meta] of pendingBatches) {
    if (now < meta.deadline) continue;

    // ── overdue ──
    meta.retries++;
    console.log(
      `[timeout] Batch ${batchId} on ${meta.socketId} overdue ` +
      `(retry ${meta.retries}/${MAX_CHUNK_RETRIES})`,
    );

    if (meta.retries > MAX_CHUNK_RETRIES) {
      // Give up on this batch — remove it and log
      console.error(`[FAILED] Batch ${batchId} exceeded ${MAX_CHUNK_RETRIES} retries, skipping`);
      markIdleSilent(meta.socketId);
      pendingBatches.delete(batchId);
      completedBatchCount++; // count as "done" to avoid blocking the run
      emitScreeningProgress(io);
      checkRunComplete(io);
      continue;
    }

    // mark the old node idle (it's apparently stuck)
    markIdleSilent(meta.socketId);

    // try to reassign
    const replacement = getFastestIdleNode();
    if (replacement) {
      reassignBatch(batchId, replacement, io);
    } else {
      // no idle node → requeue for the next available one
      meta.deadline = Infinity; // stop re-triggering until reassigned
      requeuedBatches.push({ batchId });
      console.log(`[requeue] Batch ${batchId} queued for next idle node`);
    }
  }
}

/** Reassign a single batch to a new node */
function reassignBatch(batchId, socketId, io) {
  const meta = pendingBatches.get(batchId);
  if (!meta) return;

  const replacementNode = nodes.get(socketId);
  meta.socketId = socketId;
  meta.userId = replacementNode ? replacementNode.userId : null;
  meta.username = replacementNode ? replacementNode.username : 'Anonymous Node';
  meta.deadline = Date.now() + adaptiveTimeout(socketId);

  if (!replacementNode || replacementNode.status === 'unauthenticated') {
    console.warn(`[reassign] Refusing to reassign batch to unauthenticated socket ${socketId}`);
    return;
  }

  markBusy(socketId);
  io.to(socketId).emit('molecule_batch', {
    taskId: currentRunId,
    batchId,
    molecules: meta.molecules,
    target: targetConfig,
  });

  console.log(
    `[reassign] Batch ${batchId} → ${socketId} ` +
    `(deadline +${adaptiveTimeout(socketId)}ms)`,
  );
}

/** Drain requeued batches whenever an idle node becomes available */
function drainRequeued(io) {
  while (requeuedBatches.length > 0) {
    const replacement = getFastestIdleNode();
    if (!replacement) break;

    const { batchId } = requeuedBatches.shift();

    // batch may have been removed in the meantime
    if (!pendingBatches.has(batchId)) continue;

    reassignBatch(batchId, replacement, io);
  }
}

// ── progress & run completion ────────────────────────────────────────────────

function emitScreeningProgress(io) {
  io.emit('screening:progress', {
    runId: currentRunId,
    completedBatches: completedBatchCount,
    totalBatches: totalBatchCount,
    percentComplete: Math.round((completedBatchCount / totalBatchCount) * 100),
    moleculesScored: completedBatchCount * MOLECULE_BATCH_SIZE,
    totalMolecules: moleculeLibrary.length,
  });
}

/**
 * Check if the current screening run is complete.
 * If all batches have been returned, loop back for a continuous demo.
 */
function checkRunComplete(io) {
  if (completedBatchCount >= totalBatchCount && pendingBatches.size === 0) {
    console.log(
      `[screening] Run ${currentRunId} COMPLETE — ` +
      `${totalBatchCount}/${totalBatchCount} batches, ` +
      `${moleculeLibrary.length} molecules scored`
    );

    io.emit('screening:status', {
      runId: currentRunId,
      totalBatches: totalBatchCount,
      completedBatches: completedBatchCount,
      totalMolecules: moleculeLibrary.length,
      status: 'complete',
    });

    // Loop: restart with the same library for continuous demo
    console.log('[screening] Looping — starting new screening run');
    startScreeningRun(io);
    tryDispatchNext(io);
  }
}

// ── molecule leaderboard (top 100) ───────────────────────────────────────────

/**
 * Merge newly scored molecules into the top-100 leaderboard.
 * Also persist to Supabase if available.
 */
async function updateMoleculeLeaderboard(scoredMolecules) {
  // Merge into in-memory list
  for (const mol of scoredMolecules) {
    if (mol == null || typeof mol.composite_score !== 'number') continue;

    // Check if this molecule is already in the leaderboard (by smiles)
    const existingIdx = topMolecules.findIndex(m => m.smiles === mol.smiles);
    if (existingIdx >= 0) {
      // Update if the new score is better
      if (mol.composite_score > topMolecules[existingIdx].composite_score) {
        topMolecules[existingIdx] = mol;
      }
    } else {
      topMolecules.push(mol);
    }
  }

  // Sort descending by composite_score and truncate to top 100
  topMolecules.sort((a, b) => b.composite_score - a.composite_score);
  topMolecules = topMolecules.slice(0, TOP_MOLECULES_LIMIT);

  // Persist to Supabase
  if (supabase) {
    try {
      // Upsert scored molecules
      const rows = scoredMolecules
        .filter(m => m != null && typeof m.composite_score === 'number')
        .map(m => ({
          smiles: m.smiles,
          molecule_name: m.name || null,
          is_known_reference: m.is_known_reference || false,
          mw: m.mw,
          logp: m.logp,
          hbd: m.hbd,
          hba: m.hba,
          rotatable_bonds: m.rotatable_bonds,
          druglikeness_score: m.druglikeness_score,
          complementarity_score: m.complementarity_score,
          composite_score: m.composite_score,
        }));

      if (rows.length > 0) {
        const { error } = await supabase
          .from('molecule_scores')
          .upsert(rows, { onConflict: 'smiles' });

        if (error) {
          console.error('[leaderboard] Supabase upsert error:', error.message);
        }
      }
    } catch (err) {
      console.error('[leaderboard] Supabase persist error:', err.message || err);
    }
  }
}

// ── spot-check verification ──────────────────────────────────────────────────

/**
 * Re-score 1 random molecule from a batch result server-side and compare.
 * Logs a warning if the scores differ beyond SPOT_CHECK_TOLERANCE.
 */
async function spotCheckBatchResult(results, batchMolecules) {
  if (!results || results.length === 0) return;

  // Pick a random result to verify
  const idx = Math.floor(Math.random() * results.length);
  const clientResult = results[idx];
  if (!clientResult || !clientResult.smiles) return;

  try {
    const serverResult = await scoreMolecule(clientResult.smiles, targetConfig);

    if (!serverResult) {
      console.warn(
        `[spot-check] Server could not parse SMILES that client scored: "${clientResult.smiles}"`
      );
      return;
    }

    const delta = Math.abs(clientResult.composite_score - serverResult.composite_score);
    if (delta > SPOT_CHECK_TOLERANCE) {
      console.warn(
        `[spot-check] MISMATCH for "${clientResult.smiles}": ` +
        `client=${clientResult.composite_score}, server=${serverResult.composite_score}, ` +
        `delta=${delta.toFixed(4)}`
      );
    } else {
      console.log(
        `[spot-check] OK "${clientResult.smiles.slice(0, 30)}…" ` +
        `(Δ=${delta.toFixed(4)}) ✓`
      );
    }
  } catch (err) {
    console.error('[spot-check] Error during server-side re-scoring:', err.message || err);
  }
}

// ── pipeline helpers ──────────────────────────────────────────────────────────

function abortPipelineSession(sessionId, io, reason) {
  const session = activePipelines.get(sessionId);
  if (!session) return;

  if (session.stallTimer) {
    clearTimeout(session.stallTimer);
    session.stallTimer = null;
  }

  for (const nodeId of session.activeNodes) {
    markIdle(nodeId, io);
  }

  const clientSocket = io.sockets.sockets.get(session.clientSocketId);
  if (clientSocket) {
    clientSocket.emit('generation_error', { sessionId, reason });
  }
  io.emit('pipeline_error', { sessionId, reason });

  activePipelines.delete(sessionId);
}

function finishPipelineSession(sessionId, io) {
  const session = activePipelines.get(sessionId);
  if (!session) return;

  if (session.stallTimer) {
    clearTimeout(session.stallTimer);
    session.stallTimer = null;
  }

  for (const nodeId of session.activeNodes) {
    markIdle(nodeId, io);
  }
  activePipelines.delete(sessionId);
}

function resetStallTimer(sessionId, stageIndex, io) {
  const session = activePipelines.get(sessionId);
  if (!session) return;

  if (session.stallTimer) {
    clearTimeout(session.stallTimer);
  }
  session.expectedStageIndex = stageIndex;
  session.stallTimer = setTimeout(() => {
    console.warn(`[pipeline] Session ${sessionId} stalled at stage ${stageIndex}`);
    abortPipelineSession(sessionId, io, 'A pipeline stage stalled — aborting.');
  }, 120000); // 120 seconds — generous for WebLLM first-token latency
}

// ── socket setup ─────────────────────────────────────────────────────────────

function setupSocketHandler(io) {
  // ── Load screening data at startup ──
  loadScreeningData();

  io.on('connection', (socket) => {
    // ── 1. Synchronous Initial Setup ──
    nodes.set(socket.id, {
      id: socket.id,
      userId: null,
      username: 'Anonymous Node',
      connectedAt: new Date(),
      tasksCompleted: 0,
      credits: 0,
      status: 'unauthenticated',
      supportsInference: false,
      isWarm: false,
      warmProgress: 0
    });

    socket.on('dev_auth', () => { const n = nodes.get(socket.id); if (n) n.status = 'idle'; });

    socket.on('register_worker', ({ supportsInference }) => {
      const node = nodes.get(socket.id);
      if (node) {
        node.supportsInference = supportsInference;
        node.status = 'idle';
        drainRequeued(io);
        tryDispatchNext(io);
      }
    });

    socket.on('node_warm_progress', ({ percent }) => {
      const node = nodes.get(socket.id);
      if (node) {
        node.warmProgress = percent;
      }
    });

    socket.on('node_warm_ready', () => {
      const node = nodes.get(socket.id);
      if (node) {
        node.isWarm = true;
        node.warmProgress = 100;
      }
    });

    // ── 2. Asynchronous Authentication ──
    (async () => {
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
              can_upgrade: dbUser.can_upgrade ?? true
            };
            console.log(`[auth] Google User ${dbUser.username} connected on socket ${socket.id}`);
          }
        } catch (err) {
          console.error('[auth] Google JWT verification failed:', err.message);
        }
      }

      const node = nodes.get(socket.id);
      if (!node) return; // Socket disconnected before auth finished

      if (user) {
        node.userId = user.id;
        node.username = user.username;
        node.credits = user.credits;
        node.status = 'idle'; // Upgraded from unauthenticated

        drainRequeued(io);
        tryDispatchNext(io);

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
          trophies: [],
          ownedCards: [],
          savedDeck: [],
          upgrades: {},
        });
      }

      console.log(`[node+] ${socket.id} (${user ? user.username : 'anonymous'}) connected (${nodes.size} total)`);
      io.emit('node_count', nodes.size);
    })();

    // ── handle molecule batch results coming back from a browser ──
    socket.on('molecule_batch_result', async (data) => {
      try {
        // ── untrusted client input validation ──
        if (!data || typeof data.batchId !== 'string' || !Array.isArray(data.results)) {
          console.warn(`[result] Malformed molecule_batch_result from ${socket.id}`);
          markIdle(socket.id, io);
          return;
        }

        const { batchId, results, computeMs } = data;

        const meta = pendingBatches.get(batchId);
        if (!meta) {
          markIdle(socket.id, io);
          return;
        }

        // ignore results from a node that was already reassigned away
        if (meta.socketId !== socket.id) {
          console.log(
            `[result] Ignoring late result from ${socket.id} for ${batchId} (reassigned to ${meta.socketId})`,
          );
          markIdle(socket.id, io);
          return;
        }

        // ── spot-check verification (async, non-blocking) ──
        spotCheckBatchResult(results, meta.molecules).catch(err => {
          console.error('[spot-check] Uncaught error:', err);
        });

        // ── update performance map ──
        const elapsed = computeMs || 0;
        const prev = nodePerformance.get(socket.id);
        if (prev) {
          prev.avgMsPerBatch = prev.avgMsPerBatch * 0.7 + elapsed * 0.3;
          prev.samples++;
        } else {
          nodePerformance.set(socket.id, { avgMsPerBatch: elapsed, samples: 1 });
        }

        // ── award credits: 1 credit per molecule scored ──
        const credits = results.length;
        const node = nodes.get(socket.id);

        let totalCredits = credits;
        if (node) {
          node.credits = (node.credits || 0) + credits;
          node.tasksCompleted++;
          totalCredits = node.credits;
        }

        // Persist to users table if authenticated
        if (meta.userId) {
          try {
            const updatedTotals = await incrementUserCredits(meta.userId, credits);
            if (updatedTotals) {
              totalCredits = updatedTotals.credits;
              if (node) {
                node.credits = totalCredits;
              }
              console.log(`[credits] Persisted ${credits} credits to user ${meta.username}. Total: ${updatedTotals.credits}, Lifetime: ${updatedTotals.total_contributed}`);
            }
          } catch (err) {
            console.error(`[credits] Failed to persist credits for user ${meta.userId}:`, err);
          }
        }

        // ── update molecule leaderboard ──
        // Tag results with molecule metadata from the original batch
        const enrichedResults = results.map((r, i) => {
          const origMol = meta.molecules[i];
          return {
            ...r,
            name: origMol ? origMol.name : undefined,
            molecule_id: origMol ? origMol.id : undefined,
            is_known_reference: origMol ? origMol.is_known_reference : undefined,
          };
        });
        updateMoleculeLeaderboard(enrichedResults).catch(err => {
          console.error('[leaderboard] Update error:', err);
        });

        console.log(
          `[result] ${socket.id} finished batch ${batchId} ` +
          `(${results.length} mols, ${elapsed}ms, +${credits}cr) ✓`,
        );

        // Emit updated user info/credits to the node
        if (node) {
          io.to(socket.id).emit('user_info', {
            username: node.username,
            credits: node.credits,
            isAuthenticated: !!node.userId,
          });
        }

        // ── clean up this batch ──
        pendingBatches.delete(batchId);
        completedBatchCount++;

        // emit progress
        emitScreeningProgress(io);

        // node is now idle — also triggers tryDispatchNext
        markIdle(socket.id, io);

        // check if the whole run is done
        checkRunComplete(io);

      } catch (err) {
        console.error(`[result] Uncaught exception processing molecule_batch_result from ${socket.id}:`, err);
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
        }

        // update trophies
        const delta = serverSaysWon ? TROPHY_WIN : TROPHY_LOSS;
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
      const idleIds = getIdleNodeIds(true);
      if (idleIds.length === 0) {
        socket.emit('generation_error', { sessionId, reason: 'No idle nodes available for inference pipeline.' });
        return;
      }

      // Pick ONE fast node for Request-Parallel inference, prefer warm nodes
      let warmIdleIds = idleIds.filter(id => {
        const n = nodes.get(id);
        return n && n.isWarm;
      });
      
      let assignedNodeId;
      if (warmIdleIds.length > 0) {
        assignedNodeId = getFastestIdleNode(warmIdleIds) || warmIdleIds[0];
      } else {
        assignedNodeId = getFastestIdleNode(idleIds) || idleIds[0];
        socket.emit('generation_warning', { warning: 'No warm node available; this reply may take several minutes while a node loads the model for the first time' });
      }
      
      markBusy(assignedNodeId);

      let allResponded = true;
      try {
        await new Promise((resolve, reject) => {
          const targetSocket = io.sockets.sockets.get(assignedNodeId);
          if (!targetSocket) return reject(new Error('Node missing'));

          const timer = setTimeout(() => reject(new Error('Ping timeout')), 3000);

          targetSocket.emit('pipeline:ping', {}, () => {
            clearTimeout(timer);
            resolve();
          });
        });
      } catch (err) {
        allResponded = false;
      }

      if (!allResponded) {
        markIdle(assignedNodeId, io);
        socket.emit('generation_error', { sessionId, reason: 'Ping failed for node. Aborting.' });
        return;
      }

      let tokenizer, chatPrompt, tokenIds;
      try {
        tokenizer = getTokenizer();
        chatPrompt = tokenizer.applyChatTemplate(prompt);
        tokenIds = tokenizer.encode(chatPrompt);
      } catch (err) {
        console.error('[pipeline] Error initializing tokenizer:', err);
        markIdle(assignedNodeId, io);
        socket.emit('generation_error', { sessionId, reason: 'Tokenizer unavailable on server.' });
        return;
      }

      const stages = [{
        stageIndex: 0,
        layerRange: [0, LLM_LAYERS - 1], // All layers
        role: 'all',
        socketId: assignedNodeId
      }];

      activePipelines.set(sessionId, {
        clientSocketId: socket.id,
        stages,
        activeNodes: new Set([assignedNodeId]),
        promptTokens: tokenIds,
        stallTimer: null,
        expectedStageIndex: 0
      });

      // Global broadcast for UI visualization
      io.emit('pipeline_plan', { sessionId, stages });

      const targetSocket = io.sockets.sockets.get(assignedNodeId);
      if (targetSocket) {
        targetSocket.emit('stage_assign', {
          sessionId,
          stageIndex: 0,
          layerRange: [0, LLM_LAYERS - 1],
          role: 'all'
        });
      }

      // Wait for node to load its model shards
      let allReady = true;
      try {
        await new Promise((resolve, reject) => {
          const targetSocket = io.sockets.sockets.get(assignedNodeId);
          if (!targetSocket) return reject(new Error('Node missing'));

          const envTimeout = process.env.SHARD_LOAD_TIMEOUT_MS ? parseInt(process.env.SHARD_LOAD_TIMEOUT_MS, 10) : null;
          const outerTimeoutMs = envTimeout || 1800000; // 30 minutes absolute max or env override
          let progressTimerMs = 90000; // 90 seconds progress timeout
          let progressTimer = null;
          let outerTimer = null;
          
          const clearTimers = () => {
            if (progressTimer) clearTimeout(progressTimer);
            if (outerTimer) clearTimeout(outerTimer);
          };

          const onProgress = () => {
            resetProgressTimer();
          };

          const resetProgressTimer = () => {
            if (progressTimer) clearTimeout(progressTimer);
            progressTimer = setTimeout(() => {
              targetSocket.removeAllListeners('stage_ready');
              targetSocket.removeListener('node_warm_progress', onProgress);
              clearTimers();
              reject(new Error('Shard loading stalled (no progress for 90s)'));
            }, progressTimerMs);
          };

          outerTimer = setTimeout(() => {
            targetSocket.removeAllListeners('stage_ready');
            targetSocket.removeListener('node_warm_progress', onProgress);
            clearTimers();
            reject(new Error('Shard loading hit absolute maximum time limit'));
          }, outerTimeoutMs);
          
          targetSocket.on('node_warm_progress', onProgress);

          const onStageReady = (data) => {
            if (data.sessionId === sessionId) {
              targetSocket.removeListener('stage_ready', onStageReady);
              targetSocket.removeListener('node_warm_progress', onProgress);
              clearTimers();
              resolve();
            }
          };

          targetSocket.on('stage_ready', onStageReady);
          resetProgressTimer(); // start initial 90s timer
        });
      } catch (err) {
        console.error(`[pipeline] Stage ready wait failed:`, err.message);
        allReady = false;
      }

      if (!allReady) {
        abortPipelineSession(sessionId, io, 'Model loading timed out for node.');
        return;
      }

      const stage0Socket = io.sockets.sockets.get(assignedNodeId);
      if (stage0Socket) {
        resetStallTimer(sessionId, 0, io);
        stage0Socket.emit('forward_request', {
          sessionId,
          stageIndex: 0,
          prompt: prompt
        });
        io.emit('pipeline_progress', { sessionId, stageIndex: 0 });
      }
    });

    socket.on('forward_response', ({ sessionId, stageIndex, tokenId, tokenText, isComplete }) => {
      const session = activePipelines.get(sessionId);
      if (!session) return;

      if (session.stallTimer) {
        clearTimeout(session.stallTimer);
        session.stallTimer = null;
      }

      // If generation is complete (WebLLM signals end)
      if (isComplete) {
        io.emit('pipeline_end', { sessionId });
        finishPipelineSession(sessionId, io);
        return;
      }

      // Resolve token text: use tokenText directly if provided (WebLLM),
      // otherwise decode tokenId via server tokenizer (legacy)
      let resolvedText = tokenText || '';
      if (!resolvedText && tokenId !== undefined) {
        try {
          const tokenizer = getTokenizer();
          resolvedText = tokenizer.decode([tokenId]);
          // Check for EOS in legacy mode
          if (tokenId === tokenizer.eosId) {
            io.emit('pipeline_end', { sessionId });
            finishPipelineSession(sessionId, io);
            return;
          }
        } catch (err) {
          console.error('[pipeline] Tokenizer unavailable during decoding:', err);
          abortPipelineSession(sessionId, io, 'Tokenizer unavailable on server.');
          return;
        }
      }

      const clientSocket = io.sockets.sockets.get(session.clientSocketId);
      if (clientSocket) {
        clientSocket.emit('final_token', { sessionId, tokenText: resolvedText });
      }

      // Reset stall timer for the next streamed token
      resetStallTimer(sessionId, 0, io);
    });

    socket.on('pipeline_client_error', ({ sessionId, reason }) => {
      console.error(`[pipeline] Client error from ${socket.id}: ${reason}`);
      abortPipelineSession(sessionId, io, reason);
    });

    socket.on('disconnect', () => {
      // remove from pool FIRST so it can't be picked as a reassignment target
      nodes.delete(socket.id);
      nodePerformance.delete(socket.id);

      // Pipeline disconnect check
      for (const [sessionId, session] of activePipelines.entries()) {
        if (session.activeNodes.has(socket.id) || session.clientSocketId === socket.id) {
          abortPipelineSession(sessionId, io, 'a node or client dropped — restarting');
        }
      }

      // immediately reassign any in-flight batches from this node
      for (const [batchId, meta] of pendingBatches) {
        if (meta.socketId === socket.id) {
          meta.retries++;
          if (meta.retries > MAX_CHUNK_RETRIES) {
            console.error(`[FAILED] Batch ${batchId}: node ${socket.id} disconnected, exceeded retries`);
            pendingBatches.delete(batchId);
            completedBatchCount++;
            emitScreeningProgress(io);
            checkRunComplete(io);
            continue;
          }
          const replacement = getFastestIdleNode();
          if (replacement) {
            reassignBatch(batchId, replacement, io);
          } else {
            meta.deadline = Infinity;
            requeuedBatches.push({ batchId });
            console.log(`[requeue] Batch ${batchId} queued (node ${socket.id} disconnected)`);
          }
        }
      }

      console.log(`[node-] ${socket.id} disconnected (${nodes.size} total)`);
      io.emit('node_count', nodes.size);
    });
  });

  // deadline scanner — every 2 s, check for overdue batches
  setInterval(() => scanDeadlines(io), DEADLINE_SCAN_INTERVAL_MS);

  // Start the first screening run so work begins as soon as a node connects
  startScreeningRun(io);
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

/** Get the current top-100 molecule leaderboard (in-memory) */
function getMoleculeLeaderboard() {
  return topMolecules.slice(0, TOP_MOLECULES_LIMIT);
}

module.exports = { setupSocketHandler, getLeaderboard, getForgemasterLeaderboard, getMoleculeLeaderboard };
