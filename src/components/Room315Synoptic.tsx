import React from 'react';
import type { CellSnapshot, EquipmentId, EquipmentStatus } from '../types/cell';

interface Room315SynopticProps {
  snapshot: CellSnapshot;
  selectedId: EquipmentId;
  onSelectEquipment: (id: EquipmentId) => void;
}

function statusStroke(status: EquipmentStatus): string {
  switch (status) {
    case 'active':
      return '#4E93E6';
    case 'ready':
      return '#38B87C';
    case 'warning':
      return '#EBB52A';
    case 'fault':
      return '#E55353';
    case 'standby':
    case 'out_of_scope':
    default:
      return '#526477';
  }
}

function shuttleCoords(cx: number, cy: number, progress: number): { x: number; y: number } {
  const p = ((progress % 1) + 1) % 1;
  if (p <= 0.3) {
    const t = p / 0.3;
    return { x: cx - 76 + t * 152, y: cy + 44 };
  }
  if (p <= 0.5) {
    const t = (p - 0.3) / 0.2;
    const angle = Math.PI / 2 - t * Math.PI;
    return { x: cx + 76 + Math.cos(angle) * 44, y: cy + Math.sin(angle) * 44 };
  }
  if (p <= 0.8) {
    const t = (p - 0.5) / 0.3;
    return { x: cx + 76 - t * 152, y: cy - 44 };
  }
  const t = (p - 0.8) / 0.2;
  const angle = -Math.PI / 2 - t * Math.PI;
  return { x: cx - 76 + Math.cos(angle) * 44, y: cy + Math.sin(angle) * 44 };
}

function yaskawaEffector(
  baseX: number,
  baseY: number,
  target: CellSnapshot['yaskawaA']['poseTarget'],
  zone: 'A' | 'B'
): { x: number; y: number } {
  const dir = zone === 'A' ? 1 : -1;
  switch (target) {
    case 'table':
      return { x: baseX - 54 * dir, y: baseY + 14 };
    case 'station_blue':
      return { x: baseX - 46, y: baseY - 64 };
    case 'station_green':
      return { x: baseX + 46, y: baseY - 64 };
    case 'tiago_handover':
      return { x: baseX + 92 * dir, y: baseY - 18 };
    case 'home':
    default:
      return { x: baseX, y: baseY - 32 };
  }
}

function handleKeySelect(
  event: React.KeyboardEvent,
  id: EquipmentId,
  onSelect: (id: EquipmentId) => void
) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    onSelect(id);
  }
}

export const Room315Synoptic: React.FC<Room315SynopticProps> = ({
  snapshot,
  selectedId,
  onSelectEquipment,
}) => {
  const zoneACx = 230;
  const zoneBCx = 710;
  const railCy = 238;
  const yaskawaY = 348;

  const shuttleA = shuttleCoords(zoneACx, railCy, snapshot.montracA.loopProgress);
  const shuttleB = shuttleCoords(zoneBCx, railCy, snapshot.montracB.loopProgress);

  const effA = yaskawaEffector(zoneACx, yaskawaY, snapshot.yaskawaA.poseTarget, 'A');
  const effB = yaskawaEffector(zoneBCx, yaskawaY, snapshot.yaskawaB.poseTarget, 'B');

  const tiagoPos = (() => {
    const p = snapshot.tiago.corridorProgress;
    if (p <= 0.25) {
      const t = p / 0.25;
      return { x: 470 - t * 38, y: 120 + t * 185 };
    }
    if (p <= 0.75) {
      const t = (p - 0.25) / 0.5;
      return { x: 432 + t * 76, y: 305 };
    }
    const t = (p - 0.75) / 0.25;
    return { x: 508 - t * 38, y: 305 - t * 185 };
  })();

  const renderMontracLoop = (
    cx: number,
    zone: 'A' | 'B',
    id: 'montrac_a' | 'montrac_b',
    shuttle: { x: number; y: number },
    shuttleId: string,
    partPresent: boolean,
    status: EquipmentStatus,
    watchdogOk: boolean
  ) => {
    const isSelected = selectedId === id;
    const stroke = statusStroke(status);
    return (
      <g
        role="button"
        tabIndex={0}
        aria-label={`Montrac Zone ${zone}`}
        onClick={() => onSelectEquipment(id)}
        onKeyDown={(e) => handleKeySelect(e, id, onSelectEquipment)}
        style={{ cursor: 'pointer' }}
      >
        <rect
          x={cx - 134}
          y={railCy - 66}
          width={268}
          height={132}
          rx={6}
          fill={isSelected ? 'rgba(78, 147, 230, 0.09)' : 'transparent'}
          stroke={isSelected ? '#4E93E6' : 'transparent'}
          strokeWidth={isSelected ? 1.8 : 0}
          strokeDasharray={isSelected ? '5 3' : undefined}
        />

        {/* Structure rail Montrac */}
        <rect
          x={cx - 120}
          y={railCy - 44}
          width={240}
          height={88}
          rx={44}
          fill="none"
          stroke="#253241"
          strokeWidth={14}
        />
        <line
          x1={cx - 88}
          y1={railCy}
          x2={cx + 88}
          y2={railCy}
          stroke="#253241"
          strokeWidth={10}
        />
        <line
          x1={cx - 88}
          y1={railCy}
          x2={cx + 88}
          y2={railCy}
          stroke="#4F6275"
          strokeWidth={2.5}
        />

        <rect
          x={cx - 120}
          y={railCy - 44}
          width={240}
          height={88}
          rx={44}
          fill="none"
          stroke={status === 'fault' ? '#E55353' : '#657A8F'}
          strokeWidth={3.5}
        />

        <circle cx={cx - 102} cy={railCy} r={5.5} fill="#526477" />
        <circle cx={cx + 102} cy={railCy} r={5.5} fill="#526477" />

        {/* 4 stations colorées */}
        <rect x={cx - 56} y={railCy - 55} width={22} height={10} rx={2} fill="#C94444" />
        <rect x={cx + 34} y={railCy - 55} width={22} height={10} rx={2} fill="#D9A326" />
        <rect x={cx - 56} y={railCy + 44} width={22} height={10} rx={2} fill="#3578CC" />
        <text x={cx - 45} y={railCy + 66} textAnchor="middle" fontSize={10} fill="#99A9BA">
          Bleu
        </text>
        <rect x={cx + 34} y={railCy + 44} width={22} height={10} rx={2} fill="#2A9B68" />
        <text x={cx + 45} y={railCy + 66} textAnchor="middle" fontSize={10} fill="#99A9BA">
          Vert
        </text>

        {/* Navette Montrac */}
        <g transform={`translate(${shuttle.x}, ${shuttle.y})`}>
          <rect
            x={-16}
            y={-11}
            width={32}
            height={22}
            rx={4}
            fill={status === 'fault' ? '#E55353' : '#EBB52A'}
            stroke="#0E141B"
            strokeWidth={1.6}
          />
          <rect x={-11} y={-7} width={22} height={14} rx={2} fill="#F5CE62" />
          {partPresent && (
            <rect
              x={-6}
              y={-6}
              width={12}
              height={12}
              rx={1.5}
              fill="#4E93E6"
              stroke="#0E141B"
              strokeWidth={1.4}
            />
          )}
          <text x={0} y={-15} textAnchor="middle" fontSize={10} fontWeight={700} fill="#E8EEF5">
            {shuttleId}
          </text>
        </g>

        <text
          x={cx}
          y={railCy + 4}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill={watchdogOk ? '#99A9BA' : stroke}
        >
          {watchdogOk ? `Montrac ${zone}` : `Montrac ${zone} (défaut)`}
        </text>
      </g>
    );
  };

  const renderYaskawa = (
    baseX: number,
    eff: { x: number; y: number },
    zone: 'A' | 'B',
    arm: CellSnapshot['yaskawaA'],
    partOnTable: boolean
  ) => {
    const isSelected = selectedId === arm.id;
    const stroke = statusStroke(arm.status);
    const dir = zone === 'A' ? 1 : -1;
    const tablePadX = baseX - 56 * dir;
    const tablePadY = yaskawaY + 12;
    const elbowX = (baseX + eff.x) / 2 + 16 * dir;
    const elbowY = (yaskawaY + eff.y) / 2 + 8;

    return (
      <g
        role="button"
        tabIndex={0}
        aria-label={arm.name}
        onClick={() => onSelectEquipment(arm.id)}
        onKeyDown={(e) => handleKeySelect(e, arm.id, onSelectEquipment)}
        style={{ cursor: 'pointer' }}
      >
        <rect
          x={baseX - 90}
          y={yaskawaY - 22}
          width={180}
          height={68}
          rx={4}
          fill="#1A2430"
          stroke={isSelected ? '#4E93E6' : '#324254'}
          strokeWidth={isSelected ? 2 : 1.2}
        />

        <rect
          x={tablePadX - 15}
          y={tablePadY - 12}
          width={30}
          height={24}
          rx={2}
          fill="#121922"
          stroke="#46596E"
          strokeDasharray="3 2"
        />
        {partOnTable && (
          <rect
            x={tablePadX - 7}
            y={tablePadY - 7}
            width={14}
            height={14}
            rx={1.5}
            fill="#4E93E6"
            stroke="#E8EEF5"
            strokeWidth={1.3}
          />
        )}

        <circle cx={baseX} cy={yaskawaY + 8} r={16} fill="#233142" stroke={stroke} strokeWidth={2.4} />
        <circle cx={baseX} cy={yaskawaY + 8} r={6.5} fill="#4E93E6" />

        <line
          x1={baseX}
          y1={yaskawaY + 8}
          x2={elbowX}
          y2={elbowY}
          stroke="#DCE6F2"
          strokeWidth={8}
          strokeLinecap="round"
        />
        <line
          x1={baseX}
          y1={yaskawaY + 8}
          x2={elbowX}
          y2={elbowY}
          stroke="#4E93E6"
          strokeWidth={2.2}
          strokeLinecap="round"
        />

        <line
          x1={elbowX}
          y1={elbowY}
          x2={eff.x}
          y2={eff.y}
          stroke="#DCE6F2"
          strokeWidth={6.5}
          strokeLinecap="round"
        />
        <line
          x1={elbowX}
          y1={elbowY}
          x2={eff.x}
          y2={eff.y}
          stroke="#4E93E6"
          strokeWidth={2}
          strokeLinecap="round"
        />

        <circle cx={elbowX} cy={elbowY} r={5} fill="#4E93E6" stroke="#11171E" strokeWidth={1.5} />
        <circle
          cx={eff.x}
          cy={eff.y}
          r={5.5}
          fill={arm.gripperState === 'holding' ? '#38B87C' : '#99A9BA'}
        />
        {arm.carryingPart && (
          <rect
            x={eff.x - 6}
            y={eff.y - 6}
            width={12}
            height={12}
            rx={1.5}
            fill="#4E93E6"
            stroke="#E8EEF5"
            strokeWidth={1.3}
          />
        )}

        <text
          x={baseX}
          y={yaskawaY + 64}
          textAnchor="middle"
          fontSize={12}
          fontWeight={600}
          fill={isSelected ? '#4E93E6' : '#E8EEF5'}
        >
          {arm.name}
        </text>
      </g>
    );
  };

  return (
    <svg
      className="synoptic-svg"
      viewBox="0 0 940 445"
      role="img"
      aria-label="Synoptique Salle 315 MFJA"
    >
      <defs>
        <pattern id="hall-grid-dark" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#18222E" strokeWidth="0.8" />
        </pattern>
      </defs>

      <rect x="8" y="8" width="924" height="429" rx="4" fill="#10161D" stroke="#24303F" strokeWidth="1.2" />
      <rect x="8" y="8" width="924" height="429" rx="4" fill="url(#hall-grid-dark)" />

      {/* Zone A */}
      <rect
        x="34"
        y="28"
        width="392"
        height="392"
        rx="4"
        fill="rgba(25, 34, 46, 0.55)"
        stroke={snapshot.safety.status === 'estop_triggered' ? '#E55353' : '#2C3B4D'}
        strokeWidth={snapshot.safety.status === 'estop_triggered' ? 2 : 1.2}
      />
      <text x="50" y="52" fontSize="13" fontWeight="700" fill="#E8EEF5">
        Zone A
      </text>

      {/* Zone B */}
      <rect
        x="514"
        y="28"
        width="392"
        height="392"
        rx="4"
        fill="rgba(25, 34, 46, 0.38)"
        stroke="#273444"
        strokeWidth="1.2"
      />
      <text x="530" y="52" fontSize="13" fontWeight="700" fill="#99A9BA">
        Zone B
      </text>

      {/* Couloir central */}
      <rect
        x="434"
        y="36"
        width="72"
        height="376"
        rx="2"
        fill="rgba(16, 22, 29, 0.65)"
        stroke="#24303F"
        strokeDasharray="4 4"
      />

      {/* Caméras A et B */}
      <g
        role="button"
        tabIndex={0}
        aria-label="Caméra Zone A"
        onClick={() => onSelectEquipment('camera_a')}
        onKeyDown={(e) => handleKeySelect(e, 'camera_a', onSelectEquipment)}
        style={{ cursor: 'pointer' }}
      >
        <polygon
          points="70,126 168,176 168,288"
          fill="rgba(78, 147, 230, 0.08)"
          stroke={selectedId === 'camera_a' ? '#4E93E6' : 'rgba(78, 147, 230, 0.22)'}
          strokeDasharray="3 3"
        />
        <rect x="52" y="116" width="26" height="16" rx="3" fill={selectedId === 'camera_a' ? '#4E93E6' : '#314255'} />
        <text x="52" y="110" fontSize="10" fill="#99A9BA">
          Cam. A
        </text>
      </g>

      <g
        role="button"
        tabIndex={0}
        aria-label="Caméra Zone B"
        onClick={() => onSelectEquipment('camera_b')}
        onKeyDown={(e) => handleKeySelect(e, 'camera_b', onSelectEquipment)}
        style={{ cursor: 'pointer' }}
      >
        <polygon
          points="870,126 772,176 772,288"
          fill="rgba(129, 146, 164, 0.06)"
          stroke={selectedId === 'camera_b' ? '#4E93E6' : 'rgba(129, 146, 164, 0.18)'}
          strokeDasharray="3 3"
        />
        <rect x="862" y="116" width="26" height="16" rx="3" fill={selectedId === 'camera_b' ? '#4E93E6' : '#314255'} />
        <text x="888" y="110" textAnchor="end" fontSize="10" fill="#687A8C">
          Cam. B
        </text>
      </g>

      {/* KUKA & Stäubli (discrets en veille) */}
      <g
        role="button"
        tabIndex={0}
        aria-label="KUKA KR6"
        onClick={() => onSelectEquipment('kuka_a')}
        onKeyDown={(e) => handleKeySelect(e, 'kuka_a', onSelectEquipment)}
        style={{ cursor: 'pointer' }}
        opacity={selectedId === 'kuka_a' ? 1 : 0.52}
      >
        <rect
          x={zoneACx - 52}
          y={84}
          width={104}
          height={40}
          rx={3}
          fill="#19232E"
          stroke={selectedId === 'kuka_a' ? '#4E93E6' : '#2E3D4F'}
        />
        <circle cx={zoneACx - 16} cy={104} r={9} fill="#B87635" />
        <line x1={zoneACx - 16} y1={104} x2={zoneACx + 20} y2={104} stroke="#B87635" strokeWidth={5} strokeLinecap="round" />
        <text x={zoneACx} y={138} textAnchor="middle" fontSize="10" fill="#687A8C">
          KUKA KR6
        </text>
      </g>

      <g
        role="button"
        tabIndex={0}
        aria-label="Stäubli TX2"
        onClick={() => onSelectEquipment('staubli_b')}
        onKeyDown={(e) => handleKeySelect(e, 'staubli_b', onSelectEquipment)}
        style={{ cursor: 'pointer' }}
        opacity={selectedId === 'staubli_b' ? 1 : 0.52}
      >
        <rect
          x={zoneBCx - 52}
          y={84}
          width={104}
          height={40}
          rx={3}
          fill="#19232E"
          stroke={selectedId === 'staubli_b' ? '#4E93E6' : '#2E3D4F'}
        />
        <circle cx={zoneBCx + 16} cy={104} r={9} fill="#C49E38" />
        <line x1={zoneBCx + 16} y1={104} x2={zoneBCx - 20} y2={104} stroke="#C49E38" strokeWidth={5} strokeLinecap="round" />
        <text x={zoneBCx} y={138} textAnchor="middle" fontSize="10" fill="#687A8C">
          Stäubli TX2
        </text>
      </g>

      {renderMontracLoop(
        zoneACx,
        'A',
        'montrac_a',
        shuttleA,
        snapshot.montracA.shuttleId,
        snapshot.montracA.partPresent,
        snapshot.montracA.status,
        snapshot.montracA.watchdogOk
      )}
      {renderMontracLoop(
        zoneBCx,
        'B',
        'montrac_b',
        shuttleB,
        snapshot.montracB.shuttleId,
        snapshot.montracB.partPresent,
        snapshot.montracB.status,
        snapshot.montracB.watchdogOk
      )}

      {renderYaskawa(zoneACx, effA, 'A', snapshot.yaskawaA, snapshot.partLocation === 'table_a')}
      {renderYaskawa(zoneBCx, effB, 'B', snapshot.yaskawaB, snapshot.partLocation === 'table_b')}

      {snapshot.activeScenarioCode === 'J2' && (
        <path
          d="M 470 120 L 432 305 L 508 305"
          fill="none"
          stroke="#4E93E6"
          strokeWidth="1.8"
          strokeDasharray="5 4"
        />
      )}

      <g
        role="button"
        tabIndex={0}
        aria-label="TIAGo"
        onClick={() => onSelectEquipment('tiago')}
        onKeyDown={(e) => handleKeySelect(e, 'tiago', onSelectEquipment)}
        style={{ cursor: 'pointer' }}
        transform={`translate(${tiagoPos.x}, ${tiagoPos.y})`}
        opacity={snapshot.tiago.status === 'out_of_scope' && selectedId !== 'tiago' ? 0.5 : 1}
      >
        <circle
          cx={0}
          cy={0}
          r={20}
          fill="#19232E"
          stroke={statusStroke(snapshot.tiago.status)}
          strokeWidth={selectedId === 'tiago' ? 2.4 : 1.6}
        />
        <circle cx={0} cy={-3} r={8} fill="#99A9BA" />
        <rect x={-9} y={7} width={18} height={5} rx={2} fill="#4F6275" />
        {snapshot.tiago.carryingPart && (
          <rect
            x={-6}
            y={-9}
            width={12}
            height={12}
            rx={1.5}
            fill="#4E93E6"
            stroke="#E8EEF5"
            strokeWidth={1.3}
          />
        )}
        <text x={0} y={33} textAnchor="middle" fontSize="11" fontWeight="600" fill="#E8EEF5">
          TIAGo
        </text>
      </g>
    </svg>
  );
};
