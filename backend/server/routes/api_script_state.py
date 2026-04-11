"""
api_script_state.py
-------------------
REST endpoints for script lock, per-segment capture state, trash bin,
capture range, and PiP configuration.

  POST /api/script-state/{project_id}/lock          — Lock script
  POST /api/script-state/{project_id}/unlock        — Unlock script
  GET  /api/script-state/{project_id}/state         — Full capture state
  GET  /api/script-state/{project_id}/summary       — Capture progress summary
  POST /api/script-state/{project_id}/compare       — Compare new script (hash-based)
  POST /api/script-state/{project_id}/capture-range  — Set capture range
  POST /api/script-state/{project_id}/invalidate    — Invalidate a segment
  POST /api/script-state/{project_id}/mark-captured — Mark segment as captured
  GET  /api/script-state/{project_id}/trash         — Get trash bin contents
  POST /api/script-state/{project_id}/trash/empty   — Empty trash
  POST /api/script-state/{project_id}/trash/restore — Restore a clip from trash
  GET  /api/script-state/{project_id}/pip-config    — Get PiP config
  PUT  /api/script-state/{project_id}/pip-config    — Update PiP config
  POST /api/script-state/{project_id}/filter        — Filter script segments by mode
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from server.services.project_service import project_service
from server.services.script_state_service import script_state_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/script-state", tags=["script-state"])


# ── Helpers ─────────────────────────────────────────────────────────────────

def _get_project_dir(project_id: int) -> str:
    """Resolve project directory or raise 404."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project["project_dir"]


# ── Request Models ──────────────────────────────────────────────────────────

class LockRequest(BaseModel):
    script: list[dict[str, Any]]


class CompareRequest(BaseModel):
    script: list[dict[str, Any]]


class CaptureRangeRequest(BaseModel):
    start: float | None = None
    end: float | None = None


class InvalidateRequest(BaseModel):
    segment_id: str
    reason: str = "manual"


class MarkCapturedRequest(BaseModel):
    segment_id: str
    clip_path: str


class RestoreRequest(BaseModel):
    segment_id: str


class FilterRequest(BaseModel):
    script: list[dict[str, Any]]
    mode: str = "all"
    segment_ids: list[str] | None = None
    time_range: dict[str, float] | None = None


class PipConfigUpdate(BaseModel):
    enabled: bool | None = None
    position: str | None = None
    scale: float | None = None
    margin: int | None = None
    border: bool | None = None
    border_color: str | None = None
    border_width: int | None = None
    show_live_badge: bool | None = None


# ── Script Lock ─────────────────────────────────────────────────────────────

@router.post("/{project_id}/lock")
async def lock_script(project_id: int, body: LockRequest):
    """Lock the script and initialize per-segment capture tracking."""
    project_dir = _get_project_dir(project_id)
    state = script_state_service.lock_script(project_dir, body.script)
    return {"success": True, "state": state}


@router.post("/{project_id}/unlock")
async def unlock_script(project_id: int):
    """Unlock the script.

    Does not delete clips — use ``/compare`` after regenerating the
    script to detect which segments changed.
    """
    project_dir = _get_project_dir(project_id)
    state = script_state_service.unlock_script(project_dir)
    return {"success": True, "state": state}


# ── State / Summary ─────────────────────────────────────────────────────────

@router.get("/{project_id}/state")
async def get_state(project_id: int):
    """Get full capture state including all segment states."""
    project_dir = _get_project_dir(project_id)
    state = script_state_service.load_state(project_dir)
    return state


@router.get("/{project_id}/summary")
async def get_summary(project_id: int):
    """Get a quick summary of capture progress."""
    project_dir = _get_project_dir(project_id)
    return script_state_service.get_capture_summary(project_dir)


# ── Compare / Hash ──────────────────────────────────────────────────────────

@router.post("/{project_id}/compare")
async def compare_script(project_id: int, body: CompareRequest):
    """Compare a new script against the locked state.

    Returns counts of retained, invalidated, and new segments.
    Invalidated clips are moved to the trash bin.
    """
    project_dir = _get_project_dir(project_id)
    result = script_state_service.compare_and_update(project_dir, body.script)
    return result


# ── Capture Range ───────────────────────────────────────────────────────────

@router.post("/{project_id}/capture-range")
async def set_capture_range(project_id: int, body: CaptureRangeRequest):
    """Set the capture range.  Pass nulls to clear."""
    project_dir = _get_project_dir(project_id)
    state = script_state_service.set_capture_range(project_dir, body.start, body.end)
    return {"success": True, "capture_range": state.get("capture_range")}


# ── Segment State Changes ──────────────────────────────────────────────────

@router.post("/{project_id}/invalidate")
async def invalidate_segment(project_id: int, body: InvalidateRequest):
    """Invalidate a segment's capture (moves clip to trash)."""
    project_dir = _get_project_dir(project_id)
    script_state_service.invalidate_segment(project_dir, body.segment_id, body.reason)
    return {"success": True}


@router.post("/{project_id}/mark-captured")
async def mark_captured(project_id: int, body: MarkCapturedRequest):
    """Mark a segment as captured with its clip file path."""
    project_dir = _get_project_dir(project_id)
    script_state_service.mark_captured(project_dir, body.segment_id, body.clip_path)
    return {"success": True}


# ── Segment Filtering ──────────────────────────────────────────────────────

@router.post("/{project_id}/filter")
async def filter_segments(project_id: int, body: FilterRequest):
    """Filter script segments based on capture mode and range.

    Modes: ``all``, ``uncaptured_only``, ``specific_segments``, ``time_range``.
    """
    project_dir = _get_project_dir(project_id)
    filtered = script_state_service.filter_segments_by_mode(
        project_dir,
        body.script,
        mode=body.mode,
        segment_ids=body.segment_ids,
        time_range=body.time_range,
    )
    return {"segments": filtered, "count": len(filtered)}


# ── Trash Bin ───────────────────────────────────────────────────────────────

@router.get("/{project_id}/trash")
async def get_trash(project_id: int):
    """Get contents of the trash bin."""
    project_dir = _get_project_dir(project_id)
    trash = script_state_service.get_trash(project_dir)
    return {"trash": trash, "count": len(trash)}


@router.post("/{project_id}/trash/empty")
async def empty_trash(project_id: int):
    """Delete all trashed clips permanently."""
    project_dir = _get_project_dir(project_id)
    deleted = script_state_service.empty_trash(project_dir)
    return {"success": True, "deleted": deleted}


@router.post("/{project_id}/trash/restore")
async def restore_from_trash(project_id: int, body: RestoreRequest):
    """Restore a clip from trash back to active state."""
    project_dir = _get_project_dir(project_id)
    success = script_state_service.restore_from_trash(project_dir, body.segment_id)
    if not success:
        raise HTTPException(status_code=404, detail="Clip not found in trash")
    return {"success": True}


# ── PiP Configuration ──────────────────────────────────────────────────────

@router.get("/{project_id}/pip-config")
async def get_pip_config(project_id: int):
    """Get PiP overlay configuration."""
    project_dir = _get_project_dir(project_id)
    return script_state_service.get_pip_config(project_dir)


@router.put("/{project_id}/pip-config")
async def update_pip_config(project_id: int, body: PipConfigUpdate):
    """Update PiP overlay configuration."""
    project_dir = _get_project_dir(project_id)
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    config = script_state_service.update_pip_config(project_dir, updates)
    return config
