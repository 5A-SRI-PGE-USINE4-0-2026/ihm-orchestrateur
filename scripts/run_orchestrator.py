#!/usr/bin/env python3
"""Lanceur direct de l'orchestrateur L1 (Salle 315 MFJA) connecté au graphe ROS 2 Jazzy & IHM WebSocket."""

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
for extra in (
    ROOT / "ros2_ws" / "src" / "mfja_orchestrator",
    ROOT / "src" / "usine40_supervision",
):
    if extra.is_dir():
        sys.path.insert(0, str(extra))

from mfja_orchestrator.orchestrator_node import main  # noqa: E402


if __name__ == "__main__":
    main()
