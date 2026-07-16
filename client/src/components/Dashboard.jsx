import React, { useEffect, useState } from 'react';
import './Dashboard.css';

export default function Dashboard({ socket }) {
  const [stages, setStages] = useState([]);
  const [activeStage, setActiveStage] = useState(null);

  useEffect(() => {
    if (!socket) return;

    const handlePlan = (data) => {
      setStages(data.stages || []);
      setActiveStage(null);
    };

    const handleProgress = (data) => {
      setActiveStage(data.stageIndex);
    };

    const handleEnd = () => {
      setActiveStage(null);
    };

    socket.on('pipeline_plan', handlePlan);
    socket.on('pipeline_progress', handleProgress);
    socket.on('pipeline_end', handleEnd);
    socket.on('pipeline_error', handleEnd);

    return () => {
      socket.off('pipeline_plan', handlePlan);
      socket.off('pipeline_progress', handleProgress);
      socket.off('pipeline_end', handleEnd);
      socket.off('pipeline_error', handleEnd);
    };
  }, [socket]);

  if (stages.length === 0) return null;

  return (
    <div className="pipeline-dashboard">
      <h3 className="pipeline-title">Global Inference Pipeline</h3>
      <div className="pipeline-row">
        {stages.map((stage, idx) => {
          const isActive = activeStage === stage.stageIndex;
          return (
            <div key={idx} className={`pipeline-stage ${isActive ? 'active' : ''}`}>
              <div className="stage-header">Stage {stage.stageIndex}</div>
              <div className="stage-role">{stage.role}</div>
              <div className="stage-layers">
                Layers {stage.layerRange[0]}–{stage.layerRange[1]}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
