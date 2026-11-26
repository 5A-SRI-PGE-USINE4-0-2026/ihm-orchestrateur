import type { ShuttleWorldPose } from '../types/cell';

export type WorldPt = [number, number];

export interface MontracSlotSpec {
  id: 'slot_1' | 'slot_2' | 'slot_3' | 'slot_4';
  detector: string;
  shortLabel: string;
  subLabel?: string;
  fiducialColor: string;
  segment: 'A12E' | 'A34E';
  wx: number;
  wy: number;
  yaw: number;
  progressAnchor: number;
}

export interface MontracSwitchSpec {
  id: string;
  code: string;
  kind: 'active_3pos' | 'static_nose';
  wx: number;
  wy: number;
  yaw: number;
}

export interface CadBoxFootprint {
  id: string;
  label: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  topZ: number;
}

/**
 * Segments exacts extraits de `mfja_3rd_floor_gz` (`CELL_PATH_LEFT.STL` & `rail_network_left.yaml`).
 * Emprise rail : X = [-11.8650, -9.7072] (2.158 m), Y = [-5.5600, -3.8399] (1.720 m).
 */
export const MONTRAC_LEFT_SEGMENTS: Record<string, WorldPt[]> = {
  A14: [
    [-9.7534, -4.8734],
    [-9.744, -4.8556],
    [-9.7303, -4.8153],
    [-9.7223, -4.7488],
    [-9.7228, -4.6131],
    [-9.7325, -4.5705],
    [-9.7495, -4.5334],
  ],
  A1E: [
    [-9.7495, -4.5334],
    [-9.7699, -4.4818],
    [-9.7761, -4.4533],
    [-9.7783, -4.4216],
    [-9.7691, -4.3655],
    [-9.7482, -4.314],
  ],
  A1I: [
    [-9.7495, -4.5334],
    [-9.7787, -4.4933],
    [-9.825, -4.4554],
    [-9.8499, -4.4421],
    [-9.8886, -4.4288],
    [-9.9414, -4.4223],
  ],
  A12E: [
    [-9.7482, -4.314],
    [-9.7351, -4.2878],
    [-9.7259, -4.2581],
    [-9.7189, -4.1937],
    [-9.7182, -4.063],
    [-9.7229, -4.0312],
    [-9.7323, -4.0018],
    [-9.7459, -3.9763],
    [-9.7787, -3.9333],
    [-9.8181, -3.8999],
    [-9.8577, -3.8785],
    [-9.9228, -3.866],
    [-11.0407, -3.8639],
    [-11.0655, -3.8645],
    [-11.1062, -3.8713],
    [-11.149, -3.8855],
    [-11.2103, -3.9212],
    [-11.2467, -3.9577],
    [-11.2617, -3.9815],
    [-11.2739, -4.0087],
    [-11.2819, -4.0391],
    [-11.2876, -4.1039],
    [-11.2893, -4.202],
  ],
  A12I: [
    [-9.9403, -4.4233],
    [-11.0507, -4.4227],
    [-11.1158, -4.416],
    [-11.1583, -4.4025],
    [-11.1785, -4.3905],
  ],
  A2E: [
    [-11.2893, -4.202],
    [-11.3007, -4.2669],
    [-11.3182, -4.3099],
    [-11.3516, -4.355],
    [-11.3709, -4.3726],
    [-11.4016, -4.3938],
  ],
  A2I: [
    [-11.1785, -4.3905],
    [-11.2334, -4.3687],
    [-11.2902, -4.3623],
    [-11.3468, -4.3703],
    [-11.4016, -4.3938],
  ],
  A23: [
    [-11.4016, -4.3938],
    [-11.4433, -4.412],
    [-11.4862, -4.4213],
    [-11.6164, -4.4214],
    [-11.6598, -4.4254],
    [-11.7025, -4.4371],
    [-11.7233, -4.4461],
    [-11.7632, -4.4718],
    [-11.8004, -4.5054],
    [-11.8184, -4.5277],
    [-11.844, -4.5767],
    [-11.8518, -4.6069],
    [-11.8545, -4.7363],
    [-11.85, -4.8041],
    [-11.8318, -4.8583],
    [-11.8011, -4.9037],
    [-11.7831, -4.9217],
    [-11.7446, -4.951],
    [-11.682, -4.977],
    [-11.6387, -4.9816],
    [-11.4868, -4.9841],
    [-11.444, -4.994],
    [-11.4023, -5.012],
  ],
  A3E: [
    [-11.4023, -5.012],
    [-11.3719, -5.033],
    [-11.3523, -5.0513],
    [-11.32, -5.0953],
    [-11.3072, -5.1226],
    [-11.2981, -5.153],
    [-11.2924, -5.2023],
  ],
  A3I: [
    [-11.4023, -5.012],
    [-11.3755, -5.0256],
    [-11.3478, -5.0347],
    [-11.2913, -5.0428],
    [-11.2348, -5.0359],
    [-11.1799, -5.0139],
  ],
  A34E: [
    [-11.2924, -5.2023],
    [-11.2914, -5.333],
    [-11.2878, -5.3652],
    [-11.28, -5.3957],
    [-11.2679, -5.4239],
    [-11.237, -5.4686],
    [-11.2186, -5.4861],
    [-11.1789, -5.5137],
    [-11.137, -5.5323],
    [-11.0717, -5.542],
    [-9.9534, -5.5437],
    [-9.8879, -5.5347],
    [-9.8451, -5.521],
    [-9.7866, -5.4759],
    [-9.7539, -5.4324],
    [-9.7407, -5.4054],
    [-9.7313, -5.3766],
    [-9.7265, -5.3448],
    [-9.7248, -5.214],
    [-9.7332, -5.1501],
    [-9.7428, -5.1195],
    [-9.7566, -5.0963],
  ],
  A34I: [
    [-11.1799, -5.0139],
    [-11.1158, -4.9897],
    [-11.0497, -4.9837],
    [-9.9466, -4.9843],
  ],
  A4E: [
    [-9.7566, -5.0963],
    [-9.7771, -5.0436],
    [-9.7857, -4.9841],
    [-9.7825, -4.9539],
    [-9.7753, -4.9249],
    [-9.7534, -4.8734],
  ],
  A4I: [
    [-9.9466, -4.9843],
    [-9.9068, -4.9807],
    [-9.8805, -4.9745],
    [-9.8297, -4.9511],
    [-9.8056, -4.9344],
    [-9.7831, -4.9131],
    [-9.7534, -4.8734],
  ],
};

/**
 * Segments exacts extraits de `mfja_3rd_floor_gz` (`CELL_PATH_RIGHT.STL` & `rail_network_right.yaml`).
 * Emprise rail : X = [-15.8649, -13.7063] (2.159 m), Y = [-5.5617, -3.8399] (1.722 m).
 */
export const MONTRAC_RIGHT_SEGMENTS: Record<string, WorldPt[]> = {
  A14: [
    [-14.1748, -5.0067],
    [-14.1323, -4.9885],
    [-14.0885, -4.9792],
    [-13.9557, -4.9791],
    [-13.9115, -4.9752],
    [-13.8467, -4.9545],
    [-13.806, -4.9287],
    [-13.7681, -4.8951],
    [-13.7497, -4.8728],
    [-13.7235, -4.8238],
    [-13.7156, -4.7935],
    [-13.7128, -4.664],
    [-13.7173, -4.5961],
    [-13.7359, -4.5418],
    [-13.7671, -4.4964],
    [-13.7854, -4.4783],
    [-13.8247, -4.4489],
    [-13.8886, -4.4229],
    [-13.9327, -4.4183],
    [-14.0876, -4.4157],
    [-14.1312, -4.4057],
    [-14.1737, -4.3877],
  ],
  A1E: [
    [-14.1737, -4.3877],
    [-14.1946, -4.3744],
    [-14.2247, -4.3483],
    [-14.2576, -4.3042],
    [-14.2706, -4.2769],
    [-14.2798, -4.2464],
    [-14.2857, -4.1971],
  ],
  A1I: [
    [-14.1737, -4.3877],
    [-14.201, -4.3741],
    [-14.2293, -4.3649],
    [-14.2868, -4.3568],
    [-14.3445, -4.3637],
    [-14.4004, -4.3856],
  ],
  A12E: [
    [-14.2857, -4.1971],
    [-14.285, -4.0988],
    [-14.2902, -4.0339],
    [-14.2982, -4.0034],
    [-14.3105, -3.9751],
    [-14.3419, -3.9304],
    [-14.3607, -3.9129],
    [-14.4011, -3.8852],
    [-14.4438, -3.8666],
    [-14.5105, -3.8568],
    [-15.6508, -3.8545],
    [-15.7176, -3.8634],
    [-15.7613, -3.8772],
    [-15.8018, -3.9053],
    [-15.8209, -3.9223],
    [-15.8543, -3.9658],
    [-15.8678, -3.9929],
    [-15.8774, -4.0217],
    [-15.8823, -4.0536],
    [-15.8841, -4.1845],
    [-15.8756, -4.2485],
    [-15.8659, -4.2792],
    [-15.8517, -4.3024],
  ],
  A12I: [
    [-14.4004, -4.3856],
    [-14.4659, -4.4099],
    [-14.5332, -4.4158],
    [-15.6581, -4.4146],
  ],
  A2E: [
    [-15.8517, -4.3024],
    [-15.831, -4.3552],
    [-15.8222, -4.4147],
    [-15.8286, -4.4596],
    [-15.8552, -4.5255],
  ],
  A2I: [
    [-15.6581, -4.4146],
    [-15.6987, -4.4182],
    [-15.7255, -4.4243],
    [-15.7773, -4.4478],
    [-15.8137, -4.4746],
    [-15.8367, -4.4989],
    [-15.8552, -4.5255],
  ],
  A23: [
    [-15.8552, -4.5255],
    [-15.8648, -4.5433],
    [-15.8788, -4.5837],
    [-15.8869, -4.6503],
    [-15.8865, -4.7862],
    [-15.8767, -4.8288],
    [-15.8593, -4.866],
  ],
  A3E: [
    [-15.8593, -4.866],
    [-15.8386, -4.9176],
    [-15.8324, -4.9462],
    [-15.8301, -4.978],
    [-15.8395, -5.0341],
    [-15.8608, -5.0856],
  ],
  A3I: [
    [-15.8593, -4.866],
    [-15.8297, -4.9062],
    [-15.7825, -4.9441],
    [-15.7309, -4.9671],
    [-15.7043, -4.9738],
    [-15.6638, -4.9773],
  ],
  A34E: [
    [-15.8608, -5.0856],
    [-15.8742, -5.1119],
    [-15.8836, -5.1416],
    [-15.8908, -5.2061],
    [-15.8916, -5.337],
    [-15.8868, -5.3688],
    [-15.8773, -5.3983],
    [-15.8634, -5.4238],
    [-15.83, -5.4669],
    [-15.7898, -5.5003],
    [-15.7495, -5.5218],
    [-15.6831, -5.5343],
    [-14.5432, -5.5371],
    [-14.5178, -5.5365],
    [-14.4764, -5.5296],
    [-14.4327, -5.5155],
    [-14.3702, -5.4798],
    [-14.3331, -5.4433],
    [-14.3177, -5.4194],
    [-14.3053, -5.3922],
    [-14.2971, -5.3618],
    [-14.2913, -5.2968],
    [-14.2894, -5.1987],
  ],
  A34I: [
    [-15.6649, -4.9763],
    [-14.5326, -4.9775],
    [-14.4662, -4.9843],
    [-14.4229, -4.9978],
    [-14.4023, -5.0098],
  ],
  A4E: [
    [-14.2894, -5.1987],
    [-14.2778, -5.1337],
    [-14.2599, -5.0906],
    [-14.2258, -5.0455],
    [-14.2062, -5.0279],
    [-14.1748, -5.0067],
  ],
  A4I: [
    [-14.4023, -5.0098],
    [-14.3463, -5.0317],
    [-14.2885, -5.0382],
    [-14.2307, -5.0302],
    [-14.1748, -5.0067],
  ],
};

export const EXTERIOR_SEGMENT_KEYS = ['A14', 'A1E', 'A12E', 'A2E', 'A23', 'A3E', 'A34E', 'A4E'] as const;
export const INTERIOR_BYPASS_KEYS = ['A1I', 'A12I', 'A2I', 'A3I', 'A34I', 'A4I'] as const;

/** Les 8 emplacements d'arrêt calibrés (`montrac_routes.yaml` & `room315_visual_observation_rig`) */
export const MONTRAC_LEFT_SLOTS: ReadonlyArray<MontracSlotSpec> = [
  {
    id: 'slot_1',
    detector: 'DZI1L',
    shortLabel: 'DZI1L · Bleu',
    subLabel: 'Poste A',
    fiducialColor: '#2563eb',
    segment: 'A12E',
    wx: -10.32,
    wy: -3.8648,
    yaw: 3.1403,
    progressAnchor: 0.06,
  },
  {
    id: 'slot_2',
    detector: 'DZI2L',
    shortLabel: 'DZI2L · Vert',
    subLabel: 'Bloc A',
    fiducialColor: '#16a34a',
    segment: 'A12E',
    wx: -10.8,
    wy: -3.8644,
    yaw: 3.1407,
    progressAnchor: 0.24,
  },
  {
    id: 'slot_3',
    detector: 'DZI3L',
    shortLabel: 'DZI3L · KUKA',
    subLabel: 'KR6',
    fiducialColor: '#d97706',
    segment: 'A34E',
    wx: -10.6088,
    wy: -5.5426,
    yaw: -0.001,
    progressAnchor: 0.56,
  },
  {
    id: 'slot_4',
    detector: 'DZI4L',
    shortLabel: 'DZI4L',
    subLabel: 'Sud-Est A',
    fiducialColor: '#dc2626',
    segment: 'A34E',
    wx: -10.14,
    wy: -5.543,
    yaw: -0.0006,
    progressAnchor: 0.74,
  },
];

export const MONTRAC_RIGHT_SLOTS: ReadonlyArray<MontracSlotSpec> = [
  {
    id: 'slot_1',
    detector: 'DZI1R',
    shortLabel: 'DZI1R · Bleu',
    subLabel: 'Poste B',
    fiducialColor: '#2563eb',
    segment: 'A12E',
    wx: -14.95,
    wy: -3.856,
    yaw: 3.1399,
    progressAnchor: 0.06,
  },
  {
    id: 'slot_2',
    detector: 'DZI2R',
    shortLabel: 'DZI2R · Vert',
    subLabel: 'Bloc B',
    fiducialColor: '#16a34a',
    segment: 'A12E',
    wx: -15.43,
    wy: -3.8553,
    yaw: 3.1401,
    progressAnchor: 0.24,
  },
  {
    id: 'slot_3',
    detector: 'DZI3R',
    shortLabel: 'DZI3R · Stäubli',
    subLabel: 'TX2 Reprise',
    fiducialColor: '#d97706',
    segment: 'A34E',
    wx: -15.2338,
    wy: -5.5358,
    yaw: -0.0013,
    progressAnchor: 0.56,
  },
  {
    id: 'slot_4',
    detector: 'DZI4R',
    shortLabel: 'DZI4R',
    subLabel: 'Sud-Est B',
    fiducialColor: '#dc2626',
    segment: 'A34E',
    wx: -14.77,
    wy: -5.5364,
    yaw: -0.0014,
    progressAnchor: 0.74,
  },
];

/** Les 12 aiguillages 3 positions (`usine40_room315.world` lignes 171-242) */
export const MONTRAC_LEFT_SWITCHES: ReadonlyArray<MontracSwitchSpec> = [
  { id: 'A1_gauche_switch', code: 'A1', kind: 'active_3pos', wx: -9.822, wy: -4.42, yaw: -2.6365 },
  { id: 'A2_gauche_switch', code: 'A2', kind: 'active_3pos', wx: -11.285, wy: -4.329, yaw: -0.025 },
  { id: 'A3_gauche_switch', code: 'A3', kind: 'active_3pos', wx: -11.288, wy: -5.071, yaw: 1.04 },
  { id: 'A4_gauche_switch', code: 'A4', kind: 'active_3pos', wx: -9.822, wy: -4.982, yaw: -2.6365 },
  { id: 'static_gauche_switch_1', code: 'S1', kind: 'static_nose', wx: -11.848, wy: -4.515, yaw: 3.1332 },
  { id: 'static_gauche_switch_2', code: 'S2', kind: 'static_nose', wx: -11.849, wy: -4.885, yaw: -2.13 },
];

export const MONTRAC_RIGHT_SWITCHES: ReadonlyArray<MontracSwitchSpec> = [
  { id: 'A1_droit_switch', code: 'A1', kind: 'active_3pos', wx: -14.282, wy: -4.329, yaw: -2.1 },
  { id: 'A2_droit_switch', code: 'A2', kind: 'active_3pos', wx: -15.747, wy: -4.42, yaw: 0.5067 },
  { id: 'A3_droit_switch', code: 'A3', kind: 'active_3pos', wx: -15.747, wy: -4.98, yaw: 0.5067 },
  { id: 'A4_droit_switch', code: 'A4', kind: 'active_3pos', wx: -14.285, wy: -5.075, yaw: 3.13 },
  { id: 'static_droit_switch_1', code: 'S1', kind: 'static_nose', wx: -13.715, wy: -4.515, yaw: 1.02 },
  { id: 'static_droit_switch_2', code: 'S2', kind: 'static_nose', wx: -13.72, wy: -4.89, yaw: -0.02 },
];

/** Châssis aluminium Montrac & tables robots (empreintes STL exactes) */
export const MONTRAC_CHASSIS_CAD: Record<'left' | 'right', CadBoxFootprint> = {
  left: {
    id: 'cell_static_gauche_final',
    label: 'Châssis Montrac Bloc A',
    minX: -12.039,
    maxX: -9.6513,
    minY: -5.8188,
    maxY: -3.5978,
    topZ: 0.733,
  },
  right: {
    id: 'cell_static_droit_final',
    label: 'Châssis Montrac Bloc B',
    minX: -15.917,
    maxX: -13.5301,
    minY: -5.81,
    maxY: -3.59,
    topZ: 0.733,
  },
};

export const ROBOT_TABLES_CAD: Record<
  'yaskawa_a' | 'yaskawa_b' | 'kuka_a' | 'staubli_b' | 'stock' | 'expedition',
  CadBoxFootprint
> = {
  yaskawa_a: {
    id: 'room315_yaskawa_table_1',
    label: 'Table Poste A (HC10DT)',
    minX: -11.2989,
    maxX: -10.084,
    minY: -3.6013,
    maxY: -2.3871,
    topZ: 0.632,
  },
  yaskawa_b: {
    id: 'room315_yaskawa_table_2',
    label: 'Table Poste B (HC10)',
    minX: -15.5715,
    maxX: -14.3566,
    minY: -3.6013,
    maxY: -2.3871,
    topZ: 0.632,
  },
  kuka_a: {
    id: 'room315_kuka_table_1',
    label: 'Table KUKA KR6',
    minX: -11.2069,
    maxX: -10.0115,
    minY: -6.2433,
    maxY: -5.7566,
    topZ: 1.006,
  },
  staubli_b: {
    id: 'room315_staubli_table_1',
    label: 'Table Stäubli TX2',
    minX: -15.5685,
    maxX: -14.2431,
    minY: -6.283,
    maxY: -5.717,
    topZ: 1.003,
  },
  stock: {
    id: 'usine40_stock_table',
    label: 'Table Stock (-9.0, -0.8)',
    minX: -9.4,
    maxX: -8.6,
    minY: -1.2,
    maxY: -0.4,
    topZ: 0.72,
  },
  expedition: {
    id: 'usine40_expedition_table',
    label: 'Table Expédition (-16.6, -0.8)',
    minX: -17.0,
    maxX: -16.2,
    minY: -1.2,
    maxY: -0.4,
    topZ: 0.72,
  },
};

/** Parois de sécurité 2.425m `carter_gauche` & `carter_droit` ouvertes sur la baie centrale 3.29m */
export const CARTER_GAUCHE_WORLD: WorldPt[] = [
  [-11.71, -6.455],
  [-9.96, -6.455],
  [-9.96, -5.901],
  [-9.341, -5.901],
  [-9.341, -3.555],
  [-9.875, -3.555],
  [-9.875, -2.355],
  [-11.097, -2.355],
];

export const CARTER_DROIT_WORLD: WorldPt[] = [
  [-13.783, -6.452],
  [-15.533, -6.452],
  [-15.533, -5.896],
  [-16.15, -5.896],
  [-16.15, -3.551],
  [-15.613, -3.551],
  [-15.613, -2.352],
  [-14.39, -2.352],
];

interface LoopCache {
  pts: WorldPt[];
  cumS: number[];
  totalLen: number;
  slotS: [number, number, number, number];
}

function buildPerimeterLoop(
  segments: Record<string, WorldPt[]>,
  slots: ReadonlyArray<MontracSlotSpec>
): LoopCache {
  const orderedKeys = ['A12E', 'A2E', 'A23', 'A3E', 'A34E', 'A4E', 'A14', 'A1E'];
  const pts: WorldPt[] = [];
  for (const k of orderedKeys) {
    const seg = segments[k] ?? [];
    for (const pt of seg) {
      const prev = pts[pts.length - 1];
      if (!prev || Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) > 1e-4) {
        pts.push(pt);
      }
    }
  }
  // Ferme la boucle vers le premier point
  if (pts.length > 1) {
    pts.push([pts[0][0], pts[0][1]]);
  }

  const cumS: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const ds = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    cumS.push(cumS[i - 1] + ds);
  }
  const totalLen = cumS[cumS.length - 1] || 1;

  // Projette chaque slot DZI1..DZI4 sur l'abscisse curviligne exacte du cycle extérieur
  const projectSlotS = (wx: number, wy: number): number => {
    let bestS = 0;
    let bestD2 = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const vx = bx - ax;
      const vy = by - ay;
      const len2 = vx * vx + vy * vy;
      const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((wx - ax) * vx + (wy - ay) * vy) / len2)) : 0;
      const px = ax + t * vx;
      const py = ay + t * vy;
      const d2 = (wx - px) * (wx - px) + (wy - py) * (wy - py);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestS = cumS[i] + t * Math.sqrt(len2);
      }
    }
    return bestS;
  };

  const s1 = projectSlotS(slots[0].wx, slots[0].wy);
  const s2 = projectSlotS(slots[1].wx, slots[1].wy);
  const s3 = projectSlotS(slots[2].wx, slots[2].wy);
  const s4 = projectSlotS(slots[3].wx, slots[3].wy);

  return { pts, cumS, totalLen, slotS: [s1, s2, s3, s4] };
}

const LEFT_LOOP_CACHE = buildPerimeterLoop(MONTRAC_LEFT_SEGMENTS, MONTRAC_LEFT_SLOTS);
const RIGHT_LOOP_CACHE = buildPerimeterLoop(MONTRAC_RIGHT_SEGMENTS, MONTRAC_RIGHT_SLOTS);

function sampleAtArcS(cache: LoopCache, rawS: number): { x: number; y: number; yaw: number } {
  const s = ((rawS % cache.totalLen) + cache.totalLen) % cache.totalLen;
  let idx = 0;
  while (idx < cache.cumS.length - 2 && cache.cumS[idx + 1] < s) {
    idx++;
  }
  const s0 = cache.cumS[idx];
  const s1 = cache.cumS[idx + 1];
  const span = Math.max(1e-6, s1 - s0);
  const t = Math.max(0, Math.min(1, (s - s0) / span));
  const [ax, ay] = cache.pts[idx];
  const [bx, by] = cache.pts[idx + 1];
  return {
    x: ax + (bx - ax) * t,
    y: ay + (by - ay) * t,
    yaw: Math.atan2(by - ay, bx - ax),
  };
}

/**
 * Échantillonne la pose exacte `(wx, wy, z, yaw)` d'une navette Montrac sur le vrai tracé CAO 2.16m × 1.72m :
 *   - progress = 0.06 -> DZI1 · Bleu (`slot_1`)
 *   - progress = 0.24 -> DZI2 · Vert (`slot_2`)
 *   - progress = 0.56 -> DZI3 · KUKA/Stäubli (`slot_3`)
 *   - progress = 0.74 -> DZI4 (`slot_4`)
 */
export function sampleMontracShuttlePose(
  side: 'left' | 'right',
  progress: number,
  name: string,
  speedMps = 0
): ShuttleWorldPose {
  const cache = side === 'left' ? LEFT_LOOP_CACHE : RIGHT_LOOP_CACHE;
  const slots = side === 'left' ? MONTRAC_LEFT_SLOTS : MONTRAC_RIGHT_SLOTS;
  const [s1, s2, s3, s4] = cache.slotS;
  const p = ((progress % 1) + 1) % 1;

  // Normalise p autour de l'ancre 0.06 (slot_1)
  const pShift = p < 0.06 ? p + 1.0 : p;
  let targetS = s1;
  let segCode = slots[0].detector;

  if (Math.abs(pShift - 0.06) < 0.008) {
    return {
      name,
      x: slots[0].wx,
      y: slots[0].wy,
      z: 0.8393,
      yaw: slots[0].yaw,
      speed: speedMps,
      currentSegment: slots[0].detector,
    };
  }
  if (Math.abs(pShift - 0.24) < 0.008) {
    return {
      name,
      x: slots[1].wx,
      y: slots[1].wy,
      z: 0.8393,
      yaw: slots[1].yaw,
      speed: speedMps,
      currentSegment: slots[1].detector,
    };
  }
  if (Math.abs(pShift - 0.56) < 0.008) {
    return {
      name,
      x: slots[2].wx,
      y: slots[2].wy,
      z: 0.8393,
      yaw: slots[2].yaw,
      speed: speedMps,
      currentSegment: slots[2].detector,
    };
  }
  if (Math.abs(pShift - 0.74) < 0.008) {
    return {
      name,
      x: slots[3].wx,
      y: slots[3].wy,
      z: 0.8393,
      yaw: slots[3].yaw,
      speed: speedMps,
      currentSegment: slots[3].detector,
    };
  }

  if (pShift <= 0.24) {
    const u = (pShift - 0.06) / (0.24 - 0.06);
    targetS = s1 + (s2 - s1) * u;
    segCode = 'A12E';
  } else if (pShift <= 0.56) {
    const u = (pShift - 0.24) / (0.56 - 0.24);
    targetS = s2 + (s3 - s2) * u;
    segCode = u < 0.5 ? 'A23' : 'A34E';
  } else if (pShift <= 0.74) {
    const u = (pShift - 0.56) / (0.74 - 0.56);
    targetS = s3 + (s4 - s3) * u;
    segCode = 'A34E';
  } else {
    const u = (pShift - 0.74) / (1.06 - 0.74);
    const wrapSpan = cache.totalLen - s4 + s1;
    targetS = s4 + wrapSpan * u;
    segCode = u < 0.5 ? 'A14' : 'A12E';
  }

  const sampled = sampleAtArcS(cache, targetS);
  return {
    name,
    x: Number(sampled.x.toFixed(4)),
    y: Number(sampled.y.toFixed(4)),
    z: 0.8393,
    yaw: Number(sampled.yaw.toFixed(4)),
    speed: speedMps,
    currentSegment: segCode,
  };
}
