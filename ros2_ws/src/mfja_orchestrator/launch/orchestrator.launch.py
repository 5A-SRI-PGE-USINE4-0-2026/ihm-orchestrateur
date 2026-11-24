from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    gz_sim_arg = DeclareLaunchArgument(
        "gz_sim",
        default_value="false",
        description="false = plateau réel Salle 315, true = jumeau numérique Gazebo Harmonic",
    )

    orchestrator = Node(
        package="mfja_orchestrator",
        executable="orchestrator_node",
        name="mfja_orchestrator",
        output="screen",
        arguments=["--gz-sim", LaunchConfiguration("gz_sim"), "--no-cli"],
    )

    return LaunchDescription([gz_sim_arg, orchestrator])
