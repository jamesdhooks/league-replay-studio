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
import json
import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from server.services.capture_service import capture_service
from server.events import EventType, make_event
from server.utils.command_log import command_log
from server.utils.capture_resolution import resolve_capture_resolution

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/capture", tags=["capture"])

_SEEK_PREFLIGHT_DRIFT_TOLERANCE_MS = 5000

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
    "log_file_path": None,
    "current_segment": None,
    "abort_segment_id": None,
    "abort_action": None,
    "abort_reason": None,
}
_script_capture_lock = threading.Lock()
_script_capture_engine: Optional[object] = None


def _persist_script_capture_log(project_dir: str, payload: dict[str, Any]) -> Optional[str]:
    """Write script capture audit log to project-local JSON files.

    Stores a timestamped immutable record and updates a stable "latest" file
    for quick troubleshooting.
    """
    try:
        logs_dir = Path(project_dir) / "capture_logs"
        logs_dir.mkdir(parents=True, exist_ok=True)

        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        run_path = logs_dir / f"script_capture_{stamp}.json"
        latest_path = logs_dir / "latest_script_capture.json"

        serialized = json.dumps(payload, indent=2, ensure_ascii=True)
        run_path.write_text(serialized, encoding="utf-8")
        latest_path.write_text(serialized, encoding="utf-8")
        return str(run_path)
    except Exception as exc:
        logger.error("[Capture API] Failed to persist script capture log: %s", exc)
        return None


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
    clip_padding_after: float = 1.0
    output_filename: str = "highlight_compiled.mp4"
    contiguous_gap_threshold: float = 1.0
    # ── Partial capture support ──────────────────────────────────────────
    capture_mode: str = "all"           # all, uncaptured_only, specific_segments, time_range
    segment_ids: list[str] | None = None  # for specific_segments mode
    time_range: dict | None = None        # {start, end} for time_range mode
    capture_resolution: str = "1080p"     # target iRacing client resolution


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

    # ── Filter segments based on capture mode ─────────────────────────────
    from server.services.iracing_bridge import bridge as iracing_bridge
    from server.services.project_service import project_service
    from server.services.script_state_service import script_state_service
    from server.services.settings_service import settings_service

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

    # ── Preflight checks (fail fast before background worker starts) ──────
    software = settings_service.get("capture_software") or "native"
    capture_resolution, capture_width, capture_height = resolve_capture_resolution(body.capture_resolution)

    # Manual mode cannot run automated scripted capture.
    if software == "manual":
        raise HTTPException(
            status_code=400,
            detail=(
                "Manual capture mode does not support scripted automation. "
                "Select OBS, ShadowPlay, ReLive, or LRS Native in Settings → Capture."
            ),
        )

    if software != "native":
        hotkeys = capture_service.get_hotkeys()
        watch_dir = capture_service.get_watch_directory()

        if not hotkeys.get("start"):
            raise HTTPException(
                status_code=400,
                detail=f"No start hotkey configured for '{software}' mode",
            )

        if not watch_dir:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"No video output folder found for '{software}'. "
                    "Configure the output path in Settings → Capture."
                ),
            )

        watch_path = Path(watch_dir)
        if not watch_path.exists() or not watch_path.is_dir():
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Capture output folder is invalid or missing: '{watch_dir}'. "
                    "Fix the output folder in Settings → Capture."
                ),
            )

        # Verify the process can write/delete files in watch folder before running.
        probe_file = watch_path / ".lrs_write_probe.tmp"
        try:
            probe_file.write_text("ok", encoding="utf-8")
            probe_file.unlink(missing_ok=True)
        except Exception as exc:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cannot write to capture output folder '{watch_dir}': {exc}. "
                    "Grant folder permissions or choose a different output folder."
                ),
            ) from exc

    # Size the game window before replay/capture automation starts so the
    # recorder sees the intended client resolution from the first frame.
    from server.utils.window_capture import resize_capture_target

    resize_result = resize_capture_target(capture_width, capture_height)
    command_log.record(
        "capture-window-resize",
        {
            "project_id": body.project_id,
            "capture_resolution": capture_resolution,
            "requested_width": capture_width,
            "requested_height": capture_height,
            "result": resize_result,
        },
        result="ok" if resize_result.get("success") else "error",
        source="api_capture",
    )
    if not resize_result.get("success"):
        raise HTTPException(
            status_code=400,
            detail=resize_result.get("error") or "Failed to resize capture target window",
        )

    # Probe replay commandability so we fail fast instead of segment-loop churn.
    preflight_snapshot = iracing_bridge.capture_snapshot()
    if not preflight_snapshot:
        raise HTTPException(
            status_code=400,
            detail=(
                "Unable to read iRacing telemetry snapshot for preflight. "
                "Ensure iRacing replay is loaded and telemetry is updating."
            ),
        )

    preflight_session_num = iracing_bridge.get_replay_session_num()
    if preflight_session_num < 0:
        raise HTTPException(
            status_code=400,
            detail=(
                "Replay session is unavailable. Open the iRacing replay timeline "
                "before starting scripted capture."
            ),
        )

    baseline_ms = int((preflight_snapshot.get("session_time") or 0.0) * 1000)
    probe_target_ms = max(0, baseline_ms - 2000) if baseline_ms > 3000 else baseline_ms + 2000

    if not iracing_bridge.replay_search_session_time(preflight_session_num, probe_target_ms):
        raise HTTPException(
            status_code=400,
            detail=(
                "Replay seek command failed in preflight. Make sure iRacing is in Replay mode "
                "and not blocked by modal dialogs."
            ),
        )

    time.sleep(0.35)
    probe_snapshot = iracing_bridge.capture_snapshot()
    if not probe_snapshot:
        raise HTTPException(
            status_code=400,
            detail="Unable to validate replay seek preflight (no telemetry after seek).",
        )

    actual_ms = int((probe_snapshot.get("session_time") or 0.0) * 1000)
    drift_ms = abs(actual_ms - probe_target_ms)
    if drift_ms > _SEEK_PREFLIGHT_DRIFT_TOLERANCE_MS:
        raise HTTPException(
            status_code=400,
            detail=(
                "Replay seek preflight failed: iRacing did not move to requested time "
                f"(target={probe_target_ms}ms, actual={actual_ms}ms, drift={drift_ms}ms). "
                "Click the replay timeline in iRacing and verify replay controls respond, then retry."
            ),
        )

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
    cameras = (
        getattr(iracing_bridge, "cameras", None)
        or (getattr(iracing_bridge, "session_data", {}) or {}).get("cameras", [])
        or []
    )

    requested_clip_padding = body.clip_padding
    clip_padding = requested_clip_padding if requested_clip_padding > 0 else 2.0
    if abs(requested_clip_padding - clip_padding) > 1e-9:
        logger.info(
            "[Capture API] Overriding requested clip_padding %.3fs -> %.3fs",
            requested_clip_padding,
            clip_padding,
        )

    requested_clip_padding_after = body.clip_padding_after
    clip_padding_after = 1.0
    if abs(requested_clip_padding_after - clip_padding_after) > 1e-9:
        logger.info(
            "[Capture API] Overriding requested clip_padding_after %.3fs -> %.3fs",
            requested_clip_padding_after,
            clip_padding_after,
        )

    # ── Apply capture mode filter ─────────────────────────────────────────
    filtered_script = script_state_service.filter_segments_by_mode(
        project_dir,
        body.script,
        mode=body.capture_mode,
        segment_ids=body.segment_ids,
        time_range=body.time_range,
    )
    filtered_script = [
        {
            **segment,
            "clip_padding": clip_padding,
            "clip_padding_after": clip_padding_after,
        }
        for segment in filtered_script
    ]
    # Preserve transition segments between captured segments, but ensure
    # selected capture segments use the normalized runtime padding values.
    script = []
    filtered_by_id = {
        s.get("id", s.get("segment_id", "")): s
        for s in filtered_script
    }
    for seg in body.script:
        if seg.get("type") == "transition":
            script.append(seg)
            continue

        seg_id = seg.get("id", seg.get("segment_id", ""))
        if seg_id in filtered_by_id:
            script.append(filtered_by_id[seg_id])

    contiguous_gap = body.contiguous_gap_threshold
    capture_mode = body.capture_mode

    # Now init state after filtering is done
    with _script_capture_lock:
        _script_capture_state.update({
            "running": True,
            "cancelled": False,
            "project_id": body.project_id,
            "total_segments": len([s for s in script if s.get("type") != "transition"]),
            "completed_segments": 0,
            "clips": [],
            "compiled_path": None,
            "error": None,
            "started_at": time.time(),
            "strategies": [],
            "capture_log": [],
            "log_file_path": None,
            "current_segment": None,
            "abort_segment_id": None,
            "abort_action": None,
            "abort_reason": None,
            "capture_mode": capture_mode,
            "capture_resolution": capture_resolution,
        })

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
            seg_id = data.get("segment_id", "")
            with _script_capture_lock:
                _script_capture_state["completed_segments"] = data.get("segment_index", 0)
                _script_capture_state["current_segment"] = {
                    "segment_id": seg_id,
                    "section": data.get("section"),
                    "segment_type": data.get("segment_type"),
                    "strategy": data.get("strategy"),
                }
            # Track per-segment capture state
            if seg_id and project_dir:
                script_state_service.mark_capturing(project_dir, seg_id)
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
        elif step == "clip_saved":
            clip_path = str(data.get("clip_path") or "")
            segment_ids = data.get("segment_ids") or []
            verified = bool(data.get("verified"))

            if verified and clip_path and project_dir:
                for seg_id_in_clip in segment_ids:
                    if seg_id_in_clip:
                        script_state_service.mark_captured(project_dir, seg_id_in_clip, clip_path)

            _do_broadcast(EventType.CAPTURE_SCRIPT_PROGRESS, {
                **data,
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
            "capture_resolution": capture_resolution,
        })

        # Build the recorder backend based on the configured capture software.
        #
        # • "native"  — LRS built-in DXCam capture (CaptureEngine).  Output
        #               path is known in advance; no file polling needed.
        # • anything else — Hotkey-based capture (OBS / ShadowPlay / ReLive /
        #               manual).  HotkeyRecorderAdapter sends hotkeys and polls
        #               the capture software's output folder for the new file.
        from server.utils.script_capture import CaptureAbortError, ScriptCaptureEngine, HotkeyRecorderAdapter

        native_engine = None
        started_native = False
        recorder: Any

        if software == "native":
            from server.utils.capture_engine import CaptureEngine
            native_engine = CaptureEngine()
            try:
                if not native_engine.is_running:
                    native_engine.start(fps=30, quality=80, max_width=capture_width)
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
                cancelled_fn=lambda: _script_capture_state.get("cancelled", False),
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
                cancelled = bool(_script_capture_state.get("cancelled"))

            if cancelled:
                with _script_capture_lock:
                    _script_capture_state["clips"] = clips
                    _script_capture_state["capture_log"] = engine.capture_log
                    _script_capture_state["running"] = False
                    _script_capture_state["error"] = "Script capture cancelled by user"

                cancelled_at = time.time()
                log_file_path = _persist_script_capture_log(project_dir, {
                    "project_id": body.project_id,
                    "capture_software": software,
                    "capture_mode": capture_mode,
                    "capture_resolution": capture_resolution,
                    "success": False,
                    "cancelled": True,
                    "error": "Script capture cancelled by user",
                    "started_at": _script_capture_state.get("started_at"),
                    "failed_at": cancelled_at,
                    "total_segments": _script_capture_state.get("total_segments", 0),
                    "completed_segments": _script_capture_state.get("completed_segments", 0),
                    "compiled_path": None,
                    "clips": clips,
                    "strategies": engine.segment_strategies,
                    "capture_log": engine.capture_log,
                })

                with _script_capture_lock:
                    _script_capture_state["log_file_path"] = log_file_path

                _do_broadcast(EventType.CAPTURE_SCRIPT_ERROR, {
                    "project_id": body.project_id,
                    "error": "Script capture cancelled by user",
                    "cancelled": True,
                    "log_file_path": log_file_path,
                })
                return

            # Mark each captured segment in persistent state
            for clip in clips:
                clip_path = clip.get("path", "")
                for seg_id_in_clip in clip.get("segments", []):
                    if clip_path:
                        script_state_service.mark_captured(project_dir, seg_id_in_clip, clip_path)

            with _script_capture_lock:
                _script_capture_state["clips"] = clips
                _script_capture_state["capture_log"] = engine.capture_log

            # Persist captured clip manifest for the Compose step.
            project_service.save_project_metadata(body.project_id, {
                "clips_manifest": engine.composition_manifest,
                "capture_manifest": engine.composition_manifest,
            })

            with _script_capture_lock:
                _script_capture_state["compiled_path"] = None
                _script_capture_state["running"] = False

            completed_at = time.time()
            log_file_path = _persist_script_capture_log(project_dir, {
                "project_id": body.project_id,
                "capture_software": software,
                "capture_mode": capture_mode,
                "capture_resolution": capture_resolution,
                "success": True,
                "error": None,
                "started_at": _script_capture_state.get("started_at"),
                "completed_at": completed_at,
                "total_segments": _script_capture_state.get("total_segments", 0),
                "completed_segments": _script_capture_state.get("completed_segments", 0),
                "compiled_path": None,
                "clips": clips,
                "strategies": engine.segment_strategies,
                "capture_log": engine.capture_log,
            })

            with _script_capture_lock:
                _script_capture_state["log_file_path"] = log_file_path

            _do_broadcast(EventType.CAPTURE_SCRIPT_COMPLETED, {
                "project_id": body.project_id,
                "clips": clips,
                "compiled_path": None,
                "total_clips": len(clips),
                "capture_log": engine.capture_log,
                "strategies": engine.segment_strategies,
                "log_file_path": log_file_path,
            })

        except Exception as exc:
            logger.error("[Capture API] Script capture worker error: %s", exc)
            abort_segment_id = None
            abort_action = None
            abort_reason = str(exc)
            if isinstance(exc, CaptureAbortError):
                abort_segment_id = exc.segment_id
                abort_action = exc.action
                abort_reason = exc.reason

            command_log.record(
                "capture-worker-error",
                {
                    "project_id": body.project_id,
                    "segment_id": abort_segment_id,
                    "action": abort_action,
                    "reason": abort_reason,
                    "error": str(exc),
                },
                result="error",
                source="api_capture",
            )

            with _script_capture_lock:
                _script_capture_state["error"] = str(exc)
                _script_capture_state["abort_segment_id"] = abort_segment_id
                _script_capture_state["abort_action"] = abort_action
                _script_capture_state["abort_reason"] = abort_reason
                _script_capture_state["running"] = False

            failed_at = time.time()
            log_file_path = _persist_script_capture_log(project_dir, {
                "project_id": body.project_id,
                "capture_software": software,
                "capture_mode": capture_mode,
                "capture_resolution": capture_resolution,
                "success": False,
                "error": str(exc),
                "abort_segment_id": abort_segment_id,
                "abort_action": abort_action,
                "abort_reason": abort_reason,
                "started_at": _script_capture_state.get("started_at"),
                "failed_at": failed_at,
                "total_segments": _script_capture_state.get("total_segments", 0),
                "completed_segments": _script_capture_state.get("completed_segments", 0),
                "compiled_path": _script_capture_state.get("compiled_path"),
                "clips": _script_capture_state.get("clips", []),
                "strategies": _script_capture_state.get("strategies", []),
                "capture_log": _script_capture_state.get("capture_log", []),
            })

            with _script_capture_lock:
                _script_capture_state["log_file_path"] = log_file_path

            _do_broadcast(EventType.CAPTURE_SCRIPT_ERROR, {
                "project_id": body.project_id,
                "error": str(exc),
                "abort_segment_id": abort_segment_id,
                "abort_action": abort_action,
                "abort_reason": abort_reason,
                "log_file_path": log_file_path,
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
        "capture_resolution": capture_resolution,
        "message": "Script capture started — follow progress via WebSocket",
    }


@router.post("/script-capture/cancel")
async def cancel_script_capture():
    """Cancel an in-progress script capture."""
    global _script_capture_engine
    loop = capture_service.get_event_loop()
    broadcast_fn = capture_service.get_broadcast_fn()

    with _script_capture_lock:
        if not _script_capture_state["running"]:
            return {"cancelled": False, "message": "No capture running"}
        _script_capture_state["cancelled"] = True
        engine = _script_capture_engine
        project_id = _script_capture_state.get("project_id")

    if engine is not None:
        engine.cancel()

    if broadcast_fn and loop and loop.is_running():
        asyncio.run_coroutine_threadsafe(
            broadcast_fn(make_event(EventType.CAPTURE_SCRIPT_PROGRESS, {
                "step": "cancelling",
                "message": "Cancellation requested — stopping current capture step...",
                "project_id": project_id,
            })),
            loop,
        )

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
            "log_file_path": _script_capture_state.get("log_file_path"),
        }
