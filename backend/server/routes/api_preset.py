"""
api_preset.py
-------------
REST API routes for overlay preset management.

Endpoints:
  GET    /api/presets                              — List all presets
  GET    /api/presets/{preset_id}                  — Get a single preset
  POST   /api/presets                              — Create a new preset
  PUT    /api/presets/{preset_id}                  — Update a preset
  DELETE /api/presets/{preset_id}                  — Delete a preset
  POST   /api/presets/{preset_id}/duplicate        — Duplicate a preset
  POST   /api/presets/{preset_id}/export           — Export preset JSON
  POST   /api/presets/import                       — Import preset JSON

  POST   /api/presets/{preset_id}/sections/{section}/elements       — Add element
  PUT    /api/presets/{preset_id}/sections/{section}/elements/{eid} — Update element
  DELETE /api/presets/{preset_id}/sections/{section}/elements/{eid} — Remove element

  GET    /api/presets/{preset_id}/assets            — List assets
  POST   /api/presets/{preset_id}/assets            — Upload asset
  DELETE /api/presets/{preset_id}/assets/{filename}  — Delete asset
  GET    /api/presets/{preset_id}/assets/{filename}  — Serve asset

  POST   /api/presets/{preset_id}/intro-video       — Upload intro video
  DELETE /api/presets/{preset_id}/intro-video        — Delete intro video

  POST   /api/presets/{preset_id}/render-preview     — Render element preview
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel

from server.services.preset_service import preset_service, VIDEO_SECTIONS

logger = logging.getLogger(__name__)

MAX_ASSET_SIZE_BYTES = 10 * 1024 * 1024      # 10 MB
MAX_VIDEO_SIZE_BYTES = 500 * 1024 * 1024      # 500 MB
router = APIRouter(prefix="/api/presets", tags=["presets"])


# ── Request models ──────────────────────────────────────────────────────────

class CreatePresetRequest(BaseModel):
    name: str = "Custom Preset"
    description: str = ""
    sections: dict[str, Any] | None = None
    variables: dict[str, Any] | None = None

class UpdatePresetRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    sections: dict[str, Any] | None = None
    variables: dict[str, Any] | None = None
    intro_video_path: str | None = None

class ElementRequest(BaseModel):
    id: str | None = None
    name: str = "New Element"
    template: str = "<div>{{ frame.driver_name }}</div>"
    position: dict[str, float] = {"x": 10, "y": 10, "w": 20, "h": 10}
    z_index: int = 10
    visible: bool = True

class UpdateElementRequest(BaseModel):
    name: str | None = None
    template: str | None = None
    position: dict[str, float] | None = None
    z_index: int | None = None
    visible: bool | None = None

class ImportPresetRequest(BaseModel):
    preset_data: dict[str, Any]

class RenderPreviewRequest(BaseModel):
    element_id: str | None = None
    section: str = "race"
    frame_data: dict[str, Any] | None = None
    variables: dict[str, Any] | None = None


# ── Preset CRUD ─────────────────────────────────────────────────────────────

@router.get("")
async def list_presets():
    """List all overlay presets."""
    presets = preset_service.get_presets()
    return {"presets": presets, "count": len(presets)}


@router.get("/{preset_id}")
async def get_preset(preset_id: str):
    """Get a single preset."""
    preset = preset_service.get_preset(preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")
    return preset


@router.post("")
async def create_preset(body: CreatePresetRequest):
    """Create a new custom preset."""
    result = preset_service.create_preset(body.model_dump(exclude_none=True))
    return {"success": True, "preset": result}


@router.put("/{preset_id}")
async def update_preset(preset_id: str, body: UpdatePresetRequest):
    """Update a custom preset."""
    result = preset_service.update_preset(preset_id, body.model_dump(exclude_none=True))
    if not result:
        raise HTTPException(status_code=404, detail="Preset not found or is built-in")
    return {"success": True, "preset": result}


@router.delete("/{preset_id}")
async def delete_preset(preset_id: str):
    """Delete a custom preset."""
    if not preset_service.delete_preset(preset_id):
        raise HTTPException(status_code=404, detail="Preset not found or is built-in")
    return {"success": True}


@router.post("/{preset_id}/duplicate")
async def duplicate_preset(preset_id: str):
    """Duplicate a preset as a new custom preset."""
    result = preset_service.duplicate_preset(preset_id)
    if not result:
        raise HTTPException(status_code=404, detail="Preset not found")
    return {"success": True, "preset": result}


@router.post("/{preset_id}/export")
async def export_preset(preset_id: str):
    """Export preset as JSON."""
    result = preset_service.export_preset(preset_id)
    if not result:
        raise HTTPException(status_code=404, detail="Preset not found")
    return {"success": True, "preset_data": result}


@router.post("/import")
async def import_preset(body: ImportPresetRequest):
    """Import a preset from JSON."""
    result = preset_service.import_preset(body.preset_data)
    return {"success": True, "preset": result}


# ── Element management ──────────────────────────────────────────────────────

@router.post("/{preset_id}/sections/{section}/elements")
async def add_element(preset_id: str, section: str, body: ElementRequest):
    """Add an overlay element to a preset section."""
    if section not in VIDEO_SECTIONS:
        raise HTTPException(status_code=400, detail=f"Invalid section. Must be one of: {VIDEO_SECTIONS}")
    result = preset_service.add_element(preset_id, section, body.model_dump(exclude_none=True))
    if not result:
        raise HTTPException(status_code=404, detail="Preset not found or is built-in")
    return {"success": True, "element": result}


@router.put("/{preset_id}/sections/{section}/elements/{element_id}")
async def update_element(preset_id: str, section: str, element_id: str, body: UpdateElementRequest):
    """Update an element within a preset section."""
    result = preset_service.update_element(preset_id, section, element_id, body.model_dump(exclude_none=True))
    if not result:
        raise HTTPException(status_code=404, detail="Element not found")
    return {"success": True, "element": result}


@router.delete("/{preset_id}/sections/{section}/elements/{element_id}")
async def remove_element(preset_id: str, section: str, element_id: str):
    """Remove an element from a preset section."""
    if not preset_service.remove_element(preset_id, section, element_id):
        raise HTTPException(status_code=404, detail="Element not found")
    return {"success": True}


# ── Asset management ────────────────────────────────────────────────────────

@router.get("/{preset_id}/assets")
async def list_assets(preset_id: str):
    """List uploaded assets for a preset."""
    assets = preset_service.list_assets(preset_id)
    return {"assets": assets, "count": len(assets)}


@router.post("/{preset_id}/assets")
async def upload_asset(preset_id: str, file: UploadFile = File(...)):
    """Upload an image asset for a preset."""
    if file.size is not None and file.size > MAX_ASSET_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 10 MB)")
    content = await file.read()
    if len(content) > MAX_ASSET_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 10 MB)")
    result = preset_service.upload_asset(preset_id, file.filename or "asset.png", content)
    return {"success": True, **result}


@router.delete("/{preset_id}/assets/{filename}")
async def delete_asset(preset_id: str, filename: str):
    """Delete an asset."""
    if not preset_service.delete_asset(preset_id, filename):
        raise HTTPException(status_code=404, detail="Asset not found")
    return {"success": True}


@router.get("/{preset_id}/assets/{filename}")
async def serve_asset(preset_id: str, filename: str):
    """Serve an asset file."""
    path = preset_service.get_asset_path(preset_id, filename)
    if not path:
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(path)


# ── Intro video ─────────────────────────────────────────────────────────────

@router.post("/{preset_id}/intro-video")
async def upload_intro_video(preset_id: str, file: UploadFile = File(...)):
    """Upload an intro video for a preset."""
    if file.size is not None and file.size > MAX_VIDEO_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 500 MB)")
    content = await file.read()
    if len(content) > MAX_VIDEO_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 500 MB)")
    result = preset_service.upload_intro_video(preset_id, file.filename or "intro.mp4", content)
    return {"success": True, **result}


@router.delete("/{preset_id}/intro-video")
async def delete_intro_video(preset_id: str):
    """Delete the intro video for a preset."""
    preset_service.delete_intro_video(preset_id)
    return {"success": True}


# ── Render preview ──────────────────────────────────────────────────────────

@router.post("/{preset_id}/render-preview")
async def render_preset_preview(preset_id: str, body: RenderPreviewRequest):
    """Render a live preview of a preset's elements for a given section.

    Composes all visible elements for the requested section into a single
    HTML document using percentage-based positioning, then renders via
    the overlay engine to produce a transparent PNG.
    """
    from server.services.overlay_service import overlay_service, SAMPLE_FRAME_DATA

    preset = preset_service.get_preset(preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")

    section = body.section
    frame_data = body.frame_data or dict(SAMPLE_FRAME_DATA)
    frame_data["section"] = section
    variables = body.variables or preset.get("variables", {})

    # Build CSS variables string
    css_vars = "; ".join(f"{k}: {v['value'] if isinstance(v, dict) else v}" for k, v in variables.items())

    # Get elements for this section
    elements = preset.get("sections", {}).get(section, [])

    # If a specific element is requested, only show that one
    if body.element_id:
        elements = [e for e in elements if e["id"] == body.element_id]

    # Build composite HTML
    html_parts = [
        f'<!DOCTYPE html><html><head><meta charset="UTF-8">',
        f'<style>',
        f'  * {{ margin:0; padding:0; box-sizing:border-box; }}',
        f'  html, body {{ width:100%; height:100%; background:transparent; overflow:hidden; }}',
        f'  :root {{ {css_vars} }}',
        f'</style></head>',
        f'<body style="position:relative; width:100%; height:100%;">',
    ]

    for elem in elements:
        if not elem.get("visible", True):
            continue
        pos = elem.get("position", {"x": 0, "y": 0, "w": 100, "h": 100})
        template_html = elem.get("template", "")
        # Replace {{pos.*}} placeholders with actual position values
        template_html = template_html.replace("{{pos.x}}", str(pos.get("x", 0)))
        template_html = template_html.replace("{{pos.y}}", str(pos.get("y", 0)))
        template_html = template_html.replace("{{pos.w}}", str(pos.get("w", 100)))
        template_html = template_html.replace("{{pos.h}}", str(pos.get("h", 100)))

        html_parts.append(template_html)

    html_parts.append("</body></html>")
    html_content = "\n".join(html_parts)

    # Render via overlay engine
    try:
        result = await overlay_service.render_preview("__preset__", html_content, frame_data)
    except Exception:
        logger.exception("[Preset] Render preview failed for %s", preset_id)
        raise HTTPException(status_code=500, detail="Failed to render preview")
    return result
