"""Nœud ROS 2 Jazzy `mfja_orchestrator` + pont WebSocket bidirectionnel + CLI terminal.

- Souscrit en direct à tous les topics ROS 2 `/usine40/*`, `/yaskawa_*`, `/staubli1/*` et `/room_315/*`
- Appelle en direct les services ROS 2 `/usine40/supervision/*`, `/usine40/safety/*`, `/usine40/nl/*`, `/usine40/perception/*`
- Diffuse simultanément l'état complet vers l'IHM React sur `ws://<host>:<port>` (défaut `9090`) et sur `/mfja/*`
- Reçoit en retour les ordres de production, E-Stop, pause, reset, présence opérateur et consignes NL depuis l'IHM ou le CLI
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import math
from pathlib import Path
import sys
import threading
import time
from typing import Any, Callable

from mfja_orchestrator.supervisor import CellSupervisor
from mfja_orchestrator.ws_bridge import RosbridgeServer

try:
    import rclpy
    from rclpy.callback_groups import ReentrantCallbackGroup
    from rclpy.executors import MultiThreadedExecutor
    from rclpy.node import Node
    from rclpy.qos import HistoryPolicy, QoSProfile, ReliabilityPolicy
    from geometry_msgs.msg import PoseStamped, Twist
    from sensor_msgs.msg import JointState
    from std_msgs.msg import String as RosString
    from std_srvs.srv import SetBool, Trigger

    HAS_RCLPY = True
except ImportError:
    HAS_RCLPY = False

try:
    from nav_msgs.msg import Odometry

    HAS_NAV_MSGS = True
except ImportError:
    HAS_NAV_MSGS = False

try:
    from usine40_interfaces.msg import (
        CellKpi,
        InspectionResult,
        NaturalLanguagePlanProposal,
        SafetyStatus,
        StationStatus,
        WorkpieceState,
    )
    from usine40_interfaces.srv import (
        ApprovePlanProposal,
        InspectPart,
        ParseNaturalLanguage,
        StartProductionOrder,
    )

    HAS_USINE40_INTERFACES = True
except ImportError:
    HAS_USINE40_INTERFACES = False

try:
    from mfja_rail_interfaces.msg import ShuttleState

    HAS_MFJA_RAIL = True
except ImportError:
    HAS_MFJA_RAIL = False


CLI_HELP = """
Commandes orchestrateur L1 (Salle 315 MFJA — Liaison TIAGo Bloc A <-> Bloc B) :
  start order [qty] [--defect N]  Lancer un ordre de production complet sur la simulation ROS 2
  start j1 [--loop]               Lancer le scénario local Bloc A (J1)
  start j1_alt [--loop]           Lancer le scénario reconfiguré Bloc A (J1-ALT)
  start j2 [--loop]               Lancer le transfert Bloc A -> Bloc B par TIAGo (J2)
  pause | resume                  Mettre en pause ou reprendre la production
  stop                            Arrêter proprement le cycle en cours
  propose <texte>                 Soumettre une consigne langage naturel (validation L1 + Lot 8)
  approve [proposal_id]           Approuver la dernière proposition langage naturel validée
  human on | off                  Activer/désactiver la présence opérateur collaboratif ISO 15066
  env real | gazebo               Basculer gz_sim (plateau réel / Gazebo Harmonic)
  fault estop | watchdog          Déclencher l'arrêt d'urgence ou un défaut chien de garde
  reset                           Acquitter E-Stop / défauts et réinitialiser la cellule
  status                          Afficher l'état courant
  help                            Afficher cette aide
  quit                            Arrêter l'orchestrateur
""".strip()


def _quaternion_to_yaw(x: float, y: float, z: float, w: float) -> float:
    siny_cosp = 2.0 * (w * z + x * y)
    cosy_cosp = 1.0 - 2.0 * (y * y + z * z)
    return math.atan2(siny_cosp, cosy_cosp)


def _default_config_path() -> Path:
    here = Path(__file__).resolve()
    candidates = [
        here.parent.parent / "config" / "cell_config.yaml",
        here.parent.parent.parent.parent / "share" / "mfja_orchestrator" / "config" / "cell_config.yaml",
    ]
    try:
        from ament_index_python.packages import get_package_share_directory

        candidates.insert(0, Path(get_package_share_directory("mfja_orchestrator")) / "config" / "cell_config.yaml")
    except Exception:
        pass
    for c in candidates:
        if c.exists():
            return c
    raise FileNotFoundError("Impossible de localiser config/cell_config.yaml")


@dataclass
class SimBackendCallbacks:
    """Callbacks optionnels vers les services ROS 2 `/usine40/*`."""

    start_order: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None
    set_pause: Callable[[bool], dict[str, Any] | None] | None = None
    reset_cell: Callable[[], dict[str, Any] | None] | None = None
    set_estop: Callable[[bool], dict[str, Any] | None] | None = None
    set_human: Callable[[bool], dict[str, Any] | None] | None = None
    parse_nl: Callable[[str, bool], dict[str, Any] | None] | None = None
    approve_nl: Callable[[str, bool], dict[str, Any] | None] | None = None
    inspect_part: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None


class OrchestratorCommandDispatcher:
    """Routeur de commandes unifié (WebSocket IHM + CLI + topic ROS 2) vers Sim ROS 2 + Superviseur L1."""

    def __init__(
        self,
        supervisor: CellSupervisor,
        sim_callbacks: SimBackendCallbacks | None = None,
        on_state_mutated: Callable[[], None] | None = None,
    ) -> None:
        self.supervisor = supervisor
        self.sim = sim_callbacks or SimBackendCallbacks()
        self.on_state_mutated = on_state_mutated

    def _notify(self) -> None:
        if self.on_state_mutated is not None:
            try:
                self.on_state_mutated()
            except Exception:
                pass

    def handle_service(self, service: str, args: dict[str, Any]) -> dict[str, Any]:
        svc = service.strip()

        if svc in ("/usine40/supervision/start_order", "/mfja/orchestrator/start_order"):
            scenario = str(args.get("scenario", "")).strip().lower()
            if scenario in self.supervisor.scenarios and not args.get("force_sim_order", False):
                if self.sim.start_order is not None and scenario == "j2":
                    sim_res = self.sim.start_order(
                        {
                            "batch_id": str(args.get("batch_id", "")),
                            "quantity": max(1, int(args.get("quantity", 1))),
                            "enable_qc": bool(args.get("enable_qc", True)),
                            "enable_rework": bool(args.get("enable_rework", True)),
                            "inject_defect_on_index": max(0, int(args.get("inject_defect_on_index", 0))),
                            "source": str(args.get("source", "ihm_react")),
                        }
                    )
                    if sim_res is not None:
                        self._notify()
                        return sim_res
                msg = self.supervisor.start_scenario(scenario, loop=bool(args.get("loop", False)))
                ok = msg.startswith("OK")
                self._notify()
                return {"ok": ok, "accepted": ok, "message": msg}

            payload = {
                "batch_id": str(args.get("batch_id", "")),
                "quantity": max(1, int(args.get("quantity", 1))),
                "enable_qc": bool(args.get("enable_qc", True)),
                "enable_rework": bool(args.get("enable_rework", True)),
                "inject_defect_on_index": max(0, int(args.get("inject_defect_on_index", 0))),
                "source": str(args.get("source", "ihm_react")),
            }
            if self.sim.start_order is not None:
                sim_res = self.sim.start_order(payload)
                if sim_res is not None:
                    self._notify()
                    return sim_res

            # Fallback autonome : exécuter J2 (transfert TIAGo A -> B)
            msg = self.supervisor.start_scenario("j2", loop=False)
            ok = msg.startswith("OK")
            self._notify()
            return {
                "ok": ok,
                "accepted": ok,
                "batch_id": payload["batch_id"] or "LOCAL-J2",
                "message": msg,
            }

        if svc in ("/usine40/supervision/pause", "/mfja/orchestrator/pause"):
            paused = bool(args.get("paused", args.get("data", True)))
            if self.sim.set_pause is not None:
                sim_res = self.sim.set_pause(paused)
                if sim_res is not None:
                    self._notify()
                    return sim_res
            msg = self.supervisor.stop_cycle() if paused else self.supervisor.start_scenario("j2", loop=False)
            self._notify()
            return {"ok": True, "paused": paused, "message": msg}

        if svc in ("/usine40/supervision/reset", "/mfja/orchestrator/reset"):
            if self.sim.set_estop is not None and (
                self.supervisor.hardware_estop_engaged
                or bool(self.supervisor.sim_safety.get("estop_active", False))
            ):
                self.sim.set_estop(False)
            sim_msg = ""
            if self.sim.reset_cell is not None:
                sim_res = self.sim.reset_cell()
                if sim_res is not None:
                    sim_msg = str(sim_res.get("message", ""))
            local_msg = self.supervisor.reset_safety()
            self._notify()
            return {"ok": True, "message": sim_msg or local_msg}

        if svc in ("/usine40/safety/estop", "/mfja/safety/estop"):
            active = bool(args.get("active", args.get("data", True)))
            if active:
                local_msg = self.supervisor.inject_fault("estop")
            else:
                local_msg = self.supervisor.reset_safety()
            if self.sim.set_estop is not None:
                sim_res = self.sim.set_estop(active)
                if sim_res is not None:
                    self._notify()
                    return sim_res
            self._notify()
            return {"ok": True, "estop_active": active, "message": local_msg}

        if svc in ("/usine40/safety/set_human_presence", "/mfja/safety/human_presence"):
            present = bool(args.get("present", args.get("data", True)))
            self.supervisor.sim_safety["human_in_collab_zone"] = present
            self.supervisor.sim_safety["human_distance_m"] = 1.45 if present else 99.0
            self.supervisor.sim_safety["tiago_speed_scale"] = 0.35 if present else 1.0
            if self.sim.set_human is not None:
                sim_res = self.sim.set_human(present)
                if sim_res is not None:
                    self._notify()
                    return sim_res
            self._notify()
            return {
                "ok": True,
                "present": present,
                "message": "Opérateur collaboratif en zone (ISO 15066)" if present else "Opérateur hors zone",
            }

        if svc in ("/usine40/nl/parse", "/mfja/vla/parse"):
            instruction = str(args.get("instruction", "")).strip()
            auto_confirm = bool(args.get("auto_confirm", False))
            if not instruction:
                return {"ok": False, "message": "Consigne langage naturel vide."}

            topo_ok, _ = self.supervisor.check_topological_validity(instruction)
            if not topo_ok:
                reply = self.supervisor.evaluate_natural_language(instruction)
                self._notify()
                return {
                    "ok": False,
                    "success": False,
                    "proposal": self.supervisor.vla_candidate,
                    "message": reply,
                }

            if self.sim.parse_nl is not None:
                sim_res = self.sim.parse_nl(instruction, auto_confirm)
                if sim_res is not None:
                    self._notify()
                    return sim_res

            reply = self.supervisor.evaluate_natural_language(instruction)
            ok = reply.startswith("VALIDÉ")
            self._notify()
            return {
                "ok": ok,
                "success": ok,
                "proposal": self.supervisor.vla_candidate,
                "message": reply,
            }

        if svc in ("/usine40/nl/approve", "/mfja/vla/approve"):
            proposal_id = str(
                args.get("proposal_id")
                or self.supervisor.vla_candidate.get("proposalId")
                or ""
            ).strip()
            approve = bool(args.get("approve", True))
            if self.sim.approve_nl is not None and proposal_id:
                sim_res = self.sim.approve_nl(proposal_id, approve)
                if sim_res is not None:
                    self._notify()
                    return sim_res
            if approve and self.supervisor.vla_candidate.get("verdict") == "validated":
                msg = self.supervisor.start_scenario("j2", loop=False)
                self._notify()
                return {"ok": True, "accepted": True, "message": msg}
            return {"ok": False, "accepted": False, "message": "Aucune proposition valide à approuver."}

        if svc in ("/usine40/perception/inspect", "/mfja/perception/inspect"):
            if self.sim.inspect_part is not None:
                sim_res = self.sim.inspect_part(args)
                if sim_res is not None:
                    self._notify()
                    return sim_res
            return {"ok": False, "message": "Service d'inspection ZED 2 hors ligne."}

        if svc == "/mfja/orchestrator/cli":
            cmd_txt = str(args.get("command", "")).strip()
            reply = self.execute_text_command(cmd_txt)
            return {"ok": not reply.startswith(("REFUSÉ", "REJETÉ", "Commande inconnue")), "message": reply}

        return {"ok": False, "message": f"Service inconnu : {svc}"}

    def handle_publish(self, topic: str, msg: dict[str, Any]) -> dict[str, Any]:
        cli_topic = self.supervisor.topics.get("cli_command", "/mfja/orchestrator/cli_command")
        if topic in (cli_topic, "/mfja/orchestrator/command"):
            raw = str(msg.get("data") or msg.get("command") or "").strip()
            if raw:
                reply = self.execute_text_command(raw)
                return {"ok": True, "message": reply}
        return {"ok": False, "message": f"Topic d'écriture non supporté : {topic}"}

    def execute_text_command(self, raw: str) -> str:
        cmd = raw.strip()
        if not cmd:
            return ""
        parts = cmd.split()
        verb = parts[0].lower()
        rest = parts[1:]

        if verb == "start" and rest and rest[0].lower() == "order":
            qty = 1
            defect = 0
            for idx, tok in enumerate(rest[1:]):
                if tok.isdigit() and qty == 1:
                    qty = int(tok)
                if tok == "--defect" and idx + 2 < len(rest) and rest[idx + 2].isdigit():
                    defect = int(rest[idx + 2])
            res = self.handle_service(
                "/usine40/supervision/start_order",
                {"quantity": qty, "inject_defect_on_index": defect, "enable_qc": True, "enable_rework": True},
            )
            return str(res.get("message", ""))

        if verb == "start":
            sc_key = rest[0].lower() if rest else "j2"
            loop = "--loop" in rest or "loop" in rest
            res = self.handle_service(
                "/mfja/orchestrator/start_order", {"scenario": sc_key, "loop": loop}
            )
            return str(res.get("message", ""))

        if verb in ("pause", "resume"):
            res = self.handle_service("/usine40/supervision/pause", {"paused": verb == "pause"})
            return str(res.get("message", ""))

        if verb == "stop":
            if self.sim.set_pause is not None and self.supervisor.sim_connected:
                self.sim.set_pause(True)
            out = self.supervisor.stop_cycle()
            self._notify()
            return out

        if verb == "fault":
            kind = rest[0].lower() if rest else "estop"
            if kind == "estop":
                res = self.handle_service("/usine40/safety/estop", {"active": True})
                return str(res.get("message", ""))
            out = self.supervisor.inject_fault(kind)
            self._notify()
            return out

        if verb == "reset":
            res = self.handle_service("/usine40/supervision/reset", {})
            return str(res.get("message", ""))

        if verb == "human":
            present = (rest[0].lower() in ("on", "true", "1", "zone")) if rest else True
            res = self.handle_service("/usine40/safety/set_human_presence", {"present": present})
            return str(res.get("message", ""))

        if verb == "propose":
            text = " ".join(rest).strip()
            if not text:
                return "Usage : propose <consigne en langage naturel>"
            res = self.handle_service("/usine40/nl/parse", {"instruction": text, "auto_confirm": False})
            return str(res.get("message", ""))

        if verb == "approve":
            pid = rest[0] if rest else ""
            res = self.handle_service("/usine40/nl/approve", {"proposal_id": pid, "approve": True})
            return str(res.get("message", ""))

        out = self.supervisor.execute_cli_command(cmd)
        self._notify()
        return out


def _broadcast_snapshot(bridge: RosbridgeServer, supervisor: CellSupervisor) -> dict[str, Any]:
    snap = supervisor.to_cell_snapshot()
    topics = supervisor.topics
    bridge.broadcast_topic(
        topics.get("cell_state", "/mfja/supervisor/cell_state"),
        {"data": json.dumps(snap, ensure_ascii=False)},
    )
    bridge.broadcast_topic(
        topics.get("safety_status", "/mfja/safety/status"),
        {"data": json.dumps(snap["safety"], ensure_ascii=False)},
    )
    bridge.broadcast_topic(
        topics.get("supervisor_events", "/mfja/supervisor/events"),
        {"data": json.dumps(snap["events"], ensure_ascii=False)},
    )
    bridge.broadcast_topic(
        topics.get("cycle_status", "/mfja/supervisor/cycle_status"),
        {
            "data": json.dumps(
                {
                    "orchestratorState": snap["orchestratorState"],
                    "activeScenarioCode": snap["activeScenarioCode"],
                    "partLocation": snap["partLocation"],
                    "steps": snap["steps"],
                },
                ensure_ascii=False,
            )
        },
    )
    bridge.broadcast_topic(
        topics.get("montrac_a_state", "/zone_a/montrac/shuttle_state"),
        {"data": json.dumps(snap["montracA"], ensure_ascii=False)},
    )
    bridge.broadcast_topic(
        topics.get("montrac_b_state", "/zone_b/montrac/shuttle_state"),
        {"data": json.dumps(snap["montracB"], ensure_ascii=False)},
    )
    bridge.broadcast_topic(
        topics.get("vla_plan", "/mfja/vla/candidate_plan"),
        {"data": json.dumps(snap["vlaCandidate"], ensure_ascii=False)},
    )
    bridge.broadcast_topic(
        topics.get("camera_a_info", "/zone_a/camera/scene_summary"),
        {"data": json.dumps(snap["cameraA"], ensure_ascii=False)},
    )
    bridge.broadcast_topic(
        topics.get("camera_b_info", "/zone_b/camera/scene_summary"),
        {"data": json.dumps(snap["cameraB"], ensure_ascii=False)},
    )
    return snap


if HAS_RCLPY:

    class MfjaOrchestratorNode(Node):
        def __init__(
            self,
            supervisor: CellSupervisor,
            bridge: RosbridgeServer,
            dispatcher: OrchestratorCommandDispatcher,
        ) -> None:
            super().__init__("mfja_orchestrator")
            self.supervisor = supervisor
            self.bridge = bridge
            self.dispatcher = dispatcher
            self._cb_group = ReentrantCallbackGroup()

            self.declare_parameter("gz_sim", supervisor.gz_sim)
            self.declare_parameter("ws_host", bridge.host)
            self.declare_parameter("ws_port", bridge.port)
            self.declare_parameter("hmi_url", supervisor.hmi_http_url)
            self.declare_parameter("service_timeout_sec", 4.0)

            self.supervisor.gz_sim = bool(self.get_parameter("gz_sim").value)
            self.supervisor.hmi_http_url = str(self.get_parameter("hmi_url").value)
            self._service_timeout = float(self.get_parameter("service_timeout_sec").value)

            t = supervisor.topics
            u = supervisor.usine40_topics
            s = supervisor.usine40_services

            sensor_qos = QoSProfile(
                reliability=ReliabilityPolicy.BEST_EFFORT,
                history=HistoryPolicy.KEEP_LAST,
                depth=5,
            )

            # Publications `/mfja/*` et `/zone_{a,b}/*`
            self.pub_cell = self.create_publisher(
                RosString, t.get("cell_state", "/mfja/supervisor/cell_state"), 10
            )
            self.pub_safety = self.create_publisher(
                RosString, t.get("safety_status", "/mfja/safety/status"), 10
            )
            self.pub_events = self.create_publisher(
                RosString, t.get("supervisor_events", "/mfja/supervisor/events"), 10
            )
            self.pub_montrac_a = self.create_publisher(
                RosString, t.get("montrac_a_state", "/zone_a/montrac/shuttle_state"), 10
            )
            self.pub_montrac_b = self.create_publisher(
                RosString, t.get("montrac_b_state", "/zone_b/montrac/shuttle_state"), 10
            )
            self.pub_vla = self.create_publisher(
                RosString, t.get("vla_plan", "/mfja/vla/candidate_plan"), 10
            )
            self.pub_joints_a = self.create_publisher(
                JointState, t.get("yaskawa_a_state", "/zone_a/yaskawa_hc10dt/joint_states"), 10
            )
            self.pub_joints_b = self.create_publisher(
                JointState, t.get("yaskawa_b_state", "/zone_b/yaskawa_hc10/joint_states"), 10
            )
            self.pub_tiago = self.create_publisher(
                PoseStamped, t.get("tiago_pose", "/tiago/amcl_pose"), 10
            )

            # Abonnement commandes CLI ROS 2
            self.create_subscription(
                RosString,
                t.get("cli_command", "/mfja/orchestrator/cli_command"),
                self._on_ros_cli_command,
                10,
                callback_group=self._cb_group,
            )

            # Abonnements temps réel à la simulation Gazebo / ROS 2
            self.create_subscription(
                PoseStamped,
                u.get("tiago_world_pose", "/usine40/tiago/world_pose"),
                self._on_tiago_pose,
                10,
                callback_group=self._cb_group,
            )
            self.create_subscription(
                Twist,
                u.get("tiago_cmd_vel", "/tiago1/cmd_vel"),
                lambda msg: self.supervisor.ingest_sim_tiago_cmd_vel(
                    msg.linear.x, msg.angular.z
                ),
                sensor_qos,
                callback_group=self._cb_group,
            )
            self.create_subscription(
                JointState,
                u.get("tiago_joint_states", "/tiago1/joint_states"),
                lambda msg: self.supervisor.ingest_sim_tiago_joints(
                    list(msg.name), list(msg.position)
                ),
                sensor_qos,
                callback_group=self._cb_group,
            )
            if HAS_NAV_MSGS:
                self.create_subscription(
                    Odometry,
                    u.get("tiago_odom", "/tiago1/odom"),
                    lambda msg: self.supervisor.ingest_sim_tiago_odom(
                        msg.twist.twist.linear.x, msg.twist.twist.angular.z
                    ),
                    sensor_qos,
                    callback_group=self._cb_group,
                )
            self.create_subscription(
                PoseStamped,
                u.get("human_pose", "/usine40/safety/human_pose"),
                self._on_human_pose,
                10,
                callback_group=self._cb_group,
            )
            def _ordered_joints(msg: JointState) -> list[float]:
                names = list(msg.name)
                pos = list(msg.position)
                if len(names) == len(pos) and names:
                    nmap = dict(zip(names, pos))
                    for keys in (
                        ("joint_1", "joint_2", "joint_3", "joint_4", "joint_5", "joint_6"),
                        ("joint_1_s", "joint_2_l", "joint_3_u", "joint_4_r", "joint_5_b", "joint_6_t"),
                    ):
                        if all(k in nmap for k in keys):
                            return [float(nmap[k]) for k in keys]
                return [float(v) for v in pos[:6]]

            self.create_subscription(
                JointState,
                u.get("yaskawa_a_joints", "/yaskawa_hc10dt_1/joint_states"),
                lambda msg: self.supervisor.ingest_sim_joints("yaskawa_a", _ordered_joints(msg)),
                sensor_qos,
                callback_group=self._cb_group,
            )
            self.create_subscription(
                JointState,
                u.get("yaskawa_left_joints", "/yaskawa_LEFT/joint_state_broadcaster/joint_states"),
                lambda msg: self.supervisor.ingest_sim_joints("yaskawa_a", _ordered_joints(msg)),
                sensor_qos,
                callback_group=self._cb_group,
            )
            self.create_subscription(
                JointState,
                u.get("yaskawa_b_joints", "/yaskawa_hc10_1/joint_states"),
                lambda msg: self.supervisor.ingest_sim_joints("yaskawa_b", _ordered_joints(msg)),
                sensor_qos,
                callback_group=self._cb_group,
            )
            self.create_subscription(
                JointState,
                u.get("yaskawa_right_joints", "/yaskawa_RIGHT/joint_state_broadcaster/joint_states"),
                lambda msg: self.supervisor.ingest_sim_joints("yaskawa_b", _ordered_joints(msg)),
                sensor_qos,
                callback_group=self._cb_group,
            )
            self.create_subscription(
                JointState,
                u.get("staubli_joints", "/staubli1/joint_states"),
                lambda msg: self.supervisor.ingest_sim_joints("staubli", list(msg.position)),
                sensor_qos,
                callback_group=self._cb_group,
            )
            self.create_subscription(
                RosString,
                u.get("workpieces_states", "/usine40/workpieces/states"),
                lambda msg: self.supervisor.ingest_sim_workpieces_json(msg.data),
                10,
                callback_group=self._cb_group,
            )
            self.create_subscription(
                RosString,
                u.get("traceability", "/usine40/traceability"),
                lambda msg: self.supervisor.ingest_sim_traceability(msg.data),
                50,
                callback_group=self._cb_group,
            )

            # Clients std_srvs toujours disponibles
            self._cli_pause = self.create_client(
                SetBool, s.get("pause", "/usine40/supervision/pause"), callback_group=self._cb_group
            )
            self._cli_reset = self.create_client(
                Trigger, s.get("reset", "/usine40/supervision/reset"), callback_group=self._cb_group
            )
            self._cli_estop = self.create_client(
                SetBool, s.get("estop", "/usine40/safety/estop"), callback_group=self._cb_group
            )
            self._cli_human = self.create_client(
                SetBool,
                s.get("human_presence", "/usine40/safety/set_human_presence"),
                callback_group=self._cb_group,
            )

            if HAS_USINE40_INTERFACES:
                self.create_subscription(
                    CellKpi,
                    u.get("kpi", "/usine40/kpi"),
                    self._on_sim_kpi,
                    10,
                    callback_group=self._cb_group,
                )
                self.create_subscription(
                    SafetyStatus,
                    u.get("safety_status", "/usine40/safety/status"),
                    self._on_sim_safety,
                    10,
                    callback_group=self._cb_group,
                )
                for st_topic in (
                    u.get("stations_status", "/usine40/stations/status"),
                    u.get("montrac_status", "/usine40/montrac/status"),
                    u.get("tiago_status", "/usine40/tiago/status"),
                ):
                    self.create_subscription(
                        StationStatus,
                        st_topic,
                        self._on_sim_station,
                        20,
                        callback_group=self._cb_group,
                    )
                self.create_subscription(
                    WorkpieceState,
                    u.get("active_workpiece", "/usine40/workpieces/active_state"),
                    self._on_sim_workpiece,
                    10,
                    callback_group=self._cb_group,
                )
                self.create_subscription(
                    InspectionResult,
                    u.get("inspection_a", "/usine40/perception/poste_a/result"),
                    lambda msg: self._on_sim_inspection("poste_a", msg),
                    10,
                    callback_group=self._cb_group,
                )
                self.create_subscription(
                    InspectionResult,
                    u.get("inspection_b", "/usine40/perception/poste_b/result"),
                    lambda msg: self._on_sim_inspection("poste_b", msg),
                    10,
                    callback_group=self._cb_group,
                )
                self.create_subscription(
                    NaturalLanguagePlanProposal,
                    u.get("nl_proposals", "/usine40/nl/proposals"),
                    self._on_sim_nl_proposal,
                    10,
                    callback_group=self._cb_group,
                )

                self._cli_start_order = self.create_client(
                    StartProductionOrder,
                    s.get("start_order", "/usine40/supervision/start_order"),
                    callback_group=self._cb_group,
                )
                self._cli_nl_parse = self.create_client(
                    ParseNaturalLanguage,
                    s.get("nl_parse", "/usine40/nl/parse"),
                    callback_group=self._cb_group,
                )
                self._cli_nl_approve = self.create_client(
                    ApprovePlanProposal,
                    s.get("nl_approve", "/usine40/nl/approve"),
                    callback_group=self._cb_group,
                )
                self._cli_inspect = self.create_client(
                    InspectPart,
                    s.get("inspect_part", "/usine40/perception/inspect"),
                    callback_group=self._cb_group,
                )
            else:
                self._cli_start_order = None
                self._cli_nl_parse = None
                self._cli_nl_approve = None
                self._cli_inspect = None

            self._shuttle_world_poses: dict[str, dict[str, float]] = {}
            self.create_subscription(
                PoseStamped,
                u.get("shuttle_left_pose_cmd", "/room_315/rails/left/shuttles/pose_cmd"),
                lambda msg: self._on_shuttle_pose_cmd("left", msg),
                10,
                callback_group=self._cb_group,
            )
            self.create_subscription(
                PoseStamped,
                u.get("shuttle_right_pose_cmd", "/room_315/rails/right/shuttles/pose_cmd"),
                lambda msg: self._on_shuttle_pose_cmd("right", msg),
                10,
                callback_group=self._cb_group,
            )
            if HAS_MFJA_RAIL:
                self.create_subscription(
                    ShuttleState,
                    u.get("shuttle_left_state", "/room_315/rails/left/shuttles/state"),
                    lambda msg: self._on_shuttle("left", msg),
                    10,
                    callback_group=self._cb_group,
                )
                self.create_subscription(
                    ShuttleState,
                    u.get("shuttle_right_state", "/room_315/rails/right/shuttles/state"),
                    lambda msg: self._on_shuttle("right", msg),
                    10,
                    callback_group=self._cb_group,
                )

            # Connecte les callbacks ROS 2 au dispatcher bidirectionnel
            self.dispatcher.sim = SimBackendCallbacks(
                start_order=self._call_start_order,
                set_pause=self._call_pause,
                reset_cell=self._call_reset,
                set_estop=self._call_estop,
                set_human=self._call_human,
                parse_nl=self._call_nl_parse,
                approve_nl=self._call_nl_approve,
                inspect_part=self._call_inspect,
            )

            rate_hz = float(supervisor.config.get("network", {}).get("publish_rate_hz", 10.0))
            self._dt = 1.0 / max(1.0, rate_hz)
            self.create_timer(self._dt, self._on_tick, callback_group=self._cb_group)
            self.get_logger().info(
                f"Orchestrateur L1 ROS 2 démarré ({rate_hz:.0f} Hz) — pont IHM bidirectionnel sur ws://{bridge.host}:{bridge.port}"
            )

        # ---- Callbacks souscriptions simulation ----
        def _on_ros_cli_command(self, msg: RosString) -> None:
            reply = self.dispatcher.execute_text_command(msg.data)
            if reply:
                self.get_logger().info(f"[CLI ROS] {msg.data} -> {reply}")

        def _on_tiago_pose(self, msg: PoseStamped) -> None:
            p = msg.pose.position
            q = msg.pose.orientation
            self.supervisor.ingest_sim_tiago_pose(
                p.x, p.y, p.z, _quaternion_to_yaw(q.x, q.y, q.z, q.w)
            )

        def _on_human_pose(self, msg: PoseStamped) -> None:
            p = msg.pose.position
            q = msg.pose.orientation
            self.supervisor.ingest_sim_human_pose(
                p.x, p.y, p.z, _quaternion_to_yaw(q.x, q.y, q.z, q.w)
            )

        def _on_sim_kpi(self, msg: Any) -> None:
            self.supervisor.ingest_sim_kpi(
                {
                    "line_state": msg.line_state,
                    "active_batch_id": msg.active_batch_id,
                    "target_quantity": msg.target_quantity,
                    "parts_started": msg.parts_started,
                    "parts_completed": msg.parts_completed,
                    "parts_conforming_first_pass": msg.parts_conforming_first_pass,
                    "parts_reworked": msg.parts_reworked,
                    "parts_scrapped": msg.parts_scrapped,
                    "wip_count": msg.wip_count,
                    "availability_ratio": msg.availability_ratio,
                    "performance_ratio": msg.performance_ratio,
                    "quality_ratio": msg.quality_ratio,
                    "oee_trs": msg.oee_trs,
                    "conformity_rate": msg.conformity_rate,
                    "cadence_parts_per_hour": msg.cadence_parts_per_hour,
                    "avg_cycle_time_sec": msg.avg_cycle_time_sec,
                    "elapsed_sec": msg.elapsed_sec,
                    "current_step_description": msg.current_step_description,
                    "active_plan_json": msg.active_plan_json,
                }
            )

        def _on_sim_safety(self, msg: Any) -> None:
            self.supervisor.ingest_sim_safety(
                {
                    "estop_active": msg.estop_active,
                    "cell_ready": msg.cell_ready,
                    "human_in_collab_zone": msg.human_in_collab_zone,
                    "human_distance_m": msg.human_distance_m,
                    "tiago_speed_scale": msg.tiago_speed_scale,
                    "poste_a_interlock_clear": msg.poste_a_interlock_clear,
                    "poste_b_interlock_clear": msg.poste_b_interlock_clear,
                    "staubli_interlock_clear": msg.staubli_interlock_clear,
                    "montrac_interlock_clear": msg.montrac_interlock_clear,
                    "active_veto_reason": msg.active_veto_reason,
                    "active_locks": list(msg.active_locks),
                }
            )

        def _on_sim_station(self, msg: Any) -> None:
            self.supervisor.ingest_sim_station_status(
                {
                    "station_id": msg.station_id,
                    "state": msg.state,
                    "current_action": msg.current_action,
                    "current_part_id": msg.current_part_id,
                    "progress": msg.progress,
                    "detail": msg.detail,
                }
            )

        def _on_sim_workpiece(self, msg: Any) -> None:
            p = msg.pose.position
            q = msg.pose.orientation
            self.supervisor.ingest_sim_workpiece(
                {
                    "part_id": msg.part_id,
                    "batch_id": msg.batch_id,
                    "stage": msg.stage,
                    "holder": msg.holder,
                    "quality_status": msg.quality_status,
                    "simulated_defect": msg.simulated_defect,
                    "defect_type": msg.defect_type,
                    "rework_count": msg.rework_count,
                    "pose": {
                        "x": p.x,
                        "y": p.y,
                        "z": p.z,
                        "yaw": _quaternion_to_yaw(q.x, q.y, q.z, q.w),
                    },
                }
            )

        def _on_sim_inspection(self, station_id: str, msg: Any) -> None:
            self.supervisor.ingest_sim_inspection(
                station_id,
                {
                    "station_id": msg.station_id or station_id,
                    "inspection_phase": msg.inspection_phase,
                    "part_id": msg.part_id,
                    "part_detected": msg.part_detected,
                    "orientation_ok": msg.orientation_ok,
                    "conforming": msg.conforming,
                    "defect_type": msg.defect_type,
                    "confidence": msg.confidence,
                    "orientation_deg": msg.orientation_deg,
                    "summary": msg.summary,
                },
            )

        def _on_sim_nl_proposal(self, msg: Any) -> None:
            self.supervisor.ingest_sim_nl_proposal(
                {
                    "proposal_id": msg.proposal_id,
                    "raw_instruction": msg.raw_instruction,
                    "detected_language": msg.detected_language,
                    "quantity": int(msg.quantity),
                    "enable_qc": bool(msg.enable_qc),
                    "enable_rework": bool(msg.enable_rework),
                    "inject_defect_count": int(msg.inject_defect_count),
                    "visual_grounding_summary": msg.visual_grounding_summary,
                    "pddl_actions": list(msg.pddl_actions),
                    "supervisor_valid": bool(msg.supervisor_valid),
                    "supervisor_reason": msg.supervisor_reason,
                    "status": msg.status,
                }
            )

        def _on_shuttle_pose_cmd(self, side: str, msg: PoseStamped) -> None:
            p = msg.pose.position
            q = msg.pose.orientation
            pose = {
                "x": float(p.x),
                "y": float(p.y),
                "z": float(p.z),
                "yaw": float(_quaternion_to_yaw(q.x, q.y, q.z, q.w)),
            }
            self._shuttle_world_poses[side] = pose
            existing = dict(self.supervisor.sim_shuttles.get(side, {}))
            existing.update(pose)
            existing.setdefault("name", "L1" if side == "left" else "R1")
            self.supervisor.ingest_sim_shuttle(side, existing)

        def _on_shuttle(self, side: str, msg: Any) -> None:
            wp = self._shuttle_world_poses.get(side)
            self.supervisor.ingest_sim_shuttle(
                side,
                {
                    "name": msg.name,
                    "mode": msg.mode,
                    "current_segment": msg.current_segment,
                    "s": msg.s,
                    "x": wp["x"] if wp else msg.x,
                    "y": wp["y"] if wp else msg.y,
                    "z": wp["z"] if wp else msg.z,
                    "yaw": wp["yaw"] if wp else msg.yaw,
                    "speed": msg.speed,
                    "reached_target_slot": msg.reached_target_slot,
                },
            )

        # ---- Appels services ROS 2 synchrones sûrs (MultiThreadedExecutor) ----
        def _call_service_sync(self, client: Any, req: Any, wait_sec: float = 0.8) -> Any | None:
            if client is None:
                return None
            if not client.wait_for_service(timeout_sec=wait_sec):
                return None
            done = threading.Event()
            future = client.call_async(req)
            future.add_done_callback(lambda _: done.set())
            if not done.wait(timeout=self._service_timeout):
                return None
            return future.result()

        def _call_start_order(self, payload: dict[str, Any]) -> dict[str, Any] | None:
            if self._cli_start_order is None:
                return None
            req = StartProductionOrder.Request()
            req.batch_id = str(payload.get("batch_id", ""))
            req.quantity = int(payload.get("quantity", 1))
            req.enable_qc = bool(payload.get("enable_qc", True))
            req.enable_rework = bool(payload.get("enable_rework", True))
            req.inject_defect_on_index = int(payload.get("inject_defect_on_index", 0))
            req.source = str(payload.get("source", "ihm_react"))
            resp = self._call_service_sync(self._cli_start_order, req)
            if resp is None:
                return None
            return {
                "ok": bool(resp.accepted),
                "accepted": bool(resp.accepted),
                "batch_id": resp.batch_id,
                "message": resp.message,
            }

        def _call_pause(self, paused: bool) -> dict[str, Any] | None:
            req = SetBool.Request()
            req.data = bool(paused)
            resp = self._call_service_sync(self._cli_pause, req)
            if resp is None:
                return None
            return {"ok": bool(resp.success), "paused": bool(paused), "message": resp.message}

        def _call_reset(self) -> dict[str, Any] | None:
            req = Trigger.Request()
            resp = self._call_service_sync(self._cli_reset, req)
            if resp is None:
                return None
            return {"ok": bool(resp.success), "message": resp.message}

        def _call_estop(self, active: bool) -> dict[str, Any] | None:
            req = SetBool.Request()
            req.data = bool(active)
            resp = self._call_service_sync(self._cli_estop, req)
            if resp is None:
                return None
            return {"ok": bool(resp.success), "estop_active": bool(active), "message": resp.message}

        def _call_human(self, present: bool) -> dict[str, Any] | None:
            req = SetBool.Request()
            req.data = bool(present)
            resp = self._call_service_sync(self._cli_human, req)
            if resp is None:
                return None
            return {"ok": bool(resp.success), "present": bool(present), "message": resp.message}

        def _call_nl_parse(self, instruction: str, auto_confirm: bool) -> dict[str, Any] | None:
            if self._cli_nl_parse is None:
                return None
            req = ParseNaturalLanguage.Request()
            req.instruction = instruction
            req.auto_confirm = bool(auto_confirm)
            resp = self._call_service_sync(self._cli_nl_parse, req)
            if resp is None:
                return None
            p = resp.proposal
            prop_dict = {
                "proposal_id": p.proposal_id,
                "raw_instruction": p.raw_instruction,
                "detected_language": p.detected_language,
                "quantity": int(p.quantity),
                "enable_qc": bool(p.enable_qc),
                "enable_rework": bool(p.enable_rework),
                "inject_defect_count": int(p.inject_defect_count),
                "visual_grounding_summary": p.visual_grounding_summary,
                "pddl_actions": list(p.pddl_actions),
                "supervisor_valid": bool(p.supervisor_valid),
                "supervisor_reason": p.supervisor_reason,
                "status": p.status,
            }
            self.supervisor.ingest_sim_nl_proposal(prop_dict)
            return {
                "ok": bool(resp.success and p.supervisor_valid),
                "success": bool(resp.success),
                "proposal": self.supervisor.vla_candidate,
                "message": p.supervisor_reason,
            }

        def _call_nl_approve(self, proposal_id: str, approve: bool) -> dict[str, Any] | None:
            if self._cli_nl_approve is None:
                return None
            req = ApprovePlanProposal.Request()
            req.proposal_id = proposal_id
            req.approve = bool(approve)
            resp = self._call_service_sync(self._cli_nl_approve, req)
            if resp is None:
                return None
            return {
                "ok": bool(resp.accepted),
                "accepted": bool(resp.accepted),
                "proposal_id": proposal_id,
                "message": resp.message,
            }

        def _call_inspect(self, args: dict[str, Any]) -> dict[str, Any] | None:
            if self._cli_inspect is None:
                return None
            req = InspectPart.Request()
            req.station_id = str(args.get("station_id", "poste_b"))
            req.inspection_phase = str(args.get("inspection_phase", "op2_qc"))
            req.part_id = str(args.get("part_id", ""))
            resp = self._call_service_sync(self._cli_inspect, req)
            if resp is None:
                return None
            r = resp.result
            res_dict = {
                "station_id": r.station_id or req.station_id,
                "inspection_phase": r.inspection_phase,
                "part_id": r.part_id,
                "part_detected": r.part_detected,
                "orientation_ok": r.orientation_ok,
                "conforming": r.conforming,
                "defect_type": r.defect_type,
                "confidence": r.confidence,
                "orientation_deg": r.orientation_deg,
                "summary": r.summary,
            }
            self.supervisor.ingest_sim_inspection(req.station_id, res_dict)
            return {"ok": True, "result": res_dict, "message": r.summary}

        def _on_tick(self) -> None:
            self.supervisor.tick(self._dt)
            snap = _broadcast_snapshot(self.bridge, self.supervisor)
            now_stamp = self.get_clock().now().to_msg()

            m_cell = RosString()
            m_cell.data = json.dumps(snap, ensure_ascii=False)
            self.pub_cell.publish(m_cell)

            m_safety = RosString()
            m_safety.data = json.dumps(snap["safety"], ensure_ascii=False)
            self.pub_safety.publish(m_safety)

            m_ev = RosString()
            m_ev.data = json.dumps(snap["events"][:5], ensure_ascii=False)
            self.pub_events.publish(m_ev)

            m_ma = RosString()
            m_ma.data = json.dumps(snap["montracA"], ensure_ascii=False)
            self.pub_montrac_a.publish(m_ma)

            m_mb = RosString()
            m_mb.data = json.dumps(snap["montracB"], ensure_ascii=False)
            self.pub_montrac_b.publish(m_mb)

            m_vla = RosString()
            m_vla.data = json.dumps(snap["vlaCandidate"], ensure_ascii=False)
            self.pub_vla.publish(m_vla)

            js_a = JointState()
            js_a.header.stamp = now_stamp
            js_a.name = [f"zone_a_joint_{i}" for i in range(1, 7)]
            js_a.position = [math.radians(d) for d in snap["yaskawaA"]["jointsDeg"]]
            self.pub_joints_a.publish(js_a)

            js_b = JointState()
            js_b.header.stamp = now_stamp
            js_b.name = [f"zone_b_joint_{i}" for i in range(1, 7)]
            js_b.position = [math.radians(d) for d in snap["yaskawaB"]["jointsDeg"]]
            self.pub_joints_b.publish(js_b)

            pose = PoseStamped()
            pose.header.stamp = now_stamp
            pose.header.frame_id = "world"
            wp = snap.get("liveSim", {}).get("tiagoWorldPose")
            if isinstance(wp, dict) and snap.get("simConnected"):
                pose.pose.position.x = float(wp.get("x", -12.8))
                pose.pose.position.y = float(wp.get("y", -1.2))
                pose.pose.position.z = float(wp.get("z", 0.0))
                yaw = float(wp.get("yaw", -1.5708))
                pose.pose.orientation.z = math.sin(yaw / 2.0)
                pose.pose.orientation.w = math.cos(yaw / 2.0)
            else:
                pose.pose.position.x = -9.0 - float(snap["tiago"]["corridorProgress"]) * 7.6
                pose.pose.position.y = -1.55
                pose.pose.orientation.w = 1.0
            self.pub_tiago.publish(pose)


def _run_interactive_cli(
    dispatcher: OrchestratorCommandDispatcher,
    bridge: RosbridgeServer,
    stop_event: threading.Event,
) -> None:
    print("\n=== Orchestrateur L1 — Salle 315 MFJA (Bidirectionnel ROS 2 / IHM) ===")
    print(f"Pont WebSocket IHM : ws://{bridge.host}:{bridge.port}")
    print("Taper 'help' pour les commandes opérateur (ex: start order 2, start j2, propose ...)\n")
    while not stop_event.is_set():
        try:
            line = input("orchestrateur> ").strip()
        except (EOFError, KeyboardInterrupt):
            stop_event.set()
            break
        if not line:
            continue
        if line.lower() in ("quit", "exit", "q"):
            stop_event.set()
            break
        if line.lower() == "help":
            print(CLI_HELP)
            continue
        reply = dispatcher.execute_text_command(line)
        if reply:
            print(reply)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Orchestrateur L1 — Salle 315 MFJA")
    parser.add_argument("--config", type=str, default=str(_default_config_path()))
    parser.add_argument("--gz-sim", choices=["true", "false"], default=None)
    parser.add_argument("--ws-host", type=str, default=None)
    parser.add_argument("--ws-port", type=int, default=None)
    parser.add_argument("--hmi-url", type=str, default=None)
    parser.add_argument("--auto-start", type=str, default=None, help="Ex: j1, j1_alt, j2")
    parser.add_argument("--loop", action="store_true", help="Boucler le scénario auto-démarré")
    parser.add_argument("--no-cli", action="store_true", help="Désactiver le prompt interactif")
    parser.add_argument("--standalone", action="store_true", help="Forcer le mode sans rclpy")
    args, ros_args = parser.parse_known_args(argv)

    supervisor = CellSupervisor.from_yaml(args.config)
    if args.gz_sim is not None:
        supervisor.gz_sim = args.gz_sim == "true"
    if args.hmi_url:
        supervisor.hmi_http_url = args.hmi_url

    net = supervisor.config.get("network", {})
    ws_host = args.ws_host or str(net.get("ws_host", "0.0.0.0"))
    ws_port = int(args.ws_port if args.ws_port is not None else net.get("ws_port", 9090))
    allow_cmds = bool(net.get("allow_ws_commands", True))

    bridge = RosbridgeServer(host=ws_host, port=ws_port, allow_commands=allow_cmds)
    dispatcher = OrchestratorCommandDispatcher(
        supervisor=supervisor,
        on_state_mutated=lambda: _broadcast_snapshot(bridge, supervisor),
    )
    bridge.service_handler = dispatcher.handle_service
    bridge.publish_handler = dispatcher.handle_publish
    bridge.start()

    # Diffuse immédiatement un premier instantané pour tout client qui se connecte dès t=0
    _broadcast_snapshot(bridge, supervisor)

    if args.auto_start:
        print(supervisor.start_scenario(args.auto_start, loop=args.loop))

    stop_event = threading.Event()
    cli_thread: threading.Thread | None = None
    if not args.no_cli and sys.stdin.isatty():
        cli_thread = threading.Thread(
            target=_run_interactive_cli, args=(dispatcher, bridge, stop_event), daemon=True
        )
        cli_thread.start()

    use_ros = HAS_RCLPY and not args.standalone
    try:
        if use_ros:
            rclpy.init(args=ros_args)
            node = MfjaOrchestratorNode(supervisor, bridge, dispatcher)
            executor = MultiThreadedExecutor(num_threads=4)
            executor.add_node(node)
            spin_thread = threading.Thread(target=executor.spin, daemon=True)
            spin_thread.start()
            try:
                while rclpy.ok() and not stop_event.is_set():
                    time.sleep(0.15)
            finally:
                executor.shutdown()
                node.destroy_node()
                if rclpy.ok():
                    rclpy.shutdown()
        else:
            rate_hz = float(net.get("publish_rate_hz", 10.0))
            dt = 1.0 / max(1.0, rate_hz)
            while not stop_event.is_set():
                supervisor.tick(dt)
                _broadcast_snapshot(bridge, supervisor)
                time.sleep(dt)
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        bridge.stop()
        if cli_thread and cli_thread.is_alive():
            cli_thread.join(timeout=0.5)


if __name__ == "__main__":
    main()
