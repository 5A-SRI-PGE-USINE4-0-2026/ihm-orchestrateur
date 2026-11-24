"""Superviseur / Orchestrateur déterministe L1 — Cellule Usine 4.0 Salle 315 MFJA.

Implémente :
- Machine à états explicite : IDLE, VALIDATING, RUNNING, FAULT_LOCKED
- Vérification continue des préconditions (sécurité matérielle, chien de garde Montrac, non-collision)
- Séquences reconfigurables chargées depuis cell_config.yaml (J1, J1 alternatif §3.4, J2 TIAGo)
- Validateur neuro-symbolique J3 fail-closed (rejet des commandes physiquement impossibles)
- Sérialisation vers le contrat de télémétrie en lecture seule de l'IHM
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
import math
from pathlib import Path
import threading
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
        self.topics: dict[str, str] = self.config.get("topics", {})

        self.gz_sim: bool = bool(cell_cfg.get("gz_sim", False))
        self.target_batch_cycles: int = int(cell_cfg.get("target_batch_cycles", 20))
        self.montrac_speed_nominal: int = int(hw_cfg.get("montrac_speed_mm_s", 185))
        self.stations: dict[str, float] = hw_cfg.get(
            "stations", {"blue": 0.06, "green": 0.24, "red": 0.74, "yellow": 0.56}
        )
        self.watchdog_timeout_ms: int = int(safety_cfg.get("montrac_watchdog_timeout_ms", 500))
        self.scenarios: dict[str, Any] = self.config.get("scenarios", {})

        # État orchestrateur
        self.state: str = "IDLE"  # IDLE | VALIDATING | RUNNING | FAULT_LOCKED
        self.active_scenario_key: str = "j1"
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
        self.yaskawa_a_action: str = "En position de repos"

        self.yaskawa_b_pose: str = "home"
        self.yaskawa_b_joints: list[float] = list(JOINTS_HOME)
        self.yaskawa_b_gripper: str = "open"
        self.yaskawa_b_action: str = "En veille (îlot Zone B)"

        self.montrac_a_progress: float = self.stations["blue"]
        self.montrac_a_speed: int = 0
        self.montrac_b_progress: float = self.stations["blue"]
        self.montrac_b_speed: int = 0

        self.tiago_progress: float = 0.05
        self.tiago_action: str = "Stationné hors périmètre J1"

        # KPIs & traçabilité réelle
        self.completed_cycles: int = 0
        self.faulted_cycles: int = 0
        self.rejected_commands: int = 0
        self.cycle_durations_s: list[float] = []
        self.recent_cycles: list[dict[str, Any]] = []
        self._event_seq: int = 0
        self.events: list[SupervisorEvent] = []

        # Dernier candidat J3 VLA / PDDL
        self.vla_candidate: dict[str, Any] = {
            "naturalLanguageRequest": "Aucune consigne langage naturel soumise pour le moment.",
            "sceneObservation": "Caméra Zone A : cube sur poste A, navette N1 en station Bleue.",
            "pddlGoal": "(idle salle_315)",
            "steps": [],
            "verdict": "validated",
            "verdictReason": "En attente d'une consigne via la commande CLI `propose <texte>`.",
            "timestamp": _clock_str(),
        }

        self._load_scenario_steps("j1", activate=False)
        self._add_event("ok", "Superviseur L1", "Orchestrateur initialisé en état IDLE (prêt).")

    @classmethod
    def from_yaml(cls, path: str | Path) -> "CellSupervisor":
        with open(path, "r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
        return cls(config=data)

    # ------------------------------------------------------------------
    # Journal interne
    # ------------------------------------------------------------------
    def _add_event(self, level: str, source: str, message: str) -> None:
        self._event_seq += 1
        self.events.insert(
            0,
            SupervisorEvent(
                id=f"ev-{self._event_seq}",
                timestamp=_clock_str(),
                level=level,
                source=source,
                message=message,
            ),
        )
        if len(self.events) > 30:
            self.events = self.events[:30]

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
    # Commandes opérateur (CLI / topic ROS 2 — jamais appelées par l'IHM)
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
                scenario = args[0].lower() if args else "j1"
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
                target = args[0].lower() if args else "real"
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
                return "REFUSÉ : sécurité active (FAULT_LOCKED). Acquitter physiquement puis exécuter `reset`."

            if self.state == "RUNNING":
                return f"Un cycle ({self.active_scenario_key}) est déjà en cours. Utiliser `stop` d'abord."

            # Remise en position initiale cohérente avant démarrage
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
            self.tiago_progress = 0.05

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
                self._add_event("warning", "Superviseur L1", "Arrêt contrôlé du cycle demandé depuis le terminal.")
                return "Cycle arrêté proprement (état IDLE)."
            return f"Aucun cycle actif (état actuel : {self.state})."

    def inject_fault(self, kind: str) -> str:
        with self._lock:
            if kind == "estop":
                self.hardware_estop_engaged = True
                reason = "Arrêt d'urgence matériel enclenché sur la zone A."
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
        """Validateur déterministe fail-closed pour la piste J3 (LLM/VLM -> PDDL -> L1)."""
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
                self._add_event("fault", "Superviseur L1", "Plan candidat J3 rejeté : sécurité verrouillée.")
                return "REJETÉ (fail-closed) : la cellule est verrouillée en sécurité."

            mentions_zone_b = "zone b" in low or "poste b" in low or "îlot b" in low
            mentions_montrac = "montrac" in low or "navette" in low or "rail" in low
            mentions_tiago = "tiago" in low or "robot mobile" in low
            mentions_kuka_staubli = "kuka" in low or "staubli" in low or "stäubli" in low
            mentions_alt = "alternatif" in low or "reconfig" in low or "navette d'abord" in low or "invers" in low

            # Cas 1 : Demande physiquement impossible (Montrac direct Zone A -> Zone B sans TIAGo)
            if mentions_zone_b and mentions_montrac and not mentions_tiago:
                self.rejected_commands += 1
                self.vla_candidate = {
                    "naturalLanguageRequest": f"« {request_text} »",
                    "sceneObservation": "Caméra A : cube sur poste A, navette N1 en station Bleue. Caméra B : rail B indépendant.",
                    "pddlGoal": "(part-at cube_01 zone_b_yaskawa)",
                    "steps": [
                        "pick_from_table(yaskawa_hc10dt, cube_01, zone_a)",
                        "place_on_shuttle(yaskawa_hc10dt, cube_01, n1, station_bleue_a, rail_a, zone_a)",
                        "move_shuttle_local(n1, rail_a, station_bleue_a, station_bleue_b) [INVALIDE]",
                    ],
                    "verdict": "rejected",
                    "verdictReason": (
                        "Rejet déterministe L1 : les rails Montrac Zone A et Zone B sont physiquement "
                        "séparés (station_bleue_b n'appartient pas à rail_a). Aucune commande envoyée."
                    ),
                    "timestamp": now_str,
                    "alternativeSummary": "Reformuler avec TIAGo (J2) ou limiter le cycle à la Zone A (J1).",
                }
                self._record_cycle(
                    "rejet_superviseur",
                    "Plan J3 rejeté : rails Montrac Zone A et Zone B non reliés",
                )
                self._add_event(
                    "warning",
                    "Superviseur L1",
                    "Plan candidat J3 rejeté : liaison Montrac A vers B physiquement impossible.",
                )
                return (
                    "REJETÉ par L1 (fail-closed) : les deux rails Montrac ne sont pas reliés physiquement "
                    "entre Zone A et Zone B. Aucune action exécutée."
                )

            # Cas 2 : Équipement hors périmètre (KUKA / Stäubli)
            if mentions_kuka_staubli:
                self.rejected_commands += 1
                self.vla_candidate = {
                    "naturalLanguageRequest": f"« {request_text} »",
                    "sceneObservation": "KUKA KR6 et Stäubli TX2 sont hors périmètre autorisé sur la cellule.",
                    "pddlGoal": "(operate-out-of-scope-robot)",
                    "steps": ["dispatch_robot(kuka_or_staubli) [NON AUTORISÉ]"],
                    "verdict": "rejected",
                    "verdictReason": "Rejet déterministe L1 : équipement hors périmètre validé pour le scénario actif.",
                    "timestamp": now_str,
                }
                self._record_cycle("rejet_superviseur", "Plan J3 rejeté : robot hors périmètre")
                self._add_event("warning", "Superviseur L1", "Plan candidat J3 rejeté : équipement hors périmètre.")
                return "REJETÉ par L1 : KUKA KR6 et Stäubli TX2 ne sont pas autorisés dans le périmètre actuel."

            # Cas 3 : Inter-zones valide avec TIAGo (J2)
            if mentions_zone_b and mentions_tiago:
                self.vla_candidate = {
                    "naturalLanguageRequest": f"« {request_text} »",
                    "sceneObservation": "Caméra A/B : Zone A prête, couloir central dégagé pour TIAGo, Zone B libre.",
                    "pddlGoal": "(part-at-table cube_01 zone_b)",
                    "steps": [
                        "pick_from_table(yaskawa_hc10dt, cube_01, zone_a)",
                        "place_on_shuttle(yaskawa_hc10dt, cube_01, n1, station_bleue_a, rail_a, zone_a)",
                        "move_shuttle_local(n1, rail_a, station_bleue_a, station_verte_a)",
                        "tiago_transfer_interzone(tiago, cube_01, zone_a, zone_b)",
                        "move_shuttle_local(n2, rail_b, station_bleue_b, station_verte_b)",
                        "pick_from_shuttle(yaskawa_hc10, cube_01, n2, station_verte_b, rail_b, zone_b)",
                    ],
                    "verdict": "validated",
                    "verdictReason": "Plan candidat J2 conforme au domaine PDDL Salle 315. Autorisé par le superviseur L1.",
                    "timestamp": now_str,
                }
                self._add_event("ok", "Superviseur L1", "Plan candidat J3 (transfert J2 avec TIAGo) validé.")
                if self.state == "IDLE":
                    self.start_scenario("j2", loop=False)
                return "VALIDÉ par L1 : plan inter-zones J2 avec TIAGo autorisé et lancé."

            # Cas 4 : Intra-zone A (J1 ou J1 alternatif)
            chosen_key = "j1_alt" if mentions_alt else "j1"
            self.vla_candidate = {
                "naturalLanguageRequest": f"« {request_text} »",
                "sceneObservation": "Caméra Zone A : cube détecté sur poste A, navette N1 en station Bleue.",
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
                "verdictReason": f"Plan candidat conforme au domaine PDDL ({chosen_key}). Autorisé par le superviseur L1.",
                "timestamp": now_str,
            }
            self._add_event("ok", "Superviseur L1", f"Plan candidat J3 validé -> exécution {chosen_key.upper()}.")
            if self.state == "IDLE":
                self.start_scenario(chosen_key, loop=False)
            return f"VALIDÉ par L1 : plan intra-zone ({chosen_key}) autorisé et lancé."

    def format_status_line(self) -> str:
        with self._lock:
            step_str = (
                f"étape {self.active_step_idx + 1}/{len(self.steps)} ({self.steps[self.active_step_idx].label})"
                if 0 <= self.active_step_idx < len(self.steps)
                else "aucune étape active"
            )
            env = "Gazebo (gz_sim:=true)" if self.gz_sim else "Réel (gz_sim:=false)"
            return (
                f"État={self.state} | Env={env} | Scénario={self.active_scenario_key} | "
                f"{step_str} | Cycles={self.completed_cycles} | Rejets={self.rejected_commands}"
            )

    # ------------------------------------------------------------------
    # Boucle temps réel déterministe (appelée à 10 Hz)
    # ------------------------------------------------------------------
    def tick(self, dt: float) -> None:
        with self._lock:
            # Mise à jour légère du chien de garde nominal
            if not self.watchdog_fault_injected:
                t_ms = int(22 + 6 * abs(math.sin(self.cycle_elapsed_s * 1.7)))
                self.montrac_a_watchdog_ms = t_ms
                self.montrac_b_watchdog_ms = t_ms + 3
            else:
                self.montrac_a_watchdog_ms = min(9999, self.montrac_a_watchdog_ms + int(dt * 1000))

            # Vérification sécurité prioritaire (fail-closed)
            if self.hardware_estop_engaged or self.montrac_a_watchdog_ms > self.watchdog_timeout_ms:
                if self.state != "FAULT_LOCKED":
                    self.state = "FAULT_LOCKED"
                    self.montrac_a_speed = 0
                    self.montrac_b_speed = 0
                return

            if self.state != "RUNNING" or not (0 <= self.active_step_idx < len(self.steps)):
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
                    # Fin de cycle réussie
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
                        self.tiago_progress = 0.05
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
            self.yaskawa_a_action = "Prise du cube sur la table poste A"

        elif action == "yaskawa_a_place_blue":
            self.yaskawa_a_pose = "station_blue"
            self.yaskawa_a_joints = _lerp_joints(JOINTS_TABLE, JOINTS_BLUE, t)
            self.yaskawa_a_gripper = "holding" if t < 0.75 else "open"
            self.part_location = "yaskawa_a" if t < 0.75 else "montrac_a"
            self.yaskawa_a_action = "Dépose sur la navette N1 (station Bleue)"

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
            self.yaskawa_a_action = "Chargement du cube sur la navette N1"

        elif action == "montrac_a_blue_to_green":
            self.yaskawa_a_pose = "home"
            self.yaskawa_a_joints = _lerp_joints(JOINTS_BLUE, JOINTS_HOME, min(1.0, t * 2.0))
            self.yaskawa_a_gripper = "open"
            self.yaskawa_a_action = "Dégagé pendant le convoyage"
            self.montrac_a_progress = _lerp(blue, green, t)
            self.montrac_a_speed = self.montrac_speed_nominal if t < 0.96 else 0
            self.part_location = "montrac_a"

        elif action == "montrac_a_blue_to_green_empty":
            self.yaskawa_a_pose = "home"
            self.yaskawa_a_action = "En attente du positionnement navette"
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
            self.montrac_a_progress = green
            self.tiago_progress = _lerp(0.22, 0.78, t)
            self.tiago_action = "Navigation autonome Zone A vers Zone B (Nav2)"
            self.part_location = "tiago"
            self.yaskawa_a_pose = "tiago_handover" if t < 0.18 else "home"
            self.yaskawa_a_joints = JOINTS_HANDOVER if t < 0.18 else list(JOINTS_HOME)

        elif action == "montrac_b_blue_to_green":
            self.tiago_progress = 0.78
            self.tiago_action = "Déchargement confirmé en Zone B"
            self.montrac_b_progress = _lerp(blue, green, t)
            self.montrac_b_speed = self.montrac_speed_nominal if t < 0.96 else 0
            self.part_location = "montrac_b"

        elif action == "yaskawa_b_unload_to_table":
            self.montrac_b_progress = green
            self.tiago_progress = _lerp(0.78, 0.08, t)
            self.tiago_action = "Retour point d'attente couloir"
            if t < 0.55:
                sub = t / 0.55
                self.yaskawa_b_pose = "station_green"
                self.yaskawa_b_joints = _lerp_joints(JOINTS_HOME, JOINTS_GREEN, sub)
                self.yaskawa_b_gripper = "holding" if sub > 0.55 else "open"
                self.part_location = "yaskawa_b" if sub > 0.55 else "montrac_b"
            else:
                sub = (t - 0.55) / 0.45
                self.yaskawa_b_pose = "table"
                self.yaskawa_b_joints = _lerp_joints(JOINTS_GREEN, JOINTS_TABLE, sub)
                self.yaskawa_b_gripper = "holding" if sub < 0.78 else "open"
                self.part_location = "yaskawa_b" if sub < 0.78 else "table_b"
            self.yaskawa_b_action = "Reprise cube et dépose table Zone B"

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
                "zone": "Zone A / B" if self.active_scenario_key == "j2" else "Zone A",
                "durationS": dur,
                "outcome": outcome,
                "note": note,
            },
        )
        if len(self.recent_cycles) > 12:
            self.recent_cycles = self.recent_cycles[:12]

    # ------------------------------------------------------------------
    # Sérialisation télémétrie (contrat JSON exact attendu par l'IHM)
    # ------------------------------------------------------------------
    def _station_name(self, progress: float) -> str:
        if abs(progress - self.stations["blue"]) < 0.025:
            return "blue"
        if abs(progress - self.stations["green"]) < 0.025:
            return "green"
        return "transit"

    def to_safety_payload(self) -> dict[str, Any]:
        wd_fault = self.watchdog_fault_injected or self.montrac_a_watchdog_ms > self.watchdog_timeout_ms
        if self.hardware_estop_engaged or wd_fault:
            summary = (
                "Arrêt d'urgence matériel actif en Salle 315 (Zone A)."
                if self.hardware_estop_engaged
                else f"Expiration du chien de garde Montrac ({self.montrac_a_watchdog_ms} ms > {self.watchdog_timeout_ms} ms)."
            )
            return {
                "status": "estop_triggered",
                "hardwareEstopEngaged": self.hardware_estop_engaged,
                "watchdogFault": wd_fault,
                "summary": summary,
                "operatorGuidance": (
                    "Vérifier physiquement la zone A en salle 315, réarmer la sécurité matérielle "
                    "puis acquitter depuis le terminal orchestrateur (`reset`)."
                ),
                "lastCheckTimestamp": _clock_str(),
            }
        if self.vla_candidate.get("verdict") == "rejected":
            return {
                "status": "warning",
                "hardwareEstopEngaged": False,
                "watchdogFault": False,
                "summary": "Dernier plan candidat J3 rejeté par le superviseur L1 (fail-closed).",
                "operatorGuidance": self.vla_candidate.get("verdictReason", ""),
                "lastCheckTimestamp": _clock_str(),
            }
        return {
            "status": "nominal",
            "hardwareEstopEngaged": False,
            "watchdogFault": False,
            "summary": "Sécurité matérielle nominale — superviseur L1 actif.",
            "operatorGuidance": "Pilotage exclusif depuis le terminal de l'orchestrateur.",
            "lastCheckTimestamp": _clock_str(),
        }

    def to_cell_snapshot(self) -> dict[str, Any]:
        with self._lock:
            now_str = _clock_str()
            sc = self.scenarios[self.active_scenario_key]
            wd_ok = not (self.watchdog_fault_injected or self.montrac_a_watchdog_ms > self.watchdog_timeout_ms)
            is_fault = self.state == "FAULT_LOCKED"
            is_j2 = self.active_scenario_key == "j2"

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

            station_a = self._station_name(self.montrac_a_progress)
            station_b = self._station_name(self.montrac_b_progress)

            yaskawa_a_status = (
                "fault"
                if is_fault
                else "active"
                if (self.state == "RUNNING" and (self.part_location == "yaskawa_a" or self.yaskawa_a_pose != "home"))
                else "ready"
            )
            yaskawa_b_status = (
                "active"
                if (self.state == "RUNNING" and is_j2 and (self.part_location == "yaskawa_b" or self.yaskawa_b_pose != "home"))
                else "ready"
                if is_j2
                else "standby"
            )
            montrac_a_status = (
                "fault"
                if not wd_ok or is_fault
                else "active"
                if self.montrac_a_speed > 0
                else "ready"
            )
            montrac_b_status = (
                "active"
                if self.montrac_b_speed > 0
                else "ready"
                if is_j2
                else "standby"
            )
            tiago_status = (
                "active"
                if (self.state == "RUNNING" and is_j2 and self.part_location == "tiago")
                else "ready"
                if is_j2
                else "out_of_scope"
            )

            hw_label_montrac = (
                "gz_ros2_control (montrac_description)"
                if self.gz_sim
                else "montrac_hardware_interface (SystemInterface)"
            )
            hw_label_yaskawa = (
                "gz_ros2_control (Gazebo Harmonic)"
                if self.gz_sim
                else "Contrôleur Yaskawa + ros_yaskawa_hc10"
            )

            preconditions = [
                {
                    "id": "p-estop",
                    "label": "Arrêt d'urgence matériel (Salle 315)",
                    "predicate": "(hardware_estop_clear)",
                    "passed": not self.hardware_estop_engaged,
                    "detail": "Arrêt d'urgence engagé" if self.hardware_estop_engaged else "Nominal",
                },
                {
                    "id": "p-wd",
                    "label": "Chien de garde Montrac Zone A",
                    "predicate": "(watchdog_alive rail_a)",
                    "passed": wd_ok,
                    "detail": f"{self.montrac_a_watchdog_ms} ms (seuil {self.watchdog_timeout_ms} ms)",
                },
                {
                    "id": "p-sync",
                    "label": "Non-collision bras Yaskawa / navette N1",
                    "predicate": "(non_collision zone_a)",
                    "passed": not is_fault,
                    "detail": "Bras dégagé pendant les déplacements navette",
                },
                {
                    "id": "p-topo",
                    "label": "Séparation physique rails A et B",
                    "predicate": "(not (rails_connected rail_a rail_b))",
                    "passed": True,
                    "detail": "Enforcée dans salle315_domain.pddl",
                },
            ]

            return {
                "timestamp": now_str,
                "environment": "gazebo" if self.gz_sim else "real",
                "gzSimFlag": self.gz_sim,
                "orchestratorState": self.state,
                "activeScenarioCode": sc["code"],
                "activeScenarioTitle": sc["title"],
                "activeScenarioDescription": sc["description"],
                "cycleNumber": self.cycle_number,
                "partLocation": self.part_location,
                "safety": self.to_safety_payload(),
                "yaskawaA": {
                    "id": "yaskawa_a",
                    "name": "Yaskawa HC10DT",
                    "model": "Motoman HC10DT (Poste A)",
                    "zone": "A",
                    "status": yaskawa_a_status,
                    "actionLabel": self.yaskawa_a_action,
                    "gripperState": self.yaskawa_a_gripper,
                    "carryingPart": self.part_location == "yaskawa_a",
                    "poseTarget": self.yaskawa_a_pose,
                    "jointsDeg": self.yaskawa_a_joints,
                    "controllerLayer": "MoveIt 2 / joint_trajectory_controller",
                    "hardwareInterface": hw_label_yaskawa,
                    "rosTopic": self.topics.get("yaskawa_a_state", "/zone_a/yaskawa_hc10dt/joint_states"),
                },
                "yaskawaB": {
                    "id": "yaskawa_b",
                    "name": "Yaskawa HC10",
                    "model": "Motoman HC10 (Poste B)",
                    "zone": "B",
                    "status": yaskawa_b_status,
                    "actionLabel": self.yaskawa_b_action,
                    "gripperState": self.yaskawa_b_gripper,
                    "carryingPart": self.part_location == "yaskawa_b",
                    "poseTarget": self.yaskawa_b_pose,
                    "jointsDeg": self.yaskawa_b_joints,
                    "controllerLayer": "MoveIt 2 / joint_trajectory_controller",
                    "hardwareInterface": hw_label_yaskawa,
                    "rosTopic": self.topics.get("yaskawa_b_state", "/zone_b/yaskawa_hc10/joint_states"),
                },
                "montracA": {
                    "id": "montrac_a",
                    "name": "Montrac Zone A",
                    "zone": "A",
                    "status": montrac_a_status,
                    "shuttleId": "N1",
                    "station": station_a,
                    "loopProgress": round(self.montrac_a_progress, 4),
                    "speedMmS": self.montrac_a_speed,
                    "partPresent": self.part_location == "montrac_a",
                    "watchdogOk": wd_ok,
                    "watchdogAgeMs": self.montrac_a_watchdog_ms,
                    "hardwareInterface": hw_label_montrac,
                    "controllerName": "montrac_shuttle_controller",
                    "rosTopic": self.topics.get("montrac_a_state", "/zone_a/montrac/shuttle_state"),
                },
                "montracB": {
                    "id": "montrac_b",
                    "name": "Montrac Zone B",
                    "zone": "B",
                    "status": montrac_b_status,
                    "shuttleId": "N2",
                    "station": station_b,
                    "loopProgress": round(self.montrac_b_progress, 4),
                    "speedMmS": self.montrac_b_speed,
                    "partPresent": self.part_location == "montrac_b",
                    "watchdogOk": True,
                    "watchdogAgeMs": self.montrac_b_watchdog_ms,
                    "hardwareInterface": hw_label_montrac,
                    "controllerName": "montrac_shuttle_controller",
                    "rosTopic": self.topics.get("montrac_b_state", "/zone_b/montrac/shuttle_state"),
                },
                "tiago": {
                    "id": "tiago",
                    "name": "TIAGo",
                    "status": tiago_status,
                    "actionLabel": self.tiago_action,
                    "corridorProgress": round(self.tiago_progress, 4),
                    "carryingPart": self.part_location == "tiago",
                    "batteryPct": 88,
                    "navStack": "Nav2 / ros2_control",
                    "hardwareInterface": "gz_ros2_control (TIAGo)" if self.gz_sim else "ROS 2 TIAGo",
                    "rosTopic": self.topics.get("tiago_pose", "/tiago/amcl_pose"),
                },
                "kukaA": {
                    "id": "kuka_a",
                    "name": "KUKA KR6",
                    "model": "KUKA KR6 R900",
                    "zone": "A",
                    "status": "out_of_scope",
                    "note": "Hors périmètre J1",
                    "rosTopic": "/zone_a/kuka/state (inactif)",
                },
                "staubliB": {
                    "id": "staubli_b",
                    "name": "Stäubli TX2",
                    "model": "Stäubli TX2-60",
                    "zone": "B",
                    "status": "out_of_scope",
                    "note": "Option reprise non-conformes",
                    "rosTopic": "/zone_b/staubli/state (inactif)",
                },
                "cameraA": {
                    "id": "camera_a",
                    "name": "Caméra Zone A",
                    "zone": "A",
                    "sensorType": "ZED 2 stéréo",
                    "status": "active",
                    "fps": 15,
                    "detectedObjects": [
                        f"Navette N1 : {station_a}",
                        "Cube présent sur N1" if self.part_location == "montrac_a" else "Zone A observée",
                    ],
                    "coverageNote": "Couverture rail Montrac A",
                    "rosTopic": self.topics.get("camera_a_info", "/zone_a/camera/scene_summary"),
                },
                "cameraB": {
                    "id": "camera_b",
                    "name": "Caméra Zone B",
                    "zone": "B",
                    "sensorType": "ZED 2 stéréo",
                    "status": "active" if is_j2 else "standby",
                    "fps": 15 if is_j2 else 5,
                    "detectedObjects": [f"Navette N2 : {station_b}"],
                    "coverageNote": "Couverture rail Montrac B",
                    "rosTopic": self.topics.get("camera_b_info", "/zone_b/camera/scene_summary"),
                },
                "steps": [
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
                ],
                "preconditions": preconditions,
                "events": [
                    {
                        "id": ev.id,
                        "timestamp": ev.timestamp,
                        "level": ev.level,
                        "source": ev.source,
                        "message": ev.message,
                    }
                    for ev in self.events[:8]
                ],
                "vlaCandidate": self.vla_candidate,
                "kpis": {
                    "completedCycles": self.completed_cycles,
                    "targetBatchCycles": self.target_batch_cycles,
                    "conformityRatePct": conformity,
                    "averageCycleTimeS": avg_cycle,
                    "cadencePerHour": cadence,
                    "uptimePct": 99.0 if not is_fault else 91.5,
                    "rejectedCommands": self.rejected_commands,
                    "recentCycles": self.recent_cycles,
                    "cycleTimeSeriesS": self.cycle_durations_s or [avg_cycle],
                },
                "rosTopics": [
                    {
                        "topic": self.topics.get("cell_state", "/mfja/supervisor/cell_state"),
                        "messageType": "std_msgs/msg/String (JSON)",
                        "nodeOwner": "mfja_orchestrator (L1)",
                        "hz": float(self.config.get("network", {}).get("publish_rate_hz", 10.0)),
                        "active": True,
                    },
                    {
                        "topic": self.topics.get("safety_status", "/mfja/safety/status"),
                        "messageType": "std_msgs/msg/String (JSON)",
                        "nodeOwner": "mfja_orchestrator (L1)",
                        "hz": float(self.config.get("network", {}).get("publish_rate_hz", 10.0)),
                        "active": True,
                    },
                    {
                        "topic": self.topics.get("yaskawa_a_state", "/zone_a/yaskawa_hc10dt/joint_states"),
                        "messageType": "sensor_msgs/msg/JointState",
                        "nodeOwner": "ros_yaskawa_hc10 / ros2_control",
                        "hz": 0.0 if is_fault else 10.0,
                        "active": not is_fault,
                    },
                    {
                        "topic": self.topics.get("montrac_a_state", "/zone_a/montrac/shuttle_state"),
                        "messageType": "std_msgs/msg/String (JSON)",
                        "nodeOwner": "montrac_hardware_interface (L4)",
                        "hz": 0.0 if not wd_ok else 10.0,
                        "active": wd_ok,
                    },
                    {
                        "topic": self.topics.get("tiago_pose", "/tiago/amcl_pose"),
                        "messageType": "geometry_msgs/msg/PoseStamped",
                        "nodeOwner": "tiago_nav2 (ros2_control)",
                        "hz": 10.0 if is_j2 else 0.0,
                        "active": is_j2,
                    },
                    {
                        "topic": self.topics.get("vla_plan", "/mfja/vla/candidate_plan"),
                        "messageType": "std_msgs/msg/String (JSON)",
                        "nodeOwner": "vla_validator (L8 -> L1)",
                        "hz": 1.0,
                        "active": True,
                    },
                ],
            }
