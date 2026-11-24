import React from 'react';
import { Pause, Play } from 'lucide-react';
import type { DemoScenarioId } from '../types/cell';

interface OfflinePreviewBarProps {
  scenario: DemoScenarioId;
  paused: boolean;
  onSelectScenario: (scenario: DemoScenarioId) => void;
  onTogglePause: () => void;
}

const DEMO_SCENARIOS: Array<{ id: DemoScenarioId; label: string }> = [
  { id: 'j1-nominal', label: 'J1' },
  { id: 'j1-reconfig', label: 'J1 alt' },
  { id: 'j2-interzones', label: 'J2 TIAGo' },
  { id: 'j3-vla', label: 'J3 VLA' },
  { id: 'fault-safety', label: 'Défaut' },
];

export const OfflinePreviewBar: React.FC<OfflinePreviewBarProps> = ({
  scenario,
  paused,
  onSelectScenario,
  onTogglePause,
}) => {
  return (
    <footer className="offline-bar" aria-label="Traces de démonstration hors-ligne">
      <span>Démo hors-ligne (aucune commande envoyée)</span>

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
          aria-label={paused ? 'Reprendre' : 'Pause'}
        >
          {paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
          {paused ? 'Reprendre' : 'Pause'}
        </button>
      </div>
    </footer>
  );
};
