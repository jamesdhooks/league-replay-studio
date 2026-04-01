"""
youtube_service.py
-------------------
YouTube channel integration service.

Manages the YouTube lifecycle:
  disconnected → connecting → connected → uploading → completed | error

Supports:
- OAuth2 flow with token storage
- Connection status with auto-refresh
- Resumable video uploads with real-time progress
- Jinja2-based metadata templates for auto-filling title/description
- Video listing with statistics
- Quota monitoring with daily usage tracking
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from jinja2 import BaseLoader, Environment

from server.config import DATA_DIR, load_config, save_config
from server.events import EventType, make_event
from server.utils.youtube_client import (
    QUOTA_UPLOAD_COST,
    QUOTA_LIST_COST,
    QuotaTracker,
    build_auth_url,
    clear_tokens,
    exchange_code,
    get_channel_info,
    is_token_expired,
    list_videos,
    load_tokens,
    refresh_access_token,
    save_tokens,
    upload_video,
)

logger = logging.getLogger(__name__)


# ── Connection states ───────────────────────────────────────────────────────

class YouTubeState:
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    EXPIRED = "expired"
    ERROR = "error"


# ── Upload states ───────────────────────────────────────────────────────────

class UploadState:
    IDLE = "idle"
    PREPARING = "preparing"
    UPLOADING = "uploading"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    ERROR = "error"


# ── Upload Job ──────────────────────────────────────────────────────────────

class UploadJob:
    """Represents a single video upload to YouTube."""

    def __init__(
        self,
        job_id: str,
        project_id: Optional[int],
        file_path: str,
        title: str,
        description: str = "",
        tags: Optional[list[str]] = None,
        privacy: str = "unlisted",
        playlist_id: Optional[str] = None,
    ) -> None:
        self.job_id = job_id
        self.project_id = project_id
        self.file_path = file_path
        self.title = title
        self.description = description
        self.tags = tags or []
        self.privacy = privacy
        self.playlist_id = playlist_id
        self.state = UploadState.IDLE
        self.progress = 0.0
        self.bytes_sent = 0
        self.total_bytes = 0
        self.speed_mbps = 0.0
        self.eta_seconds = 0
        self.video_id: Optional[str] = None
        self.video_url: Optional[str] = None
        self.error: Optional[str] = None
        self.started_at: Optional[float] = None
        self.completed_at: Optional[float] = None
        self.cancelled = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "project_id": self.project_id,
            "file_path": self.file_path,
            "title": self.title,
            "description": self.description,
            "tags": self.tags,
            "privacy": self.privacy,
            "state": self.state,
            "progress": round(self.progress, 1),
            "bytes_sent": self.bytes_sent,
            "total_bytes": self.total_bytes,
            "speed_mbps": round(self.speed_mbps, 2),
            "eta_seconds": self.eta_seconds,
            "video_id": self.video_id,
            "video_url": self.video_url,
            "error": self.error,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
        }


# ── Jinja2 template rendering ──────────────────────────────────────────────

_jinja_env = Environment(loader=BaseLoader(), autoescape=True)


def render_template_string(template_str: str, context: dict[str, Any]) -> str:
    """Render a Jinja2 template string with the given context."""
    try:
        template = _jinja_env.from_string(template_str)
        return template.render(**context)
    except Exception as exc:
        logger.warning("[YouTube] Template rendering failed: %s", exc)
        return template_str


# ── YouTube Service ─────────────────────────────────────────────────────────

class YouTubeService:
    """Singleton service managing YouTube channel integration."""

    def __init__(self) -> None:
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._broadcast_fn: Optional[Callable] = None
        self._state = YouTubeState.DISCONNECTED
        self._channel_info: Optional[dict[str, Any]] = None
        self._tokens: Optional[dict[str, Any]] = None
        self._quota = QuotaTracker(DATA_DIR)
        self._active_upload: Optional[UploadJob] = None
        self._upload_history: list[dict[str, Any]] = []
        self._lock = threading.Lock()

        # Load existing tokens on init
        self._tokens = load_tokens(DATA_DIR)
        if self._tokens:
            if is_token_expired(self._tokens):
                self._state = YouTubeState.EXPIRED
            else:
                self._state = YouTubeState.CONNECTED

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def set_broadcast_fn(self, fn: Callable) -> None:
        self._broadcast_fn = fn

    def _broadcast(self, message: dict) -> None:
        if self._broadcast_fn and self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(self._broadcast_fn(message), self._loop)

    # ── OAuth2 flow ─────────────────────────────────────────────────────────

    def get_auth_url(self, client_id: str, redirect_uri: str) -> str:
        """Generate the OAuth2 authorization URL."""
        state = uuid.uuid4().hex
        return build_auth_url(client_id, redirect_uri, state)

    async def handle_auth_callback(
        self,
        client_id: str,
        client_secret: str,
        code: str,
        redirect_uri: str,
    ) -> dict[str, Any]:
        """Handle the OAuth2 callback — exchange code for tokens."""
        self._state = YouTubeState.CONNECTING
        try:
            tokens = await exchange_code(client_id, client_secret, code, redirect_uri)
            self._tokens = tokens
            save_tokens(DATA_DIR, tokens)

            # Fetch channel info
            channel = await get_channel_info(tokens["access_token"])
            self._channel_info = channel
            self._state = YouTubeState.CONNECTED

            self._broadcast(make_event(EventType.YOUTUBE_CONNECTED, {
                "channel": channel,
            }))

            logger.info("[YouTube] Connected: %s", channel.get("title"))
            return {"success": True, "channel": channel}

        except Exception as exc:
            self._state = YouTubeState.ERROR
            logger.error("[YouTube] Auth callback failed: %s", exc)
            return {"success": False, "error": str(exc)}

    async def _ensure_valid_token(self) -> Optional[str]:
        """Ensure we have a valid access token, refreshing if needed."""
        if not self._tokens:
            return None

        config = load_config()
        client_id = config.get("youtube_client_id", "")
        client_secret = config.get("youtube_client_secret", "")

        if is_token_expired(self._tokens):
            if not client_id or not client_secret:
                self._state = YouTubeState.EXPIRED
                return None
            try:
                self._tokens = await refresh_access_token(
                    client_id, client_secret, self._tokens["refresh_token"]
                )
                save_tokens(DATA_DIR, self._tokens)
                self._state = YouTubeState.CONNECTED
            except Exception as exc:
                logger.error("[YouTube] Token refresh failed: %s", exc)
                self._state = YouTubeState.EXPIRED
                return None

        return self._tokens.get("access_token")

    # ── Connection status ───────────────────────────────────────────────────

    async def get_connection_status(self) -> dict[str, Any]:
        """Get the current YouTube connection status."""
        if not self._tokens:
            return {
                "state": YouTubeState.DISCONNECTED,
                "channel": None,
            }

        token = await self._ensure_valid_token()
        if not token:
            return {
                "state": self._state,
                "channel": self._channel_info,
            }

        # Refresh channel info if we don't have it
        if not self._channel_info:
            try:
                self._channel_info = await get_channel_info(token)
                self._quota.record_operation("channels.list", QUOTA_LIST_COST)
            except Exception as exc:
                logger.error("[YouTube] Failed to fetch channel info: %s", exc)

        return {
            "state": self._state,
            "channel": self._channel_info,
        }

    async def disconnect(self) -> dict[str, Any]:
        """Disconnect the YouTube channel."""
        clear_tokens(DATA_DIR)
        self._tokens = None
        self._channel_info = None
        self._state = YouTubeState.DISCONNECTED

        self._broadcast(make_event(EventType.YOUTUBE_DISCONNECTED, {}))

        logger.info("[YouTube] Disconnected")
        return {"success": True}

    async def refresh_connection(self) -> dict[str, Any]:
        """Refresh the YouTube connection (re-validate tokens)."""
        token = await self._ensure_valid_token()
        if not token:
            return {"success": False, "state": self._state}

        try:
            self._channel_info = await get_channel_info(token)
            self._quota.record_operation("channels.list", QUOTA_LIST_COST)
            self._state = YouTubeState.CONNECTED
            return {
                "success": True,
                "state": self._state,
                "channel": self._channel_info,
            }
        except Exception as exc:
            logger.error("[YouTube] Refresh failed: %s", exc)
            return {"success": False, "error": str(exc)}

    # ── Upload settings & templates ─────────────────────────────────────────

    def get_upload_defaults(self) -> dict[str, Any]:
        """Get default upload settings from config."""
        config = load_config()
        return {
            "privacy": config.get("youtube_default_privacy", "unlisted"),
            "playlist": config.get("youtube_default_playlist", ""),
            "title_template": config.get(
                "youtube_title_template",
                "{{ track_name }} - {{ series_name }} Race Highlights"
            ),
            "description_template": config.get(
                "youtube_description_template",
                "Race highlights from {{ track_name }}.\n\nDrivers: {{ drivers }}"
            ),
            "tags": config.get("youtube_default_tags", "iracing,sim racing,highlights"),
        }

    def update_upload_defaults(self, updates: dict[str, Any]) -> dict[str, Any]:
        """Update default upload settings."""
        config = load_config()
        field_map = {
            "privacy": "youtube_default_privacy",
            "playlist": "youtube_default_playlist",
            "title_template": "youtube_title_template",
            "description_template": "youtube_description_template",
            "tags": "youtube_default_tags",
        }
        for key, config_key in field_map.items():
            if key in updates:
                config[config_key] = updates[key]
        save_config(config)
        return self.get_upload_defaults()

    def render_metadata(
        self,
        title_template: str,
        description_template: str,
        project_data: Optional[dict[str, Any]] = None,
    ) -> dict[str, str]:
        """Render title and description templates with project data."""
        context = {
            "track_name": "Unknown Track",
            "series_name": "Unknown Series",
            "drivers": "",
            "date": "",
            "session_type": "",
            "laps": 0,
            "position": "",
            "car": "",
        }
        if project_data:
            context.update(project_data)

        return {
            "title": render_template_string(title_template, context),
            "description": render_template_string(description_template, context),
        }

    # ── Video upload ────────────────────────────────────────────────────────

    async def start_upload(
        self,
        file_path: str,
        title: str,
        description: str = "",
        tags: Optional[list[str]] = None,
        privacy: str = "unlisted",
        project_id: Optional[int] = None,
        playlist_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Start uploading a video to YouTube."""
        # Validate
        if self._state != YouTubeState.CONNECTED:
            return {"success": False, "error": "YouTube not connected"}

        if not Path(file_path).exists():
            return {"success": False, "error": f"File not found: {file_path}"}

        if not self._quota.can_upload():
            return {"success": False, "error": "Daily quota exceeded. Try again tomorrow."}

        token = await self._ensure_valid_token()
        if not token:
            return {"success": False, "error": "Invalid or expired token"}

        with self._lock:
            if self._active_upload and self._active_upload.state == UploadState.UPLOADING:
                return {"success": False, "error": "An upload is already in progress"}

        # Create upload job
        job = UploadJob(
            job_id=uuid.uuid4().hex[:12],
            project_id=project_id,
            file_path=file_path,
            title=title,
            description=description,
            tags=tags,
            privacy=privacy,
            playlist_id=playlist_id,
        )

        with self._lock:
            self._active_upload = job

        # Start upload in background thread
        thread = threading.Thread(
            target=self._run_upload,
            args=(job, token),
            daemon=True,
            name=f"yt-upload-{job.job_id}",
        )
        thread.start()

        logger.info("[YouTube] Upload started: %s → %s", job.title, job.file_path)
        return {"success": True, "job": job.to_dict()}

    def _run_upload(self, job: UploadJob, access_token: str) -> None:
        """Background thread: upload the video."""
        job.state = UploadState.UPLOADING
        job.started_at = time.time()

        self._broadcast(make_event(EventType.YOUTUBE_UPLOAD_STARTED, job.to_dict()))

        def on_progress(bytes_sent: int, total_bytes: int, speed_mbps: float) -> None:
            if job.cancelled:
                raise RuntimeError("Upload cancelled by user")
            job.bytes_sent = bytes_sent
            job.total_bytes = total_bytes
            job.speed_mbps = speed_mbps
            job.progress = (bytes_sent / total_bytes * 100) if total_bytes > 0 else 0
            if speed_mbps > 0:
                remaining_bytes = total_bytes - bytes_sent
                job.eta_seconds = int(remaining_bytes / (speed_mbps * 1024 * 1024))
            self._broadcast(make_event(EventType.YOUTUBE_UPLOAD_PROGRESS, job.to_dict()))

        try:
            # Run async upload in a new event loop for this thread
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                result = loop.run_until_complete(
                    upload_video(
                        access_token=access_token,
                        file_path=job.file_path,
                        title=job.title,
                        description=job.description,
                        tags=job.tags,
                        privacy=job.privacy,
                        playlist_id=job.playlist_id,
                        on_progress=on_progress,
                    )
                )
            finally:
                loop.close()

            job.state = UploadState.COMPLETED
            job.completed_at = time.time()
            job.video_id = result.get("video_id")
            job.video_url = result.get("url")
            job.progress = 100.0

            self._quota.record_operation("videos.insert", QUOTA_UPLOAD_COST)

            self._broadcast(make_event(EventType.YOUTUBE_UPLOAD_COMPLETED, job.to_dict()))

            # Check quota warning
            usage = self._quota.get_usage()
            if usage["warning"]:
                self._broadcast(make_event(EventType.YOUTUBE_QUOTA_WARNING, usage))

            logger.info(
                "[YouTube] Upload completed: %s → %s",
                job.title, job.video_url,
            )

        except Exception as exc:
            job.state = UploadState.ERROR if not job.cancelled else UploadState.CANCELLED
            job.error = str(exc)
            job.completed_at = time.time()

            self._broadcast(make_event(EventType.YOUTUBE_UPLOAD_ERROR, {
                **job.to_dict(),
                "error": str(exc),
            }))

            logger.error("[YouTube] Upload failed: %s", exc)

        finally:
            with self._lock:
                self._upload_history.insert(0, job.to_dict())
                # Keep only last 50 uploads
                self._upload_history = self._upload_history[:50]

    def cancel_upload(self, job_id: str) -> dict[str, Any]:
        """Cancel an active upload."""
        with self._lock:
            if self._active_upload and self._active_upload.job_id == job_id:
                self._active_upload.cancelled = True
                return {"success": True, "message": "Upload cancellation requested"}
        return {"success": False, "error": "No active upload with that ID"}

    # ── Video listing ───────────────────────────────────────────────────────

    async def list_uploaded_videos(
        self,
        max_results: int = 20,
        page_token: Optional[str] = None,
    ) -> dict[str, Any]:
        """List videos from the connected YouTube channel."""
        token = await self._ensure_valid_token()
        if not token:
            return {"success": False, "error": "Not connected or token expired"}

        try:
            result = await list_videos(token, max_results, page_token)
            self._quota.record_operation("search.list + videos.list", QUOTA_LIST_COST * 2)
            return {"success": True, **result}
        except Exception as exc:
            logger.error("[YouTube] List videos failed: %s", exc)
            return {"success": False, "error": str(exc)}

    # ── Quota ───────────────────────────────────────────────────────────────

    def get_quota_usage(self) -> dict[str, Any]:
        """Get current quota usage stats."""
        return self._quota.get_usage()

    # ── Status ──────────────────────────────────────────────────────────────

    def get_upload_status(self) -> dict[str, Any]:
        """Get current upload status and recent history."""
        with self._lock:
            active = self._active_upload.to_dict() if self._active_upload else None
            return {
                "active_upload": active,
                "history": self._upload_history[:10],
            }


# ── Singleton ───────────────────────────────────────────────────────────────

youtube_service = YouTubeService()
