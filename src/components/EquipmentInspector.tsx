import React from 'react';
import type { CellSnapshot, EquipmentId, EquipmentStatus } from '../types/cell';

interface EquipmentInspectorProps {
  snapshot: CellSnapshot;
  selectedId: EquipmentId | null;
  onClose: () => void;
}

function statusCode(status: EquipmentStatus): string {
  switch (status) {
    case 'active':
      return 'En cours';
    case 'ready':
      return 'Prêt';
    case 'warning':
      return 'Alerte';
    case 'fault':
      return 'Défaut';
    case 'standby':
    case 'out_of_scope':
      return 'Veille';
  }
}

export const EquipmentInspector: React.FC<EquipmentInspectorProps> = ({
  snapshot,
  selectedId,
  onClose,
}) => {
  if (!selectedId) {
    return null;
  }

  const info = (() => {
    if (selectedId === 'yaskawa_a' || selectedId === 'yaskawa_b') {
      const arm = selectedId === 'yaskawa_a' ? snapshot.yaskawaA : snapshot.yaskawaB;
      return {
        title: selectedId === 'yaskawa_a' ? 'Poste A · HC10DT' : 'Poste B · HC10',
        status: arm.status,
        detail: `${arm.actionLabel} · Pince ${arm.gripperState === 'holding' ? 'fermée' : 'ouverte'}`,
      };
    }

    if (selectedId === 'montrac_a' || selectedId === 'montrac_b') {
      const isA = selectedId === 'montrac_a';
      const rail = isA ? snapshot.montracA : snapshot.montracB;
      const slot =
        rail.station === 'blue' ? 'DZI1' : rail.station === 'green' ? (isA ? 'DZI2' : 'DZI3') : 'Transit';
      return {
        title: isA ? `Montrac A (${rail.shuttleId})` : `Montrac B (${rail.shuttleId})`,
        status: rail.status,
        detail: `${slot} · ${rail.speedMmS} mm/s`,
      };
    }

    if (selectedId === 'tiago') {
      return {
        title: 'PAL TIAGo',
        status: snapshot.tiago.status,
        detail: snapshot.tiago.actionLabel,
      };
    }

    if (selectedId === 'camera_a' || selectedId === 'camera_b') {
      const cam = selectedId === 'camera_a' ? snapshot.cameraA : snapshot.cameraB;
      return {
        title: selectedId === 'camera_a' ? 'ZED 2 Poste A' : 'ZED 2 Poste B',
        status: cam.status,
        detail: `${cam.fps} Hz`,
      };
    }

    const unit = selectedId === 'kuka_a' ? snapshot.kukaA : snapshot.staubliB;
    return {
      title: selectedId === 'kuka_a' ? 'KUKA KR6' : 'Stäubli TX2',
      status: unit.status,
      detail: unit.note,
    };
  })();

  return (
    <div className="inspector-popover-bar" role="region" aria-label="Détail équipement">
      <div className="inspector-popover-main">
        <strong className="inspector-title">{info.title}</strong>
        <span className={`scada-tag ${info.status}`}>
          <span className="scada-led" aria-hidden="true" />
          <span>{statusCode(info.status)}</span>
        </span>
        <span className="inspector-detail">{info.detail}</span>
      </div>
      <button type="button" className="scenario-chip" onClick={onClose} aria-label="Fermer détail">
        Fermer
      </button>
    </div>
  );
};
