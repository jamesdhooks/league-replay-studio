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
    flags           INTEGER NOT NULL DEFAULT 0
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
    best_lap_time   REAL    NOT NULL DEFAULT -1.0
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
        conn.commit()
        logger.info("[AnalysisDB] Initialised project database at %s", project_dir)
    finally:
        conn.close()


# ── Query helpers ────────────────────────────────────────────────────────────

def clear_analysis_data(conn: sqlite3.Connection) -> None:
    """Delete all analysis data to prepare for a fresh scan."""
    conn.execute("DELETE FROM car_states")
    conn.execute("DELETE FROM race_ticks")
    conn.execute("DELETE FROM race_events")
    conn.execute("DELETE FROM lap_completions")
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
    """Get the most recent analysis run status."""
    row = conn.execute(
        "SELECT * FROM analysis_runs ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if not row:
        return {"status": "none", "total_ticks": 0, "total_events": 0}
    return dict(row)
