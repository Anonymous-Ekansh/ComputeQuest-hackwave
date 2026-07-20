/**
 * server/src/socketHandler.js
 *
 * WebSocket event handling for ComputeQuest:
 *   - Distributed molecular screening with k=3 consensus verification
 *   - LLM inference pipeline (Request-Parallel)
 *   - The Forge card game events
 *   - Credit system gated on consensus-verified work
 */

const {
  MOLECULE_BATCH_SIZE, TASK_TYPES, TROPHY_WIN, TROPHY_LOSS,
  DECK_SIZE, CREDITS_PER_CRYSTAL, LLM_LAYERS,
  CONSENSUS_K, SCREENING_CHUNK_SIZE, CREDIT_BASE_RATE,
} = require('../../shared/constants');
const { CARD_MAP } = require('../../shared/cards');
const { getTokenizer } = require('./tokenizer');
const { ChunkManager, planStages } = require('./taskQueue');
const { loadModelConfig, getModelInfo, getModelVersion, getReferenceAntibiotics } = require('./modelRegistry');
const { getBotTier } = require('../../shared/bots');
const { simulateBattle } = require('../../shared/battleLogic');
const fs = require('fs');
const path = require('path');


// ── constants ────────────────────────────────────────────────────────────────

const BASE_TIMEOUT_MS = 60_000;          // longer timeout for ChemBERTa inference
const MAX_CHUNK_RETRIES = 3;
const DEADLINE_SCAN_INTERVAL_MS = 5_000;

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
    return data && data.length > 0 ? data[0] : null;
  }

  // Local fallback with an in-memory lock/queue
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

// socketId -> { id, userId, username, connectedAt, tasksCompleted, credits, status }
const nodes = new Map();

// socketId -> { avgMsPerBatch, samples }
const nodePerformance = new Map();

// ── molecule screening state ─────────────────────────────────────────────────

let moleculeLibrary = [];
const chunkManager = new ChunkManager();

// Top-100 molecule leaderboard (consensus-verified only)
let topMolecules = [];
const TOP_MOLECULES_LIMIT = 100;

// Aggregate stats
let totalVerifiedComputeSeconds = 0;

// ── pipeline state ───────────────────────────────────────────────────────────
const activePipelines = new Map();

// ── helpers ──────────────────────────────────────────────────────────────────

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

function markBusy(socketId) {
  const node = nodes.get(socketId);
  if (node) node.status = 'busy';
}

function markIdle(socketId, io) {
  const node = nodes.get(socketId);
  if (!node || node.status === 'unauthenticated') return;
  node.status = 'idle';
  tryDispatchNext(io);
}

function markIdleSilent(socketId) {
  const node = nodes.get(socketId);
  if (!node || node.status === 'unauthenticated') return;
  node.status = 'idle';
}

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

// ── molecule screening lifecycle ─────────────────────────────────────────────

/**
 * Load molecule library from disk. No server-side scoring — that happens on nodes.
 */
function loadScreeningData() {
  const libPath = path.join(__dirname, '..', 'data', 'molecule_library.json');

  try {
    const libRaw = JSON.parse(fs.readFileSync(libPath, 'utf-8'));
    moleculeLibrary = libRaw.molecules || [];
    console.log(`[screening] Loaded ${moleculeLibrary.length} molecules from molecule_library.json`);
  } catch (err) {
    console.error('[screening] Failed to load molecule_library.json:', err.message);
    moleculeLibrary = [];
  }
}

/**
 * Start a screening run. Chunks the library and queues for k=3 assignment.
 */
function startScreeningRun(io) {
  if (moleculeLibrary.length === 0) {
    console.warn('[screening] No molecules loaded — cannot start run');
    return;
  }

  chunkManager.initRun(moleculeLibrary, SCREENING_CHUNK_SIZE);

  console.log(`[screening] Started run ${chunkManager.runId}`);

  io.emit('screening:status', {
    runId: chunkManager.runId,
    ...chunkManager.getProgress(),
    status: 'running',
  });
}

/**
 * Core dispatch loop — assigns chunks to idle nodes.
 * Each chunk goes to up to k=3 different nodes.
 */
function tryDispatchNext(io) {
  let dispatched = true;
  while (dispatched) {
    dispatched = false;
    const idleNode = getFastestIdleNode();
    if (!idleNode) break;

    const node = nodes.get(idleNode);
    if (!node || node.status === 'unauthenticated') break;

    const chunk = chunkManager.getNextChunkForNode(idleNode, node.userId);
    if (!chunk) break;

    dispatchChunk(io, chunk, idleNode);
    dispatched = true;
  }
}

/**
 * Dispatch a chunk to a specific node.
 */
function dispatchChunk(io, chunk, socketId) {
  const node = nodes.get(socketId);
  chunkManager.assignNode(chunk.chunkId, socketId, node?.userId);
  markBusy(socketId);

  // Send chunk with reference antibiotics so node can compute similarity
  const modelInfo = getModelInfo();

  io.to(socketId).emit('molecule_batch', {
    taskId: chunkManager.runId,
    batchId: chunk.chunkId,
    molecules: chunk.molecules,
    modelVersion: getModelVersion(),
    referenceAntibiotics: modelInfo.referenceAntibiotics,
    referenceEmbeddings: modelInfo.referenceEmbeddings,
  });

  console.log(
    `[dispatch] Chunk ${chunk.chunkId} (${chunk.molecules.length} mols) → ${socketId} ` +
    `(${node ? node.username : 'anon'})`,
  );
}

// ── progress & run completion ────────────────────────────────────────────────

function emitScreeningProgress(io) {
  const progress = chunkManager.getProgress();
  io.emit('screening:progress', {
    ...progress,
    totalVerifiedComputeSeconds: Math.round(totalVerifiedComputeSeconds),
    status: chunkManager.isRunComplete() ? 'complete' : 'running',
  });
}

function checkRunComplete(io) {
  if (chunkManager.isRunComplete()) {
    console.log(`[screening] Run ${chunkManager.runId} COMPLETE`);

    io.emit('screening:status', {
      ...chunkManager.getProgress(),
      status: 'complete',
    });

    // Loop: restart for continuous demo
    console.log('[screening] Looping — starting new screening run');
    startScreeningRun(io);
    tryDispatchNext(io);
  }
}

// ── molecule leaderboard (consensus-verified only) ───────────────────────────

async function updateMoleculeLeaderboard(chunkScores) {
  let added = 0;
  for (const mol of chunkScores) {
    if (mol == null || typeof mol.affinity !== 'number') continue;

    const existingIdx = topMolecules.findIndex(m => m.smiles === mol.smiles);
    if (existingIdx >= 0) {
      if (mol.affinity < topMolecules[existingIdx].affinity) {
        topMolecules[existingIdx] = { ...mol };
      }
    } else {
      topMolecules.push({ ...mol });
      added++;
    }
  }

  topMolecules.sort((a, b) => a.affinity - b.affinity);
  topMolecules = topMolecules.slice(0, TOP_MOLECULES_LIMIT);

  if (added > 0) {
    console.log(
      `[leaderboard] +${added} new molecules. Top: ${topMolecules[0]?.affinity?.toFixed(4) || 'N/A'} kcal/mol (${topMolecules[0]?.smiles?.slice(0, 30) || 'N/A'})`
    );
  }

  // Persist to Supabase
  if (supabase && chunkScores.length > 0) {
    try {
      const rows = chunkScores
        .filter(m => m != null && typeof m.affinity === 'number')
        .map(m => ({
          smiles: m.smiles,
          binding_affinity_kcal_mol: m.affinity,
          target_id: '1pwc',
        }));

      if (rows.length > 0) {
        const BATCH_SIZE = 50;
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          const { error } = await supabase
            .from('molecule_scores')
            .upsert(batch, { onConflict: 'smiles' });
          if (error) {
            console.error('[leaderboard] Supabase upsert error:', error.message);
          }
        }
      }
    } catch (err) {
      console.error('[leaderboard] Supabase persist error:', err.message);
    }
  }
}

// ── consensus-gated credit awarding ──────────────────────────────────────────

async function awardCredits(userId, chunkId, chunkSize, computeMs) {
  if (!userId || userId === 'anonymous') return;

  const credits = Math.max(1, Math.round(CREDIT_BASE_RATE * chunkSize));

  try {
    const updatedTotals = await incrementUserCredits(userId, credits);

    for (const [socketId, node] of nodes) {
      if (node.userId === userId) {
        node.credits = updatedTotals?.credits || (node.credits + credits);
        node.tasksCompleted++;
        break;
      }
    }

    if (supabase) {
      await supabase.from('credit_events').insert({
        user_id: userId,
        chunk_id: chunkId,
        credits_awarded: credits,
        compute_seconds: computeMs / 1000,
      }).catch(() => {});
    }

    console.log(`[credits] Awarded ${credits}cr to ${userId} for ${chunkId}`);
  } catch (err) {
    console.error(`[credits] Failed to award credits to ${userId}:`, err.message);
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
  }, 120000);
}

// ── socket setup ─────────────────────────────────────────────────────────────

function setupSocketHandler(io) {
  // ── Load screening data at startup (no server-side scoring!) ──
  loadScreeningData();
  loadModelConfig();

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
        console.log(`[register] ${socket.id} registered (inference: ${supportsInference})`);
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

    // ── Model info request — client asks what model to use ──
    socket.on('model:info', () => {
      socket.emit('model:info', getModelInfo());
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
            const userId = payload.sub;
            const googleEmail = payload.email;
            const googleName = payload.name;

            const usersList = await loadUsers();

            let dbUser = usersList.find(u => u.id === userId);

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
                console.log(`[migration] Linked existing account '${dbUser.username}' to Google ID ${userId}`);
                dbUser.id = userId;
                dbUser.username = googleName || googleEmail || dbUser.username;
                await saveUsers(usersList);
              }
            }

            if (!dbUser) {
              dbUser = {
                id: userId,
                username: googleName || googleEmail || 'Google User',
                credits: 5000
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
      if (!node) return;

      if (user) {
        node.userId = user.id;
        node.username = user.username;
        node.credits = user.credits;
        node.status = 'idle';

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

    // ── handle molecule batch results ──────────────────
    socket.on('molecule_batch_result', async (data) => {
      try {
        if (!data || typeof data.batchId !== 'string' || !Array.isArray(data.results)) {
          console.warn(`[result] Malformed molecule_batch_result from ${socket.id}`);
          markIdle(socket.id, io);
          return;
        }

        const { batchId, results, computeMs } = data;
        const node = nodes.get(socket.id);

        const elapsed = computeMs || 0;
        const prev = nodePerformance.get(socket.id);
        if (prev) {
          prev.avgMsPerBatch = prev.avgMsPerBatch * 0.7 + elapsed * 0.3;
          prev.samples++;
        } else {
          nodePerformance.set(socket.id, { avgMsPerBatch: elapsed, samples: 1 });
        }

        const recordStatus = chunkManager.recordResult(batchId, socket.id);
        markIdle(socket.id, io);

        if (recordStatus === 'ignored') return;

        console.log(`[result] ✓ ${batchId} PASSED from ${socket.id}`);

        updateMoleculeLeaderboard(results).catch(err => {
          console.error('[leaderboard] Update error:', err);
        });

        const chunkSize = results.length;
        if (node?.userId) {
          await awardCredits(node.userId, batchId, chunkSize, computeMs || 0);
          io.to(socket.id).emit('user_info', {
            username: node.username,
            credits: node.credits,
            isAuthenticated: !!node.userId,
          });
        }
        
        emitScreeningProgress(io);
        checkRunComplete(io);

      } catch (err) {
        console.error(`[result] Uncaught exception processing molecule_batch_result from ${socket.id}:`, err);
        markIdle(socket.id, io);
      }
    });

    // ── The Forge — game event handlers (unchanged) ──────────────────────

    // Shop: unlock a card
    socket.on('shop:unlock_card', async ({ cardId }) => {
      try {
        const node = nodes.get(socket.id);
        if (!node || !node.userId) {
          socket.emit('shop:unlock_result', { success: false, reason: 'not_authenticated' });
          return;
        }

        const card = CARD_MAP[cardId];
        if (!card) {
          socket.emit('shop:unlock_result', { success: false, reason: 'invalid_card' });
          return;
        }

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

        const creditCost = card.cost * CREDITS_PER_CRYSTAL;
        const usersList = await loadUsers();
        const dbUser = usersList.find(u => u.id === node.userId);
        if (!dbUser || dbUser.credits < creditCost) {
          socket.emit('shop:unlock_result', { success: false, reason: 'insufficient_crystals' });
          return;
        }

        if (supabase) {
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
          dbUser.credits = dbUser.credits - creditCost;
          const allUsers = await loadUsers();
          const localUser = allUsers.find(u => u.id === node.userId);
          if (localUser) {
            localUser.credits = dbUser.credits;
            await saveUsers(allUsers);
          }
          node.credits = dbUser.credits;
        }

        if (supabase) {
          const { error: insertError } = await supabase
            .from('user_cards')
            .insert({ user_id: node.userId, card_id: cardId });
          if (insertError) {
            await incrementUserCredits(node.userId, creditCost);
            node.credits = node.credits + creditCost;
            console.error('[shop] Failed to insert card:', insertError.message);
            socket.emit('shop:unlock_result', { success: false, reason: 'server_error' });
            return;
          }
        }

        console.log(`[shop] ${node.username} unlocked ${card.name} for ${card.cost} crystals`);

        const gameData = await loadUserGameData(node.userId);
        const trophies = await loadUserTrophies(node.userId);
        socket.emit('shop:unlock_result', { success: true, cardId, newBalance: node.credits });
        socket.emit('user_info', {
          username: node.username,
          credits: node.credits,
          isAuthenticated: true,
          isEligibleForUpgrade: dbUser.can_upgrade ?? true,
          trophies,
          ownedCards: gameData.ownedCards,
          savedDeck: gameData.savedDeck,
          upgrades: gameData.upgrades,
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

        if (!Array.isArray(cardIds) || cardIds.length !== DECK_SIZE) {
          socket.emit('deck:save_result', { success: false, reason: 'invalid_deck_size' });
          return;
        }

        for (const cid of cardIds) {
          if (!CARD_MAP[cid]) {
            socket.emit('deck:save_result', { success: false, reason: `invalid_card: ${cid}` });
            return;
          }
        }

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

    // Battle: report result
    socket.on('battle:report_result', async ({ won, trophies: clientTrophies }) => {
      try {
        const node = nodes.get(socket.id);
        if (!node || !node.userId) {
          socket.emit('battle:result_confirmed', { success: false, reason: 'not_authenticated' });
          return;
        }

        const gameData = await loadUserGameData(node.userId);
        if (!gameData.savedDeck || gameData.savedDeck.length !== DECK_SIZE) {
          socket.emit('battle:result_confirmed', { success: false, reason: 'no_valid_deck' });
          return;
        }

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

        const currentTrophies = await loadUserTrophies(node.userId);
        const botTier = getBotTier(currentTrophies);
        const botDeck = botTier.cardIds.map(id => CARD_MAP[id]);

        const result = simulateBattle(playerDeck, botDeck);
        const serverSaysWon = result.winner === 'player';

        if (won !== serverSaysWon) {
          console.warn(`[battle] MISMATCH: ${node.username} claimed ${won ? 'win' : 'loss'} but server says ${serverSaysWon ? 'win' : 'loss'}`);
        }

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
          const { data: existing } = await supabase.from('user_cards').select('card_id').eq('user_id', node.userId).eq('card_id', cardId).single();
          if (!existing) {
            socket.emit('card:upgrade_result', { success: false, reason: 'card_not_owned' });
            return;
          }

          const { data: upgData } = await supabase.from('user_card_upgrades').select('attack_upgrades, defense_upgrades').eq('user_id', node.userId).eq('card_id', cardId).single();
          const currentAttack = upgData ? (upgData.attack_upgrades || 0) : 0;
          const currentDefense = upgData ? (upgData.defense_upgrades || 0) : 0;

          if (currentAttack + currentDefense >= 10) {
            socket.emit('card:upgrade_result', { success: false, reason: 'max_upgrades_reached' });
            return;
          }

          const { data: deducted, error: deductErr } = await supabase.from('users').update({ credits: dbUser.credits - 1000 }).eq('id', node.userId).gte('credits', 1000).select('credits').single();
          if (deductErr || !deducted) {
            socket.emit('card:upgrade_result', { success: false, reason: 'insufficient_crystals' });
            return;
          }
          node.credits = deducted.credits;

          const newAttack = statType === 'attack' ? currentAttack + 1 : currentAttack;
          const newDefense = statType === 'defense' ? currentDefense + 1 : currentDefense;

          await supabase.from('user_card_upgrades').upsert({
            user_id: node.userId,
            card_id: cardId,
            attack_upgrades: newAttack,
            defense_upgrades: newDefense,
            updated_at: new Date().toISOString()
          });

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
      let idleIds = getIdleNodeIds(true);

      if (idleIds.length === 0) {
        const allInferenceNodes = [];
        for (const [id, node] of nodes) {
          if (node.supportsInference && node.status !== 'unauthenticated') {
            allInferenceNodes.push(id);
          }
        }
        if (allInferenceNodes.length > 0) {
          const candidateId = allInferenceNodes[0];
          const candidateNode = nodes.get(candidateId);
          if (candidateNode) {
            console.log(`[pipeline] Preempting screening on ${candidateId} for inference`);
            candidateNode.status = 'idle';
            idleIds = [candidateId];
          }
        }
      }

      if (idleIds.length === 0) {
        socket.emit('generation_error', { sessionId, reason: 'No idle nodes available for inference pipeline.' });
        return;
      }

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
        layerRange: [0, LLM_LAYERS - 1],
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

      let allReady = true;
      try {
        await new Promise((resolve, reject) => {
          const targetSocket = io.sockets.sockets.get(assignedNodeId);
          if (!targetSocket) return reject(new Error('Node missing'));

          const envTimeout = process.env.SHARD_LOAD_TIMEOUT_MS ? parseInt(process.env.SHARD_LOAD_TIMEOUT_MS, 10) : null;
          const outerTimeoutMs = envTimeout || 1800000;
          let progressTimerMs = 90000;
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
          resetProgressTimer();
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

      if (isComplete) {
        io.emit('pipeline_end', { sessionId });
        finishPipelineSession(sessionId, io);
        return;
      }

      let resolvedText = tokenText || '';
      if (!resolvedText && tokenId !== undefined) {
        try {
          const tokenizer = getTokenizer();
          resolvedText = tokenizer.decode([tokenId]);
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

      resetStallTimer(sessionId, 0, io);
    });

    socket.on('pipeline_client_error', ({ sessionId, reason }) => {
      console.error(`[pipeline] Client error from ${socket.id}: ${reason}`);
      abortPipelineSession(sessionId, io, reason);
    });

    socket.on('disconnect', () => {
      nodes.delete(socket.id);
      nodePerformance.delete(socket.id);

      // Pipeline disconnect check
      for (const [sessionId, session] of activePipelines.entries()) {
        if (session.activeNodes.has(socket.id) || session.clientSocketId === socket.id) {
          abortPipelineSession(sessionId, io, 'a node or client dropped — restarting');
        }
      }

      // Remove from any assigned chunks
      chunkManager.handleNodeDisconnect(socket.id);

      console.log(`[node-] ${socket.id} disconnected (${nodes.size} total)`);
      io.emit('node_count', nodes.size);
    });
  });

  // deadline scanner — every 5s check for stalled chunks
  setInterval(() => {
    // Simple check: if a chunk has been assigned for too long, requeue
    const now = Date.now();
    for (const [chunkId, chunk] of chunkManager.chunks) {
      if (chunk.status === 'assigned' && chunk.assignedNodes.size > 0) {
        // Check if any assigned node is still connected
        let hasLiveNode = false;
        for (const socketId of chunk.assignedNodes.keys()) {
          if (nodes.has(socketId)) {
            hasLiveNode = true;
            break;
          }
        }
        if (!hasLiveNode) {
          console.log(`[timeout] All nodes for ${chunkId} disconnected, requeuing`);
          chunkManager.requeueChunk(chunkId);
        }
      }
    }
    // Try to dispatch more work
    tryDispatchNext(io);
  }, DEADLINE_SCAN_INTERVAL_MS);

  // Start the first screening run
  startScreeningRun(io);
}

// ── leaderboard logic ────────────────────────────────────────────────────────
async function getLeaderboard() {
  const usersList = await loadUsers();
  const activeUsers = usersList.filter(u => (u.total_contributed || 0) > 0);

  activeUsers.sort((a, b) => (b.total_contributed || 0) - (a.total_contributed || 0));

  return activeUsers.slice(0, 10).map((u, index) => ({
    rank: index + 1,
    username: u.username,
    total_contributed: u.total_contributed || 0,
  }));
}

async function getForgemasterLeaderboard() {
  const usersList = await loadUsers();
  const activePlayers = usersList.filter(u => (u.trophies || 0) > 0);

  activePlayers.sort((a, b) => (b.trophies || 0) - (a.trophies || 0));

  return activePlayers.slice(0, 10).map((u, index) => ({
    rank: index + 1,
    username: u.username,
    trophies: u.trophies || 0,
  }));
}

/** Get the current top-100 molecule leaderboard (consensus-verified only) */
function getMoleculeLeaderboard() {
  return topMolecules.slice(0, TOP_MOLECULES_LIMIT);
}

/** Get screening progress stats */
function getScreeningProgress() {
  return {
    ...chunkManager.getProgress(),
    totalVerifiedComputeSeconds: Math.round(totalVerifiedComputeSeconds),
  };
}

module.exports = {
  setupSocketHandler,
  getLeaderboard,
  getForgemasterLeaderboard,
  getMoleculeLeaderboard,
  getScreeningProgress,
};
