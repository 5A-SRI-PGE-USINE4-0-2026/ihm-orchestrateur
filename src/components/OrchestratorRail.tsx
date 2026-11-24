import React from 'react';
import type { CellSnapshot } from '../types/cell';

interface OrchestratorRailProps {
  snapshot: CellSnapshot;
}

function orchestratorBadge(state: CellSnapshot['orchestratorState']): {
  cls: string;
  label: string;
} {
  switch (state) {
    case 'RUNNING':
      return { cls: 'active', label: 'En cours' };
    case 'VALIDATING':
      return { cls: 'warning', label: 'Validation' };
    case 'FAULT_LOCKED':
      return { cls: 'fault', label: 'Verrouillé' };
    case 'IDLE':
    default:
      return { cls: 'standby', label: 'Attente' };
  }
}

export const OrchestratorRail: React.FC<OrchestratorRailProps> = ({ snapshot }) => {
  const orch = orchestratorBadge(snapshot.orchestratorState);

  return (
    <aside className="orchestrator-rail" aria-label="Séquence orchestrée">
      <div className="rail-section">
        <div className="rail-heading-row">
          <h2 className="section-title">Séquence {snapshot.activeScenarioCode}</h2>
          <span className={`state-badge ${orch.cls}`}>
            <span className="status-dot" aria-hidden="true" />
            {orch.label}
          </span>
        </div>

        <ol className="step-list">
          {snapshot.steps.map((step) => (
            <li key={step.index} className={`step-row ${step.status}`}>
              <span className="step-index num" aria-hidden="true">
                {step.index}
              </span>
              <div className="step-title">{step.label}</div>
              <div className="step-meta">
                {typeof step.durationS === 'number' ? (
                  <span className="mono">{step.durationS.toFixed(1)} s</span>
                ) : (
                  step.owner
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="rail-section">
        <div className="rail-heading-row">
          <h2 className="section-title">Événements</h2>
          <span className="step-meta mono">Cycle #{snapshot.cycleNumber}</span>
        </div>
        <ul className="event-list">
          {snapshot.events.slice(0, 3).map((ev) => (
            <li key={ev.id} className={`event-item ${ev.level}`}>
              <span className="event-time mono">{ev.timestamp}</span>
              <span className="event-msg">{ev.message}</span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
};
