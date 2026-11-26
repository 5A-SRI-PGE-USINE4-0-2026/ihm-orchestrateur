from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    gz_sim_arg = DeclareLaunchArgument(
        "gz_sim",
        default_value="true",
        description="false = plateau réel Salle 315, true = jumeau numérique Gazebo Harmonic",
    )
    ws_host_arg = DeclareLaunchArgument(
        "ws_host",
        default_value="0.0.0.0",
        description="Interface d'écoute du pont WebSocket rosbridge v2 pour l'IHM React",
    )
    ws_port_arg = DeclareLaunchArgument(
        "ws_port",
        default_value="9090",
        description="Port TCP du pont WebSocket rosbridge v2 pour l'IHM React",
    )
    hmi_url_arg = DeclareLaunchArgument(
        "hmi_url",
        default_value="http://localhost:8080",
        description="URL HTTP du serveur usine40_hmi (flux MJPEG caméras ZED 2)",
    )

    orchestrator = Node(
        package="mfja_orchestrator",
        executable="orchestrator_node",
        name="mfja_orchestrator",
        output="screen",
        arguments=[
            "--gz-sim",
            LaunchConfiguration("gz_sim"),
            "--ws-host",
            LaunchConfiguration("ws_host"),
            "--ws-port",
            LaunchConfiguration("ws_port"),
            "--hmi-url",
            LaunchConfiguration("hmi_url"),
            "--no-cli",
        ],
    )

    return LaunchDescription([gz_sim_arg, ws_host_arg, ws_port_arg, hmi_url_arg, orchestrator])
