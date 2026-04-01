"""
api_overlay.py
--------------
REST endpoints for the overlay template engine.

Prefix: ``/api/overlay``

Endpoints:
  GET    /status               — Engine + template status
  POST   /init                 — Initialize Playwright engine
  POST   /shutdown             — Shut down engine
  GET    /templates             — List all templates (built-in + custom)
  GET    /templates/{id}        — Get template details
  POST   /templates             — Import / create custom template
  PUT    /templates/{id}        — Update custom template
  DELETE /templates/{id}        — Delete custom template
  POST   /templates/{id}/duplicate — Duplicate template
  POST   /templates/{id}/export — Export template data
  POST   /render                — Render a single overlay frame
  POST   /batch                 — Start batch render
  GET    /batch/status          — Batch render progress
  POST   /resolution            — Change rendering resolution
  POST   /overrides/{project_id}/{template_id}  — Save per-project override
  GET    /overrides/{project_id}/{template_id}   — Get per-project override
  DELETE /overrides/{project_id}/{template_id}  — Delete per-project override
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from server.services.overlay_service import overlay_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/overlay", tags=["overlay"])


# ── Request / Response Models ───────────────────────────────────────────────

class InitRequest(BaseModel):
    resolution: str = "1080p"


class RenderRequest(BaseModel):
    template_id: str
    frame_data: dict[str, Any] = {}
    project_id: Optional[int] = None


class BatchRenderRequest(BaseModel):
    template_id: str
    frames: list[dict[str, Any]]
    output_dir: str
    project_id: Optional[int] = None


class TemplateRequest(BaseModel):
    name: str
    description: str = ""
    style: str = "custom"
    html_content: str = ""
    resolutions: list[str] = ["1080p", "1440p", "4k"]


class TemplateUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    style: Optional[str] = None
    html_content: Optional[str] = None
    resolutions: Optional[list[str]] = None


class ResolutionRequest(BaseModel):
    resolution: str


class OverrideRequest(BaseModel):
    html_content: str


# ── Status ──────────────────────────────────────────────────────────────────

@router.get("/status")
async def get_status():
    """Get overlay engine and template status."""
    return overlay_service.status


# ── Engine lifecycle ────────────────────────────────────────────────────────

@router.post("/init")
async def init_engine(body: InitRequest):
    """Initialize the Playwright headless Chromium engine."""
    try:
        result = await overlay_service.initialize(body.resolution)
        return result
    except Exception as exc:
        logger.error("[Overlay API] Init failed: %s", exc)
        raise HTTPException(status_code=500, detail="Overlay engine initialization failed")


@router.post("/shutdown")
async def shutdown_engine():
    """Shut down the overlay rendering engine."""
    try:
        await overlay_service.shutdown()
        return {"success": True}
    except Exception as exc:
        logger.error("[Overlay API] Shutdown failed: %s", exc)
        raise HTTPException(status_code=500, detail="Overlay engine shutdown failed")


# ── Template CRUD ───────────────────────────────────────────────────────────

@router.get("/templates")
async def list_templates():
    """List all available overlay templates."""
    return {"templates": overlay_service.get_templates()}


@router.get("/templates/{template_id}")
async def get_template(template_id: str):
    """Get details for a specific template."""
    template = overlay_service.get_template(template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    return template


@router.post("/templates")
async def create_template(body: TemplateRequest):
    """Import / create a custom template."""
    try:
        result = overlay_service.import_template({
            "name": body.name,
            "description": body.description,
            "style": body.style,
            "html_content": body.html_content,
            "resolutions": body.resolutions,
        })
        return {"success": True, "template": result}
    except Exception as exc:
        logger.error("[Overlay API] Create template failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to create template")


@router.put("/templates/{template_id}")
async def update_template(template_id: str, body: TemplateUpdateRequest):
    """Update a custom template."""
    updates = body.model_dump(exclude_none=True)
    result = overlay_service.update_template(template_id, updates)
    if not result:
        raise HTTPException(status_code=404, detail="Template not found or is built-in")
    return {"success": True, "template": result}


@router.delete("/templates/{template_id}")
async def delete_template(template_id: str):
    """Delete a custom template."""
    deleted = overlay_service.delete_template(template_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Template not found or is built-in")
    return {"success": True}


@router.post("/templates/{template_id}/duplicate")
async def duplicate_template(template_id: str):
    """Duplicate a template as a new custom template."""
    result = overlay_service.duplicate_template(template_id)
    if not result:
        raise HTTPException(status_code=404, detail="Template not found")
    return {"success": True, "template": result}


@router.post("/templates/{template_id}/export")
async def export_template(template_id: str):
    """Export a template (metadata + HTML content)."""
    result = overlay_service.export_template(template_id)
    if not result:
        raise HTTPException(status_code=404, detail="Template not found")
    return {"success": True, "template": result}


# ── Rendering ───────────────────────────────────────────────────────────────

@router.post("/render")
async def render_frame(body: RenderRequest):
    """Render a single overlay frame as transparent PNG."""
    try:
        result = await overlay_service.render_frame(
            body.template_id,
            body.frame_data,
            project_id=body.project_id,
        )
        return result
    except Exception as exc:
        logger.error("[Overlay API] Render failed: %s", exc)
        raise HTTPException(status_code=500, detail="Overlay frame rendering failed")


@router.post("/batch")
async def start_batch_render(body: BatchRenderRequest):
    """Start a batch overlay render."""
    try:
        result = overlay_service.start_batch_render(
            body.template_id,
            body.frames,
            body.output_dir,
            project_id=body.project_id,
        )
        if not result.get("success"):
            raise HTTPException(status_code=409, detail=result.get("error"))
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[Overlay API] Batch render failed: %s", exc)
        raise HTTPException(status_code=500, detail="Batch render failed")


@router.get("/batch/status")
async def get_batch_status():
    """Get current batch render progress."""
    return overlay_service.status.get("batch_progress", {})


# ── Resolution ──────────────────────────────────────────────────────────────

@router.post("/resolution")
async def set_resolution(body: ResolutionRequest):
    """Change the rendering resolution."""
    from server.utils.overlay_engine import overlay_engine
    result = await overlay_engine.set_resolution(body.resolution)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error"))
    return result


# ── Per-project overrides ───────────────────────────────────────────────────

@router.post("/overrides/{project_id}/{template_id}")
async def save_override(project_id: int, template_id: str, body: OverrideRequest):
    """Save a per-project template override."""
    result = overlay_service.save_project_override(
        project_id, template_id, body.html_content
    )
    return {"success": True, **result}


@router.get("/overrides/{project_id}/{template_id}")
async def get_override(project_id: int, template_id: str):
    """Get a per-project template override."""
    content = overlay_service.get_project_override(project_id, template_id)
    if content is None:
        raise HTTPException(status_code=404, detail="No override found")
    return {"html_content": content, "project_id": project_id, "template_id": template_id}


@router.delete("/overrides/{project_id}/{template_id}")
async def delete_override(project_id: int, template_id: str):
    """Delete a per-project template override."""
    deleted = overlay_service.delete_project_override(project_id, template_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="No override found")
    return {"success": True}
