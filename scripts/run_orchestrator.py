#!/usr/bin/env python3
"""Lanceur direct de l'orchestrateur L1 (Salle 315 MFJA) avec support ROS 2 Jazzy."""

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
PKG_PATH = ROOT / "ros2_ws" / "src" / "mfja_orchestrator"
sys.path.insert(0, str(PKG_PATH))

from mfja_orchestrator.orchestrator_node import main  # noqa: E402


if __name__ == "__main__":
    main()
