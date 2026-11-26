import React from 'react';
import type { DemoScenarioId } from '../types/cell';

interface OfflinePreviewBarProps {
  scenario: DemoScenarioId;
  paused: boolean;
  onSelectScenario: (scenario: DemoScenarioId) => void;
  onTogglePause: () => void;
}

const DEMO_SCENARIOS: Array<{ id: DemoScenarioId; label: string }> = [
  { id: 'j1-nominal', label: 'J1 NOMINAL' },
  { id: 'j1-reconfig', label: 'J1 RECONFIG' },
  { id: 'j2-interzones', label: 'J2 TIAGO A→B' },
  { id: 'j3-vla', label: 'J3 PDDL/L8' },
  { id: 'fault-safety', label: 'ALM SÉCURITÉ' },
];

export const OfflinePreviewBar: React.FC<OfflinePreviewBarProps> = ({
  scenario,
  paused,
  onSelectScenario,
  onTogglePause,
}) => {
  return (
    <footer className="offline-bar" aria-label="Traces de démonstration hors-ligne">
      <span>MODE RELECTURE LOCALE — AUCUNE COMMANDE MATÉRIELLE ÉMISE</span>

      <div className="offline-controls">
        {DEMO_SCENARIOS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="scenario-chip"
            aria-pressed={scenario === item.id}
            onClick={() => onSelectScenario(item.id)}
          >
            {item.label}
          </button>
        ))}

        <button
          type="button"
          className="pause-chip"
          onClick={onTogglePause}
          aria-label={paused ? 'Reprendre la trace' : 'Mettre en pause la trace'}
        >
          {paused ? '▶ REPRENDRE' : '❚❚ PAUSE'}
        </button>
      </div>
    </footer>
  );
};
