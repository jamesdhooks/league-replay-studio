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
  POST /api/capture/script-capture/validate — Validate persisted clips with FFmpeg
  POST /api/capture/script-capture/validate/recover — Delete/reset corrupt clips
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

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

_clip_validation_state: dict[str, Any] = {
    "running": False,
    "job_id": None,
    "project_id": None,
    "mode": None,
    "checked": 0,
    "total": 0,
    "percentage": 0,
    "message": "Idle",
    "logs": [],
    "report": None,
    "error": None,
    "started_at": None,
    "completed_at": None,
}
_clip_validation_lock = threading.Lock()


def _persist_script_capture_log(
    project_dir: str,
    payload: dict[str, Any],
    existing_path: str | None = None,
) -> Optional[str]:
    """Write script capture audit log to project-local JSON files.

    Stores a timestamped immutable record and updates a stable "latest" file
    for quick troubleshooting.
    """
    try:
        logs_dir = Path(project_dir) / "capture_logs"
        logs_dir.mkdir(parents=True, exist_ok=True)

        if existing_path:
            run_path = Path(existing_path)
        else:
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


def _script_capture_log_payload(
    project_id: int,
    *,
    success: bool | None = None,
    cancelled: bool = False,
    error: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    with _script_capture_lock:
        payload = {
            "schema": "league-replay-studio.capture-log",
            "schema_version": 1,
            "project_id": project_id,
            "success": success,
            "cancelled": cancelled,
            "error": error,
            "started_at": _script_capture_state.get("started_at"),
            "updated_at": time.time(),
            "total_segments": _script_capture_state.get("total_segments", 0),
            "completed_segments": _script_capture_state.get("completed_segments", 0),
            "compiled_path": _script_capture_state.get("compiled_path"),
            "clips": list(_script_capture_state.get("clips", [])),
            "strategies": list(_script_capture_state.get("strategies", [])),
            "capture_log": list(_script_capture_state.get("capture_log", [])),
            "capture_mode": _script_capture_state.get("capture_mode"),
            "capture_resolution": _script_capture_state.get("capture_resolution"),
            "capture_transport": _script_capture_state.get("capture_transport"),
            "validate_clips": _script_capture_state.get("validate_clips"),
            "retry_failed_clip_validation": _script_capture_state.get("retry_failed_clip_validation"),
            "clip_validation_retry_limit": _script_capture_state.get("clip_validation_retry_limit"),
        }
    if extra:
        payload.update(extra)
    return payload


def _update_script_capture_log_file(project_dir: str, project_id: int, **kwargs: Any) -> None:
    with _script_capture_lock:
        existing_path = _script_capture_state.get("log_file_path")
    log_file_path = _persist_script_capture_log(
        project_dir,
        _script_capture_log_payload(project_id, **kwargs),
        existing_path=existing_path,
    )
    if log_file_path and log_file_path != existing_path:
        with _script_capture_lock:
            _script_capture_state["log_file_path"] = log_file_path


def _persist_clip_validation_report(project_dir: str, payload: dict[str, Any], prefix: str = "clip_validation") -> Optional[str]:
    """Persist standalone clip validation runs independently of capture runs."""
    try:
        logs_dir = Path(project_dir) / "capture_logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
        report_path = logs_dir / f"{prefix}_{stamp}.json"
        latest_path = logs_dir / "latest_clip_validation.json"
        serialized = json.dumps(payload, indent=2, ensure_ascii=True)
        report_path.write_text(serialized, encoding="utf-8")
        latest_path.write_text(serialized, encoding="utf-8")
        return str(report_path)
    except Exception as exc:
        logger.error("[Capture API] Failed to persist clip validation report: %s", exc)
        return None


def _path_is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(root.resolve(strict=False))
        return True
    except ValueError:
        return False


def _validate_persisted_capture_clips(
    project_id: int,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[dict[str, Any], str, dict[str, Any]]:
    """Validate each currently captured project clip and persist its report."""
    from server.services.project_service import project_service
    from server.services.script_state_service import CAPTURE_CAPTURED, CAPTURE_UNCAPTURED, script_state_service
    from server.utils.script_capture import find_capture_ffmpeg, find_capture_ffprobe, validate_capture_clip_file

    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    project_dir = str(project.get("project_dir") or "")
    if not project_dir:
        raise HTTPException(status_code=400, detail="Project directory is not set")

    clips_root = (Path(project_dir) / "clips").resolve(strict=False)
    clips_by_path: dict[str, list[str]] = {}
    missing_events: list[dict[str, Any]] = []
    segment_states = script_state_service.get_segment_states(project_dir)
    non_capturable_segment_ids = {
        str(segment.get("id") or segment.get("segment_id") or "")
        for segment in (project.get("script") or [])
        if isinstance(segment, dict) and segment.get("type") in {"transition", "bridge"}
    }
    for segment_id, segment in segment_states.items():
        if (
            str(segment_id) in non_capturable_segment_ids
            or segment.get("segment_type") in {"transition", "bridge"}
        ):
            continue
        capture_state = str(segment.get("capture_state") or "")
        clip_path = str(segment.get("clip_path") or "").strip()
        if capture_state == CAPTURE_UNCAPTURED or not clip_path:
            missing_events.append({
                "segment_id": str(segment_id),
                "capture_state": capture_state or "uncaptured",
                "section": segment.get("section", ""),
                "event_type": segment.get("event_type", ""),
                "start_time": segment.get("start_time"),
                "end_time": segment.get("end_time"),
            })
        if capture_state != CAPTURE_CAPTURED or not clip_path:
            continue
        if clip_path:
            clips_by_path.setdefault(str(Path(clip_path).resolve(strict=False)), []).append(str(segment_id))

    ffprobe_path = find_capture_ffprobe()
    ffmpeg_path = find_capture_ffmpeg(ffprobe_path)
    validator_available = bool(ffprobe_path and ffmpeg_path)
    results: list[dict[str, Any]] = []
    progress_log: list[dict[str, Any]] = []

    def _emit_progress(data: dict[str, Any]) -> None:
        progress_log.append({
            "timestamp": time.time(),
            "level": data.get("level", "info"),
            "message": data.get("message", ""),
        })
        if progress_callback:
            progress_callback(data)

    sorted_clips = sorted(clips_by_path.items())
    total = len(sorted_clips)
    _emit_progress({
        "checked": 0,
        "total": total,
        "percentage": 0,
        "message": f"Preparing ffprobe for {total} captured clip(s)",
        "level": "info",
    })
    if missing_events:
        _emit_progress({
            "checked": 0,
            "total": total,
            "percentage": 0,
            "message": f"Capture audit found {len(missing_events)} event(s) awaiting capture",
            "level": "warning",
        })
    for index, (clip_path, segment_ids) in enumerate(sorted_clips, start=1):
        path = Path(clip_path)
        if not _path_is_within(path, clips_root):
            result = {
                "path": str(path),
                "valid": False,
                "size_bytes": path.stat().st_size if path.exists() else 0,
                "duration_seconds": None,
                "errors": ["Clip path is outside the project clips directory"],
                "segment_ids": segment_ids,
                "ffprobe_path": ffprobe_path,
                "safe_to_delete": False,
            }
        else:
            result = validate_capture_clip_file(str(path), segment_ids)
            result["safe_to_delete"] = validator_available
        results.append(result)
        _emit_progress({
            "checked": index,
            "total": total,
            "percentage": round(index / total * 100) if total else 100,
            "message": f"{Path(clip_path).name}: {'passed' if result.get('valid') else 'failed'}",
            "level": "success" if result.get("valid") else "error",
        })

    failed = [result for result in results if not result.get("valid")]
    report: dict[str, Any] = {
        "schema": "league-replay-studio.clip-validation-report",
        "schema_version": 1,
        "project_id": project_id,
        "validated_at": datetime.now(timezone.utc).isoformat(),
        "validator": "ffprobe+ffmpeg-decode",
        "validator_available": validator_available,
        "ffprobe_path": ffprobe_path,
        "ffmpeg_path": ffmpeg_path,
        "checked": len(results),
        "passed": len(results) - len(failed),
        "failed": failed,
        "results": results,
        "missing_events": missing_events,
        "capture_audit": {
            "total_event_count": sum(
                1 for segment_id, segment in segment_states.items()
                if str(segment_id) not in non_capturable_segment_ids
                and segment.get("segment_type") not in {"transition", "bridge"}
            ),
            "captured_event_count": sum(
                1 for segment_id, segment in segment_states.items()
                if str(segment_id) not in non_capturable_segment_ids
                and segment.get("segment_type") not in {"transition", "bridge"}
                and segment.get("capture_state") == CAPTURE_CAPTURED
                and segment.get("clip_path")
            ),
            "missing_event_count": len(missing_events),
        },
        "progress_log": progress_log,
    }
    report["log_file_path"] = _persist_clip_validation_report(project_dir, report)
    command_log.record(
        "capture-clip-validation",
        {"project_id": project_id, "checked": report["checked"], "failed": len(failed), "missing": len(missing_events)},
        result="error" if failed else "warning" if missing_events else "ok",
        source="api_capture",
    )
    return report, project_dir, project


def _remove_capture_manifest_entries(project_id: int, project: dict[str, Any], paths: set[str], segment_ids: set[str]) -> None:
    """Remove obsolete clip paths or segment IDs from composition manifests."""
    from server.services.project_service import project_service

    updates: dict[str, list[dict[str, Any]]] = {}
    for key in ("clips_manifest", "capture_manifest"):
        manifest = project.get(key)
        if not isinstance(manifest, list):
            continue
        filtered = [
            entry for entry in manifest
            if str(Path(str(entry.get("path") or "")).resolve(strict=False)) not in paths
            and str(entry.get("id") or entry.get("source_clip_id") or "") not in segment_ids
        ]
        if len(filtered) != len(manifest):
            updates[key] = filtered
    if updates:
        project_service.save_project_metadata(project_id, updates)


def _remove_invalid_capture_manifest_entries(project_id: int, project: dict[str, Any], failed_paths: set[str], failed_segment_ids: set[str]) -> None:
    """Remove deleted corrupt clips from the project composition manifests."""
    _remove_capture_manifest_entries(project_id, project, failed_paths, failed_segment_ids)


def _recover_corrupt_persisted_capture_clips(
    project_id: int,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Delete decode-failed clips and reset their linked events for recapture."""
    from server.services.script_state_service import script_state_service

    report, project_dir, project = _validate_persisted_capture_clips(project_id, progress_callback)
    if not report["validator_available"]:
        raise HTTPException(status_code=409, detail="FFmpeg validation is unavailable; corrupt clips cannot be safely recovered")

    if progress_callback:
        progress_callback({
            "checked": report["checked"],
            "total": report["checked"],
            "percentage": 100,
            "message": "Deleting confirmed corrupt clips and resetting events",
            "level": "info",
        })

    deleted_paths: set[str] = set()
    failed_segment_ids: set[str] = set()
    delete_errors: list[dict[str, str]] = []
    for failed in report["failed"]:
        if not failed.get("safe_to_delete"):
            continue
        path = Path(str(failed.get("path") or ""))
        try:
            path.unlink(missing_ok=True)
            deleted_paths.add(str(path.resolve(strict=False)))
            failed_segment_ids.update(str(segment_id) for segment_id in failed.get("segment_ids") or [] if segment_id)
        except OSError as exc:
            delete_errors.append({"path": str(path), "error": str(exc)})

    reset_segment_ids = script_state_service.reset_corrupt_capture_segments(project_dir, sorted(failed_segment_ids))
    _remove_invalid_capture_manifest_entries(project_id, project, deleted_paths, set(reset_segment_ids))
    recovery = {
        "deleted_clip_count": len(deleted_paths),
        "reset_segment_ids": reset_segment_ids,
        "delete_errors": delete_errors,
    }
    report["recovery"] = recovery
    report["recovery_log_file_path"] = _persist_clip_validation_report(
        project_dir,
        report,
        prefix="clip_validation_recovery",
    )
    command_log.record(
        "capture-clip-validation-recovery",
        {"project_id": project_id, **recovery},
        result="ok" if not delete_errors else "error",
        source="api_capture",
    )
    return report


def _start_persisted_clip_validation(project_id: int, mode: str) -> dict[str, Any]:
    """Start a non-blocking clip validation or recovery job."""
    with _script_capture_lock:
        if _script_capture_state["running"]:
            raise HTTPException(status_code=409, detail="Stop the active script capture before validating clips")
    with _clip_validation_lock:
        if _clip_validation_state["running"]:
            raise HTTPException(status_code=409, detail="A clip validation is already in progress")
        job_id = uuid.uuid4().hex
        _clip_validation_state.update({
            "running": True,
            "job_id": job_id,
            "project_id": project_id,
            "mode": mode,
            "checked": 0,
            "total": 0,
            "percentage": 0,
            "message": "Starting clip validation",
            "logs": [],
            "report": None,
            "error": None,
            "started_at": time.time(),
            "completed_at": None,
        })

    def _progress(data: dict[str, Any]) -> None:
        log_entry = {
            "timestamp": time.time(),
            "level": data.get("level", "info"),
            "message": data.get("message", ""),
        }
        with _clip_validation_lock:
            if _clip_validation_state.get("job_id") != job_id:
                return
            _clip_validation_state.update({
                "checked": data.get("checked", _clip_validation_state["checked"]),
                "total": data.get("total", _clip_validation_state["total"]),
                "percentage": data.get("percentage", _clip_validation_state["percentage"]),
                "message": data.get("message", _clip_validation_state["message"]),
            })
            _clip_validation_state["logs"].append(log_entry)

    def _run() -> None:
        try:
            report = (
                _recover_corrupt_persisted_capture_clips(project_id, _progress)
                if mode == "recover"
                else _validate_persisted_capture_clips(project_id, _progress)[0]
            )
            with _clip_validation_lock:
                _clip_validation_state.update({
                    "running": False,
                    "checked": report.get("checked", 0),
                    "total": report.get("checked", 0),
                    "percentage": 100,
                    "message": "Recovery complete" if mode == "recover" else "Validation complete",
                    "report": report,
                    "completed_at": time.time(),
                })
        except Exception as exc:
            logger.exception("[Capture API] Clip validation job failed: %s", exc)
            with _clip_validation_lock:
                _clip_validation_state.update({
                    "running": False,
                    "message": "Validation failed",
                    "error": str(exc),
                    "completed_at": time.time(),
                })

    threading.Thread(target=_run, daemon=True, name="clip-validation").start()
    return {
        "accepted": True,
        "running": True,
        "job_id": job_id,
        "project_id": project_id,
        "mode": mode,
        "checked": 0,
        "total": 0,
        "percentage": 0,
        "message": "Starting clip validation",
        "logs": [],
        "report": None,
        "error": None,
    }


def _restore_persisted_clip_validation_status(project_id: int) -> dict[str, Any] | None:
    """Reload the latest report when a development reload cleared job memory."""
    from server.services.project_service import project_service

    project = project_service.get_project(project_id)
    project_dir = str((project or {}).get("project_dir") or "")
    if not project_dir:
        return None

    report_path = Path(project_dir) / "capture_logs" / "latest_clip_validation.json"
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if int(report.get("project_id") or -1) != project_id:
        return None

    progress_log = report.get("progress_log") or []
    return {
        "running": False,
        "job_id": None,
        "project_id": project_id,
        "mode": "recover" if report.get("recovery") else "validate",
        "checked": report.get("checked", 0),
        "total": report.get("checked", 0),
        "percentage": 100,
        "message": "Validation report restored from disk",
        "logs": progress_log[-4:],
        "report": report,
        "error": None,
        "started_at": None,
        "completed_at": report_path.stat().st_mtime,
    }


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
        obs_control = None
        if active == "obs":
            from server.services.settings_service import settings_service
            from server.utils.obs_websocket import probe_obs_websocket
            obs_control = probe_obs_websocket(
                host=str(settings_service.get("obs_websocket_host", "127.0.0.1")),
                port=int(settings_service.get("obs_websocket_port", 4455) or 4455),
                password=str(settings_service.get("obs_websocket_password", "")),
            )
            obs_control["selected_transport"] = str(settings_service.get("obs_capture_control", "websocket"))

        return {
            "software": software,
            "active_software": active,
            "hotkeys": hotkeys,
            "watch_directory": watch_dir,
            "obs_control": obs_control,
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
    validate_clips: bool = True           # final metadata-and-decode validation pass
    retry_failed_clip_validation: bool = False
    clip_validation_retry_limit: int = 1


class PersistedClipValidationRequest(BaseModel):
    """Request a validation report for clips already captured to a project."""
    project_id: int


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
    obs_capture_control = str(settings_service.get("obs_capture_control", "websocket"))
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

        if (software != "obs" or obs_capture_control == "hotkey") and not hotkeys.get("start"):
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

        if software == "obs" and obs_capture_control == "websocket":
            from server.utils.obs_websocket import probe_obs_websocket
            obs_control = probe_obs_websocket(
                host=str(settings_service.get("obs_websocket_host", "127.0.0.1")),
                port=int(settings_service.get("obs_websocket_port", 4455) or 4455),
                password=str(settings_service.get("obs_websocket_password", "")),
            )
            if not obs_control["available"]:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "OBS direct control is unavailable. In OBS, enable Tools > WebSocket Server Settings, "
                        "then configure its host, port, and password in Settings > Camera Defaults. "
                        f"Details: {obs_control['reason']}"
                    ),
                )
            if obs_control["recording"]:
                raise HTTPException(status_code=409, detail="OBS is already recording; stop it before scripted capture")

    # Size the game window before replay/capture automation starts so the
    # recorder sees the intended client resolution from the first frame.
    from server.utils.window_capture import resize_capture_target

    try:
        resize_result = await asyncio.wait_for(
            asyncio.to_thread(resize_capture_target, capture_width, capture_height),
            timeout=10.0,
        )
    except TimeoutError as exc:
        raise HTTPException(
            status_code=504,
            detail=(
                "Timed out while resizing the iRacing capture window. "
                "Close blocking iRacing dialogs and retry Capture."
            ),
        ) from exc

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
    validate_clips = bool(body.validate_clips)
    retry_failed_clip_validation = bool(body.retry_failed_clip_validation)
    clip_validation_retry_limit = max(0, min(5, int(body.clip_validation_retry_limit or 0)))

    # Capture All is an explicit full replacement pass.  Archive the current
    # set first so deterministic recorder filenames cannot silently overwrite
    # it, and let the next run rebuild a complete manifest from fresh clips.
    recapture_reset = {"reset_segment_ids": [], "archived_clip_count": 0}
    if capture_mode == "all":
        recapture_reset = script_state_service.clear_all_captures(
            project_dir,
            reason="capture_all_requested",
        )
        if recapture_reset["reset_segment_ids"]:
            _remove_capture_manifest_entries(
                body.project_id,
                project,
                set(),
                set(recapture_reset["reset_segment_ids"]),
            )
        command_log.record(
            "capture-all-reset",
            {"project_id": body.project_id, **recapture_reset},
            result="ok",
            source="api_capture",
        )

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
            "capture_transport": "obs-websocket" if software == "obs" and obs_capture_control == "websocket" else "hotkey",
            "validate_clips": validate_clips,
            "retry_failed_clip_validation": retry_failed_clip_validation,
            "clip_validation_retry_limit": clip_validation_retry_limit,
            "recapture_reset": recapture_reset,
        })
    _update_script_capture_log_file(project_dir, body.project_id)

    def _progress_cb(data: dict) -> None:
        """Called by ScriptCaptureEngine on progress updates."""
        step = data.get("step", "")
        if step == "strategy_computed":
            with _script_capture_lock:
                _script_capture_state["strategies"] = data.get("strategies", [])
            _update_script_capture_log_file(project_dir, body.project_id)
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
            _update_script_capture_log_file(project_dir, body.project_id)
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
            _update_script_capture_log_file(project_dir, body.project_id)
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
            _update_script_capture_log_file(project_dir, body.project_id)
        elif step in ("final_clip_validation", "final_clip_validation_complete", "clip_validation_retry"):
            failed_segment_ids = list(data.get("failed_segment_ids") or [])
            for failed_item in data.get("failed") or []:
                failed_segment_ids.extend(failed_item.get("segment_ids") or [])
            if step == "clip_validation_retry" and failed_segment_ids:
                for failed_segment_id in sorted({str(s) for s in failed_segment_ids if s}):
                    script_state_service.mark_uncaptured(
                        project_dir,
                        failed_segment_id,
                    )
            _update_script_capture_log_file(project_dir, body.project_id)
            _do_broadcast(EventType.CAPTURE_SCRIPT_PROGRESS, {
                **data,
                "project_id": body.project_id,
            })
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
        from server.utils.script_capture import CaptureAbortError, ObsWebSocketRecorderAdapter, ScriptCaptureEngine, HotkeyRecorderAdapter

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
            watch_dir = capture_service.get_watch_directory()

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

            if software == "obs" and obs_capture_control == "websocket":
                recorder = ObsWebSocketRecorderAdapter(
                    watch_folder=watch_dir,
                    host=str(settings_service.get("obs_websocket_host", "127.0.0.1")),
                    port=int(settings_service.get("obs_websocket_port", 4455) or 4455),
                    password=str(settings_service.get("obs_websocket_password", "")),
                    cancelled_fn=lambda: _script_capture_state.get("cancelled", False),
                )
            else:
                hotkeys = capture_service.get_hotkeys()
                if not hotkeys.get("start"):
                    raise RuntimeError(f"No start hotkey configured for '{software}' mode")
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
                validate_clips=validate_clips,
                retry_failed_clip_validation=retry_failed_clip_validation,
                clip_validation_retry_limit=clip_validation_retry_limit,
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
                    "validate_clips": validate_clips,
                    "retry_failed_clip_validation": retry_failed_clip_validation,
                    "clip_validation_retry_limit": clip_validation_retry_limit,
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
                }, existing_path=_script_capture_state.get("log_file_path"))

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
            # Preserve clips produced by earlier partial/scripted runs. A
            # specific-segment retry should replace only the matching manifest
            # entries, never discard the rest of the project's captured clips.
            existing_project = project_service.get_project(body.project_id) or {}
            existing_manifest = existing_project.get("clips_manifest") or []
            merged_by_id = {
                str(entry.get("id") or entry.get("source_clip_id") or ""): entry
                for entry in existing_manifest
                if isinstance(entry, dict) and (entry.get("id") or entry.get("source_clip_id"))
            }
            for entry in engine.composition_manifest:
                if not isinstance(entry, dict):
                    continue
                entry_id = str(entry.get("id") or entry.get("source_clip_id") or "")
                if entry_id:
                    merged_by_id[entry_id] = entry
            merged_manifest = sorted(
                merged_by_id.values(),
                key=lambda entry: (int(entry.get("order", 0)), str(entry.get("id", ""))),
            )
            project_service.save_project_metadata(body.project_id, {
                "clips_manifest": merged_manifest,
                "capture_manifest": merged_manifest,
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
                "validate_clips": validate_clips,
                "retry_failed_clip_validation": retry_failed_clip_validation,
                "clip_validation_retry_limit": clip_validation_retry_limit,
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
            }, existing_path=_script_capture_state.get("log_file_path"))

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
                if abort_action == "clip_validation":
                    failed_segment_ids = []
                    for failed_item in exc.extra.get("failed") or []:
                        failed_segment_ids.extend(failed_item.get("segment_ids") or [])
                    for failed_segment_id in sorted({str(s) for s in failed_segment_ids if s}):
                        script_state_service.invalidate_segment(
                            project_dir,
                            failed_segment_id,
                            reason="capture_validation_failed",
                        )

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
                "validate_clips": validate_clips,
                "retry_failed_clip_validation": retry_failed_clip_validation,
                "clip_validation_retry_limit": clip_validation_retry_limit,
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
            if software == "obs" and obs_capture_control == "websocket" and hasattr(recorder, "close"):
                recorder.close()
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
        "validate_clips": validate_clips,
        "retry_failed_clip_validation": retry_failed_clip_validation,
        "clip_validation_retry_limit": clip_validation_retry_limit,
        "recapture_reset": recapture_reset,
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


@router.post("/script-capture/validate")
async def validate_persisted_script_capture(body: PersistedClipValidationRequest):
    """Start a non-blocking FFmpeg validation job for captured project clips."""
    return _start_persisted_clip_validation(body.project_id, "validate")


@router.get("/script-capture/validate/status")
async def get_persisted_clip_validation_status(project_id: int | None = None):
    """Return current validation progress and the completed report when ready."""
    with _clip_validation_lock:
        status = dict(_clip_validation_state)
    if status.get("running") or not project_id:
        return status
    if status.get("project_id") == project_id and status.get("report"):
        return status
    return _restore_persisted_clip_validation_status(project_id) or status


@router.post("/script-capture/validate/recover")
async def recover_corrupt_persisted_script_capture(body: PersistedClipValidationRequest):
    """Start non-blocking corrupt clip deletion and event reset recovery."""
    return _start_persisted_clip_validation(body.project_id, "recover")
