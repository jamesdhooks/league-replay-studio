"""
api_llm.py
----------
REST endpoints for LLM integration.

Endpoints:
  GET   /api/llm/status               — LLM availability status
  GET   /api/llm/skills               — List registered skills
  POST  /api/llm/execute              — Execute a skill with user prompt
  POST  /api/llm/editorial            — Shortcut for editorial skill
  POST  /api/llm/overlay/generate     — Shortcut for overlay element generation
  POST  /api/llm/overlay/augment      — Shortcut for overlay element augmentation
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from server.services.llm_service import (
    llm_service,
    LLMNotAvailableError,
    LLMProviderError,
    LLMSkillError,
)
from server.services.preset_service import preset_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/llm", tags=["llm"])


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

        if body.element_id:
            elements = preset.get("sections", {}).get(body.section, [])
            element = next((e for e in elements if e.get("id") == body.element_id), None)
            if not element:
                raise HTTPException(status_code=404, detail="Element not found in preset section")
            context["element"] = element

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
