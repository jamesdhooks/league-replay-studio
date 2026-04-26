"""
api_pipeline.py
----------------
REST endpoints for the one-click automated pipeline.

  GET  /api/pipeline/status        — Get current pipeline status
  GET  /api/pipeline/history       — Get pipeline run history
  POST /api/pipeline/start         — Start a new pipeline run
  POST /api/pipeline/pause         — Pause running pipeline
  POST /api/pipeline/resume        — Resume paused pipeline
  POST /api/pipeline/cancel        — Cancel pipeline run
  POST /api/pipeline/retry         — Retry failed step
  POST /api/pipeline/skip          — Skip failed step and continue
  GET  /api/pipeline/presets       — List pipeline presets
  POST /api/pipeline/presets       — Create new preset
  GET  /api/pipeline/presets/{id}  — Get single preset
  PUT  /api/pipeline/presets/{id}  — Update preset
  DELETE /api/pipeline/presets/{id} — Delete preset
  GET  /api/pipeline/runs/{id}/logs — Get step log entries for a run
  GET  /api/pipeline/projects/{id}/control-state — Full canonical control state
  PUT  /api/pipeline/projects/{id}/control-state — Save canonical control state
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from server.services.pipeline_service import pipeline_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/pipeline", tags=["pipeline"])


# ── Request/Response models ──────────────────────────────────────────────────

class StartPipelineRequest(BaseModel):
    """Request to start a new pipeline run."""
    project_id: int
    preset_id: Optional[str] = None
    config: Optional[dict] = None


class RetryStepRequest(BaseModel):
    """Request to retry a failed step."""
    step_name: str


class SkipStepRequest(BaseModel):
    """Request to skip a failed step."""
    step_name: str


class CreatePresetRequest(BaseModel):
    """Request to create a new pipeline preset."""
    name: str
    description: Optional[str] = ""
    # Export
    export_preset: Optional[str] = None
    output_dir: Optional[str] = None
    # Highlight config snapshot
    highlight_config: Optional[dict] = None
    # Overlay
    overlay_preset_id: Optional[str] = None
    overlay_variables: Optional[dict] = None
    # Capture
    capture_mode: str = "auto"
    # Upload config (applies when upload step is active)
    youtube_privacy: str = "unlisted"
    # Error handling
    failure_action: str = "pause"
    notify_on_completion: str = "toast"
    # Runtime flags
    non_interactive: bool = False


class UpdatePresetRequest(BaseModel):
    """Request to update a pipeline preset."""
    name: Optional[str] = None
    description: Optional[str] = None
    export_preset: Optional[str] = None
    output_dir: Optional[str] = None
    highlight_config: Optional[dict] = None
    overlay_preset_id: Optional[str] = None
    overlay_variables: Optional[dict] = None
    capture_mode: Optional[str] = None
    youtube_privacy: Optional[str] = None
    failure_action: Optional[str] = None
    notify_on_completion: Optional[str] = None
    non_interactive: Optional[bool] = None


class ProjectControlStateRequest(BaseModel):
    """Request to save full project control state envelope."""
    schema_version: Optional[int] = 1
    preset_id: Optional[str] = ""
    overrides: Optional[dict] = None
    controls: Optional[dict] = None


class PreflightRequest(BaseModel):
    """Request to run a pipeline preflight check."""
    project_id: int
    preset_id: Optional[str] = None
    config: Optional[dict] = None


class ResetPipelineRequest(BaseModel):
    """Request to reset current pipeline state."""
    project_id: Optional[int] = None


# ── Status endpoints ─────────────────────────────────────────────────────────

@router.get("/status")
async def get_pipeline_status():
    """Get current pipeline status.

    Returns:
        Current pipeline run state, steps progress, and control flags.
    """
    return pipeline_service.status


@router.post("/preflight")
async def pipeline_preflight(req: PreflightRequest):
    """Run a preflight check before starting the pipeline.

    Validates that all prerequisites are met: project exists, output directory
    is writable, iRacing is connected (if capture needed), YouTube is
    authenticated (if upload enabled), etc.

    Returns:
        { "ok": bool, "issues": [{ "level": "error"|"warning", "code": str, "message": str }] }
    """
    try:
        issues = pipeline_service.preflight_check(
            project_id=req.project_id,
            preset_id=req.preset_id,
            config=req.config,
        )
        has_errors = any(i["level"] == "error" for i in issues)
        return {"ok": not has_errors, "issues": issues}
    except Exception as exc:
        logger.exception("[Pipeline API] Preflight check failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc



@router.get("/history")
async def get_pipeline_history(
    limit: int = Query(default=20, ge=1, le=100),
):
    """Get pipeline run history.

    Args:
        limit: Maximum number of runs to return (1-100).

    Returns:
        List of recent pipeline runs.
    """
    return {"runs": pipeline_service.get_run_history(limit=limit)}


# ── Control endpoints ────────────────────────────────────────────────────────

@router.post("/start")
async def start_pipeline(req: StartPipelineRequest):
    """Start a new pipeline run.

    Args:
        req: Pipeline start request with project_id and optional preset/config.

    Returns:
        The new pipeline run status.
    """
    try:
        run = pipeline_service.start(
            project_id=req.project_id,
            preset_id=req.preset_id,
            config=req.config,
        )
        return {"run": run, "message": "Pipeline started"}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("[Pipeline API] Start failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/pause")
async def pause_pipeline():
    """Pause the running pipeline.

    Returns:
        Updated pipeline status.
    """
    try:
        run = pipeline_service.pause()
        return {"run": run, "message": "Pipeline paused"}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("[Pipeline API] Pause failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/resume")
async def resume_pipeline():
    """Resume a paused pipeline.

    Returns:
        Updated pipeline status.
    """
    try:
        run = pipeline_service.resume()
        return {"run": run, "message": "Pipeline resumed"}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("[Pipeline API] Resume failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/cancel")
async def cancel_pipeline():
    """Cancel the running pipeline.

    Returns:
        Updated pipeline status.
    """
    try:
        run = pipeline_service.cancel()
        return {"run": run, "message": "Pipeline cancelled"}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("[Pipeline API] Cancel failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/reset")
async def reset_pipeline(req: ResetPipelineRequest):
    """Reset active pipeline state to allow restart from the beginning."""
    try:
        result = pipeline_service.reset(project_id=req.project_id)
        return {"result": result, "message": "Pipeline reset"}
    except Exception as exc:
        logger.exception("[Pipeline API] Reset failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/retry")
async def retry_step(req: RetryStepRequest):
    """Retry a failed pipeline step.

    Args:
        req: Retry request with step name.

    Returns:
        Updated pipeline status.
    """
    try:
        run = pipeline_service.retry_step(req.step_name)
        return {"run": run, "message": f"Retrying step: {req.step_name}"}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("[Pipeline API] Retry failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/skip")
async def skip_step(req: SkipStepRequest):
    """Skip a failed pipeline step and continue.

    Args:
        req: Skip request with step name.

    Returns:
        Updated pipeline status.
    """
    try:
        run = pipeline_service.skip_step(req.step_name)
        return {"run": run, "message": f"Skipped step: {req.step_name}"}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("[Pipeline API] Skip failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ── Preset endpoints ─────────────────────────────────────────────────────────

@router.get("/presets")
async def list_presets():
    """List all pipeline presets.

    Returns:
        List of pipeline configuration presets.
    """
    return {"presets": pipeline_service.list_presets()}


@router.post("/presets")
async def create_preset(req: CreatePresetRequest):
    """Create a new pipeline preset.

    Args:
        req: Preset configuration.

    Returns:
        The created preset.
    """
    try:
        preset = pipeline_service.create_preset(req.model_dump())
        return {"preset": preset, "message": "Preset created"}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("[Pipeline API] Create preset failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/presets/{preset_id}")
async def get_preset(preset_id: str):
    """Get a single pipeline preset.

    Args:
        preset_id: The preset ID.

    Returns:
        The preset configuration.
    """
    preset = pipeline_service.get_preset(preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail=f"Preset not found: {preset_id}")
    return {"preset": preset}


@router.put("/presets/{preset_id}")
async def update_preset(preset_id: str, req: UpdatePresetRequest):
    """Update a pipeline preset.

    Args:
        preset_id: The preset ID.
        req: Updated configuration fields.

    Returns:
        The updated preset.
    """
    try:
        # Filter out None values
        update_data = {k: v for k, v in req.model_dump().items() if v is not None}
        preset = pipeline_service.update_preset(preset_id, update_data)
        if not preset:
            raise HTTPException(status_code=404, detail=f"Preset not found: {preset_id}")
        return {"preset": preset, "message": "Preset updated"}
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("[Pipeline API] Update preset failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.delete("/presets/{preset_id}")
async def delete_preset(preset_id: str):
    """Delete a pipeline preset.

    Args:
        preset_id: The preset ID.

    Returns:
        Success message.
    """
    if not pipeline_service.delete_preset(preset_id):
        raise HTTPException(status_code=404, detail=f"Preset not found: {preset_id}")
    return {"message": "Preset deleted"}


# ── Run logs endpoint ──────────────────────────────────────────────────────────────

@router.get("/runs/{run_id}/logs")
async def get_run_logs(
    run_id: str,
    limit: int = Query(default=200, ge=1, le=2000),
    step: Optional[str] = Query(default=None),
    level: Optional[str] = Query(default=None),
):
    """Get persisted step log entries for a pipeline run.

    Args:
        run_id: The pipeline run ID.
        limit: Maximum entries to return (default 200, max 2000).
        step: Optional filter by step name.
        level: Optional filter by log level (info/warning/error/success).

    Returns:
        List of log entries ordered oldest-first.
    """
    logs = pipeline_service.get_run_logs(run_id, limit=limit, step=step, level=level)
    return {"run_id": run_id, "logs": logs}


# ── Project control-state endpoints ─────────────────────────────────────────

@router.get("/projects/{project_id}/control-state")
async def get_project_control_state(project_id: int):
    """Get unified full control-state envelope for a project.

    Aggregates controls persisted across pipeline overrides, analysis DB,
    and script_state into one response contract.
    """
    try:
        return pipeline_service.get_project_control_state(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("[Pipeline API] Get project control-state failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.put("/projects/{project_id}/control-state")
async def save_project_control_state(project_id: int, req: ProjectControlStateRequest):
    """Save unified full control-state envelope for a project."""
    try:
        return pipeline_service.save_project_control_state(project_id, req.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("[Pipeline API] Save project control-state failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
