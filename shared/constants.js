// shared constants used by both server and client

const MATRIX_SIZE = 8; // 8x8 matrices for demo chunks
const TASK_INTERVAL = 5000; // ms between task dispatches

const TASK_TYPES = {
  MATRIX_MULTIPLY: 'MATRIX_MULTIPLY',
  // future: INFERENCE_BATCH, MONTE_CARLO
};

module.exports = { MATRIX_SIZE, TASK_INTERVAL, TASK_TYPES };
