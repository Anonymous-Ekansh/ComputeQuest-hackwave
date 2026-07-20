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
          Your browser is running a real physics-based molecular docking simulation (Webina/AutoDock Vina) to estimate binding affinity against a Penicillin-Binding Protein (1PWC).
        </p>
      </div>

      {/* Screening Progress */}
      {screeningProgress && (
        <div className="screening-stats">
          <div className="stat-row">
            <span className="stat-item">
              <strong>{screeningProgress.moleculesVerified || 0}</strong>
              <small> / {screeningProgress.totalMolecules || 0} molecules docked</small>
            </span>
            <span className="stat-item">
              <strong>{screeningProgress.completedChunks || 0}</strong>
              <small> / {screeningProgress.totalChunks || 0} chunks complete</small>
            </span>
            <span className="stat-item">
              <strong>{screeningProgress.inFlight || 0}</strong>
              <small> chunks in flight</small>
            </span>
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
          <h4>Top Candidates (Best Binding Affinity)</h4>
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
                <th>Binding Affinity</th>
                <th>Target</th>
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
                  <td>{(mol.affinity ?? mol.binding_affinity_kcal_mol)?.toFixed(2) ?? '-'} kcal/mol</td>
                  <td>1PWC</td>
                </tr>
              ))}
              {topMolecules.length === 0 && (
                <tr>
                  <td colSpan="4">No molecules docked yet — waiting for nodes to submit results...</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
