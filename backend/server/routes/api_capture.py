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
  GET  /api/capture/script-capture/log   — Structured capture log
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from pathlib import Path
from typing import Any, Optional

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
    "strategies": [],
    "capture_log": [],
    "current_segment": None,
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
    clip_padding: float = 2.0
    clip_padding_after: float = 5.0
    output_filename: str = "highlight_compiled.mp4"
    contiguous_gap_threshold: float = 1.0


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
            "strategies": [],
            "capture_log": [],
            "current_segment": None,
        })

    from server.services.project_service import project_service
    from server.services.iracing_bridge import bridge as iracing_bridge

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
    loop = capture_service.get_event_loop()
    broadcast_fn = capture_service.get_broadcast_fn()

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
    clip_padding_after = body.clip_padding_after
    output_filename = body.output_filename
    contiguous_gap = body.contiguous_gap_threshold

    def _progress_cb(data: dict) -> None:
        """Called by ScriptCaptureEngine on progress updates."""
        step = data.get("step", "")
        if step == "strategy_computed":
            with _script_capture_lock:
                _script_capture_state["strategies"] = data.get("strategies", [])
            _do_broadcast(EventType.CAPTURE_SCRIPT_PROGRESS, {
                **data,
                "project_id": body.project_id,
            })
        elif step == "capturing":
            with _script_capture_lock:
                _script_capture_state["completed_segments"] = data.get("segment_index", 0)
                _script_capture_state["current_segment"] = {
                    "segment_id": data.get("segment_id"),
                    "section": data.get("section"),
                    "segment_type": data.get("segment_type"),
                    "strategy": data.get("strategy"),
                }
            _do_broadcast(EventType.CAPTURE_SCRIPT_PROGRESS, {
                **data,
                "project_id": body.project_id,
            })
        elif step == "log_entry":
            log_entry = data.get("log_entry", {})
            with _script_capture_lock:
                _script_capture_state["capture_log"].append(log_entry)
            _do_broadcast(EventType.CAPTURE_SCRIPT_PROGRESS, {
                "step": "log_entry",
                "log_entry": log_entry,
                "project_id": body.project_id,
            })
        elif step == "capture_complete":
            with _script_capture_lock:
                _script_capture_state["completed_segments"] = data.get("clips_captured", 0)
                _script_capture_state["capture_log"] = data.get("capture_log", [])
        elif step in ("compiling", "compile_complete"):
            _do_broadcast(EventType.CAPTURE_SCRIPT_PROGRESS, {
                **data,
                "project_id": body.project_id,
            })

    def _run_capture() -> None:
        global _script_capture_engine
        from server.services.settings_service import settings_service

        software = settings_service.get("capture_software") or "native"

        _do_broadcast(EventType.CAPTURE_SCRIPT_STARTED, {
            "project_id": body.project_id,
            "total_segments": _script_capture_state["total_segments"],
            "capture_mode": software,
        })

        # Build the recorder backend based on the configured capture software.
        #
        # • "native"  — LRS built-in DXCam capture (CaptureEngine).  Output
        #               path is known in advance; no file polling needed.
        # • anything else — Hotkey-based capture (OBS / ShadowPlay / ReLive /
        #               manual).  HotkeyRecorderAdapter sends hotkeys and polls
        #               the capture software's output folder for the new file.
        from server.utils.script_capture import ScriptCaptureEngine, HotkeyRecorderAdapter

        native_engine = None
        started_native = False
        recorder: Any

        if software == "native":
            from server.utils.capture_engine import CaptureEngine
            native_engine = CaptureEngine()
            try:
                if not native_engine.is_running:
                    native_engine.start(fps=30, quality=80, max_width=1920)
                    started_native = True
            except Exception as exc:
                logger.error("[Capture API] Failed to start native engine: %s", exc)
                with _script_capture_lock:
                    _script_capture_state["error"] = str(exc)
                    _script_capture_state["running"] = False
                _do_broadcast(EventType.CAPTURE_SCRIPT_ERROR, {
                    "project_id": body.project_id,
                    "error": str(exc),
                })
                return
            recorder = native_engine
        else:
            hotkeys = capture_service.get_hotkeys()
            watch_dir = capture_service.get_watch_directory()

            if not hotkeys.get("start"):
                err = f"No start hotkey configured for '{software}' mode"
                logger.error("[Capture API] %s", err)
                with _script_capture_lock:
                    _script_capture_state["error"] = err
                    _script_capture_state["running"] = False
                _do_broadcast(EventType.CAPTURE_SCRIPT_ERROR, {
                    "project_id": body.project_id,
                    "error": err,
                })
                return

            if not watch_dir:
                err = (
                    f"No video output folder found for '{software}'. "
                    "Configure the output path in Settings → Capture."
                )
                logger.error("[Capture API] %s", err)
                with _script_capture_lock:
                    _script_capture_state["error"] = err
                    _script_capture_state["running"] = False
                _do_broadcast(EventType.CAPTURE_SCRIPT_ERROR, {
                    "project_id": body.project_id,
                    "error": err,
                })
                return

            recorder = HotkeyRecorderAdapter(
                watch_folder=watch_dir,
                start_hotkey=hotkeys["start"],
                stop_hotkey=hotkeys.get("stop") or hotkeys["start"],
            )

        try:
            engine = ScriptCaptureEngine(
                output_dir=clips_dir,
                clip_padding=clip_padding,
                clip_padding_after=clip_padding_after,
                progress_callback=_progress_cb,
                contiguous_gap_threshold=contiguous_gap,
                capture_mode=software,
            )

            with _script_capture_lock:
                _script_capture_engine = engine

            clips = engine.capture_script(
                script=script,
                iracing_bridge=iracing_bridge,
                capture_engine=recorder,
                available_cameras=cameras,
            )

            with _script_capture_lock:
                _script_capture_state["clips"] = clips
                _script_capture_state["capture_log"] = engine.capture_log

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
                "capture_log": engine.capture_log,
                "strategies": engine.segment_strategies,
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
            if started_native and native_engine is not None:
                native_engine.stop()
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


@router.get("/script-capture/log")
async def get_script_capture_log():
    """Get the structured capture log for the current/last script capture.

    Returns the full audit trail of commands sent, validations, retries,
    and failures for debugging and review.
    """
    with _script_capture_lock:
        return {
            "running": _script_capture_state["running"],
            "project_id": _script_capture_state["project_id"],
            "capture_log": _script_capture_state.get("capture_log", []),
            "strategies": _script_capture_state.get("strategies", []),
            "current_segment": _script_capture_state.get("current_segment"),
        }
