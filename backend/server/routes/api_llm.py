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
  GET   /api/llm/race-story/{id}      — Get stored race story for project
  POST  /api/llm/race-story/{id}      — Generate race story for project
  DELETE /api/llm/race-story/{id}     — Delete stored race story
  GET   /api/llm/race-story/config    — Get race story system prompt info
"""

from __future__ import annotations

import hashlib
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
from server.services.project_service import project_service
from server.services.analysis_db import (
    init_analysis_db,
    get_project_db,
    get_events,
    get_drivers,
    get_race_story,
    save_race_story,
    delete_race_story as db_delete_race_story,
)
from server.services.settings_service import settings_service
from server.services.llm_skills import RACE_STORY_ICONS

# Gaps narrower than this threshold show millisecond precision (+3.456);
# wider gaps use decisecond precision (+72.1).
_GAP_PRECISION_THRESHOLD = 60

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


# ── Race Story endpoints ───────────────────────────────────────────────────


class RaceStoryRequest(BaseModel):
    force: bool = False


def _build_race_story_context(project_dir: str, project: dict) -> dict:
    """Gather all race data needed for the race story prompt."""
    init_analysis_db(project_dir)
    conn = get_project_db(project_dir)
    try:
        events = get_events(conn, limit=10000)
        drivers = get_drivers(conn)

        # Get final standings from the last recorded tick
        last_tick = conn.execute(
            "SELECT id, session_time, race_laps FROM race_ticks ORDER BY session_time DESC LIMIT 1"
        ).fetchone()

        standings = []
        race_duration = "Unknown"
        total_laps = 0
        if last_tick:
            tick_id = last_tick["id"]
            race_duration_secs = last_tick["session_time"]
            total_laps = last_tick["race_laps"]
            mins = int(race_duration_secs // 60)
            secs = int(race_duration_secs % 60)
            race_duration = f"{mins}m {secs}s"

            car_rows = conn.execute(
                "SELECT cs.car_idx, cs.position, cs.est_time, cs.best_lap_time, "
                "d.user_name, d.car_number "
                "FROM car_states cs "
                "LEFT JOIN drivers d ON cs.car_idx = d.car_idx AND d.is_spectator = 0 "
                "WHERE cs.tick_id = ? AND d.user_name IS NOT NULL "
                "ORDER BY cs.position ASC",
                (tick_id,),
            ).fetchall()

            leader_est = None
            for row in car_rows:
                if leader_est is None:
                    leader_est = row["est_time"]
                    gap = "Leader"
                else:
                    gap_val = row["est_time"] - leader_est
                    gap = f"+{gap_val:.3f}" if abs(gap_val) < _GAP_PRECISION_THRESHOLD else f"+{gap_val:.1f}"
                standings.append({
                    "position": row["position"],
                    "driver_name": row["user_name"] or f"Car #{row['car_number']}",
                    "car_number": row["car_number"] or "?",
                    "gap": gap,
                })

        # Build lap-by-lap position data for key drivers
        lap_data = []
        lap_rows = conn.execute(
            "SELECT lc.lap_number, lc.car_idx, lc.position, d.user_name "
            "FROM lap_completions lc "
            "LEFT JOIN drivers d ON lc.car_idx = d.car_idx AND d.is_spectator = 0 "
            "WHERE d.user_name IS NOT NULL "
            "ORDER BY lc.lap_number ASC, lc.position ASC"
        ).fetchall()
        for row in lap_rows:
            lap_data.append({
                "lap": row["lap_number"],
                "driver_name": row["user_name"] or "Unknown",
                "position": row["position"],
            })

        return {
            "track_name": project.get("track_name", "Unknown"),
            "total_laps": total_laps or project.get("num_laps", 0),
            "num_drivers": len(drivers),
            "race_duration": race_duration,
            "standings": standings,
            "events": events,
            "lap_data": lap_data,
        }
    finally:
        conn.close()


def _compute_context_hash(context: dict) -> str:
    """Compute a hash of the race context to detect data changes."""
    key_parts = [
        str(context.get("track_name", "")),
        str(context.get("total_laps", 0)),
        str(context.get("num_drivers", 0)),
        str(len(context.get("standings", []))),
        str(len(context.get("events", []))),
    ]
    return hashlib.sha256("|".join(key_parts).encode()).hexdigest()[:16]


@router.get("/race-story/config")
async def get_race_story_config():
    """Return race story configuration and system prompt info."""
    from server.services.llm_skills import _RACE_STORY_SYSTEM_PROMPT

    return {
        "system_prompt_template": _RACE_STORY_SYSTEM_PROMPT,
        "available_icons": RACE_STORY_ICONS,
        "config": {
            "min_summary_words": int(settings_service.get("race_story_min_summary_words", 60)),
            "max_summary_words": int(settings_service.get("race_story_max_summary_words", 150)),
            "min_sub_stories": int(settings_service.get("race_story_min_sub_stories", 3)),
            "max_sub_stories": int(settings_service.get("race_story_max_sub_stories", 8)),
            "custom_guidance": settings_service.get("race_story_custom_guidance", ""),
        },
    }


@router.get("/race-story/{project_id}")
async def get_project_race_story(project_id: int):
    """Get the stored race story for a project. Returns null if not yet generated."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    init_analysis_db(project_dir)
    conn = get_project_db(project_dir)
    try:
        story = get_race_story(conn)
        return {"race_story": story}
    finally:
        conn.close()


@router.post("/race-story/{project_id}")
async def generate_project_race_story(project_id: int, body: RaceStoryRequest = RaceStoryRequest()):
    """Generate a race story for a project.

    If a story already exists and ``force`` is false, returns the existing story
    (deduplication). Pass ``force=true`` to regenerate.
    """
    force = body.force
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    init_analysis_db(project_dir)

    # Check for existing story (deduplication)
    if not force:
        conn = get_project_db(project_dir)
        try:
            existing = get_race_story(conn)
            if existing is not None:
                logger.info(
                    "[LLM API] Race story already exists for project #%d, returning cached",
                    project_id,
                )
                return {"race_story": existing, "cached": True}
        finally:
            conn.close()

    # Build context from race data
    try:
        context = _build_race_story_context(project_dir, project)
    except Exception as exc:
        logger.error("[LLM API] Failed to build race story context: %s", exc)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to gather race data: {exc}",
        )

    prompt_hash = _compute_context_hash(context)
    model = settings_service.get("llm_model", "")

    # Execute LLM skill
    logger.info("[LLM API] Generating race story for project #%d", project_id)
    try:
        result = await llm_service.execute_skill(
            skill_id="race_story",
            user_prompt="Generate a race story from the provided race data.",
            context=context,
        )
    except LLMNotAvailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except LLMSkillError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except LLMProviderError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    # Save to database
    conn = get_project_db(project_dir)
    try:
        story = save_race_story(
            conn,
            summary=result["summary"],
            sub_stories=result["sub_stories"],
            model_used=model,
            prompt_hash=prompt_hash,
        )
        logger.info(
            "[LLM API] Race story saved for project #%d (%d sub-stories)",
            project_id,
            len(result["sub_stories"]),
        )
        return {"race_story": story, "cached": False}
    finally:
        conn.close()


@router.delete("/race-story/{project_id}")
async def delete_project_race_story(project_id: int):
    """Delete the stored race story for a project."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    init_analysis_db(project_dir)
    conn = get_project_db(project_dir)
    try:
        db_delete_race_story(conn)
        return {"deleted": True}
    finally:
        conn.close()
