// Web Worker for matrix multiplication
// Runs in a separate thread so the UI stays responsive

self.onmessage = function (e) {
  const { taskId, matrixA, matrixB, size } = e.data;

  const startTime = performance.now();

  // standard matrix multiplication — O(n^3), intentionally blocking
  const result = [];
  for (let i = 0; i < size; i++) {
    result[i] = [];
    for (let j = 0; j < size; j++) {
      let sum = 0;
      for (let k = 0; k < size; k++) {
        sum += matrixA[i][k] * matrixB[k][j];
      }
      result[i][j] = sum;
    }
  }

  const elapsed = performance.now() - startTime;

  self.postMessage({
    taskId,
    matrixA,
    matrixB,
    result,
    computeTimeMs: elapsed.toFixed(2),
  });
};
