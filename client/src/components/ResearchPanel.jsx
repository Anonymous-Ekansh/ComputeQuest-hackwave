import React from 'react';
import './ResearchPanel.css';

export default function ResearchPanel({ topMolecules, screeningProgress }) {
  const SERVER_URL = import.meta.env.VITE_SERVER_URL || '';

  const handleExportCSV = () => {
    window.open(`${SERVER_URL}/api/screening/export`, '_blank');
  };

  const topScore = topMolecules.length > 0 
    ? (topMolecules[0].similarity ?? topMolecules[0].composite_score)?.toFixed(4) 
    : '-';

  return (
    <div className="research-panel">
      
      {/* Big Glowing Stats Header */}
      <div className="lab-hero-stats">
        <div className="hero-stat-card">
          <div className="hero-stat-value">
            {screeningProgress?.moleculesVerified || screeningProgress?.moleculesScored || 0}
          </div>
          <div className="hero-stat-label">Molecules Verified</div>
        </div>
        <div className="hero-stat-card">
          <div className="hero-stat-value">
            {topScore}
          </div>
          <div className="hero-stat-label">Top Similarity Score</div>
        </div>
      </div>

      <div className="research-header">
        <h3>Consensus-Verified Distributed Screening</h3>
        <p className="explainer">
          The network is screening candidate molecules by structural similarity to known antibiotics using a ChemBERTa ML model. 
          Results are verified by k=3 consensus across independent nodes.
        </p>
      </div>

      {/* Screening Progress */}
      {screeningProgress && (
        <div className="screening-stats">
          <div className="stat-row">
            <span className="stat-item">
              <strong>{screeningProgress.completedChunks || 0}</strong>
              <small> / {screeningProgress.totalChunks || 0} chunks consensus-complete</small>
            </span>
            <span className="stat-item">
              <strong>{screeningProgress.inFlight || 0}</strong>
              <small> chunks in flight</small>
            </span>
            {screeningProgress.totalVerifiedComputeSeconds > 0 && (
              <span className="stat-item">
                <strong>{screeningProgress.totalVerifiedComputeSeconds.toLocaleString()}s</strong>
                <small> verified compute</small>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Top Candidates Table */}
      <div className="research-leaderboard">
        <div className="leaderboard-header">
          <h4>Top Candidates</h4>
          {topMolecules.length > 0 && (
            <button className="export-btn" onClick={handleExportCSV}>
              Export CSV
            </button>
          )}
        </div>
        <div className="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>SMILES</th>
                <th>Similarity</th>
                <th>Closest Ref</th>
                <th>Agreed</th>
              </tr>
            </thead>
            <tbody>
              {topMolecules.slice(0, 15).map((mol, idx) => (
                <tr key={mol.smiles}>
                  <td className="rank-col">#{idx + 1}</td>
                  <td>
                    <div className="mol-name" title={mol.smiles}>
                      {mol.smiles}
                    </div>
                  </td>
                  <td className="score-col">{(mol.similarity ?? mol.composite_score)?.toFixed(4) ?? '-'}</td>
                  <td>{mol.closestRef || '-'}</td>
                  <td>{mol.agreementCount || '-'} nodes</td>
                </tr>
              ))}
              {topMolecules.length === 0 && (
                <tr>
                  <td colSpan="5" className="empty-state">No consensus-verified molecules yet — waiting for nodes to agree...</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
