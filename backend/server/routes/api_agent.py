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
from pydantic import BaseModel

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
