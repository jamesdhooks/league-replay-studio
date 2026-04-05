"""
seed_demo_data.py
-----------------
Creates a complete demo project with realistic dummy data for every stage
of the League Replay Studio pipeline:

  Stage 1 – Telemetry   : race_ticks + car_states + drivers (SQLite)
  Stage 2 – Event log   : race_events (SQLite)
  Stage 3 – Highlight   : highlight config + scored events (SQLite + JSON)
  Stage 4 – Overlay     : sample frame data JSON
  Stage 5 – Pipeline    : pipeline preset JSON

Run from the backend/ directory (or repo root):
    python backend/seed_demo_data.py

The script is idempotent: if a project named "Demo – Silverstone GP" already
exists it will be deleted and recreated.
"""

from __future__ import annotations

import json
import math
import random
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── Path bootstrap ───────────────────────────────────────────────────────────
# Allow importing backend modules without installing as a package.
REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from server.config import DATA_DIR, PROJECTS_DIR, CONFIG_PATH, load_config, save_config
from server.services.db import init_db, get_connection
from server.services.analysis_db import (
    init_analysis_db,
    get_project_db,
    insert_events_batch,
)

# ── Seed constants ────────────────────────────────────────────────────────────

DEMO_PROJECT_NAME = "Demo – Silverstone GP"
TRACK_NAME = "Silverstone Circuit"
SERIES_NAME = "iRacing GT3 Challenge"
SESSION_TYPE = "race"
TOTAL_LAPS = 15
RACE_DURATION_S = 2700.0   # 45 min
TICKS_PER_SECOND = 1       # ~1 telemetry sample / s for demo (real: 50 Hz)
REPLAY_FPS = 60
NUM_DRIVERS = 20

random.seed(42)


# ── Driver roster ─────────────────────────────────────────────────────────────

DRIVERS = [
    (0,  "44",  "Lewis Hamilton",     "GT3",  1900044),
    (1,  "16",  "Charles Leclerc",    "GT3",  1900016),
    (2,  "1",   "Max Verstappen",     "GT3",  1900001),
    (3,  "63",  "George Russell",     "GT3",  1900063),
    (4,  "11",  "Sergio Perez",       "GT3",  1900011),
    (5,  "55",  "Carlos Sainz",       "GT3",  1900055),
    (6,  "14",  "Fernando Alonso",    "GT3",  1900014),
    (7,  "4",   "Lando Norris",       "GT3",  1900004),
    (8,  "81",  "Oscar Piastri",      "GT3",  1900081),
    (9,  "18",  "Lance Stroll",       "GT3",  1900018),
    (10, "10",  "Pierre Gasly",       "GT3",  1900010),
    (11, "31",  "Esteban Ocon",       "GT3",  1900031),
    (12, "27",  "Nico Hulkenberg",    "GT3",  1900027),
    (13, "77",  "Valtteri Bottas",    "GT3",  1900077),
    (14, "24",  "Zhou Guanyu",        "GT3",  1900024),
    (15, "22",  "Yuki Tsunoda",       "GT3",  1900022),
    (16, "23",  "Alexander Albon",    "GT3",  1900023),
    (17, "2",   "Logan Sargeant",     "GT3",  1900002),
    (18, "20",  "Kevin Magnussen",    "GT3",  1900020),
    (19, "3",   "Daniel Ricciardo",   "GT3",  1900003),
]

# Lap-time baseline per driver (seconds) – slight variation per lap
BASE_LAP_TIMES = {
    0: 91.2, 1: 91.5, 2: 91.0, 3: 91.8, 4: 92.1,
    5: 92.3, 6: 92.6, 7: 91.4, 8: 91.9, 9: 93.1,
    10: 93.4, 11: 93.7, 12: 94.0, 13: 94.3, 14: 94.6,
    15: 94.9, 16: 95.2, 17: 95.5, 18: 95.8, 19: 96.1,
}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _t_to_frame(t: float) -> int:
    return int(t * REPLAY_FPS)


def _format_lap(t: float) -> str:
    m = int(t) // 60
    s = t % 60
    return f"{m}:{s:06.3f}"


def _build_race_positions(session_time: float) -> dict[int, dict]:
    """
    Simulate car states for all drivers at a given session time.
    Returns {car_idx: {"position", "lap", "lap_pct", "speed_ms", "best_lap_time"}}.
    """
    states = {}
    for car_idx, _, _, _, _ in DRIVERS:
        lap_time = BASE_LAP_TIMES[car_idx] + random.uniform(-0.3, 0.3)
        total_dist = session_time / lap_time           # laps completed (fractional)
        lap = min(int(total_dist), TOTAL_LAPS)
        lap_pct = total_dist - int(total_dist)
        speed_ms = random.uniform(30, 72) if lap < TOTAL_LAPS else 0.0
        best_lap = BASE_LAP_TIMES[car_idx] + random.uniform(-0.5, 0.1)
        states[car_idx] = {
            "lap": lap,
            "lap_pct": round(lap_pct, 4),
            "speed_ms": round(speed_ms, 2),
            "best_lap_time": round(best_lap, 3),
        }

    # Assign positions based on progress (lap + lap_pct)
    order = sorted(
        states.keys(),
        key=lambda i: (states[i]["lap"], states[i]["lap_pct"]),
        reverse=True,
    )
    for rank, car_idx in enumerate(order, 1):
        states[car_idx]["position"] = rank
        states[car_idx]["class_position"] = rank

    return states


# ── Main seed logic ───────────────────────────────────────────────────────────

def delete_existing_demo(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        "SELECT id, project_dir FROM projects WHERE name = ?",
        (DEMO_PROJECT_NAME,),
    ).fetchall()
    for row in rows:
        proj_dir = Path(row["project_dir"])
        if proj_dir.exists():
            import shutil
            shutil.rmtree(str(proj_dir), ignore_errors=True)
        conn.execute("DELETE FROM projects WHERE id = ?", (row["id"],))
    conn.commit()


def seed_project() -> dict:
    """Create project record + directories; return project dict."""
    init_db()
    conn = get_connection()
    delete_existing_demo(conn)
    conn.close()

    from server.services.project_service import project_service

    proj = project_service.create_project(
        name=DEMO_PROJECT_NAME,
        track_name=TRACK_NAME,
        session_type=SESSION_TYPE,
        num_drivers=NUM_DRIVERS,
        num_laps=TOTAL_LAPS,
    )
    print(f"  Created project #{proj['id']} at {proj['project_dir']}")
    return proj


def seed_telemetry(project_dir: str) -> dict[float, dict]:
    """Populate race_ticks, car_states, drivers, lap_completions."""
    init_analysis_db(project_dir)
    conn = get_project_db(project_dir)
    try:
        # Drivers
        conn.executemany(
            """INSERT OR REPLACE INTO drivers
               (car_idx, car_number, user_name, car_class_name, iracing_cust_id, is_spectator)
               VALUES (?, ?, ?, ?, ?, 0)""",
            [(c[0], c[1], c[2], c[3], c[4]) for c in DRIVERS],
        )

        # Race ticks & car states
        # Sample at TICKS_PER_SECOND over the full race duration
        dt = 1.0 / TICKS_PER_SECOND
        t = 0.0
        lap_logged: dict[int, set] = {i: set() for i in range(NUM_DRIVERS)}
        tick_cache: dict[float, dict] = {}

        while t <= RACE_DURATION_S + 1:
            cur_lap = int(t / (RACE_DURATION_S / TOTAL_LAPS))
            session_state = 4 if t > 5 else 3  # parade → racing
            checkered = 1 if t >= RACE_DURATION_S else 0
            cam_car_idx = random.choice([0, 1, 2, 3])

            tick_cur = conn.execute(
                """INSERT INTO race_ticks
                   (session_time, replay_frame, session_state, race_laps, cam_car_idx,
                    flags, flag_yellow, flag_red, flag_checkered)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (round(t, 2), _t_to_frame(t), session_state, cur_lap,
                 cam_car_idx, 0, 0, 0, checkered),
            )
            tick_id = tick_cur.lastrowid

            car_states = _build_race_positions(t)
            tick_cache[t] = {"tick_id": tick_id, "car_states": car_states}

            for car_idx, state in car_states.items():
                conn.execute(
                    """INSERT INTO car_states
                       (tick_id, car_idx, position, class_position, lap, lap_pct,
                        surface, est_time, best_lap_time, speed_ms)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        tick_id, car_idx, state["position"], state["class_position"],
                        state["lap"], state["lap_pct"],
                        3,  # on-track
                        round(BASE_LAP_TIMES[car_idx] * (1 - state["lap_pct"]), 2),
                        state["best_lap_time"],
                        state["speed_ms"],
                    ),
                )
                # Log lap completions
                if state["lap"] > 0 and state["lap"] not in lap_logged[car_idx]:
                    lap_logged[car_idx].add(state["lap"])
                    conn.execute(
                        "INSERT INTO lap_completions (tick_id, car_idx, lap_number, position) VALUES (?, ?, ?, ?)",
                        (tick_id, car_idx, state["lap"], state["position"]),
                    )

            t = round(t + dt, 3)

        # Analysis run metadata
        conn.execute(
            """INSERT INTO analysis_runs
               (started_at, completed_at, status, total_ticks, total_events, scan_duration)
               VALUES (?, ?, 'completed', ?, 0, ?)""",
            (
                datetime.now(timezone.utc).isoformat(),
                datetime.now(timezone.utc).isoformat(),
                int(RACE_DURATION_S),
                8.4,
            ),
        )
        conn.executemany(
            "INSERT OR REPLACE INTO analysis_meta (key, value) VALUES (?, ?)",
            [
                ("series_name", SERIES_NAME),
                ("track_name", TRACK_NAME),
                ("session_type", "race"),
                ("total_laps", str(TOTAL_LAPS)),
                ("race_duration", str(RACE_DURATION_S)),
                ("num_drivers", str(NUM_DRIVERS)),
                ("scan_speed", "16x"),
            ],
        )
        conn.commit()
        print(f"  Inserted {int(RACE_DURATION_S)} telemetry ticks for {NUM_DRIVERS} drivers")
        return tick_cache
    finally:
        conn.close()


def seed_events(project_dir: str) -> list[dict]:
    """Insert a realistic set of race events covering all event types."""
    conn = get_project_db(project_dir)
    try:
        events = [
            # ── Mandatory events ─────────────────────────────────────────────
            {
                "event_type": "first_lap",
                "start_time": 0.0,
                "end_time": 95.0,
                "start_frame": 0,
                "end_frame": _t_to_frame(95),
                "lap_number": 1,
                "severity": 8,
                "involved_drivers": list(range(20)),
                "position": 1,
                "metadata": {"note": "Formation lap & race start"},
            },
            {
                "event_type": "last_lap",
                "start_time": 2608.0,
                "end_time": 2700.0,
                "start_frame": _t_to_frame(2608),
                "end_frame": _t_to_frame(2700),
                "lap_number": TOTAL_LAPS,
                "severity": 9,
                "involved_drivers": [0, 1, 2],
                "position": 1,
                "metadata": {"note": "Final lap – race winner crosses line"},
            },
            # ── Leader changes ───────────────────────────────────────────────
            {
                "event_type": "leader_change",
                "start_time": 112.0,
                "end_time": 125.0,
                "start_frame": _t_to_frame(112),
                "end_frame": _t_to_frame(125),
                "lap_number": 2,
                "severity": 9,
                "involved_drivers": [2, 0],
                "position": 1,
                "metadata": {"new_leader": 2, "previous_leader": 0, "position_gain": 1},
            },
            {
                "event_type": "leader_change",
                "start_time": 890.0,
                "end_time": 905.0,
                "start_frame": _t_to_frame(890),
                "end_frame": _t_to_frame(905),
                "lap_number": 5,
                "severity": 8,
                "involved_drivers": [1, 2],
                "position": 1,
                "metadata": {"new_leader": 1, "previous_leader": 2, "position_gain": 1},
            },
            # ── Overtakes ────────────────────────────────────────────────────
            {
                "event_type": "overtake",
                "start_time": 245.0,
                "end_time": 262.0,
                "start_frame": _t_to_frame(245),
                "end_frame": _t_to_frame(262),
                "lap_number": 3,
                "severity": 7,
                "involved_drivers": [7, 4],
                "position": 5,
                "metadata": {"position_gain": 1, "overtaking_car": 7, "overtaken_car": 4},
            },
            {
                "event_type": "overtake",
                "start_time": 1345.0,
                "end_time": 1360.0,
                "start_frame": _t_to_frame(1345),
                "end_frame": _t_to_frame(1360),
                "lap_number": 8,
                "severity": 8,
                "involved_drivers": [3, 1],
                "position": 2,
                "metadata": {"position_gain": 1, "overtaking_car": 3, "overtaken_car": 1},
            },
            # ── Battles ──────────────────────────────────────────────────────
            {
                "event_type": "battle",
                "start_time": 480.0,
                "end_time": 508.0,
                "start_frame": _t_to_frame(480),
                "end_frame": _t_to_frame(508),
                "lap_number": 4,
                "severity": 7,
                "involved_drivers": [0, 3],
                "position": 3,
                "metadata": {"gap_seconds": 0.18, "duration_seconds": 28.0, "cars_involved": [0, 3]},
            },
            {
                "event_type": "battle",
                "start_time": 1680.0,
                "end_time": 1720.0,
                "start_frame": _t_to_frame(1680),
                "end_frame": _t_to_frame(1720),
                "lap_number": 10,
                "severity": 8,
                "involved_drivers": [1, 2, 7],
                "position": 1,
                "metadata": {"gap_seconds": 0.09, "duration_seconds": 40.0, "cars_involved": [1, 2, 7]},
            },
            # ── Crashes / Incidents ──────────────────────────────────────────
            {
                "event_type": "crash",
                "start_time": 620.0,
                "end_time": 648.0,
                "start_frame": _t_to_frame(620),
                "end_frame": _t_to_frame(648),
                "lap_number": 4,
                "severity": 9,
                "involved_drivers": [12],
                "position": 13,
                "metadata": {
                    "car_idx": 12, "speed_ms": 67.4,
                    "time_loss_seconds": 18.0, "off_track_duration": 4.2,
                },
            },
            {
                "event_type": "incident",
                "start_time": 1120.0,
                "end_time": 1136.0,
                "start_frame": _t_to_frame(1120),
                "end_frame": _t_to_frame(1136),
                "lap_number": 7,
                "severity": 6,
                "involved_drivers": [9, 10],
                "position": 9,
                "metadata": {"incident_type": "contact", "positions_lost": 2},
            },
            # ── Spinout ──────────────────────────────────────────────────────
            {
                "event_type": "spinout",
                "start_time": 1445.0,
                "end_time": 1462.0,
                "start_frame": _t_to_frame(1445),
                "end_frame": _t_to_frame(1462),
                "lap_number": 9,
                "severity": 7,
                "involved_drivers": [15],
                "position": 15,
                "metadata": {
                    "car_idx": 15, "time_loss_seconds": 8.5, "off_track_duration": 3.1,
                },
            },
            # ── Contact ──────────────────────────────────────────────────────
            {
                "event_type": "contact",
                "start_time": 340.0,
                "end_time": 355.0,
                "start_frame": _t_to_frame(340),
                "end_frame": _t_to_frame(355),
                "lap_number": 3,
                "severity": 5,
                "involved_drivers": [6, 8],
                "position": 7,
                "metadata": {"contact_type": "side-by-side", "time_window": 0.4},
            },
            # ── Close call ───────────────────────────────────────────────────
            {
                "event_type": "close_call",
                "start_time": 1850.0,
                "end_time": 1862.0,
                "start_frame": _t_to_frame(1850),
                "end_frame": _t_to_frame(1862),
                "lap_number": 11,
                "severity": 5,
                "involved_drivers": [4, 5],
                "position": 5,
                "metadata": {"proximity_seconds": 0.05, "max_off_track": 0.0},
            },
            # ── Pit stops ────────────────────────────────────────────────────
            {
                "event_type": "pit_stop",
                "start_time": 780.0,
                "end_time": 812.0,
                "start_frame": _t_to_frame(780),
                "end_frame": _t_to_frame(812),
                "lap_number": 5,
                "severity": 4,
                "involved_drivers": [2],
                "position": 1,
                "metadata": {"pit_duration_seconds": 32.0, "positions_lost": 2},
            },
            {
                "event_type": "pit_stop",
                "start_time": 1200.0,
                "end_time": 1228.0,
                "start_frame": _t_to_frame(1200),
                "end_frame": _t_to_frame(1228),
                "lap_number": 7,
                "severity": 3,
                "involved_drivers": [0],
                "position": 1,
                "metadata": {"pit_duration_seconds": 28.0, "positions_lost": 1},
            },
            # ── Fastest lap ──────────────────────────────────────────────────
            {
                "event_type": "fastest_lap",
                "start_time": 2150.0,
                "end_time": 2242.0,
                "start_frame": _t_to_frame(2150),
                "end_frame": _t_to_frame(2242),
                "lap_number": 13,
                "severity": 6,
                "involved_drivers": [2],
                "position": 1,
                "metadata": {"lap_time": 90.851, "previous_best": 91.012, "driver_name": "Max Verstappen"},
            },
        ]

        insert_events_batch(conn, events)
        conn.commit()

        # Update analysis_runs.total_events
        conn.execute(
            "UPDATE analysis_runs SET total_events = ? ORDER BY id DESC LIMIT 1",
            (len(events),),
        )
        conn.commit()
        print(f"  Inserted {len(events)} race events")
        return events
    finally:
        conn.close()


def seed_highlight_config(project_dir: str) -> None:
    """Save highlight weights and target duration."""
    from server.services.analysis_db import save_highlight_config
    conn = get_project_db(project_dir)
    try:
        save_highlight_config(
            conn,
            weights={
                "crash": 95,
                "incident": 80,
                "spinout": 75,
                "leader_change": 90,
                "overtake": 85,
                "battle": 70,
                "fastest_lap": 60,
                "contact": 55,
                "close_call": 45,
                "pit_stop": 30,
                "first_lap": 100,
                "last_lap": 100,
            },
            target_duration=420.0,   # 7-minute highlight reel
            min_severity=3,
            overrides={},
            params={
                "pip_threshold": 7.0,
                "broll_gap_threshold": 8.0,
                "max_consecutive_same_driver": 3,
            },
        )
        print("  Saved highlight configuration")
    finally:
        conn.close()


def build_highlight_script(project_dir: str, events: list[dict]) -> dict:
    """
    Build a highlight script JSON and write it to the project directory.
    Also returns the dict for inspection.
    """
    # Simple ordered timeline from the events
    race_events_sorted = sorted(
        [e for e in events if e["event_type"] not in ("first_lap", "last_lap", "pit_stop")],
        key=lambda e: e["start_time"],
    )

    # Score events (simplified)
    BASE = {
        "crash": 1.5, "incident": 1.5, "battle": 1.3, "spinout": 1.2,
        "leader_change": 0.9, "overtake": 1.0, "fastest_lap": 0.7,
        "contact": 1.2, "close_call": 0.8, "pit_stop": 0.5,
        "first_lap": 10.0, "last_lap": 10.0,
    }

    def _tier(score: float) -> str:
        if score >= 9.0:
            return "S"
        if score >= 7.0:
            return "A"
        if score >= 5.0:
            return "B"
        return "C"

    driver_name_map = {c[0]: c[2] for c in DRIVERS}

    segments = []

    # Intro section
    first_lap = next((e for e in events if e["event_type"] == "first_lap"), None)
    if first_lap:
        segments.append({
            "segment_id": "intro_001",
            "section": "intro",
            "segment_type": "event",
            "event_type": "first_lap",
            "start_time": 0.0,
            "end_time": 95.0,
            "duration": 95.0,
            "start_frame": 0,
            "end_frame": _t_to_frame(95),
            "camera_mode": "auto",
            "focused_car_idx": 2,
            "overlay_template_id": "cinematic",
            "transition": {"type": "fade", "duration_frames": 30},
            "score": 10.0,
            "tier": "S",
            "driver_names": ["Full Grid"],
        })

    # Race segments
    for i, ev in enumerate(race_events_sorted):
        score = BASE.get(ev["event_type"], 1.0) * (0.5 + ev["severity"] * 0.1) * 5
        score = round(min(score, 10.0), 2)
        d_names = [driver_name_map.get(di, f"Car #{di}") for di in ev["involved_drivers"][:3]]
        segments.append({
            "segment_id": f"race_{i+1:03d}",
            "section": "race",
            "segment_type": "event",
            "event_type": ev["event_type"],
            "start_time": ev["start_time"],
            "end_time": ev["end_time"],
            "duration": round(ev["end_time"] - ev["start_time"], 2),
            "start_frame": ev["start_frame"],
            "end_frame": ev["end_frame"],
            "lap_number": ev.get("lap_number"),
            "camera_mode": "auto",
            "focused_car_idx": ev["involved_drivers"][0] if ev["involved_drivers"] else 0,
            "overlay_template_id": "broadcast",
            "transition": {"type": "cut"},
            "score": score,
            "tier": _tier(score),
            "driver_names": d_names,
            "metadata": ev.get("metadata", {}),
        })

    # Last-lap section
    last_lap = next((e for e in events if e["event_type"] == "last_lap"), None)
    if last_lap:
        segments.append({
            "segment_id": "outro_001",
            "section": "race_results",
            "segment_type": "event",
            "event_type": "last_lap",
            "start_time": 2608.0,
            "end_time": 2700.0,
            "duration": 92.0,
            "start_frame": _t_to_frame(2608),
            "end_frame": _t_to_frame(2700),
            "camera_mode": "auto",
            "focused_car_idx": 1,
            "overlay_template_id": "broadcast",
            "transition": {"type": "fade", "duration_frames": 60},
            "score": 10.0,
            "tier": "S",
            "driver_names": ["Lewis Hamilton", "Max Verstappen", "Charles Leclerc"],
        })

    script = {
        "version": "1.0.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "project": {
            "name": DEMO_PROJECT_NAME,
            "track_name": TRACK_NAME,
            "series_name": SERIES_NAME,
            "session_type": SESSION_TYPE,
            "total_laps": TOTAL_LAPS,
            "race_duration_seconds": RACE_DURATION_S,
            "num_drivers": NUM_DRIVERS,
        },
        "summary": {
            "total_events": len(events),
            "segments_in_script": len(segments),
            "estimated_duration_seconds": sum(s["duration"] for s in segments),
            "target_duration_seconds": 420.0,
            "tier_breakdown": {
                "S": sum(1 for s in segments if s["tier"] == "S"),
                "A": sum(1 for s in segments if s["tier"] == "A"),
                "B": sum(1 for s in segments if s["tier"] == "B"),
                "C": sum(1 for s in segments if s["tier"] == "C"),
            },
        },
        "render": {
            "resolution": "1920x1080",
            "fps": 60,
            "codec": "h264",
            "bitrate_mbps": 12.0,
            "overlay_template_id": "broadcast",
        },
        "segments": segments,
    }

    out_path = Path(project_dir) / "highlight_script.json"
    out_path.write_text(json.dumps(script, indent=2), encoding="utf-8")
    print(f"  Written highlight script → {out_path.name}  ({len(segments)} segments)")
    return script


def seed_overlay_frame_data(project_dir: str) -> None:
    """Write sample overlay frame-data JSON to the project overlays directory."""
    frame_data = {
        "section": "race",
        "series_name": SERIES_NAME,
        "track_name": TRACK_NAME,
        "current_lap": 8,
        "total_laps": TOTAL_LAPS,
        "session_time": "00:26:15",
        "driver_name": "Lewis Hamilton",
        "car_name": "BMW M4 GT3",
        "car_number": "44",
        "position": 1,
        "class_position": 1,
        "irating": 7421,
        "team_color": "#00D2BE",
        "last_lap_time": _format_lap(91.234),
        "best_lap_time": _format_lap(90.987),
        "flag": "green",
        "incident_count": 0,
        "speed_kmh": 241,
        "gap_to_leader": "Leader",
        "gap_to_ahead": "Leader",
        "gap_to_behind": "+0.342",
        "standings": [
            {"position": 1, "car_number": "44",  "driver_name": "L. Hamilton",  "gap": "Leader",  "is_player": True,  "best_lap": "1:30.987"},
            {"position": 2, "car_number": "1",   "driver_name": "M. Verstappen","gap": "+0.342",  "is_player": False, "best_lap": "1:31.012"},
            {"position": 3, "car_number": "16",  "driver_name": "C. Leclerc",   "gap": "+1.891",  "is_player": False, "best_lap": "1:31.234"},
            {"position": 4, "car_number": "63",  "driver_name": "G. Russell",   "gap": "+3.456",  "is_player": False, "best_lap": "1:31.567"},
            {"position": 5, "car_number": "4",   "driver_name": "L. Norris",    "gap": "+5.123",  "is_player": False, "best_lap": "1:31.789"},
            {"position": 6, "car_number": "55",  "driver_name": "C. Sainz",     "gap": "+6.789",  "is_player": False, "best_lap": "1:32.001"},
            {"position": 7, "car_number": "14",  "driver_name": "F. Alonso",    "gap": "+8.234",  "is_player": False, "best_lap": "1:32.345"},
            {"position": 8, "car_number": "81",  "driver_name": "O. Piastri",   "gap": "+9.876",  "is_player": False, "best_lap": "1:32.567"},
        ],
    }

    out_path = Path(project_dir) / "overlays" / "sample_frame_data.json"
    out_path.write_text(json.dumps(frame_data, indent=2), encoding="utf-8")
    print(f"  Written sample overlay frame data → overlays/sample_frame_data.json")


def seed_pipeline_preset(project_dir: str) -> None:
    """Write a pipeline preset JSON to the project directory."""
    preset = {
        "id": "demo_preset",
        "name": "Demo Race Preset",
        "description": "Standard GT3 race highlight pipeline",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "steps": {
            "analysis": {"enabled": True, "force_rescan": False},
            "editing": {
                "enabled": True,
                "target_duration": 420,
                "min_severity": 3,
                "weights": {
                    "crash": 95, "leader_change": 90, "overtake": 85,
                    "incident": 80, "spinout": 75, "battle": 70,
                    "fastest_lap": 60, "contact": 55, "close_call": 45,
                    "pit_stop": 30,
                },
            },
            "capture": {
                "enabled": True,
                "software": "obs",
                "resolution": "1920x1080",
                "fps": 60,
            },
            "export": {
                "enabled": True,
                "codec": "h264",
                "bitrate_mbps": 12,
                "resolution": "1920x1080",
                "fps": 60,
                "overlay_template": "broadcast",
            },
            "upload": {
                "enabled": False,
                "privacy": "unlisted",
            },
        },
    }

    out_path = Path(project_dir) / "pipeline_preset.json"
    out_path.write_text(json.dumps(preset, indent=2), encoding="utf-8")
    print(f"  Written pipeline preset → pipeline_preset.json")


def configure_app_for_demo() -> None:
    """Mark wizard as completed so the UI goes straight to the project library."""
    config = load_config()
    config["wizard_completed"] = True
    config["theme"] = "dark"
    save_config(config)
    print("  Marked wizard_completed = True in config.json")


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    print("\n=== League Replay Studio — Demo Data Seeder ===\n")

    print("1. Configuring app settings…")
    configure_app_for_demo()

    print("2. Creating demo project…")
    proj = seed_project()
    project_dir = proj["project_dir"]
    project_id = proj["id"]

    print("3. Seeding telemetry data…")
    seed_telemetry(project_dir)

    print("4. Seeding race events…")
    events = seed_events(project_dir)

    print("5. Saving highlight configuration…")
    seed_highlight_config(project_dir)

    print("6. Building highlight script…")
    build_highlight_script(project_dir, events)

    print("7. Writing overlay frame data…")
    seed_overlay_frame_data(project_dir)

    print("8. Writing pipeline preset…")
    seed_pipeline_preset(project_dir)

    print(f"\n✅ Demo project ready!")
    print(f"   Project ID : {project_id}")
    print(f"   Project dir: {project_dir}")
    print(f"   Events     : {len(events)}")
    print(f"   Server URL : http://127.0.0.1:6175\n")


if __name__ == "__main__":
    main()
