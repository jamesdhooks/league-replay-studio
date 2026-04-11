"""
api_composition.py
-------------------
REST endpoints for the video composition pipeline.

  POST /api/composition/start     — Start a composition job
  GET  /api/composition/status    — Get composition status
  GET  /api/composition/job/{id}  — Get a specific job
  POST /api/composition/cancel/{id} — Cancel a running job
  GET  /api/composition/log/{id}  — Get structured composition log
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from server.services.composition_service import composition_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/composition", tags=["composition"])


# ── Request / Response Models ───────────────────────────────────────────────

class StartCompositionRequest(BaseModel):
    """Request to start a composition pipeline job."""
    project_id: int
    script: list[dict[str, Any]]
    clips_manifest: list[dict[str, Any]]
    overlay_config: dict[str, Any] | None = None
    transition_config: dict[str, Any] | None = None
    trim_config: dict[str, Any] | None = None
    output_dir: str
    preset_id: str = "youtube_1080p60"


class CancelCompositionRequest(BaseModel):
    """Request to cancel a composition job."""
    pass


# ── Status ──────────────────────────────────────────────────────────────────

@router.get("/status")
async def get_composition_status():
    """Get current composition service status.

    Returns:
        Active job (if any), recent completed/failed jobs, busy flag.
    """
    return composition_service.status


@router.get("/job/{job_id}")
async def get_composition_job(job_id: str):
    """Get a specific composition job by ID.

    Args:
        job_id: The composition job identifier.

    Returns:
        Job state dict.
    """
    job = composition_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Composition job not found: {job_id}")
    return {"job": job}


# ── Control ─────────────────────────────────────────────────────────────────

@router.post("/start")
async def start_composition(req: StartCompositionRequest):
    """Start a new composition pipeline job.

    The backend will trim, overlay, insert transitions, and stitch
    the captured clips into a final video.  Progress is streamed via
    WebSocket ``composition:*`` events.

    Args:
        req: Composition parameters.

    Returns:
        ``{"success": true, "job": {...}}`` or error dict.
    """
    try:
        result = composition_service.submit_job(
            project_id=req.project_id,
            script=req.script,
            clips_manifest=req.clips_manifest,
            overlay_config=req.overlay_config,
            transition_config=req.transition_config,
            trim_config=req.trim_config,
            output_dir=req.output_dir,
            preset_id=req.preset_id,
        )
        if not result.get("success"):
            raise HTTPException(status_code=400, detail=result.get("error", "Unknown error"))
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("[Composition API] Start failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/cancel/{job_id}")
async def cancel_composition(job_id: str):
    """Cancel a running composition job.

    Args:
        job_id: The composition job identifier.

    Returns:
        Updated job state.
    """
    result = composition_service.cancel_job(job_id)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Cannot cancel"))
    return result


@router.get("/log/{job_id}")
async def get_composition_log(job_id: str):
    """Get the structured composition log for a job.

    Args:
        job_id: The composition job identifier.

    Returns:
        List of log entries from the composition pipeline.
    """
    job = composition_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Composition job not found: {job_id}")
    return {"log_entries": job.get("log_entries", [])}
