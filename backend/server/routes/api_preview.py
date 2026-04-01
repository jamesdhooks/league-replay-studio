"""
api_preview.py
---------------
REST endpoints for video preview system.

  POST /api/preview/init              — Start tiered preview generation
  GET  /api/preview/status/{pid}      — Get preview status
  POST /api/preview/cancel/{pid}      — Cancel preview generation
  GET  /api/preview/sprite/{pid}/{idx} — Serve a sprite sheet image
  GET  /api/preview/sprites/{pid}     — Get sprite sheet index
  GET  /api/preview/frame/{pid}       — Extract full-res frame at timestamp
  GET  /api/preview/proxy/{pid}       — Serve proxy video
  GET  /api/preview/audio/{pid}       — Serve audio track
  GET  /api/preview/info/{pid}        — Get source video info
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from server.services.preview_service import preview_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/preview", tags=["preview"])


# ── Request models ──────────────────────────────────────────────────────────

class PreviewInitRequest(BaseModel):
    project_id: int
    input_file: str
    preview_dir: str


# ── Init preview ────────────────────────────────────────────────────────────

@router.post("/init")
async def init_preview(body: PreviewInitRequest):
    """Start tiered preview generation for a project.

    Kicks off the background pipeline: keyframe index → sprite sheets → proxy → audio.
    Returns immediately with the job status.
    """
    try:
        result = preview_service.init_preview(
            project_id=body.project_id,
            input_file=body.input_file,
            preview_dir=body.preview_dir,
        )
        if not result["success"]:
            raise HTTPException(status_code=400, detail=result.get("error", "Failed to init preview"))
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[Preview API] Init error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to start preview generation")


# ── Status ──────────────────────────────────────────────────────────────────

@router.get("/status/{project_id}")
async def get_preview_status(project_id: int):
    """Get preview generation status for a project."""
    return preview_service.get_job_status(project_id)


# ── Cancel ──────────────────────────────────────────────────────────────────

@router.post("/cancel/{project_id}")
async def cancel_preview(project_id: int):
    """Cancel a running preview generation."""
    try:
        result = preview_service.cancel_preview(project_id)
        if not result["success"]:
            raise HTTPException(status_code=400, detail=result.get("error", "Failed to cancel"))
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[Preview API] Cancel error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to cancel preview")


# ── Sprite sheets ───────────────────────────────────────────────────────────

@router.get("/sprites/{project_id}")
async def get_sprites_index(project_id: int):
    """Get the sprite sheet index (metadata for all sheets)."""
    job = preview_service.get_job(project_id)
    if not job:
        raise HTTPException(status_code=404, detail="No preview for this project")

    index_path = Path(job.sprites_dir) / "sprites.json"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Sprite sheets not yet generated")

    try:
        data = json.loads(index_path.read_text(encoding="utf-8"))
        return data
    except (json.JSONDecodeError, OSError) as exc:
        logger.error("[Preview API] Sprites index read error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to read sprite index")


@router.get("/sprite/{project_id}/{sheet_index}")
async def get_sprite_sheet(project_id: int, sheet_index: int):
    """Serve a sprite sheet image file."""
    job = preview_service.get_job(project_id)
    if not job:
        raise HTTPException(status_code=404, detail="No preview for this project")

    sheet_file = Path(job.sprites_dir) / f"sprite_{sheet_index:04d}.jpg"
    if not sheet_file.exists():
        raise HTTPException(status_code=404, detail=f"Sprite sheet {sheet_index} not found")

    return FileResponse(str(sheet_file), media_type="image/jpeg")


# ── Frame extraction ────────────────────────────────────────────────────────

@router.get("/frame/{project_id}")
async def get_frame(
    project_id: int,
    t: float = Query(..., description="Timestamp in seconds"),
    input_file: str = Query(..., description="Source video file path"),
):
    """Extract and serve a full-resolution frame at the given timestamp."""
    frame_path = preview_service.get_frame(project_id, t, input_file)
    if not frame_path or not Path(frame_path).exists():
        raise HTTPException(status_code=404, detail="Frame extraction failed")

    return FileResponse(frame_path, media_type="image/jpeg")


# ── Proxy video ─────────────────────────────────────────────────────────────

@router.get("/proxy/{project_id}")
async def get_proxy_video(project_id: int):
    """Serve the proxy video file for playback."""
    job = preview_service.get_job(project_id)
    if not job:
        raise HTTPException(status_code=404, detail="No preview for this project")

    if not job.proxy_ready or not Path(job.proxy_path).exists():
        raise HTTPException(status_code=404, detail="Proxy video not yet ready")

    return FileResponse(
        str(job.proxy_path),
        media_type="video/mp4",
        filename="proxy.mp4",
    )


# ── Audio ───────────────────────────────────────────────────────────────────

@router.get("/audio/{project_id}")
async def get_audio(project_id: int):
    """Serve the extracted audio file."""
    job = preview_service.get_job(project_id)
    if not job:
        raise HTTPException(status_code=404, detail="No preview for this project")

    if not job.audio_ready or not Path(job.audio_path).exists():
        raise HTTPException(status_code=404, detail="Audio not yet ready")

    return FileResponse(
        str(job.audio_path),
        media_type="audio/mp4",
        filename="audio.m4a",
    )


# ── Video info ──────────────────────────────────────────────────────────────

@router.get("/info/{project_id}")
async def get_video_info(
    project_id: int,
    input_file: str = Query(..., description="Source video file path"),
):
    """Get video metadata for a source file."""
    from server.utils.preview_utils import get_video_info as _get_info

    if not Path(input_file).exists():
        raise HTTPException(status_code=404, detail="Video file not found")

    info = _get_info(input_file)
    if not info:
        raise HTTPException(status_code=500, detail="Failed to read video info")

    return info
