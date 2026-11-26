import React from 'react';
import {
  CARTER_DROIT_WORLD,
  CARTER_GAUCHE_WORLD,
  EXTERIOR_SEGMENT_KEYS,
  INTERIOR_BYPASS_KEYS,
  MONTRAC_CHASSIS_CAD,
  MONTRAC_LEFT_SEGMENTS,
  MONTRAC_LEFT_SLOTS,
  MONTRAC_LEFT_SWITCHES,
  MONTRAC_RIGHT_SEGMENTS,
  MONTRAC_RIGHT_SLOTS,
  MONTRAC_RIGHT_SWITCHES,
  ROBOT_TABLES_CAD,
  sampleMontracShuttlePose,
  type CadBoxFootprint,
  type MontracSlotSpec,
  type MontracSwitchSpec,
  type WorldPt,
} from '../data/room315CadGeometry';
import type {
  CellSnapshot,
  EquipmentId,
  EquipmentStatus,
  ShuttleWorldPose,
} from '../types/cell';
import type { UiTheme } from './TopBar';

interface Room315SynopticProps {
  snapshot: CellSnapshot;
  selectedId: EquipmentId | null;
  onSelectEquipment: (id: EquipmentId) => void;
  theme?: UiTheme;
}

interface SimWorkpieceItem {
  part_id?: string;
  stage?: string;
  holder?: string;
  quality_status?: string;
  simulated_defect?: boolean;
  pose?: { x?: number; y?: number; z?: number; yaw?: number };
}

const WORLD_X_EAST = -7.45;
const WORLD_Y_SOUTH = -6.75;
const PX_PER_M = 75.0;
const OFFSET_X = 54.0;
const OFFSET_Y = 26.0;

export function worldToSvg(wx: number, wy: number): { x: number; y: number } {
  return {
    x: OFFSET_X + (WORLD_X_EAST - wx) * PX_PER_M,
    y: OFFSET_Y + (wy - WORLD_Y_SOUTH) * PX_PER_M,
  };
}

export function worldYawToSvgDeg(yawRad: number): number {
  return (Math.atan2(Math.sin(yawRad), -Math.cos(yawRad)) * 180) / Math.PI;
}

function worldPolyline(coords: ReadonlyArray<WorldPt>): string {
  return coords
    .map(([wx, wy], idx) => {
      const p = worldToSvg(wx, wy);
      return `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    })
    .join(' ');
}

function cadBoxToSvgRect(box: CadBoxFootprint): { x: number; y: number; width: number; height: number } {
  const nw = worldToSvg(box.maxX, box.minY);
  const se = worldToSvg(box.minX, box.maxY);
  return {
    x: Math.min(nw.x, se.x),
    y: Math.min(nw.y, se.y),
    width: Math.abs(se.x - nw.x),
    height: Math.abs(se.y - nw.y),
  };
}

function fallbackTiagoWorld(progress: number): { x: number; y: number; yaw: number } {
  if (progress <= 0.08) return { x: -9.0, y: -1.6, yaw: Math.PI / 2 };
  if (progress <= 0.25) {
    const t = (progress - 0.08) / 0.17;
    return { x: -12.8 + t * 1.14, y: -1.55 - t * 1.43, yaw: 0 };
  }
  if (progress <= 0.5) {
    const t = (progress - 0.25) / 0.25;
    return { x: -11.66 - t * 1.14, y: -2.98 - t * 0.07, yaw: Math.PI };
  }
  if (progress <= 0.75) {
    const t = (progress - 0.5) / 0.25;
    return { x: -12.8 - t * 1.16, y: -3.05 - t * 0.13, yaw: Math.PI };
  }
  return { x: -16.48, y: -1.6, yaw: Math.PI / 2 };
}

function computeArmTcpWorld(
  baseX: number,
  baseY: number,
  zone: 'A' | 'B',
  arm: CellSnapshot['yaskawaA'],
  activeWp?: SimWorkpieceItem
): { tcpX: number; tcpY: number; elbowX: number; elbowY: number } {
  const holder = (activeWp?.holder ?? '').toLowerCase();
  const holdingThisWp =
    arm.carryingPart ||
    (zone === 'A' && holder.includes('hc10dt')) ||
    (zone === 'B' && holder.includes('hc10_1'));

  if (holdingThisWp && activeWp?.pose?.x !== undefined && activeWp?.pose?.y !== undefined) {
    const tx = Number(activeWp.pose.x);
    const ty = Number(activeWp.pose.y);
    return {
      tcpX: tx,
      tcpY: ty,
      elbowX: (baseX + tx) * 0.5 + (zone === 'A' ? -0.14 : 0.14),
      elbowY: (baseY + ty) * 0.5 - 0.16,
    };
  }

  let anchorX = baseX + (zone === 'A' ? 0.28 : -0.28);
  let anchorY = baseY + 0.12;
  if (arm.poseTarget === 'table') {
    anchorX = zone === 'A' ? -10.18 : -15.42;
    anchorY = -3.0;
  } else if (arm.poseTarget === 'station_blue') {
    anchorX = zone === 'A' ? -10.32 : -14.95;
    anchorY = -3.72;
  } else if (arm.poseTarget === 'station_green') {
    anchorX = zone === 'A' ? -10.8 : -15.43;
    anchorY = -3.72;
  } else if (arm.poseTarget === 'tiago_handover') {
    anchorX = zone === 'A' ? -11.08 : -14.54;
    anchorY = zone === 'A' ? -2.98 : -3.18;
  } else {
    const j1Rad = ((arm.jointsDeg?.[0] ?? 0) * Math.PI) / 180;
    const reach = 0.42;
    const dir = zone === 'A' ? j1Rad + Math.PI / 3 : Math.PI - j1Rad - Math.PI / 3;
    anchorX = baseX + Math.cos(dir) * reach;
    anchorY = baseY + Math.sin(dir) * reach * 0.7;
  }

  return {
    tcpX: anchorX,
    tcpY: anchorY,
    elbowX: (baseX + anchorX) * 0.5 + (zone === 'A' ? -0.11 : 0.11),
    elbowY: (baseY + anchorY) * 0.5 - 0.12,
  };
}

function handleSvgKeyDown(
  event: React.KeyboardEvent,
  id: EquipmentId,
  onSelect: (id: EquipmentId) => void
) {
  if (event.key === 'Enter') {
    event.preventDefault();
    onSelect(id);
  } else if (event.key === ' ') {
    event.preventDefault();
  }
}

function handleSvgKeyUp(
  event: React.KeyboardEvent,
  id: EquipmentId,
  onSelect: (id: EquipmentId) => void
) {
  if (event.key === ' ') {
    event.preventDefault();
    onSelect(id);
  }
}

function workpieceVisualStyle(wp: SimWorkpieceItem): {
  fill: string;
  stroke: string;
  kind: 'raw' | 'op1' | 'ok' | 'nok';
} {
  const q = String(wp.quality_status ?? '').toUpperCase();
  const stage = String(wp.stage ?? '').toUpperCase();
  if (
    Boolean(wp.simulated_defect && !q.includes('CONFORMING')) ||
    q.includes('NON_CONFORM') ||
    q.includes('NOK') ||
    q.includes('DEFECT') ||
    q.includes('SCRAP')
  ) {
    return { fill: '#dc2626', stroke: '#fecaca', kind: 'nok' };
  }
  if (
    q === 'CONFORMING' ||
    q === 'OK' ||
    stage.includes('EXPED') ||
    stage.includes('SHIPPED') ||
    stage.includes('REWORKED')
  ) {
    return { fill: '#16a34a', stroke: '#bbf7d0', kind: 'ok' };
  }
  if (
    stage.includes('OP1') ||
    stage.includes('TRANSIT') ||
    stage.includes('MONTRAC') ||
    stage.includes('POSTE_B')
  ) {
    return { fill: '#0284c7', stroke: '#bae6fd', kind: 'op1' };
  }
  return { fill: '#3b82f6', stroke: '#dbeafe', kind: 'raw' };
}

export const Room315Synoptic: React.FC<Room315SynopticProps> = ({
  snapshot,
  selectedId,
  onSelectEquipment,
  theme = 'dark',
}) => {
  const isLight = theme === 'light';

  const pal = isLight
    ? {
        floorBg: '#f7f8fa',
        floorBorder: '#8d96a5',
        gridStroke: '#e3e7ee',
        chassisFill: 'rgba(148, 163, 184, 0.08)',
        chassisStroke: '#bcc4d0',
        railOuterCasing: '#525866',
        railOuterGroove: '#e2e8f0',
        railBypassCasing: '#78716c',
        railBypassGroove: '#fde68a',
        slotText: '#1e2229',
        tableFill: '#eaedf2',
        tableStroke: '#7c8594',
        fixtureFill: '#dde2ea',
        carterOuter: '#475569',
        carterInner: '#cbd5e1',
        labelPrimary: '#16181d',
        selectAccent: '#0f5cc0',
        selectHalo: 'rgba(15, 92, 192, 0.10)',
        bayStroke: 'rgba(19, 117, 71, 0.45)',
        bayFill: 'rgba(19, 117, 71, 0.05)',
        collabFill: 'rgba(180, 110, 0, 0.04)',
        collabActiveFill: 'rgba(180, 110, 0, 0.13)',
        collabStroke: 'rgba(180, 110, 0, 0.45)',
        armLinkOuter: '#334155',
        armLinkInner: '#0f5cc0',
        tiagoTagBg: 'rgba(255, 255, 255, 0.94)',
        tiagoTagBorder: '#9aa3b2',
      }
    : {
        floorBg: '#16181c',
        floorBorder: '#3c414a',
        gridStroke: '#1f2228',
        chassisFill: 'rgba(255, 255, 255, 0.015)',
        chassisStroke: '#2a2e35',
        railOuterCasing: '#3a404a',
        railOuterGroove: '#b0b8c4',
        railBypassCasing: '#463f34',
        railBypassGroove: '#d4a74a',
        slotText: '#d4d8e0',
        tableFill: '#1f2228',
        tableStroke: '#4b525e',
        fixtureFill: '#15171b',
        carterOuter: '#5b6370',
        carterInner: '#aeb6c2',
        labelPrimary: '#e4e6eb',
        selectAccent: '#5294e2',
        selectHalo: 'rgba(82, 148, 226, 0.12)',
        bayStroke: 'rgba(47, 179, 109, 0.42)',
        bayFill: 'rgba(47, 179, 109, 0.04)',
        collabFill: 'rgba(224, 168, 46, 0.03)',
        collabActiveFill: 'rgba(224, 168, 46, 0.11)',
        collabStroke: 'rgba(224, 168, 46, 0.35)',
        armLinkOuter: '#dce2ec',
        armLinkInner: '#5294e2',
        tiagoTagBg: 'rgba(20, 22, 26, 0.92)',
        tiagoTagBorder: '#49505c',
      };

  const statusStroke = (status: EquipmentStatus): string => {
    switch (status) {
      case 'active':
        return pal.selectAccent;
      case 'ready':
        return isLight ? '#137547' : '#2fb36d';
      case 'warning':
        return isLight ? '#945d00' : '#e0a82e';
      case 'fault':
        return isLight ? '#be241e' : '#e5534b';
      case 'standby':
      case 'out_of_scope':
      default:
        return '#7c8594';
    }
  };

  const activeWp = snapshot.liveSim?.activeWorkpiece as SimWorkpieceItem | undefined;
  const rawWorkpieces = (snapshot.liveSim?.workpieces ?? []) as SimWorkpieceItem[];
  const allWorkpieces: SimWorkpieceItem[] =
    rawWorkpieces.length > 0
      ? rawWorkpieces
      : activeWp && activeWp.pose
        ? [activeWp]
        : [];

  const shuttleLeft: ShuttleWorldPose =
    snapshot.liveSim?.shuttles?.left ??
    sampleMontracShuttlePose('left', snapshot.montracA.loopProgress, snapshot.montracA.shuttleId);
  const shuttleRight: ShuttleWorldPose =
    snapshot.liveSim?.shuttles?.right ??
    sampleMontracShuttlePose('right', snapshot.montracB.loopProgress, snapshot.montracB.shuttleId);

  const tiagoWorld = (() => {
    const wp = snapshot.liveSim?.tiagoWorldPose;
    if (wp && typeof wp.x === 'number' && typeof wp.y === 'number') {
      return {
        x: wp.x,
        y: wp.y,
        yaw: typeof wp.yaw === 'number' ? wp.yaw : snapshot.tiago.headingRad ?? -Math.PI / 2,
      };
    }
    return fallbackTiagoWorld(snapshot.tiago.corridorProgress);
  })();

  const tiagoSvg = worldToSvg(tiagoWorld.x, tiagoWorld.y);
  const tiagoHeadingDeg = worldYawToSvgDeg(tiagoWorld.yaw);
  const tiagoArmExtended =
    snapshot.tiago.carryingPart ||
    (tiagoWorld.y <= -2.7 && (Math.abs(tiagoWorld.x - -11.66) < 0.35 || Math.abs(tiagoWorld.x - -13.96) < 0.35)) ||
    (tiagoWorld.y >= -1.72 && (Math.abs(tiagoWorld.x - -9.0) < 0.35 || tiagoWorld.x <= -16.2));

  const humanInZone = Boolean(snapshot.liveSim?.humanInCollabZone);
  const speedScale = snapshot.liveSim?.tiagoSpeedScale ?? 1.0;
  const rawHuman = snapshot.liveSim?.humanWorldPose ?? { x: -12.8, y: -1.1, z: 0, yaw: -Math.PI / 2 };
  const humanSvg = worldToSvg(rawHuman.x, Math.min(-0.4, Math.max(-6.4, rawHuman.y)));

  const armA = computeArmTcpWorld(-10.44, -3.0, 'A', snapshot.yaskawaA, activeWp);
  const armB = computeArmTcpWorld(-15.16, -3.0, 'B', snapshot.yaskawaB, activeWp);

  const staubliJoints = snapshot.liveSim?.staubliJointsDeg ?? [0, 0, 0, 0, 0, 0];
  const wpHolder = String(activeWp?.holder ?? '').toLowerCase();
  const staubliActive =
    snapshot.staubliB.status === 'active' ||
    wpHolder.includes('staubli') ||
    Math.abs(staubliJoints[0]) > 2;
  const staubliBase = worldToSvg(-15.16, -6.0);
  const staubliTcp = worldToSvg(
    staubliActive ? -14.88 : -15.16 + 0.25 * Math.cos(((staubliJoints[0] || 20) * Math.PI) / 180),
    staubliActive ? -5.86 : -5.68
  );

  const interactiveProps = (id: EquipmentId, label: string) => ({
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': label,
    className: `synoptic-target ${selectedId === id ? 'is-selected' : ''}`,
    onClick: () => onSelectEquipment(id),
    onKeyDown: (e: React.KeyboardEvent) => handleSvgKeyDown(e, id, onSelectEquipment),
    onKeyUp: (e: React.KeyboardEvent) => handleSvgKeyUp(e, id, onSelectEquipment),
    style: { cursor: 'pointer' },
  });

  const renderSlotMarker = (slot: MontracSlotSpec, shuttlePose: ShuttleWorldPose) => {
    const pos = worldToSvg(slot.wx, slot.wy);
    const isOccupied = Math.hypot(shuttlePose.x - slot.wx, shuttlePose.y - slot.wy) <= 0.16;
    const isSouth = slot.segment === 'A34E';
    const shortTag = slot.detector.slice(0, 4); // DZI1, DZI2, DZI3, DZI4

    return (
      <g key={slot.detector}>
        <rect
          x={pos.x - 5.5}
          y={pos.y - 5.5}
          width={11}
          height={11}
          rx={1.5}
          fill={slot.fiducialColor}
          stroke={isOccupied ? '#facc15' : '#0b0d10'}
          strokeWidth={isOccupied ? 2 : 1.2}
        />
        <circle cx={pos.x} cy={pos.y} r={2} fill="#ffffff" />
        <text
          x={pos.x}
          y={pos.y + (isSouth ? 16 : -10)}
          textAnchor="middle"
          fontSize={8}
          fontWeight={700}
          fontFamily="var(--font-mono)"
          fill={pal.slotText}
        >
          {shortTag}
        </text>
      </g>
    );
  };

  const renderSwitchMarker = (sw: MontracSwitchSpec) => {
    const pos = worldToSvg(sw.wx, sw.wy);
    const isYellow = sw.kind === 'active_3pos';
    const sz = isYellow ? 6.8 : 5.4;

    return (
      <rect
        key={sw.id}
        x={pos.x - sz / 2}
        y={pos.y - sz / 2}
        width={sz}
        height={sz}
        rx={1}
        fill={isYellow ? '#eab308' : '#475569'}
        stroke="#0f1115"
        strokeWidth={1}
      />
    );
  };

  const renderCadMontracNetwork = (
    side: 'left' | 'right',
    id: 'montrac_a' | 'montrac_b',
    rail: CellSnapshot['montracA'],
    segments: Record<string, WorldPt[]>,
    slots: ReadonlyArray<MontracSlotSpec>,
    switches: ReadonlyArray<MontracSwitchSpec>,
    shuttlePose: ShuttleWorldPose
  ) => {
    const chassisRect = cadBoxToSvgRect(MONTRAC_CHASSIS_CAD[side]);
    const shSvg = worldToSvg(shuttlePose.x, shuttlePose.y);
    const shRot = worldYawToSvgDeg(shuttlePose.yaw);
    const isSelected = selectedId === id;

    return (
      <g {...interactiveProps(id, rail.name)}>
        <rect
          x={chassisRect.x}
          y={chassisRect.y}
          width={chassisRect.width}
          height={chassisRect.height}
          rx={2}
          fill={isSelected ? pal.selectHalo : pal.chassisFill}
          stroke={isSelected ? pal.selectAccent : pal.chassisStroke}
          strokeWidth={isSelected ? 1.8 : 0.9}
          strokeDasharray={isSelected ? undefined : '4 3'}
        />

        {INTERIOR_BYPASS_KEYS.map((segKey) => {
          const pts = segments[segKey];
          if (!pts) return null;
          const d = worldPolyline(pts);
          return (
            <g key={`in-${segKey}`}>
              <path
                d={d}
                fill="none"
                stroke={pal.railBypassCasing}
                strokeWidth={5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d={d}
                fill="none"
                stroke={pal.railBypassGroove}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          );
        })}

        {EXTERIOR_SEGMENT_KEYS.map((segKey) => {
          const pts = segments[segKey];
          if (!pts) return null;
          const d = worldPolyline(pts);
          return (
            <g key={`ex-${segKey}`}>
              <path
                d={d}
                fill="none"
                stroke={rail.status === 'fault' ? '#dc2626' : pal.railOuterCasing}
                strokeWidth={6.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d={d}
                fill="none"
                stroke={pal.railOuterGroove}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          );
        })}

        {switches.map((sw) => renderSwitchMarker(sw))}
        {slots.map((sl) => renderSlotMarker(sl, shuttlePose))}

        <g transform={`translate(${shSvg.x.toFixed(1)}, ${shSvg.y.toFixed(1)}) rotate(${shRot.toFixed(1)})`}>
          <rect
            x={-11}
            y={-7.5}
            width={22}
            height={15}
            rx={2}
            fill={rail.status === 'fault' ? '#dc2626' : '#eab308'}
            stroke="#0f1115"
            strokeWidth={1.3}
          />
          <rect
            x={-6}
            y={-5}
            width={12}
            height={10}
            rx={1}
            fill="#181b20"
            stroke="#fef08a"
            strokeWidth={1.1}
          />
        </g>
      </g>
    );
  };

  const renderYaskawaCell = (
    zone: 'A' | 'B',
    arm: CellSnapshot['yaskawaA'],
    kin: { tcpX: number; tcpY: number; elbowX: number; elbowY: number }
  ) => {
    const isA = zone === 'A';
    const baseW = isA ? { x: -10.44, y: -3.0 } : { x: -15.16, y: -3.0 };
    const handoffW = isA ? { x: -11.08, y: -2.98 } : { x: -14.54, y: -3.18 };
    const fixtureW = isA ? { x: -10.18, y: -3.0 } : { x: -15.42, y: -3.0 };
    const tblRect = cadBoxToSvgRect(isA ? ROBOT_TABLES_CAD.yaskawa_a : ROBOT_TABLES_CAD.yaskawa_b);

    const baseSvg = worldToSvg(baseW.x, baseW.y);
    const elbowSvg = worldToSvg(kin.elbowX, kin.elbowY);
    const tcpSvg = worldToSvg(kin.tcpX, kin.tcpY);
    const handoffSvg = worldToSvg(handoffW.x, handoffW.y);
    const fixtureSvg = worldToSvg(fixtureW.x, fixtureW.y);
    const isSelected = selectedId === arm.id;
    const stroke = statusStroke(arm.status);

    return (
      <g {...interactiveProps(arm.id, isA ? 'Poste A' : 'Poste B')}>
        <rect
          x={tblRect.x}
          y={tblRect.y}
          width={tblRect.width}
          height={tblRect.height}
          rx={2}
          fill={pal.tableFill}
          stroke={isSelected ? pal.selectAccent : pal.tableStroke}
          strokeWidth={isSelected ? 2 : 1.3}
        />

        <rect
          x={fixtureSvg.x - 9}
          y={fixtureSvg.y - 7.5}
          width={18}
          height={15}
          rx={1.5}
          fill={pal.fixtureFill}
          stroke={pal.tableStroke}
          strokeDasharray="3 2"
        />

        <rect
          x={handoffSvg.x - 7.5}
          y={handoffSvg.y - 7.5}
          width={15}
          height={15}
          rx={2}
          fill={pal.bayFill}
          stroke={pal.bayStroke}
          strokeWidth={1.3}
          strokeDasharray="3 2"
        />

        <circle cx={baseSvg.x} cy={baseSvg.y} r={13} fill={pal.fixtureFill} stroke={stroke} strokeWidth={2.2} />
        <circle cx={baseSvg.x} cy={baseSvg.y} r={4.8} fill={pal.selectAccent} />

        <line
          x1={baseSvg.x}
          y1={baseSvg.y}
          x2={elbowSvg.x}
          y2={elbowSvg.y}
          stroke={pal.armLinkOuter}
          strokeWidth={6.2}
          strokeLinecap="round"
        />
        <line
          x1={baseSvg.x}
          y1={baseSvg.y}
          x2={elbowSvg.x}
          y2={elbowSvg.y}
          stroke={pal.armLinkInner}
          strokeWidth={1.9}
          strokeLinecap="round"
        />
        <line
          x1={elbowSvg.x}
          y1={elbowSvg.y}
          x2={tcpSvg.x}
          y2={tcpSvg.y}
          stroke={pal.armLinkOuter}
          strokeWidth={4.8}
          strokeLinecap="round"
        />
        <line
          x1={elbowSvg.x}
          y1={elbowSvg.y}
          x2={tcpSvg.x}
          y2={tcpSvg.y}
          stroke={pal.armLinkInner}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
        <circle cx={elbowSvg.x} cy={elbowSvg.y} r={3.8} fill={pal.selectAccent} stroke="#0f1115" strokeWidth={1} />
        <circle
          cx={tcpSvg.x}
          cy={tcpSvg.y}
          r={4.2}
          fill={arm.gripperState === 'holding' ? '#16a34a' : '#94a3b8'}
          stroke="#0f1115"
          strokeWidth={1}
        />

        <text
          x={tblRect.x + tblRect.width / 2}
          y={tblRect.y + tblRect.height - 7}
          textAnchor="middle"
          fontSize={10}
          fontWeight={700}
          fill={isSelected ? pal.selectAccent : pal.labelPrimary}
        >
          {isA ? 'Poste A' : 'Poste B'}
        </text>
      </g>
    );
  };

  const eastWallX = worldToSvg(-7.46, -3.5).x;
  const westWallX = worldToSvg(-17.98, -3.5).x;
  const southWallY = worldToSvg(-12.8, -6.65).y;
  const northFloorY = worldToSvg(-12.8, 0.05).y;

  const kukaTableRect = cadBoxToSvgRect(ROBOT_TABLES_CAD.kuka_a);
  const staubliTableRect = cadBoxToSvgRect(ROBOT_TABLES_CAD.staubli_b);
  const stockTableRect = cadBoxToSvgRect(ROBOT_TABLES_CAD.stock);
  const expedTableRect = cadBoxToSvgRect(ROBOT_TABLES_CAD.expedition);

  const kukaPos = worldToSvg(-10.64, -6.0);
  const staubliFixturePos = worldToSvg(-14.85, -5.9);
  const camAPos = worldToSvg(-9.42, -3.0);
  const camBPos = worldToSvg(-16.08, -3.0);
  const stockCenter = worldToSvg(-9.0, -0.8);
  const expedCenter = worldToSvg(-16.6, -0.8);
  const collabNW = worldToSvg(-9.75, -2.18);
  const collabSE = worldToSvg(-15.85, -0.52);

  const routeSpine = worldPolyline([
    [-9.0, -1.6],
    [-10.45, -1.55],
    [-12.8, -1.55],
    [-15.05, -1.55],
    [-16.6, -1.6],
  ]);
  const routeBayEntry = worldPolyline([
    [-12.8, -1.55],
    [-12.8, -3.05],
  ]);
  const routeBayDocks = worldPolyline([
    [-11.08, -2.98],
    [-11.66, -2.98],
    [-12.8, -3.05],
    [-13.96, -3.18],
    [-14.54, -3.18],
  ]);
  const bayCenterSvg = worldToSvg(-12.8, -3.05);
  const dockASvg = worldToSvg(-11.66, -2.98);
  const dockBSvg = worldToSvg(-13.96, -3.18);

  return (
    <svg
      className="synoptic-svg"
      viewBox="46 28 806 518"
      role="img"
      aria-labelledby="room315-svg-title room315-svg-desc"
    >
      <title id="room315-svg-title">Plan de la cellule Salle 315</title>
      <desc id="room315-svg-desc">
        Vue métrique 1:1 avec KUKA, Stäubli, réseaux Montrac A et B (DZI1 à DZI4), Poste A, Poste B, TIAGo, Stock et
        Expédition.
      </desc>

      <defs>
        <pattern
          id="room315-grid-1m"
          width={PX_PER_M}
          height={PX_PER_M}
          patternUnits="userSpaceOnUse"
          x={OFFSET_X}
          y={OFFSET_Y}
        >
          <path d={`M ${PX_PER_M} 0 L 0 0 0 ${PX_PER_M}`} fill="none" stroke={pal.gridStroke} strokeWidth="0.8" />
        </pattern>
      </defs>

      <rect
        x={eastWallX}
        y={southWallY}
        width={westWallX - eastWallX}
        height={northFloorY - southWallY}
        rx={2}
        fill={pal.floorBg}
      />
      <rect
        x={eastWallX}
        y={southWallY}
        width={westWallX - eastWallX}
        height={northFloorY - southWallY}
        rx={2}
        fill="url(#room315-grid-1m)"
        stroke={snapshot.safety.status === 'estop_triggered' ? '#dc2626' : pal.floorBorder}
        strokeWidth={snapshot.safety.status === 'estop_triggered' ? 2 : 1.3}
      />

      {/* Zone collaborative Nord (contour discret) */}
      <rect
        x={collabNW.x}
        y={collabNW.y}
        width={collabSE.x - collabNW.x}
        height={collabSE.y - collabNW.y}
        rx={2}
        fill={humanInZone ? pal.collabActiveFill : pal.collabFill}
        stroke={pal.collabStroke}
        strokeWidth={humanInZone ? 1.5 : 1}
        strokeDasharray="6 4"
      />

      {/* Cloisons architecturales double-trait carter_gauche & carter_droit */}
      <g aria-label="Cloisons de protection">
        <path
          d={worldPolyline(CARTER_GAUCHE_WORLD)}
          fill="none"
          stroke={pal.carterOuter}
          strokeWidth={4.5}
          strokeLinejoin="miter"
          strokeLinecap="square"
        />
        <path
          d={worldPolyline(CARTER_GAUCHE_WORLD)}
          fill="none"
          stroke={pal.carterInner}
          strokeWidth={1.3}
          strokeLinejoin="miter"
          strokeLinecap="square"
        />

        <path
          d={worldPolyline(CARTER_DROIT_WORLD)}
          fill="none"
          stroke={pal.carterOuter}
          strokeWidth={4.5}
          strokeLinejoin="miter"
          strokeLinecap="square"
        />
        <path
          d={worldPolyline(CARTER_DROIT_WORLD)}
          fill="none"
          stroke={pal.carterInner}
          strokeWidth={1.3}
          strokeLinejoin="miter"
          strokeLinecap="square"
        />
      </g>

      {/* KUKA */}
      <g {...interactiveProps('kuka_a', 'KUKA')}>
        <rect
          x={kukaTableRect.x}
          y={kukaTableRect.y}
          width={kukaTableRect.width}
          height={kukaTableRect.height}
          rx={2}
          fill={pal.tableFill}
          stroke={selectedId === 'kuka_a' ? pal.selectAccent : pal.tableStroke}
          strokeWidth={selectedId === 'kuka_a' ? 2 : 1.2}
        />
        <circle cx={kukaPos.x} cy={kukaPos.y} r={9.5} fill="#c26a27" stroke="#0f1115" strokeWidth={1.3} />
        <line
          x1={kukaPos.x}
          y1={kukaPos.y}
          x2={kukaPos.x - 18}
          y2={kukaPos.y + 11}
          stroke="#ea8c42"
          strokeWidth={4}
          strokeLinecap="round"
        />
        <text
          x={236}
          y={kukaPos.y + 4}
          textAnchor="end"
          fontSize={10.5}
          fontWeight={700}
          fill={selectedId === 'kuka_a' ? pal.selectAccent : pal.labelPrimary}
        >
          KUKA
        </text>
      </g>

      {/* Stäubli */}
      <g {...interactiveProps('staubli_b', 'Stäubli')}>
        <rect
          x={staubliTableRect.x}
          y={staubliTableRect.y}
          width={staubliTableRect.width}
          height={staubliTableRect.height}
          rx={2}
          fill={pal.tableFill}
          stroke={
            snapshot.staubliB.status === 'active'
              ? '#eab308'
              : selectedId === 'staubli_b'
                ? pal.selectAccent
                : pal.tableStroke
          }
          strokeWidth={selectedId === 'staubli_b' ? 2 : 1.3}
        />
        <rect
          x={staubliFixturePos.x - 7}
          y={staubliFixturePos.y - 6}
          width={14}
          height={12}
          rx={1.5}
          fill={pal.fixtureFill}
          stroke={pal.tableStroke}
          strokeDasharray="2 2"
        />
        <circle cx={staubliBase.x} cy={staubliBase.y} r={9.5} fill="#d99b26" stroke="#0f1115" strokeWidth={1.3} />
        <line
          x1={staubliBase.x}
          y1={staubliBase.y}
          x2={staubliTcp.x}
          y2={staubliTcp.y}
          stroke="#facc15"
          strokeWidth={4}
          strokeLinecap="round"
        />
        <circle cx={staubliTcp.x} cy={staubliTcp.y} r={3.5} fill="#eab308" stroke="#0f1115" strokeWidth={1} />
        <text
          x={674}
          y={staubliBase.y + 4}
          textAnchor="start"
          fontSize={10.5}
          fontWeight={700}
          fill={selectedId === 'staubli_b' ? pal.selectAccent : pal.labelPrimary}
        >
          Stäubli
        </text>
      </g>

      {/* Réseaux CAO Montrac A & B (14 segments + aiguillages + DZI1..DZI4) */}
      {renderCadMontracNetwork(
        'left',
        'montrac_a',
        snapshot.montracA,
        MONTRAC_LEFT_SEGMENTS,
        MONTRAC_LEFT_SLOTS,
        MONTRAC_LEFT_SWITCHES,
        shuttleLeft
      )}
      {renderCadMontracNetwork(
        'right',
        'montrac_b',
        snapshot.montracB,
        MONTRAC_RIGHT_SEGMENTS,
        MONTRAC_RIGHT_SLOTS,
        MONTRAC_RIGHT_SWITCHES,
        shuttleRight
      )}

      {/* Poste A & Poste B */}
      {renderYaskawaCell('A', snapshot.yaskawaA, armA)}
      {renderYaskawaCell('B', snapshot.yaskawaB, armB)}

      {/* Caméras ZED 2 (icônes discrètes sans texte) */}
      <g {...interactiveProps('camera_a', 'Caméra ZED 2 Poste A')}>
        <polygon
          points={`${camAPos.x + 11},${camAPos.y} ${camAPos.x + 48},${camAPos.y - 20} ${camAPos.x + 48},${camAPos.y + 20}`}
          fill={pal.selectHalo}
          stroke={selectedId === 'camera_a' ? pal.selectAccent : pal.tableStroke}
          strokeDasharray="3 2"
        />
        <rect
          x={camAPos.x - 10}
          y={camAPos.y - 6}
          width={20}
          height={12}
          rx={1.5}
          fill={selectedId === 'camera_a' ? pal.selectAccent : pal.tableFill}
          stroke={pal.carterInner}
          strokeWidth={1}
        />
      </g>

      <g {...interactiveProps('camera_b', 'Caméra ZED 2 Poste B')}>
        <polygon
          points={`${camBPos.x - 11},${camBPos.y} ${camBPos.x - 48},${camBPos.y - 20} ${camBPos.x - 48},${camBPos.y + 20}`}
          fill={pal.bayFill}
          stroke={selectedId === 'camera_b' ? pal.selectAccent : pal.bayStroke}
          strokeDasharray="3 2"
        />
        <rect
          x={camBPos.x - 10}
          y={camBPos.y - 6}
          width={20}
          height={12}
          rx={1.5}
          fill={selectedId === 'camera_b' ? pal.selectAccent : pal.tableFill}
          stroke={pal.carterInner}
          strokeWidth={1}
        />
      </g>

      {/* Stock */}
      <g aria-label="Stock">
        <rect
          x={stockTableRect.x}
          y={stockTableRect.y}
          width={stockTableRect.width}
          height={stockTableRect.height}
          rx={2}
          fill={pal.tableFill}
          stroke="#2563eb"
          strokeWidth={1.6}
        />
        <text
          x={stockCenter.x}
          y={stockTableRect.y + stockTableRect.height + 14}
          textAnchor="middle"
          fontSize={10.5}
          fontWeight={700}
          fill={pal.labelPrimary}
        >
          Stock
        </text>
      </g>

      {/* Expédition */}
      <g aria-label="Expédition">
        <rect
          x={expedTableRect.x}
          y={expedTableRect.y}
          width={expedTableRect.width}
          height={expedTableRect.height}
          rx={2}
          fill={pal.tableFill}
          stroke="#16a34a"
          strokeWidth={1.6}
        />
        <text
          x={expedCenter.x}
          y={expedTableRect.y + expedTableRect.height + 14}
          textAnchor="middle"
          fontSize={10.5}
          fontWeight={700}
          fill={pal.labelPrimary}
        >
          Expédition
        </text>
      </g>

      {/* Trajectoire TIAGo */}
      <g aria-label="Trajectoire TIAGo">
        <path
          d={routeSpine}
          fill="none"
          stroke={pal.selectAccent}
          strokeOpacity={0.42}
          strokeWidth={1.5}
          strokeDasharray="6 4"
        />
        <path
          d={routeBayEntry}
          fill="none"
          stroke={pal.bayStroke}
          strokeWidth={1.6}
          strokeDasharray="5 4"
        />
        <path
          d={routeBayDocks}
          fill="none"
          stroke={snapshot.partLocation === 'tiago' ? pal.selectAccent : pal.bayStroke}
          strokeWidth={snapshot.partLocation === 'tiago' ? 2.2 : 1.6}
          strokeDasharray="6 4"
        />
        <circle cx={dockASvg.x} cy={dockASvg.y} r={3.2} fill="#2fb36d" />
        <circle cx={bayCenterSvg.x} cy={bayCenterSvg.y} r={3.6} fill={pal.floorBg} stroke="#2fb36d" strokeWidth={1.4} />
        <circle cx={dockBSvg.x} cy={dockBSvg.y} r={3.2} fill="#2fb36d" />
      </g>

      {/* Pièces en cours et expédiées */}
      <g aria-label="Pièces">
        {allWorkpieces.map((wp, idx) => {
          const px = Number(wp.pose?.x ?? NaN);
          const py = Number(wp.pose?.y ?? NaN);
          const pz = Number(wp.pose?.z ?? 0.7);
          if (!Number.isFinite(px) || !Number.isFinite(py) || pz < -0.5) return null;
          const holderLow = String(wp.holder ?? '').toLowerCase();
          if (snapshot.tiago.carryingPart && (holderLow === 'tiago1' || holderLow === 'tiago')) {
            return null;
          }
          const pos = worldToSvg(px, py);
          const rot = worldYawToSvgDeg(Number(wp.pose?.yaw ?? 0));
          const st = workpieceVisualStyle(wp);

          return (
            <g key={`wp-${idx}`} transform={`translate(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})`}>
              {st.kind === 'nok' && (
                <circle r={11} fill="none" stroke="#dc2626" strokeWidth={1.4} strokeDasharray="3 2" />
              )}
              <g transform={`rotate(${rot.toFixed(1)})`}>
                <rect
                  x={-6}
                  y={-4.8}
                  width={12}
                  height={9.6}
                  rx={1.5}
                  fill={st.fill}
                  stroke={st.stroke}
                  strokeWidth={1.3}
                />
                <line x1={-3} y1={0} x2={3} y2={0} stroke="#0b0d10" strokeWidth={1.2} />
              </g>
            </g>
          );
        })}
      </g>

      {/* Opérateur affiché UNIQUEMENT lorsqu'il est réellement en zone collaborative */}
      {humanInZone && (
        <g
          transform={`translate(${humanSvg.x.toFixed(1)}, ${humanSvg.y.toFixed(1)})`}
          aria-label="Opérateur en zone collaborative"
        >
          <circle
            r={2.2 * PX_PER_M}
            fill="rgba(224, 168, 46, 0.06)"
            stroke="#eab308"
            strokeWidth={1.2}
            strokeDasharray="5 4"
          />
          <circle
            r={1.1 * PX_PER_M}
            fill="rgba(220, 38, 38, 0.08)"
            stroke="#dc2626"
            strokeWidth={1.4}
            strokeDasharray="4 3"
          />
          <circle r={9.5} fill="#eab308" stroke="#141517" strokeWidth={1.5} />
        </g>
      )}

      {/* TIAGo */}
      <g
        {...interactiveProps('tiago', 'TIAGo')}
        transform={`translate(${tiagoSvg.x.toFixed(1)}, ${tiagoSvg.y.toFixed(1)})`}
      >
        {(humanInZone || speedScale < 0.99) && (
          <circle
            cx={0}
            cy={0}
            r={25}
            fill="rgba(234, 179, 8, 0.12)"
            stroke="#eab308"
            strokeWidth={1.4}
            strokeDasharray="4 3"
          />
        )}

        <g transform={`rotate(${tiagoHeadingDeg.toFixed(1)})`}>
          <rect x={-7} y={-19} width={14} height={3.8} rx={1} fill="#141517" stroke="#94a3b8" strokeWidth={0.9} />
          <rect x={-7} y={15.2} width={14} height={3.8} rx={1} fill="#141517" stroke="#94a3b8" strokeWidth={0.9} />

          <circle
            cx={0}
            cy={0}
            r={17.5}
            fill="#1e242d"
            stroke={statusStroke(snapshot.tiago.status)}
            strokeWidth={selectedId === 'tiago' ? 2.6 : 2}
          />
          <path d="M -12.5 -9 A 14.5 14.5 0 0 1 8 -11 L 8 11 A 14.5 14.5 0 0 1 -12.5 9 Z" fill="#cbd5e1" opacity={0.92} />

          <path d="M 10.5 -9 A 13.5 13.5 0 0 1 10.5 9" fill="none" stroke="#38bdf8" strokeWidth={2.1} strokeLinecap="round" />
          <polygon points="21,0 14.5,-3.5 14.5,3.5" fill="#38bdf8" />

          <rect x={-9} y={-6} width={10} height={12} rx={1.5} fill="#334155" stroke="#0f172a" strokeWidth={1} />
          <rect x={-4} y={-4} width={5} height={8} rx={1} fill={pal.selectAccent} />

          <polyline
            points={tiagoArmExtended ? '-1,5 14,9 33,0' : '-1,5 8,8 15,2'}
            fill="none"
            stroke="#f8fafc"
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <polyline
            points={tiagoArmExtended ? '-1,5 14,9 33,0' : '-1,5 8,8 15,2'}
            fill="none"
            stroke="#ea580c"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {(() => {
            const gx = tiagoArmExtended ? 33 : 15;
            const jawY = snapshot.tiago.carryingPart ? 4.2 : 5.6;
            const heldStyle = activeWp ? workpieceVisualStyle(activeWp) : { fill: '#0284c7', stroke: '#bae6fd' };
            return (
              <g>
                <line x1={gx} y1={-jawY} x2={gx} y2={jawY} stroke="#e2e8f0" strokeWidth={1.8} />
                <line x1={gx} y1={-jawY} x2={gx + 7.5} y2={-jawY} stroke="#e2e8f0" strokeWidth={1.6} strokeLinecap="round" />
                <line x1={gx} y1={jawY} x2={gx + 7.5} y2={jawY} stroke="#e2e8f0" strokeWidth={1.6} strokeLinecap="round" />
                {snapshot.tiago.carryingPart && (
                  <rect
                    x={gx + 1.5}
                    y={-4}
                    width={8.5}
                    height={8}
                    rx={1}
                    fill={heldStyle.fill}
                    stroke={heldStyle.stroke}
                    strokeWidth={1.2}
                  />
                )}
              </g>
            );
          })()}
        </g>

        <rect
          x={-26}
          y={21}
          width={52}
          height={14}
          rx={1.5}
          fill={pal.tiagoTagBg}
          stroke={pal.tiagoTagBorder}
          strokeWidth={0.9}
        />
        <text
          x={0}
          y={31}
          textAnchor="middle"
          fontSize={9.5}
          fontWeight={700}
          fill={pal.labelPrimary}
        >
          TIAGo
        </text>
      </g>
    </svg>
  );
};
