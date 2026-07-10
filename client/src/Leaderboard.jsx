import { useState, useEffect } from 'react';

const Leaderboard = () => {
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState('contributors'); // 'contributors' | 'forgemasters'

  const fetchLeaderboard = async () => {
    try {
      const SERVER_URL = import.meta.env.VITE_SERVER_URL;
      const endpoint = mode === 'contributors'
        ? `${SERVER_URL}/api/leaderboard`
        : `${SERVER_URL}/api/leaderboard/forgemasters`;
      const response = await fetch(endpoint);
      if (response.ok) {
        const data = await response.json();
        setLeaderboard(data);
      }
    } catch (err) {
      console.error('Failed to fetch leaderboard:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    fetchLeaderboard();
    // Poll every 10 seconds for a "live" feel
    const intervalId = setInterval(fetchLeaderboard, 10000);
    return () => clearInterval(intervalId);
  }, [mode]);

  return (
    <div className="leaderboard-container">
      <h3>Rankings</h3>

      {/* Toggle */}
      <div className="leaderboard-toggle">
        <button
          className={`leaderboard-toggle-btn ${mode === 'contributors' ? 'active' : ''}`}
          onClick={() => setMode('contributors')}
        >
          🖥️ Contributors
        </button>
        <button
          className={`leaderboard-toggle-btn ${mode === 'forgemasters' ? 'active' : ''}`}
          onClick={() => setMode('forgemasters')}
        >
          🏆 Forgemasters
        </button>
      </div>

      <div className="leaderboard-list">
        {loading && <div className="leaderboard-loading">Loading rankings...</div>}
        
        {!loading && leaderboard.length === 0 && (
          <div className="leaderboard-empty">
            {mode === 'contributors'
              ? 'No contributions yet. Be the first!'
              : 'No forgemasters yet. Win battles to rank up!'
            }
          </div>
        )}

        {!loading && leaderboard.length > 0 && (
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Node</th>
                <th>{mode === 'contributors' ? 'Rows' : 'Trophies'}</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((user) => (
                <tr key={user.username} className={user.rank <= 3 ? `top-${user.rank}` : ''}>
                  <td className="rank-cell">
                    {user.rank === 1 ? '🥇' : user.rank === 2 ? '🥈' : user.rank === 3 ? '🥉' : `#${user.rank}`}
                  </td>
                  <td className="name-cell">{user.username}</td>
                  <td className="score-cell">
                    {mode === 'contributors'
                      ? (user.total_contributed || 0).toLocaleString()
                      : `🏆 ${user.trophies || 0}`
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default Leaderboard;
