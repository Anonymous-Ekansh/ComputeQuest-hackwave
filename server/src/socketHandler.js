const { MATRIX_SIZE, TASK_INTERVAL, TASK_TYPES } = require('../../shared/constants');

// track all connected nodes: socketId -> { id, connectedAt, tasksCompleted }
const nodes = new Map();

// generate a random matrix of given size
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

// dispatch a matrix multiplication task to all connected nodes
function dispatchTask(io) {
  if (nodes.size === 0) return;

  const taskId = `task_${Date.now()}`;
  const matrixA = randomMatrix(MATRIX_SIZE);
  const matrixB = randomMatrix(MATRIX_SIZE);

  const chunk = {
    taskId,
    type: TASK_TYPES.MATRIX_MULTIPLY,
    matrixA,
    matrixB,
    size: MATRIX_SIZE,
  };

  console.log(`[dispatch] Sending task ${taskId} to ${nodes.size} node(s)`);
  io.emit('task_chunk', chunk);
}

function setupSocketHandler(io) {
  io.on('connection', (socket) => {
    // register this node
    nodes.set(socket.id, {
      id: socket.id,
      connectedAt: new Date(),
      tasksCompleted: 0,
    });

    console.log(`[node+] ${socket.id} connected (${nodes.size} total)`);

    // tell everyone the updated count
    io.emit('node_count', nodes.size);

    // handle compute results coming back from a browser
    socket.on('chunk_result', (data) => {
      const node = nodes.get(socket.id);
      if (node) {
        node.tasksCompleted++;
      }
      console.log(`[result] ${socket.id} finished ${data.taskId} (${node?.tasksCompleted} total)`);
    });

    socket.on('disconnect', () => {
      nodes.delete(socket.id);
      console.log(`[node-] ${socket.id} disconnected (${nodes.size} total)`);
      io.emit('node_count', nodes.size);
    });
  });

  // dispatch tasks on an interval
  setInterval(() => dispatchTask(io), TASK_INTERVAL);
}

module.exports = setupSocketHandler;
