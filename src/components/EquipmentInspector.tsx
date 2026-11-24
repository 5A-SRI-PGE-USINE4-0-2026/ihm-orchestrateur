import React from 'react';
import type { CellSnapshot, EquipmentId, EquipmentStatus } from '../types/cell';

interface EquipmentInspectorProps {
  snapshot: CellSnapshot;
  selectedId: EquipmentId;
}

function statusLabel(status: EquipmentStatus): string {
  switch (status) {
    case 'active':
      return 'Actif';
    case 'ready':
      return 'Prêt';
    case 'warning':
      return 'Attention';
    case 'fault':
      return 'Défaut';
    case 'standby':
      return 'Veille';
    case 'out_of_scope':
      return 'Hors J1';
  }
}

export const EquipmentInspector: React.FC<EquipmentInspectorProps> = ({
  snapshot,
  selectedId,
}) => {
  const info = (() => {
    if (selectedId === 'yaskawa_a' || selectedId === 'yaskawa_b') {
      const arm = selectedId === 'yaskawa_a' ? snapshot.yaskawaA : snapshot.yaskawaB;
      return {
        title: arm.name,
        status: arm.status,
        metrics: [
          {
            label: 'Pince',
            value: arm.gripperState === 'holding' ? 'Fermée (cube)' : 'Ouverte',
          },
          {
            label: 'Action',
            value: arm.actionLabel,
          },
          {
            label: 'Topic',
            value: arm.rosTopic,
            mono: true,
          },
        ],
      };
    }

    if (selectedId === 'montrac_a' || selectedId === 'montrac_b') {
      const rail = selectedId === 'montrac_a' ? snapshot.montracA : snapshot.montracB;
      const station =
        rail.station === 'blue'
          ? 'Bleu'
          : rail.station === 'green'
            ? 'Vert'
            : 'Transit';
      return {
        title: `${rail.name} (${rail.shuttleId})`,
        status: rail.status,
        metrics: [
          { label: 'Station', value: `${station} · ${rail.speedMmS} mm/s`.replace(' · ', ', ') },
          { label: 'Pièce', value: rail.partPresent ? 'Présente' : 'Libre' },
          {
            label: 'Chien de garde',
            value: rail.watchdogOk ? `OK (${rail.watchdogAgeMs} ms)` : `Défaut (${rail.watchdogAgeMs} ms)`,
            mono: true,
          },
        ],
      };
    }

    if (selectedId === 'tiago') {
      const t = snapshot.tiago;
      return {
        title: t.name,
        status: t.status,
        metrics: [
          { label: 'État', value: t.actionLabel },
          { label: 'Batterie', value: `${t.batteryPct} %`, mono: true },
          { label: 'Topic', value: t.rosTopic, mono: true },
        ],
      };
    }

    if (selectedId === 'camera_a' || selectedId === 'camera_b') {
      const cam = selectedId === 'camera_a' ? snapshot.cameraA : snapshot.cameraB;
      return {
        title: cam.name,
        status: cam.status,
        metrics: [
          { label: 'Flux', value: `${cam.fps} ips`, mono: true },
          { label: 'Observation', value: cam.detectedObjects[0] ?? 'Aucune' },
          { label: 'Topic', value: cam.rosTopic, mono: true },
        ],
      };
    }

    const standby = selectedId === 'kuka_a' ? snapshot.kukaA : snapshot.staubliB;
    return {
      title: standby.name,
      status: standby.status,
      metrics: [{ label: 'Périmètre', value: standby.note }],
    };
  })();

  return (
    <section className="inspector-strip" aria-label="Équipement sélectionné">
      <div className="inspector-identity">
        <h3 className="inspector-title">{info.title}</h3>
        <span className={`state-badge ${info.status}`}>
          <span className="status-dot" aria-hidden="true" />
          {statusLabel(info.status)}
        </span>
      </div>

      <div className="inspector-metrics">
        {info.metrics.map((m) => (
          <div className="metric-cell" key={m.label}>
            <span className="metric-label">{m.label}</span>
            <span className={`metric-value ${m.mono ? 'mono' : ''}`}>{m.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
};
