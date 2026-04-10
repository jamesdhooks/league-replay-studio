"""
detectors.py
------------
Race event detectors — each class analyses normalised telemetry data
in SQLite and returns detected events.

All detectors work on cached data (no iRacing connection needed).
They run SQL queries against race_ticks + car_states (+ incident_log),
group results into event windows, and return structured dicts ready for
insertion.

Detector list:
  - IncidentDetector        : on-track → off-track surface transitions (CarIdxTrackSurface)
  - BattleDetector          : sustained close gap between adjacent positions
  - OvertakeDetector        : position change with proximity
  - PitStopDetector         : car enters pit lane
  - LeaderChangeDetector    : P1 car_idx changes
  - FirstLapDetector        : race lap 1
  - LastLapDetector         : final lap of the race
  - CloseCallDetector       : near-miss with proximity and brief off-track
  - UndercutDetector        : earlier pitter gains position on pit-stop offset
  - OvercutDetector         : later pitter gains position by running longer on track
  - PitBattleDetector       : simultaneous pit stops creating side-by-side exits
  - YellowFlagDetector      : full-course yellow / safety car windows + restarts
  - RaceStartDetector       : green flag moment
  - RaceFinishDetector      : winner crosses finish line
  - FinishSequenceDetector  : P2–P10 finish-line crossings

Reserved (disabled — awaiting live session support):
  - IncidentLogDetector     : reads iRacing SessionLog for car_contact / contact /
                              lost_control / off_track / turn_cutting events.
                              Not active in replay mode (CarIdxIncidentCount unavailable).
"""

from __future__ import annotations

import bisect
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
EVENT_LEADER_CHANGE = "leader_change"
EVENT_FIRST_LAP   = "first_lap"
EVENT_LAST_LAP    = "last_lap"
EVENT_CONTACT     = "contact"
EVENT_CLOSE_CALL  = "close_call"
# ── SessionLog-sourced event types — named after iRacing's own descriptions ──
EVENT_CAR_CONTACT  = "car_contact"   # "Car Contact" (car-to-car)
EVENT_LOST_CONTROL = "lost_control"  # "Lost Control" (spin)
EVENT_OFF_TRACK    = "off_track"     # "Off Track"
EVENT_TURN_CUTTING = "turn_cutting"  # "Turn Cutting"
EVENT_PACE_LAP    = "pace_lap"
EVENT_RACE_START  = "race_start"
EVENT_RACE_FINISH = "race_finish"
EVENT_RESTART     = "restart"
EVENT_UNDERCUT    = "undercut"
EVENT_OVERCUT     = "overcut"
EVENT_PIT_BATTLE  = "pit_battle"

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
    """Detect incidents from on-track → off-track surface transitions.

    iRacing's ``CarIdxTrackSurface`` updates every frame during replay at
    any speed, making it the most reliable incident signal available.
    A transition from surface=3 (OnTrack) to surface=0 (OffTrack) at
    meaningful speed is treated as an incident.

    Slow excursions (pit-entry confusion, slow grass clips) are filtered out
    by a minimum speed threshold.  Events within DEDUP_SECONDS per car are
    merged into one extended clip.
    """

    event_type = EVENT_INCIDENT
    DEDUP_SECONDS   = 15.0
    MIN_SPEED_MS    = 8.0   # ~30 km/h — ignore crawling pit-entry moves
    # Multi-car proximity window: cars off-track within this time AND lap-fraction
    # gap are considered co-incident (involved in the same incident).
    NEARBY_TIME_WINDOW = 3.0   # seconds
    NEARBY_LAP_PCT     = 0.06  # track-position fraction (~5-6 s on a 90 s lap)

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        # Prefer ground-truth incidents from the iRacing API pre-pass when available.
        # Falls back to CarIdxTrackSurface heuristics if the pre-pass wasn't run
        # (e.g. re-detect only, or iRacing disconnected during scan).
        try:
            api_count = db.execute("SELECT COUNT(*) FROM incidents_api").fetchone()[0]
        except sqlite3.OperationalError:
            api_count = 0

        if api_count > 0:
            logger.info(
                "[Detector:Incident] Using %d ground-truth incidents from incidents_api (iRacing API)",
                api_count,
            )
            return self._detect_from_api(db, session_info)

        logger.info("[Detector:Incident] incidents_api empty — using surface-transition fallback")
        return self._detect_from_surface(db, session_info)

    def _detect_from_api(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        """Build incident events from the iRacing API pre-pass (incidents_api table)."""
        dedup = session_info.get("incident_dedup_seconds", self.DEDUP_SECONDS)

        rows = db.execute(
            "SELECT frame, session_time, car_idx, lap FROM incidents_api ORDER BY session_time"
        ).fetchall()

        events: list[dict] = []
        seen: dict[int, float] = {}

        for row in rows:
            time_s  = row["session_time"]
            frame   = row["frame"]
            car_idx = row["car_idx"]
            lap     = row["lap"]

            # Look up nearest position and speed from car_states for severity
            cs = db.execute("""
                SELECT cs.position, cs.speed_ms
                FROM car_states cs
                JOIN race_ticks rt ON cs.tick_id = rt.id
                WHERE cs.car_idx = ? AND rt.session_state IN (?, ?)
                ORDER BY ABS(rt.session_time - ?)
                LIMIT 1
            """, (car_idx, SESSION_STATE_RACING, SESSION_STATE_CHECKERED, time_s)).fetchone()

            position = cs["position"] if cs else 0
            speed_ms = (cs["speed_ms"] or 25.0) if cs else 25.0  # 25 m/s ≈ 90 km/h fallback

            last = seen.get(car_idx, -999.0)
            if time_s - last < dedup:
                # Extend the existing event window
                for e in reversed(events):
                    if car_idx in e["involved_drivers"]:
                        e["end_time"]  = time_s
                        e["end_frame"] = frame
                        seen[car_idx]  = time_s
                        break
                continue

            speed_severity = min(speed_ms / REFERENCE_SPEED_MS, 1.0)
            severity = max(round(speed_severity * 10), 1)

            events.append({
                "event_type":       self.event_type,
                "start_time":       time_s,
                "end_time":         time_s,
                "start_frame":      max(0, frame),
                "end_frame":        frame,
                "lap_number":       lap,
                "severity":         severity,
                "involved_drivers": [car_idx],
                "position":         position,
                "metadata":         {"detected_by": "iracing_api", "incident_time": time_s},
            })
            seen[car_idx] = time_s

        logger.info("[Detector:Incident] Found %d incidents (iRacing API)", len(events))
        return self._enrich_with_nearby_cars(events, db)

    def _detect_from_surface(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        """Fallback: detect incidents from CarIdxTrackSurface on→off-track transitions."""
        rows = db.execute("""
            WITH transitions AS (
                SELECT cs.car_idx,
                       cs.position,
                       cs.lap,
                       cs.speed_ms,
                       cs.surface,
                       t.session_time,
                       t.replay_frame,
                       LAG(cs.surface) OVER (
                           PARTITION BY cs.car_idx ORDER BY t.session_time
                       ) AS prev_surface
                FROM car_states cs
                JOIN race_ticks t ON cs.tick_id = t.id
                WHERE t.session_state IN (?, ?)
                  AND cs.position > 0
            )
            SELECT car_idx, position, lap, speed_ms, session_time, replay_frame
            FROM transitions
            WHERE surface = ?        -- now off-track
              AND prev_surface = 3   -- was on-track (3 = OnTrack)
            ORDER BY session_time
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED,
              SURFACE_OFF_TRACK)).fetchall()

        dedup = session_info.get("incident_dedup_seconds", self.DEDUP_SECONDS)

        events: list[dict] = []
        seen: dict[int, float] = {}  # car_idx → last event end_time

        for row in rows:
            time_s     = row["session_time"]
            frame      = row["replay_frame"]
            car_idx    = row["car_idx"]
            position   = row["position"]
            lap        = row["lap"]
            speed_ms   = row["speed_ms"] or 0.0

            # Skip slow excursions (pit-lane entry, rejoining, slow grass clips)
            if speed_ms < self.MIN_SPEED_MS:
                continue

            last = seen.get(car_idx, -999)
            if time_s - last < dedup:
                # Extend existing event window
                for e in reversed(events):
                    if car_idx in e["involved_drivers"]:
                        e["end_time"] = time_s
                        e["end_frame"] = frame
                        seen[car_idx] = time_s
                        break
                continue

            # Speed-based severity (normalised to ~70 m/s ≈ 250 km/h)
            speed_severity = min(speed_ms / REFERENCE_SPEED_MS, 1.0)
            severity = max(round(speed_severity * 10), 1)

            events.append({
                "event_type": self.event_type,
                "start_time": time_s,
                "end_time": time_s,
                "start_frame": max(0, frame),
                "end_frame": frame,
                "lap_number": lap,
                "severity": severity,
                "involved_drivers": [car_idx],
                "position": position,
                "metadata": {"detected_by": "surface_transition", "speed_ms": round(speed_ms, 1), "incident_time": time_s},
            })
            seen[car_idx] = time_s

        logger.info("[Detector:Incident] Found %d incidents (surface transition)", len(events))
        return self._enrich_with_nearby_cars(events, db)

    def _enrich_with_nearby_cars(
        self, events: list[dict], db: sqlite3.Connection
    ) -> list[dict]:
        """Discover co-incident cars and record multi-car involvement.

        For each incident event, checks whether any *other* car was also
        off-track within NEARBY_TIME_WINDOW seconds AND within NEARBY_LAP_PCT
        of lap position.  Qualifying nearby cars are:

        - Added to ``involved_drivers``
        - Contribute a +1 severity bonus per car (capped at 10)
        - Recorded as ``car_count`` and ``multi_car`` in metadata

        A single bulk query pre-loads all off-track moments so we avoid N
        per-event round-trips.  Cars that are already in ``involved_drivers``
        (e.g. merged via dedup) are not double-counted.
        """
        if not events:
            return events

        # Pre-load every off-track moment for all cars during racing
        off_track_rows = db.execute("""
            SELECT cs.car_idx, t.session_time, cs.lap_pct
            FROM car_states cs
            JOIN race_ticks t ON cs.tick_id = t.id
            WHERE t.session_state IN (?, ?)
              AND cs.surface = ?
              AND cs.position > 0
              AND cs.lap_pct IS NOT NULL
            ORDER BY cs.car_idx, t.session_time
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED,
              SURFACE_OFF_TRACK)).fetchall()

        # Index: car_idx → sorted list of (session_time, lap_pct)
        off_track: dict[int, list[tuple[float, float]]] = defaultdict(list)
        for row in off_track_rows:
            off_track[int(row["car_idx"])].append(
                (float(row["session_time"]), float(row["lap_pct"]))
            )

        for event in events:
            primary_car = event["involved_drivers"][0] if event["involved_drivers"] else None
            if primary_car is None:
                continue

            inc_time = event["start_time"]

            # Resolve primary car's lap_pct at incident time from off-track data
            primary_lap_pct: float | None = None
            for ot_time, ot_pct in off_track.get(primary_car, []):
                if abs(ot_time - inc_time) <= self.NEARBY_TIME_WINDOW:
                    primary_lap_pct = ot_pct
                    break

            if primary_lap_pct is None:
                # Fallback: nearest car_state (may be on-track — still valid)
                row = db.execute("""
                    SELECT cs.lap_pct
                    FROM car_states cs
                    JOIN race_ticks t ON cs.tick_id = t.id
                    WHERE cs.car_idx = ?
                      AND t.session_state IN (?, ?)
                    ORDER BY ABS(t.session_time - ?)
                    LIMIT 1
                """, (primary_car, SESSION_STATE_RACING, SESSION_STATE_CHECKERED,
                      inc_time)).fetchone()
                primary_lap_pct = float(row["lap_pct"]) if row and row["lap_pct"] is not None else None

            if primary_lap_pct is None:
                event["metadata"]["car_count"] = len(event["involved_drivers"])
                event["metadata"]["multi_car"] = len(event["involved_drivers"]) > 1
                continue

            already_involved: set[int] = set(event["involved_drivers"])
            # Store (car_idx, best_lap_diff) so we can weight the severity bonus
            nearby_cars_with_gap: list[tuple[int, float]] = []

            for other_car, moments in off_track.items():
                if other_car in already_involved:
                    continue
                best_gap = None
                for ot_time, ot_pct in moments:
                    if abs(ot_time - inc_time) > self.NEARBY_TIME_WINDOW:
                        continue
                    lap_diff = min(
                        abs(ot_pct - primary_lap_pct),
                        1.0 - abs(ot_pct - primary_lap_pct),
                    )
                    if lap_diff <= self.NEARBY_LAP_PCT:
                        if best_gap is None or lap_diff < best_gap:
                            best_gap = lap_diff
                if best_gap is not None:
                    nearby_cars_with_gap.append((other_car, best_gap))

            if nearby_cars_with_gap:
                event["involved_drivers"] = list(already_involved) + [c for c, _ in nearby_cars_with_gap]
                # Per-car bonus: +3 when lap_diff ≈ 0 (right on top of each other),
                # scales down to +1 at the edge of the detection window.
                # proximity_factor = 1 − (lap_diff / NEARBY_LAP_PCT)  →  [0, 1]
                bonus = 0
                for _, gap in nearby_cars_with_gap:
                    proximity = 1.0 - gap / self.NEARBY_LAP_PCT
                    bonus += round(1 + proximity * 2)   # 1–3 per car
                event["severity"] = min(10, event["severity"] + bonus)
                # Store the closest gap for reference
                min_gap = min(g for _, g in nearby_cars_with_gap)
                event["metadata"]["closest_gap_lap_pct"] = round(min_gap, 5)
            else:
                # Solo incident — slight reduction so multi-car events rank above
                # equivalent-speed solo crashes.
                event["severity"] = max(1, round(event["severity"] * 0.9))

            event["metadata"]["car_count"] = len(event["involved_drivers"])
            event["metadata"]["multi_car"] = len(event["involved_drivers"]) > 1

        multi_count = sum(1 for e in events if e["metadata"].get("multi_car"))
        if multi_count:
            logger.info(
                "[Detector:Incident] %d/%d incidents identified as multi-car",
                multi_count, len(events),
            )
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
    MAX_SEGMENT = 45.0    # max seconds for a single battle segment
    SEGMENT_PAD = 8.0     # seconds of context before/after a lead change

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        gap_threshold = session_info.get("battle_gap_threshold", 0.5)  # seconds
        avg_lap_time  = session_info.get("avg_lap_time", 90.0) or 90.0
        battle_hold   = session_info.get("battle_sticky_period", 120)
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

        # Track lead changes per pair: times when who-is-ahead swaps
        lead_changes: dict[tuple[int, int], list[float]] = defaultdict(list)
        # Track current leader per pair
        pair_leader: dict[tuple[int, int], int] = {}
        # Track closest gap per pair per tick for excitement scoring
        closest_gaps: dict[tuple[int, int], list[tuple[float, float]]] = defaultdict(list)

        for time_s in sorted(ticks.keys()):
            # Sort by cont_dist descending: index 0 = furthest ahead on track
            cars = sorted(ticks[time_s], key=lambda c: c["cont_dist"], reverse=True)
            frame = tick_frames[time_s]

            # Find all adjacent pairs that are within the gap threshold
            close_pairs: set[tuple[int, int]] = set()
            for i in range(len(cars) - 1):
                a = cars[i]      # ahead
                b = cars[i + 1]  # just behind
                gap = a["cont_dist"] - b["cont_dist"]
                if gap <= gap_laps:
                    pair = (a["car_idx"], b["car_idx"])
                    close_pairs.add(pair)
                    closest_gaps[pair].append((time_s, gap))

                    # Track lead changes within this pair
                    current_leader = a["car_idx"]
                    if pair in pair_leader and pair_leader[pair] != current_leader:
                        lead_changes[pair].append(time_s)
                    pair_leader[pair] = current_leader

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

        # Convert raw windows to events, with sub-segment extraction for long battles
        events: list[dict] = []
        for b in finished:
            duration = b["end_time"] - b["start_time"]
            if duration < self.MIN_DURATION:
                continue

            pair = (b["ahead_idx"], b["behind_idx"])
            pos = b["position"]
            pos_bonus = max(0, 3 - (pos - 1))

            # Short battles: emit as-is
            if duration <= self.MAX_SEGMENT:
                dur_bonus = min(3, int(duration / 20))
                severity = min(10, 4 + pos_bonus + dur_bonus)
                events.append(self._make_event(b, severity, pair, lead_changes, closest_gaps, tick_frames))
                continue

            # Long battles: extract sub-segments around lead changes or tightest gaps
            segments = self._extract_segments(b, pair, lead_changes, closest_gaps, tick_frames, battle_hold)
            for seg in segments:
                seg_dur = seg["end_time"] - seg["start_time"]
                dur_bonus = min(3, int(seg_dur / 20))
                has_lead_change = seg.get("has_lead_change", False)
                lc_bonus = 2 if has_lead_change else 0
                severity = min(10, 4 + pos_bonus + dur_bonus + lc_bonus)
                events.append(self._make_event(seg, severity, pair, lead_changes, closest_gaps, tick_frames))

        events = self._merge_overlapping_battles(events)
        events.sort(key=lambda e: e["start_time"])
        logger.info("[Detector:Battle] Found %d battles", len(events))
        return events

    @staticmethod
    def _merge_overlapping_battles(events: list[dict]) -> list[dict]:
        """Merge battle events that overlap in time and share at least one driver.

        Example: A-B (0:56–1:17) and B-C (0:56–1:26) both contain driver B and
        overlap → merged into one A-B-C event spanning 0:56–1:26.
        """
        if len(events) <= 1:
            return events

        changed = True
        while changed:
            changed = False
            used = [False] * len(events)
            result: list[dict] = []
            for i, ev in enumerate(events):
                if used[i]:
                    continue
                group = [ev]
                used[i] = True
                # Grow the group transitively: any event sharing a driver with
                # any group member AND overlapping the current merged window joins.
                j = 0
                while j < len(events):
                    if used[j]:
                        j += 1
                        continue
                    other = events[j]
                    g_start = min(g["start_time"] for g in group)
                    g_end   = max(g["end_time"]   for g in group)
                    g_drivers: set[int] = set()
                    for g in group:
                        g_drivers.update(g.get("involved_drivers") or [])
                    o_drivers = set(other.get("involved_drivers") or [])
                    overlaps      = other["start_time"] <= g_end and other["end_time"] >= g_start
                    shares_driver = bool(g_drivers & o_drivers)
                    if overlaps and shares_driver:
                        group.append(other)
                        used[j] = True
                        changed = True
                        j = 0  # restart scan — new group member may enable further merges
                        continue
                    j += 1

                if len(group) == 1:
                    result.append(group[0])
                else:
                    all_drivers: list[int] = list(
                        dict.fromkeys(d for g in group for d in (g.get("involved_drivers") or []))
                    )
                    merged_start  = min(g["start_time"]  for g in group)
                    merged_end    = max(g["end_time"]    for g in group)
                    anchor_start  = min(group, key=lambda g: g["start_time"])
                    anchor_end    = max(group, key=lambda g: g["end_time"])
                    total_lc      = sum(g.get("metadata", {}).get("lead_changes", 0) for g in group)
                    min_gaps      = [g.get("metadata", {}).get("min_gap_laps") for g in group
                                     if g.get("metadata", {}).get("min_gap_laps") is not None]
                    # Preserve the original pairwise windows so downstream code
                    # can determine which drivers are active at any point in time.
                    driver_windows = [
                        {
                            "start_time": g["start_time"],
                            "end_time":   g["end_time"],
                            "drivers":    list(g.get("involved_drivers") or []),
                        }
                        for g in sorted(group, key=lambda x: x["start_time"])
                    ]
                    result.append({
                        "event_type":       EVENT_BATTLE,
                        "start_time":       merged_start,
                        "end_time":         merged_end,
                        "start_frame":      anchor_start.get("start_frame"),
                        "end_frame":        anchor_end.get("end_frame"),
                        "lap_number":       anchor_start.get("lap_number"),
                        "severity":         max(g["severity"] for g in group),
                        "involved_drivers": all_drivers,
                        "position":         min(g.get("position", 99) for g in group),
                        "metadata": {
                            "duration_seconds": round(merged_end - merged_start, 1),
                            "lead_changes":     total_lc,
                            "min_gap_laps":     round(min(min_gaps), 5) if min_gaps else None,
                            "driver_windows":   driver_windows,
                        },
                    })
            events = result
        return events

    def _make_event(self, b, severity, pair, lead_changes, closest_gaps, tick_frames):
        lc = lead_changes.get(pair, [])
        lc_in_window = [t for t in lc if b["start_time"] <= t <= b["end_time"]]
        gaps_in_window = [g for t, g in closest_gaps.get(pair, []) if b["start_time"] <= t <= b["end_time"]]
        min_gap = min(gaps_in_window) if gaps_in_window else None
        duration = b["end_time"] - b["start_time"]

        return {
            "event_type":       self.event_type,
            "start_time":       b["start_time"],
            "end_time":         b["end_time"],
            "start_frame":      b["start_frame"],
            "end_frame":        b["end_frame"],
            "lap_number":       b["lap"],
            "severity":         severity,
            "involved_drivers": [b["ahead_idx"], b["behind_idx"]],
            "position":         b["position"],
            "metadata": {
                "duration_seconds":   round(duration, 1),
                "lead_changes":       len(lc_in_window),
                "min_gap_laps":       round(min_gap, 5) if min_gap is not None else None,
            },
        }

    def _extract_segments(self, battle, pair, lead_changes, closest_gaps, tick_frames, battle_hold):
        """Extract the most exciting sub-segments from a long battle."""
        b_start = battle["start_time"]
        b_end = battle["end_time"]
        duration = b_end - b_start

        # Gather points of interest: lead changes within this battle window
        lc_times = [t for t in lead_changes.get(pair, []) if b_start <= t <= b_end]

        # If we have lead changes, build segments around them
        if lc_times:
            segments = []
            for lc_t in lc_times:
                seg_start = max(b_start, lc_t - self.SEGMENT_PAD)
                seg_end = min(b_end, lc_t + self.SEGMENT_PAD)
                # Expand to at least MIN_DURATION
                seg_dur = seg_end - seg_start
                if seg_dur < self.MIN_DURATION:
                    expand = (self.MIN_DURATION - seg_dur) / 2
                    seg_start = max(b_start, seg_start - expand)
                    seg_end = min(b_end, seg_end + expand)
                segments.append({
                    **battle, "start_time": seg_start, "end_time": seg_end,
                    "start_frame": self._interpolate_frame(seg_start, battle, tick_frames),
                    "end_frame": self._interpolate_frame(seg_end, battle, tick_frames),
                    "has_lead_change": True,
                })

            # Merge overlapping segments
            segments.sort(key=lambda s: s["start_time"])
            merged = [segments[0]]
            for seg in segments[1:]:
                if seg["start_time"] <= merged[-1]["end_time"] + 2.0:
                    merged[-1]["end_time"] = max(merged[-1]["end_time"], seg["end_time"])
                    merged[-1]["end_frame"] = seg["end_frame"]
                else:
                    merged.append(seg)

            # Cap each segment to MAX_SEGMENT
            result = []
            for seg in merged:
                seg_dur = seg["end_time"] - seg["start_time"]
                if seg_dur > self.MAX_SEGMENT:
                    seg["end_time"] = seg["start_time"] + self.MAX_SEGMENT
                result.append(seg)
            return result

        # No lead changes: pick the segment with the tightest gap
        gaps = [(t, g) for t, g in closest_gaps.get(pair, []) if b_start <= t <= b_end]
        if gaps:
            tightest_t = min(gaps, key=lambda x: x[1])[0]
            half = self.MAX_SEGMENT / 2
            seg_start = max(b_start, tightest_t - half)
            seg_end = min(b_end, seg_start + self.MAX_SEGMENT)
            return [{
                **battle, "start_time": seg_start, "end_time": seg_end,
                "start_frame": self._interpolate_frame(seg_start, battle, tick_frames),
                "end_frame": self._interpolate_frame(seg_end, battle, tick_frames),
                "has_lead_change": False,
            }]

        # Fallback: first MAX_SEGMENT seconds
        return [{
            **battle,
            "end_time": min(b_end, b_start + self.MAX_SEGMENT),
            "has_lead_change": False,
        }]

    @staticmethod
    def _interpolate_frame(time_s, battle, tick_frames):
        """Estimate frame for a given time within a battle window."""
        b_start = battle["start_time"]
        b_end = battle["end_time"]
        if b_end <= b_start:
            return battle["start_frame"]
        frac = (time_s - b_start) / (b_end - b_start)
        return int(battle["start_frame"] + frac * (battle["end_frame"] - battle["start_frame"]))


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

    Crash filtering: if the overtaken car went off-track within a short
    window around the overtake, it's not a genuine pass — it's a crash-
    caused position gain.  We mark this in metadata but still record it
    with reduced severity.
    """

    event_type = EVENT_OVERTAKE
    DEDUP_SECONDS = 10.0
    PROXIMITY_LAPS = 0.06   # max |cont_dist| gap to count (~5.4 s on a 90 s lap)
    CRASH_WINDOW = 5.0       # seconds — if passed car went off-track within this window, it's crash-caused
    MAX_RANK_JUMP = 3        # max rank delta allowed; real passes are between adjacent cars
    PIT_WINDOW = 30.0        # seconds either side of a pit stop to mark overtake as pit-related
    HOLD_SECONDS = 5.0       # passer must remain ahead for this long after the swap
    MIN_HOLD_GAP_LAPS = 0.001  # ~4-5 m on a 4 km track — gap must reach this within the hold window

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        # Load all on-track car states during racing, ordered by time.
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

        # Build pit stop windows per car (mirrors LeaderChangeDetector)
        pit_rows = db.execute("""
            SELECT cs.car_idx, MIN(t.session_time) AS pit_start, MAX(t.session_time) AS pit_end
            FROM car_states cs
            JOIN race_ticks t ON cs.tick_id = t.id
            WHERE cs.surface IN (?, ?)
              AND t.session_state IN (?, ?)
              AND cs.position > 0
            GROUP BY cs.car_idx, CAST(t.session_time / 60 AS INTEGER)
        """, (SURFACE_IN_PIT, SURFACE_PIT_APRON,
              SESSION_STATE_RACING, SESSION_STATE_CHECKERED)).fetchall()

        pit_windows: dict[int, list[tuple[float, float]]] = defaultdict(list)
        for pr in pit_rows:
            pit_windows[pr["car_idx"]].append((pr["pit_start"], pr["pit_end"]))

        def _car_pitted_near(car_idx: int, time_s: float) -> bool:  # type: ignore[misc]
            for ps, pe in pit_windows.get(car_idx, []):
                if abs(time_s - ps) < self.PIT_WINDOW or abs(time_s - pe) < self.PIT_WINDOW:
                    return True
            return False

        # Build off-track timestamps per car for crash filtering
        off_rows = db.execute("""
            SELECT cs.car_idx, t.session_time
            FROM car_states cs
            JOIN race_ticks t ON cs.tick_id = t.id
            WHERE t.session_state IN (?, ?)
              AND cs.surface = ?
              AND cs.position > 0
            ORDER BY cs.car_idx, t.session_time
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED,
              SURFACE_OFF_TRACK)).fetchall()

        # car_idx → sorted list of off-track times
        off_track_times: dict[int, list[float]] = defaultdict(list)
        for orow in off_rows:
            off_track_times[orow["car_idx"]].append(orow["session_time"])

        def _car_off_track_near(car_idx: int, time_s: float) -> bool:
            """Check if car_idx was off-track within CRASH_WINDOW of time_s."""
            times = off_track_times.get(car_idx, [])
            if not times:
                return False
            import bisect
            pos = bisect.bisect_left(times, time_s)
            for i in (pos - 1, pos):
                if 0 <= i < len(times) and abs(times[i] - time_s) <= self.CRASH_WINDOW:
                    return True
            return False

        # Group car states by tick timestamp
        ticks: dict[float, list[dict]] = defaultdict(list)
        tick_frames: dict[float, int] = {}
        for row in rows:
            time_s = row["session_time"]
            ticks[time_s].append({
                "car_idx":   row["car_idx"],
                "cont_dist": row["lap"] + row["lap_pct"],
                "lap":       row["lap"],
                "lap_pct":   row["lap_pct"],
            })
            tick_frames[time_s] = row["replay_frame"]

        events: list[dict] = []
        seen_pairs: dict[tuple[int, int], float] = {}
        prev_ranks: dict[int, int] = {}
        all_cars_crossed_sf = False   # gate: wait until every car has lap >= 1

        # Build ordered list of tick times for look-ahead during hold verification
        sorted_times = sorted(ticks.keys())
        time_index = {t: idx for idx, t in enumerate(sorted_times)}

        # Build per-tick cont_dist lookup: tick_time → {car_idx: cont_dist}
        tick_cont: dict[float, dict[int, float]] = {}
        for t in sorted_times:
            tick_cont[t] = {c["car_idx"]: c["cont_dist"] for c in ticks[t]}

        def _hold_verified(passer_idx: int, passed_idx: int, swap_time: float) -> tuple[bool, float]:
            """Check that passer stays ahead for HOLD_SECONDS with gap reaching MIN_HOLD_GAP_LAPS.
            Returns (verified, max_gap_during_hold)."""
            start_i = time_index.get(swap_time, 0)
            max_gap = 0.0
            for ti in range(start_i + 1, len(sorted_times)):
                ft = sorted_times[ti]
                if ft - swap_time > self.HOLD_SECONDS:
                    break
                cd = tick_cont.get(ft, {})
                d_a = cd.get(passer_idx)
                d_b = cd.get(passed_idx)
                if d_a is None or d_b is None:
                    continue  # one car off-track / missing this tick
                ahead_gap = d_a - d_b
                if ahead_gap < 0:
                    return False, max_gap  # position reverted
                max_gap = max(max_gap, ahead_gap)
            return max_gap >= self.MIN_HOLD_GAP_LAPS, max_gap

        def _battle_duration(car_a: int, car_b: int, until_time: float, proximity: float) -> float:
            """How many seconds were car_a and car_b within proximity before until_time?"""
            end_i = time_index.get(until_time, len(sorted_times) - 1)
            duration = 0.0
            for ti in range(end_i - 1, -1, -1):
                ft = sorted_times[ti]
                cd = tick_cont.get(ft, {})
                d_a = cd.get(car_a)
                d_b = cd.get(car_b)
                if d_a is None or d_b is None:
                    break
                if abs(d_a - d_b) > proximity:
                    break
                duration = until_time - ft
            return duration

        for time_s in sorted_times:
            cars = sorted(ticks[time_s], key=lambda c: c["cont_dist"], reverse=True)
            curr_ranks = {c["car_idx"]: i for i, c in enumerate(cars)}

            # Hold off until every car present has completed its first S/F
            # crossing (lap >= 1).  Until then cont_dist values are still
            # settling and cars crossing the line trigger spurious rank flips.
            if not all_cars_crossed_sf:
                if all(c["lap"] >= 1 for c in cars):
                    all_cars_crossed_sf = True
                else:
                    prev_ranks = curr_ranks
                    continue

            for i in range(len(cars) - 1):
                a = cars[i]
                b = cars[i + 1]

                gap = a["cont_dist"] - b["cont_dist"]
                if gap > self.PROXIMITY_LAPS:
                    continue

                idx_a, idx_b = a["car_idx"], b["car_idx"]
                prev_rank_a = prev_ranks.get(idx_a)
                prev_rank_b = prev_ranks.get(idx_b)
                if prev_rank_a is None or prev_rank_b is None:
                    continue

                if prev_rank_b < prev_rank_a:
                    # Guard: S/F boundary artifact — when car A crosses the
                    # S/F line, CarIdxLapDistPct resets to ~0 before
                    # CarIdxLap increments.  For one tick car A appears
                    # behind car B; on the next tick the lap counter catches
                    # up and the ranking restores, appearing as a false pass.
                    # Signature: A (now "ahead") has lap_pct < 0.08, is
                    # exactly one lap ahead of B, and B's lap_pct > 0.90.
                    if (a["lap"] == b["lap"] + 1
                            and a["lap_pct"] < 0.08
                            and b["lap_pct"] > 0.90):
                        continue

                    # Guard: implausible rank leap.
                    # A real overtake is a swap between neighbours: rank
                    # delta = 1 (or 2–3 in a pack).  A delta > MAX_RANK_JUMP
                    # means one car just crossed the S/F line while the other
                    # had already crossed it a tick earlier — their cont_dists
                    # momentarily invert but no physical pass occurred.
                    if prev_rank_a - prev_rank_b > self.MAX_RANK_JUMP:
                        continue

                    pair_key = (min(idx_a, idx_b), max(idx_a, idx_b))
                    last_t = seen_pairs.get(pair_key, -999.0)
                    if time_s - last_t < self.DEDUP_SECONDS:
                        continue

                    # Verify the overtake is sustained: passer must stay ahead
                    # for HOLD_SECONDS with gap reaching at least one car length.
                    held, hold_gap = _hold_verified(idx_a, idx_b, time_s)
                    if not held:
                        continue

                    lap_num  = a["lap"]
                    new_pos  = i + 1
                    crash_caused = _car_off_track_near(idx_b, time_s)
                    pit_related  = _car_pitted_near(idx_a, time_s) or _car_pitted_near(idx_b, time_s)
                    battle_dur = _battle_duration(idx_a, idx_b, time_s, self.PROXIMITY_LAPS)
                    in_battle = battle_dur >= 10.0  # sustained close running before the pass

                    severity = min(10, 4 + max(0, 3 - (new_pos - 1)))
                    if in_battle:
                        severity = min(10, severity + 1)  # battle-overtake bonus
                    if crash_caused:
                        severity = max(1, severity - 3)
                    if pit_related:
                        severity = max(1, severity - 2)  # pit strategy moves are less highlight-worthy

                    events.append({
                        "event_type":      self.event_type,
                        "start_time":      time_s,
                        "end_time":        time_s,
                        "start_frame":     tick_frames.get(time_s, 0),
                        "end_frame":       tick_frames.get(time_s, 0),
                        "lap_number":      lap_num,
                        "severity":        severity,
                        "involved_drivers": [idx_a, idx_b],
                        "position":        new_pos,
                        "metadata": {
                            "gap_laps":        round(gap, 4),
                            "hold_gap_laps":   round(hold_gap, 5),
                            "cross_time":      round(time_s, 2),
                            "crash_caused":    crash_caused,
                            "pit_related":     pit_related,
                            "in_battle":       in_battle,
                            "battle_duration": round(battle_dur, 1),
                            # --- diagnostics ---
                            "passer_idx":      idx_a,
                            "passed_idx":      idx_b,
                            "passer_lap":      a["lap"],
                            "passer_lap_pct":  round(a["lap_pct"], 4),
                            "passer_cont_dist": round(a["cont_dist"], 6),
                            "passed_lap":      b["lap"],
                            "passed_lap_pct":  round(b["lap_pct"], 4),
                            "passed_cont_dist": round(b["cont_dist"], 6),
                            "passer_prev_rank": prev_rank_a,
                            "passed_prev_rank": prev_rank_b,
                        },
                    })
                    seen_pairs[pair_key] = time_s

            prev_ranks = curr_ranks

        logger.info("[Detector:Overtake] Found %d overtakes (%d crash-caused, %d in-battle)",
                    len(events), sum(1 for e in events if e["metadata"].get("crash_caused")),
                    sum(1 for e in events if e["metadata"].get("in_battle")))
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



# ── Leader Change Detector ───────────────────────────────────────────────────

class LeaderChangeDetector(BaseDetector):
    """Detect changes in the race leader using continuous lap distance.

    CarIdxPosition = 1 only updates at start/finish crossings, so a lead
    change at lap_pct=0.5 wouldn't register until both cars lap — up to a
    full lap late.  Instead, we find the car with the highest cont_dist
    (lap + lap_pct) in each tick; that car IS the actual leader at that
    moment, regardless of where the S/F line is.

    Leader changes caused by offset pitstops (where one car pits and the
    other doesn't) are scored lower since they're not genuine on-track
    passes.  Undercut/overcut-related leader changes retain high severity.
    """

    event_type = EVENT_LEADER_CHANGE
    DEDUP_SECONDS = 5.0
    PIT_WINDOW = 30.0   # seconds — if either car pitted within this window, it's pit-related
    # Maximum plausible cont_dist gap for a genuine on-track lead change.
    # A real overtake means the new leader barely edges ahead — they can't
    # teleport 0.3+ laps forward in a single tick.  Larger gaps mean a lap
    # counter jump or stale telemetry artifact in the replay.
    MAX_PASS_GAP = 0.25

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        # Load ALL classified cars during racing (regardless of surface) so that
        # a car in the pit lane is never excluded from the cont_dist ranking.
        # Filtering to surface=ON_TRACK caused false leader changes: the moment
        # the actual leader entered the pits they disappeared, making the next
        # highest on-track car appear as the "new leader", then the real leader
        # "reclaimed the lead" on pit exit — producing spurious front↔back events.
        rows = db.execute("""
            SELECT t.session_time, t.replay_frame,
                   cs.car_idx, cs.lap, cs.lap_pct, cs.surface
            FROM car_states cs
            JOIN race_ticks t ON cs.tick_id = t.id
            WHERE t.session_state IN (?, ?)
              AND cs.position > 0
            ORDER BY t.session_time
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED)).fetchall()

        # Build pit stop windows per car for cross-referencing
        pit_rows = db.execute("""
            SELECT cs.car_idx, MIN(t.session_time) AS pit_start, MAX(t.session_time) AS pit_end
            FROM car_states cs
            JOIN race_ticks t ON cs.tick_id = t.id
            WHERE cs.surface IN (?, ?)
              AND t.session_state IN (?, ?)
              AND cs.position > 0
            GROUP BY cs.car_idx, CAST(t.session_time / 60 AS INTEGER)
        """, (SURFACE_IN_PIT, SURFACE_PIT_APRON,
              SESSION_STATE_RACING, SESSION_STATE_CHECKERED)).fetchall()

        # car_idx → list of (pit_start, pit_end) windows
        pit_windows: dict[int, list[tuple[float, float]]] = defaultdict(list)
        for pr in pit_rows:
            pit_windows[pr["car_idx"]].append((pr["pit_start"], pr["pit_end"]))

        def _car_pitted_near(car_idx: int, time_s: float) -> bool:
            """Check if car_idx had a pit stop within PIT_WINDOW of time_s."""
            for ps, pe in pit_windows.get(car_idx, []):
                if abs(time_s - ps) < self.PIT_WINDOW or abs(time_s - pe) < self.PIT_WINDOW:
                    return True
            return False

        # per-tick surface: (car_idx, session_time) -> surface
        tick_surfaces: dict[tuple[int, float], int] = {}

        # Group into ticks and find the cont_dist leader in each
        ticks: dict[float, list[dict]] = defaultdict(list)
        tick_frames: dict[float, int] = {}
        for row in rows:
            time_s = row["session_time"]
            surface = row["surface"]
            ticks[time_s].append({
                "car_idx":   row["car_idx"],
                "cont_dist": row["lap"] + row["lap_pct"],
                "lap":       row["lap"],
                "lap_pct":   row["lap_pct"],
                "surface":   surface,
            })
            tick_frames[time_s] = row["replay_frame"]
            tick_surfaces[(row["car_idx"], time_s)] = surface

        events: list[dict] = []
        prev_leader: int | None = None
        prev_leader_cont_dist: float = 0.0
        last_event_time = -999.0

        for time_s in sorted(ticks.keys()):
            cars = ticks[time_s]
            if not cars:
                continue

            # ── Pit-lane cont_dist artifact guard ────────────────────────────
            # On some tracks the pit lane shortcut advances a car's lap_pct
            # past on-track cars, making a pitting car appear to "take the
            # lead". Exclude cars physically in the pit when ranking leaders;
            # the pit window lookup still fires for cars near a pit stop.
            IN_PIT_SURFACES = (SURFACE_IN_PIT, SURFACE_PIT_APRON)
            on_track_cars = [c for c in cars if c["surface"] not in IN_PIT_SURFACES]
            ranking_cars = on_track_cars if on_track_cars else cars  # fallback: all cars

            leader_car = max(ranking_cars, key=lambda c: c["cont_dist"])
            leader_idx = leader_car["car_idx"]

            if prev_leader is None:
                prev_leader = leader_idx
                prev_leader_cont_dist = leader_car["cont_dist"]
                continue

            if leader_idx != prev_leader:
                old_car = next((c for c in cars if c["car_idx"] == prev_leader), None)

                # ── S/F boundary artifact guard ─────────────────────────────
                # When a car crosses the S/F line, CarIdxLapDistPct resets to
                # ~0 before CarIdxLap increments. For one tick the real leader
                # shows cont_dist ~N.001 while an approaching car shows ~N.998,
                # making the approaching car look like the "new leader".
                # Pattern: same lap, old leader pct < 0.08, new pct > 0.90.
                if old_car is not None:
                    if (old_car["lap"] == leader_car["lap"]
                            and old_car["lap_pct"] < 0.08
                            and leader_car["lap_pct"] > 0.90):
                        logger.debug(
                            "[Detector:LeaderChange] Skipping S/F boundary artifact "
                            "t=%.1fs: real_leader=car%d pct=%.4f "
                            "false_leader=car%d pct=%.4f",
                            time_s, prev_leader, old_car["lap_pct"],
                            leader_idx, leader_car["lap_pct"],
                        )
                        continue  # keep prev_leader; next tick self-corrects

                # ── Negative / impossibly large gap guard ───────────────────
                # A genuine on-track overtake: new leader edges *ahead*, so
                # instant_gap must be small and positive.
                #
                # Negative gap  → old leader just entered the pit exclusion
                #   zone. They haven't been passed; the pit-surface filter
                #   removed them from the ranking pool, promoting the car
                #   behind them. Not a real lead change — keep prev_leader
                #   so that when the leader exits pits ahead, no spurious
                #   "leader change" fires.
                #
                # Gap > MAX_PASS_GAP → CarIdxLap jumped (stale telemetry /
                #   replay artifact). Physically impossible overtake.
                old_cont_dist_now = old_car["cont_dist"] if old_car else prev_leader_cont_dist
                instant_gap = leader_car["cont_dist"] - old_cont_dist_now
                if instant_gap < 0 or instant_gap > self.MAX_PASS_GAP:
                    logger.debug(
                        "[Detector:LeaderChange] Skipping invalid gap "
                        "t=%.1fs: car%d cd=%.4f vs car%d cd=%.4f gap=%.4f",
                        time_s, leader_idx, leader_car["cont_dist"],
                        prev_leader, old_cont_dist_now, instant_gap,
                    )
                    continue  # reject; prev_leader unchanged

                if time_s - last_event_time >= self.DEDUP_SECONDS:
                    frame = tick_frames[time_s]

                    # Check if either car pitted near this leader change
                    new_pitted = _car_pitted_near(leader_idx, time_s)
                    old_pitted = _car_pitted_near(prev_leader, time_s)
                    pit_related = new_pitted or old_pitted

                    # Pit-related leader changes get lower severity (routine strategy)
                    severity = 4 if pit_related else 8

                    # Cont-dist gap already computed above (instant_gap / old_cont_dist_now)
                    old_cont_dist = old_cont_dist_now
                    cont_dist_gap = round(instant_gap, 6)

                    new_surface = tick_surfaces.get((leader_idx, time_s), -1)
                    old_surface = tick_surfaces.get((prev_leader, time_s), -1)

                    events.append({
                        "event_type": self.event_type,
                        "start_time": time_s,
                        "end_time": time_s,
                        "start_frame": max(0, frame),
                        "end_frame": frame,
                        "lap_number": leader_car["lap"],
                        "severity": severity,
                        "involved_drivers": [leader_idx, prev_leader],
                        "position": 1,
                        "metadata": {
                            "new_leader": leader_idx,
                            "old_leader": prev_leader,
                            "cross_time": round(time_s, 2),
                            "pit_related": pit_related,
                            "new_leader_pitted": new_pitted,
                            "old_leader_pitted": old_pitted,
                            "new_leader_surface": new_surface,
                            "old_leader_surface": old_surface,
                            "new_leader_cont_dist": round(leader_car["cont_dist"], 6),
                            "old_leader_cont_dist": round(old_cont_dist, 6),
                            "cont_dist_gap": cont_dist_gap,
                        },
                    })

                    # Build a name map from session_info for logging
                    _drivers = session_info.get("drivers", [])
                    _name_map = {d["car_idx"]: d.get("user_name", f"Car {d['car_idx']}") for d in _drivers if "car_idx" in d}
                    new_name = _name_map.get(leader_idx, f"car_idx={leader_idx}")
                    old_name = _name_map.get(prev_leader, f"car_idx={prev_leader}")
                    pit_tag = " [pit-related]" if pit_related else ""
                    logger.info(
                        "[Detector:LeaderChange] Lap %d t=%.1fs | %s took lead from %s"
                        " | gap=%.4f laps | new_cd=%.4f old_cd=%.4f%s",
                        leader_car["lap"], time_s,
                        new_name, old_name,
                        cont_dist_gap,
                        leader_car["cont_dist"], old_cont_dist,
                        pit_tag,
                    )

                    last_event_time = time_s

            prev_leader = leader_idx
            prev_leader_cont_dist = leader_car["cont_dist"]

        logger.info("[Detector:LeaderChange] Found %d leader changes total", len(events))
        return events


# ── First Lap Detector ───────────────────────────────────────────────────────

class FirstLapDetector(BaseDetector):
    """Mark the first racing lap as a special event.

    No longer mandatory — the race start itself is captured by
    RaceStartDetector.  First-lap events still receive a moderate
    severity so they are weighted slightly higher in scoring.
    """

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
            "severity": 6,
            "involved_drivers": [],
            "position": None,
            "metadata": {"description": "First racing lap — events here weighted higher"},
        }]

        logger.info("[Detector:FirstLap] Found first lap event")
        return events


# ── Last Lap Detector ────────────────────────────────────────────────────────

class LastLapDetector(BaseDetector):
    """Mark the final lap of the race.

    No longer mandatory — the checkered flag moment is captured by
    RaceFinishDetector.  The full last lap is still detected as context.
    """

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
            "severity": 6,
            "involved_drivers": [],
            "position": None,
            "metadata": {"description": "Final lap", "lap_number": max_lap},
        }]

        logger.info("[Detector:LastLap] Found last lap event (lap %d)", max_lap)
        return events
# ── Incident Log Detector ─────────────────────────────────────────────────────

class IncidentLogDetector(BaseDetector):
    """Detect incidents from iRacing's SessionLog ground-truth data.

    Uses iRacing's own incident description strings as event types (converted
    to snake_case), so what the user sees in LRS matches what iRacing reports:

      - "Car Contact"   → car_contact  (car-to-car collision)
      - "Contact"       → contact      (wall / barrier hit)
      - "Lost Control"  → lost_control (spin, no object struck)
      - "Off Track"     → off_track    (4-wheels-off track limits)
      - "Turn Cutting"  → turn_cutting (shortcut / kerb abuse)

    Severity is computed from incident points (iRacing's own rating) enriched
    by raw telemetry (approach speed + estimated race time lost), then scaled
    by race position (front-of-field events score higher).

    Incidents within PROXIMITY_MERGE_WINDOW seconds AND within PROXIMITY_LAP_PCT
    of each other on track are grouped into one event — the most impactful type
    wins, with +1 severity per additional car (capped at 10).

    Falls back gracefully (returns []) when incident_log is empty.
    """

    # Incident-point → severity range: base_min to base_max before enrichment
    _SEVERITY_RANGES: dict[int, tuple[int, int]] = {
        1: (2, 5),   # minor: off_track, turn_cutting, lost_control
        2: (4, 7),   # moderate: contact (wall), light car_contact
        4: (7, 10),  # major: significant car_contact
    }
    _SEVERITY_DEFAULT_RANGE = (3, 6)

    # iRacing Description → event_type (snake_case of iRacing's exact strings)
    # Used when iRacing provides exact description strings (live sessions).
    _DESCRIPTION_MAP: dict[str, str] = {
        "Car Contact":  EVENT_CAR_CONTACT,
        "Contact":      EVENT_CONTACT,
        "Lost Control": EVENT_LOST_CONTROL,
        "Off Track":    EVENT_OFF_TRACK,
        "Turn Cutting": EVENT_TURN_CUTTING,
    }

    # Surface enum values from CarIdxTrackSurface
    _SURFACE_OFF_TRACK = 0
    _SURFACE_ON_TRACK  = 3

    # Type priority for unified proximity grouping (higher = more interesting)
    _TYPE_PRIORITY: dict[str, int] = {
        EVENT_CAR_CONTACT:  5,
        EVENT_CONTACT:      4,
        EVENT_LOST_CONTROL: 3,
        EVENT_OFF_TRACK:    2,
        EVENT_TURN_CUTTING: 1,
    }

    # Types that inherently involve car-to-car interaction.
    # Solo types (off_track, lost_control, turn_cutting) are only grouped with
    # multi-car types — two independent off-tracks at the same corner are NOT
    # merged (they are separate incidents that happened to be close in time).
    _MULTI_CAR_TYPES: set[str] = {EVENT_CAR_CONTACT, EVENT_CONTACT}

    # Incidents within this window AND close on track are grouped as one event
    PROXIMITY_MERGE_WINDOW = 3.0    # seconds
    PROXIMITY_LAP_PCT      = 0.04   # track position tolerance

    # Time window for measuring est_time loss around the incident
    TIME_LOSS_BEFORE = 5.0   # seconds before incident
    TIME_LOSS_AFTER  = 10.0  # seconds after incident

    # Clip windows
    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        # ── Guard: nothing to do if incident_log is empty ─────────────────
        try:
            count = db.execute("SELECT COUNT(*) FROM incident_log").fetchone()[0]
        except sqlite3.OperationalError:
            logger.warning(
                "[Detector:IncidentLog] incident_log table missing — "
                "database may predate SessionLog integration."
            )
            return []

        if count == 0:
            logger.info(
                "[Detector:IncidentLog] incident_log is empty — "
                "SessionLog was not available during scan; no events emitted."
            )
            return []

        # ── Pre-load est_time series per car (for time-loss computation) ──
        # Pre-loading avoids N per-incident queries in the inner grouping loop.
        est_times: dict[int, list[tuple[float, float]]] = defaultdict(list)
        for row in db.execute("""
            SELECT cs.car_idx, t.session_time, cs.est_time
            FROM car_states cs
            JOIN race_ticks t ON cs.tick_id = t.id
            WHERE t.session_state IN (?, ?) AND cs.est_time > 0
            ORDER BY cs.car_idx, t.session_time
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED)).fetchall():
            est_times[row["car_idx"]].append((row["session_time"], row["est_time"]))

        # ── Load incidents with nearest racing tick + car state ────────────
        raw_incidents = db.execute("""
            SELECT
                il.id, il.car_idx, il.session_time, il.lap,
                il.description, il.incident_points, il.user_name,
                t.replay_frame, t.id AS tick_id,
                cs.position, cs.speed_ms, cs.lap_pct, cs.surface
            FROM incident_log il
            JOIN race_ticks t ON t.id = (
                SELECT rt.id FROM race_ticks rt
                WHERE rt.session_state IN (?, ?)
                ORDER BY ABS(rt.session_time - il.session_time)
                LIMIT 1
            )
            LEFT JOIN car_states cs
                ON cs.tick_id = t.id AND cs.car_idx = il.car_idx
            ORDER BY il.session_time
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED)).fetchall()

        if not raw_incidents:
            logger.info("[Detector:IncidentLog] No incidents matched racing ticks.")
            return []

        # Convert to mutable dicts and resolve each description → event_type.
        # Tries the legacy description map first (exact iRacing strings from
        # live sessions), then falls back to point-value + surface telemetry
        # classification (used in replay mode where descriptions are "+Nx").
        incidents = [dict(r) for r in raw_incidents]
        for inc in incidents:
            inc["event_type"] = self._classify_incident(inc)

        # ── Unified proximity grouping ────────────────────────────────────
        # Group incidents that are close in time AND on the same part of the
        # track — these are likely the same physical incident (e.g. two drivers
        # both receiving "Car Contact", or a lost-control that was then struck).
        # incidents is already sorted by session_time from the SQL ORDER BY.
        used: set[int] = set()
        groups: list[list[dict]] = []
        for i, a in enumerate(incidents):
            if i in used or not a["event_type"]:
                continue
            group = [a]
            used.add(i)
            for j in range(i + 1, len(incidents)):
                if j in used or not incidents[j]["event_type"]:
                    continue
                b = incidents[j]
                # Time bound — sorted so we can break early
                if b["session_time"] - a["session_time"] > self.PROXIMITY_MERGE_WINDOW:
                    break
                if b["car_idx"] == a["car_idx"]:
                    continue
                # Only merge across cars when at least one has a multi-car
                # type; two independent solo incidents (e.g. both "Off Track")
                # at the same corner are separate events, not one group.
                if (a["event_type"] not in self._MULTI_CAR_TYPES
                        and b["event_type"] not in self._MULTI_CAR_TYPES):
                    continue
                # Track proximity (only enforced when both have valid lap_pct)
                lp_a = a.get("lap_pct") or 0.0
                lp_b = b.get("lap_pct") or 0.0
                if lp_a > 0 and lp_b > 0:
                    lap_diff = min(abs(lp_a - lp_b), 1.0 - abs(lp_a - lp_b))
                    if lap_diff > self.PROXIMITY_LAP_PCT:
                        continue
                group.append(b)
                used.add(j)
            groups.append(group)

        # ── Emit one event per group ──────────────────────────────────────
        events: list[dict] = []
        for group in groups:
            # Dominant type = highest-priority incident in the group
            dominant = max(group, key=lambda g: self._TYPE_PRIORITY.get(g["event_type"], 0))
            event_type = dominant["event_type"]

            # Compute individual severities; find the primary (worst-off) car
            best_sev, primary = 0, group[0]
            for g in group:
                s = self._severity(
                    g["incident_points"] or 1,
                    g["speed_ms"] or 0.0,
                    self._time_loss(est_times, g["car_idx"], g["session_time"]),
                    g["position"] or 15,
                )
                g["_sev"] = s
                if s > best_sev:
                    best_sev, primary = s, g

            # Multi-car bonus: +1 per additional car beyond the first (cap 10)
            severity = min(10, best_sev + max(0, len(group) - 1))

            t_start  = min(g["session_time"] for g in group)
            t_end    = max(g["session_time"] for g in group)
            frame    = dominant["replay_frame"] or 0
            involved = list({g["car_idx"] for g in group})
            position = min((g["position"] for g in group if g.get("position")), default=None)
            time_loss = self._time_loss(est_times, primary["car_idx"], primary["session_time"])

            minor_types = {EVENT_OFF_TRACK, EVENT_TURN_CUTTING}
            events.append({
                "event_type":   event_type,
                "start_time":   t_start,
                "end_time":     t_end,
                "start_frame":  max(0, frame),
                "end_frame":    frame,
                "lap_number":   primary["lap"],
                "severity":     severity,
                "involved_drivers": involved,
                "position":     position,
                "metadata": {
                    "incident_source":     "iracing_session_log",
                    "iracing_description": dominant["description"],
                    "incident_points":     sum(g["incident_points"] or 1 for g in group),
                    "car_count":           len(involved),
                    "time_loss":           round(time_loss, 2),
                    "speed_ms":            round(primary.get("speed_ms") or 0.0, 2),
                    "lap_pct":             round(primary.get("lap_pct") or 0.0, 4),
                },
            })

        multi = sum(1 for g in groups if len(g) > 1)
        logger.info(
            "[Detector:IncidentLog] Found %d events from %d groups "
            "(%d multi-car, %d total raw incidents)",
            len(events), len(groups), multi, len(incidents),
        )
        return events

    # ── Helpers ───────────────────────────────────────────────────────────

    def _severity(
        self,
        incident_points: int,
        speed_ms: float,
        time_loss: float,
        position: int,
    ) -> int:
        """Blend iRacing incident points with telemetry to produce 1–10 severity.

        Incident points lock the severity to a base range:
          - 1x → 2–5   (minor)
          - 2x → 4–7   (moderate)
          - 4x → 7–10  (major)

        Within that range, speed (how dramatic) and time_loss (race impact)
        fill out the score.  Position scales it: front-of-field events score
        higher; back-markers get a mild discount down to a floor of 0.55.
        """
        base_min, base_max = self._SEVERITY_RANGES.get(
            incident_points, self._SEVERITY_DEFAULT_RANGE
        )
        speed_factor     = min(speed_ms / REFERENCE_SPEED_MS, 1.0) if speed_ms > 0 else 0.0
        time_loss_factor = min(time_loss / 15.0, 1.0)              if time_loss > 0 else 0.0

        # Blend: time-loss is more race-impactful; speed is more visually dramatic
        enrichment = speed_factor * SPEED_WEIGHT + time_loss_factor * TIME_LOSS_WEIGHT

        raw = base_min + enrichment * (base_max - base_min)

        # Position discount: P1 = 1.0, P5 ≈ 0.90, P10 ≈ 0.78, P20 ≈ 0.55 floor
        position_scale = max(0.55, 1.0 - max(0, position - 1) * 0.025)

        return round(max(1, min(10, raw * position_scale)))

    @classmethod
    def _classify_incident(cls, inc: dict) -> str | None:
        """Determine event type from an incident row.

        Tries the legacy description map first (exact iRacing strings).
        Falls back to classifying by incident points + surface telemetry:

          4x → car_contact  (always car-to-car in iRacing)
          2x + off-track surface → lost_control (spin into gravel/grass)
          2x + on-track surface  → contact      (wall / barrier hit)
          1x + off-track surface → off_track    (four wheels off)
          1x + on-track surface  → turn_cutting (corner cut / kerb abuse)
        """
        # Legacy path: exact iRacing description from live sessions
        desc = inc.get("description") or ""
        mapped = cls._DESCRIPTION_MAP.get(desc)
        if mapped:
            return mapped

        # Point-based classification (replay mode: "+1x", "+2x", "+4x")
        pts = inc.get("incident_points") or 0
        surface = inc.get("surface")  # may be None if LEFT JOIN missed
        off_track = surface is not None and int(surface) == cls._SURFACE_OFF_TRACK

        if pts >= 4:
            return EVENT_CAR_CONTACT
        if pts == 2:
            return EVENT_LOST_CONTROL if off_track else EVENT_CONTACT
        if pts == 1:
            return EVENT_OFF_TRACK if off_track else EVENT_TURN_CUTTING
        # Fallback for unexpected point values (0x or unknown)
        return None

    def _time_loss(
        self,
        est_times: dict[int, list[tuple[float, float]]],
        car_idx: int,
        session_time: float,
    ) -> float:
        """Estimate race time lost by comparing est_time before and after incident.

        Uses the pre-loaded est_time series and bisect for O(log n) lookup.
        Returns 0.0 if data is insufficient.
        """
        car_data = est_times.get(car_idx)
        if not car_data:
            return 0.0

        times_only = [t for t, _ in car_data]

        # est_time ~TIME_LOSS_BEFORE seconds before the incident
        idx_b = bisect.bisect_left(times_only, session_time - self.TIME_LOSS_BEFORE)
        if idx_b >= len(car_data):
            return 0.0
        before_est = car_data[min(idx_b, len(car_data) - 1)][1]

        # est_time ~TIME_LOSS_AFTER seconds after the incident
        idx_a = bisect.bisect_right(times_only, session_time + self.TIME_LOSS_AFTER)
        if idx_a >= len(car_data):
            idx_a = len(car_data) - 1
        after_est = car_data[idx_a][1]

        return max(0.0, after_est - before_est)


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

            # Suppress if either car already has a logged incident near this
            # time — it's captured by IncidentLogDetector; this is not a
            # plain close call.
            try:
                if db.execute("""
                    SELECT 1 FROM incident_log
                    WHERE car_idx IN (?, ?)
                      AND ABS(session_time - ?) <= 5.0
                    LIMIT 1
                """, (car_idx, nearby_car, time_s)).fetchone():
                    continue
            except sqlite3.OperationalError:
                pass  # incident_log absent (old DB) — proceed normally

            # Base 3, +1 for top-5 position battles (more entertaining)
            severity = min(5, 3 + int((row["position"] or 10) <= 5))

            events.append({
                "event_type": self.event_type,
                "start_time": time_s,
                "end_time": time_s,
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

    No longer mandatory — used as B-roll for qualifying overlay.
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
            "metadata": {"description": "Pace / formation lap — B-roll for qualifying overlay"},
        }]

        logger.info("[Detector:PaceLap] Found pace lap event")
        return events


# ── Race Start Detector ──────────────────────────────────────────────────────

class RaceStartDetector(BaseDetector):
    """Detect the green flag moment — transition from PARADE to RACING.

    Creates a short mandatory event (~10 s window) centred on the exact
    moment session_state flips from PARADE (3) to RACING (4).
    """

    event_type = EVENT_RACE_START

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        # Find the first RACING tick — green flag moment
        green = db.execute("""
            SELECT MIN(t.session_time) AS green_time,
                   MIN(t.replay_frame) AS green_frame
            FROM race_ticks t
            WHERE t.session_state = ?
        """, (SESSION_STATE_RACING,)).fetchone()

        if not green or green["green_time"] is None:
            logger.info("[Detector:RaceStart] No racing state found")
            return []

        green_time = green["green_time"]
        green_frame = green["green_frame"]


        events = [{
            "event_type": self.event_type,
            "start_time": green_time,
            "end_time": green_time,
            "start_frame": green_frame,
            "end_frame": green_frame,
            "lap_number": 1,
            "severity": 10,
            "involved_drivers": [],
            "position": None,
            "metadata": {
                "description": "Green flag — race start",
                "green_flag_time": green_time,
            },
        }]

        logger.info("[Detector:RaceStart] Green flag at %.1fs", green_time)
        return events


# ── Race Finish Detector ─────────────────────────────────────────────────────

class RaceFinishDetector(BaseDetector):
    """Detect the checkered flag — when the winner crosses the finish line.

    Creates a mandatory event around the moment session_state transitions
    to CHECKERED (5), which is when the leader completes the final lap.
    Includes the P1 car as the involved driver.
    """

    event_type = EVENT_RACE_FINISH

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        # Find the first CHECKERED tick — winner crosses the line
        chk = db.execute("""
            SELECT MIN(t.session_time) AS chk_time,
                   MIN(t.replay_frame) AS chk_frame
            FROM race_ticks t
            WHERE t.session_state = ?
        """, (SESSION_STATE_CHECKERED,)).fetchone()

        if not chk or chk["chk_time"] is None:
            logger.info("[Detector:RaceFinish] No checkered state found")
            return []

        chk_time = chk["chk_time"]
        chk_frame = chk["chk_frame"]

        # Try to find the P1 car at checkered
        winner = db.execute("""
            SELECT cs.car_idx
            FROM car_states cs
            JOIN race_ticks t ON cs.tick_id = t.id
            WHERE t.session_state = ?
              AND cs.position = 1
            LIMIT 1
        """, (SESSION_STATE_CHECKERED,)).fetchone()

        involved = [winner["car_idx"]] if winner else []

        events = [{
            "event_type": self.event_type,
            "start_time": chk_time,
            "end_time": chk_time,
            "start_frame": chk_frame,
            "end_frame": chk_frame,
            "lap_number": None,
            "severity": 10,
            "involved_drivers": involved,
            "position": 1,
            "metadata": {
                "description": "Checkered flag — race winner crosses the line",
                "checkered_time": chk_time,
                "winner_car_idx": involved[0] if involved else None,
            },
        }]

        logger.info("[Detector:RaceFinish] Checkered flag at %.1fs, winner car_idx=%s",
                    chk_time, involved[0] if involved else "unknown")
        return events


# ── Shared pit-window builder ────────────────────────────────────────────────

def _build_pit_windows(db: sqlite3.Connection, min_duration: float = 5.0) -> list[dict]:
    """Build pit stop windows from the car_states log.

    For each window we also look up the last on-track position *before* the
    car entered the pits (``pre_pit_pos``) and the first on-track position
    *after* it exited (``post_pit_pos``).  These are the only reliable values
    for strategy comparisons; the in-pit ``position`` column cannot be trusted
    because iRacing may freeze or garble it while a car is on pit road.
    """
    pit_rows = db.execute("""
        SELECT cs.car_idx, cs.position, cs.lap,
               t.session_time, t.replay_frame
        FROM car_states cs
        JOIN race_ticks t ON cs.tick_id = t.id
        WHERE cs.surface IN (?, ?)
          AND t.session_state IN (?, ?)
          AND cs.position > 0
        ORDER BY cs.car_idx, t.session_time
    """, (SURFACE_IN_PIT, SURFACE_PIT_APRON,
          SESSION_STATE_RACING, SESSION_STATE_CHECKERED)).fetchall()

    pit_windows: list[dict] = []
    current: dict[int, dict] = {}

    for row in pit_rows:
        car_idx = row["car_idx"]
        time_s  = row["session_time"]
        if car_idx in current:
            if time_s - current[car_idx]["end_time"] < 5.0:
                current[car_idx]["end_time"]  = time_s
                current[car_idx]["end_frame"] = row["replay_frame"]
            else:
                pit_windows.append(current.pop(car_idx))
                current[car_idx] = {
                    "car_idx": car_idx, "start_time": time_s, "end_time": time_s,
                    "start_frame": row["replay_frame"], "end_frame": row["replay_frame"],
                    "position": row["position"], "lap": row["lap"],
                }
        else:
            current[car_idx] = {
                "car_idx": car_idx, "start_time": time_s, "end_time": time_s,
                "start_frame": row["replay_frame"], "end_frame": row["replay_frame"],
                "position": row["position"], "lap": row["lap"],
            }
    pit_windows.extend(current.values())
    pit_windows = [pw for pw in pit_windows if pw["end_time"] - pw["start_time"] >= min_duration]

    # Enrich each window with reliable pre/post on-track positions
    for pw in pit_windows:
        # Last on-track frame before pit entry
        pre = db.execute("""
            SELECT cs.position FROM car_states cs
            JOIN race_ticks t ON cs.tick_id = t.id
            WHERE cs.car_idx = ?
              AND t.session_time < ?
              AND cs.surface NOT IN (?, ?)
              AND cs.position > 0
            ORDER BY t.session_time DESC LIMIT 1
        """, (pw["car_idx"], pw["start_time"],
              SURFACE_IN_PIT, SURFACE_PIT_APRON)).fetchone()
        pw["pre_pit_pos"] = pre["position"] if pre else None

        # First on-track frame after pit exit
        post = db.execute("""
            SELECT cs.position FROM car_states cs
            JOIN race_ticks t ON cs.tick_id = t.id
            WHERE cs.car_idx = ?
              AND t.session_time > ?
              AND cs.surface NOT IN (?, ?)
              AND cs.position > 0
            ORDER BY t.session_time ASC LIMIT 1
        """, (pw["car_idx"], pw["end_time"],
              SURFACE_IN_PIT, SURFACE_PIT_APRON)).fetchone()
        pw["post_pit_pos"] = post["position"] if post else None

    return pit_windows


# ── Undercut Detector ────────────────────────────────────────────────────────

class UndercutDetector(BaseDetector):
    """Detect undercut events.

    An undercut is when the car that was *behind* pits *earlier*, gets fresh
    tyres, drives faster laps while the car ahead is still on worn rubber, and
    emerges ahead after the rival completes their own stop.

    Detection criteria (all must hold):
    1. Car A enters the pits BEFORE Car B (A is the undercut initiator).
    2. Their pit entries are staggered by at most MAX_PIT_ENTRY_STAGGER seconds
       (same strategic pit cycle, typically within one lap).
    3. Before either car pitted, A was BEHIND B on track (higher position number).
    4. The two cars were close in position before pitting (≤ PROXIMITY_POSITIONS).
    5. After BOTH cars have exited the pits, A is AHEAD of B — the swap is
       confirmed on actual on-track position data, not in-pit estimates.
    """

    event_type = EVENT_UNDERCUT
    PROXIMITY_POSITIONS   = 5    # must be within N positions before pitting
    MAX_PIT_ENTRY_STAGGER = 90.0  # max seconds between the two pit entries

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        pit_windows = _build_pit_windows(db)
        events: list[dict] = []
        seen: set[tuple] = set()

        for pw_a in pit_windows:
            for pw_b in pit_windows:
                if pw_a["car_idx"] == pw_b["car_idx"]:
                    continue

                # ── 1. A pits first (A is the undercut car) ──────────────────
                if pw_a["start_time"] >= pw_b["start_time"]:
                    continue

                # ── 2. Pit entries in the same strategic window ───────────────
                entry_stagger = pw_b["start_time"] - pw_a["start_time"]
                if entry_stagger > self.MAX_PIT_ENTRY_STAGGER:
                    continue

                # ── 3 & 4. A was close behind B before pitting ───────────────
                pre_a = pw_a["pre_pit_pos"]
                pre_b = pw_b["pre_pit_pos"]
                if pre_a is None or pre_b is None:
                    continue
                if pre_a <= pre_b:
                    # A was already ahead — can't undercut someone you're ahead of
                    continue
                if (pre_a - pre_b) > self.PROXIMITY_POSITIONS:
                    continue

                # ── 5. Confirm swap after both cars have exited ───────────────
                post_a = pw_a["post_pit_pos"]
                post_b = pw_b["post_pit_pos"]
                if post_a is None or post_b is None:
                    continue
                if post_a >= post_b:
                    # A is still behind — undercut attempt failed, skip
                    continue

                # Deduplicate: one event per (initiator, victim, lap)
                key = (pw_a["car_idx"], pw_b["car_idx"], pw_a["lap"])
                if key in seen:
                    continue
                seen.add(key)

                severity = min(8, 5 + max(0, 3 - (pre_b - 1)))  # higher for leading cars

                events.append({
                    "event_type":       self.event_type,
                    "start_time":       max(0.0, pw_a["start_time"] - 3.0),
                    "end_time":         pw_b["end_time"] + 5.0,
                    "start_frame":      pw_a["start_frame"],
                    "end_frame":        pw_b["end_frame"],
                    "lap_number":       pw_a["lap"],
                    "severity":         severity,
                    "involved_drivers": [pw_a["car_idx"], pw_b["car_idx"]],
                    "position":         pre_b,  # the position that changed hands
                    "metadata": {
                        "undercut_car":          pw_a["car_idx"],
                        "victim_car":            pw_b["car_idx"],
                        "pit_entry_stagger_s":   round(entry_stagger, 1),
                        "position_before_pit":   pre_a,
                        "position_after_pit":    post_a,
                    },
                })

        logger.info("[Detector:Undercut] Found %d undercuts", len(events))
        return events


# ── Overcut Detector ─────────────────────────────────────────────────────────

class OvercutDetector(BaseDetector):
    """Detect overcut events.

    An overcut is when the car that was *behind* stays out *longer*, gains
    clear air and runs fast laps while the rival is stuck in the dirty air of
    traffic after exiting the pits early, then emerges ahead after a later pit.

    It is the strategic inverse of an undercut:
      Undercut → earlier pitter (who was behind) gains position.
      Overcut  → later pitter  (who was behind) gains position.

    Detection criteria (all must hold):
    1. Car A enters the pits AFTER Car B (A is the overcut car — stays out longer).
    2. Their pit entries are staggered by at most MAX_PIT_ENTRY_STAGGER seconds.
    3. Before either car pitted, A was BEHIND B on track (higher position number).
    4. The two cars were close in position before pitting (≤ PROXIMITY_POSITIONS).
    5. After BOTH cars have exited the pits, A is AHEAD of B — the swap is
       confirmed on actual on-track position data, not in-pit estimates.
    """

    event_type = EVENT_OVERCUT
    PROXIMITY_POSITIONS   = 5
    MAX_PIT_ENTRY_STAGGER = 90.0

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        pit_windows = _build_pit_windows(db)
        events: list[dict] = []
        seen: set[tuple] = set()

        for pw_a in pit_windows:
            for pw_b in pit_windows:
                if pw_a["car_idx"] == pw_b["car_idx"]:
                    continue

                # ── 1. A pits LATER (A is the overcut car — stayed out longer) ─
                if pw_a["start_time"] <= pw_b["start_time"]:
                    continue

                # ── 2. Pit entries in the same strategic window ───────────────
                entry_stagger = pw_a["start_time"] - pw_b["start_time"]
                if entry_stagger > self.MAX_PIT_ENTRY_STAGGER:
                    continue

                # ── 3 & 4. A was close behind B before pitting ───────────────
                pre_a = pw_a["pre_pit_pos"]
                pre_b = pw_b["pre_pit_pos"]
                if pre_a is None or pre_b is None:
                    continue
                if pre_a <= pre_b:
                    # A was already ahead — an overcut from ahead is called
                    # "maintaining position", not an overcut pass
                    continue
                if (pre_a - pre_b) > self.PROXIMITY_POSITIONS:
                    continue

                # ── 5. Confirm swap after both cars have exited ───────────────
                post_a = pw_a["post_pit_pos"]
                post_b = pw_b["post_pit_pos"]
                if post_a is None or post_b is None:
                    continue
                if post_a >= post_b:
                    # A still behind — overcut attempt failed, skip
                    continue

                # Deduplicate: one event per (initiator, victim, lap)
                key = (pw_a["car_idx"], pw_b["car_idx"], pw_a["lap"])
                if key in seen:
                    continue
                seen.add(key)

                severity = min(8, 5 + max(0, 3 - (pre_b - 1)))

                events.append({
                    "event_type":       self.event_type,
                    "start_time":       max(0.0, pw_b["start_time"] - 3.0),
                    "end_time":         pw_a["end_time"] + 5.0,
                    "start_frame":      pw_b["start_frame"],
                    "end_frame":        pw_a["end_frame"],
                    "lap_number":       pw_a["lap"],
                    "severity":         severity,
                    "involved_drivers": [pw_a["car_idx"], pw_b["car_idx"]],
                    "position":         pre_b,  # the position that changed hands
                    "metadata": {
                        "overcut_car":           pw_a["car_idx"],
                        "victim_car":            pw_b["car_idx"],
                        "pit_entry_stagger_s":   round(entry_stagger, 1),
                        "position_before_pit":   pre_a,
                        "position_after_pit":    post_a,
                    },
                })

        logger.info("[Detector:Overcut] Found %d overcuts", len(events))
        return events


# ── Pit Battle Detector ──────────────────────────────────────────────────────

class PitBattleDetector(BaseDetector):
    """Detect pit battles: two or more cars pit at nearly the same time
    and are side-by-side in the pit lane or pit exit.

    A pit battle occurs when cars from close positions pit within a tight
    time window, creating a simultaneous pit stop scenario where pit crew
    speed and pit entry/exit determine the final order.
    """

    event_type = EVENT_PIT_BATTLE
    PIT_OVERLAP_WINDOW = 10.0  # seconds — pits must overlap within this window

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        pit_rows = db.execute("""
            SELECT cs.car_idx, cs.position, cs.lap,
                   t.session_time, t.replay_frame
            FROM car_states cs
            JOIN race_ticks t ON cs.tick_id = t.id
            WHERE cs.surface IN (?, ?)
              AND t.session_state IN (?, ?)
              AND cs.position > 0
            ORDER BY cs.car_idx, t.session_time
        """, (SURFACE_IN_PIT, SURFACE_PIT_APRON,
              SESSION_STATE_RACING, SESSION_STATE_CHECKERED)).fetchall()

        pit_windows: list[dict] = []
        current: dict[int, dict] = {}

        for row in pit_rows:
            car_idx = row["car_idx"]
            time_s = row["session_time"]
            if car_idx in current:
                if time_s - current[car_idx]["end_time"] < 5.0:
                    current[car_idx]["end_time"] = time_s
                    current[car_idx]["end_frame"] = row["replay_frame"]
                else:
                    pit_windows.append(current.pop(car_idx))
                    current[car_idx] = {
                        "car_idx": car_idx, "start_time": time_s, "end_time": time_s,
                        "start_frame": row["replay_frame"], "end_frame": row["replay_frame"],
                        "position": row["position"], "lap": row["lap"],
                    }
            else:
                current[car_idx] = {
                    "car_idx": car_idx, "start_time": time_s, "end_time": time_s,
                    "start_frame": row["replay_frame"], "end_frame": row["replay_frame"],
                    "position": row["position"], "lap": row["lap"],
                }
        pit_windows.extend(current.values())
        pit_windows = [pw for pw in pit_windows if pw["end_time"] - pw["start_time"] >= 5.0]

        # Find overlapping or near-simultaneous pit windows
        events: list[dict] = []
        used: set[int] = set()

        for i, pw_a in enumerate(pit_windows):
            if i in used:
                continue
            group = [pw_a]
            used.add(i)

            for j in range(i + 1, len(pit_windows)):
                if j in used:
                    continue
                pw_b = pit_windows[j]
                if pw_b["car_idx"] == pw_a["car_idx"]:
                    continue
                # Check for temporal overlap or near-simultaneous entry
                latest_start = max(pw_a["start_time"], pw_b["start_time"])
                earliest_end = min(pw_a["end_time"], pw_b["end_time"])
                if latest_start - earliest_end <= self.PIT_OVERLAP_WINDOW:
                    group.append(pw_b)
                    used.add(j)

            if len(group) < 2:
                continue

            drivers = [pw["car_idx"] for pw in group]
            t_start = min(pw["start_time"] for pw in group)
            t_end = max(pw["end_time"] for pw in group)
            f_start = min(pw["start_frame"] for pw in group)
            f_end = max(pw["end_frame"] for pw in group)
            best_pos = min(pw["position"] or 99 for pw in group)

            severity = min(8, 5 + len(group) - 2 + max(0, 3 - (best_pos - 1)))

            events.append({
                "event_type": self.event_type,
                "start_time": max(0, t_start - 3.0),
                "end_time": t_end + 5.0,
                "start_frame": f_start,
                "end_frame": f_end,
                "lap_number": group[0]["lap"],
                "severity": severity,
                "involved_drivers": drivers,
                "position": best_pos,
                "metadata": {
                    "car_count": len(drivers),
                    "pit_overlap_seconds": round(max(0, min(pw["end_time"] for pw in group) - max(pw["start_time"] for pw in group)), 1),
                },
            })

        logger.info("[Detector:PitBattle] Found %d pit battles", len(events))
        return events


# ── Yellow Flag / Safety Car Detector ───────────────────────────────────────

class YellowFlagDetector(BaseDetector):
    """Detect mid-race full-course yellow / safety car periods.

    Queries ``race_ticks.flag_yellow`` for windows during SESSION_STATE_RACING
    or SESSION_STATE_CHECKERED.  Merges contiguous yellow ticks into windows
    and emits:

      - A ``pace_lap`` event for each yellow flag window (B-roll / SC period).
      - A mandatory ``restart`` event at each yellow→green transition (the
        moment ``flag_yellow`` drops back to 0 after being raised), since
        restarts are high-entertainment moments.

    This detector is distinct from ``PaceLapDetector``, which only covers
    the pre-race formation/parade lap (SESSION_STATE_PARADE).
    """

    event_type = EVENT_PACE_LAP
    MERGE_GAP = 8.0        # seconds — merge yellow windows closer than this
    MIN_DURATION = 20.0    # seconds — ignore very brief yellow blips

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        rows = db.execute("""
            SELECT session_time, replay_frame, flag_yellow
            FROM race_ticks
            WHERE session_state IN (?, ?)
            ORDER BY session_time
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED)).fetchall()

        if not rows:
            logger.info("[Detector:YellowFlag] No racing ticks found")
            return []

        # Build yellow flag windows from contiguous flag_yellow=1 ticks
        windows: list[list] = []   # [[start_time, end_time, start_frame, end_frame], ...]
        in_yellow = False
        win: list = []

        for row in rows:
            flagged = bool(row["flag_yellow"])
            if flagged and not in_yellow:
                in_yellow = True
                win = [row["session_time"], row["session_time"],
                       row["replay_frame"], row["replay_frame"]]
            elif flagged and in_yellow:
                win[1] = row["session_time"]
                win[3] = row["replay_frame"]
            elif not flagged and in_yellow:
                in_yellow = False
                windows.append(win)
                win = []

        if in_yellow and win:
            windows.append(win)

        if not windows:
            logger.info("[Detector:YellowFlag] No mid-race yellow flag periods found")
            return []

        # Merge windows that are close together
        merged: list[list] = [list(windows[0])]
        for w in windows[1:]:
            if w[0] - merged[-1][1] <= self.MERGE_GAP:
                merged[-1][1] = w[1]
                merged[-1][3] = w[3]
            else:
                merged.append(list(w))

        # Filter out very brief flags (likely noise / local yellow)
        merged = [w for w in merged if w[1] - w[0] >= self.MIN_DURATION]

        if not merged:
            logger.info("[Detector:YellowFlag] No yellow periods exceeded minimum duration")
            return []

        events: list[dict] = []

        for w in merged:
            t0, t1, f0, f1 = w[0], w[1], w[2], w[3]

            # pace_lap event for the full SC/yellow window (B-roll / skip potential)
            events.append({
                "event_type": EVENT_PACE_LAP,
                "start_time": t0,
                "end_time": t1,
                "start_frame": f0,
                "end_frame": f1,
                "lap_number": None,
                "severity": 3,
                "involved_drivers": [],
                "position": None,
                "metadata": {
                    "description": "Full-course yellow — safety car period",
                    "duration_seconds": round(t1 - t0, 1),
                },
            })

            # Mandatory restart event at the yellow→green transition
            events.append({
                "event_type": EVENT_RESTART,
                "start_time": t1,
                "end_time": t1,
                "start_frame": f1,
                "end_frame": f1,
                "lap_number": None,
                "severity": 9,
                "involved_drivers": [],
                "position": None,
                "metadata": {
                    "description": "Green flag restart after safety car period",
                    "yellow_start": round(t0, 2),
                    "yellow_end": round(t1, 2),
                    "yellow_duration": round(t1 - t0, 1),
                },
            })

        logger.info(
            "[Detector:YellowFlag] Found %d yellow period(s), %d restart(s)",
            len(merged), len(merged),
        )
        return events


# ── Finish Sequence Detector ─────────────────────────────────────────────────

class FinishSequenceDetector(BaseDetector):
    """Detect individual finish-line crossings during the final lap (P2 onward).

    The ``RaceFinishDetector`` already emits a mandatory ``race_finish`` event
    for the overall winner (P1).  This detector complements it by emitting
    ``race_finish`` events for each subsequent finisher (P2–P10),
    enabling per-car camera cuts as the chequered flag is waved.

    Uses ``lap_completions`` to find the exact session_time each car crosses
    the line on the final race lap, ordered by finishing position.
    Skips P1 to avoid duplicating the ``RaceFinishDetector`` window.
    """

    event_type = EVENT_RACE_FINISH
    MAX_FINISHERS = 9      # P2 through P10
    SEVERITY = 8           # high severity — top finisher moments

    def detect(self, db: sqlite3.Connection, session_info: dict) -> list[dict]:
        # Find the final lap number
        max_lap_row = db.execute("""
            SELECT MAX(race_laps) AS max_lap
            FROM race_ticks
            WHERE session_state IN (?, ?)
        """, (SESSION_STATE_RACING, SESSION_STATE_CHECKERED)).fetchone()

        if not max_lap_row or not max_lap_row["max_lap"]:
            logger.info("[Detector:FinishSequence] No lap data found")
            return []

        max_lap = max_lap_row["max_lap"]

        # Find each car's final lap completion time, ordered by finish time
        rows = db.execute("""
            SELECT lc.car_idx, lc.position, rt.session_time, rt.replay_frame
            FROM lap_completions lc
            JOIN race_ticks rt ON rt.id = lc.tick_id
            WHERE lc.lap_number = ?
            ORDER BY rt.session_time
        """, (max_lap,)).fetchall()

        if not rows:
            logger.info("[Detector:FinishSequence] No final-lap completions for lap %d", max_lap)
            return []

        events: list[dict] = []
        # Skip P1 (index 0 = earliest crossing = winner, covered by RaceFinishDetector)
        for row in rows[1: 1 + self.MAX_FINISHERS]:
            t = row["session_time"]
            frame = row["replay_frame"]
            car_idx = row["car_idx"]
            position = row["position"] or 0
            finish_position = rows.index(row) + 1  # 1-based, with P1=1

            events.append({
                "event_type": self.event_type,
                "start_time": t,
                "end_time": t,
                "start_frame": max(0, frame),
                "end_frame": frame,
                "lap_number": max_lap,
                "severity": max(5, self.SEVERITY - finish_position + 2),
                "involved_drivers": [car_idx],
                "position": position,
                "metadata": {
                    "description": f"P{finish_position} crosses the finish line",
                    "finish_position": finish_position,
                    "crossing_time": round(t, 2),
                },
            })

        logger.info(
            "[Detector:FinishSequence] Found %d finish crossings (P2–P%d)",
            len(events), len(events) + 1,
        )
        return events


# ── Detector registry ────────────────────────────────────────────────────────

ALL_DETECTORS: list[BaseDetector] = [
    IncidentDetector(),
    BattleDetector(),
    OvertakeDetector(),
    PitStopDetector(),
    LeaderChangeDetector(),
    RaceStartDetector(),
    RaceFinishDetector(),
    PaceLapDetector(),
    YellowFlagDetector(),
    FinishSequenceDetector(),
    FirstLapDetector(),
    LastLapDetector(),
    # CloseCallDetector: catches near-misses below the incident threshold
    # (no SessionLog entry generated, purely telemetry-inferred).
    CloseCallDetector(),
    # IncidentLogDetector is reserved for live sessions (reads iRacing SessionLog).
    # Disabled in replay mode — CarIdxIncidentCount returns None during playback.
    # IncidentLogDetector(),
    UndercutDetector(),
    OvercutDetector(),
    PitBattleDetector(),
]
