# API Conventions Guide

## Overview

Standards for all REST API endpoints in League Replay Studio. All endpoints are defined in `documentation/master-plan.md` Section 6.

## Field Naming: snake_case Everywhere

All API responses use **snake_case** for field names, matching Python convention and database schema.

```python
# ✅ CORRECT
{
    "project_id": 1,
    "track_name": "Daytona International Speedway",
    "created_at": "2026-03-31T14:30:00Z",
    "current_step": "editing",
    "pipeline_config_id": 3
}

# ❌ WRONG — camelCase
{
    "projectId": 1,
    "trackName": "Daytona International Speedway",
    "createdAt": "2026-03-31T14:30:00Z"
}
```

### External API Field Conversion

When returning data from external APIs (iRacing, YouTube), convert to snake_case:

```python
# YouTube API returns camelCase — convert in Pydantic schema
# ❌ "videoId" → ✅ "video_id"
# ❌ "publishedAt" → ✅ "published_at"
# ❌ "channelTitle" → ✅ "channel_title"
```

## Pydantic Schemas

All request/response bodies use Pydantic models:

```python
from pydantic import BaseModel
from typing import Optional

class ProjectCreate(BaseModel):
    name: str
    replay_path: Optional[str] = None
    track_name: Optional[str] = None
    pipeline_config_id: Optional[int] = None

class ProjectResponse(BaseModel):
    id: int
    name: str
    track_name: Optional[str]
    current_step: str
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True
```

## Route Handler Pattern

```python
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/projects", tags=["projects"])

@router.get("/")
async def list_projects() -> list[ProjectResponse]:
    """List all projects."""
    ...

@router.post("/", status_code=201)
async def create_project(data: ProjectCreate) -> ProjectResponse:
    """Create a new project."""
    ...

@router.get("/{project_id}")
async def get_project(project_id: int) -> ProjectResponse:
    """Get project details."""
    ...
```

## Error Responses

Use FastAPI's `HTTPException` with consistent error format:

```python
raise HTTPException(
    status_code=404,
    detail={"error": "project_not_found", "message": "Project 42 does not exist"}
)
```

## WebSocket Messages

All WebSocket messages use snake_case event names with colon-separated namespaces:

```python
# ✅ Correct
await ws.send_json({"event": "pipeline:step_completed", "data": {...}})
await ws.send_json({"event": "encoding:progress", "data": {"percent": 78, "fps": 437}})

# ❌ Wrong
await ws.send_json({"event": "pipelineStepCompleted", "data": {...}})
```

## Best Practices

- All route handlers are `async def`
- Type hints on all parameters and return values
- Docstrings on all endpoints
- Group related endpoints in separate router files (`api_projects.py`, `api_youtube.py`, etc.)
- Use FastAPI dependency injection for database connections and services
- Validate path parameters with Pydantic constraints where appropriate
