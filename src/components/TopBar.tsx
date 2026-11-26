import React, { useRef } from 'react';
import type { ConnectionState, TelemetrySourceMode } from '../types/cell';

export type ActiveTab = 'cell' | 'supervisor' | 'ros';
export type UiTheme = 'dark' | 'light';

interface TopBarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab, fromKeyboard?: boolean) => void;
  theme: UiTheme;
  onToggleTheme: () => void;
  sourceMode: TelemetrySourceMode;
  connectionState: ConnectionState;
  estopActive: boolean;
  humanInZone: boolean;
  onToggleEstop: () => void;
  onToggleHuman: () => void;
}

const TAB_ITEMS: ReadonlyArray<{
  id: ActiveTab;
  btnId: string;
  testId: string;
  label: string;
}> = [
  { id: 'cell', btnId: 'tab-btn-cell', testId: 'tab-cell', label: 'Cellule' },
  { id: 'supervisor', btnId: 'tab-btn-supervisor', testId: 'tab-supervisor', label: 'Superviseur' },
  { id: 'ros', btnId: 'tab-btn-ros', testId: 'tab-ros', label: 'ROS 2' },
];

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  theme,
  onToggleTheme,
  sourceMode,
  connectionState,
  estopActive,
  humanInZone,
  onToggleEstop,
  onToggleHuman,
}) => {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const sourceTagClass =
    sourceMode === 'demo'
      ? 'scada-tag active'
      : connectionState === 'connected'
        ? 'scada-tag ok'
        : 'scada-tag fault';

  const sourceLabel =
    sourceMode === 'demo'
      ? 'Démo'
      : connectionState === 'connected'
        ? 'En ligne'
        : connectionState === 'connecting'
          ? 'Connexion'
          : 'Hors ligne';

  const canCommand = sourceMode === 'rosbridge' && connectionState === 'connected';

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIdx = TAB_ITEMS.findIndex((t) => t.id === activeTab);
    if (currentIdx < 0) return;

    let nextIdx = -1;
    if (event.key === 'ArrowRight') {
      nextIdx = (currentIdx + 1) % TAB_ITEMS.length;
    } else if (event.key === 'ArrowLeft') {
      nextIdx = (currentIdx - 1 + TAB_ITEMS.length) % TAB_ITEMS.length;
    } else if (event.key === 'Home') {
      nextIdx = 0;
    } else if (event.key === 'End') {
      nextIdx = TAB_ITEMS.length - 1;
    }

    if (nextIdx >= 0) {
      event.preventDefault();
      const targetBtn = tabRefs.current[nextIdx];
      targetBtn?.focus();
      targetBtn?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (TAB_ITEMS[nextIdx].id !== activeTab) {
        onSelectTab(TAB_ITEMS[nextIdx].id, true);
      }
    }
  };

  return (
    <header className="top-bar">
      <div className="top-bar-start">
        <h1 className="brand-title">Salle 315</h1>

        <div
          className="top-nav"
          role="tablist"
          aria-label="Vues Salle 315"
          onKeyDown={handleTabKeyDown}
        >
          {TAB_ITEMS.map((item, idx) => {
            const isSelected = activeTab === item.id;
            return (
              <button
                key={item.id}
                ref={(el) => {
                  tabRefs.current[idx] = el;
                }}
                id={item.btnId}
                type="button"
                role="tab"
                data-testid={item.testId}
                className="nav-tab"
                aria-selected={isSelected}
                tabIndex={isSelected ? 0 : -1}
                onClick={(e) => {
                  e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                  onSelectTab(item.id, false);
                }}
              >
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="top-status-cluster">
        <span className={sourceTagClass}>
          <span className="scada-led" aria-hidden="true" />
          <span>{sourceLabel}</span>
        </span>

        <button
          type="button"
          data-testid="btn-human-toggle"
          className={`top-ctrl-btn ${humanInZone ? 'warning' : ''}`}
          disabled={!canCommand}
          aria-pressed={humanInZone}
          onClick={onToggleHuman}
        >
          <span>{humanInZone ? 'Opérateur (zone)' : 'Opérateur'}</span>
        </button>

        <button
          type="button"
          data-testid="btn-theme-toggle"
          className="top-ctrl-btn"
          aria-pressed={theme === 'light'}
          onClick={onToggleTheme}
        >
          <span>{theme === 'dark' ? 'Clair' : 'Sombre'}</span>
        </button>

        <button
          type="button"
          data-testid="btn-estop-toggle"
          className={`top-ctrl-btn estop ${estopActive ? 'latched' : ''}`}
          disabled={!canCommand}
          aria-pressed={estopActive}
          onClick={onToggleEstop}
        >
          <span>{estopActive ? 'Réarmer' : "Arrêt d'urgence"}</span>
        </button>
      </div>
    </header>
  );
};
