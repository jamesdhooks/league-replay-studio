"""
script_capture.py
-----------------
Script-driven capture engine for Video Composition Scripts.

For each segment in the script, the engine:
  1. Pauses the replay
  2. Seeks to the segment's start time (minus configurable padding buffer)
  3. Switches to the appropriate iRacing camera / driver focus
  4. **Validates** seek position, camera, and driver via iRacing telemetry
  5. Retries commands with cooldown until confirmed (configurable max retries)
  6. Simultaneously starts the recorder and resumes the replay
  7. Fires intra-segment camera/driver schedule switches at their exact offsets
     *during* playback (not after), using _wait_with_schedule()
  8. Determines if the next segment is contiguous or has a gap:
     - **Contiguous**: keeps recording, sends camera/driver switch only
     - **Gap**: stops recording, validates clip file, catalogues it with
       a descriptive name linked to the script segment(s)
  9. After every requested clip is captured: runs one final validation audit,
     then deletes and recaptures only failed clips when retries are enabled

After all segments are captured, clips are compiled using FFmpeg concat.

Two recording backends are supported:
  - **Native (LRS)**: uses CaptureEngine directly; output path is controlled.
  - **Hotkey (OBS/ShadowPlay/ReLive)**: uses HotkeyRecorderAdapter which sends
    configurable hotkeys, then polls a watch folder for the new file and renames
    it into the project clips directory.

All commands and their outcomes are recorded in a structured capture log
for full auditability and debugging.

Clock injection
~~~~~~~~~~~~~~~
Pass ``_now`` (monotonic clock) and ``_sleep`` (sleep function) to the
constructor to replace ``time.monotonic`` and ``time.sleep``.  This lets unit
tests drive the engine without real wall-clock delays::

    clock = FakeClock()
    engine = ScriptCaptureEngine(..., _now=clock.now, _sleep=clock.sleep)
"""

from __future__ import annotations

import logging
import os
import platform
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from server.utils.command_log import command_log
from server.utils.ffmpeg_builder import validate_output_file

logger = logging.getLogger(__name__)

# ── Configuration defaults ──────────────────────────────────────────────────

DEFAULT_CLIP_PADDING = 2.0          # seconds before each clip
DEFAULT_CLIP_PADDING_AFTER = 1.0    # seconds after each clip
MAX_SEEK_RETRIES = 5                # attempts to validate a seek command
MAX_CAMERA_RETRIES = 3              # attempts to validate camera/driver switch
SEEK_COOLDOWN = 0.8                 # seconds between seek retry attempts
CAMERA_COOLDOWN = 0.5               # seconds between camera retry attempts
SEEK_TOLERANCE_MS = 3000            # ±ms tolerance for seek validation
SEEK_SETTLE_TIMEOUT = 2.0           # seconds to poll telemetry after seek
SEEK_SETTLE_POLL = 0.1              # seconds between seek-settle reads
CONTIGUOUS_GAP_THRESHOLD = 1.0      # max gap (seconds) to treat segments as contiguous
OBS_POLL_INTERVAL = 1.0             # seconds between file-size stability checks
OBS_STABLE_CHECKS = 3               # consecutive stable-size checks before moving file
OBS_PRE_HOTKEY_TOLERANCE = 2.0      # seconds before hotkey to scan for files (timing fuzz)

_MAX_FILENAME_LENGTH = 64
_MIN_COMPILE_TIMEOUT = 120
_COMPILE_SECONDS_PER_CLIP = 60
_SAFE_FILENAME_RE = re.compile(r'[^a-zA-Z0-9_\-]')


# ── Structured capture log entry ────────────────────────────────────────────

@dataclass
class CaptureLogEntry:
    """A single structured log entry for the capture audit trail."""
    timestamp: float = 0.0
    segment_id: str = ""
    action: str = ""         # seek, camera, driver, record_start, record_stop, validate, retry, error, info
    detail: str = ""
    success: bool = True
    attempt: int = 1
    expected: Any = None
    actual: Any = None
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = {
            "timestamp": round(self.timestamp, 3),
            "segment_id": self.segment_id,
            "action": self.action,
            "detail": self.detail,
            "success": self.success,
        }
        if self.attempt > 1:
            d["attempt"] = self.attempt
        if self.expected is not None:
            d["expected"] = self.expected
        if self.actual is not None:
            d["actual"] = self.actual
        if self.extra:
            d["extra"] = self.extra
        return d

class CaptureAbortError(RuntimeError):
    """Raised when script capture aborts due to an unrecoverable validation failure."""

    def __init__(self, segment_id: str, action: str, reason: str, extra: Optional[dict] = None):
        super().__init__(reason)
        self.segment_id = segment_id
        self.action = action
        self.reason = reason
        self.extra = extra or {}


# ── Helpers ─────────────────────────────────────────────────────────────────

def _find_ffmpeg() -> Optional[str]:
    """Locate the FFmpeg binary."""
    try:
        from server.utils.gpu_detection import find_ffmpeg
        return find_ffmpeg()
    except Exception:
        return shutil.which("ffmpeg")


def _find_ffprobe() -> Optional[str]:
    """Locate the ffprobe binary."""
    try:
        from server.utils.gpu_detection import find_ffprobe
        return find_ffprobe()
    except Exception:
        return shutil.which("ffprobe")


def find_capture_ffprobe() -> Optional[str]:
    """Return the ffprobe path used by capture validation."""
    return _find_ffprobe()


def find_capture_ffmpeg(ffprobe_path: Optional[str] = None) -> Optional[str]:
    """Return the FFmpeg path required for strict capture clip decoding."""
    if ffprobe_path:
        probe = Path(ffprobe_path)
        sibling = probe.with_name(f"ffmpeg{probe.suffix}")
        if sibling.is_file():
            return str(sibling)
    try:
        from server.utils.gpu_detection import find_ffmpeg
        return find_ffmpeg()
    except Exception:
        return shutil.which("ffmpeg")


def validate_capture_clip_file(clip_path: str, segment_ids: list[str] | None = None) -> dict[str, Any]:
    """Validate one captured clip with ffprobe for capture and recovery flows."""
    path = Path(clip_path)
    ffprobe = _find_ffprobe()
    normalized_segment_ids = [str(segment_id) for segment_id in (segment_ids or []) if segment_id]
    if not ffprobe:
        return {
            "path": str(path),
            "valid": False,
            "size_bytes": path.stat().st_size if path.exists() else 0,
            "duration_seconds": None,
            "errors": ["ffprobe not found"],
            "segment_ids": normalized_segment_ids,
            "ffprobe_path": None,
        }

    result = validate_output_file(str(path), ffprobe_path=ffprobe)
    result["segment_ids"] = normalized_segment_ids
    result["ffprobe_path"] = ffprobe
    return result


def _sanitize_filename(name: str) -> str:
    """Sanitize a string for safe use as a filename component.

    Strips path separators, special characters, and limits length to
    prevent path traversal or command injection.
    """
    sanitized = _SAFE_FILENAME_RE.sub("_", name or "clip")
    return (sanitized[:_MAX_FILENAME_LENGTH] or "clip")


def _format_race_time(seconds: float) -> str:
    """Format seconds as M:SS or H:MM:SS."""
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def _interruptible_sleep(
    seconds: float,
    cancelled_fn: Callable[[], bool],
    *,
    _now: Callable[[], float] = time.monotonic,
    _sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Sleep for *seconds*, checking cancellation every 0.25s.

    *_now* and *_sleep* are injectable for testing so that a fake clock
    can drive the loop without relying on wall-clock time.
    """
    deadline = _now() + seconds
    while _now() < deadline:
        if cancelled_fn():
            break
        remaining = deadline - _now()
        _sleep(min(0.25, remaining))


# ── Hotkey recorder adapter (OBS / ShadowPlay / ReLive) ─────────────────────

class HotkeyRecorderAdapter:
    """Recording backend that drives OBS Studio, NVIDIA ShadowPlay, or AMD
    ReLive via configurable keyboard hotkeys.

    Implements the same duck-typed interface as ``CaptureEngine``
    (``start_recording`` / ``stop_recording``) so it can be passed directly
    to :class:`ScriptCaptureEngine`.

    After the stop hotkey is sent, :meth:`stop_recording` polls
    *watch_folder* for a new video file that appeared since recording started,
    waits for the file size to stabilise (indicating the capture software has
    finished writing), then moves (renames) it to the *target_path* that was
    given to :meth:`start_recording`.

    Args:
        watch_folder: Directory where the capture software writes its output.
        start_hotkey: Hotkey string sent to begin recording, e.g. ``"F9"``.
        stop_hotkey: Hotkey string sent to stop recording.  May equal
            *start_hotkey* for toggle-style software like OBS.
        poll_timeout: Maximum seconds to wait for the output file after
            sending the stop hotkey (default 30 s).
        stable_checks: Number of consecutive stable-size polls required
            before treating the file as fully written (default 3).
        _sleep: Sleep function — inject ``FakeClock.sleep`` in tests.
        _wall_time: Wall-clock function — inject ``FakeClock.wall`` in tests.
    """

    is_running: bool = True  # always ready; matches CaptureEngine attribute

    def __init__(
        self,
        watch_folder: str,
        start_hotkey: str,
        stop_hotkey: str,
        poll_timeout: float = 30.0,
        stable_checks: int = OBS_STABLE_CHECKS,
        cancelled_fn: Optional[Callable[[], bool]] = None,
        _sleep: Callable[[float], None] = time.sleep,
        _wall_time: Callable[[], float] = time.time,
    ) -> None:
        self._watch_folder = watch_folder
        self._start_hotkey = start_hotkey
        self._stop_hotkey = stop_hotkey
        self._poll_timeout = poll_timeout
        self._stable_checks = stable_checks
        self._cancelled_fn = cancelled_fn or (lambda: False)
        self._sleep = _sleep
        self._wall_time = _wall_time
        self._target_path: Optional[str] = None
        self._recording_started_at: float = 0.0
        self.last_error: str | None = None

    # -- CaptureEngine-compatible interface ----------------------------------

    def start_recording(self, target_path: str, **_kwargs) -> None:
        """Send the start hotkey and record the current wall-clock timestamp."""
        self._target_path = target_path
        self._recording_started_at = self._wall_time()
        if platform.system() == "Windows":
            from server.utils.obs_integration import send_hotkey
            sent = send_hotkey(self._start_hotkey)
            if not sent:
                raise RuntimeError(f"Start hotkey '{self._start_hotkey}' could not be sent")
        else:
            logger.info(
                "[HotkeyRecorder] (non-Windows) Would send start hotkey: %s",
                self._start_hotkey,
            )

    def stop_recording(self) -> bool:
        """Send the stop hotkey, then poll the watch folder for the output file
        and move it to the target path that was set by :meth:`start_recording`.
        """
        if platform.system() == "Windows":
            from server.utils.obs_integration import send_hotkey
            if not send_hotkey(self._stop_hotkey):
                self.last_error = f"Stop hotkey '{self._stop_hotkey}' could not be sent"
                return False
        else:
            logger.info(
                "[HotkeyRecorder] (non-Windows) Would send stop hotkey: %s",
                self._stop_hotkey,
            )

        if self._target_path:
            ok = self._poll_and_move(self._target_path)
            if not ok:
                if self._cancelled_fn():
                    logger.info("[HotkeyRecorder] Poll cancelled by user")
                else:
                    self.last_error = f"No completed recording appeared in {self._poll_timeout:g}s after stop hotkey"
                    logger.error(
                        "[HotkeyRecorder] Timed out - clip may not have been saved to %s",
                        self._target_path,
                    )
            return ok
        return True


    def _poll_and_move(self, target_path: str) -> bool:
        """Poll *watch_folder* for a new stable video file and move it.

        Returns True if a file was successfully moved to *target_path*.
        """
        from server.utils.obs_integration import get_recent_video_files

        # Scan for files created no earlier than OBS_PRE_HOTKEY_TOLERANCE
        # seconds before the start hotkey (accommodates timestamp fuzz).
        since = self._recording_started_at - OBS_PRE_HOTKEY_TOLERANCE
        deadline = self._wall_time() + self._poll_timeout

        # Track per-file size and stability counter
        last_size: dict[str, int] = {}
        stable_count: dict[str, int] = {}

        logger.info(
            "[HotkeyRecorder] Polling '%s' for new clip (timeout=%gs)...",
            self._watch_folder,
            self._poll_timeout,
        )

        while self._wall_time() < deadline:
            if self._cancelled_fn():
                logger.info("[HotkeyRecorder] Poll cancelled before file detection")
                return False

            slept = 0.0
            while slept < OBS_POLL_INTERVAL:
                if self._cancelled_fn():
                    logger.info("[HotkeyRecorder] Poll cancelled while waiting")
                    return False
                slice_s = min(0.25, OBS_POLL_INTERVAL - slept)
                self._sleep(slice_s)
                slept += slice_s

            new_files = get_recent_video_files(self._watch_folder, since)
            for f in new_files:
                path = f["path"]
                size = f["size_bytes"]
                prev = last_size.get(path, -1)

                if size > 0 and size == prev:
                    stable_count[path] = stable_count.get(path, 0) + 1
                    if stable_count[path] >= self._stable_checks:
                        # File is fully written - move to target
                        try:
                            Path(target_path).parent.mkdir(parents=True, exist_ok=True)
                            shutil.move(path, target_path)
                            logger.info(
                                "[HotkeyRecorder] Clip ready: %s -> %s",
                                Path(path).name, target_path,
                            )
                            return True
                        except OSError as exc:
                            logger.error(
                                "[HotkeyRecorder] Failed to move clip: %s", exc
                            )
                            return False
                else:
                    last_size[path] = size
                    stable_count[path] = 0

        logger.warning(
            "[HotkeyRecorder] Timed out (%gs) waiting for clip in '%s'",
            self._poll_timeout, self._watch_folder,
        )
        return False


class ObsWebSocketRecorderAdapter(HotkeyRecorderAdapter):
    """OBS recorder that verifies recording state through OBS WebSocket v5."""

    def __init__(self, watch_folder: str, host: str, port: int, password: str, **kwargs: Any) -> None:
        super().__init__(watch_folder=watch_folder, start_hotkey="", stop_hotkey="", **kwargs)
        from server.utils.obs_websocket import ObsWebSocketClient

        self._obs = ObsWebSocketClient(host=host, port=port, password=password)

    def start_recording(self, target_path: str, **_kwargs) -> None:
        self._target_path = target_path
        self._recording_started_at = self._wall_time()
        status = self._obs.get_record_status()
        if status.get("outputActive"):
            raise RuntimeError("OBS is already recording; stop it before scripted capture")
        self._obs.request("StartRecord")
        if not self._obs.wait_for_recording_state(True):
            raise RuntimeError("OBS did not confirm that recording started")

    def stop_recording(self) -> bool:
        try:
            status = self._obs.get_record_status()
            if not status.get("outputActive"):
                self.last_error = "OBS reported that recording was already stopped"
                return False
            stop_response = self._obs.request("StopRecord")
            if not self._obs.wait_for_recording_state(False):
                self.last_error = "OBS did not confirm that recording stopped"
                return False
            if not self._target_path:
                self.last_error = "No target path was set for the OBS recording"
                return False
            output_path = str(stop_response.get("outputPath") or "").strip()
            if output_path:
                logger.info("[ObsWebSocketRecorder] OBS reported completed output: %s", output_path)
                ok = self._wait_for_output_and_move(output_path, self._target_path)
            else:
                logger.warning(
                    "[ObsWebSocketRecorder] OBS StopRecord returned no outputPath; "
                    "falling back to watch-folder scan"
                )
                ok = self._poll_and_move(self._target_path)
            if not ok:
                source = output_path or self._watch_folder
                self.last_error = (
                    f"OBS stopped but output did not stabilize within {self._poll_timeout:g}s: {source}"
                )
            return ok
        except Exception as exc:
            self.last_error = str(exc)
            return False

    def close(self) -> None:
        self._obs.close()

    def _wait_for_output_and_move(self, source_path: str, target_path: str) -> bool:
        """Wait for OBS's authoritative output path to finish writing, then move it."""
        source = Path(source_path)
        deadline = self._wall_time() + self._poll_timeout
        last_size = -1
        stable_count = 0

        while self._wall_time() < deadline:
            if self._cancelled_fn():
                return False
            if source.exists() and source.is_file():
                try:
                    size = source.stat().st_size
                except OSError:
                    size = 0
                if size > 0 and size == last_size:
                    stable_count += 1
                    if stable_count >= self._stable_checks:
                        try:
                            Path(target_path).parent.mkdir(parents=True, exist_ok=True)
                            shutil.move(str(source), target_path)
                            logger.info(
                                "[ObsWebSocketRecorder] Clip ready: %s -> %s",
                                source.name,
                                target_path,
                            )
                            return True
                        except OSError as exc:
                            self.last_error = f"Failed to move OBS output: {exc}"
                            return False
                else:
                    last_size = size
                    stable_count = 0
            self._sleep(OBS_POLL_INTERVAL)
        return False


# ── Main Engine ─────────────────────────────────────────────────────────────

class ScriptCaptureEngine:
    """Capture engine that processes a Video Composition Script segment by
    segment, producing individual clips and then compiling them into a
    final highlight video.

    This class coordinates the iRacing bridge (for replay/camera control)
    and a recorder backend (for recording), supporting two modes:

    - **Native (LRS)**: pass a ``CaptureEngine`` instance — the engine writes
      directly to the given output path.
    - **Hotkey (OBS/ShadowPlay/ReLive)**: pass a :class:`HotkeyRecorderAdapter`
      — hotkeys drive the capture software; the adapter polls the watch folder
      for the output file and renames it into the project directory.

    Key features:
    - **Validation**: Every seek/camera/driver command is verified via
      iRacing telemetry readback before proceeding.
    - **Retry with cooldown**: Failed commands are retried up to a
      configurable number of times with cooldown between attempts.
    - **Gap detection**: Consecutive segments with overlapping or nearly
      contiguous timing share a single recording pass.  Only actual gaps
      trigger stop/start of recording.
    - **Intra-segment scheduling**: Camera and driver switches within a
      segment are fired at their exact ``offset_seconds`` *during* playback
      via :meth:`_wait_with_schedule`, not after the segment finishes.
    - **Structured logging**: Every command sent, validation result, retry,
      and failure is recorded in a structured capture log.
    - **Clip management**: Each clip is named descriptively with section,
      event type, and driver info.  A manifest links clip files to script
      segments.
    - **Clock injection**: Pass ``_now`` and ``_sleep`` for deterministic
      unit testing without real wall-clock delays.
    """

    def __init__(
        self,
        output_dir: str,
        clip_padding: float = DEFAULT_CLIP_PADDING,
        clip_padding_after: float = DEFAULT_CLIP_PADDING_AFTER,
        progress_callback: Optional[Callable[[dict], None]] = None,
        compile_timeout: int = 0,
        contiguous_gap_threshold: float = CONTIGUOUS_GAP_THRESHOLD,
        capture_mode: str = "native",
        validate_clips: bool = False,
        retry_failed_clip_validation: bool = False,
        clip_validation_retry_limit: int = 0,
        _now: Optional[Callable[[], float]] = None,
        _sleep: Optional[Callable[[float], None]] = None,
    ) -> None:
        """
        Args:
            output_dir: Directory to write clip files.
            clip_padding: Seconds of pre-roll before each clip.
            clip_padding_after: Seconds of post-roll after each clip.
            progress_callback: Optional callable for progress events.
            compile_timeout: Timeout in seconds for the FFmpeg compile step.
                0 = auto-calculated from clip count.
            contiguous_gap_threshold: Max gap in seconds to treat consecutive
                segments as contiguous (keeps recording running).
            capture_mode: Informational label for the recording backend being
                used — ``"native"`` (LRS built-in), ``"obs"``, ``"shadowplay"``,
                ``"relive"``, or ``"manual"``.  Only affects log messages; the
                actual backend is determined by whichever recorder object is
                passed to :meth:`capture_script`.
            validate_clips: Run one final metadata-and-decode validation audit
                after the requested capture pass completes.
            retry_failed_clip_validation: Delete invalid clips and recapture
                their segments when validation fails.
            clip_validation_retry_limit: Number of validation-recapture passes
                allowed after the first capture pass.
            _now: Monotonic clock function.  Defaults to ``time.monotonic``.
                Inject a fake for unit tests (see :class:`FakeClock`).
            _sleep: Sleep function.  Defaults to ``time.sleep``.  Inject a
                fake for unit tests.
        """
        self._output_dir = Path(output_dir)
        self._output_dir.mkdir(parents=True, exist_ok=True)
        self._clip_padding = clip_padding
        self._clip_padding_after = clip_padding_after
        self._progress_cb = progress_callback
        self._compile_timeout = compile_timeout
        self._contiguous_gap_threshold = contiguous_gap_threshold
        self._capture_mode = capture_mode
        self._validate_clips = bool(validate_clips)
        self._retry_failed_clip_validation = bool(retry_failed_clip_validation)
        self._clip_validation_retry_limit = max(0, int(clip_validation_retry_limit or 0))
        self._now: Callable[[], float] = _now or time.monotonic
        self._sleep: Callable[[float], None] = _sleep or time.sleep
        self._clips: list[dict] = []
        self._composition_manifest: list[dict] = []
        self._capture_log: list[CaptureLogEntry] = []
        self._cancelled = False
        self._segment_strategies: list[dict] = []
        self._segment_lookup: dict[str, dict] = {}
        self._segment_order_lookup: dict[str, int] = {}

    # -- Public API ---------------------------------------------------------

    def cancel(self) -> None:
        """Signal the capture loop to stop."""
        self._cancelled = True

    @property
    def clips(self) -> list[dict]:
        """Return list of captured clip metadata."""
        return list(self._clips)

    @property
    def capture_log(self) -> list[dict]:
        """Return the structured capture log as a list of dicts."""
        return [entry.to_dict() for entry in self._capture_log]

    @property
    def composition_manifest(self) -> list[dict]:
        """Return a per-segment manifest with source offsets for Compose."""
        return list(self._composition_manifest)

    @property
    def segment_strategies(self) -> list[dict]:
        """Return strategy info for each segment (for UI progress display)."""
        return list(self._segment_strategies)

    def capture_script(
        self,
        script: list[dict],
        iracing_bridge: Any,
        capture_engine: Any,
        available_cameras: Optional[list[dict]] = None,
    ) -> list[dict]:
        """Process every segment in *script*, capturing clips.

        Uses gap detection to merge contiguous segments into single recording
        passes, and validates all iRacing commands with retry loops.

        Returns:
            List of clip dicts [{id, path, section, order, duration, segments}, ...].
        """
        self._cancelled = False
        self._clips = []
        self._composition_manifest = []
        self._capture_log = []
        self._segment_strategies = []

        # Filter out non-capturable markers (transition/bridge) and zero-duration segments.
        active_segments = [
            s for s in script
            if s.get("type") not in {"transition", "bridge"}
            and (s.get("end_time_seconds", 0) - s.get("start_time_seconds", 0)) > 0
        ]
        self._segment_lookup = {
            str(s.get("id", s.get("segment_id", ""))): s
            for s in active_segments
            if str(s.get("id", s.get("segment_id", "")))
        }
        self._segment_order_lookup = {
            str(s.get("id", s.get("segment_id", ""))): idx
            for idx, s in enumerate(active_segments)
            if str(s.get("id", s.get("segment_id", "")))
        }
        total = len(active_segments)
        if total == 0:
            return []

        self._log_entry("", "info",
            f"Starting script capture: {total} segments "
            f"[mode={self._capture_mode}]")

        retry_pass = 0
        segments_for_pass = active_segments

        while segments_for_pass and not self._cancelled:
            self._capture_segment_pass(
                segments_for_pass,
                iracing_bridge,
                capture_engine,
                available_cameras=available_cameras,
                pass_index=retry_pass,
            )

            if not self._validate_clips or self._cancelled:
                break

            validation = self._validate_all_clips()
            failed = validation.get("failed") or []
            if not failed:
                break

            failed_segment_ids: list[str] = []
            for item in failed:
                failed_segment_ids.extend(str(s) for s in item.get("segment_ids", []) if s)

            if (
                not self._retry_failed_clip_validation
                or retry_pass >= self._clip_validation_retry_limit
            ):
                self._fail_capture(
                    ",".join(failed_segment_ids[:3]),
                    "clip_validation",
                    (
                        f"Final validation failed for {len(failed)} clip(s); "
                        "capture retry is disabled or retry limit was reached"
                    ),
                    {
                        "failed": failed,
                        "retry_enabled": self._retry_failed_clip_validation,
                        "retry_limit": self._clip_validation_retry_limit,
                        "retry_pass": retry_pass,
                    },
                )

            retry_pass += 1
            self._remove_failed_validation_outputs(failed)
            seen: set[str] = set()
            segments_for_pass = []
            for seg_id in failed_segment_ids:
                if seg_id in seen:
                    continue
                seen.add(seg_id)
                segment = self._segment_lookup.get(seg_id)
                if segment:
                    segments_for_pass.append(segment)

            self._emit_progress({
                "step": "clip_validation_retry",
                "failed": failed,
                "failed_segment_ids": list(seen),
                "retry_pass": retry_pass,
                "retry_limit": self._clip_validation_retry_limit,
                "message": (
                    f"Recapturing {len(segments_for_pass)} segment(s) after "
                    "final validation failure"
                ),
            })

        # Final progress
        self._emit_progress({
            "step": "capture_complete",
            "clips_captured": len(self._clips),
            "message": f"Captured {len(self._clips)} clips from {total} segments",
            "capture_log": self.capture_log,
        })

        return list(self._clips)

    def _capture_segment_pass(
        self,
        active_segments: list[dict],
        iracing_bridge: Any,
        capture_engine: Any,
        *,
        available_cameras: Optional[list[dict]] = None,
        pass_index: int = 0,
    ) -> None:
        """Capture one pass of segments using the gap-aware recording loop."""
        total = len(active_segments)
        if total == 0:
            return

        if available_cameras is None:
            available_cameras = getattr(iracing_bridge, "cameras", []) or []

        cam_name_to_num = {
            c["group_name"]: c["group_num"]
            for c in available_cameras
        }

        strategies = self._compute_strategies(active_segments)
        if pass_index == 0:
            self._segment_strategies = strategies
        else:
            self._segment_strategies.extend({
                **strategy,
                "validation_retry_pass": pass_index,
            } for strategy in strategies)

        self._emit_progress({
            "step": "strategy_computed",
            "strategies": self._segment_strategies,
            "total_segments": total,
            "capture_mode": self._capture_mode,
            "validation_retry_pass": pass_index,
            "message": (
                f"Computed capture strategy for {total} segment(s)"
                if pass_index == 0
                else f"Computed validation-retry capture strategy for {total} segment(s)"
            ),
        })

        recording = False
        current_clip_path: Optional[str] = None
        current_clip_segments: list[str] = []
        current_clip_segment_defs: list[dict] = []
        clip_start_time: float = 0
        clip_capture_start_time: float = 0

        for idx, segment in enumerate(active_segments):
            if self._cancelled:
                self._log_entry("", "info", f"Cancelled at segment {idx + 1}/{total}")
                break

            seg_id = segment.get("id", f"seg_{idx:03d}")
            section = segment.get("section", "race")
            seg_type = segment.get("type", "event")
            start = segment.get("start_time_seconds", 0)
            end = segment.get("end_time_seconds", start + 5)
            duration = end - start
            strategy = strategies[idx] if idx < len(strategies) else {}
            is_contiguous_with_prev = strategy.get("contiguous_with_prev", False)
            is_contiguous_with_next = strategy.get("contiguous_with_next", False)

            pct = round(((idx + 0.5) / total) * 100, 1)
            self._emit_progress({
                "step": "capturing",
                "segment_index": idx,
                "segment_total": total,
                "segment_id": seg_id,
                "section": section,
                "segment_type": seg_type,
                "strategy": strategy,
                "validation_retry_pass": pass_index,
                "percentage": pct,
                "message": f"Segment {idx + 1}/{total}: {section}/{seg_id}",
            })

            if is_contiguous_with_prev and recording:
                self._log_entry(seg_id, "info",
                    "Contiguous with previous - continuing recording")

                self._apply_camera_and_driver(
                    segment, iracing_bridge, cam_name_to_num, available_cameras
                )
                current_clip_segments.append(seg_id)
                current_clip_segment_defs.append(segment)

                self._log_entry(seg_id, "info",
                    f"Waiting {duration:.1f}s for segment duration")
                self._wait_with_schedule(
                    duration, 0.0, segment, iracing_bridge, cam_name_to_num
                )

            else:
                if recording:
                    recording = self._stop_and_save_clip(
                        capture_engine, iracing_bridge, current_clip_path,
                        current_clip_segments, current_clip_segment_defs,
                        clip_start_time, clip_capture_start_time, idx - 1,
                        section
                    )

                self._log_entry(seg_id, "seek", "Priming replay at 1x for seek")
                iracing_bridge.set_replay_speed(1)
                self._sleep(0.35)

                padding = segment.get("clip_padding", self._clip_padding)
                seek_target_s = max(0, start - padding)
                seek_ok = self._validated_seek(
                    seg_id, iracing_bridge, seek_target_s, segment
                )
                if not seek_ok:
                    self._fail_capture(
                        seg_id,
                        "seek",
                        f"Seek validation failed for segment '{seg_id}' after {MAX_SEEK_RETRIES} retries",
                        {
                            "max_seek_retries": MAX_SEEK_RETRIES,
                            "seek_target_s": seek_target_s,
                        },
                    )

                self._log_entry(seg_id, "seek", "Pausing replay after seek")
                iracing_bridge.set_replay_speed(0)
                self._sleep(0.2)

                self._apply_camera_and_driver(
                    segment, iracing_bridge, cam_name_to_num, available_cameras
                )

                order_idx = self._segment_order_lookup.get(str(seg_id), idx)
                clip_name = self._build_clip_name(seg_id, section, seg_type, segment, order_idx)
                if pass_index > 0:
                    clip_name = f"{clip_name}_retry{pass_index}"
                current_clip_path = str(self._output_dir / f"{clip_name}.mp4")
                current_clip_segments = [seg_id]
                current_clip_segment_defs = [segment]
                clip_start_time = start
                clip_capture_start_time = seek_target_s

                try:
                    capture_engine.start_recording(current_clip_path, mode="auto")
                    self._log_entry(seg_id, "record_start",
                        f"Recording started [{self._capture_mode}] -> "
                        f"{Path(current_clip_path).name}")
                    recording = True
                except Exception as exc:
                    self._fail_capture(seg_id, "record_start", f"Recording start failed: {exc}")

                iracing_bridge.set_replay_speed(1)
                self._log_entry(seg_id, "info", "Replay resumed at 1x")

                padding = self._clip_padding
                wait_seconds = duration + padding
                self._log_entry(seg_id, "info",
                    f"Waiting {wait_seconds:.1f}s "
                    f"(duration {duration:.1f}s + padding {padding:.1f}s)")
                self._wait_with_schedule(
                    wait_seconds, padding, segment, iracing_bridge, cam_name_to_num
                )

            if not is_contiguous_with_next or idx == total - 1:
                if recording:
                    post_padding = self._clip_padding_after
                    if post_padding > 0:
                        self._log_entry(seg_id, "info",
                            f"Waiting {post_padding:.1f}s post-padding")
                        _interruptible_sleep(
                            post_padding, lambda: self._cancelled,
                            _now=self._now, _sleep=self._sleep,
                        )

                    order_idx = self._segment_order_lookup.get(str(seg_id), idx)
                    recording = self._stop_and_save_clip(
                        capture_engine, iracing_bridge, current_clip_path,
                        current_clip_segments, current_clip_segment_defs,
                        clip_start_time, clip_capture_start_time, order_idx, section
                    )

    def _fail_capture(
        self,
        seg_id: str,
        action: str,
        reason: str,
        extra: Optional[dict] = None,
    ) -> None:
        """Log and raise a structured capture-abort error with comms-log entry."""
        payload = {
            "segment_id": seg_id,
            "action": action,
            "reason": reason,
            **(extra or {}),
        }
        self._log_entry(seg_id, "error", f"{action} abort: {reason}", success=False, extra=payload)
        command_log.record("capture-abort", payload, result="error", source="script_capture")
        raise CaptureAbortError(seg_id, action, reason, extra)

    def compile_clips(self, output_path: str) -> Optional[str]:
        """Concatenate all captured clips into a single video file.

        Uses FFmpeg concat demuxer for lossless joining of clips that
        share the same codec/resolution.
        """
        if not self._clips:
            self._log_entry("", "error", "No clips to compile")
            return None

        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            self._log_entry("", "error", "FFmpeg not found")
            return None

        self._emit_progress({
            "step": "compiling",
            "message": "Compiling clips into final video...",
        })
        self._log_entry("", "info",
            f"Compiling {len(self._clips)} clips -> {Path(output_path).name}")

        sorted_clips = sorted(self._clips, key=lambda c: c["order"])

        concat_list = self._output_dir / "_concat_list.txt"
        with open(concat_list, "w") as f:
            for clip in sorted_clips:
                safe_path = Path(clip["path"]).as_posix()
                f.write(f"file '{safe_path}'\n")

        cmd = [
            ffmpeg, "-hide_banner", "-loglevel", "warning", "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(concat_list),
            "-c", "copy",
            output_path,
        ]

        try:
            timeout = self._compile_timeout
            if timeout <= 0:
                timeout = max(_MIN_COMPILE_TIMEOUT, len(sorted_clips) * _COMPILE_SECONDS_PER_CLIP)
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            if result.returncode != 0:
                self._log_entry("", "error",
                    f"Compile failed: {result.stderr[:500]}", success=False)
                return None
        except subprocess.TimeoutExpired:
            self._log_entry("", "error", "Compile timed out", success=False)
            return None
        except Exception as exc:
            self._log_entry("", "error", f"Compile error: {exc}", success=False)
            return None

        try:
            concat_list.unlink()
        except OSError:
            pass

        self._log_entry("", "info",
            f"Compiled {len(sorted_clips)} clips -> {output_path}")

        self._emit_progress({
            "step": "compile_complete",
            "output_path": output_path,
            "message": "Video compilation complete",
            "capture_log": self.capture_log,
        })

        return output_path

    # -- Strategy computation -----------------------------------------------

    def _compute_strategies(self, segments: list[dict]) -> list[dict]:
        """Pre-compute the capture strategy for each segment.

        Determines whether each segment is contiguous with its neighbours,
        which controls whether recording continues or is stopped/restarted.
        """
        strategies = []
        for idx, seg in enumerate(segments):
            start = seg.get("start_time_seconds", 0)
            end = seg.get("end_time_seconds", start + 5)
            duration = end - start

            contiguous_with_prev = False
            contiguous_with_next = False

            if idx > 0:
                prev = segments[idx - 1]
                prev_end = prev.get("end_time_seconds", 0)
                gap = start - prev_end
                contiguous_with_prev = gap <= self._contiguous_gap_threshold

            if idx < len(segments) - 1:
                nxt = segments[idx + 1]
                nxt_start = nxt.get("start_time_seconds", 0)
                gap = nxt_start - end
                contiguous_with_next = gap <= self._contiguous_gap_threshold

            has_camera_schedule = bool(seg.get("camera_schedule"))

            strategy = {
                "segment_id": seg.get("id", f"seg_{idx:03d}"),
                "section": seg.get("section", "race"),
                "type": seg.get("type", "event"),
                "event_type": seg.get("event_type", ""),
                "start_time": start,
                "end_time": end,
                "duration": round(duration, 2),
                "contiguous_with_prev": contiguous_with_prev,
                "contiguous_with_next": contiguous_with_next,
                "has_camera_schedule": has_camera_schedule,
                "strategy": "continue" if contiguous_with_prev else "new_recording",
                "drivers": seg.get("driver_names", []),
            }
            strategies.append(strategy)

        return strategies

    # -- Validation/retry helpers -------------------------------------------

    def _race_session_num(self, iracing_bridge: Any) -> int:
        """Return the replay session index whose type/name looks like Race."""
        try:
            sessions = iracing_bridge.session_data.get("sessions", [])
        except Exception:
            sessions = []

        for session_info in sessions:
            label = f"{session_info.get('type', '')} {session_info.get('name', '')}".lower()
            if "race" in label:
                try:
                    return int(session_info.get("index", -1))
                except (TypeError, ValueError):
                    return -1
        return -1

    def _seek_measurement(
        self,
        iracing_bridge: Any,
        expected_session: int,
        target_ms: int,
        timeout_s: float = SEEK_SETTLE_TIMEOUT,
    ) -> Optional[dict]:
        """Poll telemetry after a replay seek and return the best readback.

        replay_search_session_time() can return before ReplaySessionNum and
        SessionTime have fully settled, especially when jumping between
        qualifying and race. Prefer an in-session, in-tolerance snapshot, but
        keep the best observed snapshot for logging and retry decisions.
        """
        deadline = self._now() + max(0.0, timeout_s)
        best: Optional[dict] = None

        while True:
            if self._cancelled:
                return best

            snapshot = iracing_bridge.capture_snapshot()
            if snapshot:
                actual_ms = int((snapshot.get("session_time") or 0.0) * 1000)
                drift_ms = abs(actual_ms - target_ms)
                replay_session_num = snapshot.get("replay_session_num")
                try:
                    replay_session_num = int(replay_session_num) if replay_session_num is not None else None
                except (TypeError, ValueError):
                    replay_session_num = None

                session_matches = replay_session_num is None or replay_session_num == expected_session
                seek_valid = drift_ms <= SEEK_TOLERANCE_MS and session_matches
                measurement = {
                    "snapshot": snapshot,
                    "actual_ms": actual_ms,
                    "drift_ms": drift_ms,
                    "replay_session_num": replay_session_num,
                    "session_matches": session_matches,
                    "seek_valid": seek_valid,
                }

                if (
                    best is None
                    or (measurement["session_matches"] and not best["session_matches"])
                    or (
                        measurement["session_matches"] == best["session_matches"]
                        and measurement["drift_ms"] < best["drift_ms"]
                    )
                ):
                    best = measurement

                if seek_valid:
                    return measurement

            if self._now() >= deadline:
                return best

            _interruptible_sleep(
                min(SEEK_SETTLE_POLL, max(0.0, deadline - self._now())),
                lambda: self._cancelled,
                _now=self._now,
                _sleep=self._sleep,
            )

    def _find_best_session_for_target(
        self,
        seg_id: str,
        iracing_bridge: Any,
        target_time_s: float,
    ) -> int:
        """Probe available sessions to find which one contains the target time.
        
        Returns the in-tolerance session number with the smallest drift, or 0 if
        none validate. Large-drift probes are useful diagnostics, but they are
        not valid session resolutions.
        """
        target_ms = max(0, int(target_time_s * 1000))
        session_data = iracing_bridge.session_data
        available_sessions = session_data.get("sessions", [])
        
        if not available_sessions:
            self._log_entry(seg_id, "seek",
                "No available sessions in replay - defaulting to session 0")
            return 0
        
        best_session = 0
        best_drift = float('inf')
        closest_session = 0
        closest_drift = float('inf')
        
        # Probe each available session
        for session_info in available_sessions:
            session_idx = session_info.get("index", 0)
            session_type = session_info.get("type", "")
            
            # Try seeking to this session + target time
            if not iracing_bridge.replay_search_session_time(session_idx, target_ms):
                continue
            
            measurement = self._seek_measurement(
                iracing_bridge,
                session_idx,
                target_ms,
                timeout_s=SEEK_SETTLE_TIMEOUT,
            )
            if measurement:
                actual_ms = measurement["actual_ms"]
                drift_ms = measurement["drift_ms"]
                replay_session_num = measurement["replay_session_num"]
                session_matches = measurement["session_matches"]
                effective_drift_ms = drift_ms if session_matches else float("inf")
                
                command_log.record(
                    "session-probe",
                    {
                        "segment_id": seg_id,
                        "session_num": session_idx,
                        "session_type": session_type,
                        "target_ms": target_ms,
                        "actual_ms": actual_ms,
                        "drift_ms": drift_ms,
                        "replay_session_num": replay_session_num,
                        "session_matches": session_matches,
                        "seek_valid": measurement["seek_valid"],
                    },
                    source="script_capture",
                )
                
                self._log_entry(seg_id, "seek",
                    f"Session probe: session={session_idx} ({session_type}) "
                    f"landed={replay_session_num} drift={drift_ms}ms",
                    extra={
                        "session_idx": session_idx,
                        "replay_session_num": replay_session_num,
                        "session_matches": session_matches,
                        "drift_ms": drift_ms,
                        "seek_valid": measurement["seek_valid"],
                    })
                
                if drift_ms < closest_drift:
                    closest_drift = drift_ms
                    closest_session = session_idx

                if measurement["seek_valid"] and effective_drift_ms < best_drift:
                    best_drift = effective_drift_ms
                    best_session = session_idx
        
        if best_drift == float('inf'):
            self._log_entry(seg_id, "seek",
                "Session probe found no in-tolerance session - defaulting to 0",
                extra={
                    "closest_session": closest_session,
                    "closest_drift": closest_drift if closest_drift != float('inf') else None,
                })
            return 0
        
        self._log_entry(seg_id, "seek",
            f"Selected session {best_session} (drift={best_drift}ms)",
            extra={"selected_session": best_session, "best_drift": best_drift})
        
        # Seek to the best session one more time to land on it
        iracing_bridge.replay_search_session_time(best_session, target_ms)
        self._seek_measurement(iracing_bridge, best_session, target_ms)
        
        return best_session

    def _validated_seek(
        self,
        seg_id: str,
        iracing_bridge: Any,
        target_time_s: float,
        segment: Optional[dict] = None,
    ) -> bool:
        """Seek to target_time_s and validate via telemetry readback.

        Returns True if seek was validated within tolerance.
        
        If segment dict is provided and has session_num, uses it directly.
        Otherwise falls back to current replay session or probing.
        """
        target_ms = max(0, int(target_time_s * 1000))
        
        # First: check if segment has explicit session_num from script metadata
        session_num = segment.get("session_num", -1) if segment else -1
        if session_num >= 0:
            self._log_entry(seg_id, "seek",
                f"Using segment session_num={session_num} from script metadata")
            if segment:
                section = str(segment.get("section", "")).lower()
                seg_type = str(segment.get("type", "")).lower()
                if seg_type in {"broll", "bridge"} and section in {"intro", "qualifying_results", "race_results"}:
                    race_session_num = self._race_session_num(iracing_bridge)
                    if race_session_num >= 0 and race_session_num != session_num:
                        self._log_entry(
                            seg_id,
                            "seek",
                            f"Using race session {race_session_num} for production b-roll section '{section}'",
                            extra={
                                "metadata_session_num": session_num,
                                "race_session_num": race_session_num,
                                "section": section,
                            },
                        )
                        session_num = race_session_num
        else:
            # Fall back to current replay session
            session_num = iracing_bridge.get_replay_session_num()
            if session_num < 0:
                self._log_entry(seg_id, "seek",
                    "Replay session num unavailable - probing available sessions...")
                session_num = self._find_best_session_for_target(seg_id, iracing_bridge, target_time_s)

        resolved_session_once = False

        for attempt in range(1, MAX_SEEK_RETRIES + 1):
            if self._cancelled:
                return False
            self._log_entry(seg_id, "seek",
                f"Seeking to {_format_race_time(target_time_s)} "
                f"(session={session_num}, ms={target_ms})",
                extra={"attempt": attempt, "target_ms": target_ms})

            result = iracing_bridge.replay_search_session_time(session_num, target_ms)
            command_log.record(
                "seek-session-time-attempt",
                {
                    "segment_id": seg_id,
                    "attempt": attempt,
                    "session_num": session_num,
                    "target_ms": target_ms,
                    "command_result": bool(result),
                },
                source="script_capture",
            )
            if not result:
                self._log_entry(seg_id, "seek",
                    "Seek command returned False",
                    success=False, attempt=attempt)
                _interruptible_sleep(
                    SEEK_COOLDOWN, lambda: self._cancelled,
                    _now=self._now, _sleep=self._sleep,
                )
                continue

            measurement = self._seek_measurement(iracing_bridge, session_num, target_ms)
            if measurement:
                snapshot = measurement["snapshot"]
                actual_ms = measurement["actual_ms"]
                drift_ms = measurement["drift_ms"]
                replay_session_num = measurement["replay_session_num"]
                session_matches = measurement["session_matches"]
                seek_valid = measurement["seek_valid"]
                command_log.record(
                    "seek-session-time-validate",
                    {
                        "segment_id": seg_id,
                        "attempt": attempt,
                        "target_ms": target_ms,
                        "actual_ms": actual_ms,
                        "drift_ms": drift_ms,
                        "replay_speed": snapshot.get("replay_speed"),
                        "replay_frame": snapshot.get("replay_frame"),
                        "replay_session_num": replay_session_num,
                        "session_matches": session_matches,
                    },
                    result="ok" if seek_valid else ("session_mismatch" if not session_matches else "drift"),
                    source="script_capture",
                )

                self._log_entry(seg_id, "validate",
                    f"Seek validation: target={target_ms}ms actual={actual_ms}ms "
                    f"drift={drift_ms}ms session={replay_session_num}",
                    success=seek_valid,
                    attempt=attempt,
                    expected=target_ms,
                    actual=actual_ms)

                if seek_valid:
                    return True

                if not resolved_session_once:
                    resolved_session_once = True
                    resolved_session = self._find_best_session_for_target(
                        seg_id,
                        iracing_bridge,
                        target_time_s,
                    )
                    if resolved_session != session_num:
                        self._log_entry(
                            seg_id,
                            "seek",
                            f"Resolved replay session {session_num} -> {resolved_session}",
                            extra={
                                "requested_session": session_num,
                                "resolved_session": resolved_session,
                                "landed_session": replay_session_num,
                                "drift_ms": drift_ms,
                            },
                        )
                        session_num = resolved_session
            else:
                command_log.record(
                    "seek-session-time-validate",
                    {
                        "segment_id": seg_id,
                        "attempt": attempt,
                        "target_ms": target_ms,
                        "error": "snapshot_unavailable",
                    },
                    result="error",
                    source="script_capture",
                )
                self._log_entry(seg_id, "validate",
                    "Could not read telemetry for seek validation",
                    success=False, attempt=attempt)

            if attempt < MAX_SEEK_RETRIES:
                self._log_entry(seg_id, "retry",
                    f"Retrying seek ({attempt}/{MAX_SEEK_RETRIES}), "
                    f"cooldown {SEEK_COOLDOWN}s")
                _interruptible_sleep(
                    SEEK_COOLDOWN, lambda: self._cancelled,
                    _now=self._now, _sleep=self._sleep,
                )

        return False

    def _validated_camera_switch(
        self,
        seg_id: str,
        iracing_bridge: Any,
        target_group_num: int,
        target_car_idx: Optional[int],
    ) -> bool:
        """Switch camera and validate via telemetry readback.

        Returns True if camera group was set correctly.
        """
        for attempt in range(1, MAX_CAMERA_RETRIES + 1):
            if self._cancelled:
                return False
            if target_car_idx is not None:
                self._log_entry(seg_id, "camera",
                    f"Switching camera: group={target_group_num} car_idx={target_car_idx}",
                    attempt=attempt,
                    extra={"group_num": target_group_num, "car_idx": target_car_idx})
                iracing_bridge.cam_switch_car(target_car_idx, target_group_num)
            else:
                self._log_entry(seg_id, "camera",
                    f"Switching camera: group={target_group_num} position=leader",
                    attempt=attempt,
                    extra={"group_num": target_group_num})
                iracing_bridge.cam_switch_position(0, target_group_num)

            _interruptible_sleep(
                0.3, lambda: self._cancelled,
                _now=self._now, _sleep=self._sleep,
            )

            # Validate via snapshot
            snapshot = iracing_bridge.capture_snapshot()
            if snapshot:
                actual_group = snapshot.get("cam_group_num", -1)
                actual_car = snapshot.get("cam_car_idx", -1)
                group_ok = actual_group == target_group_num
                driver_ok = (
                    target_car_idx is None
                    or actual_car == target_car_idx
                )

                self._log_entry(seg_id, "validate",
                    f"Camera validation: "
                    f"group expected={target_group_num} actual={actual_group} "
                    f"car_idx expected={target_car_idx} actual={actual_car}",
                    success=group_ok and driver_ok,
                    attempt=attempt,
                    expected={"group": target_group_num, "car_idx": target_car_idx},
                    actual={"group": actual_group, "car_idx": actual_car})

                if group_ok and driver_ok:
                    return True
            else:
                self._log_entry(seg_id, "validate",
                    "Could not read telemetry for camera validation",
                    success=False, attempt=attempt)

            if attempt < MAX_CAMERA_RETRIES:
                self._log_entry(seg_id, "retry",
                    f"Retrying camera switch ({attempt}/{MAX_CAMERA_RETRIES}), "
                    f"cooldown {CAMERA_COOLDOWN}s")
                _interruptible_sleep(
                    CAMERA_COOLDOWN, lambda: self._cancelled,
                    _now=self._now, _sleep=self._sleep,
                )

        return False

    def _validated_driver_focus(
        self,
        seg_id: str,
        iracing_bridge: Any,
        target_car_idx: int,
    ) -> bool:
        """Switch driver focus and validate via telemetry readback."""
        snapshot = iracing_bridge.capture_snapshot() or {}
        try:
            current_group = int(snapshot.get("cam_group_num", 0))
        except (TypeError, ValueError):
            current_group = 0

        for attempt in range(1, MAX_CAMERA_RETRIES + 1):
            if self._cancelled:
                return False

            self._log_entry(
                seg_id,
                "driver",
                f"Setting driver focus: car_idx={target_car_idx}",
                attempt=attempt,
                extra={"car_idx": target_car_idx},
            )
            iracing_bridge.cam_switch_car(target_car_idx, current_group)

            _interruptible_sleep(
                0.3, lambda: self._cancelled,
                _now=self._now, _sleep=self._sleep,
            )

            snapshot = iracing_bridge.capture_snapshot()
            if snapshot:
                actual_car = snapshot.get("cam_car_idx", -1)
                driver_ok = actual_car == target_car_idx

                self._log_entry(
                    seg_id,
                    "validate",
                    f"Driver validation: expected={target_car_idx} actual={actual_car}",
                    success=driver_ok,
                    attempt=attempt,
                    expected={"car_idx": target_car_idx},
                    actual={"car_idx": actual_car},
                )

                if driver_ok:
                    return True
            else:
                self._log_entry(
                    seg_id,
                    "validate",
                    "Could not read telemetry for driver validation",
                    success=False,
                    attempt=attempt,
                )

            if attempt < MAX_CAMERA_RETRIES:
                self._log_entry(
                    seg_id,
                    "retry",
                    f"Retrying driver focus ({attempt}/{MAX_CAMERA_RETRIES}), "
                    f"cooldown {CAMERA_COOLDOWN}s",
                )
                _interruptible_sleep(
                    CAMERA_COOLDOWN, lambda: self._cancelled,
                    _now=self._now, _sleep=self._sleep,
                )

        return False

    # -- Camera/driver management -------------------------------------------

    def _apply_camera_and_driver(
        self,
        segment: dict,
        iracing_bridge: Any,
        cam_name_to_num: dict[str, int],
        available_cameras: list[dict],
    ) -> None:
        """Resolve and apply camera + driver focus for a segment."""
        seg_id = segment.get("id", "unknown")

        target_group_num = self._resolve_camera_group(segment, cam_name_to_num)
        target_car_idx = self._resolve_driver_focus(segment)

        if target_group_num is None and target_car_idx is None:
            self._fail_capture(
                seg_id,
                "camera",
                f"No camera/driver target could be resolved for segment '{seg_id}'",
                {
                    "camera_preferences": segment.get("camera_preferences", []),
                    "involved_drivers": segment.get("involved_drivers", []),
                },
            )

        if target_group_num is not None:
            ok = self._validated_camera_switch(
                seg_id, iracing_bridge, target_group_num, target_car_idx
            )
            if not ok:
                self._fail_capture(
                    seg_id,
                    "camera",
                    f"Camera validation failed for segment '{seg_id}' after {MAX_CAMERA_RETRIES} retries",
                    {
                        "target_group_num": target_group_num,
                        "target_car_idx": target_car_idx,
                        "max_camera_retries": MAX_CAMERA_RETRIES,
                    },
                )
        elif target_car_idx is not None:
            # Keep the current camera group when camera resolution is unavailable,
            # instead of forcing group 0 (which can lock capture into a wrong view).
            ok = self._validated_driver_focus(seg_id, iracing_bridge, target_car_idx)
            if not ok:
                self._fail_capture(
                    seg_id,
                    "driver",
                    f"Driver validation failed for segment '{seg_id}' after {MAX_CAMERA_RETRIES} retries",
                    {
                        "target_car_idx": target_car_idx,
                        "max_camera_retries": MAX_CAMERA_RETRIES,
                    },
                )

    def _resolve_camera_group(
        self, segment: dict, cam_name_to_num: dict[str, int]
    ) -> Optional[int]:
        """Resolve segment camera preference to a group number."""
        explicit_group = segment.get("camera_group")
        if explicit_group is not None:
            try:
                return int(explicit_group)
            except (ValueError, TypeError):
                pass

        cam_prefs = segment.get("camera_preferences", [])
        for cam_name in cam_prefs:
            group_num = cam_name_to_num.get(cam_name)
            if group_num is not None:
                return group_num

        if cam_name_to_num:
            return min(cam_name_to_num.values())

        return None

    def _resolve_driver_focus(self, segment: dict) -> Optional[int]:
        """Resolve the primary driver to focus on for a segment."""
        hints = segment.get("camera_hints", {})
        if hints.get("preferred_car_idx") is not None:
            return hints["preferred_car_idx"]

        involved = segment.get("involved_drivers", [])
        if involved:
            first = involved[0]
            if isinstance(first, int):
                return first
            try:
                return int(first)
            except (ValueError, TypeError):
                pass

        return None

    def _wait_with_schedule(
        self,
        total_wait: float,
        pre_roll: float,
        segment: dict,
        iracing_bridge: Any,
        cam_name_to_num: dict[str, int],
    ) -> None:
        """Wait *total_wait* seconds while firing scheduled camera/driver switches
        at their correct offsets during playback.

        Args:
            total_wait: Total real-time seconds to wait.
            pre_roll: Seconds of pre-roll padding already included in the wait
                before the segment's ``start_time_seconds`` is reached.  For a
                new recording pass this equals the clip padding; for a contiguous
                segment it is 0.
            segment: The segment dict, which may contain a ``camera_schedule``
                list of ``{offset_seconds, camera_name|camera_group, car_idx}``.
            iracing_bridge: iRacing bridge for camera commands.
            cam_name_to_num: Mapping of camera name → group number.
        """
        schedule = segment.get("camera_schedule") or []
        seg_id = segment.get("id", "unknown")

        # Sort entries; skip any whose fire time is at or beyond the end of the wait.
        entries = sorted(
            [e for e in schedule if isinstance(e, dict)],
            key=lambda e: e.get("offset_seconds", 0),
        )
        valid_entries = [
            e for e in entries
            if pre_roll + e.get("offset_seconds", 0) < total_wait
        ]

        elapsed = 0.0
        for entry in valid_entries:
            if self._cancelled:
                return
            fire_at = pre_roll + entry.get("offset_seconds", 0)
            to_sleep = fire_at - elapsed
            if to_sleep > 0:
                _interruptible_sleep(
                    to_sleep, lambda: self._cancelled,
                    _now=self._now, _sleep=self._sleep,
                )
                elapsed += to_sleep
            if self._cancelled:
                return
            self._fire_schedule_entry(seg_id, entry, iracing_bridge, cam_name_to_num)

        remaining = total_wait - elapsed
        if remaining > 0 and not self._cancelled:
            _interruptible_sleep(
                remaining, lambda: self._cancelled,
                _now=self._now, _sleep=self._sleep,
            )

    def _fire_schedule_entry(
        self,
        seg_id: str,
        entry: dict,
        iracing_bridge: Any,
        cam_name_to_num: dict[str, int],
    ) -> None:
        """Execute a single camera_schedule entry (camera/driver switch)."""
        offset = entry.get("offset_seconds", 0)
        cam_name = entry.get("camera_name")
        cam_group = entry.get("camera_group")
        car_idx = entry.get("car_idx")

        target_group: Optional[int] = None
        if cam_group is not None:
            try:
                target_group = int(cam_group)
            except (ValueError, TypeError):
                pass
        elif cam_name:
            target_group = cam_name_to_num.get(cam_name)

        self._log_entry(seg_id, "camera_schedule",
            f"Scheduled switch at +{offset:.1f}s: "
            f"camera={cam_name or cam_group} car_idx={car_idx}",
            extra={"offset": offset})

        if target_group is not None:
            ok = self._validated_camera_switch(
                seg_id, iracing_bridge, target_group,
                car_idx if isinstance(car_idx, int) else None,
            )
            if not ok:
                self._fail_capture(
                    seg_id,
                    "camera_schedule",
                    f"Scheduled camera validation failed for segment '{seg_id}'",
                    {"offset_seconds": offset, "camera_group": target_group, "car_idx": car_idx},
                )
        elif car_idx is not None:
            ok = self._validated_driver_focus(seg_id, iracing_bridge, int(car_idx))
            if not ok:
                self._fail_capture(
                    seg_id,
                    "camera_schedule",
                    f"Scheduled driver validation failed for segment '{seg_id}'",
                    {"offset_seconds": offset, "car_idx": car_idx},
                )

    # -- Recording management -----------------------------------------------

    def _stop_and_save_clip(
        self,
        capture_engine: Any,
        iracing_bridge: Any,
        clip_path: Optional[str],
        segment_ids: list[str],
        segment_defs: list[dict],
        clip_start_time: float,
        clip_capture_start_time: float,
        order_idx: int,
        section: str,
    ) -> bool:
        """Stop recording, save and catalogue the clip.

        Returns False (recording has stopped).
        """
        if not clip_path:
            return False

        iracing_bridge.set_replay_speed(0)
        stop_result = capture_engine.stop_recording()
        if stop_result is False:
            detail = str(getattr(capture_engine, "last_error", "") or "Recorder did not produce a confirmed clip")
            self._fail_capture(
                segment_ids[-1] if segment_ids else "",
                "record_stop",
                detail,
                {"clip_path": clip_path, "segment_ids": list(segment_ids)},
            )
        self._sleep(0.3)

        seg_label = ", ".join(segment_ids[:3])
        if len(segment_ids) > 3:
            seg_label += f" (+{len(segment_ids) - 3} more)"

        self._log_entry(segment_ids[-1] if segment_ids else "", "record_stop",
            f"Recording stopped: {Path(clip_path).name} "
            f"covering segments: {seg_label}",
            extra={
                "clip_path": clip_path,
                "segment_ids": list(segment_ids),
            })

        # This is only a file-presence check. Full FFmpeg validation runs once
        # after every requested clip has been captured.
        clip_verified = False
        file_size = 0
        if Path(clip_path).exists():
            file_size = Path(clip_path).stat().st_size
            clip_verified = True
            self._log_entry("", "file_ready",
                f"Capture file saved: {Path(clip_path).name} ({file_size:,} bytes)",
                extra={
                    "file_size": file_size,
                    "clip_path": clip_path,
                    "segment_ids": list(segment_ids),
                })
        else:
            self._log_entry("", "error",
                f"Clip file not found: {clip_path}", success=False,
                extra={
                    "clip_path": clip_path,
                    "segment_ids": list(segment_ids),
                })

        self._emit_progress({
            "step": "clip_saved",
            "clip_path": clip_path,
            "segment_ids": list(segment_ids),
            "verified": clip_verified,
            "file_size": file_size,
        })

        self._clips.append({
            "id": segment_ids[0] if segment_ids else f"clip_{order_idx:03d}",
            "path": clip_path,
            "section": section,
            "order": order_idx,
            "duration": 0,  # populated by downstream compilation/validation
            "segments": segment_ids,
            "clip_start_time": clip_start_time,
            "clip_capture_start_time": clip_capture_start_time,
        })

        for seg in segment_defs:
            seg_id = str(seg.get("id", seg.get("segment_id", ""))).strip()
            if not seg_id:
                continue

            seg_start = float(seg.get("start_time_seconds", 0))
            seg_end = float(seg.get("end_time_seconds", seg_start))
            source_offset_start = max(0.0, seg_start - clip_capture_start_time)
            source_offset_end = max(source_offset_start, seg_end - clip_capture_start_time)

            self._composition_manifest.append({
                "id": seg_id,
                "path": clip_path,
                "section": seg.get("section", section),
                "order": self._segment_order_lookup.get(seg_id, order_idx),
                "event_type": seg.get("event_type", seg.get("type", "")),
                "start_time_seconds": seg_start,
                "end_time_seconds": seg_end,
                "duration_seconds": max(0.0, seg_end - seg_start),
                "clip_padding": float(self._clip_padding),
                "clip_padding_after": float(self._clip_padding_after),
                "source_offset_start_seconds": source_offset_start,
                "source_offset_end_seconds": source_offset_end,
                "source_clip_id": segment_ids[0] if segment_ids else f"clip_{order_idx:03d}",
                "source_segment_ids": list(segment_ids),
            })

        logger.info(
            "[ScriptCapture] Saved clip %s -> %s [%d segments]",
            segment_ids[0] if segment_ids else "?",
            clip_path,
            len(segment_ids),
        )

        return False


    def _validate_clip_file(self, clip_path: str, segment_ids: list[str]) -> dict[str, Any]:
        """Validate a captured clip during the final capture audit."""
        return validate_capture_clip_file(clip_path, segment_ids)

    def _validate_all_clips(self) -> dict[str, Any]:
        """Run one final metadata-and-decode audit over the completed capture pass."""
        self._emit_progress({
            "step": "final_clip_validation",
            "phase": "final",
            "message": f"Starting final validation for {len(self._clips)} captured clip(s)...",
            "clip_count": len(self._clips),
        })

        results: list[dict[str, Any]] = []
        failed: list[dict[str, Any]] = []
        seen_paths: set[str] = set()

        for clip in self._clips:
            clip_path = str(clip.get("path") or "")
            if not clip_path or clip_path in seen_paths:
                continue
            seen_paths.add(clip_path)

            segment_ids = [str(s) for s in (clip.get("segments") or []) if s]
            result = self._validate_clip_file(clip_path, segment_ids)
            results.append(result)

            valid = bool(result.get("valid"))
            if valid:
                clip["duration"] = result.get("duration_seconds") or clip.get("duration") or 0
                self._log_entry(
                    segment_ids[0] if segment_ids else "",
                    "validate",
                    (
                        f"Final validation passed: {Path(clip_path).name} "
                        f"({result.get('duration_seconds')}s)"
                    ),
                    extra=result,
                )
            else:
                failed.append(result)
                self._log_entry(
                    segment_ids[0] if segment_ids else "",
                    "validate",
                    f"Final validation failed: {Path(clip_path).name}",
                    success=False,
                    extra=result,
                )

        summary = {
            "checked": len(results),
            "passed": len(results) - len(failed),
            "failed": failed,
            "results": results,
        }
        self._emit_progress({
            "step": "final_clip_validation_complete",
            "phase": "final",
            "message": (
                f"Final validation passed for {summary['passed']}/{summary['checked']} clip(s)"
                if not failed else f"Final validation failed for {len(failed)} clip(s)"
            ),
            **summary,
        })
        return summary

    def _remove_failed_validation_outputs(self, failed: list[dict[str, Any]]) -> None:
        """Delete invalid clip files and remove their manifest entries."""
        failed_paths = {str(item.get("path") or "") for item in failed if item.get("path")}
        failed_segment_ids = {
            str(segment_id)
            for item in failed
            for segment_id in (item.get("segment_ids") or [])
            if segment_id
        }

        for clip_path in sorted(failed_paths):
            try:
                Path(clip_path).unlink(missing_ok=True)
                self._log_entry(
                    "",
                    "delete",
                    f"Deleted invalid clip before recapture: {Path(clip_path).name}",
                    extra={"clip_path": clip_path},
                )
                command_log.record(
                    "capture-delete-invalid-clip",
                    {"clip_path": clip_path},
                    result="ok",
                    source="script_capture",
                )
            except Exception as exc:
                self._log_entry(
                    "",
                    "delete",
                    f"Failed to delete invalid clip {clip_path}: {exc}",
                    success=False,
                    extra={"clip_path": clip_path, "error": str(exc)},
                )

        self._clips = [
            clip for clip in self._clips
            if str(clip.get("path") or "") not in failed_paths
            and not (set(map(str, clip.get("segments") or [])) & failed_segment_ids)
        ]
        self._composition_manifest = [
            entry for entry in self._composition_manifest
            if str(entry.get("path") or "") not in failed_paths
            and str(entry.get("id") or "") not in failed_segment_ids
        ]

    def _build_clip_name(
        self, seg_id: str, section: str, seg_type: str,
        segment: dict, index: int
    ) -> str:
        """Build a descriptive clip filename."""
        event_type = segment.get("event_type", "")
        drivers = segment.get("driver_names", [])
        driver_str = "_".join(drivers[:2]) if drivers else ""

        parts = [
            f"{index:03d}",
            _sanitize_filename(section),
            _sanitize_filename(seg_type),
        ]
        if event_type:
            parts.append(_sanitize_filename(event_type))
        if driver_str:
            parts.append(_sanitize_filename(driver_str))
        parts.append(_sanitize_filename(seg_id)[:20])

        name = "_".join(parts)
        return name[:_MAX_FILENAME_LENGTH]

    # -- Logging helpers ----------------------------------------------------

    def _log_entry(
        self,
        seg_id: str,
        action: str,
        detail: str,
        success: bool = True,
        attempt: int = 1,
        expected: Any = None,
        actual: Any = None,
        extra: Optional[dict] = None,
    ) -> None:
        """Record a structured log entry and emit to Python logging."""
        entry = CaptureLogEntry(
            timestamp=time.time(),
            segment_id=seg_id,
            action=action,
            detail=detail,
            success=success,
            attempt=attempt,
            expected=expected,
            actual=actual,
            extra=extra or {},
        )
        self._capture_log.append(entry)

        level = logging.INFO if success else logging.WARNING
        logger.log(level, "[ScriptCapture] [%s] %s: %s", seg_id, action, detail)

        # Emit log to progress callback for real-time UI
        if self._progress_cb:
            try:
                self._progress_cb({
                    "step": "log_entry",
                    "log_entry": entry.to_dict(),
                })
            except Exception:
                logger.debug("Suppressed exception in log progress callback", exc_info=True)

    def _emit_progress(self, data: dict) -> None:
        """Send progress update via callback if registered."""
        if self._progress_cb:
            try:
                self._progress_cb(data)
            except Exception:
                logger.debug("Suppressed exception in progress callback", exc_info=True)
