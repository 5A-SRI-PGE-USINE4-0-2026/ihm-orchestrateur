"""Superviseur / Orchestrateur déterministe L1 — Cellule Usine 4.0 Salle 315 MFJA.

Implémente :
- Machine à états explicite : IDLE, VALIDATING, RUNNING, FAULT_LOCKED
- Fusion temps réel bidirectionnelle avec les topics/services ROS 2 `/usine40/*` (Gazebo Harmonic)
- Liaison inter-blocs Bloc A <-> Bloc B assurée EXCLUSIVEMENT par TIAGo (aucun convoyeur A-B)
- Vérification continue des préconditions (sécurité matérielle, chien de garde Montrac, ISO/TS 15066)
- Séquences reconfigurables chargées depuis cell_config.yaml (J1, J1 alternatif §3.4, J2 TIAGo)
- Validateur neuro-symbolique J3/L8 fail-closed (rejet des commandes physiquement impossibles ou dangereuses)
- Sérialisation vers le contrat JSON temps réel de l'IHM React
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
import json
import math
from pathlib import Path
import re
import threading
import time
from typing import Any
import yaml


JOINTS_HOME = [0.0, -22.0, 68.0, 0.0, -46.0, 0.0]
JOINTS_TABLE = [-18.0, 16.0, 42.0, 4.0, -58.0, -14.0]
JOINTS_BLUE = [24.0, 28.0, 34.0, -8.0, -62.0, 18.0]
JOINTS_GREEN = [44.0, 25.0, 38.0, -6.0, -63.0, 32.0]
JOINTS_HANDOVER = [62.0, 18.0, 40.0, 12.0, -52.0, 48.0]


def _clock_str() -> str:
    return datetime.now().strftime("%H:%M:%S")


def _lerp(a: float, b: float, t: float) -> float:
    clamped = max(0.0, min(1.0, t))
    return a + (b - a) * clamped


def _lerp_joints(a: list[float], b: list[float], t: float) -> list[float]:
    return [round(_lerp(x, y, t), 1) for x, y in zip(a, b)]


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        out = float(val)
        if math.isnan(out) or math.isinf(out):
            return default
        return out
    except (TypeError, ValueError):
        return default


def world_x_to_corridor_progress(wx: float, wy: float | None = None) -> float:
    """Projette la pose monde Gazebo Salle 315 vers la progression normalisée [0.05 .. 0.95].

    Ancres physiques DART (couloir nord + baie centrale collaborative sans collision carter) :
      Stock (-9.00, -1.60) -> 0.05
      Baie centrale Poste A (-11.66, -2.98) / Couloir Est (-10.45) -> 0.25
      Centre couloir / baie centrale (-12.80, -1.55 / -3.05) -> 0.50
      Baie centrale Poste B (-13.96, -3.18) / Couloir Ouest (-15.05) -> 0.75
      Expédition (-16.48 .. -16.72, -1.60) -> 0.95
    """
    if wy is not None and wy <= -2.25:
        if wx >= -11.66:
            return 0.25
        if wx >= -12.80:
            return round(_lerp(0.25, 0.50, (-11.66 - wx) / 1.14), 4)
        if wx >= -13.96:
            return round(_lerp(0.50, 0.75, (-12.80 - wx) / 1.16), 4)
        return 0.75

    if wx >= -9.00:
        return 0.05
    if wx >= -10.45:
        return round(_lerp(0.05, 0.25, (-9.00 - wx) / 1.45), 4)
    if wx >= -12.80:
        return round(_lerp(0.25, 0.50, (-10.45 - wx) / 2.35), 4)
    if wx >= -15.05:
        return round(_lerp(0.50, 0.75, (-12.80 - wx) / 2.25), 4)
    if wx >= -15.12:
        return 0.75
    if wx >= -16.48:
        return round(_lerp(0.75, 0.95, (-15.12 - wx) / 1.36), 4)
    return 0.95


def shuttle_segment_to_progress(segment: str, s: float, stations: dict[str, float]) -> float:
    seg = (segment or "").upper()
    s_clamped = max(0.0, min(1.0, _safe_float(s, 0.0)))
    if "DZI1" in seg or "SLOT_1" in seg:
        return float(stations.get("blue", 0.06))
    if "DZI2" in seg or "SLOT_2" in seg:
        return float(stations.get("green", 0.24))
    if "DZI3" in seg or "SLOT_3" in seg:
        return float(stations.get("yellow", 0.56))
    if "DZI4" in seg or "SLOT_4" in seg:
        return float(stations.get("red", 0.74))
    return round((0.06 + s_clamped * 0.68) % 1.0, 4)


_LEFT_PERIMETER_CAD: list[tuple[float, float]] = [
    (-10.3200, -3.8648),  # DZI1L (slot_1 Bleu, p=0.06)
    (-10.8000, -3.8644),  # DZI2L (slot_2 Vert, p=0.24)
    (-11.1490, -3.8855),
    (-11.2893, -4.2020),
    (-11.4016, -4.3938),
    (-11.6598, -4.4254),
    (-11.8518, -4.6069),  # Nez intérieur A23 Ouest
    (-11.8545, -4.7363),
    (-11.7446, -4.9510),
    (-11.4023, -5.0120),
    (-11.2924, -5.2023),
    (-11.1370, -5.5323),
    (-10.6088, -5.5426),  # DZI3L (slot_3 KUKA, p=0.56)
    (-10.1400, -5.5430),  # DZI4L (slot_4, p=0.74)
    (-9.8451, -5.5210),
    (-9.7248, -5.2140),
    (-9.7534, -4.8734),
    (-9.7225, -4.6800),   # Montant extérieur Est A14
    (-9.7495, -4.5334),
    (-9.7182, -4.0630),
    (-9.8577, -3.8785),
    (-10.3200, -3.8648),
]

_RIGHT_PERIMETER_CAD: list[tuple[float, float]] = [
    (-14.9500, -3.8560),  # DZI1R (slot_1 Bleu, p=0.06)
    (-15.4300, -3.8553),  # DZI2R (slot_2 Vert, p=0.24)
    (-15.7613, -3.8772),
    (-15.8841, -4.1845),
    (-15.8552, -4.5255),
    (-15.8869, -4.6503),  # Montant extérieur Ouest A23
    (-15.8865, -4.7862),
    (-15.8608, -5.0856),
    (-15.8916, -5.3370),
    (-15.6831, -5.5343),
    (-15.2338, -5.5358),  # DZI3R (slot_3 Stäubli, p=0.56)
    (-14.7700, -5.5364),  # DZI4R (slot_4, p=0.74)
    (-14.4327, -5.5155),
    (-14.2894, -5.1987),
    (-14.1748, -5.0067),
    (-13.8886, -4.9600),
    (-13.7156, -4.7935),  # Nez intérieur A14 Est
    (-13.7128, -4.6640),
    (-13.8886, -4.4229),
    (-14.1737, -4.3877),
    (-14.2850, -4.0988),
    (-14.4438, -3.8666),
    (-14.9500, -3.8560),
]


def _sample_polyline_between(
    pts: list[tuple[float, float]], idx_start: int, idx_end: int, u: float
) -> tuple[float, float, float]:
    sub = pts[idx_start : idx_end + 1]
    if len(sub) < 2:
        return sub[0][0], sub[0][1], 0.0
    dists = [0.0]
    for i in range(1, len(sub)):
        dists.append(dists[-1] + math.hypot(sub[i][0] - sub[i - 1][0], sub[i][1] - sub[i - 1][1]))
    total = max(1e-6, dists[-1])
    target = max(0.0, min(1.0, u)) * total
    k = 0
    while k < len(dists) - 2 and dists[k + 1] < target:
        k += 1
    span = max(1e-6, dists[k + 1] - dists[k])
    t = (target - dists[k]) / span
    ax, ay = sub[k]
    bx, by = sub[k + 1]
    return ax + (bx - ax) * t, ay + (by - ay) * t, math.atan2(by - ay, bx - ax)


def loop_progress_to_shuttle_world_pose(
    side: str, progress: float, speed_mm_s: int = 0, name: str | None = None
) -> dict[str, Any]:
    """Calcule la pose métrique (wx, wy, z, yaw) sur les vrais réseaux CAO Montrac 2.16m × 1.72m.

    Ancres exactes (`montrac_routes.yaml` / `CELL_PATH_{LEFT,RIGHT}.STL`) :
      p = 0.06 -> DZI1L (-10.3200, -3.8648) / DZI1R (-14.9500, -3.8560) [Station Bleue]
      p = 0.24 -> DZI2L (-10.8000, -3.8644) / DZI2R (-15.4300, -3.8553) [Station Verte]
      p = 0.56 -> DZI3L (-10.6088, -5.5426) / DZI3R (-15.2338, -5.5358) [KUKA / Stäubli]
      p = 0.74 -> DZI4L (-10.1400, -5.5430) / DZI4R (-14.7700, -5.5364) [Sud-Est]
    """
    is_left = side.lower() == "left"
    pts = _LEFT_PERIMETER_CAD if is_left else _RIGHT_PERIMETER_CAD
    i_s1, i_s2 = 0, 1
    i_s3 = 12 if is_left else 10
    i_s4 = 13 if is_left else 11
    i_end = len(pts) - 1

    p = (_safe_float(progress, 0.06) % 1.0 + 1.0) % 1.0
    p_shift = p + 1.0 if p < 0.06 else p

    if abs(p_shift - 0.06) < 0.008:
        wx, wy = pts[i_s1]
        yaw = math.pi
        seg = "DZI1L" if is_left else "DZI1R"
    elif abs(p_shift - 0.24) < 0.008:
        wx, wy = pts[i_s2]
        yaw = math.pi
        seg = "DZI2L" if is_left else "DZI2R"
    elif abs(p_shift - 0.56) < 0.008:
        wx, wy = pts[i_s3]
        yaw = 0.0
        seg = "DZI3L" if is_left else "DZI3R"
    elif abs(p_shift - 0.74) < 0.008:
        wx, wy = pts[i_s4]
        yaw = 0.0
        seg = "DZI4L" if is_left else "DZI4R"
    elif p_shift <= 0.24:
        wx, wy, yaw = _sample_polyline_between(pts, i_s1, i_s2, (p_shift - 0.06) / 0.18)
        seg = "A12E"
    elif p_shift <= 0.56:
        u = (p_shift - 0.24) / 0.32
        wx, wy, yaw = _sample_polyline_between(pts, i_s2, i_s3, u)
        seg = "A23" if u < 0.55 else "A34E"
    elif p_shift <= 0.74:
        wx, wy, yaw = _sample_polyline_between(pts, i_s3, i_s4, (p_shift - 0.56) / 0.18)
        seg = "A34E"
    else:
        u = (p_shift - 0.74) / 0.32
        wx, wy, yaw = _sample_polyline_between(pts, i_s4, i_end, u)
        seg = "A14" if u < 0.55 else "A12E"

    return {
        "name": name or ("L1" if is_left else "R1"),
        "x": round(wx, 4),
        "y": round(wy, 4),
        "z": 0.8393,
        "yaw": round(yaw, 4),
        "speed": round(speed_mm_s / 1000.0, 3),
        "currentSegment": seg,
    }


@dataclass
class StepRuntime:
    index: int
    action: str
    label: str
    owner: str
    target_duration_s: float
    status: str = "pending"  # done | active | pending | rejected | fault
    elapsed_s: float = 0.0
    detail: str = ""


@dataclass
class SupervisorEvent:
    id: str
    timestamp: str
    level: str  # info | ok | warning | fault
    source: str
    message: str


@dataclass
class CellSupervisor:
    config: dict[str, Any]
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False, repr=False)

    def __post_init__(self) -> None:
        cell_cfg = self.config.get("cell", {})
        hw_cfg = self.config.get("hardware", {})
        safety_cfg = self.config.get("safety", {})
        net_cfg = self.config.get("network", {})
        self.topics: dict[str, str] = self.config.get("topics", {})
        self.usine40_topics: dict[str, str] = self.config.get("usine40_topics", {})
        self.usine40_services: dict[str, str] = self.config.get("usine40_services", {})

        self.gz_sim: bool = bool(cell_cfg.get("gz_sim", True))
        self.hmi_http_url: str = str(net_cfg.get("hmi_http_url", "http://localhost:8080"))
        self.target_batch_cycles: int = int(cell_cfg.get("target_batch_cycles", 20))
        self.montrac_speed_nominal: int = int(hw_cfg.get("montrac_speed_mm_s", 185))
        self.stations: dict[str, float] = hw_cfg.get(
            "stations", {"blue": 0.06, "green": 0.24, "red": 0.74, "yellow": 0.56}
        )
        self.watchdog_timeout_ms: int = int(safety_cfg.get("montrac_watchdog_timeout_ms", 500))
        self.scenarios: dict[str, Any] = self.config.get("scenarios", {})

        # État orchestrateur local (autonome / fallback)
        self.state: str = "IDLE"  # IDLE | VALIDATING | RUNNING | FAULT_LOCKED
        self.active_scenario_key: str = "j2" if "j2" in self.scenarios else "j1"
        self.loop_mode: bool = False
        self.cycle_number: int = 1
        self.cycle_elapsed_s: float = 0.0
        self.steps: list[StepRuntime] = []
        self.active_step_idx: int = -1

        # Sécurité & chiens de garde
        self.hardware_estop_engaged: bool = False
        self.montrac_a_watchdog_ms: int = 24
        self.montrac_b_watchdog_ms: int = 28
        self.watchdog_fault_injected: bool = False

        # État physique simulé / observé des équipements
        self.part_location: str = "table_a"
        self.yaskawa_a_pose: str = "home"
        self.yaskawa_a_joints: list[float] = list(JOINTS_HOME)
        self.yaskawa_a_gripper: str = "open"
        self.yaskawa_a_action: str = "En position de repos (Bloc A)"

        self.yaskawa_b_pose: str = "home"
        self.yaskawa_b_joints: list[float] = list(JOINTS_HOME)
        self.yaskawa_b_gripper: str = "open"
        self.yaskawa_b_action: str = "En attente transfert TIAGo (Bloc B)"

        self.staubli_joints: list[float] = [0.0] * 6

        self.montrac_a_progress: float = self.stations["blue"]
        self.montrac_a_speed: int = 0
        self.montrac_b_progress: float = self.stations["blue"]
        self.montrac_b_speed: int = 0

        self.tiago_progress: float = 0.50
        self.tiago_action: str = "Prêt — liaison exclusive Bloc A ↔ Bloc B"

        # État temps réel provenant de la simulation ROS 2 `/usine40/*`
        self.sim_connected: bool = False
        self.sim_last_rx_monotonic: float = 0.0
        self.sim_kpi: dict[str, Any] = {}
        self.sim_plan_steps: list[dict[str, Any]] = []
        self.sim_plan_completed_steps: int | None = None
        self.sim_safety: dict[str, Any] = {
            "estop_active": False,
            "cell_ready": True,
            "human_in_collab_zone": False,
            "human_distance_m": 99.0,
            "tiago_speed_scale": 1.0,
            "poste_a_interlock_clear": True,
            "poste_b_interlock_clear": True,
            "staubli_interlock_clear": True,
            "montrac_interlock_clear": True,
            "active_veto_reason": "",
            "active_locks": [],
        }
        self.sim_stations: dict[str, dict[str, Any]] = {}
        self.sim_active_workpiece: dict[str, Any] = {}
        self.sim_workpieces: list[dict[str, Any]] = []
        self.sim_tiago_world_pose: dict[str, float] = {"x": -12.80, "y": -1.20, "z": 0.0, "yaw": -1.5708}
        self.sim_tiago_cmd_vel: dict[str, float] = {"linearX": 0.0, "angularZ": 0.0}
        self.sim_tiago_torso_lift_m: float = 0.34
        self.sim_tiago_arm_joints_deg: list[float] = [44.1, 60.7, -75.7, 132.9, 52.3, -71.7, -49.9]
        self.sim_tiago_gripper_m: float = 0.064
        self.sim_human_world_pose: dict[str, float] = {"x": -12.80, "y": 2.00, "z": 0.0, "yaw": -1.5708}
        self.sim_inspections: dict[str, dict[str, Any]] = {}
        self.sim_shuttles: dict[str, dict[str, Any]] = {}
        self.sim_latest_proposal: dict[str, Any] | None = None

        # KPIs & traçabilité
        self.completed_cycles: int = 0
        self.faulted_cycles: int = 0
        self.rejected_commands: int = 0
        self.cycle_durations_s: list[float] = []
        self.recent_cycles: list[dict[str, Any]] = []
        self._event_seq: int = 0
        self.events: list[SupervisorEvent] = []

        # Dernier candidat J3 / Lot 8 VLA / PDDL
        self.vla_candidate: dict[str, Any] = {
            "naturalLanguageRequest": "Aucune consigne langage naturel soumise pour le moment.",
            "sceneObservation": "ZED 2 Bloc A/B : rails locaux séparés, couloir nord dégagé pour TIAGo.",
            "pddlGoal": "(idle salle_315)",
            "steps": [],
            "verdict": "validated",
            "verdictReason": "En attente d'une consigne opérateur (IHM ou CLI `propose <texte>`).",
            "timestamp": _clock_str(),
        }

        self._load_scenario_steps(self.active_scenario_key, activate=False)
        self._add_event(
            "ok",
            "Superviseur L1",
            "Orchestrateur initialisé en état IDLE — TIAGo configuré comme unique lien Bloc A ↔ Bloc B.",
        )

    @classmethod
    def from_yaml(cls, path: str | Path) -> "CellSupervisor":
        with open(path, "r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
        return cls(config=data)

    # ------------------------------------------------------------------
    # Journal interne
    # ------------------------------------------------------------------
    def _add_event(self, level: str, source: str, message: str, ts: str | None = None) -> None:
        self._event_seq += 1
        self.events.insert(
            0,
            SupervisorEvent(
                id=f"ev-{self._event_seq}",
                timestamp=ts or _clock_str(),
                level=level,
                source=source,
                message=message,
            ),
        )
        if len(self.events) > 40:
            self.events = self.events[:40]

    def _mark_sim_rx(self) -> None:
        self.sim_connected = True
        self.gz_sim = True
        self.sim_last_rx_monotonic = time.monotonic()

    def _load_scenario_steps(self, key: str, activate: bool) -> None:
        sc = self.scenarios[key]
        self.active_scenario_key = key
        self.steps = [
            StepRuntime(
                index=idx + 1,
                action=st["action"],
                label=st["label"],
                owner=st["owner"],
                target_duration_s=float(st["duration_s"]),
                status="active" if (activate and idx == 0) else "pending",
                detail="",
            )
            for idx, st in enumerate(sc["steps"])
        ]
        self.active_step_idx = 0 if activate else -1
        self.cycle_elapsed_s = 0.0

    # ------------------------------------------------------------------
    # Ingestion temps réel depuis la simulation ROS 2 / Gazebo (`/usine40/*`)
    # ------------------------------------------------------------------
    def ingest_sim_kpi(self, data: dict[str, Any]) -> None:
        with self._lock:
            self._mark_sim_rx()
            prev_completed = int(self.sim_kpi.get("parts_completed", 0))
            self.sim_kpi = dict(data)
            new_completed = int(data.get("parts_completed", 0))
            if new_completed > prev_completed:
                avg_s = _safe_float(data.get("avg_cycle_time_sec", 0.0), 25.0)
                if avg_s > 0:
                    self.cycle_durations_s.append(round(avg_s, 1))
                    self.cycle_durations_s = self.cycle_durations_s[-10:]
                batch_id = str(data.get("active_batch_id") or f"BATCH-{self.cycle_number}")
                self.recent_cycles.insert(
                    0,
                    {
                        "id": f"{batch_id}-P{new_completed}",
                        "timestamp": _clock_str(),
                        "scenario": "Lot Production E2E (TIAGo A→B)",
                        "zone": "Bloc A → TIAGo → Bloc B",
                        "durationS": round(max(1.0, avg_s), 1),
                        "outcome": "conforme",
                        "note": "Transfert inter-blocs par TIAGo & contrôle qualité ZED 2 validés",
                    },
                )
                self.recent_cycles = self.recent_cycles[:12]

            self.completed_cycles = max(self.completed_cycles, new_completed)
            target_qty = int(data.get("target_quantity", 0))
            if target_qty > 0:
                self.target_batch_cycles = target_qty

            raw_plan = str(data.get("active_plan_json", ""))
            if raw_plan:
                try:
                    parsed = json.loads(raw_plan)
                    if isinstance(parsed, dict):
                        items = parsed.get("steps") or parsed.get("actions") or parsed.get("plan") or []
                        comp_raw = parsed.get("completed_steps")
                        self.sim_plan_completed_steps = (
                            max(0, int(comp_raw)) if isinstance(comp_raw, (int, float)) else None
                        )
                    elif isinstance(parsed, list):
                        items = parsed
                        self.sim_plan_completed_steps = None
                    else:
                        items = []
                        self.sim_plan_completed_steps = None
                    self.sim_plan_steps = [it for it in items if isinstance(it, dict)] or [
                        {"index": i, "action": str(it)}
                        for i, it in enumerate(items)
                    ]
                except json.JSONDecodeError:
                    pass

    def ingest_sim_safety(self, data: dict[str, Any]) -> None:
        with self._lock:
            self._mark_sim_rx()
            was_estop = bool(self.sim_safety.get("estop_active", False))
            now_estop = bool(data.get("estop_active", False))
            self.sim_safety.update(data)
            self.hardware_estop_engaged = now_estop
            if now_estop and not was_estop:
                self.state = "FAULT_LOCKED"
                self._add_event(
                    "fault",
                    "Sécurité Salle 315",
                    "Arrêt d'urgence global activé sur la cellule ROS 2.",
                )
            elif was_estop and not now_estop:
                if not self.watchdog_fault_injected:
                    self.state = "IDLE"
                self._add_event(
                    "ok",
                    "Sécurité Salle 315",
                    "Arrêt d'urgence relâché — cellule réarmée.",
                )

    def ingest_sim_station_status(self, data: dict[str, Any]) -> None:
        station_id = str(data.get("station_id", "")).strip().lower()
        if not station_id:
            return
        with self._lock:
            self._mark_sim_rx()
            self.sim_stations[station_id] = dict(data)
            action = str(data.get("current_action") or data.get("detail") or "").strip()
            st_upper = str(data.get("state", "IDLE")).upper()

            if station_id == "poste_a":
                if action:
                    self.yaskawa_a_action = action
                act_up = action.upper()
                if "HANDOFF" in act_up or "OUT" in act_up or "TIAGO" in act_up:
                    self.yaskawa_a_pose = "tiago_handover"
                elif "SHUTTLE" in act_up or "SLOT_1" in act_up:
                    self.yaskawa_a_pose = "station_blue"
                elif st_upper in ("BUSY", "RUNNING", "MOVING"):
                    self.yaskawa_a_pose = "table"
                else:
                    self.yaskawa_a_pose = "home"
            elif station_id == "poste_b":
                if action:
                    self.yaskawa_b_action = action
                act_up = action.upper()
                if "IN" in act_up or "TIAGO" in act_up or "HANDOFF" in act_up:
                    self.yaskawa_b_pose = "tiago_handover"
                elif "SHUTTLE" in act_up:
                    self.yaskawa_b_pose = "station_green"
                elif st_upper in ("BUSY", "RUNNING", "MOVING"):
                    self.yaskawa_b_pose = "table"
                else:
                    self.yaskawa_b_pose = "home"
            elif station_id == "tiago":
                if action:
                    self.tiago_action = action

    def ingest_sim_workpiece(self, data: dict[str, Any]) -> None:
        with self._lock:
            self._mark_sim_rx()
            self.sim_active_workpiece = dict(data)
            holder = str(data.get("holder", "")).strip().lower()
            stage = str(data.get("stage", "")).strip().upper()

            if holder in ("tiago1", "tiago", "tiago_gripper", "tiago_arm") or (
                "TRANSIT_A_TO_B" in stage and holder not in ("poste_a_out", "poste_b_in")
            ):
                self.part_location = "tiago"
            elif holder in (
                "left_shuttle_1",
                "montrac_left",
                "shuttle_left",
                "left_slot_1",
                "left_slot_3",
                "n1",
            ) or ("MONTRAC" in stage and "LEFT" in stage):
                self.part_location = "montrac_a"
            elif holder in (
                "right_shuttle_1",
                "montrac_right",
                "shuttle_right",
                "right_slot_1",
                "right_slot_3",
                "n2",
            ) or ("MONTRAC" in stage and "RIGHT" in stage):
                self.part_location = "montrac_b"
            elif holder in ("yaskawa_hc10dt_1", "poste_a", "poste_a_ee", "poste_a_fixture", "hc10dt"):
                self.part_location = "yaskawa_a"
                self.yaskawa_a_gripper = "holding"
            elif holder in ("yaskawa_hc10_1", "poste_b", "poste_b_ee", "poste_b_fixture", "hc10"):
                self.part_location = "yaskawa_b"
                self.yaskawa_b_gripper = "holding"
            elif holder in ("staubli1", "staubli", "staubli_ee", "staubli_fixture"):
                self.part_location = "montrac_b"
            elif holder in ("poste_b_in", "poste_b_out", "expedition") or (
                "POSTE_B" in stage or "EXPED" in stage or "OP2" in stage
            ):
                self.part_location = "table_b"
            else:
                self.part_location = "table_a"

            if self.part_location != "yaskawa_a":
                self.yaskawa_a_gripper = "open"
            if self.part_location != "yaskawa_b":
                self.yaskawa_b_gripper = "open"

            pid = str(data.get("part_id", "")).strip()
            if pid:
                replaced = False
                for idx, existing in enumerate(self.sim_workpieces):
                    if str(existing.get("part_id", "")).strip() == pid:
                        self.sim_workpieces[idx] = dict(data)
                        replaced = True
                        break
                if not replaced:
                    self.sim_workpieces.append(dict(data))

    def ingest_sim_workpieces_json(self, raw_json: str) -> None:
        if not raw_json:
            return
        try:
            parsed = json.loads(raw_json)
        except json.JSONDecodeError:
            return
        items = (
            parsed.get("workpieces") or parsed.get("parts") or []
            if isinstance(parsed, dict)
            else parsed
            if isinstance(parsed, list)
            else []
        )
        with self._lock:
            self._mark_sim_rx()
            self.sim_workpieces = [w for w in items if isinstance(w, dict)]
            if self.sim_workpieces:
                active_cand = next(
                    (
                        w
                        for w in reversed(self.sim_workpieces)
                        if str(w.get("holder", "")).lower() != "expedition"
                        and "EXPED" not in str(w.get("stage", "")).upper()
                        and "SHIPPED" not in str(w.get("stage", "")).upper()
                    ),
                    self.sim_workpieces[-1],
                )
                self.ingest_sim_workpiece(active_cand)

    def ingest_sim_joints(self, robot: str, positions_rad: list[float]) -> None:
        if not positions_rad:
            return
        deg = [round(math.degrees(_safe_float(v)), 1) for v in positions_rad[:6]]
        while len(deg) < 6:
            deg.append(0.0)
        with self._lock:
            self._mark_sim_rx()
            if robot == "yaskawa_a":
                self.yaskawa_a_joints = deg
            elif robot == "yaskawa_b":
                self.yaskawa_b_joints = deg
            elif robot == "staubli":
                self.staubli_joints = deg

    def ingest_sim_shuttle(self, side: str, data: dict[str, Any]) -> None:
        with self._lock:
            self._mark_sim_rx()
            key = "left" if side.lower() == "left" else "right"
            self.sim_shuttles[key] = dict(data)
            seg = str(data.get("current_segment") or data.get("reached_target_slot") or "")
            s_val = _safe_float(data.get("s", 0.0))
            speed_mm = int(round(abs(_safe_float(data.get("speed", 0.0))) * 1000.0))
            prog = shuttle_segment_to_progress(seg, s_val, self.stations)
            if key == "left":
                self.montrac_a_progress = prog
                self.montrac_a_speed = speed_mm
                self.montrac_a_watchdog_ms = 18
            else:
                self.montrac_b_progress = prog
                self.montrac_b_speed = speed_mm
                self.montrac_b_watchdog_ms = 20

    def ingest_sim_tiago_pose(self, x: float, y: float, z: float, yaw: float) -> None:
        with self._lock:
            self._mark_sim_rx()
            wx = _safe_float(x, -12.80)
            wy = _safe_float(y, -1.55)
            self.sim_tiago_world_pose = {
                "x": round(wx, 3),
                "y": round(wy, 3),
                "z": round(_safe_float(z), 3),
                "yaw": round(_safe_float(yaw), 4),
            }
            self.tiago_progress = world_x_to_corridor_progress(wx, wy)

    def ingest_sim_tiago_cmd_vel(self, linear_x: float, angular_z: float) -> None:
        with self._lock:
            self._mark_sim_rx()
            self.sim_tiago_cmd_vel = {
                "linearX": round(_safe_float(linear_x), 3),
                "angularZ": round(_safe_float(angular_z), 3),
            }

    def ingest_sim_tiago_odom(self, linear_x: float, angular_z: float) -> None:
        with self._lock:
            self._mark_sim_rx()
            if abs(self.sim_tiago_cmd_vel.get("linearX", 0.0)) < 1e-4 and abs(
                self.sim_tiago_cmd_vel.get("angularZ", 0.0)
            ) < 1e-4:
                self.sim_tiago_cmd_vel = {
                    "linearX": round(_safe_float(linear_x), 3),
                    "angularZ": round(_safe_float(angular_z), 3),
                }

    def ingest_sim_tiago_joints(self, names: list[str], positions_rad: list[float]) -> None:
        if not positions_rad:
            return
        with self._lock:
            self._mark_sim_rx()
            if names and len(names) == len(positions_rad):
                by_name = {str(n): _safe_float(v) for n, v in zip(names, positions_rad)}
                if "torso_lift_joint" in by_name:
                    self.sim_tiago_torso_lift_m = round(max(0.0, min(0.35, by_name["torso_lift_joint"])), 4)
                arm_vals = [by_name.get(f"arm_{idx}_joint") for idx in range(1, 8)]
                if any(v is not None for v in arm_vals):
                    self.sim_tiago_arm_joints_deg = [
                        round(math.degrees(v), 1) if v is not None else self.sim_tiago_arm_joints_deg[i]
                        for i, v in enumerate(arm_vals)
                    ]
                lf = by_name.get("gripper_left_finger_joint")
                rf = by_name.get("gripper_right_finger_joint")
                if lf is not None or rf is not None:
                    opening = (lf if lf is not None else 0.0) + (rf if rf is not None else (lf or 0.0))
                    self.sim_tiago_gripper_m = round(max(0.0, opening), 4)
            elif len(positions_rad) >= 8:
                self.sim_tiago_torso_lift_m = round(max(0.0, min(0.35, _safe_float(positions_rad[0]))), 4)
                self.sim_tiago_arm_joints_deg = [
                    round(math.degrees(_safe_float(v)), 1) for v in positions_rad[1:8]
                ]

    def ingest_sim_human_pose(self, x: float, y: float, z: float, yaw: float) -> None:
        with self._lock:
            self._mark_sim_rx()
            self.sim_human_world_pose = {
                "x": round(_safe_float(x), 3),
                "y": round(_safe_float(y), 3),
                "z": round(_safe_float(z), 3),
                "yaw": round(_safe_float(yaw), 4),
            }

    def ingest_sim_inspection(self, station_id: str, data: dict[str, Any]) -> None:
        key = "poste_a" if "a" in station_id.lower() else "poste_b"
        with self._lock:
            self._mark_sim_rx()
            self.sim_inspections[key] = dict(data)

    def ingest_sim_traceability(self, raw_json_or_text: str) -> None:
        if not raw_json_or_text:
            return
        try:
            parsed = json.loads(raw_json_or_text)
        except json.JSONDecodeError:
            parsed = {"message": raw_json_or_text}
        if not isinstance(parsed, dict):
            parsed = {"message": str(parsed)}
        lvl_raw = str(parsed.get("level", "INFO")).upper()
        level = (
            "fault"
            if lvl_raw in ("ERROR", "ESTOP", "FAULT", "CRITICAL")
            else "warning"
            if lvl_raw in ("WARN", "WARNING", "NOK")
            else "ok"
            if lvl_raw in ("OK", "SUCCESS", "DONE")
            else "info"
        )
        src = str(parsed.get("source") or parsed.get("station_id") or parsed.get("station") or "SUP_L1")
        part_tag = f"[{parsed['part_id']}] " if parsed.get("part_id") else ""
        base_msg = (
            parsed.get("message")
            or parsed.get("summary")
            or parsed.get("detail")
            or parsed.get("action")
            or parsed.get("event_type")
            or parsed.get("event")
        )
        extras: list[str] = []
        payload_obj = parsed.get("payload") if isinstance(parsed.get("payload"), dict) else {}
        for k_src, fmt in (
            ("orientation_deg", "θ={:+.1f}°"),
            ("theta_deg", "θ={:+.1f}°"),
            ("height_mm", "z={:.0f}mm"),
            ("z_mm", "z={:.0f}mm"),
        ):
            val = parsed.get(k_src, payload_obj.get(k_src))
            if isinstance(val, (int, float)):
                extras.append(fmt.format(float(val)))
        if isinstance(parsed.get("conforming"), bool):
            extras.append("QC=OK" if parsed["conforming"] else "QC=NOK")
        msg_clean = f"{part_tag}{str(base_msg or 'Événement enregistré').replace('_', ' ')}"
        if extras:
            msg_clean = f"{msg_clean} · {' · '.join(extras)}"
        raw_ts = str(parsed.get("iso_time") or parsed.get("timestamp") or _clock_str())
        ts = raw_ts.split("T")[1][:8] if "T" in raw_ts else raw_ts[:8]
        with self._lock:
            self._mark_sim_rx()
            self._add_event(level, src, msg_clean, ts=ts)

    def ingest_sim_nl_proposal(self, data: dict[str, Any]) -> None:
        with self._lock:
            self._mark_sim_rx()
            self.sim_latest_proposal = dict(data)
            valid = bool(data.get("supervisor_valid", False))
            if not valid:
                self.rejected_commands += 1
            status = str(data.get("status", "PROPOSED"))
            self.vla_candidate = {
                "proposalId": str(data.get("proposal_id", "")),
                "proposalStatus": status,
                "naturalLanguageRequest": f"« {data.get('raw_instruction', '')} »",
                "sceneObservation": str(
                    data.get("visual_grounding_summary")
                    or "Ancrage visuel ZED 2 Salle 315 (rails A/B indépendants, transit TIAGo)."
                ),
                "pddlGoal": f"(batch_order qty={data.get('quantity', 1)} qc={data.get('enable_qc', True)} rework={data.get('enable_rework', True)})",
                "steps": [str(a) for a in (data.get("pddl_actions") or [])],
                "verdict": "validated" if valid else "rejected",
                "verdictReason": str(data.get("supervisor_reason") or status),
                "timestamp": _clock_str(),
            }

    # ------------------------------------------------------------------
    # Validation topologique fail-closed (vérifie absence de convoyeur A<->B)
    # ------------------------------------------------------------------
    def check_topological_validity(self, instruction: str) -> tuple[bool, str]:
        """Rejette de manière déterministe toute consigne exigeant un convoyeur A<->B ou violant E-Stop."""
        low = instruction.lower()
        if re.search(r"(ignor|bypass|outrepass|sans).*(estop|arrêt d'urgence|securit|sécurit)", low):
            return (
                False,
                "Rejet fail-closed L1 : contournement de l'arrêt d'urgence ou des sécurités interdit.",
            )
        mentions_b = any(tok in low for tok in ("zone b", "poste b", "bloc b", "îlot b", "ilot b"))
        mentions_conveyor_only = any(
            tok in low
            for tok in (
                "montrac seul",
                "sans tiago",
                "convoyeur entre",
                "pont inter",
                "pont montrac",
                "rail direct",
                "par montrac vers",
                "via montrac vers",
            )
        ) or (
            mentions_b
            and any(tok in low for tok in ("montrac", "navette", "convoyeur", "rail"))
            and not any(tok in low for tok in ("tiago", "reprise", "staubli", "stäubli"))
        )
        if mentions_conveyor_only:
            return (
                False,
                "Rejet déterministe L1 : aucun convoyeur ne relie le Bloc A et le Bloc B. "
                "TIAGo est l'unique lien inter-blocs autorisé.",
            )
        return True, ""

    # ------------------------------------------------------------------
    # Commandes opérateur (CLI / topic ROS 2 / pont WebSocket bidirectionnel)
    # ------------------------------------------------------------------
    def execute_cli_command(self, raw: str) -> str:
        cmd = raw.strip()
        if not cmd:
            return ""
        parts = cmd.split()
        verb = parts[0].lower()
        args = parts[1:]

        with self._lock:
            if verb == "start":
                scenario = args[0].lower() if args else "j2"
                loop = "--loop" in args or "loop" in args
                return self.start_scenario(scenario, loop=loop)
            if verb == "stop":
                return self.stop_cycle()
            if verb == "fault":
                kind = args[0].lower() if args else "estop"
                return self.inject_fault(kind)
            if verb == "reset":
                return self.reset_safety()
            if verb == "env":
                target = args[0].lower() if args else "gazebo"
                return self.set_environment(target)
            if verb == "propose":
                text = " ".join(args).strip()
                if not text:
                    return "Usage : propose <consigne en langage naturel>"
                return self.evaluate_natural_language(text)
            if verb == "status":
                return self.format_status_line()
            return f"Commande inconnue : '{cmd}'. Taper 'help' pour la liste des commandes."

    def start_scenario(self, scenario_key: str, loop: bool = False) -> str:
        with self._lock:
            if scenario_key not in self.scenarios:
                valid = ", ".join(self.scenarios.keys())
                return f"Scénario inconnu '{scenario_key}'. Disponibles : {valid}"

            if self.state == "FAULT_LOCKED" or self.hardware_estop_engaged or self.watchdog_fault_injected:
                self.rejected_commands += 1
                self._add_event(
                    "fault",
                    "Superviseur L1",
                    f"Démarrage '{scenario_key}' refusé : cellule verrouillée en sécurité.",
                )
                return "REFUSÉ : sécurité active (FAULT_LOCKED). Acquitter puis exécuter `reset`."

            if self.state == "RUNNING":
                return f"Un cycle ({self.active_scenario_key}) est déjà en cours. Utiliser `stop` d'abord."

            self.part_location = "table_a"
            self.yaskawa_a_pose = "home"
            self.yaskawa_a_joints = list(JOINTS_HOME)
            self.yaskawa_a_gripper = "open"
            self.yaskawa_b_pose = "home"
            self.yaskawa_b_joints = list(JOINTS_HOME)
            self.yaskawa_b_gripper = "open"
            self.montrac_a_progress = self.stations["blue"]
            self.montrac_b_progress = self.stations["blue"]
            self.montrac_a_speed = 0
            self.montrac_b_speed = 0
            self.tiago_progress = 0.25 if scenario_key == "j2" else 0.50

            self.loop_mode = loop
            self._load_scenario_steps(scenario_key, activate=True)
            self.state = "RUNNING"
            mode_txt = "en boucle" if loop else "cycle unique"
            self._add_event(
                "ok",
                "Superviseur L1",
                f"Scénario {self.scenarios[scenario_key]['code']} démarré ({mode_txt}).",
            )
            return f"OK : scénario {self.scenarios[scenario_key]['code']} lancé ({mode_txt})."

    def stop_cycle(self) -> str:
        with self._lock:
            self.loop_mode = False
            self.montrac_a_speed = 0
            self.montrac_b_speed = 0
            if self.state == "RUNNING":
                self.state = "IDLE"
                self.active_step_idx = -1
                self.yaskawa_a_action = "Arrêt contrôlé par l'orchestrateur"
                self.yaskawa_b_action = "En veille"
                self._add_event("warning", "Superviseur L1", "Arrêt contrôlé du cycle demandé.")
                return "Cycle arrêté proprement (état IDLE)."
            return f"Aucun cycle local actif (état actuel : {self.state})."

    def inject_fault(self, kind: str) -> str:
        with self._lock:
            if kind == "estop":
                self.hardware_estop_engaged = True
                self.sim_safety["estop_active"] = True
                reason = "Arrêt d'urgence enclenché sur la cellule Salle 315."
                source = "Sécurité matérielle"
            elif kind == "watchdog":
                self.watchdog_fault_injected = True
                self.montrac_a_watchdog_ms = 1420
                reason = "Expiration chien de garde Montrac (> 500 ms) : appel on_deactivate()."
                source = "Montrac SystemInterface"
            else:
                return "Usage : fault estop | fault watchdog"

            was_running = self.state == "RUNNING"
            self.state = "FAULT_LOCKED"
            self.loop_mode = False
            self.montrac_a_speed = 0
            self.montrac_b_speed = 0
            self.yaskawa_a_action = "Mouvement inhibé (défaut sécurité)"
            if 0 <= self.active_step_idx < len(self.steps):
                self.steps[self.active_step_idx].status = "fault"
                self.steps[self.active_step_idx].detail = reason

            if was_running:
                self.faulted_cycles += 1
                self._record_cycle("arret_securite", reason)

            self._add_event("fault", source, reason)
            self._add_event("fault", "Superviseur L1", "Cellule verrouillée en état FAULT_LOCKED.")
            return f"DÉFAUT ACTIF : {reason} Cellule verrouillée (FAULT_LOCKED)."

    def reset_safety(self) -> str:
        with self._lock:
            self.hardware_estop_engaged = False
            self.sim_safety["estop_active"] = False
            self.watchdog_fault_injected = False
            self.montrac_a_watchdog_ms = 24
            self.montrac_b_watchdog_ms = 28
            self.state = "IDLE"
            self.active_step_idx = -1
            self.yaskawa_a_pose = "home"
            self.yaskawa_a_joints = list(JOINTS_HOME)
            self.yaskawa_a_gripper = "open"
            self.yaskawa_a_action = "Prêt après réarmement"
            self.part_location = "table_a"
            self.montrac_a_progress = self.stations["blue"]
            self.montrac_a_speed = 0
            self._load_scenario_steps(self.active_scenario_key, activate=False)
            self._add_event("ok", "Superviseur L1", "Sécurité acquittée : retour en état IDLE.")
            return "OK : défauts acquittés, superviseur de retour en état IDLE."

    def set_environment(self, target: str) -> str:
        with self._lock:
            if target in ("gazebo", "sim", "simu", "true"):
                self.gz_sim = True
                self._add_event("info", "Superviseur L1", "Bascule mode jumeau numérique (gz_sim:=true).")
                return "Mode basculé : Gazebo Harmonic (gz_sim:=true)."
            if target in ("real", "reel", "réel", "false"):
                self.gz_sim = False
                self._add_event("info", "Superviseur L1", "Bascule mode plateau réel (gz_sim:=false).")
                return "Mode basculé : Plateau réel Salle 315 (gz_sim:=false)."
            return "Usage : env real | env gazebo"

    def evaluate_natural_language(self, request_text: str) -> str:
        """Validateur déterministe fail-closed pour la piste J3 / Lot 8 (LLM/VLM -> PDDL -> L1)."""
        with self._lock:
            low = request_text.lower()
            now_str = _clock_str()

            if self.state == "FAULT_LOCKED" or self.hardware_estop_engaged or self.watchdog_fault_injected:
                self.rejected_commands += 1
                self.vla_candidate = {
                    "naturalLanguageRequest": f"« {request_text} »",
                    "sceneObservation": "Caméra Zone A : cellule immobilisée sous défaut sécurité.",
                    "pddlGoal": "(blocked-by-safety salle_315)",
                    "steps": ["reject_all_actions(hardware_estop_or_watchdog)"],
                    "verdict": "rejected",
                    "verdictReason": "Rejet déterministe L1 : cellule verrouillée en sécurité (FAULT_LOCKED).",
                    "timestamp": now_str,
                }
                self._add_event("fault", "Superviseur L1", "Plan candidat rejeté : sécurité verrouillée.")
                return "REJETÉ (fail-closed) : la cellule est verrouillée en sécurité."

            topo_ok, topo_reason = self.check_topological_validity(request_text)
            if not topo_ok:
                self.rejected_commands += 1
                self.vla_candidate = {
                    "naturalLanguageRequest": f"« {request_text} »",
                    "sceneObservation": "ZED 2 A/B : aucun convoyeur ne relie Bloc A et Bloc B ; rails locaux séparés.",
                    "pddlGoal": "(invalid-interbloc-conveyor-or-safety-bypass)",
                    "steps": [
                        "pick_from_table(yaskawa_hc10dt, cube_01, zone_a)",
                        "move_shuttle_interbloc(n1, zone_a, zone_b) [INVALIDE — AUCUN CONVOYEUR A-B]",
                    ],
                    "verdict": "rejected",
                    "verdictReason": topo_reason,
                    "timestamp": now_str,
                    "alternativeSummary": "Utiliser TIAGo (PICK_POSTE_A_DELIVER_POSTE_B) pour tout transfert Bloc A → Bloc B.",
                }
                self._record_cycle("rejet_superviseur", topo_reason)
                self._add_event("warning", "Superviseur L1", topo_reason)
                return f"REJETÉ par L1 (fail-closed) : {topo_reason}"

            if "kuka" in low:
                self.rejected_commands += 1
                self.vla_candidate = {
                    "naturalLanguageRequest": f"« {request_text} »",
                    "sceneObservation": "KUKA KR6 est en veille hors cycle actif.",
                    "pddlGoal": "(operate-out-of-scope-robot kuka)",
                    "steps": ["dispatch_robot(kuka_kr6) [NON AUTORISÉ]"],
                    "verdict": "rejected",
                    "verdictReason": "Rejet déterministe L1 : robot KUKA KR6 hors périmètre d'assemblage actif.",
                    "timestamp": now_str,
                }
                self._record_cycle("rejet_superviseur", "Plan rejeté : robot KUKA hors périmètre")
                self._add_event("warning", "Superviseur L1", "Plan candidat rejeté : KUKA hors périmètre.")
                return "REJETÉ par L1 : KUKA KR6 n'est pas autorisé dans le cycle actif."

            mentions_b_or_batch = any(
                tok in low
                for tok in (
                    "zone b",
                    "poste b",
                    "bloc b",
                    "îlot b",
                    "tiago",
                    "pièce",
                    "piece",
                    "part",
                    "assemble",
                    "produce",
                    "staubli",
                    "stäubli",
                    "conform",
                )
            )
            mentions_alt = (
                "alternatif" in low
                or "reconfig" in low
                or "navette d'abord" in low
                or "invers" in low
            )

            if mentions_b_or_batch and not mentions_alt and "j1" not in low:
                self.vla_candidate = {
                    "naturalLanguageRequest": f"« {request_text} »",
                    "sceneObservation": "ZED 2 A/B : Bloc A prêt, couloir nord dégagé pour TIAGo, Bloc B + ZED 2 QC prêts.",
                    "pddlGoal": "(and (part-at-handoff cube_01 zone_b) (qc-conforming cube_01))",
                    "steps": [
                        "pick_from_table(yaskawa_hc10dt, cube_01, zone_a)",
                        "stage_for_tiago_handoff(yaskawa_hc10dt, cube_01, poste_a_out)",
                        "tiago_transfer_interzone(tiago, cube_01, poste_a_out, poste_b_in)",
                        "pick_from_tiago_handoff(yaskawa_hc10, cube_01, poste_b_in)",
                        "zed2_inspect_and_dispatch(zed2_poste_b, cube_01)",
                    ],
                    "verdict": "validated",
                    "verdictReason": "Plan inter-blocs validé : transfert Bloc A → Bloc B assuré exclusivement par TIAGo.",
                    "timestamp": now_str,
                }
                self._add_event("ok", "Superviseur L1", "Plan candidat inter-blocs (TIAGo A→B) validé.")
                if self.state == "IDLE" and not self.sim_connected and "j2" in self.scenarios:
                    self.start_scenario("j2", loop=False)
                return "VALIDÉ par L1 : plan inter-blocs avec TIAGo autorisé."

            chosen_key = "j1_alt" if mentions_alt else "j1"
            self.vla_candidate = {
                "naturalLanguageRequest": f"« {request_text} »",
                "sceneObservation": "Caméra Bloc A : pièce sur table A, navette locale N1 en station Bleue.",
                "pddlGoal": "(and (part-at-table cube_01 zone_a) (cycle-completed zone_a))",
                "steps": [
                    "move_shuttle_local(n1, rail_a, station_bleue_a, station_verte_a)"
                    if mentions_alt
                    else "pick_from_table(yaskawa_hc10dt, cube_01, zone_a)",
                    "pick_from_table(yaskawa_hc10dt, cube_01, zone_a)"
                    if mentions_alt
                    else "place_on_shuttle(yaskawa_hc10dt, cube_01, n1, station_bleue_a, rail_a, zone_a)",
                    "place_on_shuttle(yaskawa_hc10dt, cube_01, n1, station_verte_a, rail_a, zone_a)"
                    if mentions_alt
                    else "move_shuttle_local(n1, rail_a, station_bleue_a, station_verte_a)",
                    "pick_from_shuttle(yaskawa_hc10dt, cube_01, n1, station_verte_a, rail_a, zone_a)",
                ],
                "verdict": "validated",
                "verdictReason": f"Plan intra-bloc conforme au domaine PDDL ({chosen_key}). Autorisé par L1.",
                "timestamp": now_str,
            }
            self._add_event("ok", "Superviseur L1", f"Plan candidat validé -> exécution {chosen_key.upper()}.")
            if self.state == "IDLE" and not self.sim_connected:
                self.start_scenario(chosen_key, loop=False)
            return f"VALIDÉ par L1 : plan intra-bloc ({chosen_key}) autorisé."

    def format_status_line(self) -> str:
        with self._lock:
            snap = self.to_cell_snapshot()
            return (
                f"État={snap['orchestratorState']} | SimLive={self.sim_connected} | "
                f"Scénario={snap['activeScenarioCode']} | Pièce={snap['partLocation']} | "
                f"Cycles={snap['kpis']['completedCycles']} | Rejets={self.rejected_commands}"
            )

    # ------------------------------------------------------------------
    # Boucle temps réel déterministe (appelée à 10 Hz)
    # ------------------------------------------------------------------
    def tick(self, dt: float) -> None:
        with self._lock:
            if not self.watchdog_fault_injected and not self.sim_shuttles:
                t_ms = int(22 + 6 * abs(math.sin((self.cycle_elapsed_s + time.monotonic()) * 1.7)))
                self.montrac_a_watchdog_ms = t_ms
                self.montrac_b_watchdog_ms = t_ms + 3
            elif self.watchdog_fault_injected:
                self.montrac_a_watchdog_ms = min(9999, self.montrac_a_watchdog_ms + int(dt * 1000))

            if self.hardware_estop_engaged or self.montrac_a_watchdog_ms > self.watchdog_timeout_ms:
                if self.state != "FAULT_LOCKED":
                    self.state = "FAULT_LOCKED"
                    self.montrac_a_speed = 0
                    self.montrac_b_speed = 0
                return

            # Si la simulation ROS 2 `/usine40/*` est connectée, préserver intégralement les poses
            # et états réels (notamment TIAGo stationné en poste_a, poste_b ou expedition entre étapes)
            if self.sim_connected:
                return

            if self.state != "RUNNING" or not (0 <= self.active_step_idx < len(self.steps)):
                if not self.sim_connected:
                    self.montrac_a_speed = 0
                    self.montrac_b_speed = 0
                return

            self.cycle_elapsed_s += dt
            step = self.steps[self.active_step_idx]
            step.elapsed_s += dt
            progress = min(1.0, step.elapsed_s / max(0.1, step.target_duration_s))

            self._apply_step_kinematics(step.action, progress)

            if progress >= 1.0:
                step.status = "done"
                step.detail = "Terminé"
                next_idx = self.active_step_idx + 1
                if next_idx < len(self.steps):
                    self.active_step_idx = next_idx
                    self.steps[next_idx].status = "active"
                    self._add_event(
                        "info",
                        "Superviseur L1",
                        f"Étape {next_idx + 1}/{len(self.steps)} : {self.steps[next_idx].label}.",
                    )
                else:
                    self.completed_cycles += 1
                    self._record_cycle(
                        "conforme",
                        f"Cycle {self.scenarios[self.active_scenario_key]['code']} validé sans anomalie",
                    )
                    self._add_event(
                        "ok",
                        "Superviseur L1",
                        f"Cycle #{self.cycle_number} terminé ({self.cycle_elapsed_s:.1f} s).",
                    )
                    self.cycle_number += 1
                    if self.loop_mode:
                        self.part_location = "table_a"
                        self.montrac_a_progress = self.stations["blue"]
                        self.montrac_b_progress = self.stations["blue"]
                        self.tiago_progress = 0.25 if self.active_scenario_key == "j2" else 0.50
                        self._load_scenario_steps(self.active_scenario_key, activate=True)
                    else:
                        self.state = "IDLE"
                        self.active_step_idx = -1
                        self.montrac_a_speed = 0
                        self.montrac_b_speed = 0
                        self.yaskawa_a_pose = "home"
                        self.yaskawa_a_joints = list(JOINTS_HOME)
                        self.yaskawa_a_action = "Cycle terminé — en attente"

    def _apply_step_kinematics(self, action: str, t: float) -> None:
        blue = self.stations["blue"]
        green = self.stations["green"]
        self.montrac_a_speed = 0
        self.montrac_b_speed = 0

        if action in ("check_preconditions", "check_preconditions_j2"):
            self.yaskawa_a_pose = "home"
            self.yaskawa_a_joints = list(JOINTS_HOME)
            self.yaskawa_a_gripper = "open"
            self.yaskawa_a_action = "Vérification préconditions L1"
            self.part_location = "table_a"

        elif action == "yaskawa_a_pick_table":
            self.yaskawa_a_pose = "table"
            self.yaskawa_a_joints = _lerp_joints(JOINTS_HOME, JOINTS_TABLE, min(1.0, t * 1.4))
            self.yaskawa_a_gripper = "holding" if t >= 0.55 else "open"
            self.part_location = "yaskawa_a" if t >= 0.55 else "table_a"
            self.yaskawa_a_action = "Prise de la pièce sur table Bloc A"

        elif action == "yaskawa_a_stage_handoff":
            if t < 0.5:
                sub = t * 2.0
                self.yaskawa_a_pose = "table"
                self.yaskawa_a_joints = _lerp_joints(JOINTS_HOME, JOINTS_TABLE, sub)
                self.yaskawa_a_gripper = "holding" if sub > 0.5 else "open"
                self.part_location = "yaskawa_a" if sub > 0.5 else "table_a"
                wp_x, wp_y = _lerp(-10.12, -10.44, sub), -3.00
            else:
                sub = (t - 0.5) * 2.0
                self.yaskawa_a_pose = "tiago_handover"
                self.yaskawa_a_joints = _lerp_joints(JOINTS_TABLE, JOINTS_HANDOVER, sub)
                self.yaskawa_a_gripper = "holding" if sub < 0.8 else "open"
                self.part_location = "yaskawa_a" if sub < 0.8 else "table_a"
                wp_x, wp_y = _lerp(-10.44, -11.08, sub), _lerp(-3.00, -2.98, sub)
            self.tiago_progress = 0.25
            self.sim_tiago_world_pose = {"x": -11.66, "y": -2.98, "z": 0.0, "yaw": 0.0}
            self.sim_active_workpiece = {
                "part_id": f"P{self.cycle_number:02d}",
                "stage": "OP1_POSTE_A",
                "holder": "poste_a_out" if t >= 0.9 else ("yaskawa_hc10dt_1" if self.part_location == "yaskawa_a" else "poste_a"),
                "quality_status": "OP1_OK",
                "pose": {"x": round(wp_x, 3), "y": round(wp_y, 3), "z": 0.6324, "yaw": 0.0},
            }
            self.tiago_action = "Accosté en baie centrale poste_a (-11.66, -2.98)"
            self.yaskawa_a_action = "Assemblage Op1 & dépose point d'échange TIAGo (poste_a_out)"

        elif action == "yaskawa_a_place_blue":
            self.yaskawa_a_pose = "station_blue"
            self.yaskawa_a_joints = _lerp_joints(JOINTS_TABLE, JOINTS_BLUE, t)
            self.yaskawa_a_gripper = "holding" if t < 0.75 else "open"
            self.part_location = "yaskawa_a" if t < 0.75 else "montrac_a"
            self.yaskawa_a_action = "Dépose sur la navette locale N1 (station Bleue)"

        elif action == "yaskawa_a_pick_and_place_blue":
            if t < 0.5:
                sub = t * 2.0
                self.yaskawa_a_pose = "table"
                self.yaskawa_a_joints = _lerp_joints(JOINTS_HOME, JOINTS_TABLE, sub)
                self.yaskawa_a_gripper = "holding" if sub > 0.6 else "open"
                self.part_location = "yaskawa_a" if sub > 0.6 else "table_a"
            else:
                sub = (t - 0.5) * 2.0
                self.yaskawa_a_pose = "station_blue"
                self.yaskawa_a_joints = _lerp_joints(JOINTS_TABLE, JOINTS_BLUE, sub)
                self.yaskawa_a_gripper = "holding" if sub < 0.75 else "open"
                self.part_location = "yaskawa_a" if sub < 0.75 else "montrac_a"
            self.yaskawa_a_action = "Chargement de la pièce sur navette locale N1"

        elif action == "montrac_a_blue_to_green":
            self.yaskawa_a_pose = "home"
            self.yaskawa_a_joints = _lerp_joints(JOINTS_BLUE, JOINTS_HOME, min(1.0, t * 2.0))
            self.yaskawa_a_gripper = "open"
            self.yaskawa_a_action = "Dégagé pendant le convoyage local"
            self.montrac_a_progress = _lerp(blue, green, t)
            self.montrac_a_speed = self.montrac_speed_nominal if t < 0.96 else 0
            self.part_location = "montrac_a"

        elif action == "montrac_a_blue_to_green_empty":
            self.yaskawa_a_pose = "home"
            self.yaskawa_a_action = "En attente du positionnement navette locale"
            self.montrac_a_progress = _lerp(blue, green, t)
            self.montrac_a_speed = self.montrac_speed_nominal if t < 0.96 else 0
            self.part_location = "table_a"

        elif action == "yaskawa_a_pick_and_place_green":
            self.montrac_a_progress = green
            if t < 0.45:
                sub = t / 0.45
                self.yaskawa_a_pose = "table"
                self.yaskawa_a_joints = _lerp_joints(JOINTS_HOME, JOINTS_TABLE, sub)
                self.yaskawa_a_gripper = "holding" if sub > 0.6 else "open"
                self.part_location = "yaskawa_a" if sub > 0.6 else "table_a"
            else:
                sub = (t - 0.45) / 0.55
                self.yaskawa_a_pose = "station_green"
                self.yaskawa_a_joints = _lerp_joints(JOINTS_TABLE, JOINTS_GREEN, sub)
                self.yaskawa_a_gripper = "holding" if sub < 0.78 else "open"
                self.part_location = "yaskawa_a" if sub < 0.78 else "montrac_a"
            self.yaskawa_a_action = "Dépose reconfigurée en station Verte"

        elif action == "montrac_a_green_to_blue_loaded":
            self.yaskawa_a_pose = "home"
            self.yaskawa_a_joints = _lerp_joints(JOINTS_GREEN, JOINTS_HOME, min(1.0, t * 2.0))
            self.yaskawa_a_gripper = "open"
            self.yaskawa_a_action = "Dégagé pendant le convoyage retour"
            self.montrac_a_progress = _lerp(green, blue, t)
            self.montrac_a_speed = self.montrac_speed_nominal if t < 0.96 else 0
            self.part_location = "montrac_a"

        elif action == "yaskawa_a_pick_green_to_table":
            self.montrac_a_progress = green
            if t < 0.5:
                sub = t * 2.0
                self.yaskawa_a_pose = "station_green"
                self.yaskawa_a_joints = _lerp_joints(JOINTS_HOME, JOINTS_GREEN, sub)
                self.yaskawa_a_gripper = "holding" if sub > 0.6 else "open"
                self.part_location = "yaskawa_a" if sub > 0.6 else "montrac_a"
            else:
                sub = (t - 0.5) * 2.0
                self.yaskawa_a_pose = "table"
                self.yaskawa_a_joints = _lerp_joints(JOINTS_GREEN, JOINTS_TABLE, sub)
                self.yaskawa_a_gripper = "holding" if sub < 0.8 else "open"
                self.part_location = "yaskawa_a" if sub < 0.8 else "table_a"
            self.yaskawa_a_action = "Reprise en station Verte et retour table"

        elif action == "yaskawa_a_pick_blue_to_table":
            self.montrac_a_progress = blue
            if t < 0.5:
                sub = t * 2.0
                self.yaskawa_a_pose = "station_blue"
                self.yaskawa_a_joints = _lerp_joints(JOINTS_HOME, JOINTS_BLUE, sub)
                self.yaskawa_a_gripper = "holding" if sub > 0.6 else "open"
                self.part_location = "yaskawa_a" if sub > 0.6 else "montrac_a"
            else:
                sub = (t - 0.5) * 2.0
                self.yaskawa_a_pose = "table"
                self.yaskawa_a_joints = _lerp_joints(JOINTS_BLUE, JOINTS_TABLE, sub)
                self.yaskawa_a_gripper = "holding" if sub < 0.8 else "open"
                self.part_location = "yaskawa_a" if sub < 0.8 else "table_a"
            self.yaskawa_a_action = "Reprise finale en station Bleue"

        elif action == "montrac_a_return_blue":
            self.yaskawa_a_pose = "home"
            self.yaskawa_a_joints = _lerp_joints(JOINTS_TABLE, JOINTS_HOME, min(1.0, t * 1.5))
            self.yaskawa_a_gripper = "open"
            self.yaskawa_a_action = "Retour position de repos"
            self.montrac_a_progress = _lerp(green, blue, t)
            self.montrac_a_speed = 160 if t < 0.95 else 0
            self.part_location = "table_a"

        elif action == "tiago_transit_a_to_b":
            self.tiago_progress = _lerp(0.25, 0.75, t)
            if t < 0.5:
                u = t * 2.0
                tx = _lerp(-11.66, -12.80, u)
                ty = _lerp(-2.98, -3.05, u)
                tyaw = 0.0 if u < 0.2 else math.pi
            else:
                u = (t - 0.5) * 2.0
                tx = _lerp(-12.80, -13.96, u)
                ty = _lerp(-3.05, -3.18, u)
                tyaw = math.pi
            self.sim_tiago_world_pose = {"x": round(tx, 3), "y": round(ty, 3), "z": 0.0, "yaw": round(tyaw, 4)}
            gx = tx + 0.58 * math.cos(tyaw)
            gy = ty + 0.58 * math.sin(tyaw)
            self.sim_active_workpiece = {
                "part_id": f"P{self.cycle_number:02d}",
                "stage": "IN_TRANSIT_A_TO_B",
                "holder": "tiago1",
                "quality_status": "OP1_OK",
                "pose": {"x": round(gx, 3), "y": round(gy, 3), "z": 0.92, "yaw": round(tyaw, 4)},
            }
            self.tiago_action = "Transport exclusif Bloc A → Bloc B via baie centrale (PICK_POSTE_A_DELIVER_POSTE_B)"
            self.part_location = "tiago"
            self.yaskawa_a_pose = "tiago_handover" if t < 0.15 else "home"
            self.yaskawa_a_joints = JOINTS_HANDOVER if t < 0.15 else list(JOINTS_HOME)

        elif action == "yaskawa_b_unload_to_table":
            self.tiago_progress = 0.75
            self.sim_tiago_world_pose = {"x": -13.96, "y": -3.18, "z": 0.0, "yaw": round(math.pi, 4)}
            self.tiago_action = "Dépose confirmée en poste_b_in (-14.54, -3.18) — stationné au Poste B"
            if t < 0.5:
                sub = t * 2.0
                self.yaskawa_b_pose = "tiago_handover"
                self.yaskawa_b_joints = _lerp_joints(JOINTS_HOME, JOINTS_HANDOVER, sub)
                self.yaskawa_b_gripper = "holding" if sub > 0.5 else "open"
                self.part_location = "yaskawa_b" if sub > 0.5 else "table_b"
                wp_x, wp_y = _lerp(-14.54, -14.85, sub), _lerp(-3.18, -3.08, sub)
            else:
                sub = (t - 0.5) * 2.0
                self.yaskawa_b_pose = "table"
                self.yaskawa_b_joints = _lerp_joints(JOINTS_HANDOVER, JOINTS_TABLE, sub)
                self.yaskawa_b_gripper = "holding" if sub < 0.8 else "open"
                self.part_location = "yaskawa_b" if sub < 0.8 else "table_b"
                wp_x, wp_y = _lerp(-14.85, -15.32, sub), _lerp(-3.08, -3.00, sub)
            self.sim_active_workpiece = {
                "part_id": f"P{self.cycle_number:02d}",
                "stage": "POSTE_B_QC",
                "holder": "yaskawa_hc10_1" if self.part_location == "yaskawa_b" else "poste_b_fixture",
                "quality_status": "CONFORMING" if t > 0.75 else "OP2_IN_PROGRESS",
                "pose": {"x": round(wp_x, 3), "y": round(wp_y, 3), "z": 0.6324, "yaw": 0.0},
            }
            self.yaskawa_b_action = "Prise en poste_b_in, Op2 HC10 & contrôle qualité ZED 2"

    def _record_cycle(self, outcome: str, note: str) -> None:
        dur = round(max(0.5, self.cycle_elapsed_s), 1)
        if outcome == "conforme":
            self.cycle_durations_s.append(dur)
            if len(self.cycle_durations_s) > 10:
                self.cycle_durations_s = self.cycle_durations_s[-10:]
        sc = self.scenarios[self.active_scenario_key]
        self.recent_cycles.insert(
            0,
            {
                "id": f"C-{self.cycle_number:03d}",
                "timestamp": _clock_str(),
                "scenario": sc["code"],
                "zone": "Bloc A → TIAGo → Bloc B" if self.active_scenario_key == "j2" else "Bloc A",
                "durationS": dur,
                "outcome": outcome,
                "note": note,
            },
        )
        if len(self.recent_cycles) > 12:
            self.recent_cycles = self.recent_cycles[:12]

    # ------------------------------------------------------------------
    # Sérialisation télémétrie (contrat JSON complet pour l'IHM React)
    # ------------------------------------------------------------------
    def _station_name(self, progress: float) -> str:
        if abs(progress - self.stations["blue"]) < 0.03:
            return "blue"
        if abs(progress - self.stations["green"]) < 0.03:
            return "green"
        if abs(progress - self.stations["yellow"]) < 0.04:
            return "yellow"
        if abs(progress - self.stations["red"]) < 0.04:
            return "red"
        return "transit"

    def to_safety_payload(self) -> dict[str, Any]:
        wd_fault = self.watchdog_fault_injected or self.montrac_a_watchdog_ms > self.watchdog_timeout_ms
        sim_estop = bool(self.sim_safety.get("estop_active", False))
        estop = self.hardware_estop_engaged or sim_estop
        veto = str(self.sim_safety.get("active_veto_reason", "")).strip()
        human_zone = bool(self.sim_safety.get("human_in_collab_zone", False))
        speed_scale = _safe_float(self.sim_safety.get("tiago_speed_scale", 1.0), 1.0)

        if estop or wd_fault:
            summary = (
                "Arrêt d'urgence global actif en Salle 315."
                if estop
                else f"Expiration du chien de garde Montrac ({self.montrac_a_watchdog_ms} ms > {self.watchdog_timeout_ms} ms)."
            )
            return {
                "status": "estop_triggered",
                "hardwareEstopEngaged": estop,
                "watchdogFault": wd_fault,
                "summary": summary,
                "operatorGuidance": (
                    "Vérifier l'absence d'obstacle dans les Blocs A/B et le couloir TIAGo, "
                    "déverrouiller l'arrêt d'urgence puis acquitter (`Réinitialiser` / `reset`)."
                ),
                "lastCheckTimestamp": _clock_str(),
            }
        if human_zone or speed_scale < 0.99 or veto:
            dist = _safe_float(self.sim_safety.get("human_distance_m", 99.0), 99.0)
            return {
                "status": "warning",
                "hardwareEstopEngaged": False,
                "watchdogFault": False,
                "summary": f"Surveillance collaborative ISO/TS 15066 active ({veto or 'opérateur en zone'}).",
                "operatorGuidance": (
                    f"Distance opérateur : {dist:.2f} m — vitesse TIAGo modulée à {int(round(speed_scale * 100))} %."
                ),
                "lastCheckTimestamp": _clock_str(),
            }
        if self.vla_candidate.get("verdict") == "rejected":
            return {
                "status": "warning",
                "hardwareEstopEngaged": False,
                "watchdogFault": False,
                "summary": "Dernière consigne langage naturel rejetée par le superviseur L1 (fail-closed).",
                "operatorGuidance": str(self.vla_candidate.get("verdictReason", "")),
                "lastCheckTimestamp": _clock_str(),
            }
        return {
            "status": "nominal",
            "hardwareEstopEngaged": False,
            "watchdogFault": False,
            "summary": "Sécurité nominale — superviseur L1 & liaison TIAGo Bloc A ↔ Bloc B actifs.",
            "operatorGuidance": "Pilotage bidirectionnel IHM / ROS 2 opérationnel.",
            "lastCheckTimestamp": _clock_str(),
        }

    def _map_sim_station_status(self, station_id: str, default: str = "ready") -> str:
        st = self.sim_stations.get(station_id)
        if not st:
            return default
        s = str(st.get("state", "IDLE")).upper()
        if s in ("ESTOP", "FAULT", "ERROR", "BLOCKED"):
            return "fault"
        if s in ("BUSY", "RUNNING", "MOVING", "INSPECTING", "REWORKING", "ACTIVE"):
            return "active"
        if s in ("PAUSED", "WARNING", "SLOW"):
            return "warning"
        return "ready"

    def _build_steps_payload(self) -> list[dict[str, Any]]:
        if self.sim_connected and self.sim_plan_steps:
            mapped: list[dict[str, Any]] = []
            sim_line = str(self.sim_kpi.get("line_state", "IDLE")).upper()
            sim_fault = (
                self.hardware_estop_engaged
                or bool(self.sim_safety.get("estop_active", False))
                or sim_line in ("FAULT", "ESTOP", "ERROR")
            )
            comp = self.sim_plan_completed_steps
            for idx, item in enumerate(self.sim_plan_steps):
                raw_act = str(
                    item.get("action_name")
                    or item.get("action")
                    or item.get("name")
                    or item.get("raw_action")
                    or item.get("pddl")
                    or f"step_{idx + 1}"
                ).strip()
                explicit_st = item.get("status")
                if explicit_st is not None and str(explicit_st).strip():
                    raw_st = str(explicit_st).strip().lower()
                    st_norm = (
                        "done"
                        if raw_st in ("done", "completed", "ok")
                        else "active"
                        if raw_st in ("active", "running", "in_progress")
                        else "fault"
                        if raw_st in ("fault", "error", "estop", "failed")
                        else "rejected"
                        if raw_st == "rejected"
                        else "pending"
                    )
                else:
                    done_count = comp if comp is not None else 0
                    if sim_line == "COMPLETED" or idx < done_count:
                        st_norm = "done"
                    elif idx == done_count and sim_fault:
                        st_norm = "fault"
                    elif idx == done_count and sim_line in ("RUNNING", "PAUSED"):
                        st_norm = "active"
                    else:
                        st_norm = "pending"

                owner = str(item.get("station") or item.get("actor") or "")
                if not owner:
                    low = raw_act.lower()
                    owner = (
                        "TIAGo"
                        if (
                            "tiago" in low
                            or "deliver" in low
                            or "transit" in low
                            or "transfer" in low
                            or "fetch" in low
                            or ("poste_a" in low and "poste_b" in low)
                            or "stock" in low
                            or "expedition" in low
                        )
                        else "ZED 2 QC"
                        if "inspect" in low or "qc" in low or "zed" in low
                        else "Stäubli TX2"
                        if "staubli" in low
                        else "Montrac Local"
                        if "montrac" in low or "convey" in low or "stage_for_rework" in low
                        else "Yaskawa HC10DT"
                        if "poste_a" in low or "hc10dt" in low or "op1" in low
                        else "Yaskawa HC10"
                        if "poste_b" in low or "hc10" in low or "op2" in low
                        else "Stäubli TX2"
                        if "rework" in low
                        else "Superviseur L1"
                    )
                part_id = str(item.get("part_id", "")).strip()
                if not part_id and isinstance(item.get("arguments"), list):
                    for arg in item["arguments"]:
                        arg_str = str(arg).strip()
                        if arg_str.lower().startswith(("part", "p0", "p1", "p2", "cube")):
                            part_id = arg_str
                            break
                label = f"{raw_act} [{part_id}]" if part_id and part_id not in raw_act else raw_act
                dur_val = item.get("duration")
                step_entry: dict[str, Any] = {
                    "index": idx + 1,
                    "label": label,
                    "owner": owner,
                    "status": st_norm,
                    "detail": str(item.get("detail") or item.get("raw_action") or ""),
                }
                if dur_val is not None and st_norm == "done":
                    step_entry["durationS"] = round(_safe_float(dur_val), 1)
                mapped.append(step_entry)
            return mapped

        return [
            {
                "index": st.index,
                "label": st.label,
                "owner": st.owner,
                "status": st.status,
                **(
                    {"durationS": round(st.elapsed_s, 1)}
                    if st.status in ("done", "active")
                    else {}
                ),
                "detail": st.detail,
            }
            for st in self.steps
        ]

    def to_cell_snapshot(self) -> dict[str, Any]:
        with self._lock:
            now_str = _clock_str()
            sc = self.scenarios[self.active_scenario_key]
            wd_ok = not (self.watchdog_fault_injected or self.montrac_a_watchdog_ms > self.watchdog_timeout_ms)

            sim_line = str(self.sim_kpi.get("line_state", "")).upper()
            sim_estop = bool(self.sim_safety.get("estop_active", False))
            if self.hardware_estop_engaged or sim_estop or not wd_ok or sim_line in ("ESTOP", "FAULT", "ERROR"):
                eff_state = "FAULT_LOCKED"
            elif self.sim_connected and sim_line in ("RUNNING", "PAUSED"):
                eff_state = "RUNNING"
            elif self.state == "RUNNING":
                eff_state = "RUNNING"
            else:
                eff_state = "IDLE"

            is_fault = eff_state == "FAULT_LOCKED"

            # Calcul KPI (temps réel sim si connecté, sinon compteurs locaux)
            if self.sim_connected and self.sim_kpi:
                completed = int(self.sim_kpi.get("parts_completed", self.completed_cycles))
                target_batch = int(self.sim_kpi.get("target_quantity", 0)) or self.target_batch_cycles
                raw_conf = _safe_float(self.sim_kpi.get("conformity_rate", 100.0), 100.0)
                conformity = round(raw_conf * 100.0 if raw_conf <= 1.01 and completed > 0 else raw_conf, 1)
                avg_cycle = round(_safe_float(self.sim_kpi.get("avg_cycle_time_sec", 0.0), 0.0), 1)
                cadence = int(round(_safe_float(self.sim_kpi.get("cadence_parts_per_hour", 0.0), 0.0)))
                avail = _safe_float(self.sim_kpi.get("availability_ratio", 1.0), 1.0)
                uptime_pct = round(avail * 100.0 if avail <= 1.01 else avail, 1)
                oee_raw = _safe_float(self.sim_kpi.get("oee_trs", 0.0), 0.0)
                oee_pct = round(oee_raw * 100.0 if oee_raw <= 1.01 else oee_raw, 1)
            else:
                completed = self.completed_cycles
                target_batch = self.target_batch_cycles
                total_attempts = self.completed_cycles + self.faulted_cycles
                conformity = (
                    round(100.0 * self.completed_cycles / total_attempts, 1)
                    if total_attempts > 0
                    else 100.0
                )
                avg_cycle = (
                    round(sum(self.cycle_durations_s) / len(self.cycle_durations_s), 1)
                    if self.cycle_durations_s
                    else 18.5
                )
                cadence = int(round(3600.0 / avg_cycle)) if avg_cycle > 0 else 0
                uptime_pct = 99.0 if not is_fault else 91.5
                oee_pct = round((uptime_pct / 100.0) * conformity, 1)

            station_a = self._station_name(self.montrac_a_progress)
            station_b = self._station_name(self.montrac_b_progress)

            if self.sim_connected:
                yaskawa_a_status = "fault" if is_fault else self._map_sim_station_status("poste_a", "ready")
                yaskawa_b_status = "fault" if is_fault else self._map_sim_station_status("poste_b", "ready")
                montrac_a_status = (
                    "fault"
                    if not wd_ok or is_fault
                    else "active"
                    if self.montrac_a_speed > 0
                    else self._map_sim_station_status("montrac", "ready")
                )
                montrac_b_status = (
                    "fault"
                    if is_fault
                    else "active"
                    if self.montrac_b_speed > 0
                    else self._map_sim_station_status("montrac", "ready")
                )
                tiago_status = (
                    "fault"
                    if is_fault
                    else "warning"
                    if _safe_float(self.sim_safety.get("tiago_speed_scale", 1.0), 1.0) < 0.99
                    else "active"
                    if self.part_location == "tiago"
                    else self._map_sim_station_status("tiago", "ready")
                )
                staubli_status = "fault" if is_fault else self._map_sim_station_status("staubli", "ready")
            else:
                yaskawa_a_status = (
                    "fault"
                    if is_fault
                    else "active"
                    if (eff_state == "RUNNING" and (self.part_location == "yaskawa_a" or self.yaskawa_a_pose != "home"))
                    else "ready"
                )
                yaskawa_b_status = (
                    "fault"
                    if is_fault
                    else "active"
                    if (eff_state == "RUNNING" and (self.part_location == "yaskawa_b" or self.yaskawa_b_pose != "home"))
                    else "ready"
                )
                montrac_a_status = (
                    "fault"
                    if not wd_ok or is_fault
                    else "active"
                    if self.montrac_a_speed > 0
                    else "ready"
                )
                montrac_b_status = (
                    "fault"
                    if is_fault
                    else "active"
                    if self.montrac_b_speed > 0
                    else "ready"
                )
                tiago_status = (
                    "fault"
                    if is_fault
                    else "active"
                    if (eff_state == "RUNNING" and self.part_location == "tiago")
                    else "ready"
                )
                staubli_status = "standby"

            hw_label_montrac = (
                "gz_ros2_control (boucles locales séparées)"
                if self.gz_sim
                else "montrac_hardware_interface (SystemInterface)"
            )
            hw_label_yaskawa = (
                "gz_ros2_control (Gazebo Harmonic)"
                if self.gz_sim
                else "Contrôleur Yaskawa + ros_yaskawa_hc10"
            )

            def _resolve_shuttle_pose(side: str, prog: float, speed_mm: int) -> dict[str, Any]:
                raw_sh = self.sim_shuttles.get(side)
                if raw_sh and -18.5 <= _safe_float(raw_sh.get("x", 0.0)) <= -7.0:
                    return {
                        "name": str(raw_sh.get("name") or ("L1" if side == "left" else "R1")),
                        "x": round(_safe_float(raw_sh.get("x")), 4),
                        "y": round(_safe_float(raw_sh.get("y")), 4),
                        "z": round(_safe_float(raw_sh.get("z", 0.8393)), 4),
                        "yaw": round(_safe_float(raw_sh.get("yaw", 0.0)), 4),
                        "speed": round(_safe_float(raw_sh.get("speed", speed_mm / 1000.0)), 3),
                        "currentSegment": str(raw_sh.get("current_segment") or ""),
                    }
                return loop_progress_to_shuttle_world_pose(
                    side, prog, speed_mm, str((raw_sh or {}).get("name") or ("L1" if side == "left" else "R1"))
                )

            shuttle_left_pose = _resolve_shuttle_pose("left", self.montrac_a_progress, self.montrac_a_speed)
            shuttle_right_pose = _resolve_shuttle_pose("right", self.montrac_b_progress, self.montrac_b_speed)
            workpieces_out = (
                [dict(w) for w in self.sim_workpieces]
                if self.sim_workpieces
                else ([dict(self.sim_active_workpiece)] if self.sim_active_workpiece else [])
            )
            qc_a = self.sim_inspections.get("poste_a", {})
            qc_b = self.sim_inspections.get("poste_b", {})
            cam_a_obs = (
                [
                    str(qc_a.get("summary") or ("Conforme" if qc_a.get("conforming") else "Inspecté")),
                    f"Confiance : {int(round(_safe_float(qc_a.get('confidence', 0.0)) * 100))} %",
                ]
                if qc_a
                else [
                    f"Navette locale N1 : {station_a}",
                    "Pièce détectée Bloc A" if self.part_location in ("table_a", "yaskawa_a", "montrac_a") else "Bloc A observé",
                ]
            )
            cam_b_obs = (
                [
                    str(qc_b.get("summary") or ("Conforme" if qc_b.get("conforming") else "Défaut détecté")),
                    f"Confiance : {int(round(_safe_float(qc_b.get('confidence', 0.0)) * 100))} %",
                ]
                if qc_b
                else [
                    f"Navette locale N2 : {station_b}",
                    "Contrôle qualité ZED 2 prêt",
                ]
            )

            preconditions = [
                {
                    "id": "p-estop",
                    "label": "Arrêt d'urgence global (Salle 315)",
                    "predicate": "(hardware_estop_clear)",
                    "passed": not (self.hardware_estop_engaged or sim_estop),
                    "detail": "Arrêt d'urgence engagé" if (self.hardware_estop_engaged or sim_estop) else "Nominal",
                },
                {
                    "id": "p-wd",
                    "label": "Chien de garde boucles locales Montrac",
                    "predicate": "(watchdog_alive rail_a)",
                    "passed": wd_ok and bool(self.sim_safety.get("montrac_interlock_clear", True)),
                    "detail": f"{self.montrac_a_watchdog_ms} ms (seuil {self.watchdog_timeout_ms} ms)",
                },
                {
                    "id": "p-iso",
                    "label": "Sécurité collaborative ISO/TS 15066 (couloir TIAGo)",
                    "predicate": "(corridor_clear_iso15066)",
                    "passed": _safe_float(self.sim_safety.get("tiago_speed_scale", 1.0), 1.0) > 0.0 and not is_fault,
                    "detail": (
                        f"Vitesse TIAGo {int(round(_safe_float(self.sim_safety.get('tiago_speed_scale', 1.0), 1.0) * 100))} %"
                    ),
                },
                {
                    "id": "p-topo",
                    "label": "Absence de convoyeur A↔B — transfert exclusif TIAGo",
                    "predicate": "(and (not (conveyor_linked bloc_a bloc_b)) (tiago_exclusive_bridge bloc_a bloc_b))",
                    "passed": True,
                    "detail": "PICK_POSTE_A_DELIVER_POSTE_B (poste_a_out → poste_b_in)",
                },
            ]

            active_code = (
                str(self.sim_kpi.get("active_batch_id") or "LIVE-SIM")
                if (self.sim_connected and self.sim_kpi.get("active_batch_id"))
                else sc["code"]
            )
            active_title = (
                str(self.sim_kpi.get("current_step_description") or sc["title"])
                if (self.sim_connected and self.sim_kpi.get("current_step_description"))
                else sc["title"]
            )

            return {
                "timestamp": now_str,
                "environment": "gazebo" if self.gz_sim else "real",
                "gzSimFlag": self.gz_sim,
                "simConnected": self.sim_connected,
                "interBlocLink": "tiago",
                "hmiHttpUrl": self.hmi_http_url,
                "orchestratorState": eff_state,
                "activeScenarioCode": active_code,
                "activeScenarioTitle": active_title,
                "activeScenarioDescription": sc["description"],
                "cycleNumber": max(1, completed + 1 if eff_state == "RUNNING" else max(1, completed)),
                "partLocation": self.part_location,
                "safety": self.to_safety_payload(),
                "yaskawaA": {
                    "id": "yaskawa_a",
                    "name": "Yaskawa HC10DT",
                    "model": "Motoman HC10DT (Bloc A)",
                    "zone": "A",
                    "status": yaskawa_a_status,
                    "actionLabel": self.yaskawa_a_action,
                    "gripperState": self.yaskawa_a_gripper,
                    "carryingPart": self.part_location == "yaskawa_a",
                    "poseTarget": self.yaskawa_a_pose,
                    "jointsDeg": self.yaskawa_a_joints,
                    "controllerLayer": "mfja_yaskawa (ros2_control) · /yaskawa_LEFT/arm_controller/follow_joint_trajectory",
                    "hardwareInterface": hw_label_yaskawa,
                    "commandTopic": self.usine40_topics.get("yaskawa_left_traj", "/yaskawa_LEFT/arm_controller/follow_joint_trajectory"),
                    "rosTopic": self.usine40_topics.get("yaskawa_left_joints", "/yaskawa_LEFT/joint_state_broadcaster/joint_states"),
                },
                "yaskawaB": {
                    "id": "yaskawa_b",
                    "name": "Yaskawa HC10",
                    "model": "Motoman HC10 (Bloc B)",
                    "zone": "B",
                    "status": yaskawa_b_status,
                    "actionLabel": self.yaskawa_b_action,
                    "gripperState": self.yaskawa_b_gripper,
                    "carryingPart": self.part_location == "yaskawa_b",
                    "poseTarget": self.yaskawa_b_pose,
                    "jointsDeg": self.yaskawa_b_joints,
                    "controllerLayer": "mfja_yaskawa (ros2_control) · /yaskawa_RIGHT/arm_controller/follow_joint_trajectory",
                    "hardwareInterface": hw_label_yaskawa,
                    "commandTopic": self.usine40_topics.get("yaskawa_right_traj", "/yaskawa_RIGHT/arm_controller/follow_joint_trajectory"),
                    "rosTopic": self.usine40_topics.get("yaskawa_right_joints", "/yaskawa_RIGHT/joint_state_broadcaster/joint_states"),
                },
                "montracA": {
                    "id": "montrac_a",
                    "name": "Montrac Bloc A (Local)",
                    "zone": "A",
                    "status": montrac_a_status,
                    "shuttleId": str(self.sim_shuttles.get("left", {}).get("name") or "L1"),
                    "station": station_a,
                    "loopProgress": round(self.montrac_a_progress, 4),
                    "speedMmS": self.montrac_a_speed,
                    "partPresent": self.part_location == "montrac_a",
                    "watchdogOk": wd_ok,
                    "watchdogAgeMs": self.montrac_a_watchdog_ms,
                    "hardwareInterface": hw_label_montrac,
                    "controllerName": "montrac_sequencer (boucle locale A)",
                    "rosTopic": self.usine40_topics.get("shuttle_left_state", "/room_315/rails/left/shuttles/state"),
                },
                "montracB": {
                    "id": "montrac_b",
                    "name": "Montrac Bloc B (Local)",
                    "zone": "B",
                    "status": montrac_b_status,
                    "shuttleId": str(self.sim_shuttles.get("right", {}).get("name") or "R1"),
                    "station": station_b,
                    "loopProgress": round(self.montrac_b_progress, 4),
                    "speedMmS": self.montrac_b_speed,
                    "partPresent": self.part_location == "montrac_b"
                    and str(self.sim_active_workpiece.get("holder", "")).lower()
                    not in ("staubli1", "staubli", "staubli_ee", "staubli_fixture"),
                    "watchdogOk": True,
                    "watchdogAgeMs": self.montrac_b_watchdog_ms,
                    "hardwareInterface": hw_label_montrac,
                    "controllerName": "montrac_sequencer (boucle locale B / Stäubli)",
                    "rosTopic": self.usine40_topics.get("shuttle_right_state", "/room_315/rails/right/shuttles/state"),
                },
                "tiago": {
                    "id": "tiago",
                    "name": "PAL TIAGo (Lien A↔B)",
                    "model": "PAL Robotics TIAGo (7-DOF + Parallel Gripper)",
                    "status": tiago_status,
                    "actionLabel": self.tiago_action,
                    "corridorProgress": round(self.tiago_progress, 4),
                    "carryingPart": self.part_location == "tiago",
                    "batteryPct": 92,
                    "headingRad": round(_safe_float(self.sim_tiago_world_pose.get("yaw", -1.5708)), 4),
                    "cmdVel": dict(self.sim_tiago_cmd_vel),
                    "torsoLiftM": round(self.sim_tiago_torso_lift_m, 3),
                    "armJointsDeg": list(self.sim_tiago_arm_joints_deg),
                    "gripperOpeningM": round(self.sim_tiago_gripper_m, 4),
                    "navStack": "DiffDrive /tiago1/cmd_vel + Baie Centrale ISO 15066",
                    "hardwareInterface": "gz_sim DiffDrive + JointTrajectoryController (PAL TIAGo)"
                    if self.gz_sim
                    else "ROS 2 PAL TIAGo",
                    "rosTopic": "/tiago1/cmd_vel · /tiago1/joint_trajectory · /tiago1/joint_states",
                    "controlTopics": [
                        self.usine40_topics.get("tiago_cmd_vel", "/tiago1/cmd_vel"),
                        self.usine40_topics.get("tiago_odom", "/tiago1/odom"),
                        self.usine40_topics.get("tiago_joint_trajectory", "/tiago1/joint_trajectory"),
                        self.usine40_topics.get("tiago_joint_states", "/tiago1/joint_states"),
                        self.usine40_topics.get("tiago_gripper_cmd", "/tiago1/gripper/position_command"),
                    ],
                },
                "kukaA": {
                    "id": "kuka_a",
                    "name": "KUKA KR6",
                    "model": "KUKA KR6 R900",
                    "zone": "A",
                    "status": "standby",
                    "note": "Poste auxiliaire Bloc A",
                    "rosTopic": "/kuka1/joint_states",
                },
                "staubliB": {
                    "id": "staubli_b",
                    "name": "Stäubli TX2",
                    "model": "Stäubli TX2-60L",
                    "zone": "B",
                    "status": staubli_status,
                    "note": str(
                        self.sim_stations.get("staubli", {}).get("current_action")
                        or "Cellule de reprise qualité Bloc B"
                    ),
                    "rosTopic": "/staubli1/joint_trajectory · /staubli1/joint_states",
                },
                "cameraA": {
                    "id": "camera_a",
                    "name": "ZED 2 Bloc A",
                    "zone": "A",
                    "sensorType": "ZED 2 RGB-D OpenCV",
                    "status": "fault" if (qc_a and qc_a.get("part_detected") and not qc_a.get("conforming")) else "active",
                    "fps": 10,
                    "detectedObjects": cam_a_obs,
                    "coverageNote": f"{self.hmi_http_url}/api/camera/poste_a.mjpg",
                    "rosTopic": self.usine40_topics.get("inspection_a", "/usine40/perception/poste_a/result"),
                },
                "cameraB": {
                    "id": "camera_b",
                    "name": "ZED 2 Bloc B (QC)",
                    "zone": "B",
                    "sensorType": "ZED 2 RGB-D OpenCV",
                    "status": "fault" if (qc_b and qc_b.get("part_detected") and not qc_b.get("conforming")) else "active",
                    "fps": 10,
                    "detectedObjects": cam_b_obs,
                    "coverageNote": f"{self.hmi_http_url}/api/camera/poste_b.mjpg",
                    "rosTopic": self.usine40_topics.get("inspection_b", "/usine40/perception/poste_b/result"),
                },
                "steps": self._build_steps_payload(),
                "preconditions": preconditions,
                "events": [
                    {
                        "id": ev.id,
                        "timestamp": ev.timestamp,
                        "level": ev.level,
                        "source": ev.source,
                        "message": ev.message,
                    }
                    for ev in self.events[:12]
                ],
                "vlaCandidate": self.vla_candidate,
                "kpis": {
                    "completedCycles": completed,
                    "targetBatchCycles": target_batch,
                    "conformityRatePct": conformity,
                    "averageCycleTimeS": avg_cycle,
                    "cadencePerHour": cadence,
                    "uptimePct": uptime_pct,
                    "rejectedCommands": self.rejected_commands,
                    "recentCycles": self.recent_cycles,
                    "cycleTimeSeriesS": self.cycle_durations_s or [avg_cycle],
                    "oeeTrsPct": oee_pct,
                    "partsReworked": int(self.sim_kpi.get("parts_reworked", 0)),
                    "partsScrapped": int(self.sim_kpi.get("parts_scrapped", 0)),
                    "wipCount": int(self.sim_kpi.get("wip_count", 0)),
                },
                "liveSim": {
                    "simConnected": self.sim_connected,
                    "lineState": sim_line or eff_state,
                    "paused": sim_line == "PAUSED",
                    "activeBatchId": str(self.sim_kpi.get("active_batch_id", "")),
                    "humanInCollabZone": bool(self.sim_safety.get("human_in_collab_zone", False)),
                    "humanDistanceM": round(_safe_float(self.sim_safety.get("human_distance_m", 99.0), 99.0), 2),
                    "tiagoSpeedScale": round(_safe_float(self.sim_safety.get("tiago_speed_scale", 1.0), 1.0), 2),
                    "tiagoWorldPose": dict(self.sim_tiago_world_pose),
                    "tiagoCmdVel": dict(self.sim_tiago_cmd_vel),
                    "tiagoTorsoLiftM": round(self.sim_tiago_torso_lift_m, 3),
                    "tiagoGripperM": round(self.sim_tiago_gripper_m, 4),
                    "humanWorldPose": dict(self.sim_human_world_pose),
                    "shuttles": {
                        "left": shuttle_left_pose,
                        "right": shuttle_right_pose,
                    },
                    "staubliJointsDeg": list(self.staubli_joints[:6]),
                    "activeWorkpiece": dict(self.sim_active_workpiece),
                    "workpieces": workpieces_out,
                    "qcPosteA": dict(qc_a),
                    "qcPosteB": dict(qc_b),
                    "hmiHttpUrl": self.hmi_http_url,
                },
                "rosTopics": [
                    {
                        "topic": self.topics.get("cell_state", "/mfja/supervisor/cell_state"),
                        "messageType": "std_msgs/msg/String (JSON)",
                        "nodeOwner": "mfja_orchestrator (L1 <-> Sim)",
                        "hz": float(self.config.get("network", {}).get("publish_rate_hz", 10.0)),
                        "active": True,
                    },
                    {
                        "topic": self.usine40_topics.get("kpi", "/usine40/kpi"),
                        "messageType": "usine40_interfaces/msg/CellKpi",
                        "nodeOwner": "production_orchestrator_node",
                        "hz": 2.0 if self.sim_connected else 0.0,
                        "active": self.sim_connected,
                    },
                    {
                        "topic": self.usine40_topics.get("safety_status", "/usine40/safety/status"),
                        "messageType": "usine40_interfaces/msg/SafetyStatus",
                        "nodeOwner": "cell_safety_supervisor_node",
                        "hz": 5.0 if self.sim_connected else 10.0,
                        "active": True,
                    },
                    {
                        "topic": self.usine40_topics.get("tiago_cmd_vel", "/tiago1/cmd_vel"),
                        "messageType": "geometry_msgs/msg/Twist",
                        "nodeOwner": "tiago_logistics_node -> DiffDrive PAL TIAGo",
                        "hz": 25.0 if not is_fault else 0.0,
                        "active": not is_fault,
                    },
                    {
                        "topic": self.usine40_topics.get("tiago_odom", "/tiago1/odom"),
                        "messageType": "nav_msgs/msg/Odometry",
                        "nodeOwner": "gz_sim DiffDrive (PAL TIAGo)",
                        "hz": 25.0 if not is_fault else 0.0,
                        "active": not is_fault,
                    },
                    {
                        "topic": self.usine40_topics.get("tiago_joint_trajectory", "/tiago1/joint_trajectory"),
                        "messageType": "trajectory_msgs/msg/JointTrajectory",
                        "nodeOwner": "tiago_logistics_node (Torso + 7-DOF Arm)",
                        "hz": 10.0 if not is_fault else 0.0,
                        "active": not is_fault,
                    },
                    {
                        "topic": self.usine40_topics.get("tiago_joint_states", "/tiago1/joint_states"),
                        "messageType": "sensor_msgs/msg/JointState",
                        "nodeOwner": "gz_sim JointStatePublisher (PAL TIAGo)",
                        "hz": 20.0 if not is_fault else 0.0,
                        "active": not is_fault,
                    },
                    {
                        "topic": self.usine40_topics.get("tiago_gripper_cmd", "/tiago1/gripper/position_command"),
                        "messageType": "std_msgs/msg/Float64",
                        "nodeOwner": "tiago_logistics_node (Parallel Gripper)",
                        "hz": 5.0 if not is_fault else 0.0,
                        "active": not is_fault,
                    },
                    {
                        "topic": self.usine40_topics.get("yaskawa_a_traj", "/yaskawa_hc10dt_1/joint_trajectory"),
                        "messageType": "trajectory_msgs/msg/JointTrajectory",
                        "nodeOwner": "manipulation_station (Poste A HC10DT)",
                        "hz": 0.0 if is_fault else 10.0,
                        "active": not is_fault,
                    },
                    {
                        "topic": self.usine40_topics.get("yaskawa_a_joints", "/yaskawa_hc10dt_1/joint_states"),
                        "messageType": "sensor_msgs/msg/JointState",
                        "nodeOwner": "gz_sim JointStatePublisher (HC10DT)",
                        "hz": 0.0 if is_fault else 20.0,
                        "active": not is_fault,
                    },
                    {
                        "topic": self.usine40_topics.get("yaskawa_b_traj", "/yaskawa_hc10_1/joint_trajectory"),
                        "messageType": "trajectory_msgs/msg/JointTrajectory",
                        "nodeOwner": "manipulation_station (Poste B HC10)",
                        "hz": 0.0 if is_fault else 10.0,
                        "active": not is_fault,
                    },
                    {
                        "topic": self.usine40_topics.get("yaskawa_b_joints", "/yaskawa_hc10_1/joint_states"),
                        "messageType": "sensor_msgs/msg/JointState",
                        "nodeOwner": "gz_sim JointStatePublisher (HC10)",
                        "hz": 0.0 if is_fault else 20.0,
                        "active": not is_fault,
                    },
                    {
                        "topic": "/yaskawa_LEFT/arm_controller/follow_joint_trajectory",
                        "messageType": "control_msgs/action/FollowJointTrajectory",
                        "nodeOwner": "mfja_yaskawa_gz_hardware (YaskawaGazeboSystem)",
                        "hz": 0.0 if is_fault else 50.0,
                        "active": not is_fault,
                    },
                    {
                        "topic": "/yaskawa_LEFT/gripper_controller/commands",
                        "messageType": "std_msgs/msg/Float64MultiArray",
                        "nodeOwner": "mfja_yaskawa (gripper_controller)",
                        "hz": 0.0 if is_fault else 10.0,
                        "active": not is_fault,
                    },
                    {
                        "topic": "/yaskawa_RIGHT/arm_controller/follow_joint_trajectory",
                        "messageType": "control_msgs/action/FollowJointTrajectory",
                        "nodeOwner": "mfja_yaskawa_gz_hardware (YaskawaGazeboSystem)",
                        "hz": 0.0 if is_fault else 50.0,
                        "active": not is_fault,
                    },
                    {
                        "topic": "/yaskawa_RIGHT/gripper_controller/commands",
                        "messageType": "std_msgs/msg/Float64MultiArray",
                        "nodeOwner": "mfja_yaskawa (gripper_controller)",
                        "hz": 0.0 if is_fault else 10.0,
                        "active": not is_fault,
                    },
                    {
                        "topic": self.usine40_topics.get("staubli_traj", "/staubli1/joint_trajectory"),
                        "messageType": "trajectory_msgs/msg/JointTrajectory",
                        "nodeOwner": "manipulation_station (Stäubli TX2 Reprise)",
                        "hz": 0.0 if is_fault else 10.0,
                        "active": not is_fault,
                    },
                    {
                        "topic": self.usine40_topics.get("inspection_b", "/usine40/perception/poste_b/result"),
                        "messageType": "usine40_interfaces/msg/InspectionResult",
                        "nodeOwner": "zed2_inspection_node (L2 QC)",
                        "hz": 5.0 if self.sim_connected else 0.0,
                        "active": self.sim_connected,
                    },
                ],
            }
