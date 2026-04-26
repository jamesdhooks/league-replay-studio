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
import os
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from server.events import EventType, make_event
from server.services.project_service import project_service
from server.utils.gpu_detection import (
    detect_gpus,
    find_ffmpeg,
    find_ffprobe,
    get_best_encoder,
)
from server.utils.gpu_telemetry import get_telemetry
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
        self.current_step: str = "queued"
        self.log_entries: list[dict[str, Any]] = []

    def add_log(self, level: str, message: str, detail: Optional[str] = None) -> dict[str, Any]:
        """Append a structured log entry and cap history size."""
        entry = {
            "ts": time.time(),
            "level": level,
            "message": message,
            "detail": detail,
        }
        self.log_entries.append(entry)
        if len(self.log_entries) > 600:
            self.log_entries = self.log_entries[-600:]
        return entry

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
                "fps": self.preset.get("fps"),
                "resolution_width": self.preset.get("resolution_width"),
                "resolution_height": self.preset.get("resolution_height"),
                "video_bitrate_mbps": self.preset.get("video_bitrate_mbps"),
                "quality_preset": self.preset.get("quality_preset"),
            },
            "encoder": {
                "id": self.encoder.get("id"),
                "label": self.encoder.get("label"),
                "type": self.encoder.get("type"),
            },
            "job_type": self.job_type,
            "state": self.state,
            "current_step": self.current_step,
            "progress": self.progress,
            "elapsed_seconds": elapsed,
            "duration_seconds": self.duration_seconds,
            "output_size_bytes": self.output_size_bytes,
            "error": self.error,
            "log_entries": self.log_entries,
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
        self._auto_shutdown: bool = False

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
            "auto_shutdown": self._auto_shutdown,
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

    def duplicate_preset(self, preset_id: str) -> Optional[dict[str, Any]]:
        """Duplicate a preset (built-in or custom) as a new custom preset."""
        source = self.get_preset(preset_id)
        if not source:
            return None
        copy = dict(source)
        copy["id"] = f"custom_{uuid.uuid4().hex[:8]}"
        copy["name"] = f"{source.get('name', 'Preset')} (Copy)"
        copy["is_builtin"] = False
        self._custom_presets.append(copy)
        return copy

    # ── Auto-shutdown ───────────────────────────────────────────────────────

    @property
    def auto_shutdown(self) -> bool:
        """Whether to shut down the system when all jobs are done."""
        return self._auto_shutdown

    @auto_shutdown.setter
    def auto_shutdown(self, value: bool) -> None:
        self._auto_shutdown = value

    # ── Completed exports ──────────────────────────────────────────────────

    _VIDEO_EXTENSIONS: frozenset[str] = frozenset(
        {".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v"}
    )

    def get_completed_exports(self) -> list[dict[str, Any]]:
        """Return completed export files.

        Merges two sources so results survive backend restarts:
        1. In-memory completed jobs from this session.
        2. Video files found on disk in each project's ``Encoded`` (and legacy
           ``exports``) folder that are not already covered by a known job.
        """
        completed: list[dict[str, Any]] = []
        known_files: set[str] = set()

        # ── 1. In-memory completed jobs ─────────────────────────────────────
        for job in self._jobs.values():
            if job.state != EncodingState.COMPLETED:
                continue
            output_path = Path(job.output_file)
            exists = output_path.exists()
            size = output_path.stat().st_size if exists else 0
            completed.append({
                "job_id": job.job_id,
                "project_id": job.project_id,
                "output_file": str(output_path),
                "output_dir": str(output_path.parent) if exists else "",
                "file_name": output_path.name,
                "file_exists": exists,
                "file_size_bytes": size,
                "preset": {
                    "id": job.preset.get("id"),
                    "name": job.preset.get("name"),
                },
                "encoder": {
                    "id": job.encoder.get("id"),
                    "label": job.encoder.get("label"),
                },
                "job_type": job.job_type,
                "elapsed_seconds": round(
                    (job.completed_at or 0) - (job.started_at or 0), 1
                ) if job.started_at else 0,
                "completed_at": job.completed_at,
            })
            known_files.add(str(output_path).lower())

        # ── 2. Disk scan — pick up files from previous sessions ─────────────
        try:
            projects = project_service.list_projects()
        except Exception:
            projects = []

        for project in projects:
            proj_dir = project.get("project_dir") or ""
            proj_id = project.get("id")
            if not proj_dir or not proj_id:
                continue

            base = Path(proj_dir)
            scan_dirs = [base / "Encoded", base / "exports"]

            for scan_dir in scan_dirs:
                if not scan_dir.is_dir():
                    continue
                for video_file in scan_dir.iterdir():
                    if video_file.suffix.lower() not in self._VIDEO_EXTENSIONS:
                        continue
                    key = str(video_file).lower()
                    if key in known_files:
                        continue
                    known_files.add(key)
                    try:
                        stat = video_file.stat()
                        completed.append({
                            "job_id": f"disk_{video_file.stem}",
                            "project_id": proj_id,
                            "output_file": str(video_file),
                            "output_dir": str(scan_dir),
                            "file_name": video_file.name,
                            "file_exists": True,
                            "file_size_bytes": stat.st_size,
                            "preset": {"id": None, "name": None},
                            "encoder": {"id": None, "label": None},
                            "job_type": "full",
                            "elapsed_seconds": 0,
                            "completed_at": stat.st_mtime,
                        })
                    except OSError:
                        pass

        # Most recent first
        completed.sort(key=lambda x: x.get("completed_at") or 0, reverse=True)

        # Deduplicate by output_file — keep the first (most-recent) entry per path.
        # This handles re-encodes that produce the same filename after the old file
        # was deleted: the old in-memory job and the new one would both appear otherwise.
        seen: set[str] = set()
        deduped: list[dict[str, Any]] = []
        for item in completed:
            key = str(item.get("output_file") or "").lower().replace("\\", "/")
            if key and key not in seen:
                seen.add(key)
                deduped.append(item)
        return deduped

    # ── Submit job ──────────────────────────────────────────────────────────

    def submit_job(
        self,
        project_id: int,
        input_file: str,
        output_dir: str,
        preset_id: str = "1080p",
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
        # Validate input file — reject path traversal
        input_path = Path(input_file).resolve()
        if ".." in Path(input_file).parts:
            return {"success": False, "error": "Invalid input file path"}
        if not input_path.exists():
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

        project = project_service.get_project(project_id) or {}
        project_dir = project.get("project_dir")
        encoded_dir = Path(project_dir) / "Encoded" if project_dir else None

        # Generate output filename — force encoded outputs into a dedicated folder.
        requested_output_dir = output_dir or str(encoded_dir) if encoded_dir else output_dir
        output_parts = Path(requested_output_dir).parts if requested_output_dir else ()
        if ".." in output_parts:
            return {"success": False, "error": "Invalid output directory path"}
        output_path = Path(requested_output_dir).resolve() if requested_output_dir else Path.cwd().resolve()

        if output_path.name.lower() == "compositions" and encoded_dir is not None:
            output_path = encoded_dir.resolve()

        if encoded_dir is not None:
            encoded_dir_resolved = encoded_dir.resolve()
            if output_path == encoded_dir_resolved.parent / "compositions":
                output_path = encoded_dir_resolved

        os.makedirs(str(output_path), exist_ok=True)
        input_name = input_path.stem
        suffix = "_highlight" if job_type == "highlight" else ""
        preset_tag = preset.get("id", "custom")
        output_file = str(
            output_path / f"{input_name}{suffix}_{preset_tag}.mp4"
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

        queued_log = job.add_log("info", "Job queued", detail=f"input={input_file} output={output_file}")
        self._emit(EventType.ENCODING_LOG, {
            "job_id": job.job_id,
            "project_id": job.project_id,
            **queued_log,
        })

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
            job.current_step = "cancelled"
            # Remove from active
            for gpu_idx, jid in list(self._active_jobs.items()):
                if jid == job_id:
                    del self._active_jobs[gpu_idx]

            cancel_log = job.add_log("warning", "Encoding cancelled by user")
            self._emit(EventType.ENCODING_LOG, {
                "job_id": job.job_id,
                "project_id": job.project_id,
                **cancel_log,
            })

            self._emit(EventType.ENCODING_ERROR, {
                "job_id": job_id,
                "error": "Cancelled by user",
                "state": EncodingState.CANCELLED,
                "current_step": job.current_step,
            })

        elif job.state == EncodingState.QUEUED:
            job.state = EncodingState.CANCELLED
            job.current_step = "cancelled"
            if job_id in self._queue:
                self._queue.remove(job_id)

            cancel_log = job.add_log("warning", "Queued job cancelled by user")
            self._emit(EventType.ENCODING_LOG, {
                "job_id": job.job_id,
                "project_id": job.project_id,
                **cancel_log,
            })

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
        job.current_step = "initializing"
        job.started_at = time.time()
        init_log = job.add_log("info", "Encoding job initialized")
        self._emit(EventType.ENCODING_LOG, {
            "job_id": job.job_id,
            "project_id": job.project_id,
            **init_log,
        })

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

        start_log = job.add_log(
            "info",
            "Starting encoder",
            detail=f"encoder={job.encoder.get('ffmpeg_codec')} gpu_index={job.gpu_index}",
        )
        self._emit(EventType.ENCODING_LOG, {
            "job_id": job.job_id,
            "project_id": job.project_id,
            **start_log,
        })

        self._emit(EventType.ENCODING_STARTED, {
            "job_id": job.job_id,
            "project_id": job.project_id,
            "job_type": job.job_type,
            "encoder": job.encoder.get("label"),
            "preset": job.preset.get("name"),
            "input_file": job.input_file,
            "output_file": job.output_file,
            "current_step": job.current_step,
        })

        try:
            # Build FFmpeg command
            job.current_step = "building_command"
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
            command_text = " ".join(cmd)
            command_log = job.add_log("command", "FFmpeg command", detail=command_text)
            self._emit(EventType.ENCODING_LOG, {
                "job_id": job.job_id,
                "project_id": job.project_id,
                **command_log,
            })

            # Run FFmpeg
            job.current_step = "launching_ffmpeg"
            job.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )

            job.current_step = "encoding"

            def _pump_stderr() -> None:
                if not job.process or not job.process.stderr:
                    return
                for raw in job.process.stderr:
                    if job.state != EncodingState.ENCODING:
                        break
                    line = (raw or "").rstrip()
                    if not line:
                        continue
                    entry = job.add_log("ffmpeg", "ffmpeg stderr", detail=line)
                    self._emit(EventType.ENCODING_LOG, {
                        "job_id": job.job_id,
                        "project_id": job.project_id,
                        **entry,
                    })

            stderr_thread = threading.Thread(
                target=_pump_stderr,
                daemon=True,
                name=f"encode-stderr-{job.job_id}",
            )
            stderr_thread.start()

            # Start GPU telemetry polling thread (if available)
            telemetry = get_telemetry()
            telemetry_stop_event = threading.Event()

            def _poll_gpu_telemetry() -> None:
                """Poll GPU stats periodically and emit telemetry events."""
                poll_interval = 0.5  # 500ms polling interval
                last_emit_time = 0
                emit_interval = 1.0  # Emit events at 1s intervals to avoid spam

                while not telemetry_stop_event.is_set():
                    if job.state != EncodingState.ENCODING:
                        break

                    current_time = time.time()
                    if current_time - last_emit_time >= emit_interval:
                        stats = telemetry.poll(job.gpu_index)
                        if stats:
                            self._emit(EventType.ENCODING_GPU_TELEMETRY, {
                                "job_id": job.job_id,
                                "project_id": job.project_id,
                                **stats.to_dict(),
                            })
                            last_emit_time = current_time

                    time.sleep(poll_interval)

            telemetry_thread = threading.Thread(
                target=_poll_gpu_telemetry,
                daemon=True,
                name=f"encode-telemetry-{job.job_id}",
            )
            telemetry_thread.start()
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
                        progress["current_step"] = job.current_step
                        job.progress = progress

                        snap_log = job.add_log(
                            "progress",
                            f"Progress {progress.get('percentage', 0):.1f}%",
                            detail=(
                                f"fps={progress.get('fps')} speed={progress.get('speed')} "
                                f"time={progress.get('current_time_seconds')}s bitrate={progress.get('bitrate')}"
                            ),
                        )
                        self._emit(EventType.ENCODING_LOG, {
                            "job_id": job.job_id,
                            "project_id": job.project_id,
                            **snap_log,
                        })

                        self._emit(EventType.ENCODING_PROGRESS, {
                            "job_id": job.job_id,
                            "project_id": job.project_id,
                            **progress,
                        })

            # Wait for process to finish
            job.process.wait()
            stderr_thread.join(timeout=1.0)
            telemetry_stop_event.set()
            telemetry_thread.join(timeout=1.0)
            stderr_output = job.process.stderr.read() if job.process.stderr else ""

            if job.state == EncodingState.CANCELLED:
                return

            if job.process.returncode != 0:
                # FFmpeg error
                error_lines = stderr_output.strip().split("\n")[-5:]
                error_msg = "\n".join(error_lines) or f"FFmpeg exited with code {job.process.returncode}"
                job.state = EncodingState.ERROR
                job.current_step = "error"
                job.error = error_msg
                job.completed_at = time.time()

                err_log = job.add_log("error", "Encoding failed", detail=error_msg)
                self._emit(EventType.ENCODING_LOG, {
                    "job_id": job.job_id,
                    "project_id": job.project_id,
                    **err_log,
                })

                logger.error("[Encoding] Job %s failed: %s", job.job_id, error_msg)
                self._emit(EventType.ENCODING_ERROR, {
                    "job_id": job.job_id,
                    "project_id": job.project_id,
                    "error": error_msg,
                    "current_step": job.current_step,
                })
            else:
                # Success — validate output
                job.state = EncodingState.VALIDATING
                job.current_step = "validating_output"
                validate_log = job.add_log("info", "Validating output file")
                self._emit(EventType.ENCODING_LOG, {
                    "job_id": job.job_id,
                    "project_id": job.project_id,
                    **validate_log,
                })
                validation = validate_output_file(job.output_file, ffprobe_path)

                if validation["valid"]:
                    job.state = EncodingState.COMPLETED
                    job.current_step = "completed"
                    job.completed_at = time.time()
                    job.output_size_bytes = validation["size_bytes"]
                    job.progress["percentage"] = 100
                    job.progress["current_step"] = job.current_step

                    elapsed = round(time.time() - job.started_at, 1) if job.started_at else 0
                    logger.info("[Encoding] Job %s completed in %.1fs (%s)",
                                 job.job_id, elapsed,
                                 _format_bytes(job.output_size_bytes))

                    done_log = job.add_log(
                        "success",
                        "Encoding completed",
                        detail=f"elapsed={elapsed}s size={_format_bytes(job.output_size_bytes)}",
                    )
                    self._emit(EventType.ENCODING_LOG, {
                        "job_id": job.job_id,
                        "project_id": job.project_id,
                        **done_log,
                    })

                    self._emit(EventType.ENCODING_COMPLETED, {
                        "job_id": job.job_id,
                        "project_id": job.project_id,
                        "output_file": job.output_file,
                        "output_size_bytes": job.output_size_bytes,
                        "duration_seconds": validation.get("duration_seconds"),
                        "elapsed_seconds": elapsed,
                        "current_step": job.current_step,
                    })
                else:
                    job.state = EncodingState.ERROR
                    job.current_step = "validation_error"
                    job.error = "; ".join(validation["errors"])
                    job.completed_at = time.time()

                    validation_err_log = job.add_log("error", "Output validation failed", detail=job.error)
                    self._emit(EventType.ENCODING_LOG, {
                        "job_id": job.job_id,
                        "project_id": job.project_id,
                        **validation_err_log,
                    })

                    self._emit(EventType.ENCODING_ERROR, {
                        "job_id": job.job_id,
                        "project_id": job.project_id,
                        "error": job.error,
                        "validation": validation,
                        "current_step": job.current_step,
                    })

        except Exception as exc:
            job.state = EncodingState.ERROR
            job.current_step = "exception"
            job.error = str(exc)
            job.completed_at = time.time()
            logger.exception("[Encoding] Job %s exception", job.job_id)

            exc_log = job.add_log("error", "Encoder exception", detail=str(exc))
            self._emit(EventType.ENCODING_LOG, {
                "job_id": job.job_id,
                "project_id": job.project_id,
                **exc_log,
            })

            self._emit(EventType.ENCODING_ERROR, {
                "job_id": job.job_id,
                "project_id": job.project_id,
                "error": str(exc),
                "current_step": job.current_step,
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

        # Auto-shutdown check
        if (self._auto_shutdown
                and not self._active_jobs
                and not self._queue):
            logger.info("[Encoding] All jobs done — auto-shutdown requested")
            self._emit(EventType.ENCODING_COMPLETED, {
                "auto_shutdown": True,
                "message": "All encoding jobs completed. System shutdown requested.",
            })

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
                    logger.debug("Suppressed exception in cleanup", exc_info=True)


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


# ── Module-level singleton ──────────────────────────────────────────────────

encoding_service = EncodingService()
