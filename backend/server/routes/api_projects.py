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

from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel, Field

from server.services.project_service import project_service

router = APIRouter(prefix="/api", tags=["projects"])


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


class StepUpdate(BaseModel):
    step: Optional[str] = Field(None, description="Target step (setup/analysis/editing/capture/export/upload)")
    action: Optional[str] = Field(None, description="Action: 'advance' to move to next step")


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
    project_id: int,
    path: str = Query(..., description="Relative path within the project directory"),
):
    """Serve a project file directly (for images, video, etc.)."""
    result = project_service.resolve_file_path(project_id, path)
    if result is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return FileResponse(result["absolute_path"], filename=result["filename"])


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
