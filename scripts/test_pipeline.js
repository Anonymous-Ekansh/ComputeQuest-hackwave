const { io } = require('socket.io-client');

const SERVER_URL = 'http://localhost:3001';
const numNodes = 4;
const nodes = [];

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runTest() {
  console.log(`[Test] Connecting ${numNodes} mock nodes...`);

  for (let i = 0; i < numNodes; i++) {
    const socket = io(SERVER_URL);
    nodes.push(socket);

    socket.on('connect', () => {
      console.log(`[Node ${i}] Connected: ${socket.id}`);
      // Authenticate as a normal worker
      socket.emit('dev_auth', { username: `mock_node_${i}` });
    });

    socket.on('pipeline:ping', (_, cb) => {
      console.log(`[Node ${i}] Received ping, acknowledging...`);
      cb();
    });

    socket.on('stage_assign', (data) => {
      console.log(`[Node ${i}] Assigned stage:`, data);
    });

    socket.on('forward_request', (data) => {
      console.log(`[Node ${i}] Received forward_request for posOff ${data.positionId}, stage ${data.stageIndex}`);
      
      // Simulate compute delay
      setTimeout(() => {
        if (data.stageIndex === numNodes - 1) {
          // Last stage sends sampled token (fake EOS to end it)
          socket.emit('forward_response', {
            sessionId: data.sessionId,
            stageIndex: data.stageIndex,
            hiddenStates: null,
            tokenId: 2, // EOS
            tokenText: '<fake_eos>'
          });
        } else {
          // Forward fake hidden states
          socket.emit('forward_response', {
            sessionId: data.sessionId,
            stageIndex: data.stageIndex,
            hiddenStates: new Float32Array(2048), // fake
          });
        }
      }, 100);
    });
  }

  await delay(1000); // Wait for nodes to connect and auth

  // Act as a UI client to start generation
  const uiClient = io(SERVER_URL);
  
  uiClient.on('connect', () => {
    console.log(`[UI] Connected: ${uiClient.id}`);
    
    uiClient.on('final_token', (data) => {
      console.log(`[UI] Received final_token:`, data);
      
      // End test
      console.log(`[Test] Success! Disconnecting all.`);
      nodes.forEach(n => n.disconnect());
      uiClient.disconnect();
      process.exit(0);
    });

    uiClient.on('generation_error', (data) => {
      console.error(`[UI] Generation error:`, data);
      process.exit(1);
    });

    console.log(`[UI] Starting generation...`);
    uiClient.emit('start_generation', {
      sessionId: 'test_session_1',
      prompt: 'Hello world'
    });
  });
}

runTest();
