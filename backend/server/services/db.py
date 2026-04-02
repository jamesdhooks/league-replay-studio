"""
db.py
-----
Lightweight SQLite helper for the global project registry database.

Provides connection management and common query patterns for the
application-level SQLite database (data/projects.db) that stores
the project registry (list of projects with metadata).

Note: Each project also has its own SQLite database (project.db) inside
its project directory for event data, telemetry, etc.
"""

import logging
import sqlite3
from pathlib import Path
from typing import Any, Optional

from server.config import DATA_DIR

logger = logging.getLogger(__name__)

DB_PATH = DATA_DIR / "projects.db"


def get_connection() -> sqlite3.Connection:
    """Return a connection to the global projects database.

    Uses WAL mode for concurrent read support and returns rows as
    sqlite3.Row objects for dict-like access.
    """
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    """Create the project registry table if it doesn't exist."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = get_connection()
    try:
        conn.executescript(_SCHEMA_SQL)
        conn.commit()
        logger.info("[DB] Project registry database initialised at %s", DB_PATH)
    finally:
        conn.close()


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS projects (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    track_name      TEXT    DEFAULT '',
    session_type    TEXT    DEFAULT '',
    num_drivers     INTEGER DEFAULT 0,
    num_laps        INTEGER DEFAULT 0,
    replay_file     TEXT    DEFAULT '',
    project_dir     TEXT    NOT NULL,
    current_step    TEXT    NOT NULL DEFAULT 'analysis',
    version         TEXT    DEFAULT '1.0.0'
);
"""


def row_to_dict(row: sqlite3.Row) -> dict:
    """Convert a sqlite3.Row to a plain dict."""
    return dict(row)
