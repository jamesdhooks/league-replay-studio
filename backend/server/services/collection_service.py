"""
collection_service.py
---------------------
Live iRacing telemetry collection — captures ALL SDK variables to a
SQLite file in data/collections/.

Each collection run is one .db file.  The file is fully self-contained
and can be opened later with the TelemetryExplorer in the frontend.

Schema
------
  info       — key/value metadata (track, car, session type, timestamps …)
  catalog    — one row per variable: name, type, unit, desc, count
  ticks      — id, wall_time, session_time, session_state, replay_frame,
               data_json (JSON blob of every variable's value for that tick)

Collection is driven by a background thread that calls
``bridge.capture_all_vars()`` at the configured sample rate (default 4 Hz).
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from server.config import COLLECTIONS_DIR

logger = logging.getLogger(__name__)

# Default poll rate — 4 Hz keeps file sizes manageable while giving good
# temporal resolution for analysis.  The user can override via start().
DEFAULT_HZ = 4


class CollectionService:
    """Manages a single active telemetry collection session."""

    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._active_path: Path | None = None
        self._active_name: str | None = None
        self._tick_count: int = 0
        self._started_at: float | None = None
        self._catalog_written: bool = False
        self._lock = threading.Lock()

    # ── Public API ────────────────────────────────────────────────────────────

    @property
    def is_collecting(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def status(self) -> dict:
        """Return current collection status dict."""
        elapsed = (time.time() - self._started_at) if self._started_at else 0.0
        return {
            "collecting":   self.is_collecting,
            "name":         self._active_name,
            "path":         str(self._active_path) if self._active_path else None,
            "filename":     self._active_path.name if self._active_path else None,
            "tick_count":   self._tick_count,
            "elapsed_s":    round(elapsed, 1),
        }

    def start(self, name: str | None = None, hz: int = DEFAULT_HZ) -> dict:
        """Start a new collection session.

        Parameters
        ----------
        name : str, optional
            Human-readable label embedded in the metadata and filename.
        hz   : int
            Sample rate in Hz (1–60).  Default 4.

        Returns the status dict.
        """
        if self.is_collecting:
            return {"error": "Already collecting", **self.status()}

        hz = max(1, min(hz, 60))
        COLLECTIONS_DIR.mkdir(parents=True, exist_ok=True)

        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        slug = f"_{name}" if name else ""
        filename = f"collection{slug}_{ts}.db"
        path = COLLECTIONS_DIR / filename

        self._active_path   = path
        self._active_name    = name or f"Collection {ts}"
        self._tick_count     = 0
        self._started_at     = time.time()
        self._catalog_written = False
        self._stop_event.clear()

        self._thread = threading.Thread(
            target=self._collect_loop,
            args=(path, hz),
            daemon=True,
            name="telemetry-collect",
        )
        self._thread.start()
        logger.info("[Collection] Started → %s at %d Hz", filename, hz)
        return self.status()

    def stop(self) -> dict:
        """Stop the active collection session."""
        if not self.is_collecting:
            return {"error": "Not collecting", **self.status()}

        self._stop_event.set()
        self._thread.join(timeout=10)
        self._thread = None

        # Write ended_at into info table
        if self._active_path and self._active_path.exists():
            try:
                conn = sqlite3.connect(str(self._active_path))
                conn.execute("INSERT OR REPLACE INTO info VALUES (?, ?)",
                             ("ended_at", datetime.now(timezone.utc).isoformat()))
                conn.execute("INSERT OR REPLACE INTO info VALUES (?, ?)",
                             ("total_ticks", str(self._tick_count)))
                conn.commit()
                conn.close()
            except Exception as exc:
                logger.warning("[Collection] Could not write ended_at: %s", exc)

        logger.info("[Collection] Stopped — %d ticks written to %s",
                    self._tick_count, self._active_path)
        status = self.status()
        return status

    # ── File browser helpers ──────────────────────────────────────────────────

    def list_collections(self) -> list[dict]:
        """Return a list of all saved collection files, newest first."""
        COLLECTIONS_DIR.mkdir(parents=True, exist_ok=True)
        result = []
        for db_path in sorted(COLLECTIONS_DIR.glob("*.db"), reverse=True):
            info = self._quick_info(db_path)
            result.append(info)
        return result

    def get_collection_info(self, filename: str) -> dict | None:
        """Return metadata for a specific collection file."""
        path = self._resolve(filename)
        if path is None:
            return None
        return self._quick_info(path)

    def get_catalog(self, filename: str) -> list[dict] | None:
        """Return the variable catalog for a collection file."""
        path = self._resolve(filename)
        if path is None:
            return None
        try:
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT name, var_type, unit, desc, count FROM catalog ORDER BY name"
            ).fetchall()
            conn.close()
            return [dict(r) for r in rows]
        except Exception as exc:
            logger.warning("[Collection] get_catalog error: %s", exc)
            return []

    def get_ticks(
        self,
        filename: str,
        offset: int = 0,
        limit: int = 200,
        vars: list[str] | None = None,
    ) -> dict | None:
        """Return paginated tick data for a collection file.

        If ``vars`` is provided, only those keys are included in each tick's
        data payload (parsed from the JSON blob).  Otherwise the full blob
        is returned as a dict.

        Returns {total, offset, ticks: [{id, wall_time, session_time,
                 session_state, replay_frame, data}]}
        """
        path = self._resolve(filename)
        if path is None:
            return None
        try:
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            conn.row_factory = sqlite3.Row

            total = conn.execute("SELECT COUNT(*) FROM ticks").fetchone()[0]
            rows = conn.execute(
                """SELECT id, wall_time, session_time, session_state,
                          replay_frame, data_json
                   FROM ticks ORDER BY id LIMIT ? OFFSET ?""",
                (limit, offset),
            ).fetchall()
            conn.close()

            ticks = []
            for row in rows:
                raw = row["data_json"]
                if raw:
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        data = {}
                else:
                    data = {}

                if vars:
                    data = {k: data.get(k) for k in vars}

                ticks.append({
                    "id":            row["id"],
                    "wall_time":     row["wall_time"],
                    "session_time":  row["session_time"],
                    "session_state": row["session_state"],
                    "replay_frame":  row["replay_frame"],
                    "data":          data,
                })

            return {"total": total, "offset": offset, "ticks": ticks}
        except Exception as exc:
            logger.warning("[Collection] get_ticks error: %s", exc)
            return None

    def delete_collection(self, filename: str) -> bool:
        """Delete a collection file.  Returns True on success."""
        path = self._resolve(filename)
        if path is None:
            return False
        try:
            path.unlink()
            logger.info("[Collection] Deleted %s", filename)
            return True
        except Exception as exc:
            logger.warning("[Collection] Delete error: %s", exc)
            return False

    # ── Internal ──────────────────────────────────────────────────────────────

    def _resolve(self, filename: str) -> Path | None:
        """Resolve a bare filename to an absolute path inside COLLECTIONS_DIR."""
        # Reject any path traversal attempts
        path = (COLLECTIONS_DIR / filename).resolve()
        if not str(path).startswith(str(COLLECTIONS_DIR.resolve())):
            logger.warning("[Collection] Path traversal rejected: %s", filename)
            return None
        if not path.exists():
            return None
        return path

    def _quick_info(self, path: Path) -> dict:
        """Read the info table from a collection file and return a summary dict."""
        info: dict[str, Any] = {
            "filename": path.name,
            "size_bytes": path.stat().st_size,
        }
        try:
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            for row in conn.execute("SELECT key, value FROM info"):
                info[row[0]] = row[1]
            info["tick_count_db"] = conn.execute(
                "SELECT COUNT(*) FROM ticks"
            ).fetchone()[0]
            info["var_count"] = conn.execute(
                "SELECT COUNT(*) FROM catalog"
            ).fetchone()[0]
            conn.close()
        except Exception:
            pass
        return info

    def _collect_loop(self, path: Path, hz: int) -> None:
        """Background collection thread — writes one tick per sample interval."""
        # Import inside thread to avoid circular import issues at module load
        from server.services.iracing_bridge import bridge

        interval = 1.0 / hz
        conn = None

        try:
            conn = sqlite3.connect(str(path))
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            self._init_schema(conn)

            # Write start metadata
            conn.execute("INSERT OR REPLACE INTO info VALUES (?, ?)",
                         ("started_at", datetime.now(timezone.utc).isoformat()))
            conn.execute("INSERT OR REPLACE INTO info VALUES (?, ?)",
                         ("sample_hz", str(hz)))
            conn.commit()

            last_tick = time.monotonic()

            while not self._stop_event.is_set():
                now = time.monotonic()
                sleep_for = interval - (now - last_tick)
                if sleep_for > 0:
                    time.sleep(sleep_for)
                last_tick = time.monotonic()

                result = bridge.capture_all_vars()
                if result is None:
                    # iRacing not connected — keep looping so we catch it when it starts
                    continue

                catalog, snapshot = result

                # Write catalog on the very first tick
                if not self._catalog_written:
                    self._write_catalog(conn, catalog)
                    # Enrich info table with session metadata
                    sd = bridge.session_data
                    meta = {
                        "track_name":    sd.get("track_name", ""),
                        "track_id":      str(sd.get("track_id", "")),
                        "car_class":     sd.get("car_class_name", ""),
                        "session_type":  sd.get("session_type", ""),
                        "iracing_version": sd.get("iracing_version", ""),
                        "driver_count":  str(len(sd.get("drivers", []))),
                    }
                    for k, v in meta.items():
                        conn.execute("INSERT OR REPLACE INTO info VALUES (?, ?)", (k, v))
                    conn.commit()
                    self._catalog_written = True

                # Write tick
                wall_time     = time.time()
                session_time  = snapshot.get("SessionTime") or 0.0
                session_state = snapshot.get("SessionState") or 0
                replay_frame  = snapshot.get("ReplayFrameNum") or 0

                conn.execute(
                    """INSERT INTO ticks (wall_time, session_time, session_state,
                                         replay_frame, data_json)
                       VALUES (?, ?, ?, ?, ?)""",
                    (wall_time, session_time, session_state,
                     replay_frame, json.dumps(snapshot, default=str)),
                )

                with self._lock:
                    self._tick_count += 1

                # Commit every 20 ticks to avoid constant fsync overhead
                if self._tick_count % 20 == 0:
                    conn.commit()

        except Exception as exc:
            logger.error("[Collection] Collection loop error: %s", exc, exc_info=True)
        finally:
            if conn:
                try:
                    conn.commit()
                    conn.close()
                except Exception:
                    pass

    def _init_schema(self, conn: sqlite3.Connection) -> None:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS info (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
            CREATE TABLE IF NOT EXISTS catalog (
                name      TEXT PRIMARY KEY,
                var_type  INTEGER,
                unit      TEXT,
                desc      TEXT,
                count     INTEGER
            );
            CREATE TABLE IF NOT EXISTS ticks (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                wall_time     REAL NOT NULL,
                session_time  REAL NOT NULL,
                session_state INTEGER NOT NULL,
                replay_frame  INTEGER NOT NULL,
                data_json     TEXT
            );
            CREATE INDEX IF NOT EXISTS ticks_session_time ON ticks (session_time);
        """)

    def _write_catalog(self, conn: sqlite3.Connection, catalog: dict) -> None:
        conn.executemany(
            "INSERT OR REPLACE INTO catalog (name, var_type, unit, desc, count) "
            "VALUES (?, ?, ?, ?, ?)",
            [
                (name, v.get("type"), v.get("unit", ""), v.get("desc", ""), v.get("count", 1))
                for name, v in catalog.items()
            ],
        )
        conn.commit()
        logger.info("[Collection] Catalog written — %d variables", len(catalog))


# ── Module-level singleton ────────────────────────────────────────────────────

collection_service = CollectionService()
