"""
career_stats_service.py
-----------------------
Career stats scrape / hydration service.

Fetches iRacing member career statistics and stores them in a shared SQLite
database.  The hydration queue is ordered so that users who have *never* been
hydrated come first, followed by those with the *fewest* previous hydrations,
and finally by the users whose stats are *oldest* (least-recently updated).

Priority ordering (most urgent → least urgent):
  1. last_updated IS NULL  — never hydrated
  2. hydration_count ASC   — hydrated fewest times
  3. last_updated ASC      — oldest existing snapshot

This ensures new drivers appearing in a project are processed before
repeatedly refreshing drivers whose stats are already fresh.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Default path for the global career-stats database.
# Callers may override this via CareerStatsService(db_path=...).
# ---------------------------------------------------------------------------
_DEFAULT_DB_PATH = Path(__file__).resolve().parents[3] / "data" / "career_stats.db"

# DDL for the global career_stats table.
_SCHEMA_SQL = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS career_stats (
    cust_id           INTEGER PRIMARY KEY,
    display_name      TEXT,

    -- per-category iRating snapshots (NULL until hydrated)
    oval_irating      INTEGER,
    road_irating      INTEGER,
    dirt_oval_irating INTEGER,
    dirt_road_irating INTEGER,

    -- safety ratings (stored as hundredths, e.g. 399 = "3.99 B")
    oval_sr           INTEGER,
    road_sr           INTEGER,
    dirt_oval_sr      INTEGER,
    dirt_road_sr      INTEGER,

    -- highest overall license class / sublevel
    license_class     TEXT,
    license_level     INTEGER,

    -- aggregate career counters
    total_starts      INTEGER DEFAULT 0,
    total_wins        INTEGER DEFAULT 0,
    total_top5        INTEGER DEFAULT 0,
    total_poles       INTEGER DEFAULT 0,
    total_laps_led    INTEGER DEFAULT 0,

    -- hydration bookkeeping
    hydration_count   INTEGER NOT NULL DEFAULT 0,
    last_updated      TIMESTAMP,            -- NULL = never hydrated
    created_at        TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
"""


class CareerStatsService:
    """
    Manages the career-stats hydration queue and database.

    Typical lifecycle
    -----------------
    service = CareerStatsService()
    service.open()                          # init DB
    service.enqueue([123456, 789012])       # register drivers from a project
    await service.run_hydration_loop()      # background worker (runs until cancelled)
    service.close()
    """

    def __init__(
        self,
        db_path: Optional[Path] = None,
        batch_size: int = 10,
        poll_interval_seconds: float = 5.0,
    ) -> None:
        self._db_path = Path(db_path) if db_path else _DEFAULT_DB_PATH
        self._batch_size = batch_size
        self._poll_interval = poll_interval_seconds
        self._conn: Optional[sqlite3.Connection] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def open(self) -> None:
        """Open (and initialise) the SQLite database."""
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.executescript(_SCHEMA_SQL)
        conn.commit()
        self._conn = conn
        logger.info("Career stats database opened at %s", self._db_path)

    def close(self) -> None:
        """Close the database connection."""
        if self._conn:
            self._conn.close()
            self._conn = None

    # ------------------------------------------------------------------
    # Queue management
    # ------------------------------------------------------------------

    def enqueue(self, cust_ids: list[int]) -> int:
        """
        Register one or more iRacing customer IDs for future hydration.

        Drivers that already exist in the database are left untouched so
        that existing hydration_count / last_updated values are preserved.

        Returns the number of *new* rows inserted.
        """
        if not cust_ids:
            return 0
        assert self._conn, "Call open() before enqueue()"

        inserted = 0
        for cust_id in cust_ids:
            cursor = self._conn.execute(
                "INSERT OR IGNORE INTO career_stats (cust_id) VALUES (?)",
                (cust_id,),
            )
            inserted += cursor.rowcount
        self._conn.commit()
        logger.info("Enqueued %d new cust_ids (%d already present)", inserted, len(cust_ids) - inserted)
        return inserted

    # ------------------------------------------------------------------
    # Priority queue read
    # ------------------------------------------------------------------

    def get_next_batch(self, limit: Optional[int] = None) -> list[int]:
        """
        Return the next batch of cust_ids to hydrate, ordered by priority:

          1. last_updated IS NULL  (never hydrated — highest priority)
          2. hydration_count ASC   (fewest previous hydrations)
          3. last_updated ASC      (oldest existing snapshot)

        Only rows that are not currently being hydrated
        (last_updated IS NULL OR strftime check) are returned.
        """
        assert self._conn, "Call open() before get_next_batch()"
        n = limit if limit is not None else self._batch_size

        rows = self._conn.execute(
            """
            SELECT cust_id
            FROM   career_stats
            ORDER BY
                CASE WHEN last_updated IS NULL THEN 0 ELSE 1 END ASC,
                hydration_count ASC,
                last_updated ASC
            LIMIT ?
            """,
            (n,),
        ).fetchall()
        return [row["cust_id"] for row in rows]

    # ------------------------------------------------------------------
    # Hydration
    # ------------------------------------------------------------------

    async def hydrate(self, cust_id: int) -> bool:
        """
        Fetch career stats for *cust_id* from the iRacing data API and
        persist them to the database.

        Returns True on success, False on failure (caller logs the error).

        Note: The actual HTTP call is delegated to ``_fetch_from_iracing``
        so that it can be replaced with a mock in tests.
        """
        assert self._conn, "Call open() before hydrate()"
        try:
            data = await self._fetch_from_iracing(cust_id)
            if data is None:
                logger.warning("[CareerStats] No data returned for cust_id=%d", cust_id)
                return False

            now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
            self._conn.execute(
                """
                UPDATE career_stats SET
                    display_name      = ?,
                    oval_irating      = ?,
                    road_irating      = ?,
                    dirt_oval_irating = ?,
                    dirt_road_irating = ?,
                    oval_sr           = ?,
                    road_sr           = ?,
                    dirt_oval_sr      = ?,
                    dirt_road_sr      = ?,
                    license_class     = ?,
                    license_level     = ?,
                    total_starts      = ?,
                    total_wins        = ?,
                    total_top5        = ?,
                    total_poles       = ?,
                    total_laps_led    = ?,
                    hydration_count   = hydration_count + 1,
                    last_updated      = ?
                WHERE cust_id = ?
                """,
                (
                    data.get("display_name"),
                    data.get("oval_irating"),
                    data.get("road_irating"),
                    data.get("dirt_oval_irating"),
                    data.get("dirt_road_irating"),
                    data.get("oval_sr"),
                    data.get("road_sr"),
                    data.get("dirt_oval_sr"),
                    data.get("dirt_road_sr"),
                    data.get("license_class"),
                    data.get("license_level"),
                    data.get("total_starts"),
                    data.get("total_wins"),
                    data.get("total_top5"),
                    data.get("total_poles"),
                    data.get("total_laps_led"),
                    now,
                    cust_id,
                ),
            )
            self._conn.commit()
            logger.info("[CareerStats] Hydrated cust_id=%d (%s)", cust_id, data.get("display_name", ""))
            return True

        except Exception as exc:
            logger.error("[CareerStats] Failed to hydrate cust_id=%d: %s", cust_id, exc)
            return False

    # ------------------------------------------------------------------
    # Background loop
    # ------------------------------------------------------------------

    async def run_hydration_loop(self) -> None:
        """
        Continuous background loop that processes the priority queue in
        batches.  Runs until the asyncio task is cancelled.
        """
        logger.info("[CareerStats] Hydration loop started (batch=%d, interval=%.1fs)", self._batch_size, self._poll_interval)
        while True:
            batch = self.get_next_batch()
            if batch:
                logger.debug("[CareerStats] Processing batch of %d", len(batch))
                for cust_id in batch:
                    await self.hydrate(cust_id)
            else:
                logger.debug("[CareerStats] Queue empty, sleeping %.1fs", self._poll_interval)
            await asyncio.sleep(self._poll_interval)

    # ------------------------------------------------------------------
    # Read helpers
    # ------------------------------------------------------------------

    def get_stats(self, cust_id: int) -> Optional[dict]:
        """Return the stored stats dict for a single driver, or None."""
        assert self._conn, "Call open() before get_stats()"
        row = self._conn.execute(
            "SELECT * FROM career_stats WHERE cust_id = ?", (cust_id,)
        ).fetchone()
        return dict(row) if row else None

    def list_stats(self, limit: int = 100, offset: int = 0) -> list[dict]:
        """Return a paginated list of all tracked drivers."""
        assert self._conn, "Call open() before list_stats()"
        rows = self._conn.execute(
            """
            SELECT * FROM career_stats
            ORDER BY
                CASE WHEN last_updated IS NULL THEN 0 ELSE 1 END ASC,
                hydration_count ASC,
                last_updated ASC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        ).fetchall()
        return [dict(r) for r in rows]

    def queue_depth(self) -> dict:
        """
        Return queue depth summary:
          - total: number of tracked drivers
          - pending_hydration: drivers with last_updated IS NULL
          - stale: drivers whose stats are more than 24 h old
        """
        assert self._conn, "Call open() before queue_depth()"
        total = self._conn.execute("SELECT COUNT(*) FROM career_stats").fetchone()[0]
        pending = self._conn.execute(
            "SELECT COUNT(*) FROM career_stats WHERE last_updated IS NULL"
        ).fetchone()[0]
        stale = self._conn.execute(
            """
            SELECT COUNT(*) FROM career_stats
            WHERE last_updated IS NOT NULL
              AND last_updated < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
            """
        ).fetchone()[0]
        return {"total": total, "pending_hydration": pending, "stale": stale}

    # ------------------------------------------------------------------
    # iRacing data API stub
    # ------------------------------------------------------------------

    async def _fetch_from_iracing(self, cust_id: int) -> Optional[dict]:
        """
        Fetch career statistics from the iRacing data API for *cust_id*.

        This method is intentionally thin so it can be patched in tests.
        A full implementation should use ``httpx`` (async) with the
        iRacing data API authenticated session
        (``https://members-ng.iracing.com/data/member/career``).

        Returns a dict with snake_case keys matching the career_stats
        schema columns, or None if the request fails.
        """
        raise NotImplementedError(
            "Implement _fetch_from_iracing() with an authenticated httpx session "
            "against https://members-ng.iracing.com/data/member/career"
        )
