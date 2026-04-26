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
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from server.services.composition_service import composition_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/composition", tags=["composition"])


# ── Request / Response Models ───────────────────────────────────────────────

class CompositionSelectionRequest(BaseModel):
    """Inline composition scope parameters for a single start request."""
    mode: str = "all"
    selected_segment_ids: list[str] | None = None
    region_start_seconds: float | None = None
    region_end_seconds: float | None = None


class StartCompositionRequest(BaseModel):
    """Request to start a composition pipeline job."""
    project_id: int
    script: list[dict[str, Any]]
    clips_manifest: list[dict[str, Any]]
    overlay_config: dict[str, Any] | None = None
    transition_config: dict[str, Any] | None = None
    trim_config: dict[str, Any] | None = None
    output_dir: str
    preset_id: str = "1080p"
    # Legacy convenience flag — superseded by composition_selection.mode = "captured_only"
    captured_only: bool = False
    # Compose scope: which segments/clips to include
    composition_selection: CompositionSelectionRequest | None = None
    # Gap handling policy: compress_gaps | fill_black | fade_bridge
    gap_policy: str | None = None


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
        # Resolve project directory once for filtering helpers
        from server.services.project_service import project_service
        from server.services.script_state_service import (
            GAP_POLICY_COMPRESS,
            VALID_GAP_POLICIES,
            script_state_service,
        )

        project = project_service.get_project(req.project_id)
        project_dir: str = project.get("project_dir", "") if project else ""

        script = list(req.script)
        clips_manifest = list(req.clips_manifest)

        # ── Selection filtering ──────────────────────────────────────────────
        # composition_selection takes precedence over the legacy captured_only flag.
        if req.composition_selection is not None:
            sel = req.composition_selection
            config = {
                "mode": sel.mode,
                "selected_segment_ids": sel.selected_segment_ids or [],
                "region_start_seconds": sel.region_start_seconds,
                "region_end_seconds": sel.region_end_seconds,
                "gap_policy": req.gap_policy or GAP_POLICY_COMPRESS,
            }
            if project_dir:
                script, clips_manifest = script_state_service.filter_manifest_by_composition_config(
                    project_dir, script, clips_manifest, config=config,
                )
                logger.info(
                    "[Composition API] Selection mode=%s kept %d clips / dropped %d",
                    sel.mode,
                    len(clips_manifest),
                    len(req.clips_manifest) - len(clips_manifest),
                )
        elif req.captured_only and project_dir:
            # Legacy path: keep only captured segments
            seg_states = script_state_service.get_segment_states(project_dir)
            captured_ids = {
                sid for sid, info in seg_states.items()
                if info.get("capture_state") == "captured"
            }
            original_count = len(clips_manifest)
            script = [
                s for s in script
                if s.get("id", s.get("segment_id", "")) in captured_ids
                or s.get("type") in {"transition", "bridge"}
            ]
            clips_manifest = [c for c in clips_manifest if c.get("id", c.get("segment_id", "")) in captured_ids]
            logger.info(
                "[Composition API] captured_only=True kept %d clips / dropped %d",
                len(clips_manifest),
                original_count - len(clips_manifest),
            )

        # ── Gap policy ───────────────────────────────────────────────────────
        effective_gap_policy = (req.gap_policy or GAP_POLICY_COMPRESS).strip().lower()
        if effective_gap_policy not in VALID_GAP_POLICIES:
            effective_gap_policy = GAP_POLICY_COMPRESS
        logger.info("[Composition API] gap_policy=%s", effective_gap_policy)

        result = composition_service.submit_job(
            project_id=req.project_id,
            script=script,
            clips_manifest=clips_manifest,
            overlay_config=req.overlay_config,
            transition_config=req.transition_config,
            trim_config=req.trim_config,
            output_dir=str(Path(project_dir) / "compositions") if project_dir else req.output_dir,
            preset_id=req.preset_id,
            gap_policy=effective_gap_policy,
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
