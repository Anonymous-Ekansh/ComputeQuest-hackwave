const MOLECULE_BATCH_SIZE = 30;
const TASK_TYPES = { 
  MOLECULE_SCREEN: 'MOLECULE_SCREEN',
  INFERENCE_PIPELINE: 'INFERENCE_PIPELINE'
};

const LLM_LAYERS = 22;
const LLM_HIDDEN_SIZE = 2048;
const LLM_MAX_STAGES = 8;

const CARD_TYPES = {
  OVERCLOCK: 'OVERCLOCK',
  COOLANT:   'COOLANT',
  FIRMWARE:  'FIRMWARE',
};

const TROPHY_WIN  =  3;
const TROPHY_LOSS = -1;
const DECK_SIZE   =  4;
const CREDITS_PER_CRYSTAL = 100;

// Upgrades
const CREDITS_PER_UPGRADE = 1000; 
const MAX_UPGRADES_PER_CARD = 10; 

// ── Consensus-verified distributed screening ─────────────────────────────────
const CONSENSUS_K = 3;                     // nodes per chunk (redundancy factor)
const CONSENSUS_TOLERANCE = 0.02;          // max score delta for two nodes to "agree"
const MIN_COMPUTE_MS_PER_MOLECULE = 100;   // timing sanity floor (ms) — reject results faster than this
const SCREENING_CHUNK_SIZE = 30;           // molecules per chunk (tune after benchmarking)
const CREDIT_BASE_RATE = 1;               // base credits per molecule in a verified chunk

module.exports = {
  MOLECULE_BATCH_SIZE, TASK_TYPES, CARD_TYPES, TROPHY_WIN, TROPHY_LOSS, 
  DECK_SIZE, CREDITS_PER_CRYSTAL, CREDITS_PER_UPGRADE, MAX_UPGRADES_PER_CARD,
  LLM_LAYERS, LLM_HIDDEN_SIZE, LLM_MAX_STAGES,
  CONSENSUS_K, CONSENSUS_TOLERANCE, MIN_COMPUTE_MS_PER_MOLECULE,
  SCREENING_CHUNK_SIZE, CREDIT_BASE_RATE,
};