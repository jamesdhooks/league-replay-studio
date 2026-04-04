"""
api_youtube.py
---------------
REST endpoints for YouTube channel integration.

GET    /api/youtube/status           — connection status
POST   /api/youtube/auth/url         — get OAuth2 authorization URL
POST   /api/youtube/auth/callback    — handle OAuth2 callback (code exchange)
POST   /api/youtube/disconnect       — disconnect YouTube channel
POST   /api/youtube/refresh          — refresh connection / re-validate tokens
GET    /api/youtube/upload/defaults  — get default upload settings
PUT    /api/youtube/upload/defaults  — update default upload settings
POST   /api/youtube/upload/preview   — preview rendered metadata from templates
POST   /api/youtube/upload/start     — start video upload
POST   /api/youtube/upload/cancel/{job_id} — cancel active upload
GET    /api/youtube/upload/status    — get upload status and history
GET    /api/youtube/videos           — list uploaded videos
GET    /api/youtube/quota            — get quota usage
"""

import logging

from fastapi import APIRouter, HTTPException, Query
from typing import Any, Dict, Optional

from server.services.youtube_service import youtube_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/youtube", tags=["youtube"])


# ── Connection ──────────────────────────────────────────────────────────────

@router.get("/status")
async def get_status() -> dict:
    """Get YouTube connection status."""
    return await youtube_service.get_connection_status()


@router.post("/auth/url")
async def get_auth_url(body: Dict[str, Any]) -> dict:
    """Get the OAuth2 authorization URL.

    Body: { "client_id": "...", "redirect_uri": "..." }
    """
    client_id = body.get("client_id", "")
    redirect_uri = body.get("redirect_uri", "http://localhost:8175/api/youtube/auth/callback")
    if not client_id:
        raise HTTPException(status_code=422, detail="client_id is required")
    url = youtube_service.get_auth_url(client_id, redirect_uri)
    return {"auth_url": url}


@router.post("/auth/callback")
async def auth_callback(body: Dict[str, Any]) -> dict:
    """Handle the OAuth2 callback — exchange authorization code for tokens.

    Body: { "client_id": "...", "client_secret": "...", "code": "...", "redirect_uri": "..." }
    """
    client_id = body.get("client_id", "")
    client_secret = body.get("client_secret", "")
    code = body.get("code", "")
    redirect_uri = body.get("redirect_uri", "http://localhost:8175/api/youtube/auth/callback")

    if not all([client_id, client_secret, code]):
        raise HTTPException(
            status_code=422,
            detail="client_id, client_secret, and code are required"
        )

    result = await youtube_service.handle_auth_callback(
        client_id, client_secret, code, redirect_uri
    )
    if not result.get("success"):
        raise HTTPException(status_code=400, detail="YouTube authentication failed")
    return result


@router.post("/disconnect")
async def disconnect() -> dict:
    """Disconnect the YouTube channel."""
    return await youtube_service.disconnect()


@router.post("/refresh")
async def refresh_connection() -> dict:
    """Refresh the YouTube connection (re-validate tokens)."""
    result = await youtube_service.refresh_connection()
    if not result.get("success") and "error" in result:
        logger.warning("[YouTube] Refresh failed: %s", result["error"])
    return {k: v for k, v in result.items() if k != "error"} if not result.get("success") else result


# ── Upload settings ─────────────────────────────────────────────────────────

@router.get("/upload/defaults")
async def get_upload_defaults() -> dict:
    """Get default upload settings (privacy, templates, tags)."""
    return youtube_service.get_upload_defaults()


@router.put("/upload/defaults")
async def update_upload_defaults(updates: Dict[str, Any]) -> dict:
    """Update default upload settings."""
    return youtube_service.update_upload_defaults(updates)


@router.post("/upload/preview")
async def preview_metadata(body: Dict[str, Any]) -> dict:
    """Preview rendered metadata from Jinja2 templates.

    Body: { "title_template": "...", "description_template": "...", "project_data": { ... } }
    """
    title_template = body.get("title_template", "")
    description_template = body.get("description_template", "")
    project_data = body.get("project_data", {})

    result = youtube_service.render_metadata(title_template, description_template, project_data)
    return result


# ── Upload ──────────────────────────────────────────────────────────────────

@router.post("/upload/start")
async def start_upload(body: Dict[str, Any]) -> dict:
    """Start uploading a video to YouTube.

    Body: {
        "file_path": "...",
        "title": "...",
        "description": "...",
        "tags": ["...", ...],
        "privacy": "unlisted",
        "project_id": 1,
        "playlist_id": "..."
    }
    """
    file_path = body.get("file_path", "")
    title = body.get("title", "")

    if not file_path or not title:
        raise HTTPException(status_code=422, detail="file_path and title are required")

    result = await youtube_service.start_upload(
        file_path=file_path,
        title=title,
        description=body.get("description", ""),
        tags=body.get("tags"),
        privacy=body.get("privacy", "unlisted"),
        project_id=body.get("project_id"),
        playlist_id=body.get("playlist_id"),
    )

    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Upload failed"))
    return result


@router.post("/upload/cancel/{job_id}")
async def cancel_upload(job_id: str) -> dict:
    """Cancel an active upload."""
    result = youtube_service.cancel_upload(job_id)
    if not result.get("success"):
        raise HTTPException(status_code=404, detail=result.get("error", "Upload not found"))
    return result


@router.get("/upload/status")
async def get_upload_status() -> dict:
    """Get current upload status and recent history."""
    return youtube_service.get_upload_status()


# ── Videos ──────────────────────────────────────────────────────────────────

@router.get("/videos")
async def get_videos(
    max_results: int = Query(default=20, ge=1, le=50),
    page_token: Optional[str] = Query(default=None),
) -> dict:
    """List uploaded videos from the connected YouTube channel."""
    result = await youtube_service.list_uploaded_videos(max_results, page_token)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail="Failed to list videos")
    return result


# ── Quota ───────────────────────────────────────────────────────────────────

@router.get("/quota")
async def get_quota() -> dict:
    """Get current YouTube API quota usage."""
    return youtube_service.get_quota_usage()
