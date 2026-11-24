import React from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import type { CellSnapshot } from '../types/cell';

interface SupervisorViewProps {
  snapshot: CellSnapshot;
}

export const SupervisorView: React.FC<SupervisorViewProps> = ({ snapshot }) => {
  const { preconditions, vlaCandidate, kpis } = snapshot;

  return (
    <div className="page-container">
      <section className="kpi-strip" aria-label="Indicateurs clés">
        <div className="kpi-cell">
          <span className="kpi-name">Cycles complétés</span>
          <span className="kpi-number num">
            {kpis.completedCycles} / {kpis.targetBatchCycles}
          </span>
        </div>
        <div className="kpi-cell">
          <span className="kpi-name">Conformité</span>
          <span className="kpi-number num">{(kpis.conformityRatePct ?? 0).toFixed(1)} %</span>
        </div>
        <div className="kpi-cell">
          <span className="kpi-name">Temps moyen</span>
          <span className="kpi-number num">{(kpis.averageCycleTimeS ?? 0).toFixed(1)} s</span>
        </div>
      </section>

      <div className="two-col-grid">
        <section className="panel-block">
          <div className="panel-header">
            <h2 className="section-title">Préconditions L1</h2>
            <span className="step-meta">
              {preconditions.filter((p) => p.passed).length} / {preconditions.length} OK
            </span>
          </div>
          <div className="panel-body">
            <div className="precondition-list">
              {preconditions.map((check) => (
                <div
                  key={check.id}
                  className={`precondition-item ${check.passed ? '' : 'failed'}`}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '13px' }}>{check.label}</div>
                    <div className="mono" style={{ fontSize: '11.5px', color: 'var(--ink-muted)' }}>
                      {check.predicate}
                    </div>
                  </div>
                  <span className={`state-badge ${check.passed ? 'ok' : 'fault'}`}>
                    {check.passed ? (
                      <CheckCircle2 size={13} aria-hidden="true" />
                    ) : (
                      <XCircle size={13} aria-hidden="true" />
                    )}
                    {check.passed ? 'OK' : 'Bloqué'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="panel-block">
          <div className="panel-header">
            <h2 className="section-title">Plan candidat J3 (VLA / PDDL)</h2>
            <span className={`state-badge ${vlaCandidate.verdict === 'validated' ? 'ok' : 'fault'}`}>
              {vlaCandidate.verdict === 'validated' ? 'Autorisé' : 'Rejeté'}
            </span>
          </div>
          <div className="panel-body">
            <div className="vla-box">
              <blockquote className="vla-quote">{vlaCandidate.naturalLanguageRequest}</blockquote>

              <ol className="pddl-list mono">
                {vlaCandidate.steps.map((st, idx) => (
                  <li key={idx}>{st}</li>
                ))}
              </ol>

              <div className={`verdict-panel ${vlaCandidate.verdict}`}>
                <p className="verdict-title">
                  {vlaCandidate.verdict === 'validated' ? 'Validé par L1' : 'Rejeté par L1 (fail-closed)'}
                </p>
                <span>{vlaCandidate.verdictReason}</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
