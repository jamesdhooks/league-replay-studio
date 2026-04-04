"""
api_capture.py
--------------
REST endpoints for video capture (OBS / ShadowPlay / ReLive).

  GET  /api/capture/software    — Detect available capture software
  GET  /api/capture/status      — Get capture status
  POST /api/capture/test        — Test hotkey and verify recording starts
  POST /api/capture/start       — Start capture
  POST /api/capture/stop        — Stop capture
  POST /api/capture/reset       — Reset capture state to idle
  POST /api/capture/script-capture — Script-based per-segment capture (async)
  GET  /api/capture/script-capture/status — Status of running script capture
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from server.services.capture_service import capture_service
from server.events import EventType, make_event

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/capture", tags=["capture"])

# ── Script capture state (singleton, one at a time) ─────────────────────────

_script_capture_state: dict = {
    "running": False,
    "cancelled": False,
    "project_id": None,
    "total_segments": 0,
    "completed_segments": 0,
    "clips": [],
    "compiled_path": None,
    "error": None,
    "started_at": None,
}
_script_capture_lock = threading.Lock()
_script_capture_engine: Optional[object] = None


# ── Software detection ──────────────────────────────────────────────────────

@router.get("/software")
async def get_capture_software():
    """Detect available capture software.

    Returns a list of known capture software with their running status.
    """
    try:
        software = capture_service.detect_software()
        active = capture_service.get_active_software()
        hotkeys = capture_service.get_hotkeys()
        watch_dir = capture_service.get_watch_directory()

        return {
            "software": software,
            "active_software": active,
            "hotkeys": hotkeys,
            "watch_directory": watch_dir,
        }
    except Exception as exc:
        logger.error("[Capture API] Software detection error: %s", exc)
        raise HTTPException(status_code=500, detail="Capture software detection failed")


# ── Status ──────────────────────────────────────────────────────────────────

@router.get("/status")
async def get_capture_status():
    """Get current capture status."""
    return capture_service.status


# ── Hotkey test ─────────────────────────────────────────────────────────────

@router.post("/test")
async def test_capture_hotkey():
    """Test the configured start/stop hotkeys.

    Sends the start hotkey, waits briefly for a file to appear,
    then sends the stop hotkey. Returns the test result.
    """
    try:
        result = await capture_service.test_hotkey()
        return result
    except Exception as exc:
        logger.error("[Capture API] Hotkey test error: %s", exc)
        raise HTTPException(status_code=500, detail="Hotkey test failed")


# ── Start capture ───────────────────────────────────────────────────────────

@router.post("/start")
async def start_capture():
    """Start recording via the configured capture software.

    Sends the start hotkey and begins monitoring for the capture file.
    """
    try:
        result = await capture_service.start_capture()
        if not result["success"]:
            raise HTTPException(status_code=400, detail=result.get("error", "Failed to start capture"))
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[Capture API] Start capture error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to start capture")


# ── Stop capture ────────────────────────────────────────────────────────────

@router.post("/stop")
async def stop_capture():
    """Stop recording and validate the capture file.

    Sends the stop hotkey, discovers the capture file,
    and performs post-capture validation.
    """
    try:
        result = await capture_service.stop_capture()
        return result
    except Exception as exc:
        logger.error("[Capture API] Stop capture error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to stop capture")


# ── Reset ───────────────────────────────────────────────────────────────────

@router.post("/reset")
async def reset_capture():
    """Reset capture state to idle."""
    capture_service.reset()
    return {"status": "reset", "state": "idle"}


# ── Script-based capture ───────────────────────────────────────────────────


class ScriptCaptureRequest(BaseModel):
    """Request body for script-based capture."""
    project_id: int
    script: list[dict]
    clip_padding: float = 0.5
    output_filename: str = "highlight_compiled.mp4"


@router.post("/script-capture", status_code=202)
async def start_script_capture(body: ScriptCaptureRequest):
    """Start script-based capture in the background.

    For each segment in the script:
      1. Pauses the replay
      2. Seeks to start time minus clip_padding
      3. Sets the appropriate iRacing camera
      4. Starts recording
      5. Plays replay for segment duration + padding
      6. Stops recording and trims the padding
      7. Saves the clip with the segment's ID

    After all segments are captured, clips are compiled into a single video.

    Progress is reported via WebSocket events:
      - ``capture:script_started``  — capture begins
      - ``capture:script_progress`` — one segment completed
      - ``capture:script_completed`` — all clips captured and compiled
      - ``capture:script_error``    — fatal error

    Returns 202 Accepted immediately; poll
    ``GET /api/capture/script-capture/status`` for current state.
    """
    global _script_capture_engine

    with _script_capture_lock:
        if _script_capture_state["running"]:
            raise HTTPException(
                status_code=409,
                detail="A script capture is already in progress",
            )
        _script_capture_state.update({
            "running": True,
            "cancelled": False,
            "project_id": body.project_id,
            "total_segments": len([s for s in body.script if s.get("type") != "transition"]),
            "completed_segments": 0,
            "clips": [],
            "compiled_path": None,
            "error": None,
            "started_at": time.time(),
        })

    from server.services.project_service import project_service
    from server.services.iracing_bridge import bridge as iracing_bridge
    from server.utils.script_capture import ScriptCaptureEngine

    project = project_service.get_project(body.project_id)
    if not project:
        with _script_capture_lock:
            _script_capture_state["running"] = False
        raise HTTPException(status_code=404, detail="Project not found")

    if not iracing_bridge.is_connected:
        with _script_capture_lock:
            _script_capture_state["running"] = False
        raise HTTPException(status_code=400, detail="iRacing is not connected")

    project_dir = project.get("project_dir", "")
    if not project_dir:
        with _script_capture_lock:
            _script_capture_state["running"] = False
        raise HTTPException(status_code=400, detail="Project directory not set")

    # Grab loop and broadcast function from capture_service (already wired in app.py)
    loop = capture_service._loop
    broadcast_fn = capture_service._broadcast_fn

    def _do_broadcast(event_type: str, data: dict) -> None:
        """Thread-safe broadcast via the capture service loop."""
        if broadcast_fn and loop and loop.is_running():
            asyncio.run_coroutine_threadsafe(
                broadcast_fn(make_event(event_type, data)),
                loop,
            )

    clips_dir = str(Path(project_dir) / "clips")
    cameras = getattr(iracing_bridge, "cameras", []) or []
    script = list(body.script)
    clip_padding = body.clip_padding
    output_filename = body.output_filename

    def _progress_cb(data: dict) -> None:
        """Called by ScriptCaptureEngine on each segment completion."""
        step = data.get("step", "")
        if step == "capturing":
            with _script_capture_lock:
                _script_capture_state["completed_segments"] = data.get("segment_index", 0)
            total = _script_capture_state["total_segments"]
            done = _script_capture_state["completed_segments"]
            pct = round((done / total * 100) if total else 0, 1)
            _do_broadcast(EventType.CAPTURE_SCRIPT_PROGRESS, {
                **data,
                "percentage": pct,
                "project_id": body.project_id,
            })
        elif step == "capture_complete":
            with _script_capture_lock:
                _script_capture_state["completed_segments"] = data.get("clips_captured", 0)
        elif step in ("compiling", "compile_complete"):
            _do_broadcast(EventType.CAPTURE_SCRIPT_PROGRESS, {
                **data,
                "project_id": body.project_id,
            })

    def _run_capture() -> None:
        global _script_capture_engine
        from server.utils.capture_engine import CaptureEngine

        _do_broadcast(EventType.CAPTURE_SCRIPT_STARTED, {
            "project_id": body.project_id,
            "total_segments": _script_capture_state["total_segments"],
        })

        capture_engine = CaptureEngine()
        started_engine = False

        try:
            if not capture_engine.is_running:
                capture_engine.start(fps=30, quality=80, max_width=1920)
                started_engine = True

            engine = ScriptCaptureEngine(
                output_dir=clips_dir,
                clip_padding=clip_padding,
                progress_callback=_progress_cb,
            )

            with _script_capture_lock:
                _script_capture_engine = engine

            clips = engine.capture_script(
                script=script,
                iracing_bridge=iracing_bridge,
                capture_engine=capture_engine,
                available_cameras=cameras,
            )

            with _script_capture_lock:
                _script_capture_state["clips"] = clips

            output_path = str(Path(project_dir) / output_filename)
            compiled = engine.compile_clips(output_path)

            with _script_capture_lock:
                _script_capture_state["compiled_path"] = compiled
                _script_capture_state["running"] = False

            _do_broadcast(EventType.CAPTURE_SCRIPT_COMPLETED, {
                "project_id": body.project_id,
                "clips": clips,
                "compiled_path": compiled,
                "total_clips": len(clips),
            })

        except Exception as exc:
            logger.error("[Capture API] Script capture worker error: %s", exc)
            with _script_capture_lock:
                _script_capture_state["error"] = str(exc)
                _script_capture_state["running"] = False
            _do_broadcast(EventType.CAPTURE_SCRIPT_ERROR, {
                "project_id": body.project_id,
                "error": str(exc),
            })
        finally:
            if started_engine:
                capture_engine.stop()
            with _script_capture_lock:
                _script_capture_engine = None

    thread = threading.Thread(target=_run_capture, daemon=True, name="script-capture")
    thread.start()

    return {
        "accepted": True,
        "project_id": body.project_id,
        "total_segments": _script_capture_state["total_segments"],
        "message": "Script capture started — follow progress via WebSocket",
    }


@router.post("/script-capture/cancel")
async def cancel_script_capture():
    """Cancel an in-progress script capture."""
    global _script_capture_engine
    with _script_capture_lock:
        if not _script_capture_state["running"]:
            return {"cancelled": False, "message": "No capture running"}
        _script_capture_state["cancelled"] = True
        engine = _script_capture_engine

    if engine is not None:
        engine.cancel()

    return {"cancelled": True, "message": "Cancellation requested"}


@router.get("/script-capture/status")
async def get_script_capture_status():
    """Get the current state of the script capture."""
    with _script_capture_lock:
        return dict(_script_capture_state)
