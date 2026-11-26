export type ExecutionEnvironment = 'real' | 'gazebo' | 'offline_demo';

export type TelemetrySourceMode = 'demo' | 'rosbridge';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export type EquipmentStatus =
  | 'active'
  | 'ready'
  | 'standby'
  | 'warning'
  | 'fault'
  | 'out_of_scope';

export type EquipmentId =
  | 'yaskawa_a'
  | 'montrac_a'
  | 'kuka_a'
  | 'camera_a'
  | 'tiago'
  | 'yaskawa_b'
  | 'montrac_b'
  | 'staubli_b'
  | 'camera_b';

export type MontracStation = 'blue' | 'green' | 'red' | 'yellow' | 'transit';

export type DemoScenarioId =
  | 'j1-nominal'
  | 'j1-reconfig'
  | 'j2-interzones'
  | 'j3-vla'
  | 'fault-safety';

export interface RosConfig {
  cellName: string;
  facility: string;
  readOnly: boolean;
  defaultMode: TelemetrySourceMode;
  rosbridgeUrl: string;
  hmiHttpUrl?: string;
  reconnectIntervalMs: number;
  topics: {
    cellState: string;
    cycleStatus: string;
    supervisorEvents: string;
    safetyStatus: string;
    yaskawaAState: string;
    yaskawaBState: string;
    montracAState: string;
    montracBState: string;
    tiagoPose: string;
    vlaPlan: string;
    cameraAInfo: string;
    cameraBInfo: string;
  };
}

export interface ArmTelemetry {
  id: 'yaskawa_a' | 'yaskawa_b';
  name: string;
  model: string;
  zone: 'A' | 'B';
  status: EquipmentStatus;
  actionLabel: string;
  gripperState: 'open' | 'closed' | 'holding';
  carryingPart: boolean;
  /** Normalized pose target for synoptic rendering */
  poseTarget: 'home' | 'table' | 'station_blue' | 'station_green' | 'tiago_handover';
  jointsDeg: [number, number, number, number, number, number];
  controllerLayer: string;
  hardwareInterface: string;
  commandTopic?: string;
  rosTopic: string;
}

export interface MontracTelemetry {
  id: 'montrac_a' | 'montrac_b';
  name: string;
  zone: 'A' | 'B';
  status: EquipmentStatus;
  shuttleId: string;
  station: MontracStation;
  /** 0..1 position along the closed Montrac loop */
  loopProgress: number;
  speedMmS: number;
  partPresent: boolean;
  watchdogOk: boolean;
  watchdogAgeMs: number;
  hardwareInterface: string;
  controllerName: string;
  rosTopic: string;
}

export interface MobileRobotTelemetry {
  id: 'tiago';
  name: string;
  model?: string;
  status: EquipmentStatus;
  actionLabel: string;
  /** 0.05 = stock, 0.25 = Poste A central bay, 0.50 = bay_center, 0.75 = Poste B central bay, 0.95 = expedition */
  corridorProgress: number;
  carryingPart: boolean;
  batteryPct: number;
  headingRad?: number;
  cmdVel?: { linearX: number; angularZ: number };
  torsoLiftM?: number;
  armJointsDeg?: number[];
  gripperOpeningM?: number;
  navStack: string;
  hardwareInterface: string;
  rosTopic: string;
  controlTopics?: string[];
}

export interface StandbyRobotTelemetry {
  id: 'kuka_a' | 'staubli_b';
  name: string;
  model: string;
  zone: 'A' | 'B';
  status: EquipmentStatus;
  note: string;
  rosTopic: string;
}

export interface CameraTelemetry {
  id: 'camera_a' | 'camera_b';
  name: string;
  zone: 'A' | 'B';
  sensorType: string;
  status: EquipmentStatus;
  fps: number;
  detectedObjects: string[];
  coverageNote: string;
  rosTopic: string;
}

export interface CycleStep {
  index: number;
  label: string;
  owner: string;
  status: 'done' | 'active' | 'pending' | 'rejected' | 'fault';
  durationS?: number | null;
  detail: string;
}

export interface PreconditionCheck {
  id: string;
  label: string;
  predicate: string;
  passed: boolean;
  detail: string;
}

export interface SupervisorEvent {
  id: string;
  timestamp: string;
  level: 'info' | 'ok' | 'warning' | 'fault';
  source: string;
  message: string;
}

export interface VlaPlanCandidate {
  proposalId?: string;
  proposalStatus?: string;
  naturalLanguageRequest: string;
  sceneObservation: string;
  pddlGoal: string;
  steps: string[];
  verdict: 'validated' | 'rejected' | 'evaluating';
  verdictReason: string;
  timestamp: string;
  alternativeSummary?: string;
}

export interface SafetyState {
  status: 'nominal' | 'warning' | 'estop_triggered';
  hardwareEstopEngaged: boolean;
  watchdogFault: boolean;
  summary: string;
  operatorGuidance: string;
  lastCheckTimestamp: string;
}

export interface CycleRecord {
  id: string;
  timestamp: string;
  scenario: string;
  zone: string;
  durationS: number;
  outcome: 'conforme' | 'rejet_superviseur' | 'arret_securite';
  note: string;
}

export interface KpiSummary {
  completedCycles: number;
  targetBatchCycles: number;
  conformityRatePct: number;
  averageCycleTimeS: number;
  cadencePerHour: number;
  uptimePct: number;
  rejectedCommands: number;
  recentCycles: CycleRecord[];
  cycleTimeSeriesS: number[];
  oeeTrsPct?: number;
  partsReworked?: number;
  partsScrapped?: number;
  wipCount?: number;
}

export interface RosTopicMetric {
  topic: string;
  messageType: string;
  nodeOwner: string;
  hz: number;
  active: boolean;
}

export interface InspectionSummary {
  station_id?: string;
  inspection_phase?: string;
  part_id?: string;
  part_detected?: boolean;
  conforming?: boolean;
  defect_type?: string;
  confidence?: number;
  orientation_deg?: number;
  summary?: string;
}

export interface ShuttleWorldPose {
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  currentSegment?: string;
}

export interface LiveSimTelemetry {
  simConnected: boolean;
  lineState: string;
  paused: boolean;
  activeBatchId: string;
  humanInCollabZone: boolean;
  humanDistanceM: number;
  tiagoSpeedScale: number;
  tiagoWorldPose?: { x: number; y: number; z: number; yaw: number };
  tiagoCmdVel?: { linearX: number; angularZ: number };
  tiagoTorsoLiftM?: number;
  tiagoGripperM?: number;
  humanWorldPose?: { x: number; y: number; z: number; yaw: number };
  shuttles?: {
    left?: ShuttleWorldPose;
    right?: ShuttleWorldPose;
  };
  staubliJointsDeg?: [number, number, number, number, number, number];
  activeWorkpiece?: Record<string, unknown>;
  workpieces?: Array<Record<string, unknown>>;
  qcPosteA?: InspectionSummary;
  qcPosteB?: InspectionSummary;
  hmiHttpUrl?: string;
}

export interface CellSnapshot {
  timestamp: string;
  environment: ExecutionEnvironment;
  gzSimFlag: boolean;
  simConnected?: boolean;
  interBlocLink?: 'tiago';
  hmiHttpUrl?: string;
  orchestratorState: 'RUNNING' | 'IDLE' | 'VALIDATING' | 'FAULT_LOCKED';
  activeScenarioCode: string;
  activeScenarioTitle: string;
  activeScenarioDescription: string;
  cycleNumber: number;
  partLocation:
    | 'table_a'
    | 'yaskawa_a'
    | 'montrac_a'
    | 'tiago'
    | 'montrac_b'
    | 'yaskawa_b'
    | 'table_b';
  safety: SafetyState;
  yaskawaA: ArmTelemetry;
  yaskawaB: ArmTelemetry;
  montracA: MontracTelemetry;
  montracB: MontracTelemetry;
  tiago: MobileRobotTelemetry;
  kukaA: StandbyRobotTelemetry;
  staubliB: StandbyRobotTelemetry;
  cameraA: CameraTelemetry;
  cameraB: CameraTelemetry;
  steps: CycleStep[];
  preconditions: PreconditionCheck[];
  events: SupervisorEvent[];
  vlaCandidate: VlaPlanCandidate;
  kpis: KpiSummary;
  liveSim?: LiveSimTelemetry;
  rosTopics: RosTopicMetric[];
}
