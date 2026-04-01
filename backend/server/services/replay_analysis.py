"""
replay_analysis.py
-------------------
Two-pass replay analysis engine:

  Pass 1 — SCAN: Drive the replay at 16× speed, capturing normalised
           telemetry snapshots to race_ticks + car_states tables.

  Pass 2 — DETECT: Run all event detectors on cached SQLite data.
           No iRacing connection required for this pass.

Streams real-time progress to the frontend via a callback.
Designed to run in a background asyncio task so the UI stays responsive.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import sqlite3
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from server.services.analysis_db import (
    get_project_db,
    init_analysis_db,
    clear_analysis_data,
    insert_events_batch,
    count_events,
)
from server.services.detectors import ALL_DETECTORS
from server.services.iracing_bridge import bridge as iracing_bridge

logger = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────────

SCAN_SPEED = 16          # Replay speed during scanning
TICK_INTERVAL = 0.05     # Seconds between telemetry samples (20 Hz during 16× scan)
BATCH_SIZE = 100         # Commit telemetry in batches
PROGRESS_INTERVAL = 2.0  # Seconds between progress broadcasts

# iRacing session states
SESSION_STATE_CHECKERED = 5
SESSION_STATE_COOLDOWN = 6


# ── Telemetry Writer ─────────────────────────────────────────────────────────

class TelemetryWriter:
    """Batch-writes normalised telemetry snapshots to SQLite."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._tick_batch: list[tuple] = []
        self._car_batch: list[tuple] = []
        self._lap_batch: list[tuple] = []
        self._total_ticks = 0
        self._last_laps: dict[int, int] = {}  # car_idx → last known lap

    @property
    def total_ticks(self) -> int:
        return self._total_ticks

    def write_tick(self, snapshot: dict) -> None:
        """Buffer one telemetry tick and its car states."""
        data = snapshot.get("data", snapshot)

        # Insert race_tick
        self._tick_batch.append((
            data.get("session_time", 0.0),
            data.get("replay_frame", 0),
            data.get("session_state", 0),
            data.get("race_laps", 0),
            data.get("cam_car_idx", 0),
            data.get("flags", 0),
        ))
        tick_index = self._total_ticks  # Will become the tick_id after insert
        self._total_ticks += 1

        # Buffer car states (tick_id is a placeholder — resolved at flush)
        for car in data.get("car_states", []):
            self._car_batch.append((
                tick_index,  # placeholder for tick_id
                car.get("car_idx", 0),
                car.get("position", 0),
                car.get("class_position", 0),
                car.get("lap", 0),
                car.get("lap_pct", 0.0),
                car.get("surface", 0),
                car.get("est_time", 0.0),
                car.get("best_lap_time", -1.0),
            ))

            # Detect lap completions
            car_idx = car.get("car_idx", 0)
            cur_lap = car.get("lap", 0)
            prev_lap = self._last_laps.get(car_idx, 0)
            if cur_lap > prev_lap and prev_lap > 0:
                self._lap_batch.append((
                    tick_index,  # placeholder
                    car_idx,
                    cur_lap,
                    car.get("position", 0),
                ))
            self._last_laps[car_idx] = cur_lap

        if len(self._tick_batch) >= BATCH_SIZE:
            self.flush()

    def flush(self) -> None:
        """Write buffered data to the database."""
        if not self._tick_batch:
            return

        conn = self._conn

        # Insert ticks one-by-one to collect their auto-generated IDs
        tick_ids: list[int] = []
        for tick_row in self._tick_batch:
            cursor = conn.execute(
                """INSERT INTO race_ticks
                   (session_time, replay_frame, session_state, race_laps, cam_car_idx, flags)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                tick_row,
            )
            tick_ids.append(cursor.lastrowid)  # type: ignore[arg-type]

        # Build index → actual tick_id mapping
        id_map: dict[int, int] = {}
        for i, tick_id in enumerate(tick_ids):
            base_tick_index = self._total_ticks - len(self._tick_batch) + i
            id_map[base_tick_index] = tick_id

        # Resolve placeholder tick_ids in car_states
        resolved_cars = []
        for car_row in self._car_batch:
            tick_idx = car_row[0]
            actual_id = id_map.get(tick_idx, tick_idx)
            resolved_cars.append((actual_id,) + car_row[1:])

        if resolved_cars:
            conn.executemany(
                """INSERT INTO car_states
                   (tick_id, car_idx, position, class_position, lap, lap_pct,
                    surface, est_time, best_lap_time)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                resolved_cars,
            )

        # Resolve placeholder tick_ids in lap_completions
        resolved_laps = []
        for lap_row in self._lap_batch:
            tick_idx = lap_row[0]
            actual_id = id_map.get(tick_idx, tick_idx)
            resolved_laps.append((actual_id,) + lap_row[1:])

        if resolved_laps:
            conn.executemany(
                """INSERT INTO lap_completions
                   (tick_id, car_idx, lap_number, position)
                   VALUES (?, ?, ?, ?)""",
                resolved_laps,
            )

        conn.commit()

        # Clear buffers
        self._tick_batch = []
        self._car_batch = []
        self._lap_batch = []


# ── Replay Analyzer ──────────────────────────────────────────────────────────

class ReplayAnalyzer:
    """Main orchestrator for two-pass replay analysis.

    Usage::

        analyzer = ReplayAnalyzer(
            project_id=1,
            project_dir="/path/to/project",
            on_progress=callback,
        )
        result = await analyzer.analyze()
    """

    def __init__(
        self,
        project_id: int,
        project_dir: str,
        session_info: dict | None = None,
        on_progress: Callable[[str, dict], None] | None = None,
    ) -> None:
        self.project_id = project_id
        self.project_dir = project_dir
        self.session_info = session_info or {}
        self.on_progress = on_progress or (lambda *a: None)
        self._cancelled = False

    def cancel(self) -> None:
        """Signal the analysis to stop at the next check point."""
        self._cancelled = True

    async def analyze(self) -> dict:
        """Run the full two-pass analysis. Returns summary dict."""
        started_at = datetime.now(timezone.utc).isoformat()

        # Initialise project database
        init_analysis_db(self.project_dir)
        conn = get_project_db(self.project_dir)

        # Record analysis run
        conn.execute(
            "INSERT INTO analysis_runs (started_at, status) VALUES (?, 'running')",
            (started_at,),
        )
        run_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()

        try:
            # Emit start event
            self.on_progress("started", {
                "project_id": self.project_id,
                "stage": "analysis",
                "description": "Starting replay analysis",
            })

            # Clear previous data
            clear_analysis_data(conn)

            # Save driver data from session info
            self._save_drivers(conn)

            # Pass 1: Scan telemetry
            scan_start = time.monotonic()
            total_ticks = await self._scan_telemetry(conn)
            scan_duration = time.monotonic() - scan_start

            if self._cancelled:
                self._finish_run(conn, run_id, "cancelled", total_ticks, 0, scan_duration)
                return {"status": "cancelled"}

            # Pass 2: Detect events
            self.on_progress("step_completed", {
                "project_id": self.project_id,
                "stage": "analysis_detect",
                "description": "Running event detection...",
                "progress_percent": 90,
            })
            total_events = self._detect_events(conn)

            # Mark complete
            self._finish_run(conn, run_id, "completed", total_ticks, total_events, scan_duration)

            self.on_progress("completed", {
                "project_id": self.project_id,
                "stage": "analysis",
                "events_detected": total_events,
                "telemetry_rows": total_ticks,
                "duration_seconds": round(scan_duration, 1),
            })

            logger.info(
                "[Analysis] Complete: %d ticks, %d events in %.1fs",
                total_ticks, total_events, scan_duration,
            )

            return {
                "status": "completed",
                "total_ticks": total_ticks,
                "total_events": total_events,
                "scan_duration": round(scan_duration, 1),
            }

        except Exception as exc:
            error_msg = str(exc)
            self._finish_run(conn, run_id, "error", 0, 0, 0, error_msg)
            self.on_progress("error", {
                "project_id": self.project_id,
                "stage": "analysis",
                "message": error_msg,
            })
            logger.error("[Analysis] Error: %s", exc)
            raise
        finally:
            conn.close()

    async def _scan_telemetry(self, conn: sqlite3.Connection) -> int:
        """Pass 1: Scan the replay at 16× speed, capturing telemetry."""
        if not iracing_bridge.is_connected:
            logger.warning("[Analysis] iRacing not connected — using mock scan")
            return self._mock_scan(conn)

        writer = TelemetryWriter(conn)

        # Set replay to beginning and 16× speed
        iracing_bridge.seek_to_frame(0)
        await asyncio.sleep(0.5)
        iracing_bridge.set_replay_speed(SCAN_SPEED)

        last_progress = time.monotonic()
        all_finished = False
        last_session_time = 0.0

        self.on_progress("step_completed", {
            "project_id": self.project_id,
            "stage": "analysis_scan",
            "description": f"Scanning replay at {SCAN_SPEED}× speed...",
            "progress_percent": 0,
        })

        while not self._cancelled:
            if not iracing_bridge.is_connected:
                logger.warning("[Analysis] iRacing disconnected during scan")
                break

            # Capture snapshot from the bridge's internal state
            snapshot = self._capture_snapshot()
            if not snapshot:
                await asyncio.sleep(TICK_INTERVAL)
                continue

            writer.write_tick(snapshot)

            session_state = snapshot.get("session_state", 0)
            session_time = snapshot.get("session_time", 0.0)

            # Track progress
            if session_time > last_session_time:
                last_session_time = session_time

            # Send progress update periodically
            now = time.monotonic()
            if now - last_progress >= PROGRESS_INTERVAL:
                self.on_progress("step_completed", {
                    "project_id": self.project_id,
                    "stage": "analysis_scan",
                    "current_time": round(session_time, 1),
                    "total_ticks": writer.total_ticks,
                    "message": f"Scanned {_format_time(session_time)} of race...",
                })
                last_progress = now

            # Check for race end: checkered flag + cooldown
            if session_state >= SESSION_STATE_CHECKERED:
                # Continue scanning for a few more seconds to capture finish
                await asyncio.sleep(5.0)
                # Take final samples
                for _ in range(10):
                    snap = self._capture_snapshot()
                    if snap:
                        writer.write_tick(snap)
                    await asyncio.sleep(TICK_INTERVAL)
                break

            await asyncio.sleep(TICK_INTERVAL)

        # Flush remaining data
        writer.flush()

        # Pause replay
        iracing_bridge.set_replay_speed(0)

        return writer.total_ticks

    def _capture_snapshot(self) -> dict | None:
        """Capture a telemetry snapshot from the iRacing bridge.

        Delegates to bridge.capture_snapshot() — avoids accessing private _ir.
        Returns a flat dict with telemetry fields, or None if unavailable.
        """
        return iracing_bridge.capture_snapshot()

    def _mock_scan(self, conn: sqlite3.Connection) -> int:
        """Generate mock telemetry data when iRacing is not connected.

        This allows the analysis pipeline to be tested without iRacing.
        Returns the number of mock ticks generated.
        """
        logger.info("[Analysis] Running mock scan (no iRacing connection)")
        writer = TelemetryWriter(conn)

        # Generate ~100 mock ticks representing a short race segment
        num_cars = 20
        total_laps = 10
        avg_lap_time = 90.0  # seconds

        for tick_num in range(100):
            session_time = tick_num * 1.0  # 1-second intervals at 16×
            replay_frame = tick_num * 960  # ~60fps × 16×
            race_laps = min(total_laps, int(session_time / avg_lap_time) + 1)

            if session_time > avg_lap_time * total_laps:
                session_state = SESSION_STATE_CHECKERED
            else:
                session_state = 4  # Racing

            car_states = []
            for car_idx in range(1, num_cars + 1):
                lap_pct = ((session_time / avg_lap_time) + (car_idx * 0.02)) % 1.0
                surface = 3  # OnTrack
                if random.random() < 0.02:
                    surface = 0  # OffTrack
                car_states.append({
                    "car_idx": car_idx,
                    "position": car_idx,
                    "class_position": car_idx,
                    "lap": race_laps,
                    "lap_pct": lap_pct,
                    "surface": surface,
                    "est_time": 0.0,
                    "best_lap_time": avg_lap_time + random.uniform(-2, 5),
                })

            writer.write_tick({
                "session_time": session_time,
                "session_state": session_state,
                "replay_frame": replay_frame,
                "race_laps": race_laps,
                "cam_car_idx": 1,
                "flags": 0,
                "car_states": car_states,
            })

        writer.flush()
        return writer.total_ticks

    def _detect_events(self, conn: sqlite3.Connection) -> int:
        """Pass 2: Run all event detectors on cached telemetry data."""
        total_events = 0
        session_info = dict(self.session_info)

        # Get avg_lap_time from session data or estimate from telemetry
        if not session_info.get("avg_lap_time"):
            session_info["avg_lap_time"] = self._estimate_avg_lap_time(conn)

        for detector in ALL_DETECTORS:
            try:
                events = detector.detect(conn, session_info)
                if events:
                    count = insert_events_batch(conn, events)
                    total_events += count
                    conn.commit()
                    logger.info(
                        "[Analysis] %s: %d events",
                        detector.__class__.__name__, count,
                    )
            except Exception as exc:
                logger.error(
                    "[Analysis] %s failed: %s",
                    detector.__class__.__name__, exc,
                )

        return total_events

    def _save_drivers(self, conn: sqlite3.Connection) -> None:
        """Save driver metadata from session info to the project database."""
        drivers = self.session_info.get("drivers", [])
        if not drivers:
            # Try to get from the bridge
            if iracing_bridge.is_connected:
                drivers = iracing_bridge.session_data.get("drivers", [])

        if not drivers:
            return

        rows = [
            (
                d.get("car_idx", 0),
                d.get("car_number", ""),
                d.get("user_name", ""),
                d.get("car_class_name", ""),
                d.get("iracing_cust_id", 0),
                int(d.get("is_spectator", False)),
            )
            for d in drivers
        ]

        conn.executemany(
            """INSERT OR REPLACE INTO drivers
               (car_idx, car_number, user_name, car_class_name,
                iracing_cust_id, is_spectator)
               VALUES (?, ?, ?, ?, ?, ?)""",
            rows,
        )
        conn.commit()
        logger.info("[Analysis] Saved %d drivers", len(rows))

    @staticmethod
    def _estimate_avg_lap_time(conn: sqlite3.Connection) -> float:
        """Estimate average lap time from lap completion data."""
        row = conn.execute("""
            SELECT AVG(duration) FROM (
                SELECT t2.session_time - t1.session_time AS duration
                FROM lap_completions lc1
                JOIN lap_completions lc2 ON lc2.car_idx = lc1.car_idx
                    AND lc2.lap_number = lc1.lap_number + 1
                JOIN race_ticks t1 ON lc1.tick_id = t1.id
                JOIN race_ticks t2 ON lc2.tick_id = t2.id
                WHERE duration > 10 AND duration < 600
            )
        """).fetchone()
        result = row[0] if row and row[0] else 90.0
        return float(result)

    def _finish_run(
        self,
        conn: sqlite3.Connection,
        run_id: int,
        status: str,
        total_ticks: int,
        total_events: int,
        scan_duration: float,
        error_message: str | None = None,
    ) -> None:
        """Update the analysis_runs record with final status."""
        conn.execute(
            """UPDATE analysis_runs
               SET completed_at = ?, status = ?, total_ticks = ?,
                   total_events = ?, scan_duration = ?, error_message = ?
               WHERE id = ?""",
            (
                datetime.now(timezone.utc).isoformat(),
                status,
                total_ticks,
                total_events,
                scan_duration,
                error_message,
                run_id,
            ),
        )
        conn.commit()


# ── Singleton analysis manager ───────────────────────────────────────────────

class AnalysisManager:
    """Tracks active analysis tasks across projects."""

    def __init__(self) -> None:
        self._active: dict[int, ReplayAnalyzer] = {}  # project_id → analyzer
        self._tasks: dict[int, asyncio.Task] = {}      # project_id → task

    def is_running(self, project_id: int) -> bool:
        """Check if analysis is currently running for a project."""
        task = self._tasks.get(project_id)
        return task is not None and not task.done()

    def start(
        self,
        project_id: int,
        project_dir: str,
        session_info: dict | None = None,
        on_progress: Callable[[str, dict], None] | None = None,
    ) -> bool:
        """Start analysis for a project. Returns False if already running."""
        if self.is_running(project_id):
            return False

        analyzer = ReplayAnalyzer(
            project_id=project_id,
            project_dir=project_dir,
            session_info=session_info,
            on_progress=on_progress,
        )
        self._active[project_id] = analyzer

        task = asyncio.create_task(self._run(project_id, analyzer))
        self._tasks[project_id] = task
        return True

    async def _run(self, project_id: int, analyzer: ReplayAnalyzer) -> dict:
        """Execute analysis and clean up when done."""
        try:
            result = await analyzer.analyze()
            return result
        except Exception as exc:
            logger.error("[AnalysisManager] Analysis failed for project %d: %s", project_id, exc)
            return {"status": "error", "message": str(exc)}
        finally:
            self._active.pop(project_id, None)

    def cancel(self, project_id: int) -> bool:
        """Cancel a running analysis."""
        analyzer = self._active.get(project_id)
        if analyzer:
            analyzer.cancel()
            return True
        return False

    def get_status(self, project_id: int) -> dict:
        """Get current analysis status for a project."""
        if self.is_running(project_id):
            return {"status": "running", "project_id": project_id}
        return {"status": "idle", "project_id": project_id}


# Module-level singleton
analysis_manager = AnalysisManager()


# ── Helpers ──────────────────────────────────────────────────────────────────

def _format_time(seconds: float) -> str:
    """Format seconds as MM:SS."""
    m, s = divmod(int(seconds), 60)
    return f"{m}:{s:02d}"
