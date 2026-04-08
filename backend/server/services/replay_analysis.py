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
from pathlib import Path
from typing import Any, Callable, Optional

from server.services.analysis_db import (
    get_project_db,
    init_analysis_db,
    clear_analysis_data,
    insert_events_batch,
    count_events,
    format_event_log,
)
from server.services.detectors import ALL_DETECTORS
from server.services.iracing_bridge import bridge as iracing_bridge

logger = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────────

SCAN_SPEED = 16          # Replay speed during scanning

# Seconds between telemetry samples during the 16× scan.
# At 16× replay speed, iRacing's shared memory updates at 60 Hz real-time.
# To avoid missing short incidents/overtakes we need enough samples per
# race-second.  Formula: samples_per_race_second = (1/TICK_INTERVAL) / SCAN_SPEED
#   0.05 s → 20 Hz → 1.25  samples / race-second  (original — too low)
#   0.02 s → 50 Hz → 3.125 samples / race-second  (close to reference's 3.75)
# Going below 0.02 risks saturating pyirsdk; 50 Hz is a good trade-off.
TICK_INTERVAL = 0.02

BATCH_SIZE = 100         # Commit telemetry in batches
PROGRESS_INTERVAL = 2.0  # Seconds between progress broadcasts

# iRacing session states
SESSION_STATE_RACING = 4
SESSION_STATE_CHECKERED = 5
SESSION_STATE_COOLDOWN = 6

# iRacing track surface constants (used for race-end detection)
SURFACE_OFF_TRACK = 0
SURFACE_IN_PIT    = 1
SURFACE_PIT_APRON = 2


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
        self._prev_lap_pct: dict[int, tuple[float, float]] = {}  # car_idx → (lap_pct, session_time)

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
            data.get("flag_yellow", 0),
            data.get("flag_red", 0),
            data.get("flag_checkered", 0),
        ))
        tick_index = self._total_ticks  # Will become the tick_id after insert
        self._total_ticks += 1

        # Buffer car states (tick_id is a placeholder — resolved at flush)
        for car in data.get("car_states", []):
            # Derive speed from lap_pct rate of change
            car_idx = car.get("car_idx", 0)
            current_pct = car.get("lap_pct", 0.0)
            session_time = data.get("session_time", 0.0)
            prev = self._prev_lap_pct.get(car_idx)
            speed_ms = None
            if prev is not None:
                prev_pct, prev_time = prev
                dt = session_time - prev_time
                if 0 < dt < 2.0:  # Guard against large time gaps
                    dpct = current_pct - prev_pct
                    # Handle lap boundary wrap (pct goes from ~1.0 back to ~0.0)
                    if dpct < -0.5:
                        dpct += 1.0
                    elif dpct > 0.5:
                        dpct -= 1.0
                    track_length = data.get("track_length", 4000.0)  # meters, default 4km
                    speed_ms = abs(dpct * track_length / dt)
            self._prev_lap_pct[car_idx] = (current_pct, session_time)
            # Use the computed speed_ms or the one from snapshot if provided
            raw = car.get("speed_ms")
            car_speed = raw if raw is not None else speed_ms

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
                car_speed,
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
                   (session_time, replay_frame, session_state, race_laps, cam_car_idx, flags,
                    flag_yellow, flag_red, flag_checkered)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
                    surface, est_time, best_lap_time, speed_ms)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
        self._raw_on_progress = on_progress or (lambda *a: None)
        self._cancelled = False
        self._log_entries: list[dict] = []
        # Build car_idx → driver_name map for real-time event streaming
        self._driver_map: dict[int, str] = {}
        for d in self.session_info.get("drivers", []):
            idx = d.get("car_idx")
            if idx is not None:
                self._driver_map[idx] = d.get("user_name", f"#{d.get('car_number', idx)}")

    def on_progress(self, event_type: str, data: dict) -> None:
        """Forward progress event and record it for the analysis log file."""
        self._log_entries.append({
            "event": event_type,
            "ts": time.time(),
            **data,
        })
        self._raw_on_progress(event_type, data)

    def _save_analysis_log(self) -> None:
        """Persist the full analysis log to a JSON file in the project directory.

        Loads any existing log entries first so re-runs append rather than overwrite.
        """
        try:
            log_path = Path(self.project_dir) / "analysis_log.json"
            existing: list[dict] = []
            if log_path.exists():
                try:
                    existing = json.loads(log_path.read_text())
                    if not isinstance(existing, list):
                        existing = []
                except Exception:
                    existing = []
            combined = existing + self._log_entries
            log_path.write_text(json.dumps(combined, indent=2, default=str))
            logger.info("[Analysis] Saved analysis log to %s (%d entries)", log_path, len(combined))
        except Exception as exc:
            logger.warning("[Analysis] Failed to save analysis log: %s", exc)

    def _save_preview_screenshot(self) -> None:
        """Capture a screenshot of the iRacing window and save as the project preview."""
        try:
            from server.utils.window_capture import capture_iracing_screenshot
            frame = capture_iracing_screenshot(max_width=1280, quality=85)
            if frame:
                preview_path = Path(self.project_dir) / "preview.jpg"
                preview_path.write_bytes(frame)
                logger.info("[Analysis] Saved preview screenshot to %s", preview_path)
        except Exception as exc:
            logger.warning("[Analysis] Failed to save preview: %s", exc)

    def cancel(self) -> None:
        """Signal the analysis to stop at the next check point."""
        self._cancelled = True

    async def scan_only(self) -> dict:
        """Run ONLY Pass 1 (telemetry scan) — no event detection.

        Use this when you want to re-collect iRacing telemetry without
        changing tuning parameters, or as the first step before a
        separate re-analyze call.
        """
        started_at = datetime.now(timezone.utc).isoformat()

        init_analysis_db(self.project_dir)
        conn = get_project_db(self.project_dir)

        conn.execute(
            "INSERT INTO analysis_runs (started_at, status) VALUES (?, 'running')",
            (started_at,),
        )
        run_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()

        try:
            self.on_progress("started", {
                "project_id": self.project_id,
                "stage": "analysis",
                "phase": "scan",
                "description": "Collecting telemetry from replay...",
            })

            self._save_preview_screenshot()
            clear_analysis_data(conn)
            self._save_drivers(conn)

            scan_start = time.monotonic()
            total_ticks = await self._scan_telemetry(conn)
            scan_duration = time.monotonic() - scan_start

            if self._cancelled:
                self._finish_run(conn, run_id, "scan_cancelled", total_ticks, 0, scan_duration)
                return {"status": "cancelled"}

            self._finish_run(conn, run_id, "scan_complete", total_ticks, 0, scan_duration)

            self.on_progress("completed", {
                "project_id": self.project_id,
                "stage": "analysis",
                "phase": "scan",
                "telemetry_rows": total_ticks,
                "duration_seconds": round(scan_duration, 1),
                "description": f"Telemetry collected — {total_ticks:,} samples in {_format_time(scan_duration)}",
                "detail": "Ready for event detection. Adjust tuning parameters and click Re-analyze.",
            })

            logger.info(
                "[Analysis] Scan-only complete: %d ticks in %.1fs", total_ticks, scan_duration,
            )

            return {
                "status": "scan_complete",
                "total_ticks": total_ticks,
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
            logger.error("[Analysis] Scan-only error: %s", exc)
            raise
        finally:
            self._save_analysis_log()
            conn.close()

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

            # Capture a preview screenshot at the start for project thumbnail
            self._save_preview_screenshot()

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

            # Pass 2: Detect events (run in a thread pool — CPU-bound; must not block the event loop)
            num_detectors = len(ALL_DETECTORS)
            self.on_progress("step_completed", {
                "project_id": self.project_id,
                "stage": "analysis_detect",
                "description": "Running event detectors on telemetry data...",
                "detail": f"Analysing {total_ticks:,} telemetry samples with {num_detectors} event detectors",
                "progress_percent": 85,
            })
            loop = asyncio.get_running_loop()
            total_events = await loop.run_in_executor(None, self._run_detect_in_thread)

            # Mark complete
            self._finish_run(conn, run_id, "completed", total_ticks, total_events, scan_duration)

            self.on_progress("completed", {
                "project_id": self.project_id,
                "stage": "analysis",
                "events_detected": total_events,
                "telemetry_rows": total_ticks,
                "duration_seconds": round(scan_duration, 1),
                "description": f"Analysis complete — {total_events} events found in {_format_time(scan_duration)}",
                "detail": f"Processed {total_ticks:,} telemetry samples across the full race",
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
            self._save_analysis_log()
            conn.close()

    # ── Verified replay-control helpers ──────────────────────────────────────

    async def _verified_seek(
        self,
        frame: int,
        label: str = "",
        max_retries: int = 4,
        poll_timeout: float = 5.0,
        poll_interval: float = 0.1,
        tolerance: int = 120,  # frames (~2 s at 60 fps)
    ) -> bool:
        """Seek to *frame* and confirm ReplayFrameNum is within *tolerance*.

        Retries up to *max_retries* times.  Returns True if confirmed, False
        if all attempts fail (caller decides how to proceed).
        Emits on_progress events so every attempt is visible in the UI.
        """
        tag = f" ({label})" if label else ""
        for attempt in range(1, max_retries + 1):
            iracing_bridge.seek_to_frame(frame)
            self.on_progress("step_completed", {
                "project_id": self.project_id,
                "stage": "analysis_scan",
                "description": f"Seeking to frame {frame:,}{tag}... (attempt {attempt}/{max_retries})",
                "detail": f"Sent seek command to iRacing — polling ReplayFrameNum to confirm (timeout {poll_timeout:.0f}s)",
                "progress_percent": 1,
            })
            deadline = time.monotonic() + poll_timeout
            while time.monotonic() < deadline:
                await asyncio.sleep(poll_interval)
                current = iracing_bridge.get_replay_frame()
                if current >= 0 and abs(current - frame) <= tolerance:
                    logger.info(
                        "[Analysis] Seek to frame %d confirmed (current=%d)%s",
                        frame, current, tag,
                    )
                    self.on_progress("step_completed", {
                        "project_id": self.project_id,
                        "stage": "analysis_scan",
                        "description": f"Seek confirmed{tag} ✓",
                        "detail": f"ReplayFrameNum={current:,} (target {frame:,}, within {tolerance} frames)",
                        "progress_percent": 1,
                    })
                    return True
            current = iracing_bridge.get_replay_frame()
            logger.warning(
                "[Analysis] Seek to frame %d not confirmed%s — "
                "ReplayFrameNum=%d after %.0fs, attempt %d/%d",
                frame, tag, current, poll_timeout, attempt, max_retries,
            )
            self.on_progress("step_completed", {
                "project_id": self.project_id,
                "stage": "analysis_scan",
                "description": f"Seek NOT confirmed{tag} — retrying... (attempt {attempt}/{max_retries})",
                "detail": (
                    f"ReplayFrameNum={current:,} after {poll_timeout:.0f}s, expected ~{frame:,}. "
                    "iRacing may be ignoring seek commands — check it is in Replay mode."
                ),
                "progress_percent": 1,
            })
            if attempt < max_retries:
                # Brief pause before retry so iRacing can settle
                await asyncio.sleep(0.5)
        return False

    async def _verified_set_speed(
        self,
        speed: int,
        label: str = "",
        max_retries: int = 4,
        poll_timeout: float = 3.0,
        poll_interval: float = 0.1,
    ) -> bool:
        """Set replay speed and confirm ReplayPlaySpeed matches.

        Retries up to *max_retries* times.  Returns True if confirmed.
        Emits on_progress events so every attempt is visible in the UI.
        """
        tag = f" ({label})" if label else ""
        for attempt in range(1, max_retries + 1):
            iracing_bridge.set_replay_speed(speed)
            self.on_progress("step_completed", {
                "project_id": self.project_id,
                "stage": "analysis_scan",
                "description": f"Setting replay speed to {speed}×{tag}... (attempt {attempt}/{max_retries})",
                "detail": f"Sent speed command to iRacing — polling ReplayPlaySpeed to confirm (timeout {poll_timeout:.0f}s)",
                "progress_percent": 1,
            })
            deadline = time.monotonic() + poll_timeout
            while time.monotonic() < deadline:
                await asyncio.sleep(poll_interval)
                current = iracing_bridge.get_replay_speed()
                if current == speed:
                    logger.info(
                        "[Analysis] Replay speed %d× confirmed%s", speed, tag,
                    )
                    self.on_progress("step_completed", {
                        "project_id": self.project_id,
                        "stage": "analysis_scan",
                        "description": f"Speed {speed}× confirmed{tag} ✓",
                        "detail": f"ReplayPlaySpeed={current}×",
                        "progress_percent": 1,
                    })
                    return True
            current = iracing_bridge.get_replay_speed()
            logger.warning(
                "[Analysis] Speed %d× not confirmed%s — "
                "ReplayPlaySpeed=%d after %.0fs, attempt %d/%d",
                speed, tag, current, poll_timeout, attempt, max_retries,
            )
            self.on_progress("step_completed", {
                "project_id": self.project_id,
                "stage": "analysis_scan",
                "description": f"Speed {speed}× NOT confirmed{tag} — retrying... (attempt {attempt}/{max_retries})",
                "detail": (
                    f"ReplayPlaySpeed={current}× after {poll_timeout:.0f}s, expected {speed}×. "
                    "iRacing may be ignoring speed commands."
                ),
                "progress_percent": 1,
            })
            if attempt < max_retries:
                await asyncio.sleep(0.3)
        return False

    async def _scan_telemetry(self, conn: sqlite3.Connection) -> int:
        """Pass 1: Scan the replay at 16× speed, capturing telemetry.

        Optimised race start detection:
          1. Read SessionInfo to find the race session index
          2. Use replay_search_session_time() to jump directly to the race session
          3. Scan forward from there for SessionState == Racing (very short)
          4. Subtract 20 seconds for pre-race grid
          5. Seek back and do the real scan at 16×

        Falls back to legacy frame-0 scan if session jumping is unavailable.
        """
        if not iracing_bridge.is_connected:
            logger.warning("[Analysis] iRacing not connected — using mock scan")
            return self._mock_scan(conn)

        writer = TelemetryWriter(conn)

        # ── Step 0: Rewind to frame 0 before doing anything else ─────────
        # Must happen first. When iRacing is paused at the end of the race
        # the replay engine is in an "ended" state — replay_search_session_time
        # and set_replay_speed will silently do nothing until we unstick it.
        self.on_progress("step_completed", {
            "project_id": self.project_id,
            "stage": "analysis_scan",
            "description": "Rewinding replay to start...",
            "detail": "Seeking to frame 0 before reading session data",
            "progress_percent": 0,
        })
        rewind_ok = await self._verified_seek(0, label="rewind", tolerance=60)
        if not rewind_ok:
            logger.warning("[Analysis] Frame-0 seek not confirmed — trying replay_search to_start (mode=0)")
            self.on_progress("step_completed", {
                "project_id": self.project_id,
                "stage": "analysis_scan",
                "description": "Rewind failed — trying alternate seek method...",
                "detail": "ReplayFrameNum did not reach 0. Attempting to_start search as fallback.",
                "progress_percent": 0,
            })
            iracing_bridge.replay_search(0)  # RpySrchMode.to_start = 0
            rewind_ok = await self._verified_seek(0, label="rewind-fallback", max_retries=2, tolerance=300)
            if not rewind_ok:
                logger.error("[Analysis] Could not rewind replay to frame 0 — iRacing may not be in replay mode")
                self.on_progress("error", {
                    "project_id": self.project_id,
                    "stage": "analysis_scan",
                    "message": (
                        "Cannot rewind replay: iRacing is not responding to seek commands. "
                        "Make sure the replay is loaded and iRacing is in Replay mode."
                    ),
                })
                return 0

        # ── Phase A: Jump to race session & find start frame ─────────────
        self.on_progress("step_completed", {
            "project_id": self.project_id,
            "stage": "analysis_scan",
            "description": "Locating race session...",
            "detail": "Reading session info to identify race, qualifying, and practice sessions",
            "progress_percent": 1,
        })

        # Try to find the race session index from session info
        session_data = iracing_bridge.session_data
        race_session_num = session_data.get("race_session_num")
        all_sessions = session_data.get("sessions", [])

        # ── Persist session fingerprint for later replay-validation ─────────
        # Stored in analysis_meta so the frontend can later confirm the user
        # has the same replay loaded during review/editing phases.
        fingerprint = {
            "track_name":      session_data.get("track_name", ""),
            "track_id":        session_data.get("track_id", 0),
            "subsession_id":   session_data.get("subsession_id", 0),
            "driver_count":    len([d for d in session_data.get("drivers", []) if not d.get("is_spectator")]),
            "driver_cust_ids": session_data.get("driver_cust_ids", []),
        }
        conn.execute(
            "INSERT OR REPLACE INTO analysis_meta (key, value) VALUES (?, ?)",
            ("session_fingerprint", json.dumps(fingerprint)),
        )
        conn.commit()
        logger.info(
            "[Analysis] Session fingerprint saved: track=%r subsession=%s drivers=%d",
            fingerprint["track_name"], fingerprint["subsession_id"], fingerprint["driver_count"],
        )

        # ── Persist SessionLog incidents (ground-truth for IncidentLogDetector) ──
        # Filter to only the race session so the incident_log table contains
        # exclusively race incidents (avoids session_time collisions with
        # practice / qualifying events that share the 0–N seconds range).
        race_session_num = session_data.get("race_session_num")
        raw_incidents = session_data.get("incident_log", [])
        incident_rows = []
        for m in raw_incidents:
            if race_session_num is not None and m.get("SessionNum") != race_session_num:
                continue
            car_idx = m.get("CarIdx")
            if car_idx is None:
                continue
            incident_rows.append((
                int(car_idx),
                float(m.get("SessionTime", 0)),
                int(m.get("Lap", 0)),
                str(m.get("Description", "")),
                int(m.get("Incident", 0)),
                int(m.get("SessionNum", 0)),
                str(m.get("UserName", "")),
            ))
        if incident_rows:
            conn.executemany(
                "INSERT INTO incident_log "
                "(car_idx, session_time, lap, description, incident_points, session_num, user_name) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                incident_rows,
            )
            conn.commit()
            logger.info(
                "[Analysis] Stored %d incident_log entries (race session #%s)",
                len(incident_rows), race_session_num,
            )
        else:
            logger.info(
                "[Analysis] No incident_log entries to store "
                "(SessionLog empty or no race session match)"
            )

        if all_sessions:
            session_names = ", ".join(
                f"{s.get('name', s.get('type', '?'))} (#{s['index']})"
                for s in all_sessions
            )
            logger.info("[Analysis] Available sessions: %s", session_names)

        jumped_to_race = False
        if race_session_num is not None:
            self.on_progress("step_completed", {
                "project_id": self.project_id,
                "stage": "analysis_scan",
                "description": f"Jumping to race session #{race_session_num}...",
                "detail": f"Skipping practice/qualifying — jumping directly to race session (found {len(all_sessions)} sessions)",
                "progress_percent": 2,
            })

            # Jump directly to the start of the race session.
            # replay_search_session_time() is asynchronous — iRacing updates the
            # ReplaySessionNum telemetry var only after the seek is processed
            # (can take 1-3 seconds).  We MUST verify this instead of sleeping
            # a fixed 1s and blindly trusting it worked.
            if iracing_bridge.replay_search_session_time(race_session_num, 0):
                # Poll ReplaySessionNum for up to 5 seconds to confirm the jump
                jump_confirmed = False
                for _attempt in range(100):  # 100 × 0.05 s = 5 s max
                    await asyncio.sleep(0.05)
                    current_replay_sn = iracing_bridge.get_replay_session_num()
                    if current_replay_sn == race_session_num:
                        jump_confirmed = True
                        break

                if jump_confirmed:
                    jumped_to_race = True
                    logger.info(
                        "[Analysis] Jump to race session #%d confirmed (ReplaySessionNum validated)",
                        race_session_num,
                    )
                else:
                    # replay_search_session_time succeeded but ReplaySessionNum
                    # never updated — try advancing session-by-session as fallback
                    current_replay_sn = iracing_bridge.get_replay_session_num()
                    logger.warning(
                        "[Analysis] replay_search_session_time did not confirm "
                        "(ReplaySessionNum=%d, expected=%d) — trying next_session fallback",
                        current_replay_sn, race_session_num,
                    )
                    self.on_progress("step_completed", {
                        "project_id": self.project_id,
                        "stage": "analysis_scan",
                        "description": "Jump verification failed — trying session-by-session advance...",
                        "detail": (
                            f"ReplaySessionNum is {current_replay_sn}, not {race_session_num}. "
                            "Using next_session search as fallback."
                        ),
                        "progress_percent": 3,
                    })
                    # Advance through sessions one-by-one (RpySrchMode.next_session = 3)
                    for _step in range(race_session_num * 2 + 4):
                        current_replay_sn = iracing_bridge.get_replay_session_num()
                        if current_replay_sn >= race_session_num:
                            break
                        iracing_bridge.replay_search(3)  # next_session
                        # Wait for the session hop to register
                        for _w in range(30):  # up to 1.5 s per hop
                            await asyncio.sleep(0.05)
                            if iracing_bridge.get_replay_session_num() > current_replay_sn:
                                break

                    final_sn = iracing_bridge.get_replay_session_num()
                    if final_sn == race_session_num:
                        jumped_to_race = True
                        logger.info(
                            "[Analysis] next_session fallback succeeded — now at session #%d",
                            final_sn,
                        )
                    else:
                        logger.warning(
                            "[Analysis] Could not reach race session #%d (stuck at #%d) "
                            "— falling back to full-replay scan",
                            race_session_num, final_sn,
                        )
            else:
                logger.warning("[Analysis] replay_search_session_time call failed — falling back to full-replay scan")

        if not jumped_to_race:
            # Fallback: already at frame 0 from the initial rewind above
            self.on_progress("step_completed", {
                "project_id": self.project_id,
                "stage": "analysis_scan",
                "description": "Scanning from replay start...",
                "detail": "Could not jump to race session — scanning from beginning to find green flag",
                "progress_percent": 2,
            })

        # Now scan forward to find the exact frame where SessionState==Racing
        # AND ReplaySessionNum==race_session_num.
        # Use a higher speed when scanning from frame 0 (must skip practice/qual).
        skip_speed = SCAN_SPEED if jumped_to_race else 32
        speed_ok = await self._verified_set_speed(skip_speed, label="green-flag-scan")
        if not speed_ok:
            logger.warning(
                "[Analysis] Could not confirm replay speed %d× — iRacing may be paused or unresponsive",
                skip_speed,
            )
            self.on_progress("step_completed", {
                "project_id": self.project_id,
                "stage": "analysis_scan",
                "description": f"Speed {skip_speed}× not confirmed — continuing anyway...",
                "detail": "ReplayPlaySpeed did not update. Check that iRacing is in replay mode and not paused at start.",
                "progress_percent": 5,
            })

        self.on_progress("step_completed", {
            "project_id": self.project_id,
            "stage": "analysis_scan",
            "description": "Scanning for race start (green flag)...",
            "detail": (
                f"Fast-forwarding at {skip_speed}× speed — waiting for green flag in race session #{race_session_num}"
                if jumped_to_race else
                f"Fast-forwarding at {skip_speed}× speed — scanning entire replay to reach race session"
            ),
            "progress_percent": 5,
        })

        race_start_frame = 0
        race_start_session_time = 0.0
        race_start_found = False
        # Generous scan limit in both cases; session-number validation prevents
        # false positives from practice/qualifying RACING states.  At 0.02 s/tick:
        #   jumped → 3000 ticks = 60 real-s window within the race session
        #   full scan → 18000 ticks = 6 min to traverse a multi-session replay
        scan_limit = 3000 if jumped_to_race else 18000
        last_skip_log = -1
        for tick in range(scan_limit):
            if self._cancelled:
                iracing_bridge.set_replay_speed(0)
                return 0

            snapshot = self._capture_snapshot()
            if snapshot:
                # Use ReplaySessionNum (tracks replay position) not SessionNum
                # (tracks original live session — does NOT change during replay seeks).
                current_replay_sn = snapshot.get("replay_session_num", snapshot.get("session_num", 0))
                current_state = snapshot.get("session_state", 0)

                if current_state == SESSION_STATE_RACING:
                    # Validate we are in the correct session.
                    # Skip if race_session_num is known but we haven't reached it yet.
                    if race_session_num is not None and current_replay_sn != race_session_num:
                        if tick - last_skip_log >= 100:
                            last_skip_log = tick
                            self.on_progress("step_completed", {
                                "project_id": self.project_id,
                                "stage": "analysis_scan",
                                "description": f"Skipping session #{current_replay_sn} (not race)...",
                                "detail": (
                                    f"Currently in session #{current_replay_sn}, "
                                    f"race is session #{race_session_num} — fast-forwarding"
                                ),
                                "progress_percent": 5,
                            })
                        await asyncio.sleep(TICK_INTERVAL)
                        continue

                    # Found green flag in the correct session
                    race_start_frame = snapshot.get("replay_frame", 0)
                    race_start_session_time = snapshot.get("session_time", 0.0)
                    race_start_found = True
                    logger.info(
                        "[Analysis] Green flag detected: session=#%d state=%d frame=%d t=%.1fs",
                        current_replay_sn, current_state, race_start_frame, race_start_session_time,
                    )
                    break

                # Periodic progress while waiting for green flag
                if tick > 0 and tick % 250 == 0:
                    elapsed_race_s = snapshot.get("session_time", 0.0)
                    detail_parts = [f"Scanned {_format_time(elapsed_race_s)} of replay so far"]
                    if race_session_num is not None:
                        detail_parts.append(
                            f"session #{current_replay_sn} → looking for race session #{race_session_num}"
                        )
                    else:
                        detail_parts.append("waiting for racing to begin")
                    self.on_progress("step_completed", {
                        "project_id": self.project_id,
                        "stage": "analysis_scan",
                        "description": "Searching for green flag...",
                        "detail": " — ".join(detail_parts),
                        "progress_percent": 5,
                    })

            await asyncio.sleep(TICK_INTERVAL)

        if not race_start_found:
            # Scan limit exhausted without finding the race start.
            # This means either the jump failed, the replay has no RACING state,
            # or the session numbering is unexpected.
            snap = self._capture_snapshot()
            current_sn_now = (snap or {}).get("replay_session_num", (snap or {}).get("session_num", "?"))
            current_state_now = (snap or {}).get("session_state", "?")
            msg = (
                f"Could not find race green flag after {scan_limit} scan steps "
                f"(jumped_to_race={jumped_to_race}, race_session_num={race_session_num}, "
                f"currently in session #{current_sn_now} state={current_state_now}). "
                "Check that the correct replay is loaded and the race session exists."
            )
            logger.error("[Analysis] %s", msg)
            iracing_bridge.set_replay_speed(0)
            self.on_progress("error", {
                "project_id": self.project_id,
                "stage": "analysis_scan",
                "message": f"Race start not found: {msg}",
            })
            raise RuntimeError(msg)

        # Subtract 20 seconds (1200 frames at 60fps) to capture pre-race grid,
        # matching the original AnalyseRace.cs offset
        PRE_RACE_OFFSET_FRAMES = 60 * 20  # 20 seconds at 60fps
        PRE_RACE_OFFSET_SECONDS = 20.0
        race_start_frame = max(0, race_start_frame - PRE_RACE_OFFSET_FRAMES)
        race_start_session_time = max(0.0, race_start_session_time - PRE_RACE_OFFSET_SECONDS)

        logger.info(
            "[Analysis] Race start found: frame=%d, session_time=%.1fs (with %.0fs pre-race offset)",
            race_start_frame, race_start_session_time, PRE_RACE_OFFSET_SECONDS,
        )

        self.on_progress("step_completed", {
            "project_id": self.project_id,
            "stage": "analysis_scan",
            "description": "Race start identified!",
            "detail": f"Green flag at frame {race_start_frame + PRE_RACE_OFFSET_FRAMES:,} — rewinding 20 seconds for formation lap",
            "progress_percent": 10,
        })

        # Store for use during capture phase
        conn.execute(
            "INSERT OR REPLACE INTO analysis_meta (key, value) VALUES (?, ?)",
            ("race_start_frame", str(race_start_frame)),
        )
        conn.execute(
            "INSERT OR REPLACE INTO analysis_meta (key, value) VALUES (?, ?)",
            ("race_start_session_time", str(race_start_session_time)),
        )
        conn.execute(
            "INSERT OR REPLACE INTO analysis_meta (key, value) VALUES (?, ?)",
            ("race_session_num", str(race_session_num if race_session_num is not None else 0)),
        )
        conn.commit()

        # ── Phase B: Seek back to race start and begin captured scan ────────
        # Pause first so the seek isn't fighting a running replay.
        await self._verified_set_speed(0, label="pause-before-seek")
        seek_ok = await self._verified_seek(
            race_start_frame,
            label="race-start",
            tolerance=120,
        )
        if not seek_ok:
            current_frame = iracing_bridge.get_replay_frame()
            logger.warning(
                "[Analysis] Seek to race start frame %d not confirmed (ReplayFrameNum=%d) "
                "— proceeding from current position",
                race_start_frame, current_frame,
            )
            self.on_progress("step_completed", {
                "project_id": self.project_id,
                "stage": "analysis_scan",
                "description": "Race start seek not confirmed — starting from current position...",
                "detail": (
                    f"Expected frame {race_start_frame:,}, iRacing reports {current_frame:,}. "
                    "Scan will proceed from wherever the replay is positioned."
                ),
                "progress_percent": 11,
            })
        scan_speed_ok = await self._verified_set_speed(SCAN_SPEED, label="main-scan")
        if not scan_speed_ok:
            logger.error(
                "[Analysis] Cannot start main scan — replay speed %d× not confirmed. Aborting.",
                SCAN_SPEED,
            )
            self.on_progress("error", {
                "project_id": self.project_id,
                "stage": "analysis_scan",
                "message": (
                    f"Failed to set replay speed to {SCAN_SPEED}×. "
                    "iRacing is not responding to speed commands. "
                    "Try pausing and resuming the replay manually, then re-run analysis."
                ),
            })
            return 0

        last_progress = time.monotonic()
        all_finished = False
        last_session_time = 0.0
        first_session_time = race_start_session_time
        last_lap_num = 0

        self.on_progress("step_completed", {
            "project_id": self.project_id,
            "stage": "analysis_scan",
            "description": f"Recording telemetry at {SCAN_SPEED}× speed...",
            "detail": "Capturing car positions, surfaces, gaps, and camera switches every 20ms",
            "progress_percent": 12,
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
            current_lap = snapshot.get("race_laps", 0) or 0

            # Send progress update periodically
            now = time.monotonic()
            if now - last_progress >= PROGRESS_INTERVAL:
                elapsed_race = session_time - first_session_time
                # Build a description of what we're seeing
                if current_lap != last_lap_num and current_lap > 0:
                    lap_msg = f"Lap {current_lap}"
                else:
                    lap_msg = f"Lap {current_lap}" if current_lap > 0 else "Formation"
                last_lap_num = current_lap

                car_count = len(snapshot.get("car_states", []))
                detail = f"Tracking {car_count} cars · {writer.total_ticks:,} telemetry samples captured"

                self.on_progress("step_completed", {
                    "project_id": self.project_id,
                    "stage": "analysis_scan",
                    "description": f"{lap_msg} — {_format_time(session_time)} into race",
                    "detail": detail,
                    "current_time": round(session_time, 1),
                    "total_ticks": writer.total_ticks,
                    "current_lap": current_lap,
                    "car_count": car_count,
                    "message": f"Scanned {_format_time(session_time)} of race...",
                })
                last_progress = now

            # Check for race end: checkered flag + wait for cars to finish.
            # Reference: waits until all cars have seen the checkered OR
            # have retired / are off-track.  We poll for up to 30 real
            # seconds (= ~480 race seconds at 16×) after first seeing
            # checkered, which is a generous window for stragglers.
            if session_state >= SESSION_STATE_CHECKERED:
                self.on_progress("step_completed", {
                    "project_id": self.project_id,
                    "stage": "analysis_scan",
                    "description": "Checkered flag! Waiting for all cars to finish...",
                    "detail": "Continuing to record telemetry while remaining cars cross the line",
                    "progress_percent": 80,
                    "total_ticks": writer.total_ticks,
                })
                finish_poll_start = time.monotonic()
                MAX_FINISH_WAIT = 30.0  # real seconds (480 race seconds at 16×)
                last_speed_assert = time.monotonic()

                while time.monotonic() - finish_poll_start < MAX_FINISH_WAIT:
                    if self._cancelled:
                        break
                    # iRacing auto-pauses when the session state transitions to
                    # Checkered — re-assert speed every second to keep advancing.
                    now = time.monotonic()
                    if now - last_speed_assert >= 1.0:
                        iracing_bridge.set_replay_speed(SCAN_SPEED)
                        last_speed_assert = now
                    snap = self._capture_snapshot()
                    if snap:
                        writer.write_tick(snap)
                        # Check if all positioned cars have finished
                        car_states = snap.get("car_states", [])
                        if car_states:
                            all_done = all(
                                cs.get("surface") in (SURFACE_OFF_TRACK, SURFACE_IN_PIT, SURFACE_PIT_APRON)
                                or cs.get("lap_pct", 0) < 0.05  # crossed finish
                                for cs in car_states
                                if cs.get("position", 0) > 0
                            )
                            if all_done:
                                break
                        # If session moved to cooldown, all cars are definitely done
                        if snap.get("session_state", 0) >= SESSION_STATE_COOLDOWN:
                            break
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

    def _run_detect_in_thread(self) -> int:
        """Thread-pool entry: open a fresh DB connection and run event detection.

        Called via run_in_executor so the asyncio event loop stays free during
        the CPU-bound detection pass.  The on_progress callback is thread-safe
        (api_analysis._on_progress uses run_coroutine_threadsafe internally).
        """
        conn = get_project_db(self.project_dir)
        try:
            return self._detect_events(conn)
        finally:
            conn.close()

    def _detect_events(self, conn: sqlite3.Connection) -> int:
        """Pass 2: Run all event detectors on cached telemetry data.

        Emits individual progress events as each detector completes, including
        a summary of discovered events for the live event feed on the frontend.
        """
        total_events = 0
        session_info = dict(self.session_info)
        num_detectors = len(ALL_DETECTORS)

        # Detector display names for UI
        DETECTOR_LABELS = {
            "IncidentDetector": ("Incidents", "Scanning camera switches for off-track cars"),
            "BattleDetector": ("Battles", "Finding cars within close proximity for extended periods"),
            "OvertakeDetector": ("Overtakes", "Detecting position swaps with proximity verification"),
            "PitStopDetector": ("Pit Stops", "Identifying cars on pit surface for 5+ seconds"),
            "FastestLapDetector": ("Fastest Laps", "Finding new personal and session best lap times"),
            "LeaderChangeDetector": ("Leader Changes", "Tracking P1 position changes on track"),
            "PaceLapDetector": ("Pace Lap", "Detecting formation/pace lap before green flag"),
            "FirstLapDetector": ("First Lap", "Marking the opening lap of the race"),
            "LastLapDetector": ("Last Lap", "Marking the final lap before checkered"),
            "CrashDetector": ("Crashes", "Finding off-track excursions with significant time loss"),
            "SpinoutDetector": ("Spinouts", "Detecting brief off-track moments with moderate time loss"),
            "ContactDetector": ("Contacts", "Identifying multi-car off-track incidents at same location"),
            "CloseCallDetector": ("Close Calls", "Finding near-misses with proximity and brief off-track"),
        }

        # Get avg_lap_time from session data or estimate from telemetry
        if not session_info.get("avg_lap_time"):
            session_info["avg_lap_time"] = self._estimate_avg_lap_time(conn)

        for i, detector in enumerate(ALL_DETECTORS):
            detector_name = detector.__class__.__name__
            label, detail = DETECTOR_LABELS.get(detector_name, (detector_name, ""))
            progress_pct = 85 + int((i / num_detectors) * 12)  # 85% → 97%

            self.on_progress("step_completed", {
                "project_id": self.project_id,
                "stage": "analysis_detect",
                "description": f"Detecting {label.lower()}...",
                "detail": detail,
                "detector": detector_name,
                "progress_percent": progress_pct,
            })

            try:
                events = detector.detect(conn, session_info)
                if events:
                    count = insert_events_batch(conn, events)
                    total_events += count
                    conn.commit()
                    logger.info(
                        "[Analysis] %s: %d events", detector_name, count,
                    )

                    # Emit a sidebar log entry per event with human-readable detail
                    for ev in events:
                        desc, detail = format_event_log(ev, self._driver_map)
                        self.on_progress("step_completed", {
                            "project_id": self.project_id,
                            "stage": "analysis_detect",
                            "description": desc,
                            "detail": detail,
                            "detector": detector_name,
                            "progress_percent": progress_pct,
                        })

                    # Also emit each event to the live discovered-events feed
                    for ev in events:
                        car_indices = ev.get("involved_drivers", [])
                        self.on_progress("event_discovered", {
                            "project_id": self.project_id,
                            "event_type": ev.get("event_type", "unknown"),
                            "severity": ev.get("severity", 0),
                            "start_time": ev.get("start_time", 0),
                            "end_time": ev.get("end_time", 0),
                            "lap": ev.get("lap_number", 0),
                            "drivers": car_indices,
                            "driver_names": [
                                self._driver_map.get(idx, f"Car {idx}")
                                for idx in car_indices
                            ],
                            "detector": detector_name,
                        })
                else:
                    logger.info("[Analysis] %s: 0 events", detector_name)
                    self.on_progress("step_completed", {
                        "project_id": self.project_id,
                        "stage": "analysis_detect",
                        "description": f"{label}: 0 events found",
                        "detail": f"{detector_name} completed but found no matching patterns in the telemetry data",
                        "detector": detector_name,
                        "progress_percent": progress_pct,
                    })
            except Exception as exc:
                logger.error(
                    "[Analysis] %s failed: %s", detector_name, exc,
                )
                self.on_progress("step_completed", {
                    "project_id": self.project_id,
                    "stage": "analysis_detect",
                    "description": f"{label}: detection failed",
                    "detail": f"{detector_name} encountered an error: {exc}",
                    "detector": detector_name,
                    "progress_percent": progress_pct,
                })

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

    def start_rescan(
        self,
        project_id: int,
        project_dir: str,
        session_info: dict | None = None,
        on_progress: Callable[[str, dict], None] | None = None,
    ) -> bool:
        """Start a telemetry-only scan (Pass 1) for a project. Returns False if already running."""
        if self.is_running(project_id):
            return False

        analyzer = ReplayAnalyzer(
            project_id=project_id,
            project_dir=project_dir,
            session_info=session_info,
            on_progress=on_progress,
        )
        self._active[project_id] = analyzer

        task = asyncio.create_task(self._run_scan_only(project_id, analyzer))
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

    async def _run_scan_only(self, project_id: int, analyzer: ReplayAnalyzer) -> dict:
        """Execute scan-only pass and clean up when done."""
        try:
            result = await analyzer.scan_only()
            return result
        except Exception as exc:
            logger.error("[AnalysisManager] Scan failed for project %d: %s", project_id, exc)
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
