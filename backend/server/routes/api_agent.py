"""
api_agent.py
------------
Agent-friendly REST facade for League Replay Studio automation.

This layer keeps existing LRS services as the source of truth and provides
stable, coarse-grained contracts for MCP tools.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from server.routes.api_projects import build_auto_project_name
from server.services.encoding_service import encoding_service
from server.services.iracing_bridge import bridge as iracing_bridge
from server.services.pipeline_service import pipeline_service
from server.services.project_service import project_service
from server.services.youtube_service import youtube_service

router = APIRouter(prefix="/api/agent", tags=["agent"])

WORKFLOW_STEPS = ["pipeline", "analysis", "editing", "overlay", "capture", "compose", "export", "upload"]
AUTO_PIPELINE_ACTIONS = ["start", "pause", "resume", "cancel", "retry_step", "skip_step", "reset", "status", "logs"]
MANUAL_STEP_ACTIONS = ["status", "logs", "configure", "validate", "start", "stop", "restart"]
PUBLIC_UPLOAD_CONFIRM_MESSAGE = "Public YouTube upload requires confirm_public=true"


class ReplayJobRequest(BaseModel):
    source: str = "current_iracing_session"
    project_id: int | None = None
    name: str = ""
    replay_file: str = ""
    preset_id: str | None = None
    auto_start: bool = False
    upload_policy: str = "unlisted"
    config: dict[str, Any] | None = None
    wait: bool = False


class StepControlRequest(BaseModel):
    action: str
    step: str | None = None
    preset_id: str | None = None
    config: dict[str, Any] | None = None
    run_id: str | None = None
    limit: int = 200
    level: str | None = None


class UploadStartRequest(BaseModel):
    file_path: str
    title: str
    description: str = ""
    tags: list[str] | None = None
    privacy: str = "unlisted"
    project_id: int | None = None
    playlist_id: str | None = None
    confirm_public: bool = False


class CaptureClipValidationRequest(BaseModel):
    recover_corrupt: bool = False


class HighlightScriptRequest(BaseModel):
    target_duration: float = 720.0
    continuity_preference: int = 0
    continuity_block_duration: int = 0
    continuity_block_count: int = 0
    continuity_gap_reach: int = 0
    continuity_event_diversity: int = 0
    weights: dict[str, int] = Field(default_factory=dict)
    min_severity: int = 0
    overrides: dict[str, str] = Field(default_factory=dict)
    section_config: dict[str, Any] = Field(default_factory=dict)
    clip_padding: float = 2.0
    clip_padding_after: float = 1.0
    padding_by_type: dict[str, Any] = Field(default_factory=dict)
    tuning: dict[str, Any] = Field(default_factory=dict)
    camera_weights: dict[str, Any] = Field(default_factory=dict)
    camera_recency_penalty: float = 0.5
    camera_recency_decay: float = 30.0
    dry_run: bool = False


def _session_summary() -> dict[str, Any]:
    session = dict(iracing_bridge.session_data or {}) if iracing_bridge.is_connected else {}
    return {
        "connected": bool(iracing_bridge.is_connected),
        "track_name": session.get("track_name", ""),
        "session_type": session.get("session_type", ""),
        "series_name": session.get("series_name") or session.get("series") or "",
        "subsession_id": session.get("subsession_id"),
        "driver_count": len(session.get("drivers", [])) if isinstance(session.get("drivers"), list) else 0,
        "session": session,
    }


def _flatten_project_files(files_result: dict[str, Any] | None) -> list[dict[str, Any]]:
    flattened: list[dict[str, Any]] = []
    if not files_result:
        return flattened
    for category in files_result.get("categories", []):
        for item in category.get("files", []):
            flattened.append({**item, "category": category.get("name"), "category_label": category.get("label")})
    return flattened


def _latest_file(files: list[dict[str, Any]], categories: set[str], extensions: set[str] | None = None) -> dict[str, Any] | None:
    matches = [
        f for f in files
        if f.get("category") in categories
        and (extensions is None or str(f.get("extension", "")).lower() in extensions)
    ]
    if not matches:
        return None
    return sorted(matches, key=lambda f: str(f.get("modified_at", "")), reverse=True)[0]


def _project_or_404(project_id: int) -> dict[str, Any]:
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


async def _youtube_status_bundle() -> dict[str, Any]:
    try:
        connection = await youtube_service.get_connection_status()
    except Exception as exc:
        connection = {"state": "error", "error": str(exc)}
    return {
        "connection": connection,
        "quota": youtube_service.get_quota_usage(),
        "upload": youtube_service.get_upload_status(),
        "defaults": youtube_service.get_upload_defaults(),
    }


def _validate_project(project_id: int, scope: str = "all") -> dict[str, Any]:
    project = _project_or_404(project_id)
    files_result = project_service.get_project_files(project_id) or {}
    files = _flatten_project_files(files_result)
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []

    latest_export = _latest_file(files, {"exports"}, {".mp4", ".mov", ".m4v", ".mkv", ".webm"})
    latest_composition = _latest_file(files, {"compose"}, {".mp4", ".mov", ".m4v", ".mkv", ".webm"})
    capture_file = _latest_file(files, {"captures"}, {".mp4", ".mov", ".m4v", ".mkv", ".webm"})
    replay_file = _latest_file(files, {"replay"}, {".rpy"})

    if scope in {"all", "auto", "analysis", "capture"} and not iracing_bridge.is_connected:
        warnings.append({"code": "IRACING_NOT_CONNECTED", "message": "iRacing is not connected"})
    if scope in {"all", "auto"} and not replay_file and not project.get("replay_file"):
        warnings.append({"code": "NO_REPLAY_FILE", "message": "No replay file is attached to this project"})
    if scope in {"all", "auto", "capture", "compose"} and not project.get("script"):
        warnings.append({"code": "NO_VIDEO_SCRIPT", "message": "No generated video script is stored on the project"})
    if scope in {"all", "auto", "compose"} and not project.get("clips_manifest") and not capture_file:
        warnings.append({"code": "NO_CAPTURED_CLIPS", "message": "No captured clips were found"})
    if scope in {"all", "auto", "export"} and not latest_composition:
        warnings.append({"code": "NO_COMPOSITION_OUTPUT", "message": "No composition output was found"})
    if scope in {"all", "auto", "upload"} and not latest_export:
        warnings.append({"code": "NO_EXPORT_OUTPUT", "message": "No exported video was found"})

    next_action = "start_auto_pipeline"
    if latest_export:
        next_action = "preview_or_upload_youtube"
    elif latest_composition:
        next_action = "run_export"
    elif project.get("clips_manifest") or capture_file:
        next_action = "run_compose"
    elif project.get("script"):
        next_action = "run_capture"

    return {
        "ok": not errors,
        "project_id": project_id,
        "scope": scope,
        "errors": errors,
        "warnings": warnings,
        "next_recommended_action": next_action,
        "artifacts": {
            "latest_export": latest_export,
            "latest_composition": latest_composition,
            "latest_capture": capture_file,
            "replay_file": replay_file,
        },
    }


def _run_logs(run_id: str | None, limit: int = 200, step: str | None = None, level: str | None = None) -> dict[str, Any]:
    if not run_id:
        status = pipeline_service.status
        run_id = (status.get("current_run") or {}).get("run_id") if isinstance(status, dict) else None
    if not run_id:
        return {"run_id": None, "logs": []}
    return {"run_id": run_id, "logs": pipeline_service.get_run_logs(run_id, limit=limit, step=step, level=level)}


@router.get("/capabilities")
async def get_agent_capabilities() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "preferred_orchestration": "auto_pipeline",
        "workflow_steps": WORKFLOW_STEPS,
        "auto_pipeline_actions": AUTO_PIPELINE_ACTIONS,
        "manual_step_actions": MANUAL_STEP_ACTIONS,
        "pipeline_presets": pipeline_service.list_presets(),
        "export_presets": encoding_service.get_presets(),
        "upload_policy": {
            "default_privacy": "unlisted",
            "public_requires_confirm_public": True,
        },
        "iracing": _session_summary(),
        "features": {
            "auto_project_naming": True,
            "project_file_read": True,
            "overlay_editing": True,
            "overlay_preview_artifacts": True,
            "manual_step_control": True,
            "capture_decode_validation": True,
            "capture_validation_retry": True,
            "manual_capture_clip_validation": True,
            "capture_reset_with_trash": True,
            "obs_websocket_control": True,
            "continuity_aware_script_generation": True,
            "highlight_script_dry_run": True,
            "script_regeneration_capture_reconciliation": True,
        },
        "highlights": {
            "target_duration_scope": "final_video",
            "regeneration": {
                "dry_run_returns_impact": True,
                "commit_archives_discarded_captures": True,
                "shared_recordings_invalidate_as_a_unit": True,
            },
            "continuity": {
                "config_path": "highlight_config.params.continuityPreference",
                "api_constraint": "continuity_preference",
                "minimum": 0,
                "maximum": 100,
                "default": 0,
                "retained_gaps_count_toward_target": True,
                "target_fill_preserved": True,
                "minimum_clip_duration_seconds": 6,
                "max_groups_at_100": 3,
                "selection_model": "anchor_lift+sequence_momentum+block_variety+continuity_fill",
                "script_segment_type": "event",
                "continuity_group_field": "continuity_group_id",
                "advanced_constraints": [
                    "continuity_block_duration",
                    "continuity_block_count",
                    "continuity_gap_reach",
                    "continuity_event_diversity",
                ],
            },
        },
        "capture": {
            "clip_validation": {
                "validator": "ffprobe+ffmpeg-decode",
                "default_validate_clips": True,
                "default_retry_failed_clip_validation": False,
                "default_clip_validation_retry_limit": 1,
                "max_clip_validation_retry_limit": 5,
                "config_keys": [
                    "validate_clips",
                    "retry_failed_clip_validation",
                    "clip_validation_retry_limit",
                ],
                "manual_actions": ["validate", "delete_and_reset_corrupt"],
                "status_endpoint": "/agent/projects/{project_id}/capture/validate-clips/status",
            },
            "recapture": {
                "capture_all_archives_existing": True,
                "clear_captures_endpoint": "/script-state/{project_id}/clear-captures",
            },
        },
    }


@router.post("/replay-jobs")
async def create_replay_job(req: ReplayJobRequest) -> dict[str, Any]:
    project = project_service.get_project(req.project_id) if req.project_id else None
    auto_name_source = "existing_project" if project else "provided"

    if not project:
        if req.source != "current_iracing_session":
            raise HTTPException(status_code=422, detail="Only source=current_iracing_session is supported for auto project creation")
        session = _session_summary()["session"]
        name = req.name.strip()
        if not name:
            name, auto_name_source = build_auto_project_name(session)
        project = project_service.create_project(
            name=name,
            replay_file=req.replay_file,
            track_name=session.get("track_name", ""),
            session_type=session.get("session_type", ""),
            num_drivers=len(session.get("drivers", [])) if isinstance(session.get("drivers"), list) else 0,
        )
        if session.get("subsession_id") is not None:
            project_service.save_project_metadata(project["id"], {"subsession_id": session.get("subsession_id")})

    project_id = int(project["id"])
    if req.preset_id or req.config:
        pipeline_service.save_project_control_state(project_id, {
            "preset_id": req.preset_id or "",
            "overrides": req.config or {},
            "controls": {"pipeline": {"preset_id": req.preset_id or "", "overrides": req.config or {}}},
        })

    preflight = pipeline_service.preflight_check(project_id=project_id, preset_id=req.preset_id, config=req.config)
    response: dict[str, Any] = {
        "project": project_service.get_project(project_id),
        "auto_name_source": auto_name_source,
        "preflight": {
            "ok": not any(i.get("level") == "error" for i in preflight),
            "issues": preflight,
        },
        "run": None,
    }

    if req.auto_start:
        run = pipeline_service.start(project_id=project_id, preset_id=req.preset_id, config=req.config)
        response["run"] = run
        response["message"] = "Auto pipeline started"
    return response


@router.get("/projects/{project_id}/summary")
async def get_agent_project_summary(
    project_id: int,
    include_files: bool = Query(True),
    include_validation: bool = Query(True),
    log_limit: int = Query(100, ge=1, le=2000),
) -> dict[str, Any]:
    project = _project_or_404(project_id)
    files_result = project_service.get_project_files(project_id) if include_files else None
    status = pipeline_service.status
    current_run = status.get("current_run") if isinstance(status, dict) else None
    run_id = current_run.get("run_id") if isinstance(current_run, dict) else None
    return {
        "project": project,
        "auto_pipeline": status,
        "control_state": pipeline_service.get_project_control_state(project_id),
        "logs": _run_logs(run_id, limit=log_limit),
        "files": files_result,
        "validation": _validate_project(project_id) if include_validation else None,
    }


@router.post("/projects/{project_id}/highlights/generate-script")
async def generate_agent_highlight_script(project_id: int, req: HighlightScriptRequest) -> dict[str, Any]:
    """Generate a target-aware script through the canonical analysis route."""
    from server.routes.api_analysis import VideoScriptRequest, generate_video_script_endpoint

    preference = max(0, min(100, int(req.continuity_preference)))
    return await generate_video_script_endpoint(project_id, VideoScriptRequest(
        weights=req.weights,
        constraints={
            "target_duration": max(0.0, float(req.target_duration)),
            "min_severity": max(0, min(10, int(req.min_severity))),
            "continuity_preference": preference,
            "continuity_block_duration": max(0, int(req.continuity_block_duration)),
            "continuity_block_count": max(0, int(req.continuity_block_count)),
            "continuity_gap_reach": max(0, int(req.continuity_gap_reach)),
            "continuity_event_diversity": max(
                0, min(100, int(req.continuity_event_diversity))
            ),
        },
        overrides=req.overrides,
        section_config=req.section_config,
        clip_padding=max(0.0, float(req.clip_padding)),
        clip_padding_after=max(0.0, float(req.clip_padding_after)),
        padding_by_type=req.padding_by_type,
        tuning={**req.tuning, "continuityPreference": preference},
        camera_weights=req.camera_weights,
        camera_recency_penalty=max(0.0, min(1.0, float(req.camera_recency_penalty))),
        camera_recency_decay=max(0.0, float(req.camera_recency_decay)),
        persist=not req.dry_run,
    ))


@router.post("/projects/{project_id}/capture/validate-clips")
async def validate_agent_capture_clips(project_id: int, req: CaptureClipValidationRequest) -> dict[str, Any]:
    """Validate captured clips, optionally deleting/resetting confirmed corrupt events."""
    from server.routes.api_capture import (
        PersistedClipValidationRequest,
        recover_corrupt_persisted_script_capture,
        validate_persisted_script_capture,
    )

    _project_or_404(project_id)
    request = PersistedClipValidationRequest(project_id=project_id)
    if req.recover_corrupt:
        return await recover_corrupt_persisted_script_capture(request)
    return await validate_persisted_script_capture(request)


@router.get("/projects/{project_id}/capture/validate-clips/status")
async def get_agent_capture_clip_validation_status(project_id: int) -> dict[str, Any]:
    """Return progress and the final report for a manual capture validation job."""
    from server.routes.api_capture import get_persisted_clip_validation_status

    _project_or_404(project_id)
    return await get_persisted_clip_validation_status(project_id)


@router.post("/projects/{project_id}/steps/{step}/control")
async def control_agent_step(project_id: int, step: str, req: StepControlRequest) -> dict[str, Any]:
    _project_or_404(project_id)
    action = req.action.strip().lower()
    step = step.strip().lower()

    if step == "pipeline":
        if action == "start":
            return {"run": pipeline_service.start(project_id=project_id, preset_id=req.preset_id, config=req.config)}
        if action == "pause":
            return {"run": pipeline_service.pause()}
        if action == "resume":
            return {"run": pipeline_service.resume()}
        if action in {"stop", "cancel"}:
            return {"run": pipeline_service.cancel()}
        if action == "restart":
            pipeline_service.reset(project_id=project_id)
            return {"run": pipeline_service.start(project_id=project_id, preset_id=req.preset_id, config=req.config)}
        if action == "reset":
            return {"result": pipeline_service.reset(project_id=project_id)}
        if action == "status":
            return pipeline_service.status
        if action == "logs":
            return _run_logs(req.run_id, limit=req.limit, level=req.level)
        if action == "validate":
            return _validate_project(project_id, scope="auto")
        if action == "configure":
            return pipeline_service.save_project_control_state(project_id, {
                "preset_id": req.preset_id or "",
                "overrides": req.config or {},
                "controls": {"pipeline": {"preset_id": req.preset_id or "", "overrides": req.config or {}}},
            })

    if action == "status":
        return {"step": step, "pipeline": pipeline_service.status}
    if action == "logs":
        return _run_logs(req.run_id, limit=req.limit, step=None if step in {"overlay", "editing"} else step, level=req.level)
    if action == "validate":
        return _validate_project(project_id, scope=step)
    if action == "configure":
        state = pipeline_service.get_project_control_state(project_id)
        controls = state.get("controls") or {}
        controls.setdefault(step, {}).update(req.config or {})
        return pipeline_service.save_project_control_state(project_id, {
            "preset_id": req.preset_id if req.preset_id is not None else state.get("preset_id", ""),
            "overrides": state.get("overrides") or {},
            "controls": controls,
        })

    if step == "capture" and action == "start":
        # Script capture is the real per-segment capture engine.  The generic
        # workflow facade used to report that individual capture start was not
        # available, even though this engine already exists behind
        # /api/capture/script-capture.  Delegate to it rather than maintaining
        # a parallel capture implementation.
        from server.routes.api_capture import ScriptCaptureRequest, start_script_capture

        project = _project_or_404(project_id)
        script = project.get("script") or []
        if not script:
            raise HTTPException(
                status_code=400,
                detail="No composition script is stored on this project; run Editing before Capture.",
            )

        config = req.config or {}
        capture_mode = str(config.get("capture_mode") or "uncaptured_only")
        if capture_mode not in {"all", "uncaptured_only", "specific_segments", "time_range"}:
            raise HTTPException(
                status_code=400,
                detail="capture_mode must be all, uncaptured_only, specific_segments, or time_range",
            )
        if capture_mode == "specific_segments" and not config.get("segment_ids"):
            raise HTTPException(
                status_code=400,
                detail="segment_ids is required when capture_mode=specific_segments",
            )
        if capture_mode == "time_range" and not config.get("time_range"):
            raise HTTPException(
                status_code=400,
                detail="time_range is required when capture_mode=time_range",
            )

        result = await start_script_capture(
            ScriptCaptureRequest(
                project_id=project_id,
                script=script,
                clip_padding=float(config.get("clip_padding", 2.0)),
                clip_padding_after=float(config.get("clip_padding_after", 1.0)),
                output_filename=str(config.get("output_filename") or "highlight_compiled.mp4"),
                contiguous_gap_threshold=float(config.get("contiguous_gap_threshold", 1.0)),
                capture_mode=capture_mode,
                segment_ids=config.get("segment_ids"),
                time_range=config.get("time_range"),
                capture_resolution=str(config.get("capture_resolution") or "1080p"),
                validate_clips=bool(config.get("validate_clips", True)),
                retry_failed_clip_validation=bool(config.get("retry_failed_clip_validation", False)),
                clip_validation_retry_limit=int(config.get("clip_validation_retry_limit", 1) or 0),
            )
        )
        return {
            "success": True,
            "step": "capture",
            "action": "start",
            "engine": "script_capture",
            "result": result,
        }

    return {
        "success": False,
        "step": step,
        "action": action,
        "message": "Manual start/stop/restart for individual steps is not a separate engine in v1; use Auto pipeline controls or existing step-specific APIs.",
        "recommended_action": "start_auto_pipeline" if action in {"start", "restart"} else "get_workflow_status",
    }


@router.get("/projects/{project_id}/files")
async def list_agent_project_files(project_id: int) -> dict[str, Any]:
    result = project_service.get_project_files(project_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Project not found")
    result["files"] = _flatten_project_files(result)
    return result


@router.get("/projects/{project_id}/files/read")
async def read_agent_project_file(project_id: int, path: str = Query(...)) -> dict[str, Any]:
    result = project_service.get_file_content(project_id, path)
    if result is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return {"project_id": project_id, "path": path, **result}


@router.get("/projects/{project_id}/validate")
async def validate_agent_project(project_id: int, scope: str = Query("all")) -> dict[str, Any]:
    return _validate_project(project_id, scope=scope)


@router.post("/youtube/upload/start")
async def start_agent_youtube_upload(req: UploadStartRequest) -> dict[str, Any]:
    privacy = req.privacy.strip().lower() or "unlisted"
    if privacy == "public" and not req.confirm_public:
        raise HTTPException(status_code=403, detail=PUBLIC_UPLOAD_CONFIRM_MESSAGE)
    result = await youtube_service.start_upload(
        file_path=req.file_path,
        title=req.title,
        description=req.description,
        tags=req.tags,
        privacy=privacy,
        project_id=req.project_id,
        playlist_id=req.playlist_id,
    )
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Upload failed"))
    return result


@router.get("/youtube/status")
async def get_agent_youtube_status() -> dict[str, Any]:
    return await _youtube_status_bundle()
