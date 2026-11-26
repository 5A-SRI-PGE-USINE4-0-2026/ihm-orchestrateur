import React, { useEffect, useId, useRef, useState } from 'react';
import type { CellSnapshot } from '../types/cell';

interface OrchestratorRailProps {
  snapshot: CellSnapshot;
  canCommand: boolean;
  onStartOrder: (params: {
    quantity: number;
    enable_qc: boolean;
    enable_rework: boolean;
    inject_defect_on_index: number;
    scenario?: string;
  }) => void;
  onTogglePause: () => void;
  onReset: () => void;
}

type ModalCameraId = 'poste_a' | 'poste_b';

function orchestratorBadge(
  state: CellSnapshot['orchestratorState'],
  paused: boolean
): {
  cls: string;
  label: string;
} {
  if (paused) {
    return { cls: 'warning', label: 'Pause' };
  }
  switch (state) {
    case 'RUNNING':
      return { cls: 'active', label: 'En cours' };
    case 'VALIDATING':
      return { cls: 'warning', label: 'Validation' };
    case 'FAULT_LOCKED':
      return { cls: 'fault', label: 'Défaut' };
    case 'IDLE':
    default:
      return { cls: 'standby', label: 'Prêt' };
  }
}

function stepMarker(status: CellSnapshot['steps'][number]['status'], index: number): string {
  switch (status) {
    case 'done':
      return '✓';
    case 'active':
      return '▶';
    case 'fault':
    case 'rejected':
      return '!';
    case 'pending':
    default:
      return String(index);
  }
}

/** Raccourcit tout intitulé d'étape en 2 à 4 mots clairs sans codes PDDL ni parenthèses */
function shortStepLabel(raw: string): string {
  const low = raw.toLowerCase();
  if (low.includes('précondition') || low.includes('precondition') || low.includes('vérification')) {
    return 'Vérification sécurité';
  }
  if (low.includes('deliver_poste_a') || (low.includes('stock') && low.includes('poste a'))) {
    return 'Stock → Poste A';
  }
  if (low.includes('transfer') || low.includes('transit') || (low.includes('tiago') && low.includes('bloc b'))) {
    return 'Transfert TIAGo A → B';
  }
  if (low.includes('rework') || low.includes('reprise') || low.includes('staubli') || low.includes('stäubli')) {
    return 'Reprise Stäubli';
  }
  if (low.includes('exped') || low.includes('expéd') || low.includes('ship')) {
    return 'Expédition';
  }
  if ((low.includes('inspect') || low.includes('zed') || low.includes('qc') || low.includes('contrôle')) && low.includes('b')) {
    return 'Contrôle ZED 2';
  }
  if (low.includes('inspect') || low.includes('zed') || low.includes('qc') || low.includes('contrôle')) {
    return 'Contrôle Poste A';
  }
  if (low.includes('op1') || low.includes('assemblage') || low.includes('stage_handoff') || low.includes('poste a')) {
    return 'Assemblage Poste A';
  }
  if (low.includes('op2') || low.includes('unload') || low.includes('conditionnement') || low.includes('poste b')) {
    return 'Conditionnement Poste B';
  }
  if (low.includes('bleu') && low.includes('vert')) {
    return 'Navette Bleu → Vert';
  }
  // Nettoyage générique : supprime parenthèses et codes techniques
  const stripped = raw.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const words = stripped.split(' ');
  return words.length > 4 ? words.slice(0, 4).join(' ') : stripped || raw;
}

export function parseStructuredEvent(ev: CellSnapshot['events'][number]): {
  time: string;
  detail: string;
} {
  let time = ev.timestamp || '--:--:--';
  const rawMsg = (ev.message ?? '').trim();

  const braceStart = rawMsg.indexOf('{');
  const braceEnd = rawMsg.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      const parsed = JSON.parse(rawMsg.slice(braceStart, braceEnd + 1)) as Record<string, unknown>;
      if (typeof parsed.timestamp === 'string' && parsed.timestamp.includes('T')) {
        const hhmmss = parsed.timestamp.split('T')[1]?.slice(0, 8);
        if (hhmmss) time = hhmmss;
      }
      const mainText =
        parsed.summary ??
        parsed.detail ??
        parsed.message ??
        parsed.action ??
        parsed.event_type ??
        parsed.event;
      const partTag = parsed.part_id ? `[${String(parsed.part_id)}] ` : '';
      return {
        time,
        detail: `${partTag}${String(mainText ?? 'Événement').replace(/_/g, ' ')}`,
      };
    } catch {
      // ignore
    }
  }

  return { time, detail: rawMsg };
}

export const OrchestratorRail: React.FC<OrchestratorRailProps> = ({
  snapshot,
  canCommand,
  onStartOrder,
  onTogglePause,
  onReset,
}) => {
  const [quantity, setQuantity] = useState<number>(2);
  const [defectIdx, setDefectIdx] = useState<number>(2);
  const [enableQc, setEnableQc] = useState<boolean>(true);
  const [enableRework, setEnableRework] = useState<boolean>(true);
  const [showLiveCams, setShowLiveCams] = useState<boolean>(false);
  const [modalCam, setModalCam] = useState<ModalCameraId | null>(null);

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const qtyId = useId();
  const defectId = useId();
  const qcChkId = useId();
  const reworkChkId = useId();
  const batchProgressId = useId();
  const modalTitleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || 'closedBy' in HTMLDialogElement.prototype) {
      return;
    }

    const handleBackdropClick = (event: MouseEvent) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const isInsideContent =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!isInsideContent) {
        dialog.close();
      }
    };

    dialog.addEventListener('click', handleBackdropClick);
    return () => {
      dialog.removeEventListener('click', handleBackdropClick);
    };
  }, []);

  const openCameraModal = (cam: ModalCameraId) => {
    setModalCam(cam);
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) {
      dlg.showModal();
    }
  };

  const isPaused = Boolean(snapshot.liveSim?.paused);
  const orch = orchestratorBadge(snapshot.orchestratorState, isPaused);
  const hmiBase = (snapshot.liveSim?.hmiHttpUrl || snapshot.hmiHttpUrl || 'http://localhost:8080').replace(
    /\/$/,
    ''
  );
  const qcA = snapshot.liveSim?.qcPosteA;
  const qcB = snapshot.liveSim?.qcPosteB;

  const completedCycles = Math.max(0, snapshot.kpis.completedCycles);
  const targetCycles = Math.max(1, snapshot.kpis.targetBatchCycles);
  const showBatchProgress = snapshot.orchestratorState === 'RUNNING' || completedCycles > 0;

  const activeModalQc = modalCam === 'poste_a' ? qcA : qcB;
  const activeModalLabel = modalCam === 'poste_a' ? 'Caméra ZED 2 — Poste A' : 'Caméra ZED 2 — Poste B';
  const activeModalUrl = modalCam ? `${hmiBase}/api/camera/${modalCam}.mjpg` : '';
  const activeModalFallbackUrl = modalCam ? `${hmiBase}/api/camera/${modalCam}.jpg` : '';

  return (
    <aside className="orchestrator-rail" aria-label="Commandes cellule">
      {/* Bloc 1 : Ordre */}
      <div className="rail-section">
        <div className="rail-heading-row">
          <h2 className="section-title">Ordre</h2>
          {showBatchProgress && (
            <span className="mono step-meta">
              {completedCycles} / {targetCycles}
            </span>
          )}
        </div>

        {showBatchProgress && (
          <div className="batch-progress-row">
            <label htmlFor={batchProgressId} className="visually-hidden">
              Progression lot
            </label>
            <progress
              id={batchProgressId}
              className="batch-progress"
              max={targetCycles}
              value={Math.min(completedCycles, targetCycles)}
            >
              {Math.round((Math.min(completedCycles, targetCycles) / targetCycles) * 100)} %
            </progress>
          </div>
        )}

        <div className="control-grid">
          <div className="field-group">
            <label className="field-label" htmlFor={qtyId}>
              Quantité
            </label>
            <input
              id={qtyId}
              type="number"
              data-testid="input-order-qty"
              min={1}
              max={20}
              required
              className="text-input mono"
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
            />
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor={defectId}>
              Défaut
            </label>
            <select
              id={defectId}
              data-testid="select-order-defect"
              className="text-input"
              value={defectIdx}
              onChange={(e) => setDefectIdx(Number(e.target.value))}
            >
              <option value={0}>Aucun</option>
              <option value={1}>Pièce #1</option>
              <option value={2}>Pièce #2</option>
              <option value={3}>Pièce #3</option>
            </select>
          </div>
        </div>

        <div className="chk-row">
          <label className="chk-item" htmlFor={qcChkId}>
            <input
              id={qcChkId}
              type="checkbox"
              data-testid="chk-order-qc"
              className="visually-hidden-fallback"
              checked={enableQc}
              onChange={(e) => setEnableQc(e.target.checked)}
            />
            <span>QC ZED 2</span>
          </label>
          <label className="chk-item" htmlFor={reworkChkId}>
            <input
              id={reworkChkId}
              type="checkbox"
              data-testid="chk-order-rework"
              className="visually-hidden-fallback"
              checked={enableRework}
              onChange={(e) => setEnableRework(e.target.checked)}
            />
            <span>Reprise TX2</span>
          </label>
        </div>

        <div className="ctrl-actions-row">
          <button
            type="button"
            data-testid="btn-launch-order"
            className="action-btn primary"
            disabled={!canCommand}
            onClick={() =>
              onStartOrder({
                quantity,
                enable_qc: enableQc,
                enable_rework: enableRework,
                inject_defect_on_index: defectIdx,
              })
            }
          >
            <span>Lancer</span>
          </button>
          <button
            type="button"
            data-testid="btn-pause-order"
            className="action-btn"
            disabled={!canCommand}
            onClick={onTogglePause}
          >
            <span>{isPaused ? 'Reprendre' : 'Pause'}</span>
          </button>
          <button
            type="button"
            data-testid="btn-reset-cell"
            className="action-btn"
            disabled={!canCommand}
            onClick={onReset}
          >
            <span>Reset</span>
          </button>
        </div>
      </div>

      {/* Bloc 2 : Caméras ZED 2 */}
      <div className="rail-section">
        <div className="rail-heading-row">
          <h2 className="section-title">Caméras</h2>
          <button
            type="button"
            data-testid="btn-toggle-mjpeg"
            className="scenario-chip"
            aria-pressed={showLiveCams}
            onClick={() => setShowLiveCams((v) => !v)}
          >
            <span>{showLiveCams ? 'Masquer' : 'Flux direct'}</span>
          </button>
        </div>

        <div className="qc-mini-grid">
          <div className="qc-card">
            <div className="qc-card-top">
              <span>Poste A</span>
              <span
                className={`scada-tag ${
                  qcA?.part_detected ? (qcA.conforming ? 'ok' : 'fault') : 'standby'
                }`}
              >
                <span>{qcA?.part_detected ? (qcA.conforming ? 'OK' : 'NOK') : '—'}</span>
              </span>
            </div>
            {showLiveCams && (
              <img
                className="qc-thumb"
                width={320}
                height={180}
                src={`${hmiBase}/api/camera/poste_a.mjpg`}
                onError={(e) => {
                  const img = e.currentTarget;
                  if (!img.src.endsWith('.jpg')) img.src = `${hmiBase}/api/camera/poste_a.jpg`;
                }}
                alt="Caméra Poste A"
              />
            )}
            <button
              type="button"
              data-testid="btn-zoom-cam-a"
              className="scenario-chip qc-zoom-btn"
              aria-label="Agrandir caméra Poste A"
              onClick={() => openCameraModal('poste_a')}
            >
              <span>Agrandir</span>
            </button>
          </div>

          <div className="qc-card">
            <div className="qc-card-top">
              <span>Poste B</span>
              <span
                className={`scada-tag ${
                  qcB?.part_detected ? (qcB.conforming ? 'ok' : 'fault') : 'standby'
                }`}
              >
                <span>{qcB?.part_detected ? (qcB.conforming ? 'OK' : 'NOK') : '—'}</span>
              </span>
            </div>
            {showLiveCams && (
              <img
                className="qc-thumb"
                width={320}
                height={180}
                src={`${hmiBase}/api/camera/poste_b.mjpg`}
                onError={(e) => {
                  const img = e.currentTarget;
                  if (!img.src.endsWith('.jpg')) img.src = `${hmiBase}/api/camera/poste_b.jpg`;
                }}
                alt="Caméra Poste B"
              />
            )}
            <button
              type="button"
              data-testid="btn-zoom-cam-b"
              className="scenario-chip qc-zoom-btn"
              aria-label="Agrandir caméra Poste B"
              onClick={() => openCameraModal('poste_b')}
            >
              <span>Agrandir</span>
            </button>
          </div>
        </div>
      </div>

      {/* Bloc 3 : Séquence */}
      <div className="rail-section rail-seq-block">
        <div className="rail-heading-row">
          <h2 className="section-title">Séquence</h2>
          <span className={`scada-tag ${orch.cls}`}>
            <span className="scada-led" aria-hidden="true" />
            <span>{orch.label}</span>
          </span>
        </div>

        <ol className="minimal-step-list" role="list">
          {snapshot.steps.map((step) => (
            <li key={step.index} className={`minimal-step-row ${step.status}`}>
              <span className="minimal-step-idx mono" aria-hidden="true">
                {stepMarker(step.status, step.index)}
              </span>
              <span className="minimal-step-label">{shortStepLabel(step.label)}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* Journal replié par défaut */}
      <details className="rail-details">
        <summary className="rail-details-summary">Journal ({snapshot.events.length})</summary>
        <ul className="minimal-log-list" role="list">
          {snapshot.events.slice(0, 8).map((ev) => {
            const row = parseStructuredEvent(ev);
            return (
              <li key={ev.id} className={`minimal-log-row ${ev.level}`}>
                <span className="log-time">{row.time}</span>
                <span className="log-msg">{row.detail}</span>
              </li>
            );
          })}
        </ul>
      </details>

      {/* Fenêtre modale native <dialog closedby="any"> */}
      <dialog
        ref={dialogRef}
        closedby="any"
        aria-labelledby={modalTitleId}
        className="cam-lightbox"
        data-testid="dialog-zed2-cam"
        onClose={() => {
          if (dialogRef.current) {
            dialogRef.current.returnValue = '';
          }
          setModalCam(null);
        }}
      >
        <div className="cam-lightbox-header">
          <h1 id={modalTitleId} className="cam-lightbox-title">
            {activeModalLabel}
          </h1>
          <form method="dialog">
            <button
              type="submit"
              data-testid="btn-close-cam-dialog"
              className="action-btn"
              autoFocus
            >
              <span>Fermer</span>
            </button>
          </form>
        </div>

        {modalCam && (
          <div className="cam-lightbox-body">
            <img
              className="cam-modal-feed"
              width={640}
              height={360}
              src={activeModalUrl}
              onError={(e) => {
                const img = e.currentTarget;
                if (activeModalFallbackUrl && !img.src.endsWith('.jpg')) {
                  img.src = activeModalFallbackUrl;
                }
              }}
              alt={activeModalLabel}
            />
            <div className="cam-lightbox-meta">
              <span
                className={`scada-tag ${
                  activeModalQc?.part_detected
                    ? activeModalQc.conforming
                      ? 'ok'
                      : 'fault'
                    : 'standby'
                }`}
              >
                <span className="scada-led" aria-hidden="true" />
                <span>
                  {activeModalQc?.part_detected
                    ? activeModalQc.conforming
                      ? 'Conforme'
                      : 'Défaut NOK'
                    : 'En attente'}
                </span>
              </span>
              {activeModalQc?.part_detected && (
                <span className="mono step-meta">
                  {Math.round((activeModalQc.confidence ?? 0) * 100)} % · {(activeModalQc.orientation_deg ?? 0).toFixed(1)}°
                </span>
              )}
            </div>
          </div>
        )}
      </dialog>
    </aside>
  );
};
