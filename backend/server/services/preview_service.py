"""
preview_service.py
-------------------
Video preview generation service.

Manages tiered preview pipeline per project:
  idle → indexing → sprites → proxy → audio → ready

Tiers:
  1. Keyframe index (~5 s)
  2. Sprite sheet thumbnails (~30–60 s)
  3. Proxy 540p30 video (~1–3 min, background)
  4. Audio track extraction (~5 s)

Real-time progress via WebSocket.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from server.events import EventType, make_event
from server.utils.preview_utils import (
    build_keyframe_index,
    extract_audio,
    extract_frame,
    generate_proxy_video,
    generate_sprite_sheets,
    get_video_info,
)

logger = logging.getLogger(__name__)


# ── Preview states ──────────────────────────────────────────────────────────

class PreviewState:
    IDLE = "idle"
    INDEXING = "indexing"          # Building keyframe index
    SPRITES = "sprites"           # Generating sprite sheets
    PROXY = "proxy"               # Transcoding proxy video
    AUDIO = "audio"               # Extracting audio
    READY = "ready"               # All tiers complete
    ERROR = "error"
    CANCELLED = "cancelled"


# ── Preview Job ─────────────────────────────────────────────────────────────

class PreviewJob:
    """Tracks preview generation for a single project."""

    def __init__(self, project_id: int, input_file: str, preview_dir: str) -> None:
        self.project_id = project_id
        self.input_file = input_file
        self.preview_dir = preview_dir
        self.state = PreviewState.IDLE
        self.video_info: dict[str, Any] = {}
        self.progress: float = 0.0
        self.current_tier: str = ""
        self.tier_progress: float = 0.0
        self.error: Optional[str] = None
        self.started_at: float = 0.0
        self.completed_at: float = 0.0

        # Tier completion flags
        self.keyframe_ready = False
        self.sprites_ready = False
        self.proxy_ready = False
        self.audio_ready = False

        # Paths
        self.keyframe_index_path = str(Path(preview_dir) / "keyframes.json")
        self.sprites_dir = str(Path(preview_dir) / "sprites")
        self.proxy_path = str(Path(preview_dir) / "proxy.mp4")
        self.audio_path = str(Path(preview_dir) / "audio.m4a")
        self.frames_dir = str(Path(preview_dir) / "frames")

        # Cancellation
        self._cancelled = False

    @property
    def is_cancelled(self) -> bool:
        return self._cancelled

    def cancel(self) -> None:
        self._cancelled = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "project_id": self.project_id,
            "state": self.state,
            "progress": round(self.progress, 1),
            "current_tier": self.current_tier,
            "tier_progress": round(self.tier_progress, 1),
            "error": self.error,
            "video_info": self.video_info,
            "keyframe_ready": self.keyframe_ready,
            "sprites_ready": self.sprites_ready,
            "proxy_ready": self.proxy_ready,
            "audio_ready": self.audio_ready,
            "preview_dir": self.preview_dir,
            "proxy_path": self.proxy_path if self.proxy_ready else None,
            "audio_path": self.audio_path if self.audio_ready else None,
            "elapsed": round(time.time() - self.started_at, 1) if self.started_at else 0,
        }


# ── Preview Service ─────────────────────────────────────────────────────────

class PreviewService:
    """Singleton service managing video preview generation."""

    def __init__(self) -> None:
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._broadcast_fn: Optional[Callable] = None
        self._jobs: dict[int, PreviewJob] = {}
        self._lock = threading.Lock()

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def set_broadcast_fn(self, fn: Callable) -> None:
        self._broadcast_fn = fn

    # ── Broadcast helper ────────────────────────────────────────────────────

    def _broadcast(self, event: str, data: dict) -> None:
        """Schedule a WebSocket broadcast on the event loop."""
        if self._broadcast_fn and self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(
                self._broadcast_fn(make_event(event, data)),
                self._loop,
            )

    # ── Status ──────────────────────────────────────────────────────────────

    @property
    def status(self) -> dict[str, Any]:
        """Get status of all preview jobs."""
        with self._lock:
            return {
                "jobs": {pid: job.to_dict() for pid, job in self._jobs.items()},
            }

    def get_job(self, project_id: int) -> Optional[PreviewJob]:
        """Get the preview job for a project."""
        with self._lock:
            return self._jobs.get(project_id)

    def get_job_status(self, project_id: int) -> dict[str, Any]:
        """Get preview status for a specific project."""
        job = self.get_job(project_id)
        if job:
            return job.to_dict()
        return {"state": PreviewState.IDLE, "project_id": project_id}

    # ── Initialize preview ──────────────────────────────────────────────────

    def init_preview(
        self,
        project_id: int,
        input_file: str,
        preview_dir: str,
    ) -> dict[str, Any]:
        """Start the tiered preview generation pipeline.

        Args:
            project_id: Project ID.
            input_file: Source video file path.
            preview_dir: Directory for preview assets.

        Returns:
            Job status dict.
        """
        # Validate input
        input_path = Path(input_file).resolve()
        if ".." in Path(input_file).parts:
            return {"success": False, "error": "Invalid input file path"}
        if not input_path.exists():
            return {"success": False, "error": f"Video file not found: {input_file}"}

        preview_path = Path(preview_dir).resolve()
        if ".." in Path(preview_dir).parts:
            return {"success": False, "error": "Invalid preview directory path"}

        # Check if already running
        with self._lock:
            existing = self._jobs.get(project_id)
            if existing and existing.state in (
                PreviewState.INDEXING, PreviewState.SPRITES,
                PreviewState.PROXY, PreviewState.AUDIO,
            ):
                return {"success": True, "job": existing.to_dict(), "already_running": True}

            # Create job
            job = PreviewJob(project_id, str(input_path), str(preview_path))
            self._jobs[project_id] = job

        # Start background processing
        thread = threading.Thread(
            target=self._run_pipeline,
            args=(job,),
            daemon=True,
            name=f"preview-{project_id}",
        )
        thread.start()

        return {"success": True, "job": job.to_dict()}

    # ── Cancel ──────────────────────────────────────────────────────────────

    def cancel_preview(self, project_id: int) -> dict[str, Any]:
        """Cancel a running preview generation."""
        with self._lock:
            job = self._jobs.get(project_id)
            if not job:
                return {"success": False, "error": "No preview job for this project"}
            if job.state in (PreviewState.READY, PreviewState.IDLE):
                return {"success": False, "error": "Preview is not running"}
            job.cancel()
            job.state = PreviewState.CANCELLED
            return {"success": True, "state": job.state}

    # ── Frame extraction ────────────────────────────────────────────────────

    def get_frame(
        self,
        project_id: int,
        timestamp: float,
        input_file: str,
    ) -> Optional[str]:
        """Extract a full-resolution frame at the given timestamp.

        Returns the path to the extracted JPEG, or None on failure.
        """
        job = self.get_job(project_id)
        if not job:
            return None

        # Create a unique frame file
        frame_name = f"frame_{timestamp:.3f}.jpg".replace(".", "_", 1).replace(".jpg", ".jpg")
        frame_path = str(Path(job.frames_dir) / frame_name)

        # Check cache
        if Path(frame_path).exists():
            return frame_path

        # Extract
        success = extract_frame(input_file, timestamp, frame_path)
        return frame_path if success else None

    # ── Pipeline runner ─────────────────────────────────────────────────────

    def _run_pipeline(self, job: PreviewJob) -> None:
        """Run the full tiered preview pipeline in a background thread."""
        job.started_at = time.time()
        logger.info("[Preview] Starting pipeline for project %d: %s", job.project_id, job.input_file)

        try:
            # ── Tier 0: Video info ──────────────────────────────────────────
            job.video_info = get_video_info(job.input_file)
            if not job.video_info or not job.video_info.get("duration"):
                job.state = PreviewState.ERROR
                job.error = "Could not read video file metadata"
                self._broadcast(EventType.PREVIEW_ERROR, job.to_dict())
                return

            duration = job.video_info["duration"]
            logger.info("[Preview] Video: %.1fs, %dx%d, %.1f fps",
                       duration,
                       job.video_info.get("width", 0),
                       job.video_info.get("height", 0),
                       job.video_info.get("fps", 0))

            # ── Tier 1: Keyframe index ──────────────────────────────────────
            if job.is_cancelled:
                return
            job.state = PreviewState.INDEXING
            job.current_tier = "keyframes"
            job.progress = 0
            self._broadcast(EventType.PREVIEW_PROGRESS, job.to_dict())

            keyframes = build_keyframe_index(job.input_file, job.keyframe_index_path)
            if keyframes:
                job.keyframe_ready = True
                job.progress = 10
                job.tier_progress = 100
                self._broadcast(EventType.PREVIEW_TIER_READY, {
                    **job.to_dict(),
                    "tier": "keyframes",
                    "keyframe_count": len(keyframes),
                })
            else:
                logger.warning("[Preview] Keyframe index empty, continuing anyway")
                job.keyframe_ready = True
                job.progress = 10

            # ── Tier 2: Sprite sheets ───────────────────────────────────────
            if job.is_cancelled:
                return
            job.state = PreviewState.SPRITES
            job.current_tier = "sprites"
            job.tier_progress = 0
            self._broadcast(EventType.PREVIEW_PROGRESS, job.to_dict())

            def _sprite_progress(pct: float) -> None:
                job.tier_progress = pct
                job.progress = 10 + (pct * 0.3)  # 10-40%
                self._broadcast(EventType.PREVIEW_PROGRESS, job.to_dict())

            sheets = generate_sprite_sheets(
                job.input_file,
                job.sprites_dir,
                duration,
                on_progress=_sprite_progress,
            )
            if sheets:
                job.sprites_ready = True
                job.progress = 40
                job.tier_progress = 100
                self._broadcast(EventType.PREVIEW_TIER_READY, {
                    **job.to_dict(),
                    "tier": "sprites",
                    "sheet_count": len(sheets),
                })

            # ── Tier 3: Audio extraction ────────────────────────────────────
            if job.is_cancelled:
                return
            job.state = PreviewState.AUDIO
            job.current_tier = "audio"
            job.tier_progress = 0
            self._broadcast(EventType.PREVIEW_PROGRESS, job.to_dict())

            audio_ok = extract_audio(job.input_file, job.audio_path)
            if audio_ok:
                job.audio_ready = True
                job.progress = 50
                job.tier_progress = 100
                self._broadcast(EventType.PREVIEW_TIER_READY, {
                    **job.to_dict(),
                    "tier": "audio",
                })

            # ── Tier 4: Proxy video ─────────────────────────────────────────
            if job.is_cancelled:
                return
            job.state = PreviewState.PROXY
            job.current_tier = "proxy"
            job.tier_progress = 0
            self._broadcast(EventType.PREVIEW_PROGRESS, job.to_dict())

            def _proxy_progress(pct: float) -> None:
                job.tier_progress = pct
                job.progress = 50 + (pct * 0.5)  # 50-100%
                self._broadcast(EventType.PREVIEW_PROGRESS, job.to_dict())

            proxy_ok = generate_proxy_video(
                job.input_file,
                job.proxy_path,
                on_progress=_proxy_progress,
            )
            if proxy_ok:
                job.proxy_ready = True
                job.progress = 100
                job.tier_progress = 100
                self._broadcast(EventType.PREVIEW_TIER_READY, {
                    **job.to_dict(),
                    "tier": "proxy",
                })

            # ── Complete ────────────────────────────────────────────────────
            job.state = PreviewState.READY
            job.completed_at = time.time()
            job.progress = 100
            elapsed = job.completed_at - job.started_at
            logger.info("[Preview] Pipeline complete for project %d in %.1fs", job.project_id, elapsed)
            self._broadcast(EventType.PREVIEW_READY, job.to_dict())

        except Exception as exc:
            logger.exception("[Preview] Pipeline error for project %d", job.project_id)
            job.state = PreviewState.ERROR
            job.error = str(exc)
            self._broadcast(EventType.PREVIEW_ERROR, job.to_dict())


# ── Module-level singleton ──────────────────────────────────────────────────

preview_service = PreviewService()
