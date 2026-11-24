;; Domaine PDDL PlanSys2 — Cellule Usine 4.0 Salle 315 MFJA (UPSSITECH SRI)
;; Modélise explicitement la séparation physique entre les rails Montrac Zone A et Zone B (V4 §1.3).

(define (domain mfja_salle315)
  (:requirements :strips :typing :durative-actions)

  (:types
    cobot mobile_robot - robot
    shuttle rail station zone part
  )

  (:predicates
    (hardware_estop_clear)
    (watchdog_alive ?r - rail)
    (corridor_clear)

    (zone_of_cobot ?c - cobot ?z - zone)
    (zone_of_rail ?r - rail ?z - zone)
    (station_on_rail ?s - station ?r - rail)
    (shuttle_on_rail ?sh - shuttle ?r - rail)
    (shuttle_at ?sh - shuttle ?s - station)
    (shuttle_empty ?sh - shuttle)

    (gripper_open ?c - cobot)
    (part_at_table ?p - part ?z - zone)
    (part_held ?p - part ?c - cobot)
    (part_on_shuttle ?p - part ?sh - shuttle)
    (part_on_tiago ?p - part ?m - mobile_robot)
    (mobile_at ?m - mobile_robot ?z - zone)
  )

  (:durative-action pick_from_table
    :parameters (?c - cobot ?p - part ?z - zone)
    :duration (= ?duration 4)
    :condition (and
      (over all (hardware_estop_clear))
      (at start (zone_of_cobot ?c ?z))
      (at start (gripper_open ?c))
      (at start (part_at_table ?p ?z))
    )
    :effect (and
      (at start (not (gripper_open ?c)))
      (at start (not (part_at_table ?p ?z)))
      (at end (part_held ?p ?c))
    )
  )

  (:durative-action place_on_shuttle
    :parameters (?c - cobot ?p - part ?sh - shuttle ?s - station ?r - rail ?z - zone)
    :duration (= ?duration 4)
    :condition (and
      (over all (hardware_estop_clear))
      (over all (watchdog_alive ?r))
      (at start (zone_of_cobot ?c ?z))
      (at start (zone_of_rail ?r ?z))
      (at start (station_on_rail ?s ?r))
      (at start (shuttle_on_rail ?sh ?r))
      (over all (shuttle_at ?sh ?s))
      (at start (shuttle_empty ?sh))
      (at start (part_held ?p ?c))
    )
    :effect (and
      (at start (not (part_held ?p ?c)))
      (at start (not (shuttle_empty ?sh)))
      (at end (part_on_shuttle ?p ?sh))
      (at end (gripper_open ?c))
    )
  )

  ;; Convoyage strictement intra-zone : ?from et ?to doivent appartenir au même rail ?r
  (:durative-action move_shuttle_local
    :parameters (?sh - shuttle ?r - rail ?from - station ?to - station)
    :duration (= ?duration 5)
    :condition (and
      (over all (hardware_estop_clear))
      (over all (watchdog_alive ?r))
      (at start (shuttle_on_rail ?sh ?r))
      (at start (station_on_rail ?from ?r))
      (at start (station_on_rail ?to ?r))
      (at start (shuttle_at ?sh ?from))
    )
    :effect (and
      (at start (not (shuttle_at ?sh ?from)))
      (at end (shuttle_at ?sh ?to))
    )
  )

  (:durative-action pick_from_shuttle
    :parameters (?c - cobot ?p - part ?sh - shuttle ?s - station ?r - rail ?z - zone)
    :duration (= ?duration 4)
    :condition (and
      (over all (hardware_estop_clear))
      (over all (watchdog_alive ?r))
      (at start (zone_of_cobot ?c ?z))
      (at start (zone_of_rail ?r ?z))
      (at start (station_on_rail ?s ?r))
      (over all (shuttle_at ?sh ?s))
      (at start (gripper_open ?c))
      (at start (part_on_shuttle ?p ?sh))
    )
    :effect (and
      (at start (not (gripper_open ?c)))
      (at start (not (part_on_shuttle ?p ?sh)))
      (at end (part_held ?p ?c))
      (at end (shuttle_empty ?sh))
    )
  )

  ;; Transfert inter-zones conditionnel (J2) assuré par TIAGo dans le couloir central
  (:durative-action tiago_transfer_interzone
    :parameters (?m - mobile_robot ?p - part ?za - zone ?zb - zone)
    :duration (= ?duration 10)
    :condition (and
      (over all (hardware_estop_clear))
      (over all (corridor_clear))
      (at start (mobile_at ?m ?za))
      (at start (part_on_tiago ?p ?m))
    )
    :effect (and
      (at start (not (mobile_at ?m ?za)))
      (at end (mobile_at ?m ?zb))
    )
  )
)
