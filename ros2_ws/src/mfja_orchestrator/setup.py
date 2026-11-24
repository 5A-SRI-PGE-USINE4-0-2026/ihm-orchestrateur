from glob import glob
import os
from setuptools import find_packages, setup

package_name = 'mfja_orchestrator'

setup(
    name=package_name,
    version='1.0.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        (os.path.join('share', package_name, 'config'), glob('config/*.yaml')),
        (os.path.join('share', package_name, 'pddl'), glob('pddl/*.pddl')),
        (os.path.join('share', package_name, 'launch'), glob('launch/*.launch.py')),
    ],
    install_requires=['setuptools', 'PyYAML'],
    zip_safe=True,
    maintainer='Équipe PGE 5A SRI',
    maintainer_email='sri@upssitech.eu',
    description='Orchestrateur / Superviseur déterministe L1 — Salle 315 MFJA',
    license='MIT',
    entry_points={
        'console_scripts': [
            'orchestrator_node = mfja_orchestrator.orchestrator_node:main',
        ],
    },
)
