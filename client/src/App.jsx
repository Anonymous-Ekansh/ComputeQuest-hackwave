import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import './App.css';

const SERVER_URL = 'https://compute-quest-server.onrender.com';

function App() {
  const [connected, setConnected] = useState(false);
  const [nodeCount, setNodeCount] = useState(0);
  const [tasksCompleted, setTasksCompleted] = useState(0);
  const [lastResult, setLastResult] = useState(null);
  const [log, setLog] = useState([]);

  const socketRef = useRef(null);
  const workerRef = useRef(null);

  // helper to add a log entry
  function addLog(msg) {
    setLog(prev => [...prev.slice(-19), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }

  useEffect(() => {
    // connect to server
    const socket = io(SERVER_URL);
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      addLog('Connected to server');
    });

    socket.on('disconnect', () => {
      setConnected(false);
      addLog('Disconnected from server');
    });

    socket.on('node_count', (count) => {
      setNodeCount(count);
    });

    // spin up the web worker
    const worker = new Worker(
      new URL('./workers/computeWorker.js', import.meta.url),
      { type: 'module' }
    );
    workerRef.current = worker;

    // when server sends a chunk, forward it to the worker
    socket.on('task_chunk', (chunk) => {
      addLog(`Received chunk ${chunk.chunkId} — rows ${chunk.startRow}–${chunk.startRow + chunk.rowCount - 1} of ${chunk.totalRows}`);
      worker.postMessage(chunk);
    });

    // when worker finishes a chunk, send result back to server
    worker.onmessage = (e) => {
      const { taskId, chunkId, resultRows, computeMs, startRow, rowCount, totalRows } = e.data;
      setTasksCompleted(prev => prev + 1);
      addLog(`Computed chunk ${chunkId} (${rowCount} rows) in ${computeMs}ms`);

      console.log(`%c[ComputeQuest] Chunk ${chunkId} done`, 'color: #818cf8; font-weight: bold;');
      console.log('Result rows:', resultRows);

      socket.emit('chunk_result', { taskId, chunkId, resultRows, computeMs });
    };

    // when the server has reassembled all chunks, show the full result
    socket.on('task:complete', (data) => {
      const { taskId, matrixA, matrixB, result, totalTimeMs, contributions } = data;
      setLastResult({ taskId, result, matrixA, matrixB, computeTimeMs: totalTimeMs });
      addLog(`Task ${taskId} complete in ${totalTimeMs}ms — ${contributions.length} node(s) contributed`);

      console.log(`%c[ComputeQuest] Task ${taskId} fully assembled`, 'color: #34d399; font-weight: bold;');
      console.log('Matrix A:'); console.table(matrixA);
      console.log('Matrix B:'); console.table(matrixB);
      console.log('Result:');   console.table(result);
      console.log('Contributions:', contributions);
    });

    // cleanup on unmount
    return () => {
      socket.disconnect();
      worker.terminate();
    };
  }, []);

  return (
    <div className="app">
      <h1>ComputeQuest</h1>
      <p className="tagline">Donate your browser's computing power</p>

      <div className="status-bar">
        <div className={`status-dot ${connected ? 'online' : 'offline'}`} />
        <span>{connected ? 'Connected' : 'Disconnected'}</span>
        <span className="separator">·</span>
        <span>{nodeCount} node{nodeCount !== 1 ? 's' : ''} online</span>
      </div>

      <div className="stats">
        <div className="stat-card">
          <div className="stat-value">{tasksCompleted}</div>
          <div className="stat-label">Tasks Completed</div>
        </div>
        {lastResult && (
          <div className="stat-card">
            <div className="stat-value">{lastResult.computeTimeMs}ms</div>
            <div className="stat-label">Last Compute Time</div>
          </div>
        )}
      </div>

      {lastResult && (
        <div className="visualizer-container">
          <h3>Live Matrix Compute Visualizer</h3>
          <div className="matrices-wrapper">
            <div className="matrix-box">
              <span className="matrix-name">A</span>
              <div className="matrix-grid">
                {lastResult.matrixA.map((row, r) => (
                  <div key={r} className="matrix-row">
                    {row.map((val, c) => (
                      <span key={c} className="matrix-cell">{val}</span>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <div className="matrix-op">×</div>

            <div className="matrix-box">
              <span className="matrix-name">B</span>
              <div className="matrix-grid">
                {lastResult.matrixB.map((row, r) => (
                  <div key={r} className="matrix-row">
                    {row.map((val, c) => (
                      <span key={c} className="matrix-cell">{val}</span>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <div className="matrix-op">=</div>

            <div className="matrix-box result">
              <span className="matrix-name">Result</span>
              <div className="matrix-grid">
                {lastResult.result.map((row, r) => (
                  <div key={r} className="matrix-row">
                    {row.map((val, c) => (
                      <span key={c} className="matrix-cell">{val}</span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="log-container">
        <h3>Activity Log</h3>
        <div className="log">
          {log.length === 0 && <div className="log-entry dim">Waiting for connection...</div>}
          {log.map((entry, i) => (
            <div key={i} className="log-entry">{entry}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
