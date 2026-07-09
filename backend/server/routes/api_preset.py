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
import re
import hashlib
import base64
from uuid import uuid4
from typing import Any

from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from server.services.preset_service import preset_service, VIDEO_SECTIONS
from server.services.debug_log_service import debug_log_service
from server.utils.element_renderer import apply_frame_variable_overrides, resolve_frame_variable_overrides

logger = logging.getLogger(__name__)

MAX_ASSET_SIZE_BYTES = 10 * 1024 * 1024      # 10 MB
MAX_VIDEO_SIZE_BYTES = 500 * 1024 * 1024      # 500 MB
router = APIRouter(prefix="/api/presets", tags=["presets"])


def _sha1_text(value: str) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return hashlib.sha1(value.encode("utf-8", errors="ignore")).hexdigest()


def _build_result_summary(result: dict[str, Any] | None) -> dict[str, Any]:
    payload = result or {}
    rendered_html = payload.get("rendered_html") if isinstance(payload.get("rendered_html"), str) else ""
    png_base64 = payload.get("png_base64") if isinstance(payload.get("png_base64"), str) else ""
    return {
        "success": bool(payload.get("success")),
        "error": payload.get("error"),
        "elapsed_ms": payload.get("elapsed_ms"),
        "width": payload.get("width"),
        "height": payload.get("height"),
        "rendered_html_length": len(rendered_html),
        "rendered_html_sha1": _sha1_text(rendered_html),
        "rendered_html_head": rendered_html[:2000],
        "png_base64_length": len(png_base64),
        "png_base64_sha1": _sha1_text(png_base64),
    }


# ── Request models ──────────────────────────────────────────────────────────

class CreatePresetRequest(BaseModel):
    name: str = "Custom Preset"
    description: str = ""
    style: str = "custom"
    sections: dict[str, Any] | None = None
    variables: dict[str, Any] | None = None
    frame_variable_overrides: dict[str, Any] | None = None
    html_content: str | None = None

class UpdatePresetRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    style: str | None = None
    sections: dict[str, Any] | None = None
    variables: dict[str, Any] | None = None
    frame_variable_overrides: dict[str, Any] | None = None
    intro_video_path: str | None = None
    html_content: str | None = None

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
    project_id: int | None = None
    frame_data: dict[str, Any] | None = None
    variables: dict[str, Any] | None = None
    analyze_animations: bool = True
    include_rendered_html: bool = False
    render_screenshot: bool = True
    include_debug: bool = False
    prefer_html_content: bool = False
    page_index: int | None = None


class AssetScopeUpdateRequest(BaseModel):
    target_scope: str
    source_scope: str | None = None
    project_id: int | None = None


class AssetVariableRequest(BaseModel):
    filename: str | None = None
    scope: str = "global"
    project_id: int | None = None
    clear: bool = False


def _should_keep_existing_preview_value(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str) and not value.strip():
        return True
    if isinstance(value, (list, tuple, set, dict)) and len(value) == 0:
        return True
    return False


def _merge_preview_frame_data(defaults: dict[str, Any], overrides: dict[str, Any] | None) -> dict[str, Any]:
    merged = dict(defaults)
    if not overrides:
        return merged

    for key, val in overrides.items():
        if _should_keep_existing_preview_value(val):
            continue
        merged[key] = val
    return merged


def _apply_section_preview_overrides(frame_data: dict[str, Any], section: str) -> None:
    """Inject section-specific preview values so tile renders are visually distinct."""
    section_labels = {
        "intro": "Intro",
        "qualifying_results": "Qualifying",
        "race": "Race",
        "race_results": "Results",
    }

    # Keep canonical section id and provide legacy aliases some templates may use.
    section_alias = {
        "qualifying_results": "qualifying",
        "race_results": "results",
    }.get(section, section)

    frame_data["section_canonical"] = section
    frame_data["section"] = section  # canonical form so all tabs/endpoints agree
    frame_data["section_alias"] = section_alias  # legacy alias kept for old templates
    frame_data["overlay_preview_section"] = section
    frame_data["overlay_preview_section_label"] = section_labels.get(section, section)

    if section == "intro":
        frame_data["session_time"] = frame_data.get("session_time") or "00:00:15"
        frame_data["current_lap"] = 0
        frame_data["flag"] = "none"

    elif section == "qualifying_results":
        qualifying = frame_data.get("qualifying_results")
        if not (isinstance(qualifying, list) and qualifying):
            qualifying = frame_data.get("qualifying_standings")
        if isinstance(qualifying, list) and qualifying:
            frame_data["standings"] = qualifying
        frame_data["current_lap"] = frame_data.get("current_lap", 0)
        frame_data["flag"] = "none"

    elif section == "race_results":
        results = frame_data.get("race_results")
        if not (isinstance(results, list) and results):
            results = frame_data.get("final_standings")
        if isinstance(results, list) and results:
            frame_data["standings"] = results
        frame_data["flag"] = "checkered"


def _apply_pagination_preview_context(
    frame_data: dict[str, Any],
    preset: dict[str, Any],
    section: str,
    forced_page_index: int | None = None,
) -> None:
    """Populate page_* variables for html-content preview templates.

    Some custom overlay.html templates slice standings with page_start/page_end,
    so these must be present even when rendering via raw html-content path.
    """
    if not isinstance(frame_data, dict):
        return

    standings = frame_data.get("standings")
    if not isinstance(standings, list) or not standings:
        return

    section_elements = (preset or {}).get("sections", {}).get(section, [])
    pagination = None
    if isinstance(section_elements, list) and section_elements:
        for elem in section_elements:
            pag = elem.get("pagination") if isinstance(elem, dict) else None
            if isinstance(pag, dict) and pag.get("enabled"):
                pagination = pag
                break

    # Support html-only overlays that do not carry section element pagination
    # metadata by falling back to explicit frame_data hints or sane defaults.
    if isinstance(pagination, dict):
        raw_items_per_page = pagination.get("items_per_page", 10)
    else:
        raw_items_per_page = (
            frame_data.get("items_per_page")
            or frame_data.get("overlay_items_per_page")
            or frame_data.get("pagination_items_per_page")
            or max(1, len(standings))
        )
    try:
        items_per_page = int(raw_items_per_page or 10)
    except (TypeError, ValueError):
        items_per_page = 10
    items_per_page = max(1, items_per_page)

    total_pages = max(1, (len(standings) + items_per_page - 1) // items_per_page)

    resolved_index: int
    if forced_page_index is not None:
        resolved_index = int(forced_page_index)
    elif frame_data.get("overlay_page_index") is not None:
        try:
            resolved_index = int(frame_data.get("overlay_page_index"))
        except (TypeError, ValueError):
            resolved_index = 0
    else:
        elapsed = frame_data.get("overlay_section_elapsed_seconds", frame_data.get("overlay_clip_elapsed_seconds", 0.0))
        duration = frame_data.get("overlay_section_duration_seconds", frame_data.get("overlay_clip_duration_seconds", 0.0))
        try:
            elapsed_seconds = max(0.0, float(elapsed or 0.0))
        except (TypeError, ValueError):
            elapsed_seconds = 0.0
        try:
            duration_seconds = max(0.0, float(duration or 0.0))
        except (TypeError, ValueError):
            duration_seconds = 0.0
        raw_cycle_seconds = (
            pagination.get("cycle_duration_seconds", 0.0)
            if isinstance(pagination, dict)
            else (
                frame_data.get("cycle_duration_seconds")
                or frame_data.get("overlay_cycle_duration_seconds")
                or 0.0
            )
        )
        try:
            fixed_interval = float(raw_cycle_seconds or 0.0)
        except (TypeError, ValueError):
            fixed_interval = 0.0
        if fixed_interval > 0:
            interval = fixed_interval
        elif duration_seconds > 0:
            interval = duration_seconds / total_pages
        else:
            interval = 1.0
        interval = max(0.001, interval)
        resolved_index = int(elapsed_seconds / interval)

    safe_page_index = resolved_index % total_pages
    page_start = safe_page_index * items_per_page
    page_end = min(page_start + items_per_page, len(standings))
    page_key = f"page-{safe_page_index + 1}-rows-{page_start}-{page_end}"

    frame_data["overlay_page_index"] = safe_page_index
    frame_data["page_index"] = safe_page_index
    frame_data["total_pages"] = total_pages
    frame_data["page_start"] = page_start
    frame_data["page_end"] = page_end
    frame_data["page_key"] = page_key


_TAILWIND_CDN_SCRIPT_RE = re.compile(
    r'<script[^>]+src=["\'](?:https?:)?//cdn\.tailwindcss\.com["\'][^>]*>\s*</script>',
    flags=re.IGNORECASE,
)

_PRESET_VAR_STYLE_RE = re.compile(
    r'<style[^>]+id=["\']lrs-preset-vars-runtime["\'][^>]*>.*?</style>',
    flags=re.IGNORECASE | re.DOTALL,
)


def _ensure_local_tailwind_runtime(html_content: str) -> str:
    if not html_content:
        return html_content

    normalized = _TAILWIND_CDN_SCRIPT_RE.sub("", html_content)
    has_runtime = (
        'id="lrs-tailwind-runtime"' in normalized
        or "id='lrs-tailwind-runtime'" in normalized
    )
    if has_runtime:
        return normalized

    runtime_script = "<script id=\"lrs-tailwind-runtime\">{% include '_shared/tailwind.runtime.js' %}</script>"

    if "</head>" in normalized:
        return normalized.replace("</head>", f"  {runtime_script}\n</head>", 1)
    if "<head>" in normalized:
        return normalized.replace("<head>", f"<head>\n  {runtime_script}", 1)
    return f"{runtime_script}\n{normalized}"


def _inject_preset_css_variables(html_content: str, preset: dict[str, Any]) -> str:
    if not html_content:
        return html_content

    variables = preset.get("variables") if isinstance(preset, dict) else None
    if not isinstance(variables, dict) or not variables:
        return html_content

    declarations: list[str] = []
    for name, meta in variables.items():
        if not isinstance(name, str) or not name.strip():
            continue
        if isinstance(meta, dict):
            value = meta.get("value", "")
        else:
            value = meta
        declarations.append(f"  {name}: {value};")

    if not declarations:
        return html_content

    style_block = "\n".join([
        '<style id="lrs-preset-vars-runtime">',
        '  :root {',
        *declarations,
        '  }',
        '</style>',
    ])

    normalized = _PRESET_VAR_STYLE_RE.sub("", html_content)
    if "</head>" in normalized:
        return normalized.replace("</head>", f"  {style_block}\n</head>", 1)
    if "<head>" in normalized:
        return normalized.replace("<head>", f"<head>\n  {style_block}", 1)
    return f"{style_block}\n{normalized}"


def _normalize_asset_scope(scope: str | None) -> str:
    normalized = (scope or "global").strip().lower()
    if normalized not in {"global", "project"}:
        raise HTTPException(status_code=400, detail="scope must be 'global' or 'project'")
    return normalized


def _asset_url(preset_id: str, filename: str, scope: str, project_id: int | None = None) -> str:
    if scope == "project":
        if project_id is None:
            return f"/api/presets/{preset_id}/assets/{filename}?scope=project"
        return f"/api/presets/{preset_id}/assets/{filename}?scope=project&project_id={int(project_id)}"
    return f"/api/presets/{preset_id}/assets/{filename}?scope=global"


def _decorate_variable_bindings(
    preset_id: str,
    bindings: dict[str, dict[str, dict[str, str]]],
    project_id: int | None,
) -> dict[str, dict[str, dict[str, str]]]:
    decorated: dict[str, dict[str, dict[str, str]]] = {}
    for group_name in ("defaults", "overrides", "effective"):
        group = bindings.get(group_name) or {}
        group_out: dict[str, dict[str, str]] = {}
        for variable_name, binding in group.items():
            if not isinstance(binding, dict):
                continue
            filename = binding.get("filename")
            scope = binding.get("scope")
            if not isinstance(filename, str) or not isinstance(scope, str):
                continue
            group_out[variable_name] = {
                "filename": filename,
                "scope": scope,
                "url": _asset_url(preset_id, filename, scope, project_id),
            }
        decorated[group_name] = group_out
    return decorated


def _inject_asset_variables(frame_data: dict[str, Any], preset_id: str, project_id: int | None) -> None:
    frame_data["assets"] = preset_service.get_asset_variable_urls(preset_id, project_id)


async def _enrich_with_plugin_data(frame_data: dict[str, Any], project_id: int | None = None) -> dict[str, Any]:
    """Best-effort plugin enrichment for preview rendering.

    Uses subsession_id from frame_data when available, otherwise falls back to
    the project's stored subsession_id (if project_id is provided).
    """
    subsession_id = int(frame_data.get("subsession_id", 0) or 0)

    if subsession_id <= 0 and project_id is not None:
        from server.services.project_service import project_service

        project = project_service.get_project(project_id)
        if project:
            subsession_id = int(project.get("subsession_id", 0) or 0)

    if subsession_id <= 0:
        return frame_data

    try:
        from server.services.data_plugin_service import data_plugin_service
        return await data_plugin_service.enrich_frame_data(frame_data, subsession_id)
    except Exception as exc:
        logger.warning("[Preset] Plugin enrichment failed: %s", exc)
        return frame_data


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
async def create_preset(body: dict[str, Any]):
    """Create a new custom preset."""
    result = preset_service.create_preset(body or {})
    return {"success": True, "preset": result}


@router.put("/{preset_id}")
async def update_preset(preset_id: str, body: dict[str, Any]):
    """Update a custom preset."""
    result = preset_service.update_preset(preset_id, body or {})
    if not result:
        raise HTTPException(status_code=404, detail="Preset not found")
    return {"success": True, "preset": result}


@router.delete("/{preset_id}")
async def delete_preset(preset_id: str):
    """Delete a custom preset."""
    if not preset_service.delete_preset(preset_id):
        raise HTTPException(status_code=404, detail="Preset not found")
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
        raise HTTPException(status_code=404, detail="Preset not found")
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
async def list_assets(preset_id: str, project_id: int | None = Query(default=None)):
    """List uploaded assets for a preset."""
    payload = preset_service.list_assets(preset_id, project_id=project_id)
    assets = payload.get("assets", [])

    for asset in assets:
        filename = asset.get("filename")
        scope = asset.get("scope", "global")
        if isinstance(filename, str) and isinstance(scope, str):
            asset["url"] = _asset_url(preset_id, filename, scope, project_id)

    bindings = preset_service.get_asset_variable_bindings(preset_id, project_id)
    decorated_bindings = _decorate_variable_bindings(preset_id, bindings, project_id)

    return {
        "assets": assets,
        "count": len(assets),
        "bindings": decorated_bindings,
    }


@router.post("/{preset_id}/assets")
async def upload_asset(
    preset_id: str,
    file: UploadFile = File(...),
    scope: str = Form("global"),
    project_id: int | None = Form(default=None),
    variable_name: str | None = Form(default=None),
):
    """Upload an image asset for a preset."""
    normalized_scope = _normalize_asset_scope(scope)
    if file.size is not None and file.size > MAX_ASSET_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 10 MB)")
    content = await file.read()
    if len(content) > MAX_ASSET_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 10 MB)")
    try:
        result = preset_service.upload_asset(
            preset_id,
            file.filename or "asset.png",
            content,
            scope=normalized_scope,
            project_id=project_id,
            variable_name=variable_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    filename = result.get("filename")
    if isinstance(filename, str):
        result["url"] = _asset_url(preset_id, filename, normalized_scope, project_id)
    return {"success": True, **result}


@router.put("/{preset_id}/assets/{filename}/scope")
async def update_asset_scope(preset_id: str, filename: str, body: AssetScopeUpdateRequest):
    """Move an asset between global and project stores."""
    normalized_target = _normalize_asset_scope(body.target_scope)
    normalized_source = _normalize_asset_scope(body.source_scope) if body.source_scope else None
    try:
        result = preset_service.move_asset_scope(
            preset_id=preset_id,
            filename=filename,
            target_scope=normalized_target,
            project_id=body.project_id,
            source_scope=normalized_source,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    result["url"] = _asset_url(
        preset_id,
        result.get("filename") or filename,
        result.get("target_scope", normalized_target),
        body.project_id,
    )
    return {"success": True, **result}


@router.put("/{preset_id}/asset-variables/{variable_name}")
async def set_asset_variable(preset_id: str, variable_name: str, body: AssetVariableRequest):
    """Assign or clear an asset variable mapping for defaults or project overrides."""
    normalized_scope = _normalize_asset_scope(body.scope)
    try:
        result = preset_service.set_asset_variable(
            preset_id=preset_id,
            variable_name=variable_name,
            filename=body.filename,
            scope=normalized_scope,
            project_id=body.project_id,
            clear=body.clear,
        )
        bindings = preset_service.get_asset_variable_bindings(preset_id, body.project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return {
        "success": True,
        "mapping": result,
        "bindings": _decorate_variable_bindings(preset_id, bindings, body.project_id),
    }


@router.delete("/{preset_id}/assets/{filename}")
async def delete_asset(
    preset_id: str,
    filename: str,
    scope: str = Query(default="global"),
    project_id: int | None = Query(default=None),
):
    """Delete an asset."""
    normalized_scope = _normalize_asset_scope(scope)
    try:
        deleted = preset_service.delete_asset(
            preset_id,
            filename,
            scope=normalized_scope,
            project_id=project_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not deleted:
        raise HTTPException(status_code=404, detail="Asset not found")
    return {"success": True}


@router.get("/{preset_id}/assets/{filename}")
async def serve_asset(
    preset_id: str,
    filename: str,
    scope: str = Query(default="global"),
    project_id: int | None = Query(default=None),
):
    """Serve an asset file."""
    normalized_scope = _normalize_asset_scope(scope)
    path = preset_service.get_asset_path(
        preset_id,
        filename,
        scope=normalized_scope,
        project_id=project_id,
    )
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


# ── HTML content management ─────────────────────────────────────────────────

@router.get("/{preset_id}/html")
async def get_html_content(preset_id: str):
    """Get overlay HTML content for a design."""
    html = preset_service.get_html_content(preset_id)
    if html is None:
        raise HTTPException(status_code=404, detail="Preset not found")
    return {"html_content": html, "preset_id": preset_id}


@router.put("/{preset_id}/html")
async def update_html_content(preset_id: str, body: dict[str, Any]):
    """Update overlay HTML content for a custom design."""
    html_content = body.get("html_content")
    if html_content is None:
        raise HTTPException(status_code=400, detail="html_content is required")
    if not preset_service.update_html_content(preset_id, html_content):
        raise HTTPException(status_code=404, detail="Preset not found")
    return {"success": True, "preset_id": preset_id}


class EditorPreviewRequest(BaseModel):
    html_content: str
    project_id: int | None = None
    frame_data: dict[str, Any] = {}
    analyze_animations: bool = False
    include_rendered_html: bool = False
    render_screenshot: bool = True
    page_index: int | None = None


@router.post("/{preset_id}/editor-preview")
async def editor_preview(preset_id: str, body: EditorPreviewRequest):
    """Render a live preview of raw HTML content for the Build editor."""
    from server.services.overlay_service import overlay_service, SAMPLE_FRAME_DATA
    from server.utils.overlay_engine import overlay_engine

    preset = preset_service.get_preset(preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")

    debug_request_id = f"editor-preview-{uuid4().hex}"
    debug_log_service.write(
        "overlay.editor_preview.request",
        {
            "debug_request_id": debug_request_id,
            "preset_id": preset_id,
            "project_id": body.project_id,
            "section": (body.frame_data or {}).get("section"),
            "request": {
                "page_index": body.page_index,
                "analyze_animations": bool(body.analyze_animations),
                "include_rendered_html": bool(body.include_rendered_html),
                "render_screenshot": bool(body.render_screenshot),
                "html_content_length": len(body.html_content or ""),
                "html_content_sha1": _sha1_text(body.html_content or ""),
                "html_content_head": (body.html_content or "")[:2000],
                "frame_data": body.frame_data,
            },
        },
    )

    # Smart merge: use SAMPLE_FRAME_DATA as defaults, overlay caller values.
    frame_data = _merge_preview_frame_data(SAMPLE_FRAME_DATA, body.frame_data)
    if body.page_index is not None:
        frame_data["overlay_page_index"] = int(body.page_index)
    # Apply the same section overrides used by render-preview so Build/Design/Preview
    # tabs all see the same frame.section canonical value.
    section = frame_data.get("section") or "race"
    _apply_section_preview_overrides(frame_data, section)
    frame_data = await _enrich_with_plugin_data(frame_data, body.project_id)
    _inject_asset_variables(frame_data, preset_id, body.project_id)
    frame_data = apply_frame_variable_overrides(
        frame_data,
        preset.get("frame_variable_overrides"),
        project_id=body.project_id,
    )
    _apply_pagination_preview_context(frame_data, preset, section, body.page_index)
    frame_data["_debug_request_id"] = debug_request_id

    debug_log_service.write(
        "overlay.editor_preview.runtime",
        {
            "debug_request_id": debug_request_id,
            "preset_id": preset_id,
            "section": section,
            "frame_data": frame_data,
        },
    )

    try:
        if not overlay_engine.initialized:
            init_result = await overlay_service.initialize()
            if not init_result.get("success"):
                debug_log_service.write(
                    "overlay.editor_preview.output",
                    {
                        "debug_request_id": debug_request_id,
                        "preset_id": preset_id,
                        "section": section,
                        "result": _build_result_summary(init_result),
                    },
                )
                return init_result

        runtime_html = _inject_preset_css_variables(body.html_content, preset)
        result = await overlay_engine.render_raw_html(
            runtime_html,
            frame_data,
            analyze_animations=body.analyze_animations,
            include_rendered_html=body.include_rendered_html,
            render_screenshot=body.render_screenshot,
        )
        debug_log_service.write(
            "overlay.editor_preview.output",
            {
                "debug_request_id": debug_request_id,
                "preset_id": preset_id,
                "section": section,
                "result": _build_result_summary(result),
            },
        )
        return result
    except Exception as exc:
        debug_log_service.write(
            "overlay.editor_preview.exception",
            {
                "debug_request_id": debug_request_id,
                "preset_id": preset_id,
                "section": section,
                "error": str(exc),
            },
        )
        logger.exception("[Preset] Editor preview failed for %s", preset_id)
        raise HTTPException(status_code=500, detail="Editor preview rendering failed")


@router.get("/{preset_id}/editor-context")
async def get_editor_context(preset_id: str, project_id: int | None = None):
    """Get available Jinja2 template variables with sample values for the editor."""
    from server.services.overlay_service import SAMPLE_FRAME_DATA, VARIABLE_DOCS, VARIABLE_SOURCES

    preset = preset_service.get_preset(preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")

    variables = dict(SAMPLE_FRAME_DATA)
    variables = await _enrich_with_plugin_data(variables, project_id)
    _inject_asset_variables(variables, preset_id, project_id)
    variables = apply_frame_variable_overrides(
        variables,
        preset.get("frame_variable_overrides"),
        project_id=project_id,
    )

    return {
        "preset_id": preset_id,
        "variables": variables,
        "variable_docs": VARIABLE_DOCS,
        "variable_sources": VARIABLE_SOURCES,
    }


# ── Render preview ──────────────────────────────────────────────────────────

@router.post("/{preset_id}/render-preview")
async def render_preset_preview(preset_id: str, body: RenderPreviewRequest):
    """Render a live preview of a preset's elements for a given section.

    Composes all visible elements for the requested section into a single
    HTML document using percentage-based positioning, then renders via
    the overlay engine to produce a transparent PNG.
    """
    import copy

    from server.services.overlay_service import overlay_service, SAMPLE_FRAME_DATA
    from server.utils.overlay_engine import overlay_engine
    from server.utils.element_renderer import compose_preset_html

    preset = preset_service.get_preset(preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")

    debug_request_id = f"render-preview-{uuid4().hex}"
    debug_log_service.write(
        "overlay.render_preview.request",
        {
            "debug_request_id": debug_request_id,
            "preset_id": preset_id,
            "request": {
                "section": body.section,
                "project_id": body.project_id,
                "element_id": body.element_id,
                "page_index": body.page_index,
                "variables": body.variables,
                "analyze_animations": bool(body.analyze_animations),
                "include_rendered_html": bool(body.include_rendered_html),
                "render_screenshot": bool(body.render_screenshot),
                "include_debug": bool(body.include_debug),
                "prefer_html_content": bool(body.prefer_html_content),
                "frame_data": body.frame_data,
            },
        },
    )

    section = body.section

    # Start with rich SAMPLE_FRAME_DATA defaults, then overlay any
    # non-null / non-empty values the caller provided.  This ensures
    # overlay templates always have displayable content even when the
    # frontend sends sparse telemetry or a minimal fallback dict.
    frame_data = _merge_preview_frame_data(SAMPLE_FRAME_DATA, body.frame_data)
    if body.page_index is not None:
        frame_data["overlay_page_index"] = int(body.page_index)
    _apply_section_preview_overrides(frame_data, section)
    frame_data = await _enrich_with_plugin_data(frame_data, body.project_id)
    _inject_asset_variables(frame_data, preset_id, body.project_id)
    frame_data = apply_frame_variable_overrides(
        frame_data,
        preset.get("frame_variable_overrides"),
        project_id=body.project_id,
    )
    _apply_pagination_preview_context(frame_data, preset, section, body.page_index)
    frame_data["_debug_request_id"] = debug_request_id
    if body.variables:
        preset = copy.deepcopy(preset)
        preset["variables"] = body.variables

    resolution = overlay_engine.resolution

    section_elements = preset.get("sections", {}).get(section, [])
    has_section_elements = bool(section_elements)

    # Load the design HTML from disk (built-in templates or custom overlay.html)
    # rather than relying on the in-memory preset dict which doesn't carry it.
    design_html = _ensure_local_tailwind_runtime(preset_service.get_html_content(preset_id) or "")
    has_html_content = bool(design_html.strip())

    # For html-based designs (common in Build), callers can explicitly force
    # html_content rendering so Preview/Design match Build output.
    # Keep element-filter behavior on the composition path.
    render_source = "composed_sections"
    if has_html_content and not body.element_id and (body.prefer_html_content or not has_section_elements):
        html_content = _inject_preset_css_variables(design_html, preset)
        render_source = "preset_html_content"
    else:
        html_content = compose_preset_html(
            preset=preset,
            section=section,
            frame_data=frame_data,
            project_id=body.project_id,
            resolution=resolution,
            element_filter=body.element_id,
        )

    debug_log_service.write(
        "overlay.render_preview.runtime",
        {
            "debug_request_id": debug_request_id,
            "preset_id": preset_id,
            "section": section,
            "render_source": render_source,
            "frame_data": frame_data,
            "html_content_length": len(html_content),
            "html_content_sha1": _sha1_text(html_content),
            "html_content_head": html_content[:2000],
        },
    )

    # Render via overlay engine
    try:
        if not overlay_engine.initialized:
            init_result = await overlay_service.initialize()
            if not init_result.get("success"):
                debug_log_service.write(
                    "overlay.render_preview.output",
                    {
                        "debug_request_id": debug_request_id,
                        "preset_id": preset_id,
                        "section": section,
                        "render_source": render_source,
                        "result": _build_result_summary(init_result),
                    },
                )
                return init_result

        result = await overlay_engine.render_raw_html(
            html_content,
            frame_data,
            analyze_animations=body.analyze_animations,
            include_rendered_html=True,
            render_screenshot=body.render_screenshot,
        )
        debug_log_service.write(
            "overlay.render_preview.output",
            {
                "debug_request_id": debug_request_id,
                "preset_id": preset_id,
                "section": section,
                "render_source": render_source,
                "result": _build_result_summary(result),
            },
        )
    except Exception as exc:
        debug_log_service.write(
            "overlay.render_preview.exception",
            {
                "debug_request_id": debug_request_id,
                "preset_id": preset_id,
                "section": section,
                "error": str(exc),
            },
        )
        logger.exception("[Preset] Render preview failed for %s", preset_id)
        raise HTTPException(status_code=500, detail="Failed to render preview")

    if body.include_debug and isinstance(result, dict):
        rendered_html = result.get("rendered_html") if isinstance(result.get("rendered_html"), str) else ""
        png_base64 = result.get("png_base64") if isinstance(result.get("png_base64"), str) else ""
        effective_overrides = resolve_frame_variable_overrides(
            preset.get("frame_variable_overrides"),
            project_id=body.project_id,
        )

        rendered_html_sha1 = hashlib.sha1(rendered_html.encode("utf-8")).hexdigest() if rendered_html else None
        png_base64_sha1 = hashlib.sha1(png_base64.encode("ascii", errors="ignore")).hexdigest() if png_base64 else None

        png_bytes_sha1 = None
        if png_base64:
            try:
                png_bytes = base64.b64decode(png_base64)
                png_bytes_sha1 = hashlib.sha1(png_bytes).hexdigest()
            except Exception:
                png_bytes_sha1 = None

        result["debug_render"] = {
            "preset_id": preset_id,
            "section": section,
            "frame_section": frame_data.get("section"),
            "frame_section_canonical": frame_data.get("section_canonical"),
            "frame_overlay_page_index": frame_data.get("overlay_page_index"),
            "frame_page_index": frame_data.get("page_index"),
            "frame_page_start": frame_data.get("page_start"),
            "frame_page_end": frame_data.get("page_end"),
            "frame_total_pages": frame_data.get("total_pages"),
            "frame_page_key": frame_data.get("page_key"),
            "render_source": render_source,
            "has_html_content": has_html_content,
            "section_element_count": len(section_elements),
            "used_element_filter": bool(body.element_id),
            "prefer_html_content": bool(body.prefer_html_content),
            "include_rendered_html": bool(body.include_rendered_html),
            "render_screenshot": bool(body.render_screenshot),
            "html_length": len(html_content),
            "rendered_html_length": len(rendered_html),
            "rendered_html_sha1": rendered_html_sha1,
            "rendered_html_head": rendered_html[:500],
            "png_base64_length": len(png_base64),
            "png_base64_sha1": png_base64_sha1,
            "png_bytes_sha1": png_bytes_sha1,
            "frame_summary": {
                "driver_name": frame_data.get("driver_name"),
                "position": frame_data.get("position"),
                "current_lap": frame_data.get("current_lap", 0),
                "flag": frame_data.get("flag", ""),
                "standings_count": len(frame_data.get("standings", [])),
                "session_time": frame_data.get("session_time", ""),
            },
            "effective_override_keys": sorted(list(effective_overrides.keys())),
            "effective_override_sample": {
                key: frame_data.get(key)
                for key in sorted(list(effective_overrides.keys()))[:10]
            },
        }

        logger.info(
            "[Preset][render-preview] preset=%s section=%s source=%s elements=%s has_html=%s prefer_html=%s html_len=%s include_html=%s screenshot=%s",
            preset_id,
            section,
            render_source,
            len(section_elements),
            has_html_content,
            body.prefer_html_content,
            len(html_content),
            body.include_rendered_html,
            body.render_screenshot,
        )
    return result
