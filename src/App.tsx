import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArchitectureView } from './components/ArchitectureView';
import { EquipmentInspector } from './components/EquipmentInspector';
import { OfflinePreviewBar } from './components/OfflinePreviewBar';
import { OrchestratorRail } from './components/OrchestratorRail';
import { Room315Synoptic } from './components/Room315Synoptic';
import { SafetyBanner } from './components/SafetyBanner';
import { SupervisorView } from './components/SupervisorView';
import { TopBar, type ActiveTab } from './components/TopBar';
import { buildDemoSnapshot } from './services/demoTelemetry';
import { ReadOnlyRosbridgeClient } from './services/rosbridgeClient';
import type {
  CellSnapshot,
  ConnectionState,
  DemoScenarioId,
  EquipmentId,
  RosConfig,
  TelemetrySourceMode,
} from './types/cell';

const FALLBACK_CONFIG: RosConfig = {
  cellName: 'Cellule Usine 4.0 — Salle 315',
  facility: 'Maison de la Formation Jacqueline Auriol (UPSSITECH SRI)',
  readOnly: true,
  defaultMode: 'rosbridge',
  rosbridgeUrl: 'ws://localhost:9090',
  reconnectIntervalMs: 2500,
  topics: {
    cellState: '/mfja/supervisor/cell_state',
    cycleStatus: '/mfja/supervisor/cycle_status',
    supervisorEvents: '/mfja/supervisor/events',
    safetyStatus: '/mfja/safety/status',
    yaskawaAState: '/zone_a/yaskawa_hc10dt/joint_states',
    yaskawaBState: '/zone_b/yaskawa_hc10/joint_states',
    montracAState: '/zone_a/montrac/shuttle_state',
    montracBState: '/zone_b/montrac/shuttle_state',
    tiagoPose: '/tiago/amcl_pose',
    vlaPlan: '/mfja/vla/candidate_plan',
    cameraAInfo: '/zone_a/camera/scene_summary',
    cameraBInfo: '/zone_b/camera/scene_summary',
  },
};

const STORAGE_KEY_URL = 'mfja_ihm_rosbridge_url';

export const App: React.FC = () => {
  const [config, setConfig] = useState<RosConfig>(FALLBACK_CONFIG);
  const [activeTab, setActiveTab] = useState<ActiveTab>('cell');
  const [selectedEquipment, setSelectedEquipment] = useState<EquipmentId>('yaskawa_a');
  const [sourceMode, setSourceMode] = useState<TelemetrySourceMode>('rosbridge');
  const [demoScenario, setDemoScenario] = useState<DemoScenarioId>('j1-nominal');
  const [demoPaused, setDemoPaused] = useState<boolean>(false);
  const [demoPhase, setDemoPhase] = useState<number>(0.18);
  const [demoCycleCount, setDemoCycleCount] = useState<number>(0);

  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [connectionDetail, setConnectionDetail] = useState<string>('Connexion à l’orchestrateur...');
  const [liveSnapshot, setLiveSnapshot] = useState<CellSnapshot | null>(null);
  const [topicLastSeen, setTopicLastSeen] = useState<Record<string, number>>({});

  const clientRef = useRef<ReadOnlyRosbridgeClient | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/config.json')
      .then((res) => (res.ok ? res.json() : null))
      .then((loaded: RosConfig | null) => {
        if (!active || !loaded) return;
        const savedUrl = window.localStorage.getItem(STORAGE_KEY_URL);
        setConfig({
          ...loaded,
          readOnly: true,
          rosbridgeUrl: savedUrl || loaded.rosbridgeUrl,
        });
        setSourceMode(loaded.defaultMode);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (sourceMode !== 'demo' || demoPaused) return;
    const tickMs = 120;
    const stepPerTick = tickMs / 22000;
    const timer = window.setInterval(() => {
      setDemoPhase((prev) => {
        const next = prev + stepPerTick;
        if (next >= 1) {
          setDemoCycleCount((c) => c + 1);
          return next - 1;
        }
        return next;
      });
    }, tickMs);
    return () => window.clearInterval(timer);
  }, [sourceMode, demoPaused]);

  useEffect(() => {
    if (sourceMode !== 'rosbridge') {
      if (clientRef.current) {
        clientRef.current.disconnect();
        clientRef.current = null;
      }
      setLiveSnapshot(null);
      return;
    }

    const client = new ReadOnlyRosbridgeClient(config, {
      onStatusChange: (state, detail) => {
        setConnectionState(state);
        setConnectionDetail(detail);
      },
      onCellSnapshot: (fullSnap) => {
        setLiveSnapshot(fullSnap);
      },
      onTelemetryPatch: (patch) => {
        setLiveSnapshot((prev) => (prev ? { ...prev, ...patch } : prev));
      },
      onTopicActivity: (topic, ts) => {
        setTopicLastSeen((prev) => ({ ...prev, [topic]: ts }));
      },
    });
    clientRef.current = client;
    client.connect();

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [sourceMode, config]);

  const handleSaveRosbridgeUrl = (url: string) => {
    window.localStorage.setItem(STORAGE_KEY_URL, url);
    setConfig((prev) => ({ ...prev, rosbridgeUrl: url }));
  };

  const handleSelectScenario = (next: DemoScenarioId) => {
    setDemoScenario(next);
    setDemoPhase(0.08);
    if (next === 'fault-safety') {
      setSelectedEquipment('montrac_a');
    } else if (next === 'j2-interzones') {
      setSelectedEquipment('tiago');
    } else {
      setSelectedEquipment('yaskawa_a');
    }
  };

  const snapshot: CellSnapshot = useMemo(() => {
    if (sourceMode === 'rosbridge' && liveSnapshot) {
      const nowMs = Date.now();
      const mergedTopics = liveSnapshot.rosTopics.map((t) => {
        const seen = topicLastSeen[t.topic];
        if (seen !== undefined) {
          const fresh = nowMs - seen < 3000;
          return { ...t, active: fresh || t.active };
        }
        return t;
      });
      return {
        ...liveSnapshot,
        rosTopics: mergedTopics,
      };
    }

    const base = buildDemoSnapshot(demoScenario, demoPhase, demoCycleCount);
    if (sourceMode === 'rosbridge') {
      return {
        ...base,
        orchestratorState: 'IDLE',
        steps: base.steps.map((s) => ({ ...s, status: 'pending', durationS: undefined })),
        events: [
          {
            id: 'ev-wait',
            timestamp: base.timestamp,
            level: 'info',
            source: 'IHM',
            message: `En attente de l'orchestrateur sur ${config.rosbridgeUrl}`,
          },
        ],
      };
    }
    return base;
  }, [demoScenario, demoPhase, demoCycleCount, sourceMode, liveSnapshot, topicLastSeen, config.rosbridgeUrl]);

  const envLabel = snapshot.gzSimFlag ? 'Gazebo Harmonic' : 'Plateau réel';

  return (
    <div className="app-shell">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        sourceMode={sourceMode}
        connectionState={connectionState}
        timestamp={snapshot.timestamp}
      />

      <SafetyBanner safety={snapshot.safety} />

      <main className="main-workspace">
        {activeTab === 'cell' && (
          <div className="cell-grid">
            <div className="synoptic-column">
              <div className="synoptic-header">
                <h2 className="section-title">Synoptique temps réel</h2>
                <div className="env-strip">
                  <span className={`state-badge ${snapshot.gzSimFlag ? 'active' : 'ready'}`}>
                    {envLabel}
                  </span>
                  <span className="state-badge standby mono">
                    {snapshot.activeScenarioCode}
                  </span>
                </div>
              </div>

              <div className="synoptic-canvas-wrap">
                <Room315Synoptic
                  snapshot={snapshot}
                  selectedId={selectedEquipment}
                  onSelectEquipment={setSelectedEquipment}
                />
              </div>

              <EquipmentInspector snapshot={snapshot} selectedId={selectedEquipment} />
            </div>

            <OrchestratorRail snapshot={snapshot} />
          </div>
        )}

        {activeTab === 'supervisor' && <SupervisorView snapshot={snapshot} />}

        {activeTab === 'ros' && (
          <ArchitectureView
            snapshot={snapshot}
            config={config}
            sourceMode={sourceMode}
            connectionState={connectionState}
            connectionDetail={connectionDetail}
            onSaveRosbridgeUrl={handleSaveRosbridgeUrl}
            onChangeSourceMode={setSourceMode}
          />
        )}
      </main>

      {sourceMode === 'demo' ? (
        <OfflinePreviewBar
          scenario={demoScenario}
          paused={demoPaused}
          onSelectScenario={handleSelectScenario}
          onTogglePause={() => setDemoPaused((p) => !p)}
        />
      ) : (
        connectionState !== 'connected' && (
          <footer className="offline-bar">
            <span>
              Orchestrateur hors ligne ({config.rosbridgeUrl}) — lancer{' '}
              <code className="mono">npm run orchestrator</code>
            </span>
            <button
              type="button"
              className="scenario-chip"
              onClick={() => setSourceMode('demo')}
            >
              Passer en démo locale
            </button>
          </footer>
        )
      )}
    </div>
  );
};
