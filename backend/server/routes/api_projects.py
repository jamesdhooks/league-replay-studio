"""
api_projects.py
----------------
REST endpoints for project management.

GET    /api/projects                          — list all projects (with optional search/filter)
POST   /api/projects                          — create a new project
GET    /api/projects/{id}                     — get project details
PUT    /api/projects/{id}                     — update project
DELETE /api/projects/{id}                     — delete project
POST   /api/projects/{id}/duplicate           — duplicate project
GET    /api/projects/{id}/step                — get step status
PUT    /api/projects/{id}/step                — set/advance project step
GET    /api/projects/{id}/files               — project file browser
GET    /api/projects/{id}/files/content       — read file content as text
GET    /api/projects/{id}/files/serve         — serve file directly (images/video)
GET    /api/replays/discover                  — auto-discover .rpy files
"""

from __future__ import annotations

import os
from datetime import datetime
from mimetypes import guess_type
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field

from server.services.project_service import project_service

router = APIRouter(prefix="/api", tags=["projects"])

VIDEO_EXTENSIONS = {".mp4", ".avi", ".mkv", ".webm", ".mov", ".m4v"}


def _iter_file_range(file_path: str, start: int, end: int, chunk_size: int = 1024 * 1024):
    """Yield a byte range from file_path (inclusive start/end offsets)."""
    with open(file_path, "rb") as fh:
        fh.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            read_size = min(chunk_size, remaining)
            data = fh.read(read_size)
            if not data:
                break
            remaining -= len(data)
            yield data


def _parse_range_header(range_header: str, file_size: int) -> tuple[int, int] | None:
    """Parse a simple bytes range header and return inclusive start/end."""
    if not range_header or not range_header.startswith("bytes="):
        return None

    range_spec = range_header.split("=", 1)[1].strip()
    if "," in range_spec:
        # Multiple ranges are not supported.
        return None

    start_str, sep, end_str = range_spec.partition("-")
    if not sep:
        return None

    if start_str == "":
        # Suffix byte range: bytes=-500
        suffix_len = int(end_str)
        if suffix_len <= 0:
            return None
        start = max(file_size - suffix_len, 0)
        end = file_size - 1
        return (start, end)

    start = int(start_str)
    end = int(end_str) if end_str else file_size - 1
    if start < 0 or end < start or start >= file_size:
        return None
    end = min(end, file_size - 1)
    return (start, end)


# ── Request / Response Models ─────────────────────────────────────────────────

class ProjectCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200, description="Project name")
    replay_file: str = Field("", description="Path to .rpy replay file")
    project_dir: str = Field("", description="Custom project directory (auto-generated if empty)")
    track_name: str = Field("", description="Track name")
    session_type: str = Field("", description="Session type (race, qualifying, practice)")
    num_drivers: int = Field(0, ge=0, description="Number of drivers")
    num_laps: int = Field(0, ge=0, description="Number of laps")


class ProjectUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    track_name: Optional[str] = None
    session_type: Optional[str] = None
    num_drivers: Optional[int] = Field(None, ge=0)
    num_laps: Optional[int] = Field(None, ge=0)
    replay_file: Optional[str] = None
    current_step: Optional[str] = None
    script: Optional[list[dict[str, Any]]] = None
    script_sections: Optional[dict[str, Any]] = None
    script_generated_at: Optional[str] = None
    clips_manifest: Optional[list[dict[str, Any]]] = None
    capture_manifest: Optional[list[dict[str, Any]]] = None
    subsession_id: Optional[int] = Field(None, ge=0, description="iRacing subsession ID for this project")


class StepUpdate(BaseModel):
    step: Optional[str] = Field(None, description="Target step (pipeline/analysis/editing/overlay/capture/compose/export/upload)")
    action: Optional[str] = Field(None, description="Action: 'advance' to move to next step")


class FileDeleteRequest(BaseModel):
    paths: list[str] = Field(default_factory=list, description="Project-relative file paths to delete")


class FromActiveSessionRequest(BaseModel):
    name: str = Field("", max_length=200, description="Optional project name; auto-generated when omitted")
    replay_file: str = Field("", description="Optional explicit replay file path")


def _first_non_empty(*values: Any) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _first_positive_int(*values: Any) -> int | None:
    for value in values:
        try:
            number = int(value)
        except (TypeError, ValueError):
            continue
        if number > 0:
            return number
    return None


def build_auto_project_name(active_session: dict[str, Any] | None, race_details: dict[str, Any] | None = None) -> tuple[str, str]:
    """Build the same style of auto project name used by the New Project UI."""
    active_session = active_session or {}
    race_details = race_details or {}
    series = _first_non_empty(
        race_details.get("series"),
        active_session.get("series"),
        active_session.get("series_name"),
        active_session.get("session_type"),
    )
    race_num = _first_positive_int(
        race_details.get("race_number"),
        race_details.get("race_num"),
        active_session.get("race_number"),
        active_session.get("race_num"),
        race_details.get("week_number"),
        active_session.get("week_number"),
        active_session.get("race_week"),
    )
    track = _first_non_empty(
        race_details.get("track_name"),
        active_session.get("track_name"),
    )

    if series and race_num and track:
        return f"{series} Week {race_num} - {track}", "race_details_series_week_track"
    if series and track:
        return f"{series} - {track}", "series_track"
    if track:
        return track, "track"
    return f"iRacing Replay {datetime.now().strftime('%Y-%m-%d %H%M')}", "fallback_timestamp"


# ── Project CRUD ──────────────────────────────────────────────────────────────

@router.get("/projects")
async def list_projects(
    search: str = Query("", description="Search by name or track"),
    track: str = Query("", description="Filter by track name"),
    step: str = Query("", description="Filter by workflow step"),
    sort_by: str = Query("updated_at", description="Sort field"),
    sort_dir: str = Query("desc", description="Sort direction (asc/desc)"),
) -> list[dict]:
    """List all projects with optional filtering and sorting."""
    return project_service.list_projects(
        search=search, track=track, step=step,
        sort_by=sort_by, sort_dir=sort_dir,
    )


@router.post("/projects", status_code=201)
async def create_project(data: ProjectCreate) -> dict:
    """Create a new project with directory structure."""
    try:
        project = project_service.create_project(
            name=data.name,
            replay_file=data.replay_file,
            project_dir=data.project_dir,
            track_name=data.track_name,
            session_type=data.session_type,
            num_drivers=data.num_drivers,
            num_laps=data.num_laps,
        )
        return project
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/projects/from-active-session", status_code=201)
async def create_project_from_active_session(data: FromActiveSessionRequest) -> dict:
    """Create a new project auto-filled from the active iRacing session."""
    from server.services.iracing_bridge import bridge

    track_name = ""
    session_type = ""
    num_drivers = 0
    active_session: dict[str, Any] = {}

    if bridge.is_connected and bridge.session_data:
        sd = bridge.session_data
        active_session = dict(sd)
        track_name = sd.get("track_name", "")
        session_type = sd.get("session_type", "")
        drivers = sd.get("drivers", [])
        num_drivers = len(drivers) if isinstance(drivers, list) else 0

    project_name = data.name.strip()
    auto_name_source = "provided"
    if not project_name:
        project_name, auto_name_source = build_auto_project_name(active_session)

    try:
        project = project_service.create_project(
            name=project_name,
            replay_file=data.replay_file,
            track_name=track_name,
            session_type=session_type,
            num_drivers=num_drivers,
        )
        project["auto_name_source"] = auto_name_source
        if active_session.get("subsession_id") is not None:
            project["subsession_id"] = active_session.get("subsession_id")
            project_service.save_project_metadata(project["id"], {"subsession_id": active_session.get("subsession_id")})
        return project
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.get("/projects/{project_id}")
async def get_project(project_id: int) -> dict:
    """Get project details by ID."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.put("/projects/{project_id}")
async def update_project(project_id: int, data: ProjectUpdate) -> dict:
    """Update project fields."""
    updates = data.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=422, detail="No fields to update")

    try:
        project = project_service.update_project(project_id, updates)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.delete("/projects/{project_id}")
async def delete_project(
    project_id: int,
    delete_files: bool = Query(False, description="Also delete project files from disk"),
) -> dict:
    """Delete a project from the registry."""
    success = project_service.delete_project(project_id, delete_files=delete_files)
    if not success:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"status": "deleted", "id": project_id}


# ── Duplicate ─────────────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/duplicate", status_code=201)
async def duplicate_project(project_id: int) -> dict:
    """Duplicate an existing project."""
    project = project_service.duplicate_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


# ── Step Navigation ───────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/step")
async def get_step_status(project_id: int) -> dict:
    """Get the current step and progression status."""
    status = project_service.get_step_status(project_id)
    if not status:
        raise HTTPException(status_code=404, detail="Project not found")
    return status


@router.put("/projects/{project_id}/step")
async def update_step(project_id: int, data: StepUpdate) -> dict:
    """Set or advance the project step."""
    try:
        if data.action == "advance":
            project = project_service.advance_step(project_id)
        elif data.step:
            project = project_service.set_step(project_id, data.step)
        else:
            raise HTTPException(
                status_code=422,
                detail="Provide 'step' or 'action: advance'",
            )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


# ── File Browser ──────────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/files")
async def get_project_files(project_id: int) -> dict:
    """List project directory contents organized by category."""
    result = project_service.get_project_files(project_id)
    if not result:
        raise HTTPException(status_code=404, detail="Project not found")
    return result


@router.post("/projects/{project_id}/files/delete")
async def delete_project_files(project_id: int, body: FileDeleteRequest) -> dict:
    """Delete selected files inside a project directory."""
    if not body.paths:
        raise HTTPException(status_code=422, detail="No files selected")

    result = project_service.delete_project_files(project_id, body.paths)
    if result is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return result


@router.post("/projects/{project_id}/open-directory")
async def open_project_directory(project_id: int, body: Optional[dict[str, str]] = None) -> dict:
    """Open the project directory in the OS file explorer."""
    result = project_service.open_project_directory(project_id, (body or {}).get("path", ""))
    if result is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


# ── File Content & Serving ────────────────────────────────────────────────────

@router.get("/projects/{project_id}/files/content")
async def get_file_content(
    project_id: int,
    path: str = Query(..., description="Relative path within the project directory"),
) -> PlainTextResponse:
    """Read a project file and return its content as plain text."""
    result = project_service.get_file_content(project_id, path)
    if result is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return PlainTextResponse(result["content"])


@router.get("/projects/{project_id}/files/serve")
async def serve_file(
    request: Request,
    project_id: int,
    path: str = Query(..., description="Relative path within the project directory"),
):
    """Serve a project file directly (for images, video, etc.)."""
    result = project_service.resolve_file_path(project_id, path)
    if result is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    absolute_path = result["absolute_path"]
    ext = os.path.splitext(result["filename"])[1].lower()

    # Explicit byte-range streaming for video files enables reliable seek/scrub
    # behavior in embedded HTML5 players across browsers and webviews.
    if ext in VIDEO_EXTENSIONS:
        media_type = guess_type(result["filename"])[0] or "video/mp4"
        file_size = os.path.getsize(absolute_path)
        range_header = request.headers.get("range")
        parsed = _parse_range_header(range_header, file_size) if range_header else None

        if range_header and parsed is None:
            raise HTTPException(status_code=416, detail="Invalid Range header")

        if parsed is not None:
            start, end = parsed
            content_length = end - start + 1
            headers = {
                "Accept-Ranges": "bytes",
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(content_length),
            }
            return StreamingResponse(
                _iter_file_range(absolute_path, start, end),
                status_code=206,
                media_type=media_type,
                headers=headers,
            )

        return FileResponse(
            absolute_path,
            media_type=media_type,
            headers={"Accept-Ranges": "bytes"},
        )

    return FileResponse(absolute_path)


# ── Replay Discovery ─────────────────────────────────────────────────────────

@router.get("/replays/discover")
async def discover_replays(
    directory: str = Query("", description="Directory to scan (default: iRacing replays dir)"),
) -> list[dict]:
    """Auto-discover .rpy replay files."""
    return project_service.discover_replay_files(directory=directory)


@router.get("/replays/suggest")
async def suggest_replay(
    name: str = Query(..., description="Project name to fuzzy-match against replay filenames"),
    directory: str = Query("", description="Directory to scan (default: iRacing replays dir)"),
) -> dict:
    """Suggest the best replay file for a project name via fuzzy matching."""
    from server.services.project_service import fuzzy_match_replay
    files = project_service.discover_replay_files(directory=directory)
    match = fuzzy_match_replay(name, files)
    return {"suggestion": match}
