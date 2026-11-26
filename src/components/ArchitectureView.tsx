import React, { useId, useState } from 'react';
import type {
  CellSnapshot,
  ConnectionState,
  RosConfig,
  TelemetrySourceMode,
} from '../types/cell';

interface ArchitectureViewProps {
  headingRef?: React.RefObject<HTMLHeadingElement>;
  snapshot: CellSnapshot;
  config: RosConfig;
  sourceMode: TelemetrySourceMode;
  connectionState: ConnectionState;
  connectionDetail: string;
  onSaveRosbridgeUrl: (url: string) => void;
  onChangeSourceMode: (mode: TelemetrySourceMode) => void;
}

export const ArchitectureView: React.FC<ArchitectureViewProps> = ({
  headingRef,
  snapshot,
  config,
  onSaveRosbridgeUrl,
  onChangeSourceMode,
}) => {
  const [urlDraft, setUrlDraft] = useState(config.rosbridgeUrl);
  const urlInputId = useId();

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
        <h2 ref={headingRef} tabIndex={-1} className="visually-hidden">
          Connexion ROS 2
        </h2>
        <div className="panel-body">
          <form className="config-form" onSubmit={handleSubmit}>
            <div className="field-group">
              <label className="visually-hidden" htmlFor={urlInputId}>
                Serveur WebSocket ROS 2
              </label>
              <input
                id={urlInputId}
                type="url"
                required
                className="text-input mono"
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                placeholder="ws://localhost:9090"
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
        </div>
      </section>

      <section className="panel-block">
        <div
          tabIndex={0}
          role="region"
          aria-labelledby="ros-topics-caption"
          className="data-table-wrap"
        >
          <table className="data-table">
            <caption id="ros-topics-caption" className="table-caption">
              Topics ROS 2 Salle 315
            </caption>
            <thead>
              <tr>
                <th scope="col">Topic</th>
                <th scope="col">Hz</th>
                <th scope="col">État</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.rosTopics.map((item) => (
                <tr key={item.topic}>
                  <th scope="row" className="mono">
                    {item.topic}
                  </th>
                  <td className="mono">{(item.hz ?? 0).toFixed(1)}</td>
                  <td>
                    <span className={`scada-tag ${item.active ? 'ok' : 'standby'}`}>
                      <span className="scada-led" aria-hidden="true" />
                      <span>{item.active ? 'Actif' : 'Veille'}</span>
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
