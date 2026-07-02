import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import WorkerManager from './WorkerManager';
import './App.css';

const SERVER_URL = 'https://compute-quest-server.onrender.com';

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
  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [authError, setAuthError] = useState('');

  // Progress states
  const [taskProgress, setTaskProgress] = useState(null);

  const socketRef = useRef(null);

  // helper to add a log entry
  function addLog(msg) {
    setLog(prev => [...prev.slice(-19), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }

  // Handle Login and Register
  const handleAuth = async (action) => {
    setAuthError('');
    if (!usernameInput || !passwordInput) {
      setAuthError('Username and password are required');
      return;
    }
    try {
      const response = await fetch(`${SERVER_URL}/api/auth/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: usernameInput, password: passwordInput }),
      });
      const data = await response.json();
      if (!response.ok) {
        setAuthError(data.error || 'Authentication failed');
        return;
      }

      localStorage.setItem('token', data.token);
      addLog(`Authenticated as ${data.username}`);

      // Clear input fields
      setUsernameInput('');
      setPasswordInput('');

      // Reconnect socket with new token
      if (socketRef.current) {
        socketRef.current.auth = { token: data.token };
        socketRef.current.disconnect().connect();
      }
    } catch (err) {
      setAuthError('Authentication server unreachable');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setUserInfo({
      username: 'Anonymous Node',
      credits: 0,
      isAuthenticated: false,
    });
    addLog('Logged out — back to anonymous contribution');
    if (socketRef.current) {
      socketRef.current.auth = { token: null };
      socketRef.current.disconnect().connect();
    }
  };

  useEffect(() => {
    // ── persistent worker (singleton — never terminated between chunks) ──
    const workerManager = WorkerManager.getInstance();

    // connect to server with JWT auth if present
    const token = localStorage.getItem('token');
    const socket = io(SERVER_URL, {
      auth: { token },
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

    // cleanup: disconnect socket only — worker stays alive (managed by WorkerManager)
    return () => {
      socket.disconnect();
    };
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
            <h3>Persist Credits (Login / Register)</h3>
            <div className="auth-row">
              <input
                type="text"
                placeholder="Username"
                className="auth-input"
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
              />
              <input
                type="password"
                placeholder="Password"
                className="auth-input"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
              />
              <button className="auth-btn" onClick={() => handleAuth('login')}>Login</button>
              <button className="auth-btn secondary" onClick={() => handleAuth('register')}>Register</button>
            </div>
            {authError && <div className="auth-error">{authError}</div>}
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
