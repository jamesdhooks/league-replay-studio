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
                if dt > 0 and dt < 2.0:  # Guard against large time gaps
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
            car_speed = car.get("speed_ms") or speed_ms

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
                car.get("f2_time", None),
                car.get("last_lap_time", -1.0),
                car.get("steer_angle", None),
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
                    surface, est_time, best_lap_time, speed_ms, f2_time, last_lap_time, steer_angle)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
        """Persist the full analysis log to a JSON file in the project directory."""
        try:
            log_path = Path(self.project_dir) / "analysis_log.json"
            log_path.write_text(json.dumps(self._log_entries, indent=2, default=str))
            logger.info("[Analysis] Saved analysis log to %s", log_path)
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

            # Pass 2: Detect events
            num_detectors = len(ALL_DETECTORS)
            self.on_progress("step_completed", {
                "project_id": self.project_id,
                "stage": "analysis_detect",
                "description": "Running event detectors on telemetry data...",
                "detail": f"Analysing {total_ticks:,} telemetry samples with {num_detectors} event detectors",
                "progress_percent": 85,
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

        # ── Phase A: Jump to race session & find start frame ─────────────
        self.on_progress("step_completed", {
            "project_id": self.project_id,
            "stage": "analysis_scan",
            "description": "Locating race session...",
            "detail": "Reading session info to identify race, qualifying, and practice sessions",
            "progress_percent": 0,
        })

        # Try to find the race session index from session info
        session_data = iracing_bridge.session_data
        race_session_num = session_data.get("race_session_num")
        all_sessions = session_data.get("sessions", [])

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

            # Jump directly to the start of the race session
            if iracing_bridge.replay_search_session_time(race_session_num, 0):
                await asyncio.sleep(1.0)  # Wait for iRacing to seek
                jumped_to_race = True
                logger.info(
                    "[Analysis] Jumped to race session #%d via replay_search_session_time",
                    race_session_num,
                )
            else:
                logger.warning("[Analysis] replay_search_session_time failed, falling back")

        if not jumped_to_race:
            # Fallback: seek to beginning and scan forward
            self.on_progress("step_completed", {
                "project_id": self.project_id,
                "stage": "analysis_scan",
                "description": "Seeking to replay start...",
                "detail": "Could not identify race session — scanning from beginning at 16× speed",
                "progress_percent": 1,
            })
            iracing_bridge.seek_to_frame(0)
            await asyncio.sleep(0.5)

        # Now scan forward at 16× to find the exact moment SessionState==Racing
        # Use a higher speed when scanning from frame 0 (must skip practice/qual)
        skip_speed = SCAN_SPEED if jumped_to_race else 32
        iracing_bridge.set_replay_speed(skip_speed)

        self.on_progress("step_completed", {
            "project_id": self.project_id,
            "stage": "analysis_scan",
            "description": "Scanning for race start (green flag)...",
            "detail": (
                "Fast-forwarding at 16× speed, waiting for SessionState to change to Racing (green flag drop)"
                if jumped_to_race else
                f"Fast-forwarding at {skip_speed}× speed — skipping practice/qualifying sessions to find race green flag"
            ),
            "progress_percent": 5,
        })

        race_start_frame = 0
        race_start_session_time = 0.0
        scan_limit = 1500 if jumped_to_race else 12000  # Longer limit when scanning from start (must traverse practice/qual)
        for tick in range(scan_limit):
            if self._cancelled:
                iracing_bridge.set_replay_speed(0)
                return 0

            snapshot = self._capture_snapshot()
            if snapshot and snapshot.get("session_state") == SESSION_STATE_RACING:
                # If we know the race session number, verify we're actually in
                # the race session — not practice or qualifying (which also have
                # session_state == RACING).
                current_session_num = snapshot.get("session_num")
                if race_session_num is not None and current_session_num is not None:
                    if current_session_num != race_session_num:
                        # Still in practice/qualifying — keep scanning
                        if tick > 0 and tick % 500 == 0:
                            self.on_progress("step_completed", {
                                "project_id": self.project_id,
                                "stage": "analysis_scan",
                                "description": f"Skipping session #{current_session_num} (not race)...",
                                "detail": f"Currently in session #{current_session_num}, race is session #{race_session_num} — fast-forwarding",
                                "progress_percent": 5,
                            })
                        await asyncio.sleep(TICK_INTERVAL)
                        continue

                race_start_frame = snapshot.get("replay_frame", 0)
                race_start_session_time = snapshot.get("session_time", 0.0)
                break

            # Periodic progress during race-start search
            if tick > 0 and tick % 250 == 0:
                elapsed_race_s = (snapshot or {}).get("session_time", 0.0)
                current_sn = (snapshot or {}).get("session_num")
                detail_parts = [f"Scanned {_format_time(elapsed_race_s)} of replay so far"]
                if current_sn is not None and race_session_num is not None:
                    detail_parts.append(f"in session #{current_sn}, looking for race session #{race_session_num}")
                else:
                    detail_parts.append("waiting for racing to begin")
                self.on_progress("step_completed", {
                    "project_id": self.project_id,
                    "stage": "analysis_scan",
                    "description": "Still searching for green flag...",
                    "detail": " — ".join(detail_parts),
                    "progress_percent": 5,
                })

            await asyncio.sleep(TICK_INTERVAL)

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
        conn.commit()

        # ── Phase B: Seek back to race start and begin captured scan ────────
        iracing_bridge.set_replay_speed(0)
        await asyncio.sleep(0.3)
        iracing_bridge.seek_to_frame(race_start_frame)
        await asyncio.sleep(0.5)
        iracing_bridge.set_replay_speed(SCAN_SPEED)

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

                while time.monotonic() - finish_poll_start < MAX_FINISH_WAIT:
                    if self._cancelled:
                        break
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

                    # Emit each discovered event for the live frontend feed
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
                    # Log zero-event detectors in the analysis feed for diagnostics
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
