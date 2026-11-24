import React, { useState } from 'react';
import type {
  CellSnapshot,
  ConnectionState,
  RosConfig,
  TelemetrySourceMode,
} from '../types/cell';

interface ArchitectureViewProps {
  snapshot: CellSnapshot;
  config: RosConfig;
  sourceMode: TelemetrySourceMode;
  connectionState: ConnectionState;
  connectionDetail: string;
  onSaveRosbridgeUrl: (url: string) => void;
  onChangeSourceMode: (mode: TelemetrySourceMode) => void;
}

export const ArchitectureView: React.FC<ArchitectureViewProps> = ({
  snapshot,
  config,
  sourceMode,
  connectionState,
  connectionDetail,
  onSaveRosbridgeUrl,
  onChangeSourceMode,
}) => {
  const [urlDraft, setUrlDraft] = useState(config.rosbridgeUrl);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const cleaned = urlDraft.trim();
    if (!cleaned) return;
    onSaveRosbridgeUrl(cleaned);
    onChangeSourceMode('rosbridge');
  };

  return (
    <div className="page-container">
      <section className="panel-block">
        <div className="panel-header">
          <h2 className="section-title">Connexion rosbridge (lecture seule)</h2>
          <span className={`state-badge ${snapshot.gzSimFlag ? 'active' : 'ready'} mono`}>
            gz_sim:={snapshot.gzSimFlag ? 'true' : 'false'}
          </span>
        </div>
        <div className="panel-body">
          <form className="config-form" onSubmit={handleSubmit}>
            <div className="field-group">
              <label className="field-label" htmlFor="rosbridge-url">
                WebSocket rosbridge_server
              </label>
              <input
                id="rosbridge-url"
                type="text"
                className="text-input mono"
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                placeholder="ws://192.168.x.x:9090"
              />
            </div>
            <button type="submit" className="action-btn primary">
              Connecter
            </button>
            <button
              type="button"
              className="action-btn"
              onClick={() => onChangeSourceMode('demo')}
            >
              Mode démo
            </button>
          </form>
          <p className="metric-label" style={{ margin: '8px 0 0 0' }}>
            {sourceMode === 'demo' ? 'Relecture locale active.' : `${connectionDetail} (${connectionState}).`}
          </p>
        </div>
      </section>

      <section className="panel-block">
        <div className="panel-header">
          <h2 className="section-title">Topics ROS 2 écoutés</h2>
          <span className="step-meta">Abonnements passifs uniquement</span>
        </div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Topic</th>
                <th>Producteur</th>
                <th>Hz</th>
                <th>État</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.rosTopics.map((item) => (
                <tr key={item.topic}>
                  <td className="mono">{item.topic}</td>
                  <td>{item.nodeOwner}</td>
                  <td className="mono">{(item.hz ?? 0).toFixed(1)}</td>
                  <td>
                    <span className={`state-badge ${item.active ? 'ok' : 'standby'}`}>
                      {item.active ? 'Actif' : 'Inactif'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
