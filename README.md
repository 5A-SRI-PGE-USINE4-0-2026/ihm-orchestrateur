# Orchestrateur L1 et IHM — Usine 4.0 Salle 315 (MFJA)

Ensemble **Orchestrateur ROS 2 (Lot L1)** + **IHM de supervision en lecture seule (Lot L7 / FP4)** pour la cellule collaborative et reconfigurable de la **Salle 315 MFJA (UPSSITECH SRI)**.

## Architecture et séparation des rôles

```text
Terminal opérateur / topic ROS 2 (/mfja/orchestrator/cli_command)
        │
        ▼
[Orchestrateur L1 — mfja_orchestrator (ROS 2 Jazzy)]
  • Machine à états déterministe (IDLE / RUNNING / FAULT_LOCKED)
  • Préconditions & chien de garde Montrac (seuil 500 ms -> on_deactivate)
  • Séquences reconfigurables YAML (J1, J1 alternatif §3.4, J2 TIAGo)
  • Validateur J3 fail-closed (domaine PDDL salle315_domain.pddl)
        │
        ├──► Topics ROS 2 natifs (/mfja/supervisor/cell_state, /zone_a/..., /tiago/...)
        └──► Pont WebSocket rosbridge v2 LECTURE SEULE (ws://0.0.0.0:9090)
                    │  (publish / call_service refusés côté client ET côté serveur)
                    ▼
           [IHM web — affichage seul]
```

## Démarrage rapide (2 terminaux)

### Terminal 1 — Lancer l'orchestrateur L1 (ROS 2 Jazzy)

```bash
cd /home/tiago/Documents/PGE_ihm
npm run orchestrator
```

Commandes disponibles dans le terminal de l'orchestrateur :

```text
start j1 [--loop]        Lancer le scénario J1 intra-zone (Zone A)
start j1_alt [--loop]    Lancer le scénario J1 reconfiguré (§3.4)
start j2 [--loop]        Lancer le transfert inter-zones TIAGo
propose <consigne>       Tester le validateur J3 fail-closed
                         ex: propose envoie le cube en zone B par le montrac  -> REJETÉ
                         ex: propose fais un cycle en zone A                  -> VALIDÉ
env real | gazebo        Basculer gz_sim:=false / gz_sim:=true
fault estop | watchdog   Simuler un arrêt d'urgence ou une perte watchdog Montrac
reset                    Acquitter après réarmement sécurité
stop                     Arrêter proprement le cycle en cours
status                   Afficher l'état courant
```

On peut également piloter l'orchestrateur depuis un autre terminal ROS 2 :

```bash
ros2 topic pub --once /mfja/orchestrator/cli_command std_msgs/msg/String "{data: 'start j1'}"
```

### Terminal 2 — Lancer l'IHM (lecture seule)

```bash
cd /home/tiago/Documents/PGE_ihm
npm run dev
```

Ouvrir `http://localhost:5173`. L'IHM se connecte automatiquement en lecture seule à `ws://localhost:9090` (configurable sans valeur codée en dur dans [`public/config.json`](public/config.json) ou via l'onglet **ROS 2**).

## Construction en paquet ROS 2 (`colcon`)

Le paquet [`ros2_ws/src/mfja_orchestrator`](ros2_ws/src/mfja_orchestrator) est un paquet `ament_python` standard :

```bash
cd /home/tiago/Documents/PGE_ihm/ros2_ws
source /opt/ros/jazzy/setup.bash
colcon build --packages-select mfja_orchestrator
source install/setup.bash
ros2 launch mfja_orchestrator orchestrator.launch.py gz_sim:=false
```

## Fichiers clés

- Configuration orchestrateur (scénarios, topics, seuils, réseau) : [`ros2_ws/src/mfja_orchestrator/config/cell_config.yaml`](ros2_ws/src/mfja_orchestrator/config/cell_config.yaml)
- Domaine PDDL PlanSys2 Salle 315 : [`ros2_ws/src/mfja_orchestrator/pddl/salle315_domain.pddl`](ros2_ws/src/mfja_orchestrator/pddl/salle315_domain.pddl)
- Superviseur L1 déterministe : [`ros2_ws/src/mfja_orchestrator/mfja_orchestrator/supervisor.py`](ros2_ws/src/mfja_orchestrator/mfja_orchestrator/supervisor.py)
- Pont WebSocket lecture seule : [`ros2_ws/src/mfja_orchestrator/mfja_orchestrator/ws_bridge.py`](ros2_ws/src/mfja_orchestrator/mfja_orchestrator/ws_bridge.py)
- Nœud ROS 2 Jazzy : [`ros2_ws/src/mfja_orchestrator/mfja_orchestrator/orchestrator_node.py`](ros2_ws/src/mfja_orchestrator/mfja_orchestrator/orchestrator_node.py)
- Configuration IHM : [`public/config.json`](public/config.json)
