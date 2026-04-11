"""
composition_service.py
-----------------------
Video composition service: trim, overlay, transition, stitch.

Orchestrates the final video assembly from captured clips:
  1. Trim each clip's pre/post buffer to match script segment duration
  2. Render section-appropriate overlay (intro/qualifying/race/results)
  3. Insert fade-to-black transitions between non-contiguous segments
  4. Stitch everything into the final encoded video

Real-time progress is emitted via WebSocket events.
"""

from __future__ import annotations

import asyncio
import logging
import re
import subprocess
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from server.events import EventType, make_event
from server.utils.ffmpeg_builder import (
    get_video_duration,
    validate_output_file,
)
from server.utils.gpu_detection import find_ffmpeg, find_ffprobe, get_best_encoder

logger = logging.getLogger(__name__)


# ── Allowed file extensions (mirrors overlay_compositor.py) ─────────────────

_ALLOWED_VIDEO_EXTENSIONS: frozenset[str] = frozenset({".mp4", ".mov", ".mkv", ".avi", ".ts"})
_ALLOWED_OUTPUT_EXTENSIONS: frozenset[str] = frozenset({".mp4", ".mov", ".mkv"})


# ── Composition states ──────────────────────────────────────────────────────

class CompositionState:
    """State machine states for a composition job."""
    IDLE = "idle"
    PROCESSING = "processing"
    TRIMMING = "trimming"
    OVERLAYING = "overlaying"
    STITCHING = "stitching"
    COMPLETED = "completed"
    ERROR = "error"
    CANCELLED = "cancelled"


# ── Composition log entry ───────────────────────────────────────────────────

@dataclass
class CompositionLogEntry:
    """Structured log entry for composition pipeline audit trail.

    Emitted at every pipeline step and forwarded to the frontend
    progress UI via WebSocket.
    """
    timestamp: float = 0.0
    step_name: str = ""
    detail: str = ""
    success: bool = True
    segment_id: str = ""
    progress_pct: float = 0.0
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Serialize for API / WebSocket payloads."""
        return {
            "timestamp": self.timestamp,
            "step_name": self.step_name,
            "detail": self.detail,
            "success": self.success,
            "segment_id": self.segment_id,
            "progress_pct": round(self.progress_pct, 1),
            "extra": self.extra,
        }


# ── Composition job ─────────────────────────────────────────────────────────

class CompositionJob:
    """Represents a single composition pipeline run."""

    def __init__(
        self,
        job_id: str,
        project_id: int,
        script: list[dict[str, Any]],
        clips_manifest: list[dict[str, Any]],
        overlay_config: dict[str, Any],
        transition_config: dict[str, Any],
        trim_config: dict[str, Any],
        output_dir: str,
        preset_id: str,
    ) -> None:
        self.job_id = job_id
        self.project_id = project_id
        self.script = script
        self.clips_manifest = clips_manifest
        self.overlay_config = overlay_config
        self.transition_config = transition_config
        self.trim_config = trim_config
        self.output_dir = output_dir
        self.preset_id = preset_id

        self.state = CompositionState.IDLE
        self.started_at: float | None = None
        self.completed_at: float | None = None
        self.error: str | None = None
        self.output_file: str | None = None
        self.log_entries: list[CompositionLogEntry] = []
        self.progress_pct: float = 0.0

        # Intermediate artefacts (cleaned up on completion)
        self.trimmed_clips: list[str] = []
        self.overlaid_clips: list[str] = []
        self.transition_clips: list[str] = []

    def to_dict(self) -> dict[str, Any]:
        """Serialize job state for API responses."""
        elapsed = 0.0
        if self.started_at:
            end = self.completed_at or time.time()
            elapsed = round(end - self.started_at, 1)

        return {
            "job_id": self.job_id,
            "project_id": self.project_id,
            "state": self.state,
            "progress_pct": round(self.progress_pct, 1),
            "elapsed_seconds": elapsed,
            "output_file": self.output_file,
            "error": self.error,
            "log_entries": [e.to_dict() for e in self.log_entries[-50:]],
            "clip_count": len(self.clips_manifest),
            "preset_id": self.preset_id,
        }


# ── Path validation helpers ─────────────────────────────────────────────────

def _safe_video_path(path: str) -> str:
    """Resolve and validate a video input path.

    Rejects path-traversal attempts and unknown extensions.
    Returns the resolved absolute path string.
    """
    raw = Path(path)
    if ".." in raw.parts:
        raise ValueError(f"Path traversal rejected: {path!r}")
    resolved = raw.resolve()  # lgtm[py/path-injection]
    if resolved.suffix.lower() not in _ALLOWED_VIDEO_EXTENSIONS:
        raise ValueError(f"Unexpected video extension {resolved.suffix!r} for {resolved!r}")
    return str(resolved)


def _safe_output_path(path: str) -> str:
    """Resolve and validate a video output path, creating parent dirs."""
    raw = Path(path)
    if ".." in raw.parts:
        raise ValueError(f"Path traversal rejected: {path!r}")
    resolved = raw.resolve()  # lgtm[py/path-injection]
    if resolved.suffix.lower() not in _ALLOWED_OUTPUT_EXTENSIONS:
        raise ValueError(f"Unexpected output extension {resolved.suffix!r} for {resolved!r}")
    resolved.parent.mkdir(parents=True, exist_ok=True)  # lgtm[py/path-injection]
    return str(resolved)


def _sanitise_id(raw_id: str, max_len: int = 64) -> str:
    """Return a filesystem-safe version of an ID string."""
    return re.sub(r"[^a-zA-Z0-9_\-]", "_", str(raw_id))[:max_len]


# ── Composition Service ─────────────────────────────────────────────────────

class CompositionService:
    """Singleton service orchestrating the video composition pipeline.

    Bridges the capture step (which produces raw clips) and the final
    encoding step by trimming, overlaying, inserting transitions, and
    stitching clips into a single output video.

    Wire up with ``set_broadcast_fn`` / ``set_loop`` before first use
    so that real-time progress events are emitted via WebSocket.
    """

    def __init__(self) -> None:
        self._jobs: dict[str, CompositionJob] = {}
        self._active_job_id: str | None = None
        self._thread: threading.Thread | None = None
        self._cancel_event = threading.Event()
        self._broadcast_fn: Callable | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    # ── Properties ──────────────────────────────────────────────────────────

    @property
    def status(self) -> dict[str, Any]:
        """Return full composition status snapshot."""
        active = None
        if self._active_job_id and self._active_job_id in self._jobs:
            active = self._jobs[self._active_job_id].to_dict()

        recent = [
            j.to_dict()
            for j in self._jobs.values()
            if j.state in (CompositionState.COMPLETED, CompositionState.ERROR, CompositionState.CANCELLED)
        ]
        recent.sort(key=lambda x: x.get("elapsed_seconds", 0), reverse=True)

        return {
            "active_job": active,
            "recent_jobs": recent[:20],
            "is_busy": self._active_job_id is not None,
        }

    # ── Wiring ──────────────────────────────────────────────────────────────

    def set_broadcast_fn(self, fn: Callable) -> None:
        """Set the function used to broadcast WebSocket messages."""
        self._broadcast_fn = fn

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Set the asyncio event loop for scheduling broadcasts."""
        self._loop = loop

    # ── Submit job ──────────────────────────────────────────────────────────

    def submit_job(
        self,
        project_id: int,
        script: list[dict[str, Any]],
        clips_manifest: list[dict[str, Any]],
        overlay_config: dict[str, Any] | None = None,
        transition_config: dict[str, Any] | None = None,
        trim_config: dict[str, Any] | None = None,
        output_dir: str = "",
        preset_id: str = "youtube_1080p60",
    ) -> dict[str, Any]:
        """Submit a composition job for background execution.

        Args:
            project_id:        Project database ID.
            script:            List of segment dicts from the script editor,
                               each with ``id``, ``section``, ``start_time``,
                               ``end_time``, ``duration``, etc.
            clips_manifest:    List of clip dicts from the capture step,
                               each with ``id``, ``path``, ``section``,
                               ``start_time_seconds``, ``end_time_seconds``.
            overlay_config:    ``{"template_id": str, "per_section": {...}}``.
            transition_config: ``{"fade_threshold": float, "fade_duration": float}``.
            trim_config:       ``{"trim_start_buffer": float, "trim_end_buffer": float}``.
            output_dir:        Directory to write the final video.
            preset_id:         Encoding preset for the final stitch.

        Returns:
            ``{"success": True, "job": <job_dict>}`` or error dict.
        """
        if self._active_job_id is not None:
            return {"success": False, "error": "A composition job is already running"}

        # Validate output directory — must be under the application's
        # data directory to prevent arbitrary filesystem writes.
        if not output_dir:
            return {"success": False, "error": "output_dir is required"}
        out_path = Path(output_dir)
        if ".." in out_path.parts:
            return {"success": False, "error": "Invalid output directory path"}
        out_resolved = out_path.resolve()

        # Restrict to allowed base directories (project data paths).
        from server.config import DATA_DIR, PROJECTS_DIR
        allowed_bases = [DATA_DIR.resolve(), PROJECTS_DIR.resolve()]
        if not any(out_resolved == base or out_resolved.is_relative_to(base) for base in allowed_bases):
            return {
                "success": False,
                "error": "Output directory must be within the application data directory",
            }
        out_resolved.mkdir(parents=True, exist_ok=True)  # lgtm[py/path-injection]

        if not clips_manifest:
            return {"success": False, "error": "clips_manifest is empty"}
        if not script:
            return {"success": False, "error": "script is empty"}

        # Verify FFmpeg is available
        if not find_ffmpeg():
            return {"success": False, "error": "FFmpeg not found. Install FFmpeg to compose videos."}

        job_id = uuid.uuid4().hex[:12]
        job = CompositionJob(
            job_id=job_id,
            project_id=project_id,
            script=script,
            clips_manifest=clips_manifest,
            overlay_config=overlay_config or {},
            transition_config=transition_config or {"fade_threshold": 5.0, "fade_duration": 1.5},
            trim_config=trim_config or {"trim_start_buffer": 0.0, "trim_end_buffer": 0.0},
            output_dir=str(out_resolved),
            preset_id=preset_id,
        )

        self._jobs[job_id] = job
        self._active_job_id = job_id
        self._cancel_event.clear()

        logger.info(
            "[Composition] Job %s submitted: %d clips, preset=%s, output=%s",
            job_id, len(clips_manifest), preset_id, out_resolved,
        )

        # Start background thread
        self._thread = threading.Thread(
            target=self._run_pipeline,
            args=(job,),
            daemon=True,
            name=f"compose-{job_id}",
        )
        self._thread.start()

        return {"success": True, "job": job.to_dict()}

    # ── Get / cancel job ────────────────────────────────────────────────────

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        """Get job info by ID."""
        job = self._jobs.get(job_id)
        return job.to_dict() if job else None

    def cancel_job(self, job_id: str) -> dict[str, Any]:
        """Cancel a running composition job."""
        job = self._jobs.get(job_id)
        if not job:
            return {"success": False, "error": "Job not found"}

        if job.state in (CompositionState.COMPLETED, CompositionState.ERROR, CompositionState.CANCELLED):
            return {"success": False, "error": f"Job already in terminal state: {job.state}"}

        self._cancel_event.set()
        job.state = CompositionState.CANCELLED
        job.completed_at = time.time()
        self._log(job, "cancel", "Job cancelled by user")

        self._emit(EventType.COMPOSITION_ERROR, {
            "job_id": job_id,
            "project_id": job.project_id,
            "error": "Cancelled by user",
            "state": CompositionState.CANCELLED,
        })

        return {"success": True, "job": job.to_dict()}

    # ── Pipeline execution (background thread) ──────────────────────────────

    def _run_pipeline(self, job: CompositionJob) -> None:
        """Execute the full composition pipeline in a background thread.

        Steps:
            1. Trim clips to match script segment durations
            2. Render & burn overlays onto each trimmed clip
            3. Generate fade-to-black transitions between non-contiguous clips
            4. Stitch all clips + transitions into the final video
        """
        ffmpeg_path = find_ffmpeg()
        ffprobe_path = find_ffprobe()

        if not ffmpeg_path:
            self._fail(job, "FFmpeg not found")
            return

        job.state = CompositionState.PROCESSING
        job.started_at = time.time()

        self._log(job, "start", f"Composition started for {len(job.clips_manifest)} clips")
        self._emit(EventType.COMPOSITION_STARTED, {
            "job_id": job.job_id,
            "project_id": job.project_id,
            "clip_count": len(job.clips_manifest),
            "preset_id": job.preset_id,
        })

        try:
            # ── Step 1: Trim ────────────────────────────────────────────────
            if self._is_cancelled(job):
                return
            job.state = CompositionState.TRIMMING
            trimmed = self._step_trim(job, ffmpeg_path, ffprobe_path)
            if trimmed is None:
                return  # _step_trim already called _fail

            # ── Step 2: Overlay ─────────────────────────────────────────────
            if self._is_cancelled(job):
                return
            job.state = CompositionState.OVERLAYING
            overlaid = self._step_overlay(job, trimmed, ffmpeg_path)
            if overlaid is None:
                return

            # ── Step 3: Build clip list with transitions ────────────────────
            if self._is_cancelled(job):
                return
            job.state = CompositionState.STITCHING
            final_clip_list = self._step_transitions(job, overlaid, ffmpeg_path, ffprobe_path)
            if final_clip_list is None:
                return

            # ── Step 4: Stitch / concatenate ────────────────────────────────
            if self._is_cancelled(job):
                return
            output_file = self._step_stitch(job, final_clip_list, ffmpeg_path, ffprobe_path)
            if output_file is None:
                return

            # ── Done ────────────────────────────────────────────────────────
            job.state = CompositionState.COMPLETED
            job.completed_at = time.time()
            job.output_file = output_file
            job.progress_pct = 100.0
            elapsed = round(time.time() - (job.started_at or 0), 1)

            self._log(job, "complete", f"Composition finished in {elapsed}s → {output_file}")
            self._emit(EventType.COMPOSITION_COMPLETED, {
                "job_id": job.job_id,
                "project_id": job.project_id,
                "output_file": output_file,
                "elapsed_seconds": elapsed,
            })

            logger.info("[Composition] Job %s completed in %.1fs → %s", job.job_id, elapsed, output_file)

        except Exception as exc:
            logger.exception("[Composition] Job %s unhandled exception", job.job_id)
            self._fail(job, str(exc))

        finally:
            self._active_job_id = None
            self._thread = None

    # ── Step 1: Trim ────────────────────────────────────────────────────────

    def _step_trim(
        self,
        job: CompositionJob,
        ffmpeg_path: str,
        ffprobe_path: str | None,
    ) -> list[dict[str, Any]] | None:
        """Trim each captured clip to match its script segment duration.

        Uses ``-c copy`` (stream copy) for speed — no re-encoding needed
        at this stage.  The overlay step handles re-encoding.

        Returns:
            List of clip dicts with added ``trimmed_path`` key,
            or ``None`` on failure.
        """
        trim_start_buf = float(job.trim_config.get("trim_start_buffer", 0.0))
        trim_end_buf = float(job.trim_config.get("trim_end_buffer", 0.0))
        out_dir = Path(job.output_dir) / "trimmed"
        out_dir.mkdir(parents=True, exist_ok=True)

        total = len(job.clips_manifest)
        results: list[dict[str, Any]] = []

        for idx, clip in enumerate(job.clips_manifest):
            if self._is_cancelled(job):
                return None

            seg_id = clip.get("id", f"clip_{idx}")
            clip_path_raw = clip.get("path", "")

            # Validate clip path
            try:
                clip_path = _safe_video_path(clip_path_raw)
            except ValueError as exc:
                self._log(job, "trim", f"Invalid clip path: {exc}", success=False, segment_id=seg_id)
                results.append({**clip, "trimmed_path": None})
                continue

            if not Path(clip_path).is_file():  # lgtm[py/path-injection]
                self._log(job, "trim", f"Clip not found: {clip_path}", success=False, segment_id=seg_id)
                results.append({**clip, "trimmed_path": None})
                continue

            # Calculate trim boundaries
            # Segment timing from the script
            seg_start = float(clip.get("start_time_seconds", 0))
            seg_end = float(clip.get("end_time_seconds", seg_start + 30))
            seg_duration = seg_end - seg_start

            # The captured clip may have pre/post buffer from the capture step.
            # We trim to remove that buffer, keeping only the segment content
            # plus any user-configured trim buffer.
            clip_duration: float | None = None
            if ffprobe_path:
                clip_duration = get_video_duration(ffprobe_path, clip_path)

            # Trim from the start buffer, to segment duration + end buffer
            trim_ss = max(0.0, trim_start_buf)
            if clip_duration and clip_duration > 0:
                trim_to = min(clip_duration, seg_duration + trim_start_buf - trim_end_buf)
            else:
                trim_to = seg_duration + trim_start_buf - trim_end_buf
            trim_to = max(trim_ss + 0.1, trim_to)  # ensure positive duration

            safe_id = _sanitise_id(seg_id)
            trimmed_path = str(out_dir / f"{safe_id}_trimmed.mp4")

            cmd = [
                ffmpeg_path, "-hide_banner", "-loglevel", "warning", "-y",
                "-i", clip_path,
                "-ss", f"{trim_ss:.3f}",
                "-to", f"{trim_to:.3f}",
                "-c", "copy",
                trimmed_path,
            ]

            try:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)  # noqa: S603
                if result.returncode != 0:
                    err = result.stderr[:300] if result.stderr else f"FFmpeg exit code {result.returncode}"
                    self._log(job, "trim", f"FFmpeg trim failed for {seg_id}: {err}",
                              success=False, segment_id=seg_id)
                    results.append({**clip, "trimmed_path": None})
                    continue
            except subprocess.TimeoutExpired:
                self._log(job, "trim", f"Trim timed out for {seg_id}", success=False, segment_id=seg_id)
                results.append({**clip, "trimmed_path": None})
                continue

            job.trimmed_clips.append(trimmed_path)
            results.append({**clip, "trimmed_path": trimmed_path})

            pct = ((idx + 1) / total) * 25  # trim is 0-25%
            job.progress_pct = pct
            self._log(job, "trim", f"Trimmed {seg_id} → {trimmed_path}", segment_id=seg_id, progress_pct=pct)
            self._emit_progress(job, "trimming", idx, total)

        # Check that at least one clip was trimmed successfully
        valid = [r for r in results if r.get("trimmed_path")]
        if not valid:
            self._fail(job, "All clips failed to trim — nothing to compose")
            return None

        self._log(job, "trim", f"Trim complete: {len(valid)}/{total} clips trimmed")
        return results

    # ── Step 2: Overlay ─────────────────────────────────────────────────────

    def _step_overlay(
        self,
        job: CompositionJob,
        clips: list[dict[str, Any]],
        ffmpeg_path: str,
    ) -> list[dict[str, Any]] | None:
        """Render and burn section-appropriate overlays onto each trimmed clip.

        Uses :class:`~server.utils.overlay_compositor.OverlayCompositor` for
        the actual compositing.  If no overlay config is provided, clips
        pass through unchanged.

        Returns:
            Updated clip list with ``overlaid_path`` key, or ``None`` on failure.
        """
        template_id = job.overlay_config.get("template_id", "")
        per_section = job.overlay_config.get("per_section", {})

        # If no overlay template configured, skip overlay step entirely
        if not template_id and not per_section:
            self._log(job, "overlay", "No overlay config — skipping overlay step")
            for clip in clips:
                clip["overlaid_path"] = clip.get("trimmed_path")
            return clips

        from server.utils.frame_data_builder import build_frame_data
        from server.utils.overlay_compositor import OverlayCompositor

        compositor = OverlayCompositor()
        out_dir = Path(job.output_dir) / "overlaid"
        out_dir.mkdir(parents=True, exist_ok=True)

        total = len(clips)
        for idx, clip in enumerate(clips):
            if self._is_cancelled(job):
                return None

            seg_id = clip.get("id", f"clip_{idx}")
            trimmed = clip.get("trimmed_path")

            if not trimmed:
                clip["overlaid_path"] = None
                continue

            section = clip.get("section", "race")
            session_time = float(clip.get("start_time_seconds", 0))

            # Determine which template to use for this section
            section_template = per_section.get(section, {}).get("template_id", template_id)
            if not section_template:
                # No overlay for this section — pass through
                clip["overlaid_path"] = trimmed
                self._log(job, "overlay", f"No overlay template for section '{section}', passing through",
                          segment_id=seg_id)
                continue

            safe_id = _sanitise_id(seg_id)
            overlaid_path = str(out_dir / f"{safe_id}_overlaid.mp4")

            # Build frame data for this clip's telemetry snapshot
            project_dir = clip.get("project_dir", "")
            series_name = clip.get("series_name", "")
            track_name = clip.get("track_name", "")
            focused_car_idx = clip.get("focused_car_idx")

            frame_data = None
            if project_dir:
                try:
                    frame_data = build_frame_data(
                        project_dir=project_dir,
                        session_time=session_time,
                        section=section,
                        focused_car_idx=focused_car_idx,
                        series_name=series_name,
                        track_name=track_name,
                    )
                except Exception as exc:
                    logger.warning(
                        "[Composition] frame_data build failed for %s: %s", seg_id, exc
                    )

            # Use synchronous composite_clip with a pre-rendered overlay PNG.
            # Since we're in a background thread, we run the async
            # render_and_composite via a new event loop if needed.
            try:
                overlaid = self._run_overlay_composite(
                    compositor=compositor,
                    clip_path=trimmed,
                    template_id=section_template,
                    output_path=overlaid_path,
                    frame_data=frame_data,
                    project_dir=project_dir,
                    session_time=session_time,
                    section=section,
                    focused_car_idx=focused_car_idx,
                    series_name=series_name,
                    track_name=track_name,
                )
            except Exception as exc:
                logger.warning("[Composition] Overlay failed for %s: %s", seg_id, exc)
                overlaid = None

            if overlaid:
                clip["overlaid_path"] = overlaid
                job.overlaid_clips.append(overlaid)
                self._log(job, "overlay", f"Overlaid {seg_id} → {overlaid}", segment_id=seg_id)
            else:
                # Fall back to trimmed clip if overlay fails
                clip["overlaid_path"] = trimmed
                self._log(job, "overlay", f"Overlay failed for {seg_id}, using trimmed clip",
                          success=False, segment_id=seg_id)

            pct = 25 + ((idx + 1) / total) * 40  # overlay is 25-65%
            job.progress_pct = pct
            self._emit_progress(job, "overlaying", idx, total)

        valid = [c for c in clips if c.get("overlaid_path")]
        if not valid:
            self._fail(job, "All clips failed overlay — nothing to stitch")
            return None

        self._log(job, "overlay", f"Overlay complete: {len(valid)}/{total} clips processed")
        return clips

    def _run_overlay_composite(
        self,
        compositor: Any,
        clip_path: str,
        template_id: str,
        output_path: str,
        frame_data: dict[str, Any] | None = None,
        project_dir: str = "",
        session_time: float = 0.0,
        section: str = "race",
        focused_car_idx: int | None = None,
        series_name: str = "",
        track_name: str = "",
    ) -> str | None:
        """Run the async overlay compositor from a synchronous thread.

        Creates a temporary event loop to run the async
        ``render_and_composite`` method.  This is safe because we are in
        a dedicated daemon thread, not the main asyncio loop.
        """
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(
                compositor.render_and_composite(
                    clip_path=clip_path,
                    template_id=template_id,
                    output_path=output_path,
                    overlay_engine=self._get_overlay_engine(),
                    frame_data=frame_data,
                    project_dir=project_dir or None,
                    session_time=session_time,
                    section=section,
                    focused_car_idx=focused_car_idx,
                    series_name=series_name,
                    track_name=track_name,
                )
            )
        finally:
            loop.close()

    @staticmethod
    def _get_overlay_engine() -> Any:
        """Lazy-import and return the overlay engine singleton.

        The overlay engine requires Playwright and is heavy to import,
        so we defer the import to first use.
        """
        try:
            from server.utils.overlay_engine import overlay_engine
            return overlay_engine
        except ImportError:
            logger.warning("[Composition] overlay_engine not available — overlay step will be skipped")
            return None

    # ── Step 3: Transitions ─────────────────────────────────────────────────

    def _step_transitions(
        self,
        job: CompositionJob,
        clips: list[dict[str, Any]],
        ffmpeg_path: str,
        ffprobe_path: str | None,
    ) -> list[str] | None:
        """Insert fade-to-black transitions between non-contiguous clips.

        Clips whose time gap exceeds ``fade_threshold`` get a short black
        clip with fade-out / fade-in inserted between them.

        Returns:
            Ordered list of file paths (clips + transitions) ready for
            concatenation, or ``None`` on failure.
        """
        fade_threshold = float(job.transition_config.get("fade_threshold", 5.0))
        fade_duration = float(job.transition_config.get("fade_duration", 1.5))
        trans_dir = Path(job.output_dir) / "transitions"
        trans_dir.mkdir(parents=True, exist_ok=True)

        # Collect the valid overlaid (or trimmed) clips in script order
        ordered: list[dict[str, Any]] = [c for c in clips if c.get("overlaid_path")]
        if not ordered:
            self._fail(job, "No valid clips for transition insertion")
            return None

        final_list: list[str] = []
        total = len(ordered)

        for idx, clip in enumerate(ordered):
            if self._is_cancelled(job):
                return None

            clip_file = clip["overlaid_path"]
            final_list.append(clip_file)

            # Check if a transition is needed before the *next* clip
            if idx < total - 1:
                next_clip = ordered[idx + 1]
                current_end = float(clip.get("end_time_seconds", 0))
                next_start = float(next_clip.get("start_time_seconds", 0))
                gap = next_start - current_end

                if gap > fade_threshold:
                    seg_id = clip.get("id", f"clip_{idx}")
                    trans_path = self._generate_fade_transition(
                        ffmpeg_path, ffprobe_path, clip_file, fade_duration, trans_dir, idx,
                    )
                    if trans_path:
                        final_list.append(trans_path)
                        job.transition_clips.append(trans_path)
                        self._log(
                            job, "transition",
                            f"Fade transition inserted after {seg_id} (gap={gap:.1f}s)",
                            segment_id=seg_id,
                        )

            pct = 65 + ((idx + 1) / total) * 15  # transitions are 65-80%
            job.progress_pct = pct
            self._emit_progress(job, "transitions", idx, total)

        self._log(job, "transition", f"Transition pass complete: {len(final_list)} files in sequence")
        return final_list

    def _generate_fade_transition(
        self,
        ffmpeg_path: str,
        ffprobe_path: str | None,
        preceding_clip: str,
        fade_duration: float,
        trans_dir: Path,
        index: int,
    ) -> str | None:
        """Generate a short black clip with fade-out then fade-in.

        The clip matches the resolution and framerate of the preceding clip
        so FFmpeg concat demuxer does not complain about stream mismatches.

        Returns:
            Path to the generated transition clip, or ``None`` on failure.
        """
        # Detect resolution and fps from the preceding clip
        width, height, fps = 1920, 1080, 60
        if ffprobe_path:
            info = self._probe_video_info(ffprobe_path, preceding_clip)
            width = info.get("width", 1920)
            height = info.get("height", 1080)
            fps = info.get("fps", 60)

        trans_path = str(trans_dir / f"transition_{index:03d}.mp4")
        half = fade_duration / 2.0

        # Generate a black clip with fade-in at the start and fade-out at the end.
        # Total duration = fade_duration (half fade-in, half fade-out).
        cmd = [
            ffmpeg_path, "-hide_banner", "-loglevel", "warning", "-y",
            "-f", "lavfi",
            "-i", (
                f"color=c=black:s={width}x{height}:r={fps}:d={fade_duration},"
                f"fade=t=in:st=0:d={half},fade=t=out:st={half}:d={half}"
            ),
            # Silent audio track matching typical capture format
            "-f", "lavfi",
            "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-t", f"{fade_duration:.3f}",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k",
            "-shortest",
            trans_path,
        ]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)  # noqa: S603
            if result.returncode != 0:
                logger.warning(
                    "[Composition] Transition generation failed (rc=%d): %s",
                    result.returncode, result.stderr[:300],
                )
                return None
        except subprocess.TimeoutExpired:
            logger.warning("[Composition] Transition generation timed out")
            return None

        return trans_path

    @staticmethod
    def _probe_video_info(ffprobe_path: str, clip_path: str) -> dict[str, Any]:
        """Probe a video for resolution and framerate.

        Returns:
            Dict with ``width``, ``height``, ``fps`` keys.
        """
        info: dict[str, Any] = {"width": 1920, "height": 1080, "fps": 60}
        try:
            result = subprocess.run(  # noqa: S603
                [
                    ffprobe_path, "-v", "error",
                    "-select_streams", "v:0",
                    "-show_entries", "stream=width,height,r_frame_rate",
                    "-of", "default=noprint_wrappers=1",
                    clip_path,
                ],
                capture_output=True, text=True, timeout=30,
            )
            for line in result.stdout.strip().splitlines():
                key, _, val = line.partition("=")
                if key == "width":
                    info["width"] = int(val)
                elif key == "height":
                    info["height"] = int(val)
                elif key == "r_frame_rate" and "/" in val:
                    num, den = val.split("/")
                    if int(den) > 0:
                        info["fps"] = round(int(num) / int(den))
        except Exception as exc:
            logger.debug("[Composition] ffprobe info failed: %s", exc)
        return info

    # ── Step 4: Stitch ──────────────────────────────────────────────────────

    def _step_stitch(
        self,
        job: CompositionJob,
        clip_list: list[str],
        ffmpeg_path: str,
        ffprobe_path: str | None,
    ) -> str | None:
        """Concatenate all clips and transitions into the final video.

        Uses the FFmpeg concat demuxer for lossless concatenation when
        all streams are compatible.  Falls back to the concat filter
        if the demuxer fails.

        Returns:
            Path to the final output file, or ``None`` on failure.
        """
        if not clip_list:
            self._fail(job, "No clips to stitch")
            return None

        # If only one clip, just copy it
        if len(clip_list) == 1:
            output_file = str(Path(job.output_dir) / f"composed_{job.job_id}.mp4")
            try:
                safe_src = _safe_video_path(clip_list[0])
                safe_dst = _safe_output_path(output_file)
                cmd = [
                    ffmpeg_path, "-hide_banner", "-loglevel", "warning", "-y",
                    "-i", safe_src,
                    "-c", "copy",
                    safe_dst,
                ]
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)  # noqa: S603
                if result.returncode != 0:
                    self._fail(job, f"Copy single clip failed: {result.stderr[:300]}")
                    return None
            except (ValueError, subprocess.TimeoutExpired) as exc:
                self._fail(job, f"Stitch (single) error: {exc}")
                return None

            self._log(job, "stitch", f"Single clip copied → {output_file}")
            job.progress_pct = 95.0
            self._emit_progress(job, "stitching", 0, 1)
            return output_file

        # Write concat list file
        concat_list_path = Path(job.output_dir) / f"concat_{job.job_id}.txt"
        try:
            with open(concat_list_path, "w", encoding="utf-8") as fh:
                for clip_file in clip_list:
                    # FFmpeg concat demuxer requires 'file' directives with escaped paths
                    safe_path = Path(clip_file).resolve()
                    escaped = str(safe_path).replace("'", "'\\''")
                    fh.write(f"file '{escaped}'\n")
        except OSError as exc:
            self._fail(job, f"Cannot write concat list: {exc}")
            return None

        output_file = str(Path(job.output_dir) / f"composed_{job.job_id}.mp4")

        try:
            safe_output = _safe_output_path(output_file)
        except ValueError as exc:
            self._fail(job, f"Invalid output path: {exc}")
            return None

        # Try concat demuxer first (stream copy — fast)
        cmd = [
            ffmpeg_path, "-hide_banner", "-loglevel", "warning", "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(concat_list_path),
            "-c", "copy",
            safe_output,
        ]

        self._log(job, "stitch", f"Stitching {len(clip_list)} files via concat demuxer")

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)  # noqa: S603
            if result.returncode != 0:
                logger.warning(
                    "[Composition] Concat demuxer failed (rc=%d), falling back to re-encode: %s",
                    result.returncode, result.stderr[:300],
                )
                # Fallback: re-encode via concat filter
                output_file = self._stitch_reencode(job, clip_list, ffmpeg_path, safe_output)
                if not output_file:
                    return None
        except subprocess.TimeoutExpired:
            self._fail(job, "Stitch timed out (10 min limit)")
            return None

        # Clean up concat list
        try:
            concat_list_path.unlink(missing_ok=True)
        except OSError:
            pass

        # Validate the output file
        if ffprobe_path:
            validation = validate_output_file(output_file, ffprobe_path)
            if not validation["valid"]:
                self._fail(job, f"Output validation failed: {'; '.join(validation['errors'])}")
                return None
            self._log(
                job, "stitch",
                f"Output validated: {validation.get('duration_seconds', '?')}s, "
                f"{validation.get('size_bytes', 0)} bytes",
            )

        job.progress_pct = 95.0
        self._emit_progress(job, "stitching", len(clip_list) - 1, len(clip_list))
        return output_file

    def _stitch_reencode(
        self,
        job: CompositionJob,
        clip_list: list[str],
        ffmpeg_path: str,
        output_path: str,
    ) -> str | None:
        """Fallback stitch via the FFmpeg concat filter (re-encodes).

        Used when the concat demuxer fails due to stream incompatibility.
        """
        self._log(job, "stitch", "Re-encoding via concat filter (slower)")

        # Build input args
        input_args: list[str] = []
        for clip_file in clip_list:
            input_args.extend(["-i", str(Path(clip_file).resolve())])

        n = len(clip_list)
        # Build the concat filter
        filter_inputs = "".join(f"[{i}:v:0][{i}:a:0]" for i in range(n))
        filter_str = f"{filter_inputs}concat=n={n}:v=1:a=1[outv][outa]"

        encoder = get_best_encoder("h264")
        codec = encoder.get("ffmpeg_codec", "libx264")

        cmd = [
            ffmpeg_path, "-hide_banner", "-loglevel", "warning", "-y",
            *input_args,
            "-filter_complex", filter_str,
            "-map", "[outv]", "-map", "[outa]",
            "-c:v", codec, "-preset", "fast", "-crf", "18",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            output_path,
        ]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=900)  # noqa: S603
            if result.returncode != 0:
                self._fail(job, f"Re-encode stitch failed: {result.stderr[:300]}")
                return None
        except subprocess.TimeoutExpired:
            self._fail(job, "Re-encode stitch timed out (15 min limit)")
            return None

        return output_path

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _is_cancelled(self, job: CompositionJob) -> bool:
        """Check if cancellation was requested."""
        if self._cancel_event.is_set():
            if job.state != CompositionState.CANCELLED:
                job.state = CompositionState.CANCELLED
                job.completed_at = time.time()
            return True
        return False

    def _fail(self, job: CompositionJob, error: str) -> None:
        """Transition job to error state and emit event."""
        job.state = CompositionState.ERROR
        job.error = error
        job.completed_at = time.time()

        self._log(job, "error", error, success=False)
        logger.error("[Composition] Job %s failed: %s", job.job_id, error)

        self._emit(EventType.COMPOSITION_ERROR, {
            "job_id": job.job_id,
            "project_id": job.project_id,
            "error": error,
        })

    def _log(
        self,
        job: CompositionJob,
        step_name: str,
        detail: str,
        success: bool = True,
        segment_id: str = "",
        progress_pct: float | None = None,
        extra: dict | None = None,
    ) -> None:
        """Append a structured log entry to the job."""
        entry = CompositionLogEntry(
            timestamp=time.time(),
            step_name=step_name,
            detail=detail,
            success=success,
            segment_id=segment_id,
            progress_pct=progress_pct if progress_pct is not None else job.progress_pct,
            extra=extra or {},
        )
        job.log_entries.append(entry)
        logger.info("[Composition] [%s] %s (seg=%s ok=%s)", step_name, detail, segment_id, success)

    # ── Event emission ──────────────────────────────────────────────────────

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
                logger.debug("Suppressed exception in emit", exc_info=True)

    def _emit_progress(
        self,
        job: CompositionJob,
        step: str,
        segment_index: int,
        total_segments: int,
    ) -> None:
        """Emit a composition:progress event with current state."""
        self._emit(EventType.COMPOSITION_PROGRESS, {
            "job_id": job.job_id,
            "project_id": job.project_id,
            "step": step,
            "segment_index": segment_index,
            "total_segments": total_segments,
            "progress_pct": round(job.progress_pct, 1),
            "state": job.state,
            "log_entries": [e.to_dict() for e in job.log_entries[-10:]],
        })


# ── Module-level singleton ──────────────────────────────────────────────────

composition_service = CompositionService()
