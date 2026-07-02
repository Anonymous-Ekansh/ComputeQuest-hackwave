import { useState, useEffect } from 'react';

const Leaderboard = () => {
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchLeaderboard = async () => {
    try {
      const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'https://compute-quest-server.onrender.com';
      const response = await fetch(`${SERVER_URL}/api/leaderboard`);
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
    fetchLeaderboard();
    // Poll every 10 seconds for a "live" feel
    const intervalId = setInterval(fetchLeaderboard, 10000);
    return () => clearInterval(intervalId);
  }, []);

  return (
    <div className="leaderboard-container">
      <h3>Top Contributors</h3>
      <div className="leaderboard-list">
        {loading && <div className="leaderboard-loading">Loading rankings...</div>}
        
        {!loading && leaderboard.length === 0 && (
          <div className="leaderboard-empty">No contributions yet. Be the first!</div>
        )}

        {!loading && leaderboard.length > 0 && (
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Node</th>
                <th>Rows Computed</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((user) => (
                <tr key={user.username} className={user.rank <= 3 ? `top-${user.rank}` : ''}>
                  <td className="rank-cell">
                    {user.rank === 1 ? '🥇' : user.rank === 2 ? '🥈' : user.rank === 3 ? '🥉' : `#${user.rank}`}
                  </td>
                  <td className="name-cell">{user.username}</td>
                  <td className="score-cell">{user.total_contributed.toLocaleString()}</td>
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
