"""
detectors.py
------------
Race event detectors — each class analyses normalised telemetry data
in SQLite and returns detected events.

All detectors work on cached data (no iRacing connection needed).
They run SQL queries against race_ticks + car_states, group results
into event windows, and return structured dicts ready for insertion.

Detector list:
  - IncidentDetector     : camera-switch to off-track car
  - BattleDetector       : sustained close gap between adjacent positions
  - OvertakeDetector     : position change with proximity
  - PitStopDetector      : car enters pit lane
  - FastestLapDetector   : new session-best lap time
  - LeaderChangeDetector : P1 car_idx changes
  - FirstLapDetector     : race lap 1
  - LastLapDetector      : final lap of the race
  - CrashDetector        : off-track with significant time loss
  - SpinoutDetector      : brief off-track with moderate time loss
  - ContactDetector      : multiple cars off-track at same location
  - CloseCallDetector    : near-miss with proximity and brief off-track
"""

from __future__ import annotations

import json
import logging
import sqlite3
from collections import defaultdict
from typing import Any

logger = logging.getLogger(__name__)


# ── Event types ──────────────────────────────────────────────────────────────

EVENT_INCIDENT    = "incident"
EVENT_BATTLE      = "battle"
EVENT_OVERTAKE    = "overtake"
EVENT_PIT_STOP    = "pit_stop"
EVENT_FASTEST_LAP = "fastest_lap"
EVENT_LEADER_CHANGE = "leader_change"
EVENT_FIRST_LAP   = "first_lap"
EVENT_LAST_LAP    = "last_lap"
EVENT_CRASH       = "crash"
EVENT_SPINOUT     = "spinout"
EVENT_CONTACT     = "contact"
EVENT_CLOSE_CALL  = "close_call"
EVENT_PACE_LAP    = "pace_lap"

# iRacing surface constants
SURFACE_OFF_TRACK = 0
SURFACE_IN_PIT    = 1
SURFACE_PIT_APRON = 2
SURFACE_ON_TRACK  = 3

# iRacing session states
SESSION_STATE_INVALID    = 0
SESSION_STATE_GET_IN_CAR = 1
SESSION_STATE_WARMUP     = 2
SESSION_STATE_PARADE     = 3
SESSION_STATE_RACING     = 4
SESSION_STATE_CHECKERED  = 5
SESSION_STATE_COOLDOWN   = 6

# Speed-based severity constants
REFERENCE_SPEED_MS = 70.0    # ~250 km/h — used to normalise speed to 0–1
TIME_LOSS_WEIGHT   = 0.6     # weight for time-loss component in blended severity
SPEED_WEIGHT       = 0.4     # weight for speed component in blended severity


# ── Base class ───────────────────────────────────────────────────────────────

class BaseDetector:
    """Base class for event detectors."""

    event_type: str = ""

    def detect(
        self,
        db: sqlite3.Connection,
        session_info: dict,
    ) -> list[dict]:
        """Run detection and return a list of event dicts.

        Each dict must contain at minimum:
          event_type, start_time, end_time, start_frame, end_frame,
          severity, involved_drivers
        """
        raise NotImplementedError


# ── Incident Detector ────────────────────────────────────────────────────────

class IncidentDetector(BaseDetector):
    """Detect incidents via iRacing's auto-director camera switching.

    Mirrors the original iRacingReplayDirector AnalyseRace.cs pattern:
    when iRacing's auto-director switches the camera to a car that is
    off-track, that signals a genuine incident.  This is far more reliable
    than simply looking for any off-track car, because iRacing only switches
    the camera for significant incidents (not grass clips / minor offs).

    We detect ticks where ``cam_car_idx`` changed AND the car that the camera
    switched *to* has surface == OffTrack in that same tick.

    Deduplicates within 15 seconds per car.
    """

    event_type = EVENT_INCIDENT
    DEDUP_SECONDS = 15.0
    LEAD_IN = 2.0     # seconds before incident
    FOLLOW_OUT = 8.0  # seconds after incident

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        # Find ticks where the camera switched to a car that is off-track.
        # LAG(cam_car_idx) gives the previous camera target; when it differs
        # from the current one, we have a camera switch.  We then join the
        # car_states for the *new* target to check its surface.
        rows = db.execute("""
            WITH cam_switches AS (
                SELECT t.id AS tick_id,
                       t.session_time,
                       t.replay_frame,
                       t.cam_car_idx,
                       LAG(t.cam_car_idx) OVER (ORDER BY t.session_time) AS prev_cam
                FROM race_ticks t
                WHERE t.session_state IN (?, ?)
            )
            SELECT sw.session_time, sw.replay_frame, sw.cam_car_idx,
                   cs.position, cs.lap, cs.speed_ms
            FROM cam_switches sw
            JOIN car_states cs ON cs.tick_id = sw.tick_id
                              AND cs.car_idx = sw.cam_car_idx
            WHERE sw.prev_cam IS NOT NULL
              AND sw.cam_car_idx != sw.prev_cam
              AND cs.surface = ?
              AND cs.position > 0
            ORDER BY sw.session_time
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED,
              SURFACE_OFF_TRACK)).fetchall()

        events: list[dict] = []
        seen: dict[int, float] = {}  # car_idx → last event end_time

        for row in rows:
            time_s = row["session_time"]
            frame = row["replay_frame"]
            car_idx = row["cam_car_idx"]
            position = row["position"]
            lap = row["lap"]
            speed_ms = row["speed_ms"]

            last = seen.get(car_idx, -999)
            if time_s - last < self.DEDUP_SECONDS:
                # Extend existing event window
                for e in reversed(events):
                    if car_idx in e["involved_drivers"]:
                        e["end_time"] = time_s + self.FOLLOW_OUT
                        e["end_frame"] = frame
                        seen[car_idx] = time_s + self.FOLLOW_OUT
                        break
                continue

            # Speed-based severity: normalise to ~70 m/s ≈ 250 km/h
            if speed_ms is not None and speed_ms > 0:
                speed_severity = min(speed_ms / REFERENCE_SPEED_MS, 1.0)
                severity = max(round(speed_severity * 10), 1)
            else:
                severity = 6  # fallback to original default

            events.append({
                "event_type": self.event_type,
                "start_time": max(0, time_s - self.LEAD_IN),
                "end_time": time_s + self.FOLLOW_OUT,
                "start_frame": max(0, frame),
                "end_frame": frame,
                "lap_number": lap,
                "severity": severity,
                "involved_drivers": [car_idx],
                "position": position,
                "metadata": {"detected_by": "cam_switch_off_track"},
            })
            seen[car_idx] = time_s + self.FOLLOW_OUT

        logger.info("[Detector:Incident] Found %d incidents", len(events))
        return events


# ── Battle Detector ──────────────────────────────────────────────────────────


def _find_chains(pairs):
    """Find connected components from a list of (a, b) pairs using union-find."""
    parent = {}

    def find(x):
        if x not in parent:
            parent[x] = x
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for a, b in pairs:
        union(a, b)

    chains = defaultdict(set)
    for node in parent:
        chains[find(node)].add(node)

    return list(chains.values())


class BattleDetector(BaseDetector):
    """Detect sustained battles between adjacent cars using continuous lap distance.

    Two bugs existed in the previous SQL-based design:
    1. CarIdxPosition is only updated at S/F crossings, so mid-lap adjacency
       checks were stale by up to a full lap.
    2. The merge logic only checked battles[-1] and merged any chain that
       shared a single driver, causing the entire field to collapse into
       1-2 mega-battles with a dozen drivers each.

    Fix: use cont_dist = lap + lap_pct (live, accurate) to rank cars in
    each tick.  Track one independent battle window per PAIR of adjacent
    cars.  Each pair starts, extends, and closes entirely on its own —
    no cross-pair merging.  A 3-car train (A-B-C) produces two separate
    battle events (A-B and B-C), which is more useful than one 3-car blob.
    """

    event_type = EVENT_BATTLE
    MIN_DURATION = 10.0   # seconds of sustained close running
    MERGE_GAP = 5.0       # gap (s) before a pair's battle window is closed

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        gap_threshold = session_info.get("battle_gap_threshold", 0.5)  # seconds
        avg_lap_time  = session_info.get("avg_lap_time", 90.0) or 90.0
        # Convert gap from seconds to lap fraction for cont_dist comparison
        gap_laps = gap_threshold / avg_lap_time

        # Load all on-track cars during racing, ordered by tick time
        rows = db.execute("""
            SELECT t.session_time, t.replay_frame,
                   cs.car_idx, cs.lap, cs.lap_pct
            FROM car_states cs
            JOIN race_ticks t ON cs.tick_id = t.id
            WHERE t.session_state IN (?, ?)
              AND cs.position > 0
              AND cs.surface = ?
            ORDER BY t.session_time
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED,
              SURFACE_ON_TRACK)).fetchall()

        # Group car states by tick
        ticks: dict[float, list[dict]] = defaultdict(list)
        tick_frames: dict[float, int] = {}
        for row in rows:
            time_s = row["session_time"]
            ticks[time_s].append({
                "car_idx":   row["car_idx"],
                "cont_dist": row["lap"] + row["lap_pct"],
                "lap":       row["lap"],
            })
            tick_frames[time_s] = row["replay_frame"]

        # active[(ahead_idx, behind_idx)] = current open battle window
        active: dict[tuple[int, int], dict] = {}
        finished: list[dict] = []

        for time_s in sorted(ticks.keys()):
            # Sort by cont_dist descending: index 0 = furthest ahead on track
            cars = sorted(ticks[time_s], key=lambda c: c["cont_dist"], reverse=True)
            frame = tick_frames[time_s]

            # Find all adjacent pairs that are within the gap threshold
            close_pairs: set[tuple[int, int]] = set()
            for i in range(len(cars) - 1):
                a = cars[i]      # ahead
                b = cars[i + 1]  # just behind
                if a["cont_dist"] - b["cont_dist"] <= gap_laps:
                    pair = (a["car_idx"], b["car_idx"])
                    close_pairs.add(pair)
                    if pair in active:
                        # Extend the existing battle window
                        active[pair]["end_time"]  = time_s
                        active[pair]["end_frame"] = frame
                    else:
                        # Open a new battle window for this pair
                        active[pair] = {
                            "start_time":  time_s,
                            "end_time":    time_s,
                            "start_frame": frame,
                            "end_frame":   frame,
                            "lap":         a["lap"],
                            "position":    i + 1,  # 1-indexed from cont_dist rank
                            "ahead_idx":   a["car_idx"],
                            "behind_idx":  b["car_idx"],
                        }

            # Close out pairs that have been out of proximity long enough
            to_close = [
                pair for pair, b in active.items()
                if pair not in close_pairs
                and time_s - b["end_time"] > self.MERGE_GAP
            ]
            for pair in to_close:
                finished.append(active.pop(pair))

        # Flush all still-open battles at end of data
        finished.extend(active.values())

        # Convert raw windows to events, filtering by minimum duration
        events: list[dict] = []
        for b in finished:
            duration = b["end_time"] - b["start_time"]
            if duration < self.MIN_DURATION:
                continue

            pos = b["position"]
            pos_bonus = max(0, 3 - (pos - 1))        # +3 for P1, +2 P2, …
            dur_bonus = min(3, int(duration / 20))    # +1 per 20 s of battle
            severity  = min(10, 4 + pos_bonus + dur_bonus)

            events.append({
                "event_type":       self.event_type,
                "start_time":       b["start_time"],
                "end_time":         b["end_time"],
                "start_frame":      b["start_frame"],
                "end_frame":        b["end_frame"],
                "lap_number":       b["lap"],
                "severity":         severity,
                "involved_drivers": [b["ahead_idx"], b["behind_idx"]],
                "position":         pos,
                "metadata": {
                    "gap_threshold_laps": round(gap_laps, 5),
                    "duration_seconds":   round(duration, 1),
                },
            })

        events.sort(key=lambda e: e["start_time"])
        logger.info("[Detector:Battle] Found %d battles", len(events))
        return events


# ── Overtake Detector ────────────────────────────────────────────────────────

class OvertakeDetector(BaseDetector):
    """Detect overtakes using continuous lap distance (lap + lap_pct).

    The fundamental problem with CarIdxPosition: iRacing only updates it
    when cars CROSS THE START/FINISH LINE.  A pass at lap_pct=0.7 won't
    be reflected until the end of that lap — up to ~60 seconds late on a
    90-second lap.  Any approach that looks for position-number changes will
    therefore timestamp the event a full lap after it actually happened.

    Fix: use cont_dist = lap + lap_pct as a monotonically increasing
    continuous track distance.  When car A's cont_dist crosses above car
    B's cont_dist while they are physically close, that IS the overtake
    moment — accurate to our scan sample rate (~320ms at 16×/20ms poll).

    Algorithm:
      For each tick, sort all on-track cars by cont_dist (highest = furthest
      ahead).  Detect adjacent pairs where the order flipped since the
      previous tick AND the gap is small enough to be a genuine on-track
      pass (not lapped traffic or a pit-stop-gap).
    """

    event_type = EVENT_OVERTAKE
    DEDUP_SECONDS = 10.0
    PROXIMITY_LAPS = 0.06   # max |cont_dist| gap to count (~5.4 s on a 90 s lap)
    LEAD_IN = 2.0            # seconds before crossing to use as start_time

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        # Load all on-track car states during racing, ordered by time.
        # We only need lap, lap_pct, and the frame number — NOT position.
        rows = db.execute("""
            SELECT t.session_time, t.replay_frame,
                   cs.car_idx, cs.lap, cs.lap_pct
            FROM car_states cs
            JOIN race_ticks t ON cs.tick_id = t.id
            WHERE t.session_state IN (?, ?)
              AND cs.position > 0
              AND cs.surface = ?
            ORDER BY t.session_time
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED,
              SURFACE_ON_TRACK)).fetchall()

        # Group car states by tick timestamp
        ticks: dict[float, list[dict]] = defaultdict(list)
        tick_frames: dict[float, int] = {}
        for row in rows:
            time_s = row["session_time"]
            ticks[time_s].append({
                "car_idx":   row["car_idx"],
                "cont_dist": row["lap"] + row["lap_pct"],
                "lap":       row["lap"],
            })
            tick_frames[time_s] = row["replay_frame"]

        events: list[dict] = []
        # (min_car_idx, max_car_idx) → last overtake session_time (per-pair dedup)
        seen_pairs: dict[tuple[int, int], float] = {}
        # car_idx → rank in previous tick (0 = furthest ahead in field)
        prev_ranks: dict[int, int] = {}

        for time_s in sorted(ticks.keys()):
            # Sort by continuous distance, descending: index 0 = race leader
            cars = sorted(ticks[time_s], key=lambda c: c["cont_dist"], reverse=True)
            curr_ranks = {c["car_idx"]: i for i, c in enumerate(cars)}

            # Examine each adjacent pair in the current on-track order
            for i in range(len(cars) - 1):
                a = cars[i]       # currently ahead
                b = cars[i + 1]   # currently just behind

                # Proximity gate: ignore pairs separated by more than a small
                # fraction of a lap — that means lapped traffic or a pit gap,
                # not a wheel-to-wheel pass.
                gap = a["cont_dist"] - b["cont_dist"]
                if gap > self.PROXIMITY_LAPS:
                    continue

                idx_a, idx_b = a["car_idx"], b["car_idx"]
                prev_rank_a = prev_ranks.get(idx_a)
                prev_rank_b = prev_ranks.get(idx_b)
                if prev_rank_a is None or prev_rank_b is None:
                    continue

                # In the previous tick, B had a lower rank number (= further
                # ahead) than A.  Now A has the lower rank.  B → A: overtake.
                if prev_rank_b < prev_rank_a:
                    pair_key = (min(idx_a, idx_b), max(idx_a, idx_b))
                    last_t = seen_pairs.get(pair_key, -999.0)
                    if time_s - last_t < self.DEDUP_SECONDS:
                        continue

                    lap_num  = a["lap"]
                    new_pos  = i + 1   # 1-indexed field position from cont_dist rank
                    severity = min(10, 4 + max(0, 3 - (new_pos - 1)))

                    events.append({
                        "event_type":      self.event_type,
                        "start_time":      max(0.0, time_s - self.LEAD_IN),
                        "end_time":        time_s + 5.0,
                        "start_frame":     tick_frames.get(time_s, 0),
                        "end_frame":       tick_frames.get(time_s, 0),
                        "lap_number":      lap_num,
                        "severity":        severity,
                        "involved_drivers": [idx_a, idx_b],
                        "position":        new_pos,
                        "metadata": {
                            "gap_laps":    round(gap, 4),
                            "cross_time":  round(time_s, 2),
                        },
                    })
                    seen_pairs[pair_key] = time_s

            prev_ranks = curr_ranks

        logger.info("[Detector:Overtake] Found %d overtakes", len(events))
        return events



# ── Pit Stop Detector ────────────────────────────────────────────────────────

class PitStopDetector(BaseDetector):
    """Detect pit stops by identifying periods on pit surface."""

    event_type = EVENT_PIT_STOP
    MIN_PIT_DURATION = 5.0  # seconds minimum to count as pit stop

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        rows = db.execute("""
            SELECT t.session_time, t.replay_frame, cs.car_idx, cs.position, cs.lap
            FROM car_states cs
            JOIN race_ticks t ON cs.tick_id = t.id
            WHERE cs.surface IN (?, ?)
              AND t.session_state IN (?, ?)
              AND cs.position > 0
            ORDER BY cs.car_idx, t.session_time
        """, (SURFACE_IN_PIT, SURFACE_PIT_APRON,
              SESSION_STATE_RACING, SESSION_STATE_CHECKERED)).fetchall()

        # Group consecutive pit frames per car
        pit_stops: list[dict] = []
        current: dict[int, dict] = {}  # car_idx → current pit stop being built

        for row in rows:
            time_s = row["session_time"]
            frame = row["replay_frame"]
            car_idx = row["car_idx"]

            if car_idx in current:
                # Extend if within reasonable time gap
                if time_s - current[car_idx]["end_time"] < 5.0:
                    current[car_idx]["end_time"] = time_s
                    current[car_idx]["end_frame"] = frame
                else:
                    # Close previous pit stop
                    pit_stops.append(current.pop(car_idx))
                    current[car_idx] = {
                        "event_type": self.event_type,
                        "start_time": time_s,
                        "end_time": time_s,
                        "start_frame": frame,
                        "end_frame": frame,
                        "lap_number": row["lap"],
                        "severity": 2,
                        "involved_drivers": [car_idx],
                        "position": row["position"],
                        "metadata": {},
                    }
            else:
                current[car_idx] = {
                    "event_type": self.event_type,
                    "start_time": time_s,
                    "end_time": time_s,
                    "start_frame": frame,
                    "end_frame": frame,
                    "lap_number": row["lap"],
                    "severity": 2,
                    "involved_drivers": [car_idx],
                    "position": row["position"],
                    "metadata": {},
                }

        # Flush remaining
        pit_stops.extend(current.values())

        # Filter by minimum duration
        pit_stops = [
            p for p in pit_stops
            if p["end_time"] - p["start_time"] >= self.MIN_PIT_DURATION
        ]

        logger.info("[Detector:PitStop] Found %d pit stops", len(pit_stops))
        return pit_stops


# ── Fastest Lap Detector ─────────────────────────────────────────────────────

class FastestLapDetector(BaseDetector):
    """Detect new session-best lap times."""

    event_type = EVENT_FASTEST_LAP

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        # Find ticks where a car's best_lap_time improved
        rows = db.execute("""
            WITH lap_improvements AS (
                SELECT cs.car_idx, cs.best_lap_time, cs.position, cs.lap,
                       t.session_time, t.replay_frame,
                       LAG(cs.best_lap_time) OVER (
                           PARTITION BY cs.car_idx ORDER BY t.session_time
                       ) AS prev_best
                FROM car_states cs
                JOIN race_ticks t ON cs.tick_id = t.id
                WHERE t.session_state IN (?, ?)
                  AND cs.best_lap_time > 0
                  AND cs.position > 0
            )
            SELECT session_time, replay_frame, car_idx, best_lap_time,
                   prev_best, position, lap
            FROM lap_improvements
            WHERE prev_best IS NOT NULL
              AND best_lap_time < prev_best
            ORDER BY session_time
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED)).fetchall()

        # Track the overall session-best
        events: list[dict] = []
        session_best: float = float("inf")

        for row in rows:
            time_s = row["session_time"]
            frame = row["replay_frame"]
            car_idx = row["car_idx"]
            lap_time = row["best_lap_time"]
            lap = row["lap"]

            is_session_best = lap_time < session_best
            if is_session_best:
                session_best = lap_time

            severity = 8 if is_session_best else 4

            events.append({
                "event_type": self.event_type,
                "start_time": max(0, time_s - 5.0),
                "end_time": time_s + 3.0,
                "start_frame": max(0, frame),
                "end_frame": frame,
                "lap_number": lap,
                "severity": severity,
                "involved_drivers": [car_idx],
                "position": row["position"],
                "metadata": {
                    "lap_time": lap_time,
                    "is_session_best": is_session_best,
                },
            })

        logger.info("[Detector:FastestLap] Found %d fastest laps", len(events))
        return events


# ── Leader Change Detector ───────────────────────────────────────────────────

class LeaderChangeDetector(BaseDetector):
    """Detect changes in the race leader using continuous lap distance.

    CarIdxPosition = 1 only updates at start/finish crossings, so a lead
    change at lap_pct=0.5 wouldn't register until both cars lap — up to a
    full lap late.  Instead, we find the car with the highest cont_dist
    (lap + lap_pct) in each tick; that car IS the actual leader at that
    moment, regardless of where the S/F line is.
    """

    event_type = EVENT_LEADER_CHANGE
    DEDUP_SECONDS = 5.0
    LEAD_IN = 3.0

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        # Load all on-track cars during racing, ordered by tick time.
        rows = db.execute("""
            SELECT t.session_time, t.replay_frame,
                   cs.car_idx, cs.lap, cs.lap_pct
            FROM car_states cs
            JOIN race_ticks t ON cs.tick_id = t.id
            WHERE t.session_state IN (?, ?)
              AND cs.position > 0
              AND cs.surface = ?
            ORDER BY t.session_time
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED,
              SURFACE_ON_TRACK)).fetchall()

        # Group into ticks and find the cont_dist leader in each
        ticks: dict[float, list[dict]] = defaultdict(list)
        tick_frames: dict[float, int] = {}
        for row in rows:
            time_s = row["session_time"]
            ticks[time_s].append({
                "car_idx":   row["car_idx"],
                "cont_dist": row["lap"] + row["lap_pct"],
                "lap":       row["lap"],
            })
            tick_frames[time_s] = row["replay_frame"]

        events: list[dict] = []
        prev_leader: int | None = None
        last_event_time = -999.0

        for time_s in sorted(ticks.keys()):
            cars = ticks[time_s]
            if not cars:
                continue
            leader_car = max(cars, key=lambda c: c["cont_dist"])
            leader_idx = leader_car["car_idx"]

            if prev_leader is None:
                prev_leader = leader_idx
                continue

            if leader_idx != prev_leader and time_s - last_event_time >= self.DEDUP_SECONDS:
                frame = tick_frames[time_s]
                events.append({
                    "event_type": self.event_type,
                    "start_time": max(0.0, time_s - self.LEAD_IN),
                    "end_time": time_s + 5.0,
                    "start_frame": max(0, frame),
                    "end_frame": frame,
                    "lap_number": leader_car["lap"],
                    "severity": 8,
                    "involved_drivers": [leader_idx, prev_leader],
                    "position": 1,
                    "metadata": {
                        "new_leader": leader_idx,
                        "old_leader": prev_leader,
                        "cross_time": round(time_s, 2),
                    },
                })
                last_event_time = time_s

            prev_leader = leader_idx

        logger.info("[Detector:LeaderChange] Found %d leader changes", len(events))
        return events


# ── First Lap Detector ───────────────────────────────────────────────────────

class FirstLapDetector(BaseDetector):
    """Mark the first racing lap as a special event."""

    event_type = EVENT_FIRST_LAP

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        row = db.execute("""
            SELECT MIN(t.session_time) AS start_time,
                   MAX(t.session_time) AS end_time,
                   MIN(t.replay_frame) AS start_frame,
                   MAX(t.replay_frame) AS end_frame
            FROM race_ticks t
            WHERE t.session_state = ?
              AND t.race_laps <= 1
        """, (SESSION_STATE_RACING,)).fetchone()

        if not row or row["start_time"] is None:
            logger.info("[Detector:FirstLap] No first lap data found")
            return []

        events = [{
            "event_type": self.event_type,
            "start_time": row["start_time"],
            "end_time": row["end_time"],
            "start_frame": row["start_frame"],
            "end_frame": row["end_frame"],
            "lap_number": 1,
            "severity": 7,
            "involved_drivers": [],
            "position": None,
            "metadata": {"description": "Race start / first lap"},
        }]

        logger.info("[Detector:FirstLap] Found first lap event")
        return events


# ── Last Lap Detector ────────────────────────────────────────────────────────

class LastLapDetector(BaseDetector):
    """Mark the final lap of the race."""

    event_type = EVENT_LAST_LAP

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        # Find the maximum race_laps value
        max_lap_row = db.execute("""
            SELECT MAX(race_laps) AS max_lap
            FROM race_ticks
            WHERE session_state IN (?, ?)
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED)).fetchone()

        if not max_lap_row or not max_lap_row["max_lap"]:
            logger.info("[Detector:LastLap] No lap data found")
            return []

        max_lap = max_lap_row["max_lap"]

        row = db.execute("""
            SELECT MIN(t.session_time) AS start_time,
                   MAX(t.session_time) AS end_time,
                   MIN(t.replay_frame) AS start_frame,
                   MAX(t.replay_frame) AS end_frame
            FROM race_ticks t
            WHERE t.race_laps = ?
              AND t.session_state IN (?, ?)
        """, (max_lap, SESSION_STATE_RACING, SESSION_STATE_CHECKERED)).fetchone()

        if not row or row["start_time"] is None:
            logger.info("[Detector:LastLap] No last lap data found")
            return []

        events = [{
            "event_type": self.event_type,
            "start_time": row["start_time"],
            "end_time": row["end_time"],
            "start_frame": row["start_frame"],
            "end_frame": row["end_frame"],
            "lap_number": max_lap,
            "severity": 7,
            "involved_drivers": [],
            "position": None,
            "metadata": {"description": "Final lap", "lap_number": max_lap},
        }]

        logger.info("[Detector:LastLap] Found last lap event (lap %d)", max_lap)
        return events


# ── Crash Detector ───────────────────────────────────────────────────────────

class CrashDetector(BaseDetector):
    """Detect crashes by finding cars that go off-track with a significant
    lap time increase, indicating a big stop or impact.

    Severity scales with the number of cars involved and the duration of
    the off-track excursion.  Distinguished from spinouts by requiring a
    larger time loss and longer off-track duration.
    """

    event_type = EVENT_CRASH
    DEDUP_SECONDS = 20.0
    LEAD_IN = 3.0
    FOLLOW_OUT = 10.0

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        min_time_loss = session_info.get("crash_min_time_loss", 10.0)
        min_off_track_duration = session_info.get("crash_min_off_track_duration", 3.0)

        # Find off-track episodes per car with their duration and estimated
        # time degradation.  We compare est_time before and after the off-track
        # window; a large positive delta indicates the car lost significant time.
        rows = db.execute("""
            WITH off_track AS (
                SELECT cs.car_idx, cs.position, cs.lap, cs.lap_pct,
                       cs.est_time, cs.best_lap_time, cs.speed_ms,
                       t.session_time, t.replay_frame,
                       LAG(cs.surface) OVER (
                           PARTITION BY cs.car_idx ORDER BY t.session_time
                       ) AS prev_surface,
                       LEAD(cs.est_time) OVER (
                           PARTITION BY cs.car_idx ORDER BY t.session_time
                       ) AS next_est_time
                FROM car_states cs
                JOIN race_ticks t ON cs.tick_id = t.id
                WHERE t.session_state IN (?, ?)
                  AND cs.position > 0
            )
            SELECT session_time, replay_frame, car_idx, position, lap,
                   lap_pct, est_time, next_est_time, best_lap_time, speed_ms
            FROM off_track
            WHERE prev_surface = ?
              AND next_est_time IS NOT NULL
              AND next_est_time - est_time > ?
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED,
              SURFACE_OFF_TRACK, min_time_loss)).fetchall()

        events: list[dict] = []
        seen: dict[int, float] = {}

        for row in rows:
            time_s = row["session_time"]
            frame = row["replay_frame"]
            car_idx = row["car_idx"]

            if time_s - seen.get(car_idx, -999) < self.DEDUP_SECONDS:
                # Extend existing event if nearby cars are also crashing
                for e in reversed(events):
                    if car_idx in e["involved_drivers"]:
                        e["end_time"] = time_s + self.FOLLOW_OUT
                        e["end_frame"] = frame
                        seen[car_idx] = time_s + self.FOLLOW_OUT
                        break
                continue

            time_loss = row["next_est_time"] - row["est_time"]
            # Base severity from time loss: base 6, scale up (capped at 10)
            base_severity = min(10, 6 + int(time_loss / 10))

            # Blend speed component if available
            speed_ms = row["speed_ms"]
            if speed_ms is not None and speed_ms > 0:
                speed_factor = min(speed_ms / REFERENCE_SPEED_MS, 1.0)
                severity = max(round(
                    base_severity * TIME_LOSS_WEIGHT
                    + speed_factor * 10 * SPEED_WEIGHT
                ), 1)
            else:
                severity = base_severity

            events.append({
                "event_type": self.event_type,
                "start_time": max(0, time_s - self.LEAD_IN),
                "end_time": time_s + self.FOLLOW_OUT,
                "start_frame": max(0, frame),
                "end_frame": frame,
                "lap_number": row["lap"],
                "severity": severity,
                "involved_drivers": [car_idx],
                "position": row["position"],
                "metadata": {
                    "time_loss": round(time_loss, 2),
                    "lap_pct": row["lap_pct"],
                    "detected_by": "off_track_time_loss",
                },
            })
            seen[car_idx] = time_s + self.FOLLOW_OUT

        # Merge crashes that overlap in time (multi-car pileups)
        merged: list[dict] = []
        for ev in sorted(events, key=lambda e: e["start_time"]):
            if merged and ev["start_time"] <= merged[-1]["end_time"]:
                last = merged[-1]
                for d in ev["involved_drivers"]:
                    if d not in last["involved_drivers"]:
                        last["involved_drivers"].append(d)
                last["end_time"] = max(last["end_time"], ev["end_time"])
                last["end_frame"] = max(last["end_frame"], ev["end_frame"])
                # Bump severity for multi-car crashes
                last["severity"] = min(10, last["severity"] + 1)
            else:
                merged.append(ev)

        logger.info("[Detector:Crash] Found %d crashes", len(merged))
        return merged


# ── Spinout Detector ─────────────────────────────────────────────────────────

class SpinoutDetector(BaseDetector):
    """Detect spinouts / loss of control events.

    A spinout is a brief off-track excursion with moderate time loss — less
    severe than a crash but more impactful than a simple track-limit
    violation.  The key differentiator is the time loss range: significant
    enough to notice but not enough to indicate a full crash.
    """

    event_type = EVENT_SPINOUT
    DEDUP_SECONDS = 15.0
    LEAD_IN = 2.0
    FOLLOW_OUT = 5.0

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        min_time_loss = session_info.get("spinout_min_time_loss", 2.0)
        max_time_loss = session_info.get("spinout_max_time_loss", 10.0)

        rows = db.execute("""
            WITH surface_changes AS (
                SELECT cs.car_idx, cs.position, cs.lap, cs.lap_pct,
                       cs.surface, cs.est_time,
                       t.session_time, t.replay_frame,
                       LAG(cs.surface) OVER (
                           PARTITION BY cs.car_idx ORDER BY t.session_time
                       ) AS prev_surface,
                       LAG(cs.est_time) OVER (
                           PARTITION BY cs.car_idx ORDER BY t.session_time
                       ) AS prev_est_time
                FROM car_states cs
                JOIN race_ticks t ON cs.tick_id = t.id
                WHERE t.session_state IN (?, ?)
                  AND cs.position > 0
            )
            SELECT session_time, replay_frame, car_idx, position, lap,
                   lap_pct, est_time, prev_est_time
            FROM surface_changes
            WHERE surface = ?
              AND prev_surface = ?
              AND prev_est_time IS NOT NULL
              AND est_time - prev_est_time > ?
              AND est_time - prev_est_time <= ?
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED,
              SURFACE_ON_TRACK, SURFACE_OFF_TRACK,
              min_time_loss, max_time_loss)).fetchall()

        events: list[dict] = []
        seen: dict[int, float] = {}

        for row in rows:
            time_s = row["session_time"]
            frame = row["replay_frame"]
            car_idx = row["car_idx"]

            if time_s - seen.get(car_idx, -999) < self.DEDUP_SECONDS:
                continue

            time_loss = row["est_time"] - row["prev_est_time"]
            # Severity: 3-6 range based on time loss within the spinout band
            severity = min(6, 3 + int(time_loss / 3))

            events.append({
                "event_type": self.event_type,
                "start_time": max(0, time_s - self.LEAD_IN),
                "end_time": time_s + self.FOLLOW_OUT,
                "start_frame": max(0, frame),
                "end_frame": frame,
                "lap_number": row["lap"],
                "severity": severity,
                "involved_drivers": [car_idx],
                "position": row["position"],
                "metadata": {
                    "time_loss": round(time_loss, 2),
                    "lap_pct": row["lap_pct"],
                    "detected_by": "off_track_recovery",
                },
            })
            seen[car_idx] = time_s

        logger.info("[Detector:Spinout] Found %d spinouts", len(events))
        return events


# ── Contact Detector ─────────────────────────────────────────────────────────

class ContactDetector(BaseDetector):
    """Detect car-to-car contact by finding multiple cars going off-track
    at nearly the same time and track position.

    Contact is inferred when two or more cars go off-track within a short
    time window and are close together on the track (similar lap_pct),
    but recover quickly without major position changes.
    """

    event_type = EVENT_CONTACT
    LEAD_IN = 2.0
    FOLLOW_OUT = 5.0

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        time_window = session_info.get("contact_time_window", 2.0)
        lap_pct_threshold = session_info.get("contact_lap_pct_threshold", 0.03)

        # Find all off-track transition moments (on-track → off-track)
        rows = db.execute("""
            WITH surface_transitions AS (
                SELECT cs.car_idx, cs.position, cs.lap, cs.lap_pct,
                       cs.surface,
                       t.session_time, t.replay_frame,
                       LAG(cs.surface) OVER (
                           PARTITION BY cs.car_idx ORDER BY t.session_time
                       ) AS prev_surface
                FROM car_states cs
                JOIN race_ticks t ON cs.tick_id = t.id
                WHERE t.session_state IN (?, ?)
                  AND cs.position > 0
            )
            SELECT session_time, replay_frame, car_idx, position, lap, lap_pct
            FROM surface_transitions
            WHERE surface = ?
              AND prev_surface = ?
            ORDER BY session_time
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED,
              SURFACE_OFF_TRACK, SURFACE_ON_TRACK)).fetchall()

        # Group off-track transitions that are close in time and track position
        events: list[dict] = []
        used: set[int] = set()

        for i, row_a in enumerate(rows):
            if i in used:
                continue
            group = [row_a]
            used.add(i)

            for j in range(i + 1, len(rows)):
                if j in used:
                    continue
                row_b = rows[j]
                dt = row_b["session_time"] - row_a["session_time"]
                if dt > time_window:
                    break
                if row_b["car_idx"] == row_a["car_idx"]:
                    continue
                lap_diff = min(
                    abs(row_a["lap_pct"] - row_b["lap_pct"]),
                    1.0 - abs(row_a["lap_pct"] - row_b["lap_pct"]),
                )
                if lap_diff <= lap_pct_threshold:
                    group.append(row_b)
                    used.add(j)

            if len(group) < 2:
                continue

            drivers = list({r["car_idx"] for r in group})
            t_start = min(r["session_time"] for r in group)
            t_end = max(r["session_time"] for r in group)
            frame_start = min(r["replay_frame"] for r in group)
            frame_end = max(r["replay_frame"] for r in group)
            # Severity: 4-7, higher with more cars involved
            severity = min(7, 4 + len(drivers) - 2)

            events.append({
                "event_type": self.event_type,
                "start_time": max(0, t_start - self.LEAD_IN),
                "end_time": t_end + self.FOLLOW_OUT,
                "start_frame": max(0, frame_start),
                "end_frame": frame_end,
                "lap_number": group[0]["lap"],
                "severity": severity,
                "involved_drivers": drivers,
                "position": min(r["position"] for r in group),
                "metadata": {
                    "car_count": len(drivers),
                    "lap_pct": round(group[0]["lap_pct"], 4),
                    "detected_by": "multi_car_off_track",
                },
            })

        logger.info("[Detector:Contact] Found %d contacts", len(events))
        return events


# ── Close Call Detector ──────────────────────────────────────────────────────

class CloseCallDetector(BaseDetector):
    """Detect near-misses where cars are very close together and one
    briefly goes off-track but recovers quickly.

    A close call occurs when a car goes off-track while another car is
    nearby (small lap_pct gap), but the off-track car returns to racing
    without significant time loss.  Lower severity entertainment events.
    """

    event_type = EVENT_CLOSE_CALL
    DEDUP_SECONDS = 10.0
    LEAD_IN = 2.0
    FOLLOW_OUT = 4.0

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        proximity_pct = session_info.get("close_call_proximity_pct", 0.02)
        avg_lap_time = session_info.get("avg_lap_time", 90.0) or 90.0
        max_time_loss = session_info.get("close_call_max_time_loss", 2.0)

        # Find cars that go off-track while a nearby car stays on-track,
        # and recover quickly (re-appear on track in the next sample with
        # small est_time degradation).
        rows = db.execute("""
            WITH off_track_moments AS (
                SELECT cs.car_idx, cs.position, cs.lap, cs.lap_pct,
                       cs.est_time,
                       t.session_time, t.replay_frame, t.id AS tick_id,
                       LAG(cs.surface) OVER (
                           PARTITION BY cs.car_idx ORDER BY t.session_time
                       ) AS prev_surface,
                       LEAD(cs.surface) OVER (
                           PARTITION BY cs.car_idx ORDER BY t.session_time
                       ) AS next_surface,
                       LEAD(cs.est_time) OVER (
                           PARTITION BY cs.car_idx ORDER BY t.session_time
                       ) AS next_est_time
                FROM car_states cs
                JOIN race_ticks t ON cs.tick_id = t.id
                WHERE t.session_state IN (?, ?)
                  AND cs.position > 0
            )
            SELECT otm.session_time, otm.replay_frame, otm.car_idx,
                   otm.position, otm.lap, otm.lap_pct,
                   otm.tick_id,
                   otm.est_time, otm.next_est_time
            FROM off_track_moments otm
            WHERE otm.prev_surface = ?
              AND otm.next_surface = ?
              AND otm.next_est_time IS NOT NULL
              AND otm.next_est_time - otm.est_time < ?
              AND otm.next_est_time - otm.est_time >= 0
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED,
              SURFACE_OFF_TRACK, SURFACE_ON_TRACK,
              max_time_loss)).fetchall()

        events: list[dict] = []
        seen: dict[int, float] = {}

        for row in rows:
            time_s = row["session_time"]
            frame = row["replay_frame"]
            car_idx = row["car_idx"]
            tick_id = row["tick_id"]

            if time_s - seen.get(car_idx, -999) < self.DEDUP_SECONDS:
                continue

            # Check for a nearby on-track car at the same tick
            nearby = db.execute("""
                SELECT car_idx
                FROM car_states
                WHERE tick_id = ?
                  AND car_idx != ?
                  AND surface = ?
                  AND position > 0
                  AND MIN(
                      ABS(lap_pct - ?),
                      1.0 - ABS(lap_pct - ?)
                  ) < ?
                LIMIT 1
            """, (tick_id, car_idx, SURFACE_ON_TRACK,
                  row["lap_pct"], row["lap_pct"],
                  proximity_pct)).fetchone()

            if not nearby:
                continue

            nearby_car = nearby["car_idx"]
            # Base 3, +1 for top-5 position battles (more entertaining)
            severity = min(5, 3 + int((row["position"] or 10) <= 5))

            events.append({
                "event_type": self.event_type,
                "start_time": max(0, time_s - self.LEAD_IN),
                "end_time": time_s + self.FOLLOW_OUT,
                "start_frame": max(0, frame),
                "end_frame": frame,
                "lap_number": row["lap"],
                "severity": severity,
                "involved_drivers": [car_idx, nearby_car],
                "position": row["position"],
                "metadata": {
                    "off_track_car": car_idx,
                    "nearby_car": nearby_car,
                    "lap_pct": round(row["lap_pct"], 4),
                    "detected_by": "brief_off_track_with_proximity",
                },
            })
            seen[car_idx] = time_s

        logger.info("[Detector:CloseCall] Found %d close calls", len(events))
        return events


# ── Pace Lap Detector ────────────────────────────────────────────────────────

class PaceLapDetector(BaseDetector):
    """Detect the pace / formation lap before the green flag.

    The pace lap is the period when ``session_state == SESSION_STATE_PARADE``
    (state 3), which indicates cars have left the grid and are circulating
    under the pace car but before the green flag drops.
    """

    event_type = EVENT_PACE_LAP

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        row = db.execute("""
            SELECT MIN(t.session_time)  AS start_time,
                   MAX(t.session_time)  AS end_time,
                   MIN(t.replay_frame)  AS start_frame,
                   MAX(t.replay_frame)  AS end_frame
            FROM race_ticks t
            WHERE t.session_state = ?
        """, (SESSION_STATE_PARADE,)).fetchone()

        if not row or row["start_time"] is None:
            logger.info("[Detector:PaceLap] No parade/pace lap data found")
            return []

        events = [{
            "event_type": self.event_type,
            "start_time": row["start_time"],
            "end_time": row["end_time"],
            "start_frame": row["start_frame"],
            "end_frame": row["end_frame"],
            "lap_number": 0,
            "severity": 4,
            "involved_drivers": [],
            "position": None,
            "metadata": {"description": "Pace / formation lap before green flag"},
        }]

        logger.info("[Detector:PaceLap] Found pace lap event")
        return events


# ── Detector registry ────────────────────────────────────────────────────────

ALL_DETECTORS: list[BaseDetector] = [
    IncidentDetector(),
    BattleDetector(),
    OvertakeDetector(),
    PitStopDetector(),
    FastestLapDetector(),
    LeaderChangeDetector(),
    PaceLapDetector(),
    FirstLapDetector(),
    LastLapDetector(),
    CrashDetector(),
    SpinoutDetector(),
    ContactDetector(),
    CloseCallDetector(),
]
