// shared constants used by both server and client

const MATRIX_SIZE = 8; // 8x8 matrices for demo chunks

const TASK_TYPES = {
  MATRIX_MULTIPLY: 'MATRIX_MULTIPLY',
  // future: INFERENCE_BATCH, MONTE_CARLO
};

// ── The Forge — game constants ───────────────────────────────────────────────

const CARD_TYPES = {
  OVERCLOCK: 'OVERCLOCK',
  COOLANT:   'COOLANT',
  FIRMWARE:  'FIRMWARE',
};

const TROPHY_WIN  =  3;   // trophies gained on win
const TROPHY_LOSS = -1;   // trophies lost on loss (floor 0)
const DECK_SIZE   =  4;   // cards per deck

module.exports = {
  MATRIX_SIZE,
  TASK_TYPES,
  CARD_TYPES,
  TROPHY_WIN,
  TROPHY_LOSS,
  DECK_SIZE,
};
