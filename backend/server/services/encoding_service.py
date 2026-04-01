"""
encoding_service.py
--------------------
GPU-accelerated video encoding service.

Manages the encoding lifecycle:
  idle → queued → encoding → validating → completed | error

Supports:
- GPU-accelerated encoding (NVENC, AMF, QSV) with CPU fallback
- Export presets (YouTube 1080p60, Discord 720p30, Archive 4K, Custom)
- EDL-based highlight reel encoding
- Real-time progress via WebSocket
- Multi-GPU simultaneous encoding
- Batch queue for sequential processing
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from server.events import EventType, make_event
from server.utils.gpu_detection import (
    detect_gpus,
    find_ffmpeg,
    find_ffprobe,
    get_best_encoder,
)
from server.utils.ffmpeg_builder import (
    DEFAULT_PRESETS,
    build_encode_command,
    compute_progress,
    get_video_duration,
    validate_output_file,
)

logger = logging.getLogger(__name__)


# ── Encoding states ─────────────────────────────────────────────────────────

class EncodingState:
    IDLE = "idle"
    QUEUED = "queued"
    ENCODING = "encoding"
    VALIDATING = "validating"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    ERROR = "error"


# ── Encoding Job ────────────────────────────────────────────────────────────

class EncodingJob:
    """Represents a single encoding job."""

    def __init__(
        self,
        job_id: str,
        project_id: int,
        input_file: str,
        output_file: str,
        preset: dict[str, Any],
        encoder: dict[str, Any],
        edl: Optional[list[dict]] = None,
        job_type: str = "full",       # "full" or "highlight"
        gpu_index: int = 0,
    ) -> None:
        self.job_id = job_id
        self.project_id = project_id
        self.input_file = input_file
        self.output_file = output_file
        self.preset = preset
        self.encoder = encoder
        self.edl = edl
        self.job_type = job_type
        self.gpu_index = gpu_index

        self.state = EncodingState.QUEUED
        self.progress: dict[str, Any] = {
            "percentage": 0,
            "fps": 0,
            "speed": "",
            "eta_seconds": None,
            "current_time_seconds": 0,
            "bitrate": "",
        }
        self.started_at: Optional[float] = None
        self.completed_at: Optional[float] = None
        self.duration_seconds: Optional[float] = None
        self.output_size_bytes: int = 0
        self.error: Optional[str] = None
        self.process: Optional[subprocess.Popen] = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize job to dict for API responses."""
        elapsed = 0
        if self.started_at:
            end = self.completed_at or time.time()
            elapsed = round(end - self.started_at, 1)

        return {
            "job_id": self.job_id,
            "project_id": self.project_id,
            "input_file": self.input_file,
            "output_file": self.output_file,
            "preset": {
                "id": self.preset.get("id"),
                "name": self.preset.get("name"),
            },
            "encoder": {
                "id": self.encoder.get("id"),
                "label": self.encoder.get("label"),
                "type": self.encoder.get("type"),
            },
            "job_type": self.job_type,
            "state": self.state,
            "progress": self.progress,
            "elapsed_seconds": elapsed,
            "duration_seconds": self.duration_seconds,
            "output_size_bytes": self.output_size_bytes,
            "error": self.error,
        }


# ── Encoding Service ────────────────────────────────────────────────────────

class EncodingService:
    """Singleton service managing video encoding."""

    def __init__(self) -> None:
        self._jobs: dict[str, EncodingJob] = {}
        self._queue: list[str] = []          # Job IDs in queue order
        self._active_jobs: dict[str, str] = {}  # gpu_index → job_id
        self._encode_threads: dict[str, threading.Thread] = {}
        self._broadcast_fn: Optional[Callable] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._gpu_info: Optional[dict] = None
        self._custom_presets: list[dict[str, Any]] = []

    # ── Properties ──────────────────────────────────────────────────────────

    @property
    def status(self) -> dict[str, Any]:
        """Return full encoding status snapshot."""
        active = [
            self._jobs[jid].to_dict()
            for jid in self._active_jobs.values()
            if jid in self._jobs
        ]
        queued = [
            self._jobs[jid].to_dict()
            for jid in self._queue
            if jid in self._jobs and self._jobs[jid].state == EncodingState.QUEUED
        ]
        recent = [
            j.to_dict()
            for j in self._jobs.values()
            if j.state in (EncodingState.COMPLETED, EncodingState.ERROR, EncodingState.CANCELLED)
        ]
        # Keep last 20 completed jobs
        recent = sorted(recent, key=lambda x: x.get("elapsed_seconds", 0), reverse=True)[:20]

        return {
            "active_jobs": active,
            "queued_jobs": queued,
            "recent_jobs": recent,
            "queue_length": len(queued),
        }

    # ── Wiring ──────────────────────────────────────────────────────────────

    def set_broadcast_fn(self, fn: Callable) -> None:
        self._broadcast_fn = fn

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    # ── GPU Detection ───────────────────────────────────────────────────────

    def detect_gpus(self) -> dict[str, Any]:
        """Detect GPU encoding capabilities (cached)."""
        if self._gpu_info is None:
            self._gpu_info = detect_gpus()
        return self._gpu_info

    def refresh_gpus(self) -> dict[str, Any]:
        """Force re-detection of GPU capabilities."""
        self._gpu_info = detect_gpus()
        return self._gpu_info

    # ── Presets ─────────────────────────────────────────────────────────────

    def get_presets(self) -> list[dict[str, Any]]:
        """Get all available export presets (built-in + custom)."""
        return DEFAULT_PRESETS + self._custom_presets

    def get_preset(self, preset_id: str) -> Optional[dict[str, Any]]:
        """Get a specific preset by ID."""
        for p in self.get_presets():
            if p["id"] == preset_id:
                return p
        return None

    def save_custom_preset(self, preset: dict[str, Any]) -> dict[str, Any]:
        """Save a custom preset."""
        preset_id = preset.get("id") or f"custom_{uuid.uuid4().hex[:8]}"
        preset["id"] = preset_id
        preset["is_builtin"] = False

        # Update or append
        for i, existing in enumerate(self._custom_presets):
            if existing["id"] == preset_id:
                self._custom_presets[i] = preset
                return preset

        self._custom_presets.append(preset)
        return preset

    def delete_custom_preset(self, preset_id: str) -> bool:
        """Delete a custom preset."""
        for i, p in enumerate(self._custom_presets):
            if p["id"] == preset_id:
                self._custom_presets.pop(i)
                return True
        return False

    # ── Submit job ──────────────────────────────────────────────────────────

    def submit_job(
        self,
        project_id: int,
        input_file: str,
        output_dir: str,
        preset_id: str = "youtube_1080p60",
        edl: Optional[list[dict]] = None,
        job_type: str = "full",
        custom_preset: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Submit an encoding job to the queue.

        Args:
            project_id: Project ID.
            input_file: Source video path.
            output_dir: Directory for output file.
            preset_id: Export preset ID.
            edl: Optional EDL for highlight reel.
            job_type: "full" or "highlight".
            custom_preset: Optional custom preset overrides.

        Returns:
            Job info dict.
        """
        # Validate input file
        if not Path(input_file).exists():
            return {"success": False, "error": f"Input file not found: {input_file}"}

        # Get preset
        preset = custom_preset or self.get_preset(preset_id)
        if not preset:
            return {"success": False, "error": f"Unknown preset: {preset_id}"}

        # Detect GPU and choose encoder
        gpu_info = self.detect_gpus()
        if not gpu_info["ffmpeg_available"]:
            return {"success": False, "error": "FFmpeg not found. Install FFmpeg to encode videos."}

        codec_family = preset.get("codec_family", "h264")
        encoder = get_best_encoder(codec_family)

        # Generate output filename
        os.makedirs(output_dir, exist_ok=True)
        input_name = Path(input_file).stem
        suffix = "_highlight" if job_type == "highlight" else ""
        preset_tag = preset.get("id", "custom")
        output_file = str(
            Path(output_dir) / f"{input_name}{suffix}_{preset_tag}.mp4"
        )

        # Create job
        job_id = uuid.uuid4().hex[:12]
        job = EncodingJob(
            job_id=job_id,
            project_id=project_id,
            input_file=input_file,
            output_file=output_file,
            preset=preset,
            encoder=encoder,
            edl=edl,
            job_type=job_type,
        )

        self._jobs[job_id] = job
        self._queue.append(job_id)

        logger.info("[Encoding] Job %s queued: %s → %s (%s)",
                     job_id, input_file, output_file, encoder.get("label"))

        # Try to start immediately if no active job
        self._process_queue()

        return {"success": True, "job": job.to_dict()}

    # ── Cancel job ──────────────────────────────────────────────────────────

    def cancel_job(self, job_id: str) -> dict[str, Any]:
        """Cancel an encoding job."""
        job = self._jobs.get(job_id)
        if not job:
            return {"success": False, "error": "Job not found"}

        if job.state == EncodingState.ENCODING:
            # Kill the FFmpeg process
            if job.process and job.process.poll() is None:
                job.process.terminate()
                try:
                    job.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    job.process.kill()

            job.state = EncodingState.CANCELLED
            # Remove from active
            for gpu_idx, jid in list(self._active_jobs.items()):
                if jid == job_id:
                    del self._active_jobs[gpu_idx]

            self._emit(EventType.ENCODING_ERROR, {
                "job_id": job_id,
                "error": "Cancelled by user",
                "state": EncodingState.CANCELLED,
            })

        elif job.state == EncodingState.QUEUED:
            job.state = EncodingState.CANCELLED
            if job_id in self._queue:
                self._queue.remove(job_id)

        return {"success": True, "job": job.to_dict()}

    # ── Get job ─────────────────────────────────────────────────────────────

    def get_job(self, job_id: str) -> Optional[dict[str, Any]]:
        """Get job info by ID."""
        job = self._jobs.get(job_id)
        return job.to_dict() if job else None

    # ── Queue processing ────────────────────────────────────────────────────

    def _process_queue(self) -> None:
        """Start the next queued job if a GPU/CPU slot is available."""
        if not self._queue:
            return

        # Find available slot (simple: max 1 active encoding for now)
        # Multi-GPU: could allow 1 per GPU
        max_concurrent = 1
        gpu_info = self.detect_gpus()
        if gpu_info.get("gpu_count", 0) >= 2:
            max_concurrent = 2

        while len(self._active_jobs) < max_concurrent and self._queue:
            job_id = self._queue.pop(0)
            job = self._jobs.get(job_id)
            if not job or job.state != EncodingState.QUEUED:
                continue

            # Assign GPU index
            used_gpus = set(self._active_jobs.keys())
            gpu_idx = "0"
            for i in range(max_concurrent):
                if str(i) not in used_gpus:
                    gpu_idx = str(i)
                    break

            self._active_jobs[gpu_idx] = job_id
            job.gpu_index = int(gpu_idx)

            # Start encoding in background thread
            thread = threading.Thread(
                target=self._encode_job,
                args=(job,),
                daemon=True,
                name=f"encode-{job_id}",
            )
            self._encode_threads[job_id] = thread
            thread.start()

    def _encode_job(self, job: EncodingJob) -> None:
        """Run encoding in a background thread."""
        ffmpeg_path = find_ffmpeg()
        ffprobe_path = find_ffprobe()

        if not ffmpeg_path:
            job.state = EncodingState.ERROR
            job.error = "FFmpeg not found"
            self._emit(EventType.ENCODING_ERROR, {
                "job_id": job.job_id,
                "error": job.error,
            })
            self._finish_job(job.job_id)
            return

        job.state = EncodingState.ENCODING
        job.started_at = time.time()

        # Get input duration for progress calculation
        if ffprobe_path:
            job.duration_seconds = get_video_duration(ffprobe_path, job.input_file)

        # If encoding an EDL highlight reel, compute total duration from segments
        if job.edl and len(job.edl) > 0:
            job.duration_seconds = sum(
                seg.get("end_time", 0) - seg.get("start_time", 0)
                for seg in job.edl
            )

        logger.info("[Encoding] Starting job %s: %s (encoder=%s, gpu=%d)",
                     job.job_id, job.input_file,
                     job.encoder.get("ffmpeg_codec"), job.gpu_index)

        self._emit(EventType.ENCODING_STARTED, {
            "job_id": job.job_id,
            "project_id": job.project_id,
            "job_type": job.job_type,
            "encoder": job.encoder.get("label"),
            "preset": job.preset.get("name"),
            "input_file": job.input_file,
            "output_file": job.output_file,
        })

        try:
            # Build FFmpeg command
            cmd = build_encode_command(
                ffmpeg_path=ffmpeg_path,
                input_file=job.input_file,
                output_file=job.output_file,
                encoder_codec=job.encoder.get("ffmpeg_codec", "libx264"),
                preset=job.preset,
                edl=job.edl,
                gpu_index=job.gpu_index,
            )

            logger.info("[Encoding] Command: %s", " ".join(cmd))

            # Run FFmpeg
            job.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )

            # Parse progress from stdout
            progress_data: dict[str, str] = {}
            for line in job.process.stdout:
                if job.state != EncodingState.ENCODING:
                    break  # Cancelled

                kv = line.strip()
                if "=" in kv:
                    key, _, value = kv.partition("=")
                    progress_data[key.strip()] = value.strip()

                    # On "progress=continue" or "progress=end", emit update
                    if key.strip() == "progress":
                        progress = compute_progress(
                            progress_data,
                            job.duration_seconds or 0,
                        )
                        job.progress = progress

                        self._emit(EventType.ENCODING_PROGRESS, {
                            "job_id": job.job_id,
                            "project_id": job.project_id,
                            **progress,
                        })

            # Wait for process to finish
            job.process.wait()
            stderr_output = job.process.stderr.read() if job.process.stderr else ""

            if job.state == EncodingState.CANCELLED:
                return

            if job.process.returncode != 0:
                # FFmpeg error
                error_lines = stderr_output.strip().split("\n")[-5:]
                error_msg = "\n".join(error_lines) or f"FFmpeg exited with code {job.process.returncode}"
                job.state = EncodingState.ERROR
                job.error = error_msg
                job.completed_at = time.time()

                logger.error("[Encoding] Job %s failed: %s", job.job_id, error_msg)
                self._emit(EventType.ENCODING_ERROR, {
                    "job_id": job.job_id,
                    "project_id": job.project_id,
                    "error": error_msg,
                })
            else:
                # Success — validate output
                job.state = EncodingState.VALIDATING
                validation = validate_output_file(job.output_file, ffprobe_path)

                if validation["valid"]:
                    job.state = EncodingState.COMPLETED
                    job.completed_at = time.time()
                    job.output_size_bytes = validation["size_bytes"]
                    job.progress["percentage"] = 100

                    elapsed = round(time.time() - job.started_at, 1) if job.started_at else 0
                    logger.info("[Encoding] Job %s completed in %.1fs (%s)",
                                 job.job_id, elapsed,
                                 _format_bytes(job.output_size_bytes))

                    self._emit(EventType.ENCODING_COMPLETED, {
                        "job_id": job.job_id,
                        "project_id": job.project_id,
                        "output_file": job.output_file,
                        "output_size_bytes": job.output_size_bytes,
                        "duration_seconds": validation.get("duration_seconds"),
                        "elapsed_seconds": elapsed,
                    })
                else:
                    job.state = EncodingState.ERROR
                    job.error = "; ".join(validation["errors"])
                    job.completed_at = time.time()

                    self._emit(EventType.ENCODING_ERROR, {
                        "job_id": job.job_id,
                        "project_id": job.project_id,
                        "error": job.error,
                        "validation": validation,
                    })

        except Exception as exc:
            job.state = EncodingState.ERROR
            job.error = str(exc)
            job.completed_at = time.time()
            logger.exception("[Encoding] Job %s exception", job.job_id)

            self._emit(EventType.ENCODING_ERROR, {
                "job_id": job.job_id,
                "project_id": job.project_id,
                "error": str(exc),
            })

        finally:
            self._finish_job(job.job_id)

    def _finish_job(self, job_id: str) -> None:
        """Clean up after a job finishes and start next queued job."""
        # Remove from active
        for gpu_idx, jid in list(self._active_jobs.items()):
            if jid == job_id:
                del self._active_jobs[gpu_idx]

        # Clean up thread ref
        self._encode_threads.pop(job_id, None)

        # Process next in queue
        self._process_queue()

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
                pass


# ── Helpers ─────────────────────────────────────────────────────────────────

def _format_bytes(size: int) -> str:
    """Format bytes to human-readable string."""
    if size >= 1e9:
        return f"{size / 1e9:.1f} GB"
    if size >= 1e6:
        return f"{size / 1e6:.1f} MB"
    if size >= 1e3:
        return f"{size / 1e3:.0f} KB"
    return f"{size} B"


# Need os import for makedirs in submit_job
import os

# ── Module-level singleton ──────────────────────────────────────────────────

encoding_service = EncodingService()
