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
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from server.services.capture_service import capture_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/capture", tags=["capture"])


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

from pydantic import BaseModel
from typing import Optional


class ScriptCaptureRequest(BaseModel):
    """Request body for script-based capture."""
    project_id: int
    script: list[dict]
    clip_padding: float = 0.5
    output_filename: str = "highlight_compiled.mp4"


@router.post("/script-capture")
async def start_script_capture(body: ScriptCaptureRequest):
    """Capture video clips for each segment in a Video Composition Script.

    This endpoint:
      1. Iterates through each script segment
      2. For each: pauses replay → seeks → sets camera → records → trims
      3. Compiles all clips into a single output video
      4. Returns the list of clips and compiled video path

    This is a long-running operation — progress is reported via WebSocket.
    """
    from server.services.project_service import project_service
    from server.services.iracing_bridge import bridge as iracing_bridge
    from server.utils.script_capture import ScriptCaptureEngine

    project = project_service.get_project(body.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if not iracing_bridge.is_connected:
        raise HTTPException(status_code=400, detail="iRacing is not connected")

    project_dir = project.get("project_dir", "")
    if not project_dir:
        raise HTTPException(status_code=400, detail="Project directory not set")

    clips_dir = str(Path(project_dir) / "clips")

    # Get available cameras from iRacing
    cameras = getattr(iracing_bridge, "cameras", []) or []

    # Create the CaptureEngine for recording
    from server.utils.capture_engine import CaptureEngine
    capture_engine = CaptureEngine()
    if not capture_engine.is_running:
        capture_engine.start(fps=30, quality=80, max_width=1920)

    try:
        engine = ScriptCaptureEngine(
            output_dir=clips_dir,
            clip_padding=body.clip_padding,
        )

        clips = engine.capture_script(
            script=body.script,
            iracing_bridge=iracing_bridge,
            capture_engine=capture_engine,
            available_cameras=cameras,
        )

        output_path = str(Path(project_dir) / body.output_filename)
        compiled = engine.compile_clips(output_path)

        return {
            "success": True,
            "clips": clips,
            "compiled_path": compiled,
            "total_clips": len(clips),
        }
    except Exception as exc:
        logger.error("[Capture API] Script capture error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        capture_engine.stop()


from pathlib import Path
