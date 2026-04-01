"""
api_encoding.py
----------------
REST endpoints for GPU-accelerated video encoding.

  GET  /api/encoding/gpus       — Detect GPU encoding capabilities
  GET  /api/encoding/presets    — List export presets
  POST /api/encoding/presets    — Save a custom preset
  DELETE /api/encoding/presets/{preset_id} — Delete a custom preset
  GET  /api/encoding/status     — Get encoding queue/job status
  POST /api/encoding/start      — Submit an encoding job
  POST /api/encoding/cancel/{job_id} — Cancel a job
  GET  /api/encoding/job/{job_id}    — Get job details
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from server.services.encoding_service import encoding_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/encoding", tags=["encoding"])


# ── Request models ──────────────────────────────────────────────────────────

class EncodeRequest(BaseModel):
    project_id: int
    input_file: str
    output_dir: str
    preset_id: str = "youtube_1080p60"
    edl: Optional[list[dict[str, Any]]] = None
    job_type: str = "full"
    custom_preset: Optional[dict[str, Any]] = None


class PresetRequest(BaseModel):
    id: Optional[str] = None
    name: str
    description: str = ""
    resolution_width: int = 1920
    resolution_height: int = 1080
    fps: int = 60
    codec_family: str = "h264"
    video_bitrate_mbps: float = 12
    audio_bitrate_kbps: int = 192
    quality_preset: str = "medium"


# ── GPU detection ───────────────────────────────────────────────────────────

@router.get("/gpus")
async def get_gpu_capabilities():
    """Detect GPU encoding capabilities.

    Returns available encoders (NVENC, AMF, QSV, CPU) and FFmpeg status.
    """
    try:
        return encoding_service.detect_gpus()
    except Exception as exc:
        logger.error("[Encoding API] GPU detection error: %s", exc)
        raise HTTPException(status_code=500, detail="GPU detection failed")


@router.post("/gpus/refresh")
async def refresh_gpu_capabilities():
    """Force re-detection of GPU capabilities."""
    try:
        return encoding_service.refresh_gpus()
    except Exception as exc:
        logger.error("[Encoding API] GPU refresh error: %s", exc)
        raise HTTPException(status_code=500, detail="GPU detection failed")


# ── Presets ─────────────────────────────────────────────────────────────────

@router.get("/presets")
async def get_presets():
    """List all available export presets."""
    return {"presets": encoding_service.get_presets()}


@router.post("/presets")
async def save_preset(body: PresetRequest):
    """Save a custom export preset."""
    try:
        preset = encoding_service.save_custom_preset(body.model_dump())
        return {"success": True, "preset": preset}
    except Exception as exc:
        logger.error("[Encoding API] Save preset error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to save preset")


@router.delete("/presets/{preset_id}")
async def delete_preset(preset_id: str):
    """Delete a custom export preset."""
    deleted = encoding_service.delete_custom_preset(preset_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Preset not found or is built-in")
    return {"success": True}


# ── Status ──────────────────────────────────────────────────────────────────

@router.get("/status")
async def get_encoding_status():
    """Get encoding queue status (active, queued, recent jobs)."""
    return encoding_service.status


# ── Submit job ──────────────────────────────────────────────────────────────

@router.post("/start")
async def start_encoding(body: EncodeRequest):
    """Submit an encoding job.

    Validates input, selects the best encoder, and adds the job to the queue.
    Encoding starts immediately if no other job is active.
    """
    try:
        result = encoding_service.submit_job(
            project_id=body.project_id,
            input_file=body.input_file,
            output_dir=body.output_dir,
            preset_id=body.preset_id,
            edl=body.edl,
            job_type=body.job_type,
            custom_preset=body.custom_preset,
        )
        if not result["success"]:
            raise HTTPException(status_code=400, detail=result.get("error", "Failed to start encoding"))
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[Encoding API] Start encoding error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to start encoding")


# ── Cancel job ──────────────────────────────────────────────────────────────

@router.post("/cancel/{job_id}")
async def cancel_encoding(job_id: str):
    """Cancel an active or queued encoding job."""
    try:
        result = encoding_service.cancel_job(job_id)
        if not result["success"]:
            raise HTTPException(status_code=400, detail=result.get("error", "Failed to cancel job"))
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[Encoding API] Cancel error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to cancel job")


# ── Get job details ─────────────────────────────────────────────────────────

@router.get("/job/{job_id}")
async def get_job(job_id: str):
    """Get details for a specific encoding job."""
    job = encoding_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job
