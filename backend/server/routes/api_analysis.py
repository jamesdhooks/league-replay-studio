"""
api_analysis.py
---------------
REST endpoints for the replay analysis engine.

  POST /api/projects/{id}/analyze      — Start analysis
  POST /api/projects/{id}/analyze/cancel — Cancel running analysis
  GET  /api/projects/{id}/analysis/status — Get analysis status
  GET  /api/projects/{id}/events       — List detected events
  GET  /api/projects/{id}/events/summary — Event count summary by type
  POST /api/projects/{id}/events       — Create an event (undo support)
  GET  /api/projects/{id}/events/{eid} — Get a single event
  PUT  /api/projects/{id}/events/{eid} — Update an event
  DELETE /api/projects/{id}/events/{eid} — Delete an event
  POST /api/projects/{id}/events/{eid}/split — Split an event at a timestamp
  GET  /api/projects/{id}/analysis/race-duration — Get total race duration
  GET  /api/projects/{id}/highlights/config — Get highlight configuration
  PUT  /api/projects/{id}/highlights/config — Save highlight configuration
  POST /api/projects/{id}/highlights/apply — Batch apply highlight selections
  POST /api/projects/{id}/highlights/reprocess — Run full scoring pipeline
  GET  /api/projects/{id}/scored-events — Get scored + tiered events
  GET  /api/projects/{id}/analysis/drivers — Get driver list
  GET  /api/highlights/presets — List global highlight presets
  POST /api/highlights/presets — Save a global highlight preset
  DELETE /api/highlights/presets/{name} — Delete a global highlight preset
  POST /api/projects/{id}/analyze/rescan — Re-collect telemetry (scan only, no detection)
  GET  /api/projects/{id}/analysis/tuning — Get saved tuning parameters
  PUT  /api/projects/{id}/analysis/tuning — Save tuning parameters
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from server.services.project_service import project_service
from server.services.replay_analysis import analysis_manager
from server.services.analysis_db import (
    get_project_db,
    init_analysis_db,
    clear_analysis_data,
    get_events,
    count_events,
    insert_events_batch,
    get_analysis_status as db_get_analysis_status,
    get_highlight_config,
    save_highlight_config,
    batch_update_highlight_flags,
    get_drivers,
    save_tuning_params,
    load_tuning_params,
)
from server.services.detectors import ALL_DETECTORS
from server.services.replay_analysis import ReplayAnalyzer

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["analysis"])

# ── WebSocket broadcaster (set by app.py at startup) ─────────────────────────
_broadcast_fn: Any = None


def set_broadcast_fn(fn: Any) -> None:
    """Set the WebSocket broadcast function (called from app.py)."""
    global _broadcast_fn
    _broadcast_fn = fn


def _on_progress(event_type: str, data: dict) -> None:
    """Broadcast analysis progress to WebSocket clients."""
    if _broadcast_fn is not None:
        message = {"event": f"pipeline:{event_type}", "data": data}
        try:
            _broadcast_fn(message)
        except Exception as exc:
            logger.debug("[Analysis API] Broadcast error: %s", exc)


# ── Request/Response models ──────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    """Optional parameters for starting analysis."""
    battle_gap_threshold: Optional[float] = None
    crash_min_time_loss: Optional[float] = None
    crash_min_off_track_duration: Optional[float] = None
    spinout_min_time_loss: Optional[float] = None
    spinout_max_time_loss: Optional[float] = None
    contact_time_window: Optional[float] = None
    contact_proximity: Optional[float] = None
    close_call_proximity: Optional[float] = None
    close_call_max_off_track: Optional[float] = None
    force_rescan: bool = False


class RedetectRequest(BaseModel):
    """Parameters for re-running detection with tuned thresholds."""
    battle_gap_threshold: Optional[float] = 0.5
    crash_min_time_loss: Optional[float] = 10.0
    crash_min_off_track_duration: Optional[float] = 3.0
    spinout_min_time_loss: Optional[float] = 2.0
    spinout_max_time_loss: Optional[float] = 10.0
    contact_time_window: Optional[float] = 2.0
    contact_proximity: Optional[float] = 0.05
    close_call_proximity: Optional[float] = 0.02
    close_call_max_off_track: Optional[float] = 3.0


class EventsResponse(BaseModel):
    """Response for event listing."""
    events: list[dict]
    total: int
    skip: int
    limit: int


# ── Helpers ──────────────────────────────────────────────────────────────────

def _build_session_info_from_body(body) -> dict:
    """Extract tuning parameters from a request body into a session_info dict."""
    info: dict[str, Any] = {}
    param_keys = [
        "battle_gap_threshold", "crash_min_time_loss", "crash_min_off_track_duration",
        "spinout_min_time_loss", "spinout_max_time_loss", "contact_time_window",
        "contact_proximity", "close_call_proximity", "close_call_max_off_track",
    ]
    if body:
        for key in param_keys:
            val = getattr(body, key, None)
            if val is not None:
                info[key] = val
    return info


def _run_redetect_sync(project_id: int, project_dir: str, session_info: dict) -> int:
    """Synchronous core of redetect — runs in a thread pool via run_in_executor.

    All _on_progress calls are thread-safe because _analysis_broadcast uses
    run_coroutine_threadsafe internally.
    """
    conn = get_project_db(project_dir)
    try:
        # Check for existing telemetry data
        tick_count = conn.execute("SELECT COUNT(*) FROM race_ticks").fetchone()[0]
        if tick_count == 0:
            raise ValueError("No telemetry data found. Run a full analysis first.")

        # Clear existing events
        conn.execute("DELETE FROM race_events")
        conn.commit()

        # Build driver map from stored drivers
        drivers = get_drivers(conn)
        driver_map: dict[int, str] = {}
        driver_list = []
        for d in drivers:
            idx = d.get("car_idx")
            if idx is not None:
                driver_map[idx] = d.get("user_name", f"#{d.get('car_number', idx)}")
                driver_list.append(d)
        session_info["drivers"] = driver_list

        # Estimate average lap time
        if not session_info.get("avg_lap_time"):
            session_info["avg_lap_time"] = ReplayAnalyzer._estimate_avg_lap_time(conn)

        # Broadcast start
        _on_progress("step_completed", {
            "project_id": project_id,
            "stage": "redetect_start",
            "description": "Re-detecting events with tuned parameters...",
            "progress_percent": 0,
        })

        total = 0
        num_detectors = len(ALL_DETECTORS)

        for i, detector in enumerate(ALL_DETECTORS):
            detector_name = detector.__class__.__name__
            progress_pct = int((i / num_detectors) * 100)

            _on_progress("step_completed", {
                "project_id": project_id,
                "stage": "redetect",
                "description": f"Detecting {detector_name}...",
                "detector": detector_name,
                "progress_percent": progress_pct,
            })

            try:
                events = detector.detect(conn, session_info)
                if events:
                    count = insert_events_batch(conn, events)
                    total += count
                    conn.commit()

                    for ev in events:
                        car_indices = ev.get("involved_drivers", [])
                        _on_progress("event_discovered", {
                            "project_id": project_id,
                            "event_type": ev.get("event_type", "unknown"),
                            "severity": ev.get("severity", 0),
                            "start_time": ev.get("start_time", 0),
                            "end_time": ev.get("end_time", 0),
                            "lap": ev.get("lap_number", 0),
                            "drivers": car_indices,
                            "driver_names": [
                                driver_map.get(idx, f"Car {idx}")
                                for idx in car_indices
                            ],
                            "detector": detector_name,
                        })
            except Exception as exc:
                logger.error("[Redetect] %s failed: %s", detector_name, exc)

        _on_progress("step_completed", {
            "project_id": project_id,
            "stage": "redetect_complete",
            "description": f"Re-detection complete — {total} events found",
            "progress_percent": 100,
        })

        return total
    finally:
        conn.close()


async def _run_redetect(project_id: int, project_dir: str, session_info: dict) -> int:
    """Re-run ONLY the event detection pass with new tuning parameters."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, _run_redetect_sync, project_id, project_dir, session_info
    )


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/analyze")
async def start_analysis(project_id: int, body: AnalyzeRequest | None = None):
    """Start replay analysis for a project.

    If analysis is already running, returns 409 Conflict.
    If iRacing is not connected, falls back to mock analysis.
    """
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if analysis_manager.is_running(project_id):
        raise HTTPException(
            status_code=409,
            detail="Analysis is already running for this project",
        )

    project_dir = project["project_dir"]

    # Build session info from project + bridge
    from server.services.iracing_bridge import bridge as iracing_bridge
    session_info = dict(iracing_bridge.session_data) if iracing_bridge.is_connected else {}
    session_info.update(_build_session_info_from_body(body))

    # Start background analysis
    started = analysis_manager.start(
        project_id=project_id,
        project_dir=project_dir,
        session_info=session_info,
        on_progress=_on_progress,
    )

    if not started:
        raise HTTPException(status_code=500, detail="Failed to start analysis")

    # Advance project to analysis step
    try:
        project_service.update_project(project_id, {"current_step": "analysis"})
    except Exception:
        pass  # Non-critical — don't fail the analysis

    logger.info("[Analysis API] Started analysis for project #%d", project_id)
    return {"status": "started", "project_id": project_id}


@router.post("/projects/{project_id}/analyze/cancel")
async def cancel_analysis(project_id: int):
    """Cancel a running analysis."""
    if not analysis_manager.is_running(project_id):
        raise HTTPException(status_code=404, detail="No running analysis for this project")

    analysis_manager.cancel(project_id)
    logger.info("[Analysis API] Cancelled analysis for project #%d", project_id)
    return {"status": "cancelled", "project_id": project_id}


@router.post("/projects/{project_id}/analyze/rescan")
async def rescan_telemetry(project_id: int, body: AnalyzeRequest | None = None):
    """Re-collect telemetry from the iRacing replay (Pass 1 only).

    Clears all existing telemetry AND events, then re-runs the 16× scan.
    Event detection is NOT run — call /analyze/redetect afterwards.
    Requires an active iRacing connection.
    """
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if analysis_manager.is_running(project_id):
        raise HTTPException(
            status_code=409,
            detail="Analysis is already running for this project",
        )

    project_dir = project["project_dir"]

    from server.services.iracing_bridge import bridge as iracing_bridge
    session_info = dict(iracing_bridge.session_data) if iracing_bridge.is_connected else {}
    session_info.update(_build_session_info_from_body(body) if body else {})

    started = analysis_manager.start_rescan(
        project_id=project_id,
        project_dir=project_dir,
        session_info=session_info,
        on_progress=_on_progress,
    )

    if not started:
        raise HTTPException(status_code=500, detail="Failed to start rescan")

    logger.info("[Analysis API] Started rescan for project #%d", project_id)
    return {"status": "started", "project_id": project_id, "phase": "scan"}


@router.post("/projects/{project_id}/analyze/redetect")
async def redetect_events(project_id: int, body: RedetectRequest):
    """Re-run ONLY the event detection pass with new tuning parameters.

    Requires existing telemetry data (from a previous analysis scan).
    Saves the supplied tuning parameters to the project database.
    """
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if analysis_manager.is_running(project_id):
        raise HTTPException(
            status_code=409,
            detail="Analysis is already running for this project",
        )

    project_dir = project["project_dir"]
    session_info = _build_session_info_from_body(body)

    # Persist tuning params so they survive page refresh
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            save_tuning_params(conn, {k: v for k, v in vars(body).items()
                                       if k in [
                                           "battle_gap_threshold", "crash_min_time_loss",
                                           "crash_min_off_track_duration", "spinout_min_time_loss",
                                           "spinout_max_time_loss", "contact_time_window",
                                           "contact_proximity", "close_call_proximity",
                                           "close_call_max_off_track",
                                       ] and v is not None})
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("[Analysis API] Could not save tuning params: %s", exc)

    try:
        total = await _run_redetect(project_id, project_dir, session_info)
        logger.info(
            "[Analysis API] Redetect for project #%d: %d events", project_id, total,
        )
        return {"status": "completed", "project_id": project_id, "total_events": total}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("[Analysis API] Redetect failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/projects/{project_id}/analysis")
async def clear_analysis(project_id: int):
    """Clear all analysis data for a project (events, telemetry, runs)."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if analysis_manager.is_running(project_id):
        analysis_manager.cancel(project_id)

    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            clear_analysis_data(conn)
            # Clear analysis runs too
            conn.execute("DELETE FROM analysis_runs")
            conn.commit()
        finally:
            conn.close()

        # Remove analysis log file
        from pathlib import Path
        log_path = Path(project_dir) / "analysis_log.json"
        if log_path.exists():
            log_path.unlink()

        logger.info("[Analysis API] Cleared analysis for project #%d", project_id)
        return {"status": "cleared", "project_id": project_id}
    except Exception as exc:
        logger.error("[Analysis API] Clear error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/projects/{project_id}/analysis/status")
async def get_analysis_status(project_id: int):
    """Get the current analysis status for a project.

    Returns has_telemetry and has_events flags so the frontend can
    determine which phase controls to show.
    """
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]

    # Check if actively running
    is_running = analysis_manager.is_running(project_id)

    # Check database for most recent run + live counts
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            db_status = db_get_analysis_status(conn)
            db_status["project_id"] = project_id
            if is_running:
                db_status["status"] = "running"
            # Attach saved tuning params if available
            saved_tuning = load_tuning_params(conn)
            if saved_tuning:
                db_status["tuning_params"] = saved_tuning
            return db_status
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("[Analysis API] Status check error: %s", exc)
        return {"status": "none", "project_id": project_id,
                "has_telemetry": False, "has_events": False}


@router.get("/projects/{project_id}/analysis/session-match")
async def session_match(project_id: int):
    """Compare the current iRacing session against the fingerprint recorded during analysis.

    Returns:
      status:  "match"         — same track + same driver roster
               "mismatch"      — connected but wrong replay loaded
               "partial"       — track matches but driver set differs
               "no_fingerprint"— analysis hasn't run yet for this project
               "not_connected" — iRacing is not running
    """
    from server.services.iracing_bridge import bridge as iracing_bridge

    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    stored_fp = None
    try:
        init_analysis_db(project["project_dir"])
        conn = get_project_db(project["project_dir"])
        try:
            row = conn.execute(
                "SELECT value FROM analysis_meta WHERE key = 'session_fingerprint'"
            ).fetchone()
            if row:
                stored_fp = json.loads(row[0])
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("[Analysis API] session-match DB error: %s", exc)

    if stored_fp is None:
        return {"status": "no_fingerprint", "details": "No analysis run yet.", "stored": None, "current": None}

    if not iracing_bridge.is_connected:
        return {"status": "not_connected", "details": "iRacing is not running.", "stored": stored_fp, "current": None}

    sd = iracing_bridge.session_data
    current = {
        "track_name":      sd.get("track_name", ""),
        "track_id":        sd.get("track_id", 0),
        "subsession_id":   sd.get("subsession_id", 0),
        "driver_count":    len([d for d in sd.get("drivers", []) if not d.get("is_spectator")]),
        "driver_cust_ids": sd.get("driver_cust_ids", []),
    }

    stored_sub  = stored_fp.get("subsession_id", 0)
    current_sub = current["subsession_id"]
    if stored_sub and current_sub and stored_sub == current_sub:
        return {"status": "match", "match_type": "subsession_id",
                "details": f"Exact match — SubsessionID {stored_sub}.",
                "stored": stored_fp, "current": current}

    stored_track  = stored_fp.get("track_id", 0)
    current_track = current["track_id"]
    track_id_match = bool(stored_track and current_track and stored_track == current_track)
    stored_name  = (stored_fp.get("track_name") or "").lower().strip()
    current_name = (current["track_name"] or "").lower().strip()
    name_match = bool(stored_name and current_name and stored_name == current_name)
    track_match = track_id_match or name_match

    stored_ids  = set(stored_fp.get("driver_cust_ids") or [])
    current_ids = set(current["driver_cust_ids"] or [])
    shared = stored_ids & current_ids
    driver_pct = len(shared) / max(len(stored_ids), 1)

    if track_match and driver_pct >= 0.75:
        return {"status": "match", "match_type": "track_and_drivers",
                "details": f"Track '{current['track_name']}' matches and {len(shared)}/{len(stored_ids)} drivers present ({driver_pct:.0%}).",
                "stored": stored_fp, "current": current}

    if track_match:
        return {"status": "partial", "match_type": "track_only",
                "details": f"Track matches ('{current['track_name']}') but only {len(shared)}/{len(stored_ids)} drivers overlap ({driver_pct:.0%}). Possibly a different race on the same track.",
                "stored": stored_fp, "current": current}

    return {"status": "mismatch", "match_type": None,
            "details": f"Wrong replay. Expected '{stored_fp.get('track_name')}' (ID {stored_track}), got '{current['track_name']}' (ID {current_track}).",
            "stored": stored_fp, "current": current}


@router.get("/projects/{project_id}/analysis/tuning")
async def get_tuning_params(project_id: int):
    """Get saved detection tuning parameters for a project."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            params = load_tuning_params(conn)
            return {"tuning_params": params}
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("[Analysis API] Tuning params fetch error: %s", exc)
        return {"tuning_params": None}


@router.put("/projects/{project_id}/analysis/tuning")
async def save_tuning(project_id: int, body: RedetectRequest):
    """Save detection tuning parameters for a project (without running re-detection)."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            params = {k: v for k, v in vars(body).items()
                      if k in [
                          "battle_gap_threshold", "crash_min_time_loss",
                          "crash_min_off_track_duration", "spinout_min_time_loss",
                          "spinout_max_time_loss", "contact_time_window",
                          "contact_proximity", "close_call_proximity",
                          "close_call_max_off_track",
                      ] and v is not None}
            save_tuning_params(conn, params)
            return {"status": "saved", "tuning_params": params}
        finally:
            conn.close()
    except Exception as exc:
        logger.error("[Analysis API] Save tuning error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


class SeekEventRequest(BaseModel):
    """Request body for seeking the replay to an event."""
    start_time_seconds: float = Field(..., ge=0)
    car_idx: int | None = Field(None)


@router.post("/projects/{project_id}/analysis/seek-event")
async def seek_to_event(project_id: int, body: SeekEventRequest):
    """Seek the iRacing replay to a specific analysis event time.

    Combines two sources of truth so neither alone can fail:
      1.  race_ticks   — look up the replay_frame nearest to start_time_seconds.
                         Frame-based seeking is session-agnostic (global index).
      2.  analysis_meta — race_session_num + race_start_session_time, used as
                         fallback via replay_search_session_time if frame = 0.

    This runs entirely server-side so the frontend never needs to know
    the race session number or worry about stale start_frame values in events.
    """
    from server.services.iracing_bridge import bridge as iracing_bridge

    if not iracing_bridge.is_connected:
        raise HTTPException(status_code=409, detail="iRacing is not connected")

    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            # 1. Find the replay frame closest to the requested time
            tick_row = conn.execute(
                """SELECT replay_frame, session_time
                   FROM race_ticks
                   ORDER BY ABS(session_time - ?) LIMIT 1""",
                (body.start_time_seconds,)
            ).fetchone()

            frame = tick_row["replay_frame"] if tick_row else 0
            session_time = tick_row["session_time"] if tick_row else body.start_time_seconds

            # 2. Read race session metadata as fallback
            def _meta(key, default):
                r = conn.execute(
                    "SELECT value FROM analysis_meta WHERE key=?", (key,)
                ).fetchone()
                return r[0] if r else default

            race_session_num = int(_meta("race_session_num", 0))
        finally:
            conn.close()
    except Exception as exc:
        logger.error("[Analysis API] seek-event DB error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    loop = asyncio.get_running_loop()

    def _snapshot() -> dict:
        snap = iracing_bridge.capture_snapshot()
        if snap is None:
            return {"actual_frame": None, "actual_session_time": None}
        return {
            "actual_frame": snap.get("replay_frame"),
            "actual_session_time": snap.get("session_time"),
        }

    # 3. PAUSE FIRST.
    #    iRacing silently ignores replay_set_play_position while playing.
    logger.info("[Analysis API] seek-event: pausing replay before seek")
    await loop.run_in_executor(None, iracing_bridge.set_replay_speed, 0)
    await asyncio.sleep(0.15)

    # 4. Frame-based seek (primary) — falls back to session_time if frame=0
    if frame > 0:
        logger.info(
            "[Analysis API] seek-event: frame-based seek → frame=%d  (session_time=%.3f)",
            frame, session_time,
        )
        ok = await loop.run_in_executor(None, iracing_bridge.seek_to_frame, frame)
    else:
        logger.warning(
            "[Analysis API] seek-event: no replay_frame for session_time=%.3f — "
            "using replay_search_session_time(session_num=%d, time_ms=%d)",
            body.start_time_seconds, race_session_num, int(body.start_time_seconds * 1000),
        )
        time_ms = int(session_time * 1000)
        ok = await loop.run_in_executor(
            None, iracing_bridge.replay_search_session_time, race_session_num, time_ms
        )

    if not ok:
        logger.error(
            "[Analysis API] seek-event: seek command returned False "
            "(frame=%d, session_num=%d, time=%.3f)",
            frame, race_session_num, body.start_time_seconds,
        )
        raise HTTPException(status_code=500, detail="iRacing seek command failed — is a replay loaded?")

    # 5. Switch camera while still paused (cleaner cut).
    if body.car_idx is not None:
        logger.info("[Analysis API] seek-event: switching camera to car_idx=%d", body.car_idx)
        await loop.run_in_executor(None, iracing_bridge.cam_switch_car, body.car_idx, 0)

    # 6. Resume playback.
    #    IMPORTANT: ReplayFrameNum in telemetry is 0/stale while paused — iRacing
    #    does not update shared-memory variables when the replay is frozen. We must
    #    resume first, let at least one telemetry tick propagate, then verify.
    await asyncio.sleep(0.1)
    await loop.run_in_executor(None, iracing_bridge.set_replay_speed, 1)
    await asyncio.sleep(0.35)

    # 7. Verify frame position now that the replay is running and telemetry is live.
    TOL_FRAMES = 360   # 6 s at 60 Hz — generous; accounts for resume lag + seek imprecision
    verification = await loop.run_in_executor(None, _snapshot)
    actual_frame = verification["actual_frame"]
    actual_time  = verification["actual_session_time"]

    if actual_frame is None or actual_frame == 0:
        # Telemetry unreadable — can't confirm, but don't fail. Treat as success.
        verified = True
        logger.info(
            "[Analysis API] seek-event: telemetry unreadable after resume — "
            "assuming seek ok (frame=%d)", frame,
        )
    elif frame > 0 and abs(actual_frame - frame) > TOL_FRAMES:
        verified = False
        logger.warning(
            "[Analysis API] seek-event: MISMATCH after resume — "
            "target_frame=%d  actual_frame=%d  actual_time=%.3f  drift=%d frames",
            frame, actual_frame, actual_time or 0, abs(actual_frame - frame),
        )
    else:
        verified = True
        logger.info(
            "[Analysis API] seek-event: verified after resume — "
            "actual_frame=%d  actual_time=%.3f  drift=%d frames",
            actual_frame, actual_time or 0,
            abs((actual_frame or 0) - frame) if frame > 0 else 0,
        )

    return {
        "status": "ok",
        "frame": frame,
        "session_time": session_time,
        "race_session_num": race_session_num,
        "verified": verified,
        "actual_frame": actual_frame,
        "actual_session_time": actual_time,
    }


@router.get("/projects/{project_id}/events")
async def list_events(
    project_id: int,
    event_type: str = Query("", description="Filter by event type"),
    min_severity: int = Query(0, ge=0, le=10, description="Minimum severity"),
    skip: int = Query(0, ge=0, description="Offset for pagination"),
    limit: int = Query(200, ge=1, le=1000, description="Max events to return"),
):
    """List detected race events for a project."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            events = get_events(
                conn,
                event_type=event_type,
                min_severity=min_severity,
                skip=skip,
                limit=limit,
            )
            total = count_events(conn, event_type=event_type)
            return {
                "events": events,
                "total": total,
                "skip": skip,
                "limit": limit,
            }
        finally:
            conn.close()
    except Exception as exc:
        logger.error("[Analysis API] Event list error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/projects/{project_id}/events/summary")
async def event_summary(project_id: int):
    """Get a summary of detected events grouped by type."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            rows = conn.execute("""
                SELECT event_type, COUNT(*) AS count,
                       AVG(severity) AS avg_severity,
                       SUM(end_time_seconds - start_time_seconds) AS total_duration
                FROM race_events
                GROUP BY event_type
                ORDER BY count DESC
            """).fetchall()
            summary = [
                {
                    "event_type": r["event_type"],
                    "count": r["count"],
                    "avg_severity": round(r["avg_severity"], 1) if r["avg_severity"] else 0,
                    "total_duration": round(r["total_duration"], 1) if r["total_duration"] else 0,
                }
                for r in rows
            ]
            total = sum(s["count"] for s in summary)
            return {
                "project_id": project_id,
                "total_events": total,
                "by_type": summary,
            }
        finally:
            conn.close()
    except Exception as exc:
        logger.error("[Analysis API] Event summary error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/projects/{project_id}/analysis/log")
async def get_analysis_log(project_id: int):
    """Load the persisted analysis log from the project directory."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    from pathlib import Path
    log_path = Path(project["project_dir"]) / "analysis_log.json"
    if not log_path.exists():
        return {"entries": []}

    import json as _json
    try:
        entries = _json.loads(log_path.read_text())
        return {"entries": entries}
    except Exception:
        return {"entries": []}


# ── Event editing endpoints (Feature 8: Timeline Editor) ─────────────────────

class EventUpdateRequest(BaseModel):
    """Fields that can be updated on an event."""
    start_time_seconds: Optional[float] = None
    end_time_seconds: Optional[float] = None
    start_frame: Optional[int] = None
    end_frame: Optional[int] = None
    severity: Optional[int] = None
    event_type: Optional[str] = None
    included_in_highlight: Optional[bool] = None
    involved_drivers: Optional[list[int]] = None


class EventSplitRequest(BaseModel):
    """Split point for dividing an event into two."""
    split_time: float


@router.put("/projects/{project_id}/events/{event_id}")
async def update_event(project_id: int, event_id: int, body: EventUpdateRequest):
    """Update a race event (e.g., drag-resize on timeline)."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        conn = get_project_db(project_dir)
        try:
            # Verify event exists
            row = conn.execute(
                "SELECT id FROM race_events WHERE id = ?", (event_id,)
            ).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Event not found")

            # Build dynamic SET clause from provided fields
            updates: list[str] = []
            params: list[Any] = []
            if body.start_time_seconds is not None:
                updates.append("start_time_seconds = ?")
                params.append(body.start_time_seconds)
            if body.end_time_seconds is not None:
                updates.append("end_time_seconds = ?")
                params.append(body.end_time_seconds)
            if body.start_frame is not None:
                updates.append("start_frame = ?")
                params.append(body.start_frame)
            if body.end_frame is not None:
                updates.append("end_frame = ?")
                params.append(body.end_frame)
            if body.severity is not None:
                updates.append("severity = ?")
                params.append(max(0, min(10, body.severity)))
            if body.event_type is not None:
                updates.append("event_type = ?")
                params.append(body.event_type)
            if body.included_in_highlight is not None:
                updates.append("included_in_highlight = ?")
                params.append(1 if body.included_in_highlight else 0)
            if body.involved_drivers is not None:
                updates.append("involved_drivers = ?")
                params.append(json.dumps(body.involved_drivers))

            if not updates:
                raise HTTPException(status_code=400, detail="No fields to update")

            # Always mark as user-modified
            updates.append("user_modified = 1")
            params.append(event_id)

            conn.execute(
                f"UPDATE race_events SET {', '.join(updates)} WHERE id = ?",
                params,
            )
            conn.commit()

            # Return updated event
            updated = conn.execute(
                "SELECT * FROM race_events WHERE id = ?", (event_id,)
            ).fetchone()
            d = dict(updated)
            try:
                d["involved_drivers"] = json.loads(d.get("involved_drivers", "[]"))
            except (json.JSONDecodeError, TypeError):
                d["involved_drivers"] = []
            try:
                d["metadata"] = json.loads(d.get("metadata", "{}"))
            except (json.JSONDecodeError, TypeError):
                d["metadata"] = {}

            logger.info("[Analysis API] Updated event #%d", event_id)
            return d
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[Analysis API] Event update error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


class EventCreateRequest(BaseModel):
    """Fields for creating a new event (used by undo-delete)."""
    event_type: str
    start_time_seconds: float
    end_time_seconds: float
    start_frame: int = 0
    end_frame: int = 0
    lap_number: int = 0
    severity: int = 5
    involved_drivers: Optional[list[int]] = None
    position: int = 0
    included_in_highlight: bool = False
    metadata: Optional[dict] = None


@router.post("/projects/{project_id}/events")
async def create_event(project_id: int, body: EventCreateRequest):
    """Create a race event (e.g., undo a delete operation)."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        conn = get_project_db(project_dir)
        try:
            drivers_json = json.dumps(body.involved_drivers or [])
            metadata_json = json.dumps(body.metadata or {})
            cursor = conn.execute(
                """INSERT INTO race_events
                   (event_type, start_time_seconds, end_time_seconds, start_frame, end_frame,
                    lap_number, severity, involved_drivers, position,
                    auto_detected, user_modified, included_in_highlight, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)""",
                (
                    body.event_type,
                    body.start_time_seconds,
                    body.end_time_seconds,
                    body.start_frame,
                    body.end_frame,
                    body.lap_number,
                    max(0, min(10, body.severity)),
                    drivers_json,
                    body.position,
                    1 if body.included_in_highlight else 0,
                    metadata_json,
                ),
            )
            new_id = cursor.lastrowid
            conn.commit()

            # Return the created event
            row = conn.execute("SELECT * FROM race_events WHERE id = ?", (new_id,)).fetchone()
            d = dict(row)
            try:
                d["involved_drivers"] = json.loads(d.get("involved_drivers", "[]"))
            except (json.JSONDecodeError, TypeError):
                d["involved_drivers"] = []
            try:
                d["metadata"] = json.loads(d.get("metadata", "{}"))
            except (json.JSONDecodeError, TypeError):
                d["metadata"] = {}

            logger.info("[Analysis API] Created event #%d", new_id)
            return d
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[Analysis API] Event create error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/projects/{project_id}/events/{event_id}")
async def get_single_event(project_id: int, event_id: int):
    """Get a single race event by ID."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        conn = get_project_db(project_dir)
        try:
            row = conn.execute(
                "SELECT * FROM race_events WHERE id = ?", (event_id,)
            ).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Event not found")

            d = dict(row)
            try:
                d["involved_drivers"] = json.loads(d.get("involved_drivers", "[]"))
            except (json.JSONDecodeError, TypeError):
                d["involved_drivers"] = []
            try:
                d["metadata"] = json.loads(d.get("metadata", "{}"))
            except (json.JSONDecodeError, TypeError):
                d["metadata"] = {}
            return d
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[Analysis API] Get event error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/projects/{project_id}/events/{event_id}")
async def delete_event(project_id: int, event_id: int):
    """Delete a race event."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        conn = get_project_db(project_dir)
        try:
            row = conn.execute(
                "SELECT id FROM race_events WHERE id = ?", (event_id,)
            ).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Event not found")

            conn.execute("DELETE FROM race_events WHERE id = ?", (event_id,))
            conn.commit()
            logger.info("[Analysis API] Deleted event #%d", event_id)
            return {"status": "deleted", "event_id": event_id}
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[Analysis API] Event delete error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/projects/{project_id}/events/{event_id}/split")
async def split_event(project_id: int, event_id: int, body: EventSplitRequest):
    """Split a race event into two at the given timestamp.

    The original event keeps times [start, split_time] and a new event
    is created for [split_time, end].
    """
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        conn = get_project_db(project_dir)
        try:
            row = conn.execute(
                "SELECT * FROM race_events WHERE id = ?", (event_id,)
            ).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Event not found")

            original = dict(row)
            split_t = body.split_time

            if split_t <= original["start_time_seconds"] or split_t >= original["end_time_seconds"]:
                raise HTTPException(
                    status_code=400,
                    detail="Split time must be between event start and end",
                )

            # Estimate split frame (linear interpolation)
            total_time = original["end_time_seconds"] - original["start_time_seconds"]
            frac = (split_t - original["start_time_seconds"]) / total_time if total_time > 0 else 0.5
            split_frame = int(
                original["start_frame"] + frac * (original["end_frame"] - original["start_frame"])
            )

            # Update original: shrink to [start, split_time]
            conn.execute(
                """UPDATE race_events
                   SET end_time_seconds = ?, end_frame = ?, user_modified = 1
                   WHERE id = ?""",
                (split_t, split_frame, event_id),
            )

            # Insert new event: [split_time, end]
            cursor = conn.execute(
                """INSERT INTO race_events
                   (event_type, start_time_seconds, end_time_seconds, start_frame, end_frame,
                    lap_number, severity, involved_drivers, position,
                    auto_detected, user_modified, included_in_highlight, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)""",
                (
                    original["event_type"],
                    split_t,
                    original["end_time_seconds"],
                    split_frame,
                    original["end_frame"],
                    original["lap_number"],
                    original["severity"],
                    original["involved_drivers"],
                    original["position"],
                    original["included_in_highlight"],
                    original["metadata"],
                ),
            )
            new_id = cursor.lastrowid
            conn.commit()

            logger.info("[Analysis API] Split event #%d at %.1fs → new event #%d", event_id, split_t, new_id)
            return {
                "status": "split",
                "original_id": event_id,
                "new_id": new_id,
                "split_time": split_t,
            }
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[Analysis API] Event split error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/projects/{project_id}/analysis/race-duration")
async def get_race_duration(project_id: int):
    """Get the total race duration from the analysis data."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            row = conn.execute(
                "SELECT MAX(session_time) AS max_time, MIN(session_time) AS min_time, MAX(replay_frame) AS max_frame FROM race_ticks"
            ).fetchone()
            max_time = row["max_time"] if row and row["max_time"] else 0
            min_time = row["min_time"] if row and row["min_time"] else 0
            max_frame = row["max_frame"] if row and row["max_frame"] else 0

            # Read race metadata for correct session seeking
            def _meta(key, default):
                r = conn.execute("SELECT value FROM analysis_meta WHERE key=?", (key,)).fetchone()
                return r[0] if r else default

            race_session_num = int(_meta("race_session_num", 0))
            race_start_time = float(_meta("race_start_session_time", min_time))

            return {
                "project_id": project_id,
                "duration_seconds": max_time,
                "race_start_seconds": race_start_time,
                "race_session_num": race_session_num,
                "total_frames": max_frame,
            }
        finally:
            conn.close()
    except Exception as exc:
        logger.error("[Analysis API] Race duration error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ── Highlight configuration endpoints (Feature 9) ───────────────────────────

class HighlightConfigRequest(BaseModel):
    """Highlight configuration payload."""
    weights: dict[str, int] = {}
    target_duration: Optional[float] = None
    min_severity: int = 0
    overrides: dict[str, str] = {}  # event_id -> "include" | "exclude"
    params: dict = {}  # detection/camera tuning parameters


class HighlightApplyRequest(BaseModel):
    """Batch-apply highlight selections."""
    included_ids: list[int] = []
    excluded_ids: list[int] = []


class PresetSaveRequest(BaseModel):
    """Save a named highlight preset."""
    name: str
    weights: dict[str, int]
    target_duration: Optional[float] = None
    min_severity: int = 0


@router.get("/projects/{project_id}/highlights/config")
async def get_project_highlight_config(project_id: int):
    """Get the highlight configuration for a project."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            config = get_highlight_config(conn)
            config["project_id"] = project_id
            return config
        finally:
            conn.close()
    except Exception as exc:
        logger.error("[Highlights API] Config fetch error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.put("/projects/{project_id}/highlights/config")
async def update_project_highlight_config(project_id: int, body: HighlightConfigRequest):
    """Save the highlight configuration for a project."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            config = save_highlight_config(
                conn,
                weights=body.weights,
                target_duration=body.target_duration,
                min_severity=body.min_severity,
                overrides=body.overrides,
                params=body.params,
            )
            config["project_id"] = project_id
            logger.info("[Highlights API] Saved config for project #%d", project_id)
            return config
        finally:
            conn.close()
    except Exception as exc:
        logger.error("[Highlights API] Config save error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/projects/{project_id}/highlights/apply")
async def apply_highlights(project_id: int, body: HighlightApplyRequest):
    """Batch-apply highlight selections to events.

    Sets included_in_highlight=1 for included_ids and 0 for excluded_ids.
    """
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        conn = get_project_db(project_dir)
        try:
            count = batch_update_highlight_flags(
                conn,
                included_ids=body.included_ids,
                excluded_ids=body.excluded_ids,
            )
            logger.info(
                "[Highlights API] Applied highlights for project #%d: %d events updated",
                project_id, count,
            )
            return {
                "status": "applied",
                "project_id": project_id,
                "included_count": len(body.included_ids),
                "excluded_count": len(body.excluded_ids),
                "rows_updated": count,
            }
        finally:
            conn.close()
    except Exception as exc:
        logger.error("[Highlights API] Apply error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/projects/{project_id}/analysis/drivers")
async def list_drivers(project_id: int):
    """Get all non-spectator drivers for a project."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            drivers = get_drivers(conn)
            return {"project_id": project_id, "drivers": drivers}
        finally:
            conn.close()
    except Exception as exc:
        logger.error("[Analysis API] Drivers fetch error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ── Enhanced highlight pipeline (v2) ─────────────────────────────────────────

class ReprocessRequest(BaseModel):
    """Extended recompute request for multi-pass scoring pipeline."""
    weights: dict[str, float] = {}
    constraints: dict[str, Any] = {}



@router.post("/projects/{project_id}/highlights/reprocess")
async def reprocess_highlights(project_id: int, body: ReprocessRequest):
    """Run the full multi-pass scoring pipeline and return updated results.

    This replaces the simple severity × weight scoring with the 8-stage
    pipeline: base score → position → position change → consequence →
    narrative → exposure → user weight → tier classification.
    """
    from server.services.scoring_engine import generate_highlights

    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            # Fetch all events
            events = get_events(conn, limit=10000)

            # Fetch highlight config for overrides
            config = get_highlight_config(conn)
            overrides = config.get("overrides", {})

            # Fetch race duration
            conn.row_factory = _dict_factory
            row = conn.execute(
                "SELECT MAX(session_time) as max_time FROM race_ticks"
            ).fetchone()
            race_duration = row["max_time"] if row and row["max_time"] else 0

            # Fetch driver count
            drivers = get_drivers(conn)
            num_drivers = len(drivers) if drivers else 1

            # Build race info
            race_info = {
                "duration": race_duration,
                "num_drivers": num_drivers,
                "track": project.get("track_name", "Unknown"),
                "total_laps": project.get("num_laps", 0),
                "target_duration": body.constraints.get("target_duration", 300),
            }

            # Merge weights from request with config
            weights = {**config.get("weights", {}), **body.weights}

            # Run the full pipeline
            result = generate_highlights(
                events=events,
                target_duration=body.constraints.get("target_duration", 300),
                weights=weights,
                constraints=body.constraints,
                overrides=overrides,
                race_info=race_info,
            )

            logger.info(
                "[Highlights API] Reprocessed project #%d: %d events scored, "
                "%d segments in timeline",
                project_id,
                len(result.get("scored_events", [])),
                len(result.get("timeline", [])),
            )

            return {
                "project_id": project_id,
                "scored_events": result["scored_events"],
                "timeline": result["timeline"],
                "metrics": result["metrics"],
            }
        finally:
            conn.close()
    except Exception as exc:
        logger.error("[Highlights API] Reprocess error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


class VideoScriptRequest(BaseModel):
    """Request body for generating a Video Composition Script."""
    weights: dict = {}
    constraints: dict = {}
    section_config: dict = {}
    clip_padding: float = 0.5


@router.post("/projects/{project_id}/highlights/video-script")
async def generate_video_script_endpoint(project_id: int, body: VideoScriptRequest):
    """Generate a full Video Composition Script with intro/qualifying/race/results sections.

    Returns the ordered script segments, scored events, race timeline,
    metrics, and a sections summary for the frontend.
    """
    from server.services.scoring_engine import generate_video_script

    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            events = get_events(conn, limit=10000)

            config = get_highlight_config(conn)
            overrides = config.get("overrides", {})

            conn.row_factory = _dict_factory
            row = conn.execute(
                "SELECT MAX(session_time) as max_time FROM race_ticks"
            ).fetchone()
            race_duration = row["max_time"] if row and row["max_time"] else 0

            drivers = get_drivers(conn)
            num_drivers = len(drivers) if drivers else 1

            race_info = {
                "duration": race_duration,
                "num_drivers": num_drivers,
                "track": project.get("track_name", "Unknown"),
                "total_laps": project.get("num_laps", 0),
                "target_duration": body.constraints.get("target_duration", 300),
            }

            weights = {**config.get("weights", {}), **body.weights}

            result = generate_video_script(
                events=events,
                target_duration=body.constraints.get("target_duration", 300),
                weights=weights,
                constraints=body.constraints,
                overrides=overrides,
                race_info=race_info,
                section_config=body.section_config,
                clip_padding=body.clip_padding,
            )

            logger.info(
                "[Highlights API] Video script generated for project #%d: "
                "%d script segments, %d sections",
                project_id,
                len(result.get("script", [])),
                len(result.get("sections", [])),
            )

            return {
                "project_id": project_id,
                **result,
            }
        finally:
            conn.close()
    except Exception as exc:
        logger.error("[Highlights API] Video script error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/projects/{project_id}/scored-events")
async def get_scored_events(project_id: int):
    """Get all events scored and tiered using the multi-pass pipeline."""
    from server.services.scoring_engine import score_events

    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            events = get_events(conn, limit=10000)
            config = get_highlight_config(conn)
            weights = config.get("weights", {})

            conn.row_factory = _dict_factory
            row = conn.execute(
                "SELECT MAX(session_time) as max_time FROM race_ticks"
            ).fetchone()
            race_duration = row["max_time"] if row and row["max_time"] else 0

            drivers = get_drivers(conn)
            num_drivers = len(drivers) if drivers else 1

            scored = score_events(
                events=events,
                weights=weights,
                race_duration=race_duration,
                num_drivers=num_drivers,
            )

            return {
                "project_id": project_id,
                "events": scored,
                "total": len(scored),
            }
        finally:
            conn.close()
    except Exception as exc:
        logger.error("[Analysis API] Scored events error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


def _dict_factory(cursor, row):
    """SQLite row factory that returns dicts."""
    return {col[0]: row[idx] for idx, col in enumerate(cursor.description)}


# ── Global highlight presets ─────────────────────────────────────────────────

import os
from server.config import DATA_DIR

_PRESETS_PATH = DATA_DIR / "highlight_presets.json"


def _load_presets() -> dict:
    """Load global highlight presets from JSON file."""
    if _PRESETS_PATH.exists():
        try:
            return json.loads(_PRESETS_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_presets(presets: dict) -> None:
    """Persist global highlight presets to JSON file."""
    _PRESETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    _PRESETS_PATH.write_text(
        json.dumps(presets, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


@router.get("/highlights/presets")
async def list_presets():
    """List all named highlight presets."""
    presets = _load_presets()
    return {
        "presets": [
            {"name": name, **data}
            for name, data in presets.items()
        ]
    }


@router.post("/highlights/presets")
async def save_preset(body: PresetSaveRequest):
    """Save a named highlight preset (global, not project-specific)."""
    if not body.name or not body.name.strip():
        raise HTTPException(status_code=400, detail="Preset name is required")

    presets = _load_presets()
    presets[body.name.strip()] = {
        "weights": body.weights,
        "target_duration": body.target_duration,
        "min_severity": body.min_severity,
    }
    _save_presets(presets)
    logger.info("[Highlights API] Saved preset '%s'", body.name)
    return {"status": "saved", "name": body.name.strip()}


@router.delete("/highlights/presets/{name}")
async def delete_preset(name: str):
    """Delete a named highlight preset."""
    presets = _load_presets()
    if name not in presets:
        raise HTTPException(status_code=404, detail="Preset not found")

    del presets[name]
    _save_presets(presets)
    logger.info("[Highlights API] Deleted preset '%s'", name)
    return {"status": "deleted", "name": name}
