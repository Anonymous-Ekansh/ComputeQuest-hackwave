// Web Worker for distributed matrix multiplication
// Receives a CHUNK of rows from matrix A and the full matrix B,
// computes only the assigned rows, and returns them with timing info.

self.onmessage = function (e) {
  const { taskId, chunkId, chunkData, startRow, rowCount, totalRows } = e.data;
  const { rowsA, matrixB } = chunkData;

  const cols = matrixB[0].length;
  const inner = matrixB.length; // shared dimension (columns of A / rows of B)

  const startTime = Date.now();

  // multiply only the rows assigned to this node
  const resultRows = [];
  for (let i = 0; i < rowsA.length; i++) {
    const row = [];
    for (let j = 0; j < cols; j++) {
      let sum = 0;
      for (let k = 0; k < inner; k++) {
        sum += rowsA[i][k] * matrixB[k][j];
      }
      row.push(sum);
    }
    resultRows.push(row);
  }

  const computeMs = Date.now() - startTime;

  self.postMessage({
    taskId,
    chunkId,
    resultRows,
    computeMs,
    startRow,
    rowCount,
    totalRows,
  });
};
