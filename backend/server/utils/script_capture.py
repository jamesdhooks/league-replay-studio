"""
script_capture.py
-----------------
Script-driven capture engine for Video Composition Scripts.

For each segment in the script, the engine:
  1. Pauses the replay
  2. Seeks to the segment's start time (minus configurable padding)
  3. Switches to the appropriate iRacing camera
  4. Starts recording
  5. Resumes replay at 1× speed
  6. Waits for the segment duration to elapse
  7. Stops recording
  8. Trims the padding from the clip start
  9. Saves the clip with a name tied to the script segment ID

After all segments are captured, it concatenates them in script order
using FFmpeg.

Camera switching within race segments (e.g., changing focus car during a
battle) is handled by the existing capture-time camera direction logic.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

# Default padding in seconds added before each clip to avoid missed starts.
# This prefix is trimmed from the final clip.
DEFAULT_CLIP_PADDING = 0.5

# Maximum characters for a sanitized segment filename component
_MAX_FILENAME_LENGTH = 64

# Minimum FFmpeg compile timeout in seconds (prevents excessively short deadlines)
_MIN_COMPILE_TIMEOUT = 120

# Seconds of FFmpeg compile budget allocated per clip
_COMPILE_SECONDS_PER_CLIP = 60

# Pattern to strip unsafe characters from segment IDs used as filenames
_SAFE_FILENAME_RE = re.compile(r'[^a-zA-Z0-9_\-]')


def _find_ffmpeg() -> Optional[str]:
    """Locate the FFmpeg binary."""
    try:
        from server.utils.gpu_detection import find_ffmpeg
        return find_ffmpeg()
    except Exception:
        import shutil
        return shutil.which("ffmpeg")


def _sanitize_filename(name: str) -> str:
    """Sanitize a string for safe use as a filename component.

    Strips path separators, special characters, and limits length to
    prevent path traversal or command injection.
    """
    # Strip all non-safe characters (handles path separators, spaces, etc.)
    sanitized = _SAFE_FILENAME_RE.sub("_", name or "clip")
    # Limit length and ensure non-empty
    return (sanitized[:_MAX_FILENAME_LENGTH] or "clip")


class ScriptCaptureEngine:
    """Capture engine that processes a Video Composition Script segment by
    segment, producing individual clips and then compiling them into a
    final highlight video.

    This class coordinates the iRacing bridge (for replay/camera control)
    and the CaptureEngine (for recording) but does NOT depend on the
    CaptureService (OBS hotkey layer).  It uses the CaptureEngine's
    start_recording / stop_recording directly for precise clip control.
    """

    def __init__(
        self,
        output_dir: str,
        clip_padding: float = DEFAULT_CLIP_PADDING,
        progress_callback: Optional[Callable[[dict], None]] = None,
        compile_timeout: int = 0,
    ) -> None:
        """
        Args:
            output_dir: Directory to write clip files.
            clip_padding: Seconds of pre-roll before each clip (trimmed later).
            progress_callback: Optional callable for progress events.
            compile_timeout: Timeout in seconds for the FFmpeg compile step.
                0 = auto (_COMPILE_SECONDS_PER_CLIP × clip count,
                minimum _MIN_COMPILE_TIMEOUT seconds).
        """
        self._output_dir = Path(output_dir)
        self._output_dir.mkdir(parents=True, exist_ok=True)
        self._clip_padding = clip_padding
        self._progress_cb = progress_callback
        self._compile_timeout = compile_timeout
        self._clips: list[dict] = []  # {id, path, section, order}
        self._cancelled = False

    # -- Public API ---------------------------------------------------------

    def cancel(self) -> None:
        """Signal the capture loop to stop."""
        self._cancelled = True

    @property
    def clips(self) -> list[dict]:
        """Return list of captured clip metadata."""
        return list(self._clips)

    def capture_script(
        self,
        script: list[dict],
        iracing_bridge: Any,
        capture_engine: Any,
        available_cameras: Optional[list[dict]] = None,
    ) -> list[dict]:
        """Process every segment in *script*, capturing a clip for each.

        Args:
            script: Ordered list of script segment dicts (from
                    generate_video_script).
            iracing_bridge: The IRacingBridge singleton for replay/camera
                            control.
            capture_engine: The CaptureEngine instance for recording.
            available_cameras: Optional cached list of camera groups from
                               iRacing (each has 'group_num', 'group_name').

        Returns:
            List of clip dicts [{id, path, section, order, duration}, ...].
        """
        self._cancelled = False
        self._clips = []

        total = len(script)
        if total == 0:
            return []

        # Cache camera groups if not provided
        if available_cameras is None:
            available_cameras = getattr(iracing_bridge, "cameras", []) or []

        cam_name_to_num = {
            c["group_name"]: c["group_num"]
            for c in available_cameras
        }

        for idx, segment in enumerate(script):
            if self._cancelled:
                logger.info("[ScriptCapture] Cancelled at segment %d/%d", idx + 1, total)
                break

            seg_id = segment.get("id", f"seg_{idx:03d}")
            section = segment.get("section", "race")
            seg_type = segment.get("type", "event")
            start = segment.get("start_time_seconds", 0)
            end = segment.get("end_time_seconds", start + 5)
            duration = end - start
            padding = segment.get("clip_padding", self._clip_padding)

            # Skip zero-duration or transition-only segments
            if seg_type == "transition" or duration <= 0:
                continue

            self._emit_progress({
                "step": "capturing",
                "segment_index": idx,
                "segment_total": total,
                "segment_id": seg_id,
                "section": section,
                "message": f"Capturing {section}: {seg_id}",
            })

            clip_path = str(self._output_dir / f"{_sanitize_filename(seg_id)}.mp4")

            # 1. Pause replay
            iracing_bridge.set_replay_speed(0)
            time.sleep(0.2)

            # 2. Seek to start time minus padding buffer
            seek_time_ms = max(0, int((start - padding) * 1000))
            session_num = iracing_bridge.get_replay_session_num()
            if session_num < 0:
                logger.warning("[ScriptCapture] Replay session num unavailable, defaulting to 0")
                session_num = 0
            iracing_bridge.replay_search_session_time(session_num, seek_time_ms)
            time.sleep(0.5)  # allow seek to settle

            # 3. Switch camera for B-roll segments
            self._select_camera(segment, iracing_bridge, cam_name_to_num)
            time.sleep(0.2)

            # 4. Start recording
            try:
                capture_engine.start_recording(clip_path, mode="auto")
            except Exception as exc:
                logger.error("[ScriptCapture] Recording start failed for %s: %s", seg_id, exc)
                continue

            # 5. Resume replay at 1×
            iracing_bridge.set_replay_speed(1)

            # 6. Wait for segment duration + padding
            wait_seconds = duration + padding
            _interruptible_sleep(wait_seconds, lambda: self._cancelled)

            # 7. Stop recording
            iracing_bridge.set_replay_speed(0)
            capture_engine.stop_recording()
            time.sleep(0.3)

            # 8. Trim the padding from the clip start
            trimmed_path = self._trim_clip(clip_path, padding) if padding > 0 else clip_path

            self._clips.append({
                "id": seg_id,
                "path": trimmed_path,
                "section": section,
                "order": idx,
                "duration": duration,
                "type": seg_type,
            })

            logger.info(
                "[ScriptCapture] Captured %s (%s) → %s  [%.1fs]",
                seg_id, section, trimmed_path, duration,
            )

        self._emit_progress({
            "step": "capture_complete",
            "clips_captured": len(self._clips),
            "message": f"Captured {len(self._clips)} clips",
        })

        return list(self._clips)

    def compile_clips(self, output_path: str) -> Optional[str]:
        """Concatenate all captured clips into a single video file.

        Uses FFmpeg concat demuxer for lossless joining of clips that
        share the same codec/resolution.

        Args:
            output_path: Path for the final compiled video.

        Returns:
            The output file path on success, None on failure.
        """
        if not self._clips:
            logger.warning("[ScriptCapture] No clips to compile")
            return None

        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            logger.error("[ScriptCapture] FFmpeg not found")
            return None

        self._emit_progress({
            "step": "compiling",
            "message": "Compiling clips into final video...",
        })

        # Sort clips by script order
        sorted_clips = sorted(self._clips, key=lambda c: c["order"])

        # Write concat list file
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
            # Auto-calculate timeout: budget per clip, capped at minimum
            timeout = self._compile_timeout
            if timeout <= 0:
                timeout = max(_MIN_COMPILE_TIMEOUT, len(sorted_clips) * _COMPILE_SECONDS_PER_CLIP)
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            if result.returncode != 0:
                logger.error("[ScriptCapture] Compile failed: %s", result.stderr[:500])
                return None
        except subprocess.TimeoutExpired:
            logger.error("[ScriptCapture] Compile timed out")
            return None
        except Exception as exc:
            logger.error("[ScriptCapture] Compile error: %s", exc)
            return None

        # Clean up concat list
        try:
            concat_list.unlink()
        except OSError:
            pass

        logger.info("[ScriptCapture] Compiled %d clips → %s", len(sorted_clips), output_path)

        self._emit_progress({
            "step": "compile_complete",
            "output_path": output_path,
            "message": "Video compilation complete",
        })

        return output_path

    # -- Internal helpers ---------------------------------------------------

    def _select_camera(
        self,
        segment: dict,
        iracing_bridge: Any,
        cam_name_to_num: dict[str, int],
    ) -> None:
        """Choose and apply the best camera for the segment."""
        # If user explicitly chose a camera group number, use it
        explicit_group = segment.get("camera_group")
        if explicit_group is not None:
            try:
                iracing_bridge.cam_switch_position(0, int(explicit_group))
                return
            except Exception:
                pass

        # For B-roll / TV cam segments, walk the preference list
        cam_prefs = segment.get("camera_preferences", [])
        for cam_name in cam_prefs:
            group_num = cam_name_to_num.get(cam_name)
            if group_num is not None:
                iracing_bridge.cam_switch_position(0, group_num)
                logger.debug("[ScriptCapture] Camera → %s (group %d)", cam_name, group_num)
                return

        # Fallback: if this is a race event, point camera at involved drivers
        if segment.get("type") == "event" or segment.get("section") == "race":
            involved = segment.get("involved_drivers", [])
            if involved:
                car_idx = involved[0] if isinstance(involved[0], int) else 0
                iracing_bridge.cam_switch_car(car_idx, 0)
                return

        # Last resort: use camera group 0 (usually the default TV cam)
        if cam_name_to_num:
            first_group = min(cam_name_to_num.values())
            iracing_bridge.cam_switch_position(0, first_group)

    def _trim_clip(self, clip_path: str, trim_seconds: float) -> str:
        """Trim the first *trim_seconds* from a clip using FFmpeg.

        Returns the path to the trimmed clip (replaces the original).
        """
        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            return clip_path

        trimmed_path = clip_path.replace(".mp4", "_trimmed.mp4")
        cmd = [
            ffmpeg, "-hide_banner", "-loglevel", "warning", "-y",
            "-ss", f"{trim_seconds:.3f}",
            "-i", clip_path,
            "-c", "copy",
            "-avoid_negative_ts", "make_zero",
            trimmed_path,
        ]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            if result.returncode == 0:
                # Replace original with trimmed version
                try:
                    os.remove(clip_path)
                    os.rename(trimmed_path, clip_path)
                except OSError:
                    return trimmed_path
                return clip_path
        except Exception as exc:
            logger.warning("[ScriptCapture] Trim failed for %s: %s", clip_path, exc)

        return clip_path

    def _emit_progress(self, data: dict) -> None:
        """Send progress update via callback if registered."""
        if self._progress_cb:
            try:
                self._progress_cb(data)
            except Exception:
                pass


def _interruptible_sleep(seconds: float, cancelled_fn: Callable[[], bool]) -> None:
    """Sleep for *seconds*, checking cancellation every 0.25s."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if cancelled_fn():
            break
        time.sleep(min(0.25, deadline - time.monotonic()))
