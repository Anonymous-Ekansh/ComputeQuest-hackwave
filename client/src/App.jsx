import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { GoogleLogin, googleLogout } from '@react-oauth/google';
import WorkerManager from './WorkerManager';
import './App.css';

const SERVER_URL = 'http://localhost:3001'; // Fallback for local, we will use the actual domain if deployed, or keep dynamic if we want

function App() {
  const [connected, setConnected] = useState(false);
  const [nodeCount, setNodeCount] = useState(0);
  const [tasksCompleted, setTasksCompleted] = useState(0);
  const [lastResult, setLastResult] = useState(null);
  const [log, setLog] = useState([]);

  // Auth states
  const [userInfo, setUserInfo] = useState({
    username: 'Anonymous Node',
    credits: 0,
    isAuthenticated: false,
  });
  
  const [authToken, setAuthToken] = useState(localStorage.getItem('cq_auth_token') || null);

  // Progress states
  const [taskProgress, setTaskProgress] = useState(null);

  const socketRef = useRef(null);

  // helper to add a log entry
  function addLog(msg) {
    setLog(prev => [...prev.slice(-19), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }

  // Handle Google Login and Signout
  const handleGoogleSuccess = (credentialResponse) => {
    const token = credentialResponse.credential;
    setAuthToken(token);
    localStorage.setItem('cq_auth_token', token);
    addLog('Google sign-in successful. Reconnecting...');
    
    // Reconnect socket with the new token
    if (socketRef.current) {
      socketRef.current.auth = { token };
      socketRef.current.disconnect().connect();
    }
  };

  const handleLogout = () => {
    googleLogout();
    setAuthToken(null);
    localStorage.removeItem('cq_auth_token');
    setUserInfo({
      username: 'Anonymous Node',
      credits: 0,
      isAuthenticated: false,
    });
    addLog('Signed out. Reconnecting anonymously...');
    
    // Reconnect socket anonymously
    if (socketRef.current) {
      socketRef.current.auth = { token: null };
      socketRef.current.disconnect().connect();
    }
  };

  useEffect(() => {
    // ── persistent worker (singleton — never terminated between chunks) ──
    const workerManager = WorkerManager.getInstance();

    let socket;

    const initSocket = () => {
      // Connect to server, passing token if we have one
      const serverUrl = import.meta.env.VITE_SERVER_URL || SERVER_URL;
      socket = io(serverUrl, {
        auth: { token: authToken },
      });
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

      // listen for user/credit updates from server
      socket.on('user_info', (info) => {
        setUserInfo(info);
      });

      // listen for task:progress events
      socket.on('task:progress', (progress) => {
        setTaskProgress(progress);
      });

      // when server sends a chunk, queue it through the WorkerManager
      socket.on('task_chunk', (chunk) => {
        addLog(`Received chunk ${chunk.chunkId} — rows ${chunk.startRow}–${chunk.startRow + chunk.rowCount - 1} of ${chunk.totalRows}`);
        workerManager.sendChunk(chunk);
      });

      // when the worker finishes a chunk, send the result back to the server
      workerManager.onResult((data) => {
        const { taskId, chunkId, resultRows, computeMs, startRow, rowCount, totalRows } = data;
        setTasksCompleted(prev => prev + 1);
        addLog(`Computed chunk ${chunkId} (${rowCount} rows) in ${computeMs}ms`);

        console.log(`%c[ComputeQuest] Chunk ${chunkId} done`, 'color: #818cf8; font-weight: bold;');
        console.log('Result rows:', resultRows);

        socket.emit('chunk_result', { taskId, chunkId, resultRows, computeMs });
      });

      // when the server has reassembled all chunks, show the full result
      socket.on('task:complete', (data) => {
        const { taskId, matrixA, matrixB, result, totalTimeMs, contributions } = data;
        setLastResult({ taskId, result, matrixA, matrixB, computeTimeMs: totalTimeMs });
        setTaskProgress(null); // clear progress
        addLog(`Task ${taskId} complete in ${totalTimeMs}ms — ${contributions.length} node(s) contributed`);

        console.log(`%c[ComputeQuest] Task ${taskId} fully assembled`, 'color: #34d399; font-weight: bold;');
        console.log('Matrix A:'); console.table(matrixA);
        console.log('Matrix B:'); console.table(matrixB);
        console.log('Result:');   console.table(result);
        console.log('Contributions:', contributions);
      });

      socket.on('task:failed', (data) => {
        addLog(`Task failed: ${data.reason}`);
        setTaskProgress(null); // clear progress
      });
    };

    initSocket();

    // cleanup: disconnect socket only — worker stays alive (managed by WorkerManager)
    return () => {
      if (socket) {
        socket.disconnect();
      }
    };
    // Note: intentionally only running on mount. authToken changes are handled by disconnect().connect() in the success/logout handlers.
  }, []);


  return (
    <div className="app">
      <h1>ComputeQuest</h1>
      <p className="tagline">Donate your browser's computing power</p>

      {/* Auth Card */}
      <div className="auth-card">
        {userInfo.isAuthenticated ? (
          <div className="auth-logged-in">
            <div>
              <span>Logged in as: </span>
              <strong className="user-meta">{userInfo.username}</strong>
              <span> · Credits: </span>
              <strong className="user-meta">{userInfo.credits}</strong>
            </div>
            <button className="auth-btn secondary" onClick={handleLogout}>Logout</button>
          </div>
        ) : (
          <div className="auth-fields">
            <h3>Persist Credits (Google Account)</h3>
            <div className="auth-row" style={{ display: 'flex', justifyContent: 'center', marginTop: '10px' }}>
              <GoogleLogin
                onSuccess={handleGoogleSuccess}
                onError={() => addLog('Google Login Failed')}
              />
            </div>
          </div>
        )}
      </div>

      <div className="status-bar">
        <div className={`status-dot ${connected ? 'online' : 'offline'}`} />
        <span>{connected ? 'Connected' : 'Disconnected'}</span>
        <span className="separator">·</span>
        <span>{nodeCount} node{nodeCount !== 1 ? 's' : ''} online</span>
      </div>

      {/* Task Progress Bar */}
      {taskProgress && (
        <div className="progress-container">
          <div className="progress-header">
            <span>Processing Task: {taskProgress.taskId.slice(-10)}</span>
            <span>{taskProgress.percentComplete}% ({taskProgress.chunksComplete}/{taskProgress.chunksTotal} chunks)</span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${taskProgress.percentComplete}%` }}
            />
          </div>
        </div>
      )}

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
