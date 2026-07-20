import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { GoogleLogin, googleLogout } from '@react-oauth/google';
import WorkerManager from './WorkerManager';
import Leaderboard from './Leaderboard';
import TheForge from './forge/TheForge';
import Dashboard from './components/Dashboard';
import ChatPanel from './components/ChatPanel';
import WarmupProgress from './components/WarmupProgress';
import ResearchPanel from './components/ResearchPanel';
import { runDeviceBenchmark } from './benchmark';
import './App.css';

const SERVER_URL = import.meta.env.VITE_SERVER_URL;

function App() {
  const [connected, setConnected] = useState(false);
  const [nodeCount, setNodeCount] = useState(0);
  const [log, setLog] = useState([]);
  
  // Molecule screening states
  const [screeningProgress, setScreeningProgress] = useState(null);
  const [topMolecules, setTopMolecules] = useState([]);

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
  const [warmProgress, setWarmProgress] = useState(null);

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

  // Fetch molecule leaderboard + screening progress
  const fetchResearchData = async () => {
    try {
      const serverUrl = import.meta.env.VITE_SERVER_URL || SERVER_URL || '';
      const res = await fetch(`${serverUrl}/api/leaderboard/molecules`);
      if (res.ok) {
        const data = await res.json();
        setTopMolecules(data.topMolecules || []);
        if (data.progress) setScreeningProgress(prev => ({ ...prev, ...data.progress }));
      }
    } catch (err) {
      console.error('Failed to fetch research data:', err);
    }
  };

  useEffect(() => {
    fetchResearchData();
    // Re-fetch periodically
    const interval = setInterval(fetchResearchData, 5000);
    return () => clearInterval(interval);
  }, []);

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

      socket.on('connect', async () => {
        setConnected(true);
        addLog('Connected to server');
        let supportsInference = false;
        if (navigator.gpu) {
          try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
              const device = await adapter.requestDevice();
              if (device) supportsInference = true;
            }
          } catch (err) {
            console.warn('WebGPU validation failed:', err);
          }
        }
        socket.emit('register_worker', { supportsInference });
        if (supportsInference) {
          workerManager.postPipelineMessage({ type: 'start_background_warmup' });
        }
      });

      socket.on('disconnect', () => {
        setConnected(false);
        addLog('Disconnected from server');
      });

      // Respond to server's pre-generation health check
      socket.on('pipeline:ping', (data, callback) => {
        if (typeof callback === 'function') {
          callback({ status: 'ok' });
        }
      });

      socket.on('node_count', (count) => {
        setNodeCount(count);
      });

      // listen for user/credit updates from server
      socket.on('user_info', (info) => {
        setUserInfo(prev => ({ ...prev, ...info }));
      });

      // listen for screening events
      socket.on('screening:progress', (progress) => {
        setScreeningProgress(progress);
      });
      socket.on('screening:status', (status) => {
        setScreeningProgress(status);
        if (status.status === 'complete') {
          addLog(`Screening run ${status.runId.slice(-6)} complete! Looping...`);
        }
      });

      // when server sends a batch, queue it through the WorkerManager
      socket.on('molecule_batch', (batch) => {
        addLog(`Received batch ${batch.batchId} (${batch.molecules.length} molecules)`);
        workerManager.sendChunk({ type: 'molecule_batch', ...batch });
      });

      // when the worker finishes a batch, send the result back to the server
      workerManager.onResult((data) => {
        const { taskId, batchId, results, computeMs } = data;
        addLog(`Scored batch ${batchId} (${results.length} mols) in ${computeMs}ms`);

        console.log(`%c[ComputeQuest] Batch ${batchId} done in ${computeMs}ms`, 'color: #818cf8; font-weight: bold;');

        socket.emit('molecule_batch_result', { taskId, batchId, results, computeMs });
        // Trigger a quick fetch of research data so UI updates fast
        fetchResearchData();
      });

      socket.on('task:failed', (data) => {
        addLog(`Task failed: ${data.reason}`);
      });

      socket.on('pipeline_end', ({ sessionId }) => {
        WorkerManager.getInstance().clearSession(sessionId);
      });
      socket.on('generation_error', ({ sessionId }) => {
        WorkerManager.getInstance().clearSession(sessionId);
      });

      // ── INFERENCE PIPELINE: socket → worker bridge ──────────────────────
      socket.on('stage_assign', (data) => {
        workerManager.postPipelineMessage({ type: 'stage_assign', ...data });
      });

      socket.on('forward_request', (data) => {
        workerManager.postPipelineMessage({ type: 'forward_request', ...data });
      });

      // ── INFERENCE PIPELINE: worker → socket bridge ──────────────────────
      workerManager.onPipelineMessage((msg) => {
        if (msg.type === 'stage_progress') {
          addLog(msg.detail);
        } else if (msg.type === 'stage_ready') {
          socket.emit('stage_ready', {
            sessionId: msg.sessionId,
            stageIndex: msg.stageIndex
          });
        } else if (msg.type === 'forward_response') {
          socket.emit('forward_response', {
            sessionId: msg.sessionId,
            stageIndex: msg.stageIndex,
            tokenId: msg.tokenId,
            tokenText: msg.tokenText,
            isComplete: msg.isComplete
          });
        } else if (msg.type === 'stage_error') {
          socket.emit('pipeline_client_error', {
            sessionId: msg.sessionId,
            reason: msg.error || 'Worker stage error'
          });
        } else if (msg.type === 'node_warm_progress') {
          setWarmProgress({ percent: msg.percent, label: msg.label, loadedBytes: msg.loadedBytes, totalBytes: msg.totalBytes });
          socket.emit('node_warm_progress', { percent: msg.percent });
        } else if (msg.type === 'node_warm_ready') {
          setWarmProgress({ percent: 100, label: 'Ready' });
          socket.emit('node_warm_ready', {});
        }
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
              {screeningProgress && (
                <div className="progress-container">
                  <div className="progress-header">
                    <span>Molecules Screened</span>
                    <span>{screeningProgress.percentComplete || 0}%</span>
                  </div>
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{ width: `${screeningProgress.percentComplete || 0}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="stats">
                <div className="stat-card">
                  <div className="stat-value">{screeningProgress?.moleculesVerified || screeningProgress?.moleculesScored || 0}</div>
                  <div className="stat-label">Verified</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">
                    {topMolecules.length > 0 ? (topMolecules[0].similarity ?? topMolecules[0].composite_score)?.toFixed(3) : '-'}
                  </div>
                  <div className="stat-label">Top Score</div>
                </div>
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

          {/* Background Warmup Progress */}
          {warmProgress && warmProgress.percent < 100 && (
            <div style={{ marginTop: '20px' }}>
              <WarmupProgress warmProgress={warmProgress} />
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
      <main className="main-panel" style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'row', flex: 1, minHeight: 0 }}>
          <div style={{ flex: 1, position: 'relative', overflowY: 'auto' }}>
            <TheForge
              socket={socketRef.current}
              userInfo={userInfo}
              isAuthenticated={userInfo.isAuthenticated}
            />
          </div>
          
          {/* HackWave AI Chat Panel */}
          <div style={{ width: '300px', flexShrink: 0, height: '100%', overflowY: 'auto', borderLeft: '1px solid #27272a', background: '#09090b' }}>
            <ChatPanel socket={socketRef.current} />
          </div>
        </div>
        
        {/* Research Panel at Bottom */}
        <div style={{ flexShrink: 0 }}>
          <ResearchPanel topMolecules={topMolecules} screeningProgress={screeningProgress} />
        </div>
      </main>
    </div>
  );
}

export default App;
