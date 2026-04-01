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
        raise HTTPException(status_code=500, detail=str(exc))


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
        raise HTTPException(status_code=500, detail=str(exc))


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
        raise HTTPException(status_code=500, detail=str(exc))


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
        raise HTTPException(status_code=500, detail=str(exc))


# ── Reset ───────────────────────────────────────────────────────────────────

@router.post("/reset")
async def reset_capture():
    """Reset capture state to idle."""
    capture_service.reset()
    return {"status": "reset", "state": "idle"}
