import React from 'react';

export default function WarmupProgress({ warmProgress }) {
  if (!warmProgress || warmProgress.percent === 100) return null;

  return (
    <div className="warmup-progress-container">
      <div className="warmup-progress-header" style={{ marginBottom: '8px', fontSize: '13px', color: '#cbd5e1' }}>
        <span>Setting up this device (one-time, ~15-20 min on slower connections) — you can keep using the app while this finishes.</span>
      </div>
      <div className="progress-track" style={{ height: '8px', background: '#334155', borderRadius: '4px', overflow: 'hidden' }}>
        <div 
          className="progress-fill" 
          style={{ width: `${warmProgress.percent || 0}%`, background: '#3b82f6', height: '100%', transition: 'width 0.3s' }}
        />
      </div>
      <div className="warmup-progress-footer" style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', fontSize: '12px', color: '#94a3b8' }}>
        <span>{warmProgress.label}</span>
        <span>{warmProgress.percent}%</span>
      </div>
    </div>
  );
}
