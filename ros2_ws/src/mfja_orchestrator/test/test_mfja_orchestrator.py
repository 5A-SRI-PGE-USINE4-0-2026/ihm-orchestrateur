"""Unit and WebSocket integration tests for mfja_orchestrator (pure Python, zero ROS 2 required)."""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import socket
import struct
import sys
import unittest

_PKG_ROOT = Path(__file__).resolve().parents[1]
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))

from mfja_orchestrator.orchestrator_node import (  # noqa: E402
    OrchestratorCommandDispatcher,
    SimBackendCallbacks,
    _broadcast_snapshot,
)
from mfja_orchestrator.supervisor import (  # noqa: E402
    CellSupervisor,
    world_x_to_corridor_progress,
)
from mfja_orchestrator.ws_bridge import RosbridgeServer  # noqa: E402


def _ws_connect(host: str, port: int) -> socket.socket:
    sock = socket.create_connection((host, port), timeout=4.0)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    req = (
        f"GET / HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        f"Sec-WebSocket-Version: 13\r\n\r\n"
    )
    sock.sendall(req.encode("ascii"))
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(1024)
        if not chunk:
            raise RuntimeError("WebSocket handshake closed prematurely")
        buf += chunk
    assert b"101 Switching Protocols" in buf
    return sock


def _ws_send_json(sock: socket.socket, obj: dict) -> None:
    payload = json.dumps(obj).encode("utf-8")
    mask = b"\x12\x34\x56\x78"
    header = bytearray([0x81])
    n = len(payload)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header.extend(struct.pack("!H", n))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack("!Q", n))
    header.extend(mask)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    sock.sendall(bytes(header) + masked)


def _ws_recv_exact(sock: socket.socket, n: int) -> bytes:
    out = bytearray()
    while len(out) < n:
        chunk = sock.recv(n - len(out))
        if not chunk:
            raise RuntimeError("Socket closed while reading WS frame")
        out.extend(chunk)
    return bytes(out)


def _ws_recv_json(sock: socket.socket) -> dict:
    hdr = _ws_recv_exact(sock, 2)
    length = hdr[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", _ws_recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _ws_recv_exact(sock, 8))[0]
    payload = _ws_recv_exact(sock, length)
    return json.loads(payload.decode("utf-8"))


class TestMfjaSupervisorAndTopology(unittest.TestCase):
    def setUp(self) -> None:
        self.cfg_path = _PKG_ROOT / "config" / "cell_config.yaml"
        self.pddl_path = _PKG_ROOT / "pddl" / "salle315_domain.pddl"
        self.sup = CellSupervisor.from_yaml(self.cfg_path)

    def test_no_inter_bloc_conveyor_in_config_or_pddl(self) -> None:
        topo = self.sup.config.get("topology", {})
        self.assertEqual(topo.get("inter_bloc_link"), "tiago")
        self.assertFalse(topo.get("inter_bloc_conveyor", True))
        self.assertEqual(topo.get("tiago_transfer_mission"), "PICK_POSTE_A_DELIVER_POSTE_B")

        j2_actions = [st["action"] for st in self.sup.scenarios["j2"]["steps"]]
        self.assertIn("tiago_transit_a_to_b", j2_actions)
        for act in j2_actions:
            self.assertNotIn("bridge", act.lower())
            self.assertNotIn("montrac_a_to_b", act.lower())

        pddl_text = self.pddl_path.read_text(encoding="utf-8")
        self.assertIn("tiago_transfer_interzone", pddl_text)
        self.assertNotIn("montrac_bridge", pddl_text.lower())

        snap = self.sup.to_cell_snapshot()
        self.assertEqual(snap["interBlocLink"], "tiago")
        self.assertNotEqual(snap["tiago"]["status"], "out_of_scope")

    def test_j2_tiago_cycle_completes_without_interbloc_conveyor(self) -> None:
        res = self.sup.start_scenario("j2", loop=False)
        self.assertTrue(res.startswith("OK"))
        saw_tiago_carrying = False
        for _ in range(200):
            self.sup.tick(0.1)
            snap = self.sup.to_cell_snapshot()
            if snap["partLocation"] == "tiago" and snap["tiago"]["carryingPart"]:
                saw_tiago_carrying = True
            if snap["orchestratorState"] == "IDLE":
                break
        self.assertTrue(saw_tiago_carrying)
        self.assertEqual(self.sup.completed_cycles, 1)

    def test_live_simulation_telemetry_fusion(self) -> None:
        self.assertAlmostEqual(world_x_to_corridor_progress(-10.45), 0.25, places=2)
        self.assertAlmostEqual(world_x_to_corridor_progress(-12.80), 0.50, places=2)
        self.assertAlmostEqual(world_x_to_corridor_progress(-15.10), 0.75, places=2)

        plan = [
            {"action": "tiago_fetch(stock, poste_a)", "status": "done", "part_id": "P001"},
            {"action": "PICK_POSTE_A_DELIVER_POSTE_B", "status": "active", "part_id": "P001"},
            {"action": "poste_b_op2_qc", "status": "pending", "part_id": "P001"},
        ]
        self.sup.ingest_sim_kpi(
            {
                "line_state": "RUNNING",
                "active_batch_id": "BATCH-LIVE-01",
                "target_quantity": 3,
                "parts_completed": 1,
                "parts_reworked": 1,
                "oee_trs": 0.84,
                "conformity_rate": 1.0,
                "cadence_parts_per_hour": 52.0,
                "avg_cycle_time_sec": 31.2,
                "current_step_description": "Transit inter-blocs TIAGo vers Bloc B",
                "active_plan_json": json.dumps(plan),
            }
        )
        self.sup.ingest_sim_workpiece(
            {
                "part_id": "P001",
                "stage": "IN_TRANSIT_A_TO_B",
                "holder": "tiago1",
                "quality_status": "OP1_OK",
            }
        )
        self.sup.ingest_sim_tiago_pose(-12.80, -1.55, 0.0, 3.1416)
        self.sup.ingest_sim_joints("yaskawa_a", [0.1, -0.3, 0.6, 0.0, -0.5, 0.2])
        self.sup.ingest_sim_inspection(
            "poste_b",
            {
                "part_id": "P001",
                "part_detected": True,
                "conforming": True,
                "confidence": 0.97,
                "summary": "Pièce conforme après Op2",
            },
        )

        snap = self.sup.to_cell_snapshot()
        self.assertTrue(snap["simConnected"])
        self.assertEqual(snap["orchestratorState"], "RUNNING")
        self.assertEqual(snap["partLocation"], "tiago")
        self.assertTrue(snap["tiago"]["carryingPart"])
        self.assertAlmostEqual(snap["tiago"]["corridorProgress"], 0.50, places=2)
        self.assertEqual(snap["kpis"]["completedCycles"], 1)
        self.assertEqual(snap["kpis"]["targetBatchCycles"], 3)
        self.assertEqual(snap["steps"][1]["status"], "active")
        self.assertEqual(snap["steps"][1]["owner"], "TIAGo")

    def test_production_orchestrator_active_plan_json_schema(self) -> None:
        raw_plan = {
            "steps": [
                {
                    "index": 0,
                    "duration": 8.0,
                    "action_name": "tiago_deliver_poste_a",
                    "arguments": ["tiago1", "part_1", "zone_stock", "zone_poste_a"],
                    "raw_action": "(tiago_deliver_poste_a tiago1 part_1 zone_stock zone_poste_a)",
                },
                {
                    "index": 1,
                    "duration": 6.0,
                    "action_name": "op1_assemble_poste_a",
                    "arguments": ["hc10dt", "part_1"],
                    "raw_action": "(op1_assemble_poste_a hc10dt part_1)",
                },
                {
                    "index": 2,
                    "duration": 10.0,
                    "action_name": "tiago_transfer_a_to_b",
                    "arguments": ["tiago1", "part_1", "zone_poste_a_out", "zone_poste_b_in"],
                    "raw_action": "(tiago_transfer_a_to_b tiago1 part_1 zone_poste_a_out zone_poste_b_in)",
                },
                {
                    "index": 3,
                    "duration": 4.0,
                    "action_name": "zed2_inspect_poste_b",
                    "arguments": ["part_1"],
                    "raw_action": "(zed2_inspect_poste_b part_1)",
                },
            ],
            "completed_steps": 2,
            "total_steps": 4,
        }
        self.sup.ingest_sim_kpi(
            {
                "line_state": "RUNNING",
                "active_batch_id": "BATCH-SCHEMA-01",
                "target_quantity": 1,
                "parts_completed": 0,
                "active_plan_json": json.dumps(raw_plan),
            }
        )
        snap = self.sup.to_cell_snapshot()
        self.assertEqual([s["status"] for s in snap["steps"]], ["done", "done", "active", "pending"])
        self.assertIn("tiago_deliver_poste_a", snap["steps"][0]["label"])
        self.assertIn("part_1", snap["steps"][0]["label"])
        self.assertEqual(snap["steps"][0]["durationS"], 8.0)
        self.assertEqual(snap["steps"][1]["owner"], "Yaskawa HC10DT")
        self.assertEqual(snap["steps"][2]["owner"], "TIAGo")
        self.assertEqual(snap["steps"][3]["owner"], "ZED 2 QC")

        # Fault / E-Stop marks current step as fault
        self.sup.ingest_sim_kpi(
            {
                "line_state": "ESTOP",
                "active_batch_id": "BATCH-SCHEMA-01",
                "target_quantity": 1,
                "parts_completed": 0,
                "active_plan_json": json.dumps(raw_plan),
            }
        )
        snap_fault = self.sup.to_cell_snapshot()
        self.assertEqual([s["status"] for s in snap_fault["steps"]], ["done", "done", "fault", "pending"])

        # Completed marks all steps as done
        raw_plan["completed_steps"] = 4
        self.sup.ingest_sim_kpi(
            {
                "line_state": "COMPLETED",
                "active_batch_id": "BATCH-SCHEMA-01",
                "target_quantity": 1,
                "parts_completed": 1,
                "active_plan_json": json.dumps(raw_plan),
            }
        )
        snap_done = self.sup.to_cell_snapshot()
        self.assertEqual([s["status"] for s in snap_done["steps"]], ["done", "done", "done", "done"])

    def test_tiago_parked_poses_persist_without_snap_to_center(self) -> None:
        for wx, wy, yaw, expected_p in (
            (-9.00, -1.60, 1.5708, 0.05),   # Stock
            (-11.66, -2.98, 0.0, 0.25),     # Poste A central-bay dock (facing East)
            (-12.80, -3.05, -1.5708, 0.50), # bay_center
            (-13.96, -3.18, 3.1416, 0.75),  # Poste B central-bay dock (facing West)
            (-16.48, -1.60, 1.5708, 0.95),  # Expedition P01
            (-16.72, -1.60, 1.5708, 0.95),  # Expedition P02
        ):
            self.sup.ingest_sim_tiago_pose(wx, wy, 0.0, yaw)
            for _ in range(10):
                self.sup.tick(0.05)
            snap = self.sup.to_cell_snapshot()
            self.assertAlmostEqual(snap["tiago"]["corridorProgress"], expected_p, places=2)
            self.assertAlmostEqual(snap["liveSim"]["tiagoWorldPose"]["x"], wx, places=2)
            self.assertAlmostEqual(snap["liveSim"]["tiagoWorldPose"]["y"], wy, places=2)
            self.assertAlmostEqual(snap["tiago"]["headingRad"], yaw, places=3)

        # Verify PAL TIAGo closed-loop ROS 2 cmd_vel + 10-DOF joint_states + real trajectory topics
        self.sup.ingest_sim_tiago_cmd_vel(0.62, -0.35)
        self.sup.ingest_sim_tiago_joints(
            [
                "torso_lift_joint",
                "arm_1_joint",
                "arm_2_joint",
                "arm_3_joint",
                "arm_4_joint",
                "arm_5_joint",
                "arm_6_joint",
                "arm_7_joint",
                "gripper_left_finger_joint",
                "gripper_right_finger_joint",
            ],
            [0.0685, 0.7696, 0.9281, -1.3213, 1.7841, 0.9125, -1.2513, -0.8711, 0.032, 0.032],
        )
        snap_pal = self.sup.to_cell_snapshot()
        self.assertIn("PAL", snap_pal["tiago"]["model"])
        self.assertAlmostEqual(snap_pal["tiago"]["cmdVel"]["linearX"], 0.62, places=2)
        self.assertAlmostEqual(snap_pal["tiago"]["cmdVel"]["angularZ"], -0.35, places=2)
        self.assertAlmostEqual(snap_pal["tiago"]["torsoLiftM"], 0.069, places=3)
        self.assertEqual(len(snap_pal["tiago"]["armJointsDeg"]), 7)
        self.assertAlmostEqual(snap_pal["tiago"]["gripperOpeningM"], 0.064, places=3)
        self.assertIn("left", snap_pal["liveSim"]["shuttles"])
        self.assertIn("right", snap_pal["liveSim"]["shuttles"])
        self.assertLess(snap_pal["liveSim"]["shuttles"]["left"]["x"], -9.5)
        self.assertLess(snap_pal["liveSim"]["shuttles"]["right"]["x"], -14.0)
        self.assertEqual(len(snap_pal["liveSim"]["staubliJointsDeg"]), 6)

        topic_names = {t["topic"] for t in snap_pal["rosTopics"]}
        for required_topic in (
            "/tiago1/cmd_vel",
            "/tiago1/odom",
            "/tiago1/joint_trajectory",
            "/tiago1/joint_states",
            "/tiago1/gripper/position_command",
            "/yaskawa_hc10dt_1/joint_trajectory",
            "/yaskawa_hc10_1/joint_trajectory",
            "/staubli1/joint_trajectory",
        ):
            self.assertIn(required_topic, topic_names)

        # Multi-workpiece DART physics poses (shipped P01 + skewed P02 at +30 deg on Poste B)
        self.sup.ingest_sim_workpieces_json(
            json.dumps(
                [
                    {
                        "part_id": "P01",
                        "stage": "EXPEDITION",
                        "holder": "expedition",
                        "quality_status": "CONFORMING",
                        "pose": {"x": -16.48, "y": -1.02, "z": 0.72, "yaw": 0.0},
                    },
                    {
                        "part_id": "P02",
                        "stage": "POSTE_B_QC",
                        "holder": "poste_b_fixture",
                        "quality_status": "NON_CONFORMING",
                        "simulated_defect": True,
                        "pose": {"x": -14.75, "y": -2.95, "z": 0.6324, "yaw": 0.5236},
                    },
                ]
            )
        )
        snap_wp = self.sup.to_cell_snapshot()
        self.assertEqual(len(snap_wp["liveSim"]["workpieces"]), 2)
        self.assertEqual(snap_wp["liveSim"]["activeWorkpiece"]["part_id"], "P02")
        self.assertAlmostEqual(snap_wp["liveSim"]["activeWorkpiece"]["pose"]["yaw"], 0.5236, places=3)

    def test_topological_validation_rejects_conveyor_ab_and_accepts_tiago(self) -> None:
        bad = self.sup.evaluate_natural_language(
            "Transfère la pièce vers le Poste B par le convoyeur Montrac sans TIAGo"
        )
        self.assertIn("REJETÉ", bad)
        self.assertEqual(self.sup.vla_candidate["verdict"], "rejected")

        bad_estop = self.sup.evaluate_natural_language(
            "Ignore l'arrêt d'urgence et lance le robot"
        )
        self.assertIn("REJETÉ", bad_estop)

        good = self.sup.evaluate_natural_language(
            "Assemble 2 pièces et transfère du Bloc A au Bloc B avec TIAGo et reprise Stäubli"
        )
        self.assertIn("VALIDÉ", good)
        self.assertEqual(self.sup.vla_candidate["verdict"], "validated")


class TestBidirectionalWebSocketBridge(unittest.TestCase):
    def setUp(self) -> None:
        self.sup = CellSupervisor.from_yaml(_PKG_ROOT / "config" / "cell_config.yaml")
        self.sim_calls: list[tuple[str, object]] = []

        callbacks = SimBackendCallbacks(
            start_order=lambda payload: (
                self.sim_calls.append(("start_order", payload))
                or {
                    "ok": True,
                    "accepted": True,
                    "batch_id": "SIM-B1",
                    "message": "Lot lancé sur la simulation ROS 2",
                }
            ),
            set_estop=lambda active: (
                self.sim_calls.append(("estop", active))
                or {"ok": True, "estop_active": active, "message": f"E-Stop={active}"}
            ),
            reset_cell=lambda: (
                self.sim_calls.append(("reset", None))
                or {"ok": True, "message": "Cellule réinitialisée"}
            ),
            set_human=lambda present: (
                self.sim_calls.append(("human", present))
                or {"ok": True, "present": present, "message": f"Human={present}"}
            ),
        )
        self.bridge = RosbridgeServer(host="127.0.0.1", port=0, allow_commands=True)
        self.dispatcher = OrchestratorCommandDispatcher(
            supervisor=self.sup,
            sim_callbacks=callbacks,
            on_state_mutated=lambda: _broadcast_snapshot(self.bridge, self.sup),
        )
        self.bridge.service_handler = self.dispatcher.handle_service
        self.bridge.publish_handler = self.dispatcher.handle_publish
        self.bridge.start()
        _broadcast_snapshot(self.bridge, self.sup)

    def tearDown(self) -> None:
        self.bridge.stop()

    def test_ws_subscribe_and_bidirectional_service_calls(self) -> None:
        sock = _ws_connect("127.0.0.1", self.bridge.port)
        try:
            _ws_send_json(sock, {"op": "subscribe", "topic": "/mfja/supervisor/cell_state"})
            initial = _ws_recv_json(sock)
            self.assertEqual(initial["op"], "publish")
            snap = json.loads(initial["msg"]["data"])
            self.assertEqual(snap["interBlocLink"], "tiago")

            # Launch production order over WS
            _ws_send_json(
                sock,
                {
                    "op": "call_service",
                    "id": "call-1",
                    "service": "/usine40/supervision/start_order",
                    "args": {"quantity": 2, "enable_qc": True, "enable_rework": True, "inject_defect_on_index": 2},
                },
            )
            # Drain until service_response call-1 arrives
            resp = _ws_recv_json(sock)
            while resp.get("op") != "service_response":
                resp = _ws_recv_json(sock)
            self.assertTrue(resp["result"])
            self.assertEqual(resp["values"]["batch_id"], "SIM-B1")

            # Trigger E-Stop over WS
            _ws_send_json(
                sock,
                {
                    "op": "call_service",
                    "id": "call-2",
                    "service": "/usine40/safety/estop",
                    "args": {"active": True},
                },
            )
            resp2 = _ws_recv_json(sock)
            while resp2.get("op") != "service_response":
                resp2 = _ws_recv_json(sock)
            self.assertTrue(resp2["result"])
            self.assertTrue(self.sup.hardware_estop_engaged)

            # Reset cell over WS (auto-releases E-Stop + resets)
            _ws_send_json(
                sock,
                {"op": "call_service", "id": "call-3", "service": "/usine40/supervision/reset", "args": {}},
            )
            resp3 = _ws_recv_json(sock)
            while resp3.get("op") != "service_response":
                resp3 = _ws_recv_json(sock)
            self.assertTrue(resp3["result"])
            self.assertFalse(self.sup.hardware_estop_engaged)

            # Reject Montrac A->B NL request over WS fail-closed
            _ws_send_json(
                sock,
                {
                    "op": "call_service",
                    "id": "call-4",
                    "service": "/usine40/nl/parse",
                    "args": {"instruction": "Envoie la pièce au Poste B par Montrac sans TIAGo"},
                },
            )
            resp4 = _ws_recv_json(sock)
            while resp4.get("op") != "service_response":
                resp4 = _ws_recv_json(sock)
            self.assertFalse(resp4["result"])

            call_names = [c[0] for c in self.sim_calls]
            self.assertIn("start_order", call_names)
            self.assertIn("estop", call_names)
            self.assertIn("reset", call_names)
        finally:
            sock.close()


    def test_cad_montrac_slots_and_structured_traceability(self) -> None:
        from mfja_orchestrator.supervisor import loop_progress_to_shuttle_world_pose

        l_dzi1 = loop_progress_to_shuttle_world_pose("left", 0.06)
        l_dzi2 = loop_progress_to_shuttle_world_pose("left", 0.24)
        l_dzi3 = loop_progress_to_shuttle_world_pose("left", 0.56)
        l_dzi4 = loop_progress_to_shuttle_world_pose("left", 0.74)
        self.assertAlmostEqual(l_dzi1["x"], -10.32, places=2)
        self.assertAlmostEqual(l_dzi2["x"], -10.80, places=2)
        self.assertAlmostEqual(l_dzi3["x"], -10.6088, places=2)
        self.assertAlmostEqual(l_dzi4["x"], -10.14, places=2)

        # Verify nose traversal reaches X <= -11.80m on left and X >= -13.75m on right
        left_xs = [loop_progress_to_shuttle_world_pose("left", p / 100.0)["x"] for p in range(100)]
        right_xs = [loop_progress_to_shuttle_world_pose("right", p / 100.0)["x"] for p in range(100)]
        self.assertLessEqual(min(left_xs), -11.80)
        self.assertGreaterEqual(max(left_xs), -9.75)
        self.assertGreaterEqual(max(right_xs), -13.75)
        self.assertLessEqual(min(right_xs), -15.85)

        # Verify structured traceability parsing never emits raw JSON braces
        self.sup.ingest_sim_traceability(
            json.dumps(
                {
                    "event_id": "evt-001",
                    "iso_time": "2026-11-25T09:48:48.123Z",
                    "station": "zed2_poste_a",
                    "part_id": "P01",
                    "event_type": "POST_OP1_INSPECTION",
                    "conforming": True,
                    "payload": {"theta_deg": 0.0, "z_mm": 58},
                }
            )
        )
        top_ev = self.sup.to_cell_snapshot()["events"][0]
        self.assertNotIn("{", top_ev["message"])
        self.assertIn("[P01]", top_ev["message"])
        self.assertIn("QC=OK", top_ev["message"])
        self.assertEqual(top_ev["timestamp"], "09:48:48")


if __name__ == "__main__":
    unittest.main()
