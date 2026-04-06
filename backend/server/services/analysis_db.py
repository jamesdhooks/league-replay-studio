"""
analysis_db.py
--------------
Per-project SQLite schema and helpers for the replay analysis engine.

Creates normalised tables for telemetry snapshots (race_ticks, car_states),
detected race events, lap completions, and driver metadata.  Used by the
ReplayAnalyzer and all event detector classes.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


# ── Schema ───────────────────────────────────────────────────────────────────

_ANALYSIS_SCHEMA = """
-- Telemetry snapshots (one row per sample taken during 16× scan)
CREATE TABLE IF NOT EXISTS race_ticks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_time    REAL    NOT NULL,
    replay_frame    INTEGER NOT NULL,
    session_state   INTEGER NOT NULL DEFAULT 0,
    race_laps       INTEGER NOT NULL DEFAULT 0,
    cam_car_idx     INTEGER NOT NULL DEFAULT 0,
    flags           INTEGER NOT NULL DEFAULT 0,
    flag_yellow     INTEGER NOT NULL DEFAULT 0,
    flag_red        INTEGER NOT NULL DEFAULT 0,
    flag_checkered  INTEGER NOT NULL DEFAULT 0
);

-- Per-car state (N rows per race_tick, one per active car)
CREATE TABLE IF NOT EXISTS car_states (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tick_id         INTEGER NOT NULL REFERENCES race_ticks(id),
    car_idx         INTEGER NOT NULL,
    position        INTEGER NOT NULL DEFAULT 0,
    class_position  INTEGER NOT NULL DEFAULT 0,
    lap             INTEGER NOT NULL DEFAULT 0,
    lap_pct         REAL    NOT NULL DEFAULT 0.0,
    surface         INTEGER NOT NULL DEFAULT 0,
    est_time        REAL    NOT NULL DEFAULT 0.0,
    best_lap_time   REAL    NOT NULL DEFAULT -1.0,
    speed_ms        REAL    DEFAULT NULL
);

-- Detected race events
CREATE TABLE IF NOT EXISTS race_events (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type              TEXT    NOT NULL,
    start_time_seconds      REAL    NOT NULL,
    end_time_seconds        REAL    NOT NULL,
    start_frame             INTEGER NOT NULL DEFAULT 0,
    end_frame               INTEGER NOT NULL DEFAULT 0,
    lap_number              INTEGER,
    severity                INTEGER NOT NULL DEFAULT 0,
    involved_drivers        TEXT    NOT NULL DEFAULT '[]',
    position                INTEGER,
    auto_detected           INTEGER NOT NULL DEFAULT 1,
    user_modified           INTEGER NOT NULL DEFAULT 0,
    included_in_highlight   INTEGER NOT NULL DEFAULT 1,
    metadata                TEXT    NOT NULL DEFAULT '{}'
);

-- Lap completion markers
CREATE TABLE IF NOT EXISTS lap_completions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tick_id         INTEGER NOT NULL REFERENCES race_ticks(id),
    car_idx         INTEGER NOT NULL,
    lap_number      INTEGER NOT NULL,
    position        INTEGER NOT NULL DEFAULT 0
);

-- Driver info (from session data)
CREATE TABLE IF NOT EXISTS drivers (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    car_idx                 INTEGER NOT NULL UNIQUE,
    car_number              TEXT    NOT NULL DEFAULT '',
    user_name               TEXT    NOT NULL DEFAULT '',
    car_class_name          TEXT    NOT NULL DEFAULT '',
    iracing_cust_id         INTEGER NOT NULL DEFAULT 0,
    is_spectator            INTEGER NOT NULL DEFAULT 0
);

-- Analysis run metadata
CREATE TABLE IF NOT EXISTS analysis_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      TEXT    NOT NULL,
    completed_at    TEXT,
    status          TEXT    NOT NULL DEFAULT 'running',
    total_ticks     INTEGER NOT NULL DEFAULT 0,
    total_events    INTEGER NOT NULL DEFAULT 0,
    scan_duration   REAL    NOT NULL DEFAULT 0.0,
    error_message   TEXT
);

-- Key-value metadata for the analysis run
CREATE TABLE IF NOT EXISTS analysis_meta (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL
);

-- Highlight configuration (one active row per project)
CREATE TABLE IF NOT EXISTS highlight_config (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    weights         TEXT    NOT NULL DEFAULT '{}',
    target_duration REAL,
    min_severity    INTEGER NOT NULL DEFAULT 0,
    overrides       TEXT    NOT NULL DEFAULT '{}',
    params          TEXT    NOT NULL DEFAULT '{}',
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_car_states_tick ON car_states(tick_id);
CREATE INDEX IF NOT EXISTS idx_car_states_car  ON car_states(car_idx);
CREATE INDEX IF NOT EXISTS idx_car_states_pos  ON car_states(position);
CREATE INDEX IF NOT EXISTS idx_race_ticks_time ON race_ticks(session_time);
CREATE INDEX IF NOT EXISTS idx_race_events_type ON race_events(event_type);
CREATE INDEX IF NOT EXISTS idx_lap_completions_car ON lap_completions(car_idx, lap_number);
"""


# ── Connection helper ────────────────────────────────────────────────────────

def get_project_db(project_dir: str) -> sqlite3.Connection:
    """Open (or create) the per-project analysis database.

    Returns a WAL-mode connection with Row factory.
    """
    db_path = Path(project_dir) / "project.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_analysis_db(project_dir: str) -> None:
    """Create all analysis tables and indexes if they don't exist."""
    conn = get_project_db(project_dir)
    try:
        conn.executescript(_ANALYSIS_SCHEMA)
        # Migration: add params column to highlight_config if missing
        cols = [r[1] for r in conn.execute("PRAGMA table_info(highlight_config)").fetchall()]
        if "params" not in cols:
            conn.execute("ALTER TABLE highlight_config ADD COLUMN params TEXT NOT NULL DEFAULT '{}'")

        # Migration: add speed_ms column to car_states if missing (older DBs)
        cs_cols = [r[1] for r in conn.execute("PRAGMA table_info(car_states)").fetchall()]
        if "speed_ms" not in cs_cols:
            try:
                conn.execute("ALTER TABLE car_states ADD COLUMN speed_ms REAL DEFAULT NULL")
            except sqlite3.OperationalError as exc:
                logger.debug("car_states migration skip speed_ms: %s", exc)

        # Migration: add new race_ticks columns if missing
        rt_cols = [r[1] for r in conn.execute("PRAGMA table_info(race_ticks)").fetchall()]
        for col, ddl in [
            ("flag_yellow",    "INTEGER NOT NULL DEFAULT 0"),
            ("flag_red",       "INTEGER NOT NULL DEFAULT 0"),
            ("flag_checkered", "INTEGER NOT NULL DEFAULT 0"),
        ]:
            if col not in rt_cols:
                try:
                    conn.execute(f"ALTER TABLE race_ticks ADD COLUMN {col} {ddl}")
                except sqlite3.OperationalError as exc:
                    logger.debug("race_ticks migration skip %s: %s", col, exc)

        conn.commit()
        logger.info("[AnalysisDB] Initialised project database at %s", project_dir)
    finally:
        conn.close()


# ── Query helpers ────────────────────────────────────────────────────────────

def clear_analysis_data(conn: sqlite3.Connection) -> None:
    """Delete all analysis data to prepare for a fresh scan."""
    # Delete child tables before parents to satisfy FK constraints
    conn.execute("DELETE FROM car_states")
    conn.execute("DELETE FROM lap_completions")
    conn.execute("DELETE FROM race_ticks")
    conn.execute("DELETE FROM race_events")
    conn.execute("DELETE FROM drivers")
    conn.commit()
    logger.info("[AnalysisDB] Cleared previous analysis data")


def insert_event(
    conn: sqlite3.Connection,
    event_type: str,
    start_time: float,
    end_time: float,
    start_frame: int = 0,
    end_frame: int = 0,
    lap_number: int | None = None,
    severity: int = 0,
    involved_drivers: list[int] | None = None,
    position: int | None = None,
    metadata: dict | None = None,
) -> int:
    """Insert a single race event and return its ID."""
    cursor = conn.execute(
        """INSERT INTO race_events
           (event_type, start_time_seconds, end_time_seconds, start_frame, end_frame,
            lap_number, severity, involved_drivers, position, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            event_type,
            start_time,
            end_time,
            start_frame,
            end_frame,
            lap_number,
            max(0, min(10, severity)),  # Clamp to 0–10
            json.dumps(involved_drivers or []),
            position,
            json.dumps(metadata or {}),
        ),
    )
    return cursor.lastrowid  # type: ignore[return-value]


def insert_events_batch(
    conn: sqlite3.Connection,
    events: list[dict],
) -> int:
    """Insert multiple race events in a single batch. Returns count inserted."""
    if not events:
        return 0
    rows = [
        (
            e["event_type"],
            e["start_time"],
            e["end_time"],
            e.get("start_frame", 0),
            e.get("end_frame", 0),
            e.get("lap_number"),
            max(0, min(10, e.get("severity", 0))),
            json.dumps(e.get("involved_drivers", [])),
            e.get("position"),
            json.dumps(e.get("metadata", {})),
        )
        for e in events
    ]
    conn.executemany(
        """INSERT INTO race_events
           (event_type, start_time_seconds, end_time_seconds, start_frame, end_frame,
            lap_number, severity, involved_drivers, position, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        rows,
    )
    return len(rows)


def get_events(
    conn: sqlite3.Connection,
    event_type: str = "",
    min_severity: int = 0,
    skip: int = 0,
    limit: int = 200,
) -> list[dict]:
    """Fetch race events with optional filters."""
    query = "SELECT * FROM race_events WHERE 1=1"
    params: list[Any] = []

    if event_type:
        query += " AND event_type = ?"
        params.append(event_type)
    if min_severity > 0:
        query += " AND severity >= ?"
        params.append(min_severity)

    query += " ORDER BY start_time_seconds ASC LIMIT ? OFFSET ?"
    params.extend([limit, skip])

    rows = conn.execute(query, params).fetchall()

    # Build a car_idx → driver_name lookup from the drivers table
    driver_rows = conn.execute(
        "SELECT car_idx, user_name, car_number FROM drivers WHERE is_spectator = 0"
    ).fetchall()
    driver_map = {r["car_idx"]: r["user_name"] for r in driver_rows}
    car_number_map = {r["car_idx"]: r["car_number"] for r in driver_rows}

    result = []
    for r in rows:
        d = dict(r)
        # Parse JSON fields
        try:
            d["involved_drivers"] = json.loads(d.get("involved_drivers", "[]"))
        except (json.JSONDecodeError, TypeError):
            d["involved_drivers"] = []
        try:
            d["metadata"] = json.loads(d.get("metadata", "{}"))
        except (json.JSONDecodeError, TypeError):
            d["metadata"] = {}
        # Resolve car indices to driver names
        d["driver_names"] = [
            driver_map.get(idx, f"Car #{car_number_map.get(idx, idx)}")
            for idx in d["involved_drivers"]
        ]
        result.append(d)
    return result


def count_events(conn: sqlite3.Connection, event_type: str = "") -> int:
    """Count race events, optionally filtered by type."""
    if event_type:
        row = conn.execute(
            "SELECT COUNT(*) FROM race_events WHERE event_type = ?",
            (event_type,),
        ).fetchone()
    else:
        row = conn.execute("SELECT COUNT(*) FROM race_events").fetchone()
    return row[0] if row else 0


def get_analysis_status(conn: sqlite3.Connection) -> dict:
    """Get the most recent analysis run status, augmented with live counts."""
    row = conn.execute(
        "SELECT * FROM analysis_runs ORDER BY id DESC LIMIT 1"
    ).fetchone()

    tick_count = conn.execute("SELECT COUNT(*) FROM race_ticks").fetchone()[0]
    event_count = conn.execute("SELECT COUNT(*) FROM race_events").fetchone()[0]

    page_count = conn.execute("PRAGMA page_count").fetchone()[0]
    page_size = conn.execute("PRAGMA page_size").fetchone()[0]
    db_size_bytes = page_count * page_size

    if not row:
        return {
            "status": "none",
            "total_ticks": tick_count,
            "total_events": event_count,
            "has_telemetry": tick_count > 0,
            "has_events": event_count > 0,
            "db_size_bytes": db_size_bytes,
        }

    d = dict(row)
    d["has_telemetry"] = tick_count > 0
    d["has_events"] = event_count > 0
    d["total_ticks"] = tick_count
    d["total_events"] = event_count
    d["db_size_bytes"] = db_size_bytes
    return d


def save_tuning_params(conn: sqlite3.Connection, params: dict) -> None:
    """Persist detection tuning parameters to analysis_meta."""
    conn.execute(
        "INSERT OR REPLACE INTO analysis_meta (key, value) VALUES (?, ?)",
        ("tuning_params", json.dumps(params)),
    )
    conn.commit()


def load_tuning_params(conn: sqlite3.Connection) -> dict | None:
    """Load saved detection tuning parameters from analysis_meta. Returns None if not saved."""
    row = conn.execute(
        "SELECT value FROM analysis_meta WHERE key = 'tuning_params'"
    ).fetchone()
    if not row:
        return None
    try:
        return json.loads(row[0])
    except (json.JSONDecodeError, TypeError):
        return None


# ── Highlight config helpers ─────────────────────────────────────────────────

_DEFAULT_WEIGHTS = {
    "incident": 80,
    "battle": 60,
    "overtake": 70,
    "pit_stop": 20,
    "fastest_lap": 50,
    "leader_change": 90,
    "first_lap": 100,
    "last_lap": 100,
}


def get_highlight_config(conn: sqlite3.Connection) -> dict:
    """Get the current highlight configuration for this project.

    Returns default values if no config has been saved yet.
    """
    row = conn.execute(
        "SELECT * FROM highlight_config ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if not row:
        return {
            "weights": dict(_DEFAULT_WEIGHTS),
            "target_duration": None,
            "min_severity": 0,
            "overrides": {},
            "params": {},
        }
    d = dict(row)
    try:
        d["weights"] = json.loads(d.get("weights", "{}"))
    except (json.JSONDecodeError, TypeError):
        d["weights"] = dict(_DEFAULT_WEIGHTS)
    try:
        d["overrides"] = json.loads(d.get("overrides", "{}"))
    except (json.JSONDecodeError, TypeError):
        d["overrides"] = {}
    try:
        d["params"] = json.loads(d.get("params", "{}"))
    except (json.JSONDecodeError, TypeError):
        d["params"] = {}
    return d


def save_highlight_config(
    conn: sqlite3.Connection,
    weights: dict,
    target_duration: float | None = None,
    min_severity: int = 0,
    overrides: dict | None = None,
    params: dict | None = None,
) -> dict:
    """Save (upsert) the highlight configuration for this project.

    Always replaces the single config row with the new values.
    """
    conn.execute("DELETE FROM highlight_config")
    conn.execute(
        """INSERT INTO highlight_config (weights, target_duration, min_severity, overrides, params)
           VALUES (?, ?, ?, ?, ?)""",
        (
            json.dumps(weights),
            target_duration,
            max(0, min(10, min_severity)),
            json.dumps(overrides or {}),
            json.dumps(params or {}),
        ),
    )
    conn.commit()
    return get_highlight_config(conn)


def batch_update_highlight_flags(
    conn: sqlite3.Connection,
    included_ids: list[int],
    excluded_ids: list[int],
) -> int:
    """Batch-update the included_in_highlight flag for events.

    Sets included=1 for included_ids, included=0 for excluded_ids.
    Returns total number of rows updated.
    """
    count = 0
    if included_ids:
        placeholders = ",".join("?" for _ in included_ids)
        cur = conn.execute(
            f"UPDATE race_events SET included_in_highlight = 1 WHERE id IN ({placeholders})",
            included_ids,
        )
        count += cur.rowcount
    if excluded_ids:
        placeholders = ",".join("?" for _ in excluded_ids)
        cur = conn.execute(
            f"UPDATE race_events SET included_in_highlight = 0 WHERE id IN ({placeholders})",
            excluded_ids,
        )
        count += cur.rowcount
    conn.commit()
    return count


def get_drivers(conn: sqlite3.Connection) -> list[dict]:
    """Get all drivers for the project."""
    rows = conn.execute(
        "SELECT * FROM drivers WHERE is_spectator = 0 ORDER BY car_idx"
    ).fetchall()
    return [dict(r) for r in rows]
