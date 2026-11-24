import React from 'react';
import { Activity, Cpu, Eye, ShieldCheck } from 'lucide-react';
import type { ConnectionState, TelemetrySourceMode } from '../types/cell';

export type ActiveTab = 'cell' | 'supervisor' | 'ros';

interface TopBarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  sourceMode: TelemetrySourceMode;
  connectionState: ConnectionState;
  timestamp: string;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  sourceMode,
  connectionState,
  timestamp,
}) => {
  const sourcePillClass =
    sourceMode === 'demo'
      ? 'source-pill demo'
      : connectionState === 'connected'
        ? 'source-pill live'
        : 'source-pill error';

  const sourceLabel =
    sourceMode === 'demo'
      ? 'Démo locale'
      : connectionState === 'connected'
        ? 'ROS 2 connecté'
        : connectionState === 'connecting'
          ? 'Connexion...'
          : 'ROS 2 hors ligne';

  return (
    <header className="top-bar">
      <div className="brand-block">
        <h1 className="brand-title">Salle 315 MFJA</h1>
      </div>

      <nav className="top-nav" aria-label="Navigation">
        <button
          type="button"
          className="nav-tab"
          aria-current={activeTab === 'cell' ? 'page' : undefined}
          onClick={() => onSelectTab('cell')}
        >
          <Activity size={15} aria-hidden="true" />
          Cellule
        </button>
        <button
          type="button"
          className="nav-tab"
          aria-current={activeTab === 'supervisor' ? 'page' : undefined}
          onClick={() => onSelectTab('supervisor')}
        >
          <ShieldCheck size={15} aria-hidden="true" />
          Superviseur
        </button>
        <button
          type="button"
          className="nav-tab"
          aria-current={activeTab === 'ros' ? 'page' : undefined}
          onClick={() => onSelectTab('ros')}
        >
          <Cpu size={15} aria-hidden="true" />
          ROS 2
        </button>
      </nav>

      <div className="top-status-cluster">
        <span className="readonly-tag" title="Pilotage exclusif par l’orchestrateur L1">
          <Eye size={13} aria-hidden="true" />
          Lecture seule
        </span>
        <span className={sourcePillClass}>
          <span className="status-dot" aria-hidden="true" />
          {sourceLabel}
        </span>
        <span className="clock-readout mono">{timestamp}</span>
      </div>
    </header>
  );
};
