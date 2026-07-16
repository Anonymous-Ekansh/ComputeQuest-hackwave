import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { GoogleLogin, googleLogout } from '@react-oauth/google';
import WorkerManager from './WorkerManager';
import Leaderboard from './Leaderboard';
import TheForge from './forge/TheForge';
import Dashboard from './components/Dashboard';
import ChatPanel from './components/ChatPanel';
import { runDeviceBenchmark } from './benchmark';
import './App.css';

const SERVER_URL = import.meta.env.VITE_SERVER_URL;

function App() {
  const [connected, setConnected] = useState(false);
  const [nodeCount, setNodeCount] = useState(0);
  const [tasksCompleted, setTasksCompleted] = useState(0);
  const [lastResult, setLastResult] = useState(null);
  const [log, setLog] = useState([]);

  const [userInfo, setUserInfo] = useState({
    username: 'Anonymous Node',
    credits: 0,
    isAuthenticated: false,
    trophies: 0,
    ownedCards: [],
    savedDeck: [],
  });
  const userInfoRef = useRef(userInfo);
  
  useEffect(() => {
    userInfoRef.current = userInfo;
  }, [userInfo]);
  
  const [authToken, setAuthToken] = useState(localStorage.getItem('cq_auth_token') || null);

  // Progress states
  const [taskProgress, setTaskProgress] = useState(null);

  // Benchmark states
  const [deviceBenchmark, setDeviceBenchmark] = useState(null);
  const [isBenchmarking, setIsBenchmarking] = useState(false);

  const socketRef = useRef(null);

  useEffect(() => {
    if (userInfo.isAuthenticated && connected && !deviceBenchmark && !isBenchmarking) {
      setIsBenchmarking(true);
      runDeviceBenchmark().then(result => {
        setDeviceBenchmark(result);
        setIsBenchmarking(false);
      }).catch(err => {
        console.error('Benchmark failed:', err);
        setIsBenchmarking(false);
      });
    }
  }, [userInfo.isAuthenticated, connected, deviceBenchmark, isBenchmarking]);

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
      trophies: 0,
      ownedCards: [],
      savedDeck: [],
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
        setUserInfo(prev => ({ ...prev, ...info }));
      });

      // listen for task:progress events
      socket.on('task:progress', (progress) => {
        setTaskProgress(progress);
      });

      // when server sends a chunk, queue it through the WorkerManager
      socket.on('task_chunk', (chunk) => {
        if (!userInfoRef.current.isAuthenticated) {
          console.warn('[client] Dropping chunk: unauthenticated');
          return;
        }
        addLog(`Received chunk ${chunk.chunkId} — rows ${chunk.startRow}–${chunk.startRow + chunk.rowCount - 1} of ${chunk.totalRows}`);
        workerManager.sendChunk(chunk);
      });

      // when the worker finishes a chunk, send the result back to the server
      workerManager.onResult((data) => {
        const { taskId, chunkId, resultRows, computeMs, startRow, rowCount, totalRows } = data;
        setTasksCompleted(prev => prev + 1);
        addLog(`Computed chunk ${chunkId} (${rowCount} rows) in ${computeMs}ms`);

        console.log(`%c[ComputeQuest] Chunk ${chunkId} done in ${computeMs}ms`, 'color: #818cf8; font-weight: bold;');

        socket.emit('chunk_result', { taskId, chunkId, resultRows, computeMs });
      });

      // when the server has reassembled all chunks, show the full result
      socket.on('task:complete', (data) => {
        const { taskId, totalTimeMs, contributions } = data;
        setLastResult({ taskId, computeTimeMs: totalTimeMs });
        setTaskProgress(null); // clear progress
        addLog(`Task ${taskId} complete in ${totalTimeMs}ms — ${contributions.length} node(s) contributed`);

        console.log(`%c[ComputeQuest] Task ${taskId} fully assembled in ${totalTimeMs}ms`, 'color: #34d399; font-weight: bold;');
        console.log('Contributions:', contributions);
      });

      socket.on('task:failed', (data) => {
        addLog(`Task failed: ${data.reason}`);
        setTaskProgress(null); // clear progress
      });

      socket.on('pipeline_end', ({ sessionId }) => {
        WorkerManager.getInstance().clearSession(sessionId);
      });
      socket.on('generation_error', ({ sessionId }) => {
        WorkerManager.getInstance().clearSession(sessionId);
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
    <div className="app-shell">
      {/* ── Left Sidebar (Compute Panel) ── */}
      <aside className="sidebar">
        <div className="sidebar-inner">
          <h1 className="sidebar-title">ComputeQuest</h1>
          <p className="tagline">Donate your browser's computing power</p>

          {/* Auth Card */}
          <div className="auth-card">
            {userInfo.isAuthenticated ? (
              <div className="auth-logged-in">
                <div className="auth-user-info">
                  <strong className="user-meta">{userInfo.username}</strong>
                  <span className="credit-display" title="Credits earned from computing">
                    <span className="credit-icon"></span>
                    <span className="credit-value">{userInfo.credits} credits</span>
                  </span>
                </div>
                <button className="auth-btn secondary" onClick={handleLogout}>Logout</button>
              </div>
            ) : (
              <div className="auth-fields">
                <h3>Sign In to Compute</h3>
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

          {userInfo.isAuthenticated && (
            <>
              {/* Task Progress Bar */}
              {taskProgress && (
                <div className="progress-container">
                  <div className="progress-header">
                    <span>Task: {taskProgress.taskId.slice(-10)}</span>
                    <span>{taskProgress.percentComplete}%</span>
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
                  <div className="stat-label">Chunks Done</div>
                </div>
                {lastResult && (
                  <div className="stat-card">
                    <div className="stat-value">{lastResult.computeTimeMs}ms</div>
                    <div className="stat-label">Last Time</div>
                  </div>
                )}
              </div>

              <div className="log-container">
                <h3>Activity Log</h3>
                <div className="log">
                  {log.length === 0 && <div className="log-entry dim">Waiting for connection...</div>}
                  {log.map((entry, i) => (
                    <div key={i} className="log-entry">{entry}</div>
                  ))}
                </div>
              </div>
            </>
          )}

          {!userInfo.isAuthenticated && (
            <div className="sidebar-cta">
              <p>Sign in with Google to start contributing compute and earn credits to convert into crystals for The Forge!</p>
            </div>
          )}

          {/* Global Inference Pipeline Visualization */}
          <Dashboard socket={socketRef.current} />

          {/* Leaderboard */}
          <Leaderboard />

          {/* Device Benchmark Footer */}
          {userInfo.isAuthenticated && (isBenchmarking || deviceBenchmark) && (
            <div className="benchmark-footer">
              {isBenchmarking ? (
                <span>Benchmarking device…</span>
              ) : deviceBenchmark ? (
                <span>{deviceBenchmark.cores} cores · {deviceBenchmark.latency.toFixed(0)}ms · {(deviceBenchmark.computeScore / 1000000).toFixed(1)}M ops/s</span>
              ) : null}
            </div>
          )}
        </div>
      </aside>

      {/* ── Right Panel (Main Content) ── */}
      <main className="main-panel" style={{ display: 'flex', flexDirection: 'row', width: '100%' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <TheForge
            socket={socketRef.current}
            userInfo={userInfo}
            isAuthenticated={userInfo.isAuthenticated}
          />
        </div>
        
        {/* HackWave AI Chat Panel */}
        <div style={{ width: '450px', flexShrink: 0, height: '100%' }}>
          <ChatPanel socket={socketRef.current} />
        </div>
      </main>
    </div>
  );
}

export default App;
