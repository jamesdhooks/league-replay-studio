"""
api_llm.py
----------
REST endpoints for LLM integration.

Endpoints:
  GET   /api/llm/status                   — LLM availability status
  GET   /api/llm/skills                   — List registered skills
  POST  /api/llm/execute                  — Execute a skill with user prompt
  POST  /api/llm/editorial                — Shortcut for editorial skill
  POST  /api/llm/overlay/generate         — Shortcut for overlay element generation
  POST  /api/llm/overlay/augment          — Shortcut for overlay element augmentation
  POST  /api/llm/overlay/generate-full    — Generate a complete overlay for all sections
"""

from __future__ import annotations

import logging
import re
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from server.events import EventType, make_event

from server.services.llm_service import (
    llm_service,
    LLMNotAvailableError,
    LLMProviderError,
    LLMSkillError,
)
from server.services.preset_service import preset_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/llm", tags=["llm"])
_broadcast_fn: Any = None


def set_broadcast_fn(fn: Any) -> None:
    """Set the WebSocket broadcast function (called from app.py)."""
    global _broadcast_fn
    _broadcast_fn = fn


def _broadcast_overlay_ai(event_type: str, data: dict[str, Any]) -> None:
    if _broadcast_fn is None:
        return

    try:
        _broadcast_fn(make_event(event_type, data))
    except Exception as exc:
        logger.debug("[LLM API] Broadcast error: %s", exc)


def _new_request_id() -> str:
    return uuid.uuid4().hex[:10]


_PROGRESS_DETAIL_KEYS = (
    "provider",
    "model",
    "attempt",
    "next_attempt",
    "max_attempts",
    "attempts",
    "status_code",
    "retryable",
    "error_category",
    "elapsed_ms",
    "backoff_seconds",
    "timeout_seconds",
    "user_prompt_chars",
    "system_prompt_chars",
)


def _format_progress_details(payload: dict[str, Any]) -> str:
    """Render selected progress metadata as a compact log-friendly string."""
    details: list[str] = []
    for key in _PROGRESS_DETAIL_KEYS:
        value = payload.get(key)
        if value is None:
            continue
        details.append(f"{key}={value}")

    error_detail = payload.get("error_detail")
    if isinstance(error_detail, str) and error_detail.strip():
        compact = " ".join(error_detail.split())
        if len(compact) > 220:
            compact = f"{compact[:217]}..."
        details.append(f"error_detail={compact}")

    return " ".join(details)


def _make_progress_callback(action: str, request_id: str, preset_id: str | None):
    def _callback(payload: dict[str, Any]) -> None:
        stage = payload.get("stage", "unknown")
        message = payload.get("message", stage)
        detail_suffix = _format_progress_details(payload)
        event_payload = {
            "source": "llm_overlay",
            "action": action,
            "request_id": request_id,
            "preset_id": preset_id,
            **payload,
        }
        if detail_suffix:
            logger.info(
                "[LLM API] [%s] %s stage=%s message=%s details=%s",
                request_id,
                action,
                stage,
                message,
                detail_suffix,
            )
        else:
            logger.info(
                "[LLM API] [%s] %s stage=%s message=%s",
                request_id,
                action,
                stage,
                message,
            )
        _broadcast_overlay_ai(EventType.OVERLAY_AI_STATUS, event_payload)

    return _callback


# ── Request models ──────────────────────────────────────────────────────────


class ExecuteSkillRequest(BaseModel):
    skill_id: str
    prompt: str
    context: dict[str, Any] | None = None


class EditorialRequest(BaseModel):
    prompt: str
    timeline: list[Any] | None = None
    scored_events: list[Any] | None = None
    metrics: dict[str, Any] | None = None
    race_info: dict[str, Any] | None = None


class OverlayGenerateRequest(BaseModel):
    prompt: str
    section: str = "race"
    preset_id: str | None = None
    existing_elements: list[Any] | None = None


class OverlayAugmentRequest(BaseModel):
    prompt: str
    section: str = "race"
    preset_id: str | None = None
    element_id: str | None = None


class OverlayEditHtmlRequest(BaseModel):
    prompt: str
    html_content: str
    template_id: str | None = None
    request_id: str | None = None
    section: str = "race"
    scope_mode: str = "section"  # "section" | "all_sections"
    workspace_path: str = "build"  # "build" | "design"
    section_html_map: dict[str, str] | None = None


class OverlayFullGenerateRequest(BaseModel):
    prompt: str
    preset_id: str
    request_id: str | None = None


_TAILWIND_CDN_SCRIPT_RE = re.compile(
    r'<script[^>]+src=["\'](?:https?:)?//cdn\.tailwindcss\.com["\'][^>]*>\s*</script>',
    flags=re.IGNORECASE,
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


# ── Status / discovery ─────────────────────────────────────────────────────


@router.get("/status")
async def get_status():
    """Return LLM availability status and provider information."""
    info = llm_service.get_provider_info()
    return {
        "available": info["available"],
        "provider": info["provider"],
        "model": info["model"],
        "skills": info["skills"],
    }


@router.get("/skills")
async def list_skills():
    """List all registered LLM skills with name and description."""
    skills = []
    for skill_id, skill in llm_service._skills.items():
        skills.append({
            "skill_id": skill_id,
            "name": skill.name,
            "description": skill.description,
        })
    return {"skills": skills}


# ── Generic skill execution ────────────────────────────────────────────────


@router.post("/execute")
async def execute_skill(body: ExecuteSkillRequest):
    """Execute a registered LLM skill with a user prompt and optional context."""
    logger.info("[LLM API] Execute skill='%s' prompt='%s'", body.skill_id, body.prompt[:80])
    try:
        result = await llm_service.execute_skill(
            skill_id=body.skill_id,
            user_prompt=body.prompt,
            context=body.context,
        )
    except LLMNotAvailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except LLMSkillError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except LLMProviderError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return result


# ── Editorial shortcut ─────────────────────────────────────────────────────


@router.post("/editorial")
async def execute_editorial(body: EditorialRequest):
    """Shortcut for the editorial skill — apply high-level editing instructions."""
    logger.info("[LLM API] Editorial prompt='%s'", body.prompt[:80])
    context: dict[str, Any] = {}
    if body.timeline is not None:
        context["timeline"] = body.timeline
    if body.scored_events is not None:
        context["scored_events"] = body.scored_events
    if body.metrics is not None:
        context["metrics"] = body.metrics
    if body.race_info is not None:
        context["race_info"] = body.race_info

    try:
        result = await llm_service.execute_skill(
            skill_id="editorial",
            user_prompt=body.prompt,
            context=context,
        )
    except LLMNotAvailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except LLMSkillError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except LLMProviderError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return result


# ── Overlay generation shortcut ────────────────────────────────────────────


@router.post("/overlay/generate")
async def generate_overlay_element(body: OverlayGenerateRequest):
    """Shortcut for overlay_design skill — generate a new overlay element."""
    logger.info("[LLM API] Overlay generate prompt='%s'", body.prompt[:80])
    context: dict[str, Any] = {"section": body.section}
    if body.existing_elements is not None:
        context["existing_elements"] = body.existing_elements
    if body.preset_id:
        preset = preset_service.get_preset(body.preset_id)
        if preset:
            context["preset_variables"] = preset.get("variables", {})

    try:
        result = await llm_service.execute_skill(
            skill_id="overlay_design",
            user_prompt=body.prompt,
            context=context,
        )
    except LLMNotAvailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except LLMSkillError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except LLMProviderError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return result


# ── Overlay augmentation shortcut ──────────────────────────────────────────

# ── Overlay HTML edit shortcut ─────────────────────────────────────────────


@router.post("/overlay/edit-html")
async def edit_overlay_html(body: OverlayEditHtmlRequest):
    """Shortcut for overlay_html_edit skill — modify a full overlay HTML template."""
    request_id = body.request_id or _new_request_id()
    logger.info("[LLM API] [%s] Overlay edit-html prompt='%s'", request_id, body.prompt[:80])
    scope_mode = body.scope_mode if body.scope_mode in {"section", "all_sections"} else "section"
    workspace_path = body.workspace_path if body.workspace_path in {"build", "design"} else "build"
    progress = _make_progress_callback("edit-html", request_id, body.template_id)
    progress({
        "stage": "request_received",
        "message": "Overlay HTML edit request received",
        "section": body.section,
        "scope_mode": scope_mode,
        "workspace_path": workspace_path,
    })

    context = {
        "current_html": body.html_content,
        "section": body.section,
        "template_id": body.template_id,
        "scope_mode": scope_mode,
        "workspace_path": workspace_path,
        "section_html_map": body.section_html_map or {},
    }
    try:
        result = await llm_service.execute_skill(
            skill_id="overlay_html_edit",
            user_prompt=body.prompt,
            context=context,
            progress_callback=progress,
        )
    except LLMNotAvailableError as exc:
        _broadcast_overlay_ai(EventType.OVERLAY_AI_ERROR, {
            "source": "llm_overlay",
            "action": "edit-html",
            "request_id": request_id,
            "preset_id": body.template_id,
            "stage": "failed",
            "message": str(exc),
        })
        raise HTTPException(status_code=503, detail=str(exc))
    except LLMSkillError as exc:
        _broadcast_overlay_ai(EventType.OVERLAY_AI_ERROR, {
            "source": "llm_overlay",
            "action": "edit-html",
            "request_id": request_id,
            "preset_id": body.template_id,
            "stage": "failed",
            "message": str(exc),
        })
        raise HTTPException(status_code=400, detail=str(exc))
    except LLMProviderError as exc:
        _broadcast_overlay_ai(EventType.OVERLAY_AI_ERROR, {
            "source": "llm_overlay",
            "action": "edit-html",
            "request_id": request_id,
            "preset_id": body.template_id,
            "stage": "failed",
            "message": str(exc),
            "detail": getattr(exc, "detail", "") or str(exc),
        })
        raise HTTPException(status_code=500, detail=str(exc))

    if isinstance(result, dict):
        touched_sections = result.get("touched_sections")
        if not isinstance(touched_sections, list) or not touched_sections:
            touched_sections = [body.section] if scope_mode == "section" else [
                "intro",
                "qualifying_results",
                "race",
                "race_results",
            ]
        result["touched_sections"] = touched_sections
        result["scope_mode"] = scope_mode
        result["workspace_path"] = workspace_path
        result["request_id"] = request_id

    _broadcast_overlay_ai(EventType.OVERLAY_AI_COMPLETED, {
        "source": "llm_overlay",
        "action": "edit-html",
        "request_id": request_id,
        "preset_id": body.template_id,
        "stage": "completed",
        "message": "Overlay HTML edit completed",
        "section": body.section,
        "scope_mode": scope_mode,
    })

    return result


@router.post("/overlay/augment")
async def augment_overlay_element(body: OverlayAugmentRequest):
    """Shortcut for overlay_augment skill — modify an existing overlay element."""
    logger.info("[LLM API] Overlay augment prompt='%s'", body.prompt[:80])
    context: dict[str, Any] = {"section": body.section}

    if body.preset_id:
        preset = preset_service.get_preset(body.preset_id)
        if not preset:
            raise HTTPException(status_code=404, detail="Preset not found")
        context["preset_variables"] = preset.get("variables", {})
        elements = preset.get("sections", {}).get(body.section, [])
        context["existing_elements"] = elements

        if body.element_id:
            element = next((e for e in elements if e.get("id") == body.element_id), None)
            if not element:
                raise HTTPException(status_code=404, detail="Element not found in preset section")
            context["target_element"] = element

    try:
        result = await llm_service.execute_skill(
            skill_id="overlay_augment",
            user_prompt=body.prompt,
            context=context,
        )
    except LLMNotAvailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except LLMSkillError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except LLMProviderError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return result


# ── Full overlay generation ────────────────────────────────────────────────


@router.post("/overlay/generate-full")
async def generate_full_overlay(body: OverlayFullGenerateRequest):
    """Generate a complete overlay HTML (all four sections) from a style description.

    Creates the Jinja2/HTML file directly on the specified preset so the
    user can immediately open the Build tab to inspect or refine it.
    """
    request_id = body.request_id or _new_request_id()
    logger.info("[LLM API] [%s] Overlay generate-full preset_id='%s' prompt='%s'", request_id, body.preset_id, body.prompt[:80])
    progress = _make_progress_callback("generate-full", request_id, body.preset_id)
    progress({
        "stage": "request_received",
        "message": "Full overlay generation request received",
    })

    preset = preset_service.get_preset(body.preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")

    try:
        result = await llm_service.execute_skill(
            skill_id="overlay_full_design",
            user_prompt=body.prompt,
            context={},
            progress_callback=progress,
        )
    except LLMNotAvailableError as exc:
        _broadcast_overlay_ai(EventType.OVERLAY_AI_ERROR, {
            "source": "llm_overlay",
            "action": "generate-full",
            "request_id": request_id,
            "preset_id": body.preset_id,
            "stage": "failed",
            "message": str(exc),
        })
        raise HTTPException(status_code=503, detail=str(exc))
    except LLMSkillError as exc:
        _broadcast_overlay_ai(EventType.OVERLAY_AI_ERROR, {
            "source": "llm_overlay",
            "action": "generate-full",
            "request_id": request_id,
            "preset_id": body.preset_id,
            "stage": "failed",
            "message": str(exc),
        })
        raise HTTPException(status_code=400, detail=str(exc))
    except LLMProviderError as exc:
        _broadcast_overlay_ai(EventType.OVERLAY_AI_ERROR, {
            "source": "llm_overlay",
            "action": "generate-full",
            "request_id": request_id,
            "preset_id": body.preset_id,
            "stage": "failed",
            "message": str(exc),
            "detail": getattr(exc, "detail", "") or str(exc),
        })
        raise HTTPException(status_code=500, detail=str(exc))

    progress({"stage": "postprocessing_html", "message": "Normalizing generated HTML"})
    html = _ensure_local_tailwind_runtime(result.get("html", ""))
    if not html:
        raise HTTPException(status_code=500, detail="LLM returned empty HTML")

    progress({"stage": "saving_html", "message": "Saving generated overlay HTML"})
    saved = preset_service.update_html_content(body.preset_id, html)
    if not saved:
        raise HTTPException(status_code=500, detail="Failed to save generated overlay HTML")

    _broadcast_overlay_ai(EventType.OVERLAY_AI_COMPLETED, {
        "source": "llm_overlay",
        "action": "generate-full",
        "request_id": request_id,
        "preset_id": body.preset_id,
        "stage": "completed",
        "message": "Full overlay generation completed",
    })

    return {
        "success": True,
        "request_id": request_id,
        "style_summary": result.get("style_summary", ""),
    }
