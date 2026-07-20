import React from 'react';
import './ResearchPanel.css';

export default function ResearchPanel({ topMolecules, screeningProgress }) {
  const SERVER_URL = import.meta.env.VITE_SERVER_URL || '';

  const handleExportCSV = () => {
    window.open(`${SERVER_URL}/api/screening/export`, '_blank');
  };

  return (
    <div className="research-panel">
      <div className="research-header">
        <h3>Research Panel: Distributed Drug Screening</h3>
        <p className="explainer">
          Your browser is running a ChemBERTa ML model to screen candidate molecules by structural similarity to known antibiotics.
        </p>
      </div>

      {/* Screening Progress */}
      {screeningProgress && (
        <div className="screening-stats">
          <div className="stat-row">
            <span className="stat-item">
              <strong>{screeningProgress.moleculesVerified || 0}</strong>
              <small> / {screeningProgress.totalMolecules || 0} molecules verified</small>
            </span>
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
          <div className="progress-track" style={{ marginTop: '8px' }}>
            <div
              className="progress-fill"
              style={{ width: `${screeningProgress.percentComplete || 0}%` }}
            />
          </div>
        </div>
      )}

      {/* Top Candidates */}
      <div className="research-leaderboard">
        <div className="leaderboard-header">
          <h4>Top Candidates (Consensus-Verified)</h4>
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
              {topMolecules.slice(0, 10).map((mol, idx) => (
                <tr key={mol.smiles}>
                  <td>#{idx + 1}</td>
                  <td>
                    <div className="mol-name" title={mol.smiles}>
                      {mol.smiles.length > 35 ? mol.smiles.slice(0, 35) + '…' : mol.smiles}
                    </div>
                  </td>
                  <td>{(mol.similarity ?? mol.composite_score)?.toFixed(4) ?? '-'}</td>
                  <td>{mol.closestRef || '-'}</td>
                  <td>{mol.agreementCount || '-'} nodes</td>
                </tr>
              ))}
              {topMolecules.length === 0 && (
                <tr>
                  <td colSpan="5">No consensus-verified molecules yet — waiting for nodes to agree...</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
