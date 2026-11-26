import React, { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ArchitectureView } from './components/ArchitectureView';
import { EquipmentInspector } from './components/EquipmentInspector';
import { OfflinePreviewBar } from './components/OfflinePreviewBar';
import { OrchestratorRail } from './components/OrchestratorRail';
import { Room315Synoptic } from './components/Room315Synoptic';
import { SafetyBanner } from './components/SafetyBanner';
import { SupervisorView } from './components/SupervisorView';
import { TopBar, type ActiveTab, type UiTheme } from './components/TopBar';
import { buildDemoSnapshot } from './services/demoTelemetry';
import { RosbridgeClient, type ServiceCallResult } from './services/rosbridgeClient';
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
  readOnly: false,
  defaultMode: 'rosbridge',
  rosbridgeUrl: 'ws://localhost:9090',
  hmiHttpUrl: 'http://localhost:8080',
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
const STORAGE_KEY_THEME = 'mfja_ihm_theme';

const TAB_TITLES: Record<ActiveTab, string> = {
  cell: 'Cellule Salle 315 | MFJA Usine 4.0',
  supervisor: 'Superviseur L1 & Lot 8 | MFJA Usine 4.0',
  ros: 'Interfaces ROS 2 | MFJA Usine 4.0',
};

function runViewTransition(mutate: () => void, after?: () => void): void {
  const prefersReduced =
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const docWithVt =
    typeof document !== 'undefined'
      ? (document as Document & {
          startViewTransition?: (cb: () => void) => { finished: Promise<void> };
        })
      : null;

  if (!docWithVt?.startViewTransition || prefersReduced) {
    mutate();
    after?.();
    return;
  }

  const transition = docWithVt.startViewTransition(() => {
    flushSync(mutate);
  });
  transition.finished.finally(() => {
    after?.();
  });
}

export const App: React.FC = () => {
  const [config, setConfig] = useState<RosConfig>(FALLBACK_CONFIG);
  const [activeTab, setActiveTab] = useState<ActiveTab>('cell');
  const [theme, setTheme] = useState<UiTheme>(() => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem(STORAGE_KEY_THEME);
      if (saved === 'light' || saved === 'dark') return saved;
    }
    return 'dark';
  });
  const [selectedEquipment, setSelectedEquipment] = useState<EquipmentId | null>(null);
  const [sourceMode, setSourceMode] = useState<TelemetrySourceMode>('rosbridge');
  const [demoScenario, setDemoScenario] = useState<DemoScenarioId>('j2-interzones');
  const [demoPaused, setDemoPaused] = useState<boolean>(false);
  const [demoPhase, setDemoPhase] = useState<number>(0.42);
  const [demoCycleCount, setDemoCycleCount] = useState<number>(0);

  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [connectionDetail, setConnectionDetail] = useState<string>('Connexion à l’orchestrateur...');
  const [liveSnapshot, setLiveSnapshot] = useState<CellSnapshot | null>(null);
  const [topicLastSeen, setTopicLastSeen] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);

  const clientRef = useRef<RosbridgeClient | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const cellHeadingRef = useRef<HTMLHeadingElement>(null);
  const supHeadingRef = useRef<HTMLHeadingElement>(null);
  const rosHeadingRef = useRef<HTMLHeadingElement>(null);

  const notify = (text: string, kind: 'ok' | 'err' | 'info' = 'info') => {
    setToast({ kind, text });
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4000);
  };

  useEffect(() => {
    document.title = TAB_TITLES[activeTab];
  }, [activeTab]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(STORAGE_KEY_THEME, theme);
  }, [theme]);

  const handleToggleTheme = () => {
    runViewTransition(() => {
      setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
    });
  };

  useEffect(() => {
    let active = true;
    fetch('/config.json')
      .then((res) => (res.ok ? res.json() : null))
      .then((loaded: RosConfig | null) => {
        if (!active || !loaded) return;
        const savedUrl = window.localStorage.getItem(STORAGE_KEY_URL);
        setConfig({
          ...loaded,
          readOnly: false,
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

    const client = new RosbridgeClient(config, {
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
      onServerNotice: (level, msg) => {
        notify(msg, level === 'error' ? 'err' : 'info');
      },
    });
    clientRef.current = client;
    client.connect();

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [sourceMode, config]);

  const handleSelectTab = (nextTab: ActiveTab, fromKeyboard = false) => {
    if (nextTab === activeTab) return;
    runViewTransition(
      () => setActiveTab(nextTab),
      () => {
        if (!fromKeyboard && document.activeElement === document.body) {
          const targetHeading =
            nextTab === 'cell'
              ? cellHeadingRef.current
              : nextTab === 'supervisor'
                ? supHeadingRef.current
                : rosHeadingRef.current;
          targetHeading?.focus({ preventScroll: true });
        }
      }
    );
  };

  const handleSelectEquipment = (nextId: EquipmentId) => {
    runViewTransition(() => {
      setSelectedEquipment((prev) => (prev === nextId ? null : nextId));
    });
  };

  const handleSaveRosbridgeUrl = (url: string) => {
    window.localStorage.setItem(STORAGE_KEY_URL, url);
    setConfig((prev) => ({ ...prev, rosbridgeUrl: url }));
  };

  const handleSelectScenario = (next: DemoScenarioId) => {
    runViewTransition(() => {
      setDemoScenario(next);
      setDemoPhase(0.08);
    });
  };

  const handleResultToast = (res: ServiceCallResult, fallbackOk: string) => {
    if (res.ok) {
      notify(res.message || fallbackOk, 'ok');
    } else {
      notify(res.message || 'Commande refusée par le superviseur.', 'err');
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
        hmiHttpUrl: liveSnapshot.hmiHttpUrl || config.hmiHttpUrl,
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
  }, [
    demoScenario,
    demoPhase,
    demoCycleCount,
    sourceMode,
    liveSnapshot,
    topicLastSeen,
    config.rosbridgeUrl,
    config.hmiHttpUrl,
  ]);

  const canCommand = sourceMode === 'rosbridge' && connectionState === 'connected';
  const estopActive = Boolean(snapshot.safety.hardwareEstopEngaged || snapshot.safety.status === 'estop_triggered');
  const humanInZone = Boolean(snapshot.liveSim?.humanInCollabZone);

  const handleStartOrder = async (params: {
    quantity: number;
    enable_qc: boolean;
    enable_rework: boolean;
    inject_defect_on_index: number;
    scenario?: string;
  }) => {
    if (!clientRef.current) return;
    const res = await clientRef.current.startOrder(params);
    handleResultToast(res, 'Ordre de production transmis.');
  };

  const handleTogglePause = async () => {
    if (!clientRef.current) return;
    const nextPaused = !Boolean(snapshot.liveSim?.paused);
    const res = await clientRef.current.setPause(nextPaused);
    handleResultToast(res, nextPaused ? 'Cycle mis en pause.' : 'Cycle repris.');
  };

  const handleReset = async () => {
    if (!clientRef.current) return;
    const res = await clientRef.current.resetCell();
    handleResultToast(res, 'Cellule réinitialisée.');
  };

  const handleToggleEstop = async () => {
    if (!clientRef.current) return;
    const res = await clientRef.current.setEstop(!estopActive);
    handleResultToast(res, !estopActive ? "Arrêt d'urgence activé." : "Arrêt d'urgence relâché.");
  };

  const handleToggleHuman = async () => {
    if (!clientRef.current) return;
    const res = await clientRef.current.setHumanPresence(!humanInZone);
    handleResultToast(res, 'Présence opérateur mise à jour.');
  };

  const handleParseNl = async (instruction: string) => {
    if (!clientRef.current) return;
    const res = await clientRef.current.parseNaturalLanguage(instruction, false);
    handleResultToast(res, 'Consigne langage naturel évaluée.');
  };

  const handleApproveNl = async (proposalId: string, approve: boolean) => {
    if (!clientRef.current) return;
    const res = await clientRef.current.approveNaturalLanguage(proposalId, approve);
    handleResultToast(res, approve ? 'Plan PDDL approuvé et lancé.' : 'Proposition rejetée.');
  };

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link visually-hidden">
        Aller au contenu principal
      </a>

      <TopBar
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        sourceMode={sourceMode}
        connectionState={connectionState}
        estopActive={estopActive}
        humanInZone={humanInZone}
        onToggleEstop={handleToggleEstop}
        onToggleHuman={handleToggleHuman}
      />

      <SafetyBanner safety={snapshot.safety} />

      <main id="main-content" className="main-workspace">
        <div
          id="panel-cell"
          role="tabpanel"
          aria-labelledby="tab-btn-cell"
          className="tab-panel"
          hidden={activeTab !== 'cell'}
        >
          <h2 ref={cellHeadingRef} tabIndex={-1} className="visually-hidden">
            Cellule Salle 315
          </h2>
          <div className="cell-grid">
            <div className="synoptic-column">
              <div className="synoptic-canvas-wrap">
                <Room315Synoptic
                  snapshot={snapshot}
                  selectedId={selectedEquipment}
                  onSelectEquipment={handleSelectEquipment}
                  theme={theme}
                />
              </div>

              <EquipmentInspector
                snapshot={snapshot}
                selectedId={selectedEquipment}
                onClose={() => setSelectedEquipment(null)}
              />
            </div>

            <OrchestratorRail
              snapshot={snapshot}
              canCommand={canCommand}
              onStartOrder={handleStartOrder}
              onTogglePause={handleTogglePause}
              onReset={handleReset}
            />
          </div>
        </div>

        <div
          id="panel-supervisor"
          role="tabpanel"
          aria-labelledby="tab-btn-supervisor"
          className="tab-panel"
          hidden={activeTab !== 'supervisor'}
        >
          <SupervisorView
            headingRef={supHeadingRef}
            snapshot={snapshot}
            canCommand={canCommand}
            onParseNl={handleParseNl}
            onApproveNl={handleApproveNl}
          />
        </div>

        <div
          id="panel-ros"
          role="tabpanel"
          aria-labelledby="tab-btn-ros"
          className="tab-panel"
          hidden={activeTab !== 'ros'}
        >
          <ArchitectureView
            headingRef={rosHeadingRef}
            snapshot={snapshot}
            config={config}
            sourceMode={sourceMode}
            connectionState={connectionState}
            connectionDetail={connectionDetail}
            onSaveRosbridgeUrl={handleSaveRosbridgeUrl}
            onChangeSourceMode={setSourceMode}
          />
        </div>
      </main>

      {toast && (
        <div className={`toast-banner ${toast.kind}`} role={toast.kind === 'err' ? 'alert' : 'status'}>
          {toast.text}
        </div>
      )}

      {sourceMode === 'demo' && (
        <OfflinePreviewBar
          scenario={demoScenario}
          paused={demoPaused}
          onSelectScenario={handleSelectScenario}
          onTogglePause={() => setDemoPaused((p) => !p)}
        />
      )}
    </div>
  );
};
