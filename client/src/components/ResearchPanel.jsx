import React from 'react';
import './ResearchPanel.css';

export default function ResearchPanel({ topMolecules, targetConfig }) {
  if (!topMolecules || !targetConfig) return null;

  return (
    <div className="research-panel">
      <div className="research-header">
        <h3>Research Panel: Virtual Drug Screening</h3>
        <p className="explainer">
          Your browser is helping screen candidate molecules against {targetConfig.target_name || 'the target'}'s binding pocket — a real early step in drug discovery.
        </p>
      </div>
      <div className="research-leaderboard">
        <h4>Top Candidates</h4>
        <div className="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Name / SMILES</th>
                <th>MW</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {topMolecules.slice(0, 10).map((mol, idx) => (
                <tr key={mol.smiles} className={mol.is_known_reference ? 'reference-row' : ''}>
                  <td>#{idx + 1}</td>
                  <td>
                    <div className="mol-name" title={mol.smiles}>
                      {mol.name || mol.smiles.slice(0, 30) + '...'}
                    </div>
                    {mol.is_known_reference && (
                      <span className="reference-badge">known reference — validates scorer</span>
                    )}
                  </td>
                  <td>{mol.mw}</td>
                  <td>{mol.composite_score.toFixed(4)}</td>
                </tr>
              ))}
              {topMolecules.length === 0 && (
                <tr>
                  <td colSpan="4">No molecules scored yet...</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
