"""
overlay_service.py
-------------------
Overlay template management service.

Manages the overlay lifecycle:
  idle → initializing → ready → rendering → completed | error

Supports:
- Built-in template library (Broadcast, Minimal, Classic, Cinematic, Blank)
- Template CRUD (import, export, duplicate, delete)
- Per-project template overrides
- Resolution-aware rendering (1080p / 1440p / 4K)
- Batch rendering for export pipeline
- Version tracking for templates
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from server.events import EventType, make_event
from server.utils.overlay_engine import (
    BUILTIN_TEMPLATES_DIR,
    RESOLUTIONS,
    overlay_engine,
)
from server.config import DATA_DIR

logger = logging.getLogger(__name__)


# ── Path sanitisation ────────────────────────────────────────────────────────

import re

_SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


def _safe_id(value: str) -> str:
    """Validate and return a safe identifier for use in file paths.

    Prevents directory traversal attacks by rejecting IDs that contain
    path separators, dots, or other unsafe characters.

    Raises:
        ValueError: If the value contains unsafe characters.
    """
    if not value or not _SAFE_ID_RE.match(value):
        raise ValueError(f"Invalid identifier: {value!r}")
    return value

# ── Template storage ─────────────────────────────────────────────────────────

CUSTOM_TEMPLATES_DIR = DATA_DIR / "overlay_templates"
OVERRIDES_DIR = DATA_DIR / "overlay_overrides"


# ── Overlay states ──────────────────────────────────────────────────────────

class OverlayState:
    IDLE = "idle"
    INITIALIZING = "initializing"
    READY = "ready"
    RENDERING = "rendering"
    ERROR = "error"


# ── Built-in template metadata ──────────────────────────────────────────────

BUILTIN_TEMPLATES: list[dict[str, Any]] = [
    {
        "id": "broadcast",
        "name": "Broadcast",
        "description": "Full broadcast overlay with driver standings, lap counter, and timing tower",
        "style": "broadcast",
        "is_builtin": True,
        "version": "1.0.0",
        "resolutions": ["1080p", "1440p", "4k"],
        "preview_image": None,
    },
    {
        "id": "minimal",
        "name": "Minimal",
        "description": "Clean minimal overlay showing position, driver name, and lap",
        "style": "minimal",
        "is_builtin": True,
        "version": "1.0.0",
        "resolutions": ["1080p", "1440p", "4k"],
        "preview_image": None,
    },
    {
        "id": "classic",
        "name": "Classic",
        "description": "Traditional racing overlay with classic timing board layout",
        "style": "classic",
        "is_builtin": True,
        "version": "1.0.0",
        "resolutions": ["1080p", "1440p", "4k"],
        "preview_image": None,
    },
    {
        "id": "cinematic",
        "name": "Cinematic",
        "description": "Cinematic lower-third overlay for dramatic replays",
        "style": "cinematic",
        "is_builtin": True,
        "version": "1.0.0",
        "resolutions": ["1080p", "1440p", "4k"],
        "preview_image": None,
    },
    {
        "id": "blank",
        "name": "Blank",
        "description": "Empty template — starting point for custom overlays",
        "style": "blank",
        "is_builtin": True,
        "version": "1.0.0",
        "resolutions": ["1080p", "1440p", "4k"],
        "preview_image": None,
    },
]


# ── Overlay Service ─────────────────────────────────────────────────────────

class OverlayService:
    """Singleton service managing overlay templates and rendering."""

    def __init__(self) -> None:
        self._state = OverlayState.IDLE
        self._broadcast_fn: Optional[Callable] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._custom_templates: list[dict[str, Any]] = []
        self._render_thread: Optional[threading.Thread] = None
        self._batch_progress: dict[str, Any] = {}

        # Ensure directories exist
        CUSTOM_TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
        OVERRIDES_DIR.mkdir(parents=True, exist_ok=True)

        # Load custom templates from disk
        self._load_custom_templates()

    # ── Properties ──────────────────────────────────────────────────────────

    @property
    def state(self) -> str:
        return self._state

    @property
    def status(self) -> dict[str, Any]:
        """Return full overlay service status."""
        return {
            "state": self._state,
            "engine_initialized": overlay_engine.initialized,
            "resolution": overlay_engine.resolution,
            "template_count": len(self.get_templates()),
            "custom_template_count": len(self._custom_templates),
            "batch_progress": self._batch_progress,
        }

    # ── Wiring ──────────────────────────────────────────────────────────────

    def set_broadcast_fn(self, fn: Callable) -> None:
        self._broadcast_fn = fn

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    # ── Engine lifecycle ────────────────────────────────────────────────────

    async def initialize(self, resolution: str = "1080p") -> dict[str, Any]:
        """Initialize the overlay rendering engine."""
        self._state = OverlayState.INITIALIZING
        result = await overlay_engine.initialize(resolution)

        if result.get("success"):
            self._state = OverlayState.READY
            logger.info("[Overlay] Service ready")
        else:
            self._state = OverlayState.ERROR
            self._emit(EventType.OVERLAY_ERROR, {"error": result.get("error", "Init failed")})

        return result

    async def shutdown(self) -> None:
        """Shut down the overlay rendering engine."""
        await overlay_engine.shutdown()
        self._state = OverlayState.IDLE

    # ── Template management ─────────────────────────────────────────────────

    def get_templates(self) -> list[dict[str, Any]]:
        """Get all available templates (built-in + custom)."""
        return BUILTIN_TEMPLATES + self._custom_templates

    def get_template(self, template_id: str) -> Optional[dict[str, Any]]:
        """Get a specific template by ID."""
        for t in self.get_templates():
            if t["id"] == template_id:
                return t
        return None

    def import_template(self, template_data: dict[str, Any]) -> dict[str, Any]:
        """Import a custom template.

        Args:
            template_data: Template metadata and HTML content.

        Returns:
            The saved template metadata.
        """
        template_id = template_data.get("id") or f"custom_{uuid.uuid4().hex[:8]}"
        template_id = _safe_id(template_id)
        template_data["id"] = template_id
        template_data["is_builtin"] = False
        template_data["version"] = template_data.get("version", "1.0.0")
        template_data["resolutions"] = template_data.get("resolutions", ["1080p", "1440p", "4k"])

        # Save template files
        template_dir = CUSTOM_TEMPLATES_DIR / template_id
        template_dir.mkdir(parents=True, exist_ok=True)

        # Save HTML content if provided
        html_content = template_data.pop("html_content", None)
        if html_content:
            (template_dir / "overlay.html").write_text(html_content, encoding="utf-8")

        # Save metadata
        meta = {k: v for k, v in template_data.items() if k != "html_content"}
        (template_dir / "meta.json").write_text(
            json.dumps(meta, indent=2), encoding="utf-8"
        )

        # Update in-memory list
        self._update_custom_template(meta)
        self._invalidate_jinja_env()

        logger.info("[Overlay] Template imported: %s", template_id)
        return meta

    def export_template(self, template_id: str) -> Optional[dict[str, Any]]:
        """Export a template (metadata + HTML content).

        Returns:
            Template data dict with html_content, or None if not found.
        """
        template_id = _safe_id(template_id)
        template = self.get_template(template_id)
        if not template:
            return None

        result = dict(template)

        # Read HTML content
        if template.get("is_builtin"):
            html_path = BUILTIN_TEMPLATES_DIR / template_id / "overlay.html"
        else:
            html_path = CUSTOM_TEMPLATES_DIR / template_id / "overlay.html"

        if html_path.exists():
            result["html_content"] = html_path.read_text(encoding="utf-8")

        return result

    def duplicate_template(self, template_id: str) -> Optional[dict[str, Any]]:
        """Duplicate a template as a new custom template."""
        exported = self.export_template(template_id)
        if not exported:
            return None

        new_id = f"custom_{uuid.uuid4().hex[:8]}"
        exported["id"] = new_id
        exported["name"] = f"{exported.get('name', 'Template')} (Copy)"
        exported["is_builtin"] = False
        # Increment version
        ver = exported.get("version", "1.0.0")
        exported["version"] = ver

        return self.import_template(exported)

    def delete_template(self, template_id: str) -> bool:
        """Delete a custom template (built-in templates cannot be deleted)."""
        template_id = _safe_id(template_id)
        template = self.get_template(template_id)
        if not template or template.get("is_builtin"):
            return False

        # Remove from disk
        template_dir = CUSTOM_TEMPLATES_DIR / template_id
        if template_dir.exists():
            shutil.rmtree(template_dir)

        # Remove from memory
        self._custom_templates = [t for t in self._custom_templates if t["id"] != template_id]
        self._invalidate_jinja_env()

        logger.info("[Overlay] Template deleted: %s", template_id)
        return True

    def update_template(self, template_id: str, updates: dict[str, Any]) -> Optional[dict[str, Any]]:
        """Update a custom template's metadata or HTML content."""
        template_id = _safe_id(template_id)
        template = self.get_template(template_id)
        if not template or template.get("is_builtin"):
            return None

        # Update metadata
        for key in ("name", "description", "style", "resolutions"):
            if key in updates:
                template[key] = updates[key]

        # Bump version on update
        template["version"] = _bump_version(template.get("version", "1.0.0"))

        # Save HTML if provided
        html_content = updates.get("html_content")
        if html_content:
            template_dir = CUSTOM_TEMPLATES_DIR / template_id
            template_dir.mkdir(parents=True, exist_ok=True)
            (template_dir / "overlay.html").write_text(html_content, encoding="utf-8")

        # Save metadata
        meta = {k: v for k, v in template.items() if k != "html_content"}
        template_dir = CUSTOM_TEMPLATES_DIR / template_id
        (template_dir / "meta.json").write_text(
            json.dumps(meta, indent=2), encoding="utf-8"
        )

        self._update_custom_template(meta)
        self._invalidate_jinja_env()

        return meta

    # ── Per-project overrides ───────────────────────────────────────────────

    def save_project_override(
        self, project_id: int, template_id: str, html_content: str
    ) -> dict[str, Any]:
        """Save a per-project template override (doesn't modify the original)."""
        safe_tid = _safe_id(template_id)
        safe_pid = _safe_id(str(project_id))
        override_dir = OVERRIDES_DIR / safe_pid / safe_tid
        override_dir.mkdir(parents=True, exist_ok=True)
        (override_dir / "overlay.html").write_text(html_content, encoding="utf-8")

        return {
            "project_id": project_id,
            "template_id": template_id,
            "override_path": str(override_dir / "overlay.html"),
        }

    def get_project_override(self, project_id: int, template_id: str) -> Optional[str]:
        """Get per-project override HTML content, or None if no override exists."""
        safe_tid = _safe_id(template_id)
        safe_pid = _safe_id(str(project_id))
        override_path = OVERRIDES_DIR / safe_pid / safe_tid / "overlay.html"
        if override_path.exists():
            return override_path.read_text(encoding="utf-8")
        return None

    def delete_project_override(self, project_id: int, template_id: str) -> bool:
        """Delete a per-project template override."""
        safe_tid = _safe_id(template_id)
        safe_pid = _safe_id(str(project_id))
        override_dir = OVERRIDES_DIR / safe_pid / safe_tid
        if override_dir.exists():
            shutil.rmtree(override_dir)
            return True
        return False

    # ── Rendering ───────────────────────────────────────────────────────────

    async def render_frame(
        self,
        template_id: str,
        frame_data: dict[str, Any],
        project_id: Optional[int] = None,
    ) -> dict[str, Any]:
        """Render a single overlay frame.

        If a project override exists, it's used instead of the base template.

        Args:
            template_id: Template to render.
            frame_data: Per-frame data context.
            project_id: Optional project for per-project overrides.

        Returns:
            Render result dict.
        """
        template_id = _safe_id(template_id)

        if not overlay_engine.initialized:
            init = await self.initialize()
            if not init.get("success"):
                return init

        # Set up per-project override if it exists
        if project_id:
            safe_pid = _safe_id(str(project_id))
            override = self.get_project_override(project_id, template_id)
            if override:
                override_dir = OVERRIDES_DIR / safe_pid
                overlay_engine.set_custom_template_dirs([override_dir])
            else:
                overlay_engine.set_custom_template_dirs([])
        else:
            overlay_engine.set_custom_template_dirs([])

        # Include custom template dirs for non-builtin templates
        template = self.get_template(template_id)
        if template and not template.get("is_builtin"):
            overlay_engine.set_custom_template_dirs([CUSTOM_TEMPLATES_DIR])

        return await overlay_engine.render_frame(template_id, frame_data)

    def start_batch_render(
        self,
        template_id: str,
        frames: list[dict[str, Any]],
        output_dir: str,
        project_id: Optional[int] = None,
    ) -> dict[str, Any]:
        """Start a batch render in a background thread.

        Args:
            template_id: Template to use.
            frames: List of per-frame data dicts.
            output_dir: Directory for output PNGs.
            project_id: Optional project for overrides.

        Returns:
            Batch job info.
        """
        if self._state == OverlayState.RENDERING:
            return {"success": False, "error": "Batch render already in progress"}

        batch_id = uuid.uuid4().hex[:12]
        self._batch_progress = {
            "batch_id": batch_id,
            "total_frames": len(frames),
            "rendered_frames": 0,
            "percentage": 0,
            "avg_ms_per_frame": 0,
            "state": "rendering",
        }
        self._state = OverlayState.RENDERING

        self._emit(EventType.OVERLAY_RENDER_STARTED, {
            "batch_id": batch_id,
            "total_frames": len(frames),
            "template_id": template_id,
        })

        # Run in background thread
        self._render_thread = threading.Thread(
            target=self._run_batch_render,
            args=(batch_id, template_id, frames, output_dir, project_id),
            daemon=True,
            name=f"overlay-batch-{batch_id}",
        )
        self._render_thread.start()

        return {
            "success": True,
            "batch_id": batch_id,
            "total_frames": len(frames),
        }

    def _run_batch_render(
        self,
        batch_id: str,
        template_id: str,
        frames: list[dict[str, Any]],
        output_dir: str,
        project_id: Optional[int],
    ) -> None:
        """Background thread for batch rendering."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(
                self._async_batch_render(batch_id, template_id, frames, output_dir, project_id)
            )
        except Exception as exc:
            logger.exception("[Overlay] Batch render failed: %s", exc)
            self._batch_progress["state"] = "error"
            self._state = OverlayState.ERROR
            self._emit(EventType.OVERLAY_ERROR, {
                "batch_id": batch_id,
                "error": str(exc),
            })
        finally:
            loop.close()

    async def _async_batch_render(
        self,
        batch_id: str,
        template_id: str,
        frames: list[dict[str, Any]],
        output_dir: str,
        project_id: Optional[int],
    ) -> None:
        """Async batch render implementation."""
        # Initialize engine if needed
        if not overlay_engine.initialized:
            init = await overlay_engine.initialize()
            if not init.get("success"):
                raise RuntimeError(init.get("error", "Engine init failed"))

        # Set up overrides
        if project_id:
            override = self.get_project_override(project_id, template_id)
            if override:
                overlay_engine.set_custom_template_dirs([OVERRIDES_DIR / str(project_id)])
            else:
                overlay_engine.set_custom_template_dirs([])

        template = self.get_template(template_id)
        if template and not template.get("is_builtin"):
            overlay_engine.set_custom_template_dirs([CUSTOM_TEMPLATES_DIR])

        def on_progress(frame_idx: int, total: int, elapsed_ms: float) -> None:
            pct = round((frame_idx + 1) / total * 100, 1) if total > 0 else 0
            self._batch_progress.update({
                "rendered_frames": frame_idx + 1,
                "percentage": pct,
                "avg_ms_per_frame": round(elapsed_ms, 2),
            })
            # Emit progress every 10 frames to avoid flooding
            if (frame_idx + 1) % 10 == 0 or (frame_idx + 1) == total:
                self._emit(EventType.OVERLAY_RENDER_PROGRESS, {
                    "batch_id": batch_id,
                    "rendered_frames": frame_idx + 1,
                    "total_frames": total,
                    "percentage": pct,
                })

        result = await overlay_engine.batch_render_for_export(
            template_id, frames, output_dir, on_progress=on_progress,
        )

        self._batch_progress["state"] = "completed" if result.get("success") else "error"
        self._state = OverlayState.READY

        if result.get("success"):
            self._emit(EventType.OVERLAY_RENDER_COMPLETED, {
                "batch_id": batch_id,
                **result,
            })
        else:
            self._emit(EventType.OVERLAY_ERROR, {
                "batch_id": batch_id,
                "error": f"{result.get('error_count', 0)} frames failed",
            })

    # ── Internal helpers ────────────────────────────────────────────────────

    def _load_custom_templates(self) -> None:
        """Load custom template metadata from disk."""
        self._custom_templates = []
        if not CUSTOM_TEMPLATES_DIR.exists():
            return

        for meta_path in CUSTOM_TEMPLATES_DIR.glob("*/meta.json"):
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                meta["is_builtin"] = False
                self._custom_templates.append(meta)
            except (json.JSONDecodeError, OSError) as exc:
                logger.warning("[Overlay] Failed to load template %s: %s", meta_path, exc)

    def _update_custom_template(self, meta: dict[str, Any]) -> None:
        """Update or add a custom template in the in-memory list."""
        for i, t in enumerate(self._custom_templates):
            if t["id"] == meta["id"]:
                self._custom_templates[i] = meta
                return
        self._custom_templates.append(meta)

    def _invalidate_jinja_env(self) -> None:
        """Force Jinja2 environment re-creation on next render."""
        overlay_engine.set_custom_template_dirs([])

    def _emit(self, event_type: str, data: dict[str, Any]) -> None:
        """Emit a WebSocket event via the broadcast function."""
        if not self._broadcast_fn:
            return
        message = make_event(event_type, data)
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(
                self._broadcast_fn(message), self._loop
            )
        else:
            try:
                self._broadcast_fn(message)
            except Exception:
                pass


# ── Helpers ─────────────────────────────────────────────────────────────────

def _bump_version(version: str) -> str:
    """Bump the patch version (e.g., '1.0.0' → '1.0.1')."""
    parts = version.split(".")
    if len(parts) == 3:
        parts[2] = str(int(parts[2]) + 1)
    return ".".join(parts)


# ── Module-level singleton ──────────────────────────────────────────────────

overlay_service = OverlayService()
