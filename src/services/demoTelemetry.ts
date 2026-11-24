import type {
  CellSnapshot,
  CycleRecord,
  CycleStep,
  DemoScenarioId,
  PreconditionCheck,
  RosTopicMetric,
  SupervisorEvent,
  VlaPlanCandidate,
} from '../types/cell';

function formatClock(offsetSeconds = 0): string {
  const d = new Date(Date.now() + offsetSeconds * 1000);
  return d.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const BASE_HISTORY: CycleRecord[] = [
  {
    id: 'C-014',
    timestamp: '09:54:12',
    scenario: 'J1 intra-zone',
    zone: 'Zone A',
    durationS: 27.4,
    outcome: 'conforme',
    note: 'Prise cube, convoyage Bleu vers Vert, reprise sans glissement',
  },
  {
    id: 'C-013',
    timestamp: '09:51:04',
    scenario: 'J1 intra-zone',
    zone: 'Zone A',
    durationS: 28.1,
    outcome: 'conforme',
    note: 'Cycle complet validé sans intervention opérateur',
  },
  {
    id: 'C-012',
    timestamp: '09:47:39',
    scenario: 'J3 candidat VLA',
    zone: 'Zone A / B',
    durationS: 1.8,
    outcome: 'rejet_superviseur',
    note: 'Plan candidat rejeté : rails Montrac A et B physiquement séparés',
  },
  {
    id: 'C-011',
    timestamp: '09:44:22',
    scenario: 'J1 alternatif',
    zone: 'Zone A',
    durationS: 25.9,
    outcome: 'conforme',
    note: 'Séquence reconfigurée : positionnement navette avant dépose',
  },
  {
    id: 'C-010',
    timestamp: '09:40:51',
    scenario: 'J1 intra-zone',
    zone: 'Zone A',
    durationS: 28.6,
    outcome: 'conforme',
    note: 'Validation croisée répétable (équipe L3 / L4)',
  },
];

function buildRosTopics(
  isFault: boolean,
  isJ2: boolean,
  isJ3: boolean
): RosTopicMetric[] {
  return [
    {
      topic: '/mfja/supervisor/cell_state',
      messageType: 'mfja_interfaces/msg/CellState',
      nodeOwner: 'supervisor_l1 (PlanSys2)',
      hz: 10.0,
      active: true,
    },
    {
      topic: '/mfja/safety/status',
      messageType: 'mfja_interfaces/msg/SafetyStatus',
      nodeOwner: 'safety_monitor',
      hz: 20.0,
      active: true,
    },
    {
      topic: '/zone_a/yaskawa_hc10dt/joint_states',
      messageType: 'sensor_msgs/msg/JointState',
      nodeOwner: 'ros_yaskawa_hc10 / ros2_control',
      hz: isFault ? 0.0 : 50.0,
      active: !isFault,
    },
    {
      topic: '/zone_a/montrac/shuttle_state',
      messageType: 'mfja_rail_interfaces/msg/ShuttleState',
      nodeOwner: 'montrac_hardware_interface (SystemInterface)',
      hz: isFault ? 0.0 : 25.0,
      active: !isFault,
    },
    {
      topic: '/zone_a/camera/scene_summary',
      messageType: 'mfja_vision_interfaces/msg/SceneState',
      nodeOwner: 'zed2_zone_a_node',
      hz: 15.0,
      active: true,
    },
    {
      topic: '/zone_b/yaskawa_hc10/joint_states',
      messageType: 'sensor_msgs/msg/JointState',
      nodeOwner: 'ros_yaskawa_hc10 / ros2_control',
      hz: isJ2 ? 50.0 : 5.0,
      active: true,
    },
    {
      topic: '/tiago/amcl_pose',
      messageType: 'geometry_msgs/msg/PoseWithCovarianceStamped',
      nodeOwner: 'tiago_nav2 (ros2_control)',
      hz: isJ2 ? 20.0 : 0.0,
      active: isJ2,
    },
    {
      topic: '/mfja/vla/candidate_plan',
      messageType: 'mfja_interfaces/msg/PddlCandidate',
      nodeOwner: 'vla_planner_bridge (L8)',
      hz: isJ3 ? 1.0 : 0.0,
      active: isJ3,
    },
  ];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

function interpolateJoints(
  from: [number, number, number, number, number, number],
  to: [number, number, number, number, number, number],
  t: number
): [number, number, number, number, number, number] {
  return [
    Math.round(lerp(from[0], to[0], t) * 10) / 10,
    Math.round(lerp(from[1], to[1], t) * 10) / 10,
    Math.round(lerp(from[2], to[2], t) * 10) / 10,
    Math.round(lerp(from[3], to[3], t) * 10) / 10,
    Math.round(lerp(from[4], to[4], t) * 10) / 10,
    Math.round(lerp(from[5], to[5], t) * 10) / 10,
  ];
}

const JOINTS_HOME: [number, number, number, number, number, number] = [0, -22, 68, 0, -46, 0];
const JOINTS_TABLE: [number, number, number, number, number, number] = [-18, 16, 42, 4, -58, -14];
const JOINTS_BLUE: [number, number, number, number, number, number] = [24, 28, 34, -8, -62, 18];
const JOINTS_GREEN: [number, number, number, number, number, number] = [44, 25, 38, -6, -63, 32];
const JOINTS_HANDOVER: [number, number, number, number, number, number] = [62, 18, 40, 12, -52, 48];

/**
 * Génère un instantané de télémétrie réaliste pour le mode de prévisualisation hors-ligne.
 * `phase` varie cycliquement entre 0 et 1 (24 secondes par cycle de démonstration).
 */
export function buildDemoSnapshot(
  scenario: DemoScenarioId,
  phase: number,
  cycleCount: number
): CellSnapshot {
  const nowStr = formatClock();

  const defaultVla: VlaPlanCandidate = {
    naturalLanguageRequest: 'Prends le cube en zone A, fais-le circuler sur le rail Montrac puis reprends-le.',
    sceneObservation: 'Caméra Zone A : cube détecté sur le poste de prise, navette N1 présente en station Bleue, zone libre.',
    pddlGoal: '(and (part-returned cube_01 poste_a) (shuttle-at n1 station_verte))',
    steps: [
      'pick(yaskawa_hc10dt, cube_01, poste_a)',
      'place_on_shuttle(yaskawa_hc10dt, cube_01, n1, station_bleue)',
      'move_shuttle(montrac_a, n1, station_bleue, station_verte)',
      'pick_from_shuttle(yaskawa_hc10dt, cube_01, n1, station_verte)',
      'place(yaskawa_hc10dt, cube_01, poste_a)',
    ],
    verdict: 'validated',
    verdictReason: 'Toutes les préconditions de sécurité et de topologie Salle 315 sont satisfaites par le superviseur L1.',
    timestamp: formatClock(-18),
  };

  if (scenario === 'fault-safety') {
    const steps: CycleStep[] = [
      {
        index: 1,
        label: 'Vérification des préconditions',
        owner: 'Superviseur L1',
        status: 'done',
        durationS: 0.9,
        detail: 'Zone A vérifiée, pince initialisée',
      },
      {
        index: 2,
        label: 'Prise du cube par Yaskawa HC10DT',
        owner: 'Yaskawa HC10DT',
        status: 'done',
        durationS: 5.2,
        detail: 'Objet saisi et contrôlé en pince',
      },
      {
        index: 3,
        label: 'Dépose sur la navette Montrac N1',
        owner: 'Yaskawa HC10DT',
        status: 'done',
        durationS: 4.8,
        detail: 'Cube déposé en station Bleue',
      },
      {
        index: 4,
        label: 'Convoyage local vers la station Verte',
        owner: 'Montrac Zone A',
        status: 'fault',
        durationS: 2.1,
        detail: 'Perte du chien de garde matériel (> 500 ms) et arrêt d’urgence engagé',
      },
      {
        index: 5,
        label: 'Reprise du cube en station Verte',
        owner: 'Yaskawa HC10DT',
        status: 'pending',
        detail: 'Bloqué par le superviseur tant que la sécurité matérielle reste active',
      },
    ];

    const preconditions: PreconditionCheck[] = [
      {
        id: 'p-estop',
        label: 'Chaîne d’arrêt d’urgence matérielle (Salle 315)',
        predicate: '(hardware-estop-clear salle_315)',
        passed: false,
        detail: 'Arrêt d’urgence enclenché sur l’îlot Zone A',
      },
      {
        id: 'p-wd',
        label: 'Chien de garde interface matérielle Montrac',
        predicate: '(watchdog-alive montrac_a)',
        passed: false,
        detail: 'Dernière trame automate reçue il y a 1 420 ms (seuil : 500 ms)',
      },
      {
        id: 'p-yaskawa',
        label: 'Autorisation de mouvement Yaskawa HC10DT',
        predicate: '(motion-enabled yaskawa_a)',
        passed: false,
        detail: 'Mouvement inhibé par sécurité matérielle et verrouillage L1',
      },
      {
        id: 'p-part',
        label: 'Présence pièce sur la navette N1',
        predicate: '(part-on-shuttle cube_01 n1)',
        passed: true,
        detail: 'Cube immobilisé sur la navette N1 entre Bleu et Vert',
      },
    ];

    const events: SupervisorEvent[] = [
      {
        id: 'ev-f1',
        timestamp: formatClock(-2),
        level: 'fault',
        source: 'Superviseur L1',
        message: 'Transition refusée : cellule verrouillée en état FAULT_LOCKED.',
      },
      {
        id: 'ev-f2',
        timestamp: formatClock(-4),
        level: 'fault',
        source: 'Sécurité matérielle',
        message: 'Arrêt d’urgence physique détecté sur la zone A.',
      },
      {
        id: 'ev-f3',
        timestamp: formatClock(-5),
        level: 'fault',
        source: 'Montrac SystemInterface',
        message: 'Expiration du chien de garde (> 500 ms) : appel on_deactivate() exécuté.',
      },
      {
        id: 'ev-f4',
        timestamp: formatClock(-11),
        level: 'ok',
        source: 'Yaskawa HC10DT',
        message: 'Dépose cube confirmée sur la navette N1 (station Bleue).',
      },
    ];

    return {
      timestamp: nowStr,
      environment: 'offline_demo',
      gzSimFlag: false,
      orchestratorState: 'FAULT_LOCKED',
      activeScenarioCode: 'J1',
      activeScenarioTitle: 'J1 intra-zone (interrompu par défaut sécurité)',
      activeScenarioDescription:
        'Un défaut matériel sur le convoyeur Montrac et un arrêt d’urgence ont interrompu le cycle. L’IHM reste informative : l’acquittement se fait physiquement sur le plateau.',
      cycleNumber: 15 + cycleCount,
      partLocation: 'montrac_a',
      safety: {
        status: 'estop_triggered',
        hardwareEstopEngaged: true,
        watchdogFault: true,
        summary: 'Arrêt d’urgence matériel actif et perte du chien de garde Montrac (Zone A).',
        operatorGuidance:
          'Vérifier visuellement la zone A en salle 315, contrôler la liaison automate Montrac, réarmer le bouton d’arrêt d’urgence physique puis relancer la vérification depuis le terminal de l’orchestrateur.',
        lastCheckTimestamp: nowStr,
      },
      yaskawaA: {
        id: 'yaskawa_a',
        name: 'Yaskawa HC10DT',
        model: 'Motoman HC10DT (Poste A)',
        zone: 'A',
        status: 'fault',
        actionLabel: 'Mouvement inhibé (arrêt d’urgence actif)',
        gripperState: 'open',
        carryingPart: false,
        poseTarget: 'home',
        jointsDeg: JOINTS_HOME,
        controllerLayer: 'MoveIt 2 / joint_trajectory_controller',
        hardwareInterface: 'Contrôleur Yaskawa + ros_yaskawa_hc10',
        rosTopic: '/zone_a/yaskawa_hc10dt/joint_states',
      },
      yaskawaB: {
        id: 'yaskawa_b',
        name: 'Yaskawa HC10',
        model: 'Motoman HC10 (Poste B)',
        zone: 'B',
        status: 'standby',
        actionLabel: 'En veille (hors périmètre J1)',
        gripperState: 'open',
        carryingPart: false,
        poseTarget: 'home',
        jointsDeg: JOINTS_HOME,
        controllerLayer: 'MoveIt 2 / joint_trajectory_controller',
        hardwareInterface: 'Contrôleur Yaskawa + ros_yaskawa_hc10',
        rosTopic: '/zone_b/yaskawa_hc10/joint_states',
      },
      montracA: {
        id: 'montrac_a',
        name: 'Montrac Zone A',
        zone: 'A',
        status: 'fault',
        shuttleId: 'N1',
        station: 'transit',
        loopProgress: 0.14,
        speedMmS: 0,
        partPresent: true,
        watchdogOk: false,
        watchdogAgeMs: 1420,
        hardwareInterface: 'montrac_hardware_interface (SystemInterface — on_deactivate)',
        controllerName: 'montrac_shuttle_controller',
        rosTopic: '/zone_a/montrac/shuttle_state',
      },
      montracB: {
        id: 'montrac_b',
        name: 'Montrac Zone B',
        zone: 'B',
        status: 'standby',
        shuttleId: 'N2',
        station: 'blue',
        loopProgress: 0.06,
        speedMmS: 0,
        partPresent: false,
        watchdogOk: true,
        watchdogAgeMs: 32,
        hardwareInterface: 'montrac_hardware_interface (SystemInterface)',
        controllerName: 'montrac_shuttle_controller',
        rosTopic: '/zone_b/montrac/shuttle_state',
      },
      tiago: {
        id: 'tiago',
        name: 'TIAGo',
        status: 'out_of_scope',
        actionLabel: 'Stationné hors zone active (prévu J2)',
        corridorProgress: 0.05,
        carryingPart: false,
        batteryPct: 86,
        navStack: 'Nav2 (hors chemin critique J1)',
        hardwareInterface: 'ros2_control (TIAGo)',
        rosTopic: '/tiago/amcl_pose',
      },
      kukaA: {
        id: 'kuka_a',
        name: 'KUKA KR6',
        model: 'KUKA KR6 R900',
        zone: 'A',
        status: 'out_of_scope',
        note: 'Non mobilisé sur le scénario J1 (extension possible du plateau)',
        rosTopic: '/zone_a/kuka/state (inactif)',
      },
      staubliB: {
        id: 'staubli_b',
        name: 'Stäubli TX2',
        model: 'Stäubli TX2-60',
        zone: 'B',
        status: 'out_of_scope',
        note: 'Extension optionnelle (reprise non-conformes / finition)',
        rosTopic: '/zone_b/staubli/state (inactif)',
      },
      cameraA: {
        id: 'camera_a',
        name: 'Caméra Zone A',
        zone: 'A',
        sensorType: 'ZED 2 stéréo (comparatif Cognex en cours)',
        status: 'ready',
        fps: 15,
        detectedObjects: ['Navette N1 immobilisée', 'Cube rigide présent sur N1'],
        coverageNote: 'Couverture complète du rail Montrac A pour l’état visuel',
        rosTopic: '/zone_a/camera/scene_summary',
      },
      cameraB: {
        id: 'camera_b',
        name: 'Caméra Zone B',
        zone: 'B',
        sensorType: 'ZED 2 stéréo (comparatif Cognex en cours)',
        status: 'standby',
        fps: 5,
        detectedObjects: ['Navette N2 en station Bleue', 'Zone libre'],
        coverageNote: 'En veille tant que le scénario reste intra-zone A',
        rosTopic: '/zone_b/camera/scene_summary',
      },
      steps,
      preconditions,
      events,
      vlaCandidate: defaultVla,
      kpis: {
        completedCycles: 14,
        targetBatchCycles: 20,
        conformityRatePct: 92.9,
        averageCycleTimeS: 27.5,
        cadencePerHour: 118,
        uptimePct: 94.2,
        rejectedCommands: 2,
        recentCycles: [
          {
            id: 'C-015',
            timestamp: formatClock(-5),
            scenario: 'J1 intra-zone',
            zone: 'Zone A',
            durationS: 13.0,
            outcome: 'arret_securite',
            note: 'Arrêt sûr déclenché : chien de garde Montrac + AU Zone A',
          },
          ...BASE_HISTORY,
        ],
        cycleTimeSeriesS: [28.6, 27.9, 28.4, 25.9, 28.1, 27.4, 13.0],
      },
      rosTopics: buildRosTopics(true, false, false),
    };
  }

  if (scenario === 'j3-vla') {
    const showingRejected = phase < 0.5;
    const vlaCandidate: VlaPlanCandidate = showingRejected
      ? {
          naturalLanguageRequest:
            '« Envoie le cube de la zone A jusqu’au Yaskawa de la zone B directement par le rail Montrac. »',
          sceneObservation:
            'Caméra A : cube sur poste A, navette N1 en station Bleue. Caméra B : navette N2 libre, zone B libre.',
          pddlGoal: '(part-at cube_01 zone_b_yaskawa)',
          steps: [
            'pick(yaskawa_hc10dt, cube_01, poste_a)',
            'place_on_shuttle(yaskawa_hc10dt, cube_01, n1, station_bleue_a)',
            'move_shuttle(montrac_a, n1, station_bleue_a, station_bleue_b)  [INVALIDE]',
          ],
          verdict: 'rejected',
          verdictReason:
            'Rejet déterministe par le superviseur L1 : les rails Montrac Zone A et Zone B ne sont pas reliés physiquement (aucune transition valide entre rail_a et rail_b). Aucune commande publiée vers les robots.',
          timestamp: formatClock(-3),
          alternativeSummary:
            'Replanification proposée : limiter le cycle à la zone A (J1) ou insérer un transit TIAGo (J2) si autorisé.',
        }
      : {
          naturalLanguageRequest:
            '« Fais un cycle complet du cube dans la zone A en vérifiant la présence sur la navette. »',
          sceneObservation:
            'Caméra A : cube détecté sur poste A, navette N1 prête en station Bleue, aucun obstacle opérateur.',
          pddlGoal: '(and (cycle-done cube_01 zone_a) (shuttle-at n1 station_verte_a))',
          steps: [
            'pick(yaskawa_hc10dt, cube_01, poste_a)',
            'place_on_shuttle(yaskawa_hc10dt, cube_01, n1, station_bleue_a)',
            'move_shuttle(montrac_a, n1, station_bleue_a, station_verte_a)',
            'pick_from_shuttle(yaskawa_hc10dt, cube_01, n1, station_verte_a)',
          ],
          verdict: 'validated',
          verdictReason:
            'Plan candidat conforme au domaine PDDL et aux règles de sécurité Salle 315. Autorisé par le superviseur L1 pour exécution en simulation Gazebo.',
          timestamp: formatClock(-1),
        };

    const subPhase = showingRejected ? 0 : (phase - 0.5) * 2;
    const shuttleLoop = showingRejected ? 0.06 : lerp(0.06, 0.24, Math.min(1, subPhase * 1.4));

    return {
      timestamp: nowStr,
      environment: 'offline_demo',
      gzSimFlag: true,
      orchestratorState: showingRejected ? 'VALIDATING' : 'RUNNING',
      activeScenarioCode: 'J3',
      activeScenarioTitle: 'J3 langage naturel et validation neuro-symbolique',
      activeScenarioDescription:
        'Les modèles LLM/VLM proposent un plan candidat PDDL à partir de la consigne et des images caméra, mais seul le superviseur déterministe L1 valide ou rejette.',
      cycleNumber: 15 + cycleCount,
      partLocation: showingRejected ? 'table_a' : subPhase < 0.35 ? 'yaskawa_a' : 'montrac_a',
      safety: {
        status: showingRejected ? 'warning' : 'nominal',
        hardwareEstopEngaged: false,
        watchdogFault: false,
        summary: showingRejected
          ? 'Plan candidat VLA rejeté par le superviseur (fail-closed) : aucune action robot déclenchée.'
          : 'Plan candidat validé par le superviseur L1 en simulation Gazebo Harmonic.',
        operatorGuidance: showingRejected
          ? 'Le superviseur a bloqué une commande physiquement impossible (rails Montrac séparés). Formuler une consigne intra-zone ou autoriser le transit TIAGo.'
          : 'Exécution nominale en jumeau numérique (gz_sim:=true).',
        lastCheckTimestamp: nowStr,
      },
      yaskawaA: {
        id: 'yaskawa_a',
        name: 'Yaskawa HC10DT',
        model: 'Motoman HC10DT (Poste A)',
        zone: 'A',
        status: showingRejected ? 'ready' : 'active',
        actionLabel: showingRejected
          ? 'En attente de validation du plan candidat'
          : subPhase < 0.35
            ? 'Saisie et transfert du cube vers la navette N1'
            : 'Dégagement pendant le convoyage Montrac',
        gripperState: showingRejected ? 'open' : subPhase < 0.35 ? 'holding' : 'open',
        carryingPart: !showingRejected && subPhase < 0.35,
        poseTarget: showingRejected ? 'home' : subPhase < 0.35 ? 'station_blue' : 'home',
        jointsDeg: showingRejected
          ? JOINTS_HOME
          : interpolateJoints(JOINTS_TABLE, JOINTS_BLUE, Math.min(1, subPhase * 2)),
        controllerLayer: 'MoveIt 2 / joint_trajectory_controller',
        hardwareInterface: 'gz_ros2_control (Gazebo Harmonic)',
        rosTopic: '/zone_a/yaskawa_hc10dt/joint_states',
      },
      yaskawaB: {
        id: 'yaskawa_b',
        name: 'Yaskawa HC10',
        model: 'Motoman HC10 (Poste B)',
        zone: 'B',
        status: 'standby',
        actionLabel: 'En veille',
        gripperState: 'open',
        carryingPart: false,
        poseTarget: 'home',
        jointsDeg: JOINTS_HOME,
        controllerLayer: 'MoveIt 2 / joint_trajectory_controller',
        hardwareInterface: 'gz_ros2_control (Gazebo Harmonic)',
        rosTopic: '/zone_b/yaskawa_hc10/joint_states',
      },
      montracA: {
        id: 'montrac_a',
        name: 'Montrac Zone A',
        zone: 'A',
        status: showingRejected ? 'ready' : 'active',
        shuttleId: 'N1',
        station: shuttleLoop < 0.1 ? 'blue' : shuttleLoop > 0.21 ? 'green' : 'transit',
        loopProgress: shuttleLoop,
        speedMmS: showingRejected ? 0 : shuttleLoop < 0.23 ? 185 : 0,
        partPresent: !showingRejected && subPhase >= 0.35,
        watchdogOk: true,
        watchdogAgeMs: 24,
        hardwareInterface: 'gz_ros2_control (montrac_description, gz_sim:=true)',
        controllerName: 'montrac_shuttle_controller',
        rosTopic: '/zone_a/montrac/shuttle_state',
      },
      montracB: {
        id: 'montrac_b',
        name: 'Montrac Zone B',
        zone: 'B',
        status: 'standby',
        shuttleId: 'N2',
        station: 'blue',
        loopProgress: 0.06,
        speedMmS: 0,
        partPresent: false,
        watchdogOk: true,
        watchdogAgeMs: 29,
        hardwareInterface: 'gz_ros2_control (montrac_description, gz_sim:=true)',
        controllerName: 'montrac_shuttle_controller',
        rosTopic: '/zone_b/montrac/shuttle_state',
      },
      tiago: {
        id: 'tiago',
        name: 'TIAGo',
        status: 'standby',
        actionLabel: 'Disponible en couloir central (simulation Nav2)',
        corridorProgress: 0.08,
        carryingPart: false,
        batteryPct: 91,
        navStack: 'Nav2 / ros2_control',
        hardwareInterface: 'gz_ros2_control (TIAGo)',
        rosTopic: '/tiago/amcl_pose',
      },
      kukaA: {
        id: 'kuka_a',
        name: 'KUKA KR6',
        model: 'KUKA KR6 R900',
        zone: 'A',
        status: 'out_of_scope',
        note: 'Hors plan candidat actif',
        rosTopic: '/zone_a/kuka/state (inactif)',
      },
      staubliB: {
        id: 'staubli_b',
        name: 'Stäubli TX2',
        model: 'Stäubli TX2-60',
        zone: 'B',
        status: 'out_of_scope',
        note: 'Hors plan candidat actif',
        rosTopic: '/zone_b/staubli/state (inactif)',
      },
      cameraA: {
        id: 'camera_a',
        name: 'Caméra Zone A',
        zone: 'A',
        sensorType: 'ZED 2 simulée (ancrage visuel VLM)',
        status: 'active',
        fps: 15,
        detectedObjects: ['Cube rigide détecté', 'Navette N1 localisée', 'Voie libre'],
        coverageNote: 'Images transmises au module d’ancrage visuel VLA',
        rosTopic: '/zone_a/camera/scene_summary',
      },
      cameraB: {
        id: 'camera_b',
        name: 'Caméra Zone B',
        zone: 'B',
        sensorType: 'ZED 2 simulée (ancrage visuel VLM)',
        status: 'active',
        fps: 15,
        detectedObjects: ['Navette N2 vide', 'Poste B libre'],
        coverageNote: 'Confirme l’état libre de la zone B au VLM',
        rosTopic: '/zone_b/camera/scene_summary',
      },
      steps: [
        {
          index: 1,
          label: 'Réception de la consigne en langage naturel',
          owner: 'Interface L8',
          status: 'done',
          durationS: 0.4,
          detail: 'Texte opérateur transmis au module de décomposition',
        },
        {
          index: 2,
          label: 'Observation visuelle des deux zones Montrac',
          owner: 'Vision ZED 2 / VLM',
          status: 'done',
          durationS: 0.8,
          detail: 'État des navettes N1 et N2 extrait des caméras',
        },
        {
          index: 3,
          label: 'Génération du problème et plan candidat PDDL',
          owner: 'PlanSys2 / VLA',
          status: 'done',
          durationS: 1.1,
          detail: 'Séquence symbolique soumise au superviseur L1',
        },
        {
          index: 4,
          label: 'Validation déterministe des préconditions',
          owner: 'Superviseur L1',
          status: showingRejected ? 'rejected' : 'done',
          durationS: 0.2,
          detail: showingRejected
            ? 'Plan rejeté : aucune liaison physique entre rail A et rail B'
            : 'Plan validé : préconditions topologiques et sécurité vérifiées',
        },
        {
          index: 5,
          label: 'Exécution orchestrée sur la cellule',
          owner: 'Yaskawa A + Montrac A',
          status: showingRejected ? 'pending' : 'active',
          detail: showingRejected
            ? 'En attente d’un plan valide (principe fail-closed)'
            : 'Exécution autorisée en simulation Gazebo Harmonic',
        },
      ],
      preconditions: [
        {
          id: 'p-topo',
          label: 'Cohérence topologique des rails Montrac',
          predicate: '(connected rail_zone_a rail_zone_b)',
          passed: !showingRejected,
          detail: showingRejected
            ? 'Faux : les rails Zone A et Zone B sont indépendants'
            : 'Non requis : plan replanifié en intra-zone A',
        },
        {
          id: 'p-estop',
          label: 'Chaîne de sécurité',
          predicate: '(safety-ok salle_315)',
          passed: true,
          detail: 'Simulation Gazebo active, aucun verrou de sécurité',
        },
        {
          id: 'p-vlm',
          label: 'Ancrage visuel cohérent avec les capteurs',
          predicate: '(vision-consistent zone_a)',
          passed: true,
          detail: 'Caméra A confirme la présence du cube et de la navette N1',
        },
      ],
      events: showingRejected
        ? [
            {
              id: 'ev-j3-1',
              timestamp: formatClock(-1),
              level: 'warning',
              source: 'Superviseur L1',
              message: 'Plan candidat rejeté : liaison Montrac A vers B inexistante.',
            },
            {
              id: 'ev-j3-2',
              timestamp: formatClock(-3),
              level: 'info',
              source: 'Module VLA (L8)',
              message: 'Proposition d’un plan PDDL issu de la consigne texte.',
            },
            {
              id: 'ev-j3-3',
              timestamp: formatClock(-5),
              level: 'ok',
              source: 'Vision Zone A',
              message: 'État de scène acquis (cube poste A, navette N1 en station Bleue).',
            },
          ]
        : [
            {
              id: 'ev-j3-4',
              timestamp: formatClock(-1),
              level: 'ok',
              source: 'Superviseur L1',
              message: 'Nouveau plan intra-zone A validé et transmis aux contrôleurs.',
            },
            {
              id: 'ev-j3-5',
              timestamp: formatClock(-4),
              level: 'info',
              source: 'PlanSys2',
              message: 'Décomposition PDDL conforme aux préconditions Salle 315.',
            },
          ],
      vlaCandidate,
      kpis: {
        completedCycles: 14,
        targetBatchCycles: 20,
        conformityRatePct: 93.3,
        averageCycleTimeS: 27.1,
        cadencePerHour: 122,
        uptimePct: 98.4,
        rejectedCommands: 3,
        recentCycles: BASE_HISTORY,
        cycleTimeSeriesS: [28.6, 27.9, 28.4, 25.9, 28.1, 27.4],
      },
      rosTopics: buildRosTopics(false, false, true),
    };
  }

  if (scenario === 'j2-interzones') {
    // 6-stage J2 flow: Yaskawa A -> Montrac A -> TIAGo Zone A->B -> Montrac B -> Yaskawa B
    let activeStepIdx = 1;
    let partLocation: CellSnapshot['partLocation'] = 'table_a';
    let yaskawaAPose: CellSnapshot['yaskawaA']['poseTarget'] = 'home';
    let yaskawaBPose: CellSnapshot['yaskawaB']['poseTarget'] = 'home';
    let yaskawaAJoints = JOINTS_HOME;
    let yaskawaBJoints = JOINTS_HOME;
    let montracAProgress = 0.06;
    let montracBProgress = 0.06;
    let tiagoProgress = 0.18;

    if (phase < 0.18) {
      activeStepIdx = 1;
      const t = phase / 0.18;
      partLocation = t < 0.45 ? 'table_a' : 'yaskawa_a';
      yaskawaAPose = t < 0.45 ? 'table' : 'station_blue';
      yaskawaAJoints = interpolateJoints(JOINTS_TABLE, JOINTS_BLUE, t);
    } else if (phase < 0.36) {
      activeStepIdx = 2;
      const t = (phase - 0.18) / 0.18;
      partLocation = 'montrac_a';
      montracAProgress = lerp(0.06, 0.24, t);
    } else if (phase < 0.62) {
      activeStepIdx = 3;
      const t = (phase - 0.36) / 0.26;
      partLocation = 'tiago';
      montracAProgress = 0.24;
      tiagoProgress = lerp(0.22, 0.78, t);
      yaskawaAPose = t < 0.2 ? 'tiago_handover' : 'home';
      yaskawaAJoints = t < 0.2 ? JOINTS_HANDOVER : JOINTS_HOME;
    } else if (phase < 0.80) {
      activeStepIdx = 4;
      const t = (phase - 0.62) / 0.18;
      partLocation = 'montrac_b';
      montracAProgress = 0.24;
      tiagoProgress = 0.78;
      montracBProgress = lerp(0.06, 0.24, t);
    } else {
      activeStepIdx = 5;
      const t = (phase - 0.80) / 0.20;
      partLocation = t < 0.65 ? 'yaskawa_b' : 'table_b';
      montracAProgress = 0.24;
      tiagoProgress = lerp(0.78, 0.18, t);
      montracBProgress = 0.24;
      yaskawaBPose = t < 0.55 ? 'station_green' : 'table';
      yaskawaBJoints = interpolateJoints(JOINTS_GREEN, JOINTS_TABLE, t);
    }

    const stepDefs: Array<{ label: string; owner: string; detail: string; dur: number }> = [
      {
        label: 'Prise et dépose initiale en Zone A',
        owner: 'Yaskawa HC10DT',
        detail: 'Chargement du cube sur la navette N1 (station Bleue)',
        dur: 6.2,
      },
      {
        label: 'Convoyage local Zone A vers point de transfert',
        owner: 'Montrac Zone A',
        detail: 'Acheminement vers la station Verte côté couloir',
        dur: 5.4,
      },
      {
        label: 'Transit inter-zones par le robot mobile TIAGo',
        owner: 'TIAGo (Nav2)',
        detail: 'Navigation autonome dans le couloir central Zone A vers Zone B',
        dur: 11.8,
      },
      {
        label: 'Convoyage local Zone B vers poste de reprise',
        owner: 'Montrac Zone B',
        detail: 'Navette N2 achemine la pièce vers la station Verte',
        dur: 5.1,
      },
      {
        label: 'Reprise finale et dépose en Zone B',
        owner: 'Yaskawa HC10',
        detail: 'Déchargement du produit fini sur la table du poste B',
        dur: 6.0,
      },
    ];

    const steps: CycleStep[] = stepDefs.map((s, idx) => {
      const stepNum = idx + 1;
      return {
        index: stepNum,
        label: s.label,
        owner: s.owner,
        detail: s.detail,
        durationS: stepNum < activeStepIdx ? s.dur : undefined,
        status:
          stepNum < activeStepIdx
            ? 'done'
            : stepNum === activeStepIdx
              ? 'active'
              : 'pending',
      };
    });

    return {
      timestamp: nowStr,
      environment: 'offline_demo',
      gzSimFlag: true,
      orchestratorState: 'RUNNING',
      activeScenarioCode: 'J2',
      activeScenarioTitle: 'J2 transfert inter-zones (extension conditionnelle TIAGo)',
      activeScenarioDescription:
        'Liaison entre les deux îlots de la salle 315 par le robot mobile TIAGo sous Nav2, les deux rails Montrac restant physiquement indépendants.',
      cycleNumber: 15 + cycleCount,
      partLocation,
      safety: {
        status: 'nominal',
        hardwareEstopEngaged: false,
        watchdogFault: false,
        summary: 'Sécurité nominale — couloir mobile TIAGo dégagé (mode simulation Gazebo).',
        operatorGuidance: 'Respecter la zone de navigation partagée de TIAGo dans le couloir central.',
        lastCheckTimestamp: nowStr,
      },
      yaskawaA: {
        id: 'yaskawa_a',
        name: 'Yaskawa HC10DT',
        model: 'Motoman HC10DT (Poste A)',
        zone: 'A',
        status: activeStepIdx === 1 ? 'active' : 'ready',
        actionLabel:
          activeStepIdx === 1
            ? 'Prise du cube et dépose sur la navette N1'
            : 'En attente du cycle suivant',
        gripperState: partLocation === 'yaskawa_a' ? 'holding' : 'open',
        carryingPart: partLocation === 'yaskawa_a',
        poseTarget: yaskawaAPose,
        jointsDeg: yaskawaAJoints,
        controllerLayer: 'MoveIt 2 / joint_trajectory_controller',
        hardwareInterface: 'gz_ros2_control (Gazebo Harmonic)',
        rosTopic: '/zone_a/yaskawa_hc10dt/joint_states',
      },
      yaskawaB: {
        id: 'yaskawa_b',
        name: 'Yaskawa HC10',
        model: 'Motoman HC10 (Poste B)',
        zone: 'B',
        status: activeStepIdx === 5 ? 'active' : 'ready',
        actionLabel:
          activeStepIdx === 5
            ? 'Reprise du cube depuis Montrac B et dépose table B'
            : 'Prêt pour réception en zone B',
        gripperState: partLocation === 'yaskawa_b' ? 'holding' : 'open',
        carryingPart: partLocation === 'yaskawa_b',
        poseTarget: yaskawaBPose,
        jointsDeg: yaskawaBJoints,
        controllerLayer: 'MoveIt 2 / joint_trajectory_controller',
        hardwareInterface: 'gz_ros2_control (Gazebo Harmonic)',
        rosTopic: '/zone_b/yaskawa_hc10/joint_states',
      },
      montracA: {
        id: 'montrac_a',
        name: 'Montrac Zone A',
        zone: 'A',
        status: activeStepIdx === 2 ? 'active' : 'ready',
        shuttleId: 'N1',
        station: montracAProgress < 0.1 ? 'blue' : montracAProgress > 0.21 ? 'green' : 'transit',
        loopProgress: montracAProgress,
        speedMmS: activeStepIdx === 2 ? 190 : 0,
        partPresent: partLocation === 'montrac_a',
        watchdogOk: true,
        watchdogAgeMs: 22,
        hardwareInterface: 'gz_ros2_control (montrac_description)',
        controllerName: 'montrac_shuttle_controller',
        rosTopic: '/zone_a/montrac/shuttle_state',
      },
      montracB: {
        id: 'montrac_b',
        name: 'Montrac Zone B',
        zone: 'B',
        status: activeStepIdx === 4 ? 'active' : 'ready',
        shuttleId: 'N2',
        station: montracBProgress < 0.1 ? 'blue' : montracBProgress > 0.21 ? 'green' : 'transit',
        loopProgress: montracBProgress,
        speedMmS: activeStepIdx === 4 ? 190 : 0,
        partPresent: partLocation === 'montrac_b',
        watchdogOk: true,
        watchdogAgeMs: 26,
        hardwareInterface: 'gz_ros2_control (montrac_description)',
        controllerName: 'montrac_shuttle_controller',
        rosTopic: '/zone_b/montrac/shuttle_state',
      },
      tiago: {
        id: 'tiago',
        name: 'TIAGo',
        status: activeStepIdx === 3 ? 'active' : 'ready',
        actionLabel:
          activeStepIdx === 3
            ? 'Navigation autonome Zone A vers Zone B (Nav2)'
            : activeStepIdx > 3
              ? 'Transfert effectué — retour point d’attente'
              : 'En attente de chargement côté Zone A',
        corridorProgress: tiagoProgress,
        carryingPart: partLocation === 'tiago',
        batteryPct: 84,
        navStack: 'Nav2 + AMCL (environnement partagé)',
        hardwareInterface: 'gz_ros2_control (TIAGo officiel)',
        rosTopic: '/tiago/amcl_pose',
      },
      kukaA: {
        id: 'kuka_a',
        name: 'KUKA KR6',
        model: 'KUKA KR6 R900',
        zone: 'A',
        status: 'out_of_scope',
        note: 'Non mobilisé sur J2',
        rosTopic: '/zone_a/kuka/state (inactif)',
      },
      staubliB: {
        id: 'staubli_b',
        name: 'Stäubli TX2',
        model: 'Stäubli TX2-60',
        zone: 'B',
        status: 'out_of_scope',
        note: 'Option reprise non-conformes (hors séquence nominale)',
        rosTopic: '/zone_b/staubli/state (inactif)',
      },
      cameraA: {
        id: 'camera_a',
        name: 'Caméra Zone A',
        zone: 'A',
        sensorType: 'ZED 2 stéréo',
        status: 'active',
        fps: 15,
        detectedObjects: ['Navette N1 suivie', 'Zone A dégagée'],
        coverageNote: 'Supervision visuelle du transfert sortant Zone A',
        rosTopic: '/zone_a/camera/scene_summary',
      },
      cameraB: {
        id: 'camera_b',
        name: 'Caméra Zone B',
        zone: 'B',
        sensorType: 'ZED 2 stéréo',
        status: 'active',
        fps: 15,
        detectedObjects: ['Navette N2 prête', 'Réception Zone B libre'],
        coverageNote: 'Supervision visuelle du transfert entrant Zone B',
        rosTopic: '/zone_b/camera/scene_summary',
      },
      steps,
      preconditions: [
        {
          id: 'p-corridor',
          label: 'Couloir central dégagé pour TIAGo',
          predicate: '(corridor-clear zone_a zone_b)',
          passed: true,
          detail: 'Aucun obstacle détecté par le LiDAR TIAGo',
        },
        {
          id: 'p-montracs',
          label: 'Chiens de garde Montrac A et B actifs',
          predicate: '(and (watchdog-alive montrac_a) (watchdog-alive montrac_b))',
          passed: true,
          detail: 'Latence < 30 ms sur les deux îlots',
        },
        {
          id: 'p-estop',
          label: 'Sécurité matérielle Salle 315',
          predicate: '(hardware-estop-clear salle_315)',
          passed: true,
          detail: 'Aucune alarme active',
        },
      ],
      events: [
        {
          id: 'ev-j2-1',
          timestamp: formatClock(-1),
          level: 'info',
          source: 'Superviseur L1',
          message: `Étape ${activeStepIdx}/5 en cours : ${stepDefs[activeStepIdx - 1].label}.`,
        },
        {
          id: 'ev-j2-2',
          timestamp: formatClock(-6),
          level: 'ok',
          source: 'TIAGo Nav2',
          message: 'Trajectoire inter-zones validée sans obstacle.',
        },
        {
          id: 'ev-j2-3',
          timestamp: formatClock(-12),
          level: 'ok',
          source: 'Superviseur L1',
          message: 'Préconditions J2 vérifiées sur Zone A, couloir et Zone B.',
        },
      ],
      vlaCandidate: defaultVla,
      kpis: {
        completedCycles: 14 + cycleCount,
        targetBatchCycles: 20,
        conformityRatePct: 95.0,
        averageCycleTimeS: 34.5,
        cadencePerHour: 98,
        uptimePct: 98.1,
        rejectedCommands: 1,
        recentCycles: BASE_HISTORY,
        cycleTimeSeriesS: [35.2, 34.8, 33.9, 34.6, 34.1, 34.5],
      },
      rosTopics: buildRosTopics(false, true, false),
    };
  }

  // J1 Nominal & J1 Alternatif (Reconfigurabilité §3.4)
  const isAlt = scenario === 'j1-reconfig';
  let activeStepIdx = 1;
  let partLocation: CellSnapshot['partLocation'] = 'table_a';
  let yaskawaAPose: CellSnapshot['yaskawaA']['poseTarget'] = 'home';
  let yaskawaAJoints = JOINTS_HOME;
  let montracAProgress = isAlt ? 0.06 : 0.06;
  let montracSpeed = 0;

  if (!isAlt) {
    // J1 Nominal: 1. Préconditions -> 2. Prise cube -> 3. Dépose navette Bleu -> 4. Convoyage Bleu->Vert -> 5. Reprise cube -> 6. Retour repos
    if (phase < 0.12) {
      activeStepIdx = 1;
      partLocation = 'table_a';
      yaskawaAPose = 'home';
      yaskawaAJoints = JOINTS_HOME;
      montracAProgress = 0.06;
    } else if (phase < 0.30) {
      activeStepIdx = 2;
      const t = (phase - 0.12) / 0.18;
      partLocation = t < 0.55 ? 'table_a' : 'yaskawa_a';
      yaskawaAPose = 'table';
      yaskawaAJoints = interpolateJoints(JOINTS_HOME, JOINTS_TABLE, Math.min(1, t * 1.4));
      montracAProgress = 0.06;
    } else if (phase < 0.48) {
      activeStepIdx = 3;
      const t = (phase - 0.30) / 0.18;
      partLocation = t < 0.7 ? 'yaskawa_a' : 'montrac_a';
      yaskawaAPose = 'station_blue';
      yaskawaAJoints = interpolateJoints(JOINTS_TABLE, JOINTS_BLUE, t);
      montracAProgress = 0.06;
    } else if (phase < 0.74) {
      activeStepIdx = 4;
      const t = (phase - 0.48) / 0.26;
      partLocation = 'montrac_a';
      yaskawaAPose = 'home';
      yaskawaAJoints = interpolateJoints(JOINTS_BLUE, JOINTS_HOME, Math.min(1, t * 2));
      // Parcours sur la boucle Montrac de la station Bleue vers la station Verte
      montracAProgress = lerp(0.06, 0.24, t);
      montracSpeed = t < 0.92 ? 185 : 0;
    } else if (phase < 0.90) {
      activeStepIdx = 5;
      const t = (phase - 0.74) / 0.16;
      partLocation = t < 0.4 ? 'montrac_a' : 'yaskawa_a';
      yaskawaAPose = t < 0.55 ? 'station_green' : 'table';
      yaskawaAJoints =
        t < 0.5
          ? interpolateJoints(JOINTS_HOME, JOINTS_GREEN, t * 2)
          : interpolateJoints(JOINTS_GREEN, JOINTS_TABLE, (t - 0.5) * 2);
      montracAProgress = 0.24;
    } else {
      activeStepIdx = 6;
      const t = (phase - 0.90) / 0.10;
      partLocation = 'table_a';
      yaskawaAPose = 'home';
      yaskawaAJoints = interpolateJoints(JOINTS_TABLE, JOINTS_HOME, t);
      montracAProgress = lerp(0.24, 0.06, t);
      montracSpeed = 160;
    }
  } else {
    // J1 Alternatif (§3.4) : déplacer la navette d'abord vers Vert, puis prise & dépose sur Vert, puis retour Bleu
    if (phase < 0.14) {
      activeStepIdx = 1;
      partLocation = 'table_a';
      montracAProgress = 0.06;
    } else if (phase < 0.40) {
      activeStepIdx = 2;
      const t = (phase - 0.14) / 0.26;
      partLocation = 'table_a';
      montracAProgress = lerp(0.06, 0.24, t);
      montracSpeed = 190;
    } else if (phase < 0.66) {
      activeStepIdx = 3;
      const t = (phase - 0.40) / 0.26;
      partLocation = t < 0.35 ? 'table_a' : t < 0.8 ? 'yaskawa_a' : 'montrac_a';
      yaskawaAPose = t < 0.45 ? 'table' : 'station_green';
      yaskawaAJoints =
        t < 0.45
          ? interpolateJoints(JOINTS_HOME, JOINTS_TABLE, t / 0.45)
          : interpolateJoints(JOINTS_TABLE, JOINTS_GREEN, (t - 0.45) / 0.55);
      montracAProgress = 0.24;
    } else if (phase < 0.86) {
      activeStepIdx = 4;
      const t = (phase - 0.66) / 0.20;
      partLocation = 'montrac_a';
      yaskawaAPose = 'home';
      yaskawaAJoints = interpolateJoints(JOINTS_GREEN, JOINTS_HOME, Math.min(1, t * 2));
      montracAProgress = lerp(0.24, 0.06, t);
      montracSpeed = 175;
    } else {
      activeStepIdx = 5;
      const t = (phase - 0.86) / 0.14;
      partLocation = t < 0.5 ? 'yaskawa_a' : 'table_a';
      yaskawaAPose = t < 0.5 ? 'station_blue' : 'table';
      yaskawaAJoints = interpolateJoints(JOINTS_BLUE, JOINTS_TABLE, t);
      montracAProgress = 0.06;
    }
  }

  const nominalSteps: Array<{ label: string; owner: string; detail: string; dur: number }> = [
    {
      label: 'Vérification des préconditions initiales',
      owner: 'Superviseur L1',
      detail: 'Zone A dégagée, pince ouverte, navette N1 en station Bleue',
      dur: 1.1,
    },
    {
      label: 'Prise du cube par Yaskawa HC10DT',
      owner: 'Yaskawa HC10DT',
      detail: 'Déplacement vers pose connue (poste A) et fermeture pince',
      dur: 5.4,
    },
    {
      label: 'Dépose du cube sur la navette Montrac N1',
      owner: 'Yaskawa HC10DT',
      detail: 'Dépose contrôlée en station Bleue puis ouverture pince',
      dur: 4.9,
    },
    {
      label: 'Convoyage local sur le rail Montrac A',
      owner: 'Montrac Zone A',
      detail: 'Trajet station Bleue vers station Verte sans glissement de pièce',
      dur: 7.2,
    },
    {
      label: 'Reprise du cube en station Verte',
      owner: 'Yaskawa HC10DT',
      detail: 'Reprise en station autorisée et retour sur table poste A',
      dur: 6.1,
    },
    {
      label: 'Clôture du cycle et repositionnement',
      owner: 'Superviseur L1',
      detail: 'Mise au repos du bras et retour navette N1 en station Bleue',
      dur: 2.7,
    },
  ];

  const altSteps: Array<{ label: string; owner: string; detail: string; dur: number }> = [
    {
      label: 'Chargement de la séquence reconfigurée',
      owner: 'Superviseur L1',
      detail: 'Mêmes pilotes ros2_control, enchaînement inversé (§3.4)',
      dur: 0.8,
    },
    {
      label: 'Déplacement préalable de la navette N1',
      owner: 'Montrac Zone A',
      detail: 'Positionnement à vide en station Verte avant toute prise robot',
      dur: 6.4,
    },
    {
      label: 'Prise du cube et dépose directe en station Verte',
      owner: 'Yaskawa HC10DT',
      detail: 'Réutilisation du même service de prise/dépose sur nouvelle pose',
      dur: 7.1,
    },
    {
      label: 'Convoyage retour vers la station Bleue',
      owner: 'Montrac Zone A',
      detail: 'Maintien de la pièce vérifié pendant le trajet retour',
      dur: 6.2,
    },
    {
      label: 'Reprise finale en station Bleue',
      owner: 'Yaskawa HC10DT',
      detail: 'Restitution du cube sur la table du poste A',
      dur: 5.4,
    },
  ];

  const stepDefs = isAlt ? altSteps : nominalSteps;
  const steps: CycleStep[] = stepDefs.map((s, idx) => {
    const stepNum = idx + 1;
    return {
      index: stepNum,
      label: s.label,
      owner: s.owner,
      detail: s.detail,
      durationS: stepNum < activeStepIdx ? s.dur : undefined,
      status:
        stepNum < activeStepIdx
          ? 'done'
          : stepNum === activeStepIdx
            ? 'active'
            : 'pending',
    };
  });

  const shuttleStation =
    montracAProgress < 0.08
      ? 'blue'
      : montracAProgress > 0.22
        ? 'green'
        : 'transit';

  const yaskawaAction =
    partLocation === 'yaskawa_a'
      ? 'Manipulation du cube rigide en cours'
      : activeStepIdx === 1
        ? 'Position de repos — attente autorisation L1'
        : activeStepIdx === 4 && !isAlt
          ? 'Dégagé hors volume navette pendant convoyage'
          : 'En position d’attente synchronisée';

  return {
    timestamp: nowStr,
    environment: 'offline_demo',
    gzSimFlag: false,
    orchestratorState: 'RUNNING',
    activeScenarioCode: isAlt ? 'J1-ALT' : 'J1',
    activeScenarioTitle: isAlt
      ? 'J1 alternatif — preuve de reconfigurabilité'
      : 'J1 — chaîne réelle intra-zone (Zone A)',
    activeScenarioDescription: isAlt
      ? 'Réassemblage des mêmes briques logicielles sans modifier les pilotes : déplacement navette avant prise et dépose.'
      : 'Séquence de référence sur l’îlot Zone A : prise Yaskawa HC10DT, convoyage local Montrac, puis reprise contrôlée.',
    cycleNumber: 15 + cycleCount,
    partLocation,
    safety: {
      status: 'nominal',
      hardwareEstopEngaged: false,
      watchdogFault: false,
      summary: 'Sécurité matérielle nominale — chien de garde Montrac actif.',
      operatorGuidance:
        'Cellule pilotée exclusivement par l’orchestrateur L1. Utiliser l’arrêt d’urgence physique en salle 315 en cas d’anomalie.',
      lastCheckTimestamp: nowStr,
    },
    yaskawaA: {
      id: 'yaskawa_a',
      name: 'Yaskawa HC10DT',
      model: 'Motoman HC10DT (Poste A)',
      zone: 'A',
      status:
        partLocation === 'yaskawa_a' || activeStepIdx === 2 || activeStepIdx === 3
          ? 'active'
          : 'ready',
      actionLabel: yaskawaAction,
      gripperState: partLocation === 'yaskawa_a' ? 'holding' : 'open',
      carryingPart: partLocation === 'yaskawa_a',
      poseTarget: yaskawaAPose,
      jointsDeg: yaskawaAJoints,
      controllerLayer: 'MoveIt 2 / joint_trajectory_controller',
      hardwareInterface: 'Contrôleur Yaskawa + ros_yaskawa_hc10',
      rosTopic: '/zone_a/yaskawa_hc10dt/joint_states',
    },
    yaskawaB: {
      id: 'yaskawa_b',
      name: 'Yaskawa HC10',
      model: 'Motoman HC10 (Poste B)',
      zone: 'B',
      status: 'standby',
      actionLabel: 'En veille (îlot Zone B hors scénario J1)',
      gripperState: 'open',
      carryingPart: false,
      poseTarget: 'home',
      jointsDeg: JOINTS_HOME,
      controllerLayer: 'MoveIt 2 / joint_trajectory_controller',
      hardwareInterface: 'Contrôleur Yaskawa + ros_yaskawa_hc10',
      rosTopic: '/zone_b/yaskawa_hc10/joint_states',
    },
    montracA: {
      id: 'montrac_a',
      name: 'Montrac Zone A',
      zone: 'A',
      status: montracSpeed > 0 ? 'active' : 'ready',
      shuttleId: 'N1',
      station: shuttleStation,
      loopProgress: montracAProgress,
      speedMmS: montracSpeed,
      partPresent: partLocation === 'montrac_a',
      watchdogOk: true,
      watchdogAgeMs: 28,
      hardwareInterface: 'montrac_hardware_interface (SystemInterface)',
      controllerName: 'montrac_shuttle_controller',
      rosTopic: '/zone_a/montrac/shuttle_state',
    },
    montracB: {
      id: 'montrac_b',
      name: 'Montrac Zone B',
      zone: 'B',
      status: 'standby',
      shuttleId: 'N2',
      station: 'blue',
      loopProgress: 0.06,
      speedMmS: 0,
      partPresent: false,
      watchdogOk: true,
      watchdogAgeMs: 31,
      hardwareInterface: 'montrac_hardware_interface (SystemInterface)',
      controllerName: 'montrac_shuttle_controller',
      rosTopic: '/zone_b/montrac/shuttle_state',
    },
    tiago: {
      id: 'tiago',
      name: 'TIAGo',
      status: 'out_of_scope',
      actionLabel: 'Hors chemin critique J1 (réservé au transfert J2)',
      corridorProgress: 0.05,
      carryingPart: false,
      batteryPct: 88,
      navStack: 'Nav2 (inactif sur J1)',
      hardwareInterface: 'ros2_control (TIAGo)',
      rosTopic: '/tiago/amcl_pose',
    },
    kukaA: {
      id: 'kuka_a',
      name: 'KUKA KR6',
      model: 'KUKA KR6 R900',
      zone: 'A',
      status: 'out_of_scope',
      note: 'Non mobilisé pour J1 (extension plateau)',
      rosTopic: '/zone_a/kuka/state (inactif)',
    },
    staubliB: {
      id: 'staubli_b',
      name: 'Stäubli TX2',
      model: 'Stäubli TX2-60',
      zone: 'B',
      status: 'out_of_scope',
      note: 'Option reprise pièces non conformes (hors J1)',
      rosTopic: '/zone_b/staubli/state (inactif)',
    },
    cameraA: {
      id: 'camera_a',
      name: 'Caméra Zone A',
      zone: 'A',
      sensorType: 'ZED 2 stéréo (essai couverture Zone A)',
      status: 'active',
      fps: 15,
      detectedObjects: [
        `Navette N1 : ${
          shuttleStation === 'blue'
            ? 'station Bleue'
            : shuttleStation === 'green'
              ? 'station Verte'
              : 'en transit'
        }`,
        partLocation === 'montrac_a'
          ? 'Cube confirmé sur la navette N1'
          : 'Cube suivi sur poste A / pince',
      ],
      coverageNote: 'Acquisition d’images exploitables de la zone Montrac A',
      rosTopic: '/zone_a/camera/scene_summary',
    },
    cameraB: {
      id: 'camera_b',
      name: 'Caméra Zone B',
      zone: 'B',
      sensorType: 'ZED 2 stéréo (comparatif Cognex)',
      status: 'standby',
      fps: 5,
      detectedObjects: ['Navette N2 en station Bleue', 'Zone B au repos'],
      coverageNote: 'En veille sur le scénario intra-zone A',
      rosTopic: '/zone_b/camera/scene_summary',
    },
    steps,
    preconditions: [
      {
        id: 'p-estop',
        label: 'Chaîne d’arrêt d’urgence matérielle (Salle 315)',
        predicate: '(hardware-estop-clear salle_315)',
        passed: true,
        detail: 'Aucun arrêt d’urgence engagé',
      },
      {
        id: 'p-wd',
        label: 'Chien de garde interface matérielle Montrac',
        predicate: '(watchdog-alive montrac_a)',
        passed: true,
        detail: 'Dernière trame reçue il y a 28 ms (seuil : 500 ms)',
      },
      {
        id: 'p-yaskawa',
        label: 'Synchronisation bras Yaskawa et navette N1',
        predicate: '(non-collision-zone zone_a)',
        passed: true,
        detail: 'Mouvement bras inhibé pendant les déplacements de navette',
      },
      {
        id: 'p-station',
        label: 'Station de prise/dépose autorisée',
        predicate: `(shuttle-locked n1 ${shuttleStation})`,
        passed: true,
        detail:
          shuttleStation === 'transit'
            ? 'Navette en mouvement — bras maintenu au repos'
            : `Navette verrouillée en station ${shuttleStation === 'blue' ? 'Bleue' : 'Verte'}`,
      },
    ],
    events: [
      {
        id: 'ev-1',
        timestamp: formatClock(-1),
        level: 'info',
        source: 'Superviseur L1',
        message: `Étape ${activeStepIdx}/${stepDefs.length} : ${stepDefs[activeStepIdx - 1].label}.`,
      },
      {
        id: 'ev-2',
        timestamp: formatClock(-6),
        level: 'ok',
        source: 'Montrac SystemInterface',
        message: 'Retours d’état navette N1 nominaux (watchdog 28 ms).',
      },
      {
        id: 'ev-3',
        timestamp: formatClock(-14),
        level: 'ok',
        source: 'Superviseur L1',
        message: isAlt
          ? 'Séquence reconfigurée chargée sur les pilotes existants.'
          : 'Cycle J1 autorisé depuis le terminal de supervision.',
      },
    ],
    vlaCandidate: defaultVla,
    kpis: {
      completedCycles: 14 + cycleCount,
      targetBatchCycles: 20,
      conformityRatePct: 95.2,
      averageCycleTimeS: isAlt ? 25.9 : 27.4,
      cadencePerHour: isAlt ? 131 : 124,
      uptimePct: 98.7,
      rejectedCommands: 1,
      recentCycles: BASE_HISTORY,
      cycleTimeSeriesS: [28.6, 27.9, 28.4, 25.9, 28.1, 27.4],
    },
    rosTopics: buildRosTopics(false, false, false),
  };
}
