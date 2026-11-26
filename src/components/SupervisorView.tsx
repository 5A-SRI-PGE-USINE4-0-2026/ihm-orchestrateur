import React, { useId, useState } from 'react';
import type { CellSnapshot } from '../types/cell';

interface SupervisorViewProps {
  headingRef?: React.RefObject<HTMLHeadingElement>;
  snapshot: CellSnapshot;
  canCommand: boolean;
  onParseNl: (instruction: string) => void;
  onApproveNl: (proposalId: string, approve: boolean) => void;
}

const NL_PRESETS = [
  'Assemble 2 pièces et transfère du Bloc A au Bloc B avec TIAGo, contrôle qualité ZED 2 et reprise Stäubli',
  'Produce 2 parts with TIAGo transfer, visual quality control and Staubli rework',
  'Envoie la pièce du Bloc A au Bloc B par le convoyeur Montrac sans TIAGo',
];

export const SupervisorView: React.FC<SupervisorViewProps> = ({
  headingRef,
  snapshot,
  canCommand,
  onParseNl,
  onApproveNl,
}) => {
  const { preconditions, vlaCandidate, kpis } = snapshot;
  const [nlDraft, setNlDraft] = useState<string>(NL_PRESETS[0]);
  const nlInputId = useId();
  const kpiProgId = useId();

  const handleSubmitNl = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = nlDraft.trim();
    if (!cleaned) return;
    onParseNl(cleaned);
  };

  const targetBatch = Math.max(1, kpis.targetBatchCycles);
  const completedBatch = Math.max(0, Math.min(targetBatch, kpis.completedCycles));

  return (
    <div className="page-container">
      <section className="kpi-strip" aria-label="Indicateurs">
        <div className="kpi-cell">
          <label htmlFor={kpiProgId} className="kpi-name">
            Pièces
          </label>
          <span className="kpi-number num">
            {kpis.completedCycles} / {kpis.targetBatchCycles}
          </span>
          <progress id={kpiProgId} className="batch-progress" max={targetBatch} value={completedBatch}>
            {Math.round((completedBatch / targetBatch) * 100)} %
          </progress>
        </div>
        <div className="kpi-cell">
          <span className="kpi-name">Conformité</span>
          <span className="kpi-number num">{(kpis.conformityRatePct ?? 0).toFixed(0)} %</span>
        </div>
        <div className="kpi-cell">
          <span className="kpi-name">Reprises</span>
          <span className="kpi-number num">{kpis.partsReworked ?? 0}</span>
        </div>
      </section>

      <section className="panel-block">
        <div className="panel-header">
          <h2 ref={headingRef} tabIndex={-1} className="section-title">
            Consigne langage naturel
          </h2>
          <span className={`scada-tag ${vlaCandidate.verdict === 'validated' ? 'ok' : 'fault'}`}>
            <span className="scada-led" aria-hidden="true" />
            <span>{vlaCandidate.verdict === 'validated' ? 'Autorisé' : 'Rejeté'}</span>
          </span>
        </div>
        <div className="panel-body">
          <form className="nl-form" onSubmit={handleSubmitNl}>
            <label htmlFor={nlInputId} className="visually-hidden">
              Consigne opérateur
            </label>
            <textarea
              id={nlInputId}
              rows={2}
              required
              data-testid="input-nl-prompt"
              className="nl-textarea"
              value={nlDraft}
              onChange={(e) => setNlDraft(e.target.value)}
              placeholder="Consigne en français ou en anglais..."
            />
            <div className="scenario-quick-row">
              <button
                type="button"
                data-testid="btn-nl-preset-fr"
                className="scenario-chip"
                onClick={() => setNlDraft(NL_PRESETS[0])}
              >
                FR : 2 pièces TIAGo
              </button>
              <button
                type="button"
                data-testid="btn-nl-preset-en"
                className="scenario-chip"
                onClick={() => setNlDraft(NL_PRESETS[1])}
              >
                EN : 2 parts QC
              </button>
              <button
                type="button"
                data-testid="btn-nl-preset-reject"
                className="scenario-chip"
                onClick={() => setNlDraft(NL_PRESETS[2])}
              >
                Rejet convoyeur A→B
              </button>
            </div>
            <div className="ctrl-actions-row">
              <button
                type="submit"
                data-testid="btn-nl-submit"
                className="action-btn primary"
                disabled={!canCommand}
              >
                <span>Valider</span>
              </button>
              {vlaCandidate.verdict === 'validated' && vlaCandidate.steps.length > 0 && (
                <button
                  type="button"
                  data-testid="btn-nl-approve"
                  className="action-btn"
                  disabled={!canCommand}
                  onClick={() => onApproveNl(vlaCandidate.proposalId ?? '', true)}
                >
                  <span>Exécuter</span>
                </button>
              )}
            </div>
          </form>

          <div className="vla-box">
            {vlaCandidate.steps.length > 0 && (
              <ol className="pddl-list mono">
                {vlaCandidate.steps.map((st, idx) => (
                  <li key={idx}>{st}</li>
                ))}
              </ol>
            )}

            <div className={`verdict-panel ${vlaCandidate.verdict}`}>
              <span>{vlaCandidate.verdictReason}</span>
            </div>
          </div>
        </div>
      </section>

      <details className="panel-details">
        <summary className="rail-details-summary">
          Préconditions L1 ({preconditions.filter((p) => p.passed).length}/{preconditions.length})
        </summary>
        <div className="precondition-list">
          {preconditions.map((check) => (
            <div
              key={check.id}
              className={`precondition-item ${check.passed ? '' : 'failed'}`}
            >
              <div>
                <div className="precondition-label">{check.label}</div>
                <div className="precondition-detail">{check.detail}</div>
              </div>
              <span className={`scada-tag ${check.passed ? 'ok' : 'fault'}`}>
                <span className="scada-led" aria-hidden="true" />
                <span>{check.passed ? 'OK' : 'Bloqué'}</span>
              </span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
};
