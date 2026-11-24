"""Nœud ROS 2 Jazzy `mfja_orchestrator` + pont WebSocket lecture seule + CLI terminal.

- Publie les vrais topics ROS 2 Jazzy (inspectables via `ros2 topic list` / `ros2 topic echo`)
- Diffuse simultanément les états vers l'IHM via le pont WebSocket rosbridge v2 (lecture seule)
- Accepte les ordres opérateur uniquement depuis le terminal CLI ou le topic `/mfja/orchestrator/cli_command`
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys
import threading
import time
from typing import Any

from mfja_orchestrator.supervisor import CellSupervisor
from mfja_orchestrator.ws_bridge import ReadOnlyRosbridgeServer

try:
    import rclpy
    from rclpy.node import Node
    from std_msgs.msg import String as RosString
    from sensor_msgs.msg import JointState
    from geometry_msgs.msg import PoseStamped

    HAS_RCLPY = True
except ImportError:
    HAS_RCLPY = False


CLI_HELP = """
Commandes orchestrateur L1 (Salle 315 MFJA) :
  start j1 [--loop]        Lancer le scénario J1 intra-zone (Zone A)
  start j1_alt [--loop]    Lancer le scénario J1 alternatif (reconfigurabilité §3.4)
  start j2 [--loop]        Lancer le transfert inter-zones avec TIAGo
  stop                     Arrêter proprement le cycle en cours
  propose <texte>          Soumettre une consigne langage naturel (validation J3 fail-closed)
  env real | gazebo        Basculer gz_sim (plateau réel / Gazebo Harmonic)
  fault estop | watchdog   Simuler un arrêt d'urgence ou une perte watchdog Montrac
  reset                    Acquitter les défauts sécurité et revenir en IDLE
  status                   Afficher l'état courant
  help                     Afficher cette aide
  quit                     Arrêter l'orchestrateur
""".strip()


def _default_config_path() -> Path:
    here = Path(__file__).resolve()
    candidates = [
        here.parent.parent / "config" / "cell_config.yaml",
        here.parent.parent.parent.parent / "share" / "mfja_orchestrator" / "config" / "cell_config.yaml",
    ]
    for c in candidates:
        if c.exists():
            return c
    raise FileNotFoundError("Impossible de localiser config/cell_config.yaml")


def _broadcast_snapshot(bridge: ReadOnlyRosbridgeServer, supervisor: CellSupervisor) -> dict[str, Any]:
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
        topics.get("montrac_a_state", "/zone_a/montrac/shuttle_state"),
        {"data": json.dumps(snap["montracA"], ensure_ascii=False)},
    )
    bridge.broadcast_topic(
        topics.get("vla_plan", "/mfja/vla/candidate_plan"),
        {"data": json.dumps(snap["vlaCandidate"], ensure_ascii=False)},
    )
    return snap


if HAS_RCLPY:

    class MfjaOrchestratorNode(Node):
        def __init__(
            self, supervisor: CellSupervisor, bridge: ReadOnlyRosbridgeServer
        ) -> None:
            super().__init__("mfja_orchestrator")
            self.supervisor = supervisor
            self.bridge = bridge
            t = supervisor.topics

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

            self.create_subscription(
                RosString,
                t.get("cli_command", "/mfja/orchestrator/cli_command"),
                self._on_ros_cli_command,
                10,
            )

            rate_hz = float(supervisor.config.get("network", {}).get("publish_rate_hz", 10.0))
            self._dt = 1.0 / max(1.0, rate_hz)
            self.create_timer(self._dt, self._on_tick)
            self.get_logger().info(
                f"Orchestrateur L1 ROS 2 démarré ({rate_hz:.0f} Hz) — pont IHM lecture seule sur ws://{bridge.host}:{bridge.port}"
            )

        def _on_ros_cli_command(self, msg: RosString) -> None:
            reply = self.supervisor.execute_cli_command(msg.data)
            if reply:
                self.get_logger().info(f"[CLI ROS] {msg.data} -> {reply}")

        def _on_tick(self) -> None:
            self.supervisor.tick(self._dt)
            snap = _broadcast_snapshot(self.bridge, self.supervisor)
            now_stamp = self.get_clock().now().to_msg()

            # Publication ROS 2 native
            m_cell = RosString()
            m_cell.data = json.dumps(snap, ensure_ascii=False)
            self.pub_cell.publish(m_cell)

            m_safety = RosString()
            m_safety.data = json.dumps(snap["safety"], ensure_ascii=False)
            self.pub_safety.publish(m_safety)

            m_ev = RosString()
            m_ev.data = json.dumps(snap["events"][:3], ensure_ascii=False)
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
            pose.header.frame_id = "map"
            pose.pose.position.x = float(snap["tiago"]["corridorProgress"]) * 3.0
            pose.pose.position.y = 0.0
            pose.pose.orientation.w = 1.0
            self.pub_tiago.publish(pose)


def _run_interactive_cli(
    supervisor: CellSupervisor,
    bridge: ReadOnlyRosbridgeServer,
    stop_event: threading.Event,
) -> None:
    print("\n=== Orchestrateur L1 — Salle 315 MFJA ===")
    print(f"Pont WebSocket IHM (lecture seule) : ws://{bridge.host}:{bridge.port}")
    print("Taper 'help' pour les commandes opérateur (ex: start j1 --loop)\n")
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
        reply = supervisor.execute_cli_command(line)
        if reply:
            print(reply)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Orchestrateur L1 — Salle 315 MFJA")
    parser.add_argument("--config", type=str, default=str(_default_config_path()))
    parser.add_argument("--gz-sim", choices=["true", "false"], default=None)
    parser.add_argument("--auto-start", type=str, default=None, help="Ex: j1, j1_alt, j2")
    parser.add_argument("--loop", action="store_true", help="Boucler le scénario auto-démarré")
    parser.add_argument("--no-cli", action="store_true", help="Désactiver le prompt interactif")
    parser.add_argument("--standalone", action="store_true", help="Forcer le mode sans rclpy")
    args, ros_args = parser.parse_known_args(argv)

    supervisor = CellSupervisor.from_yaml(args.config)
    if args.gz_sim is not None:
        supervisor.gz_sim = args.gz_sim == "true"

    net = supervisor.config.get("network", {})
    bridge = ReadOnlyRosbridgeServer(
        host=str(net.get("ws_host", "0.0.0.0")),
        port=int(net.get("ws_port", 9090)),
    )
    bridge.start()

    if args.auto_start:
        print(supervisor.start_scenario(args.auto_start, loop=args.loop))

    stop_event = threading.Event()
    cli_thread: threading.Thread | None = None
    if not args.no_cli and sys.stdin.isatty():
        cli_thread = threading.Thread(
            target=_run_interactive_cli, args=(supervisor, bridge, stop_event), daemon=True
        )
        cli_thread.start()

    use_ros = HAS_RCLPY and not args.standalone
    try:
        if use_ros:
            rclpy.init(args=ros_args)
            node = MfjaOrchestratorNode(supervisor, bridge)
            try:
                while rclpy.ok() and not stop_event.is_set():
                    rclpy.spin_once(node, timeout_sec=0.1)
            finally:
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
