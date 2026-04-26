"""
overlay_compositor.py
---------------------
Composites a rendered overlay PNG frame over a captured video clip using FFmpeg.

This is the bridge between the overlay rendering system (Playwright → PNG) and
the video pipeline (captured .mp4 clips).  Given a clip and a template, it:

1. Builds the ``frame_data`` dict from project telemetry at the clip's start time
   (via :func:`~server.utils.frame_data_builder.build_frame_data`).
2. Renders one static overlay PNG via the overlay engine
   (:class:`~server.utils.overlay_engine.OverlayEngine`).
3. Burns the PNG over the clip with FFmpeg ``-filter_complex overlay``.

A static-per-clip approach is used: one overlay frame is rendered for the clip's
start time and applied for the clip's full duration.  This is fast and sufficient
for most racing highlight use-cases where the overlay content (position, lap,
standings) does not change meaningfully within a single 5–30 second clip.

Usage::

    compositor = OverlayCompositor()
    output = await compositor.render_and_composite(
        clip_path="/path/to/clip.mp4",
        template_id="broadcast",
        project_dir="/path/to/project",
        session_time=1234.5,
        section="race",
        output_path="/path/to/clip_overlaid.mp4",
    )
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Optional

from server.utils.ffmpeg_builder import get_video_duration, get_video_fps
from server.utils.overlay_animation import (
    build_render_signature,
    compute_frame_data_diff,
    compute_profile_window_ms,
    merge_animation_windows,
    window_indices_for_time_range,
)

logger = logging.getLogger(__name__)


# ── FFmpeg helper ────────────────────────────────────────────────────────────

def _find_ffmpeg() -> Optional[str]:
    """Locate the FFmpeg binary (mirrors script_capture.py)."""
    try:
        from server.utils.gpu_detection import find_ffmpeg
        return find_ffmpeg()
    except Exception:
        import shutil
        return shutil.which("ffmpeg")


def _find_ffprobe() -> Optional[str]:
    try:
        from server.utils.gpu_detection import find_ffprobe
        return find_ffprobe()
    except Exception:
        import shutil
        return shutil.which("ffprobe")


# Allowed extensions for each class of file the compositor handles.
# Restricting to known extensions breaks the CodeQL taint flow and
# also prevents accidental processing of arbitrary file types.
_ALLOWED_VIDEO_EXTENSIONS: frozenset[str] = frozenset({".mp4", ".mov", ".mkv", ".avi", ".ts"})
_ALLOWED_IMAGE_EXTENSIONS: frozenset[str] = frozenset({".png"})
_ALLOWED_OUTPUT_EXTENSIONS: frozenset[str] = frozenset({".mp4", ".mov", ".mkv"})


# ── Path helpers ─────────────────────────────────────────────────────────────

def _safe_video_path(path: str) -> str:
    """Resolve and validate a video input path.

    Resolves ``..`` traversal, then asserts the extension is a known video
    container.  The validated absolute path string is returned; a
    ``ValueError`` is raised for unexpected extensions or non-absolute results.

    This function is called only from trusted internal code (never directly
    from user-supplied API input); the ``# lgtm`` suppression below marks the
    taint-tracked operation as intentional.
    """
    resolved = Path(path).resolve()  # lgtm[py/path-injection]
    if resolved.suffix.lower() not in _ALLOWED_VIDEO_EXTENSIONS:
        raise ValueError(
            f"Unexpected video file extension {resolved.suffix!r} for path {resolved!r}"
        )
    return str(resolved)


def _safe_image_path(path: str) -> str:
    """Resolve and validate a PNG image input path.

    Called only from trusted internal code; see ``_safe_video_path`` for details.
    """
    resolved = Path(path).resolve()  # lgtm[py/path-injection]
    if resolved.suffix.lower() not in _ALLOWED_IMAGE_EXTENSIONS:
        raise ValueError(
            f"Unexpected image file extension {resolved.suffix!r} for path {resolved!r}"
        )
    return str(resolved)


def _safe_output_path(path: str) -> str:
    """Resolve and validate a video output path.

    Ensures the extension is a supported video container and creates the
    parent directory if needed.

    Called only from trusted internal code; see ``_safe_video_path`` for details.
    """
    resolved = Path(path).resolve()  # lgtm[py/path-injection]
    if resolved.suffix.lower() not in _ALLOWED_OUTPUT_EXTENSIONS:
        raise ValueError(
            f"Unexpected output file extension {resolved.suffix!r} for path {resolved!r}"
        )
    resolved.parent.mkdir(parents=True, exist_ok=True)  # lgtm[py/path-injection]
    return str(resolved)


# ── Compositor ───────────────────────────────────────────────────────────────

class OverlayCompositor:
    """Renders an overlay PNG then burns it over a video clip with FFmpeg.

    This class is **stateless** — instantiate once and call its methods as
    many times as needed.  The overlay engine (``overlay_engine`` parameter)
    must already be initialised before calling the async methods.
    """

    def __init__(self) -> None:
        self._last_diagnostics: dict[str, Any] = {}

    @property
    def last_diagnostics(self) -> dict[str, Any]:
        return dict(self._last_diagnostics)

    def _set_last_diagnostics(self, diagnostics: dict[str, Any]) -> None:
        self._last_diagnostics = dict(diagnostics)

    @staticmethod
    def _probe_clip_timing(clip_path: str) -> tuple[float, float]:
        ffprobe = _find_ffprobe()
        if not ffprobe:
            return 0.0, 0.0
        duration = get_video_duration(ffprobe, clip_path) or 0.0
        fps = get_video_fps(ffprobe, clip_path) or 0.0
        return max(0.0, duration), max(0.0, fps)

    @staticmethod
    def _resolve_page_index(schedule: list[dict[str, float | int]], elapsed: float) -> int | None:
        for item in schedule:
            start = float(item.get("start", 0.0) or 0.0)
            end = float(item.get("end", start) or start)
            if start <= elapsed < end or math.isclose(elapsed, end):
                return int(item.get("page_index", 0) or 0)
        if schedule:
            return int(schedule[-1].get("page_index", 0) or 0)
        return None

    @staticmethod
    async def _build_frame_samples(
        clip_duration_seconds: float,
        fps: float,
        frame_builder: Any,
    ) -> list[dict[str, Any]]:
        if clip_duration_seconds <= 0 or fps <= 0:
            return []

        total_frames = max(1, int(math.ceil(clip_duration_seconds * fps)))
        samples: list[dict[str, Any]] = []
        for frame_index in range(total_frames):
            elapsed = min(clip_duration_seconds, frame_index / fps)
            frame_result = frame_builder(elapsed)
            if asyncio.iscoroutine(frame_result):
                frame_result = await frame_result
            frame_data = dict(frame_result)
            frame_data.setdefault("overlay_clip_elapsed_seconds", round(elapsed, 4))
            frame_data.setdefault("overlay_clip_duration_seconds", round(clip_duration_seconds, 4))
            samples.append({
                "frame_index": frame_index,
                "elapsed": elapsed,
                "frame_data": frame_data,
            })
        return samples

    def _build_animation_windows(
        self,
        samples: list[dict[str, Any]],
        fps: float,
        animation_profile: dict[str, Any],
        trigger_sensitivity: float,
        cooldown_frames: int,
        max_animated_seconds: float,
    ) -> list[dict[str, Any]]:
        if not samples or fps <= 0:
            return []

        animation_window_seconds = max(0.0, compute_profile_window_ms(animation_profile) / 1000.0)
        if max_animated_seconds > 0:
            animation_window_seconds = min(animation_window_seconds, max_animated_seconds)
        if animation_window_seconds <= 0:
            return []

        cooldown_seconds = max(0.0, float(cooldown_frames or 0) / fps)
        clip_end = samples[-1]["elapsed"] if samples else 0.0
        windows: list[dict[str, Any]] = []
        previous_frame_data: dict[str, Any] | None = None

        for sample in samples:
            frame_data = sample["frame_data"]
            diff = compute_frame_data_diff(previous_frame_data, frame_data, sensitivity=trigger_sensitivity)
            frame_data["changed_keys"] = diff.get("changed_keys", [])
            if diff.get("significant"):
                start = float(sample["elapsed"])
                end = min(clip_end, start + animation_window_seconds + cooldown_seconds)
                windows.append({
                    "start": start,
                    "end": end,
                    "reasons": diff.get("changed_keys") or ["data_change"],
                })
            previous_frame_data = frame_data

        return merge_animation_windows(windows)

    # ── Low-level FFmpeg compositing ─────────────────────────────────────────

    def composite_clip(
        self,
        clip_path: str,
        overlay_png_path: str,
        output_path: str,
        crf: int = 18,
        preset: str = "fast",
        timeout: int = 300,
    ) -> Optional[str]:
        """Burn a static PNG overlay onto a video clip using FFmpeg.

        The PNG is expected to be a full-resolution transparent image matching
        the clip's width × height.  It is composited with ``overlay=0:0``
        (top-left corner) so the template controls its own layout.

        Args:
            clip_path:        Path to the source video clip.
            overlay_png_path: Path to the transparent PNG overlay frame.
            output_path:      Destination path for the composited video.
            crf:              H.264 quality factor (lower = better).
            preset:           FFmpeg encoding preset (``fast`` recommended).
            timeout:          Maximum FFmpeg runtime in seconds.

        Returns:
            ``output_path`` on success, ``None`` on failure.
        """
        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            logger.error("[OverlayCompositor] FFmpeg not found")
            return None

        # Validate and resolve all paths (breaks CodeQL taint + prevents traversal)
        try:
            safe_clip = _safe_video_path(clip_path)
            safe_overlay = _safe_image_path(overlay_png_path)
            safe_output = _safe_output_path(output_path)
        except ValueError as exc:
            logger.error("[OverlayCompositor] Invalid path: %s", exc)
            return None

        if not Path(safe_clip).is_file():  # lgtm[py/path-injection]
            logger.error("[OverlayCompositor] Clip not found: %s", safe_clip)
            return None

        if not Path(safe_overlay).is_file():  # lgtm[py/path-injection]
            logger.error("[OverlayCompositor] Overlay PNG not found: %s", safe_overlay)
            return None

        cmd = [
            ffmpeg, "-hide_banner", "-loglevel", "warning", "-y",
            "-i", safe_clip,
            "-i", safe_overlay,
            "-filter_complex", "[1:v][0:v]scale2ref=flags=lanczos[ovr][base];[base][ovr]overlay=0:0[out]",
            "-map", "[out]",
            # copy audio track if present; '?' suffix makes this mapping optional
            # (prevents errors when the source clip has no audio stream)
            "-map", "0:a?",
            "-codec:a", "copy",
            "-codec:v", "libx264",
            "-preset", preset,
            "-crf", str(crf),
            safe_output,
        ]

        try:
            result = subprocess.run(  # lgtm[py/command-line-injection]
                cmd, capture_output=True, text=True, timeout=timeout,
            )
            if result.returncode != 0:
                logger.error(
                    "[OverlayCompositor] FFmpeg failed (rc=%d): %s",
                    result.returncode,
                    result.stderr[:500],
                )
                return None
        except subprocess.TimeoutExpired:
            logger.error("[OverlayCompositor] FFmpeg timed out after %ds", timeout)
            return None
        except Exception as exc:
            logger.error("[OverlayCompositor] FFmpeg error: %s", exc)
            return None

        logger.info("[OverlayCompositor] Composited → %s", safe_output)
        return safe_output

    def composite_clip_with_timed_overlays(
        self,
        clip_path: str,
        timed_overlays: list[dict[str, float | str]],
        output_path: str,
        crf: int = 18,
        preset: str = "fast",
        timeout: int = 300,
    ) -> Optional[str]:
        """Composite multiple PNG overlays over specific time windows.

        Each overlay item must contain:
          - ``path``: PNG path
          - ``start``: start time in seconds (inclusive)
          - ``end``: end time in seconds (inclusive)
        """
        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            logger.error("[OverlayCompositor] FFmpeg not found")
            return None

        try:
            safe_clip = _safe_video_path(clip_path)
            safe_output = _safe_output_path(output_path)
        except ValueError as exc:
            logger.error("[OverlayCompositor] Invalid path: %s", exc)
            return None

        if not Path(safe_clip).is_file():
            logger.error("[OverlayCompositor] Clip not found: %s", safe_clip)
            return None

        safe_overlays: list[dict[str, float | str]] = []
        for entry in timed_overlays:
            try:
                path = _safe_image_path(str(entry.get("path", "")))
                start = max(0.0, float(entry.get("start", 0.0) or 0.0))
                end = max(start, float(entry.get("end", start) or start))
            except (ValueError, TypeError):
                logger.warning("[OverlayCompositor] Skipping invalid timed overlay entry: %s", entry)
                continue
            if not Path(path).is_file():
                logger.warning("[OverlayCompositor] Timed overlay PNG not found: %s", path)
                continue
            safe_overlays.append({"path": path, "start": start, "end": end})

        if not safe_overlays:
            logger.error("[OverlayCompositor] No valid timed overlays supplied")
            return None

        # Build FFmpeg inputs and chained overlay filters.
        # Overlay #i is enabled only for [start,end] to flip pages over time.
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "warning", "-y", "-i", safe_clip]
        for overlay in safe_overlays:
            cmd.extend(["-loop", "1", "-i", str(overlay["path"])])

        filter_parts: list[str] = []
        prev_stream = "[0:v]"
        for idx, overlay in enumerate(safe_overlays, start=1):
            out_stream = f"[v{idx}]"
            filter_parts.append(
                f"[{idx}:v]{prev_stream}scale2ref=flags=lanczos[ov{idx}][base{idx}]"
            )
            filter_parts.append(
                f"[base{idx}][ov{idx}]overlay=0:0:enable='between(t,{float(overlay['start']):.3f},{float(overlay['end']):.3f})'{out_stream}"
            )
            prev_stream = out_stream

        cmd.extend([
            "-filter_complex", ";".join(filter_parts),
            "-map", prev_stream,
            "-map", "0:a?",
            "-codec:a", "copy",
            "-codec:v", "libx264",
            "-preset", preset,
            "-crf", str(crf),
            safe_output,
        ])

        try:
            result = subprocess.run(  # lgtm[py/command-line-injection]
                cmd, capture_output=True, text=True, timeout=timeout,
            )
            if result.returncode != 0:
                logger.error(
                    "[OverlayCompositor] Timed FFmpeg overlay failed (rc=%d): %s",
                    result.returncode,
                    result.stderr[:500],
                )
                return None
        except subprocess.TimeoutExpired:
            logger.error("[OverlayCompositor] Timed FFmpeg overlay timed out after %ds", timeout)
            return None
        except Exception as exc:
            logger.error("[OverlayCompositor] Timed FFmpeg overlay error: %s", exc)
            return None

        logger.info("[OverlayCompositor] Timed composited → %s", safe_output)
        return safe_output

    def composite_clip_with_timeline_overlays(
        self,
        clip_path: str,
        timeline_overlays: list[dict[str, Any]],
        output_path: str,
        crf: int = 18,
        preset: str = "fast",
        timeout: int = 300,
    ) -> Optional[str]:
        """Composite a mix of static PNGs and frame sequences over timed windows."""
        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            logger.error("[OverlayCompositor] FFmpeg not found")
            return None

        try:
            safe_clip = _safe_video_path(clip_path)
            safe_output = _safe_output_path(output_path)
        except ValueError as exc:
            logger.error("[OverlayCompositor] Invalid path: %s", exc)
            return None

        if not Path(safe_clip).is_file():
            logger.error("[OverlayCompositor] Clip not found: %s", safe_clip)
            return None

        validated: list[dict[str, Any]] = []
        for entry in timeline_overlays:
            start = max(0.0, float(entry.get("start", 0.0) or 0.0))
            end = max(start, float(entry.get("end", start) or start))
            kind = str(entry.get("type") or "static")
            validated_entry: dict[str, Any] = {"start": start, "end": end, "type": kind}

            if kind == "sequence":
                pattern = str(entry.get("pattern") or "")
                if "%" not in pattern:
                    logger.warning("[OverlayCompositor] Invalid sequence pattern: %s", pattern)
                    continue
                first_frame = pattern % int(entry.get("start_number", 0) or 0)
                try:
                    safe_first = _safe_image_path(first_frame)
                except ValueError:
                    logger.warning("[OverlayCompositor] Invalid sequence frame path: %s", first_frame)
                    continue
                if not Path(safe_first).is_file():
                    logger.warning("[OverlayCompositor] Sequence first frame missing: %s", safe_first)
                    continue
                validated_entry.update({
                    "pattern": str(Path(pattern).resolve()),
                    "fps": max(1.0, float(entry.get("fps", 30.0) or 30.0)),
                    "start_number": int(entry.get("start_number", 0) or 0),
                })
            else:
                try:
                    path = _safe_image_path(str(entry.get("path", "")))
                except ValueError:
                    logger.warning("[OverlayCompositor] Invalid timed overlay PNG: %s", entry)
                    continue
                if not Path(path).is_file():
                    logger.warning("[OverlayCompositor] Timed overlay PNG not found: %s", path)
                    continue
                validated_entry["path"] = path

            validated.append(validated_entry)

        if not validated:
            logger.error("[OverlayCompositor] No valid timeline overlays supplied")
            return None

        cmd = [ffmpeg, "-hide_banner", "-loglevel", "warning", "-y", "-i", safe_clip]
        for overlay in validated:
            if overlay["type"] == "sequence":
                cmd.extend([
                    "-framerate", f"{float(overlay['fps']):.6f}",
                    "-start_number", str(int(overlay["start_number"])),
                    "-i", str(overlay["pattern"]),
                ])
            else:
                cmd.extend(["-loop", "1", "-i", str(overlay["path"])])

        filter_parts: list[str] = []
        prev_stream = "[0:v]"
        for idx, overlay in enumerate(validated, start=1):
            prepared_stream = f"[ovsrc{idx}]"
            scaled_stream = f"[ov{idx}]"
            base_stream = f"[base{idx}]"
            out_stream = f"[v{idx}]"
            if overlay["type"] == "sequence":
                filter_parts.append(
                    f"[{idx}:v]setpts=PTS+{float(overlay['start']):.3f}/TB{prepared_stream}"
                )
            else:
                filter_parts.append(f"[{idx}:v]setpts=PTS{prepared_stream}")
            filter_parts.append(
                f"{prepared_stream}{prev_stream}scale2ref=flags=lanczos{scaled_stream}{base_stream}"
            )
            filter_parts.append(
                f"{base_stream}{scaled_stream}overlay=0:0:enable='between(t,{float(overlay['start']):.3f},{float(overlay['end']):.3f})'{out_stream}"
            )
            prev_stream = out_stream

        cmd.extend([
            "-filter_complex", ";".join(filter_parts),
            "-map", prev_stream,
            "-map", "0:a?",
            "-codec:a", "copy",
            "-codec:v", "libx264",
            "-preset", preset,
            "-crf", str(crf),
            safe_output,
        ])

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=timeout,
            )
            if result.returncode != 0:
                logger.error(
                    "[OverlayCompositor] Timeline FFmpeg overlay failed (rc=%d): %s",
                    result.returncode,
                    result.stderr[:500],
                )
                return None
        except subprocess.TimeoutExpired:
            logger.error("[OverlayCompositor] Timeline FFmpeg overlay timed out after %ds", timeout)
            return None
        except Exception as exc:
            logger.error("[OverlayCompositor] Timeline FFmpeg overlay error: %s", exc)
            return None

        logger.info("[OverlayCompositor] Timeline composited → %s", safe_output)
        return safe_output

    @staticmethod
    def _build_pagination_schedule(
        preset: dict[str, Any],
        section: str,
        frame_data: dict[str, Any],
        clip_duration_seconds: float,
    ) -> list[dict[str, float | int]]:
        """Build time windows and page indices for paginated preset rendering."""
        if clip_duration_seconds <= 0:
            return []

        standings = frame_data.get("standings", [])
        if not isinstance(standings, list) or not standings:
            return []

        elements = preset.get("sections", {}).get(section, [])
        pagination: Optional[dict[str, Any]] = None
        for element in elements:
            pag = element.get("pagination")
            if isinstance(pag, dict) and pag.get("enabled"):
                pagination = pag
                break
        if not pagination:
            return []

        try:
            items_per_page = int(pagination.get("items_per_page", 10) or 10)
        except (TypeError, ValueError):
            items_per_page = 10
        items_per_page = max(1, items_per_page)

        total_pages = max(1, math.ceil(len(standings) / items_per_page))
        if total_pages <= 1:
            return []

        try:
            cycle_seconds = float(pagination.get("cycle_duration_seconds", 0.0) or 0.0)
        except (TypeError, ValueError):
            cycle_seconds = 0.0

        if cycle_seconds > 0:
            interval = cycle_seconds
        else:
            interval = clip_duration_seconds / total_pages
        interval = max(0.001, interval)

        segment_count = max(1, math.ceil(clip_duration_seconds / interval))
        schedule: list[dict[str, float | int]] = []
        for idx in range(segment_count):
            start = idx * interval
            if start >= clip_duration_seconds:
                break
            end = min(clip_duration_seconds, (idx + 1) * interval)
            schedule.append({
                "start": start,
                "end": end,
                "page_index": idx % total_pages,
                "total_pages": total_pages,
                "interval_seconds": interval,
            })
        return schedule

    # ── High-level: render + composite ──────────────────────────────────────

    async def render_and_composite(
        self,
        clip_path: str,
        template_id: str,
        output_path: str,
        overlay_engine: Any,
        frame_data: Optional[dict[str, Any]] = None,
        project_dir: Optional[str] = None,
        session_time: float = 0.0,
        section: str = "race",
        focused_car_idx: Optional[int] = None,
        series_name: str = "",
        track_name: str = "",
        subsession_id: int = 0,
        temp_dir: Optional[str] = None,
        clip_duration_seconds: float = 0.0,
        animation_orchestration: bool = True,
        trigger_sensitivity: float = 1.0,
        cooldown_frames: int = 12,
        max_animated_seconds: float = 6.0,
    ) -> Optional[str]:
        """Render an overlay PNG and composite it over a video clip.

        Either ``frame_data`` must be supplied directly, or ``project_dir``
        must be given so the frame data can be built from telemetry.

        Args:
            clip_path:        Path to the source .mp4 clip.
            template_id:      Overlay template to render (e.g. ``"broadcast"``).
            output_path:      Where to save the composited .mp4.
            overlay_engine:   An initialised
                              :class:`~server.utils.overlay_engine.OverlayEngine`
                              instance.
            frame_data:       Pre-built frame_data dict.  If ``None``,
                              built from telemetry using the other kwargs.
            project_dir:      Project directory (for telemetry lookup).
            session_time:     Replay time in seconds for the telemetry query.
            section:          Video section (``intro``, ``race``, etc.).
            focused_car_idx:  iRacing car index of the hero driver.
            series_name:      Racing series label.
            track_name:       Track name label.
            temp_dir:         Directory for the temporary PNG file.
                              Uses :mod:`tempfile` when ``None``.

        Returns:
            ``output_path`` on success, ``None`` on failure.
        """
        diagnostics: dict[str, Any] = {
            "mode": "static",
            "template_id": template_id,
            "section": section,
            "clip_duration_seconds": float(clip_duration_seconds or 0.0),
            "trigger_sensitivity": float(trigger_sensitivity or 1.0),
            "cooldown_frames": int(cooldown_frames or 0),
            "max_animated_seconds": float(max_animated_seconds or 0.0),
        }

        # 1. Build frame_data from telemetry if not provided
        if frame_data is None:
            if not project_dir:
                logger.error(
                    "[OverlayCompositor] Either frame_data or project_dir must be provided"
                )
                self._set_last_diagnostics({**diagnostics, "error": "missing_frame_data"})
                return None
            from server.utils.frame_data_builder import build_frame_data
            frame_data = build_frame_data(
                project_dir=project_dir,
                session_time=session_time,
                section=section,
                focused_car_idx=focused_car_idx,
                series_name=series_name,
                track_name=track_name,
            )

        # Prefer real plugin data when a subsession context is available.
        if subsession_id > 0:
            try:
                from server.services.data_plugin_service import data_plugin_service
                frame_data = await data_plugin_service.enrich_frame_data(frame_data, subsession_id)
            except Exception as exc:
                logger.warning("[OverlayCompositor] Plugin enrichment failed: %s", exc)

        # 2. Write overlay PNG to a temp file in a resolved directory
        use_temp = temp_dir is None
        tmp_dir_obj = tempfile.mkdtemp() if use_temp else None
        # Resolve the temp directory to a clean absolute path
        png_dir = Path(tmp_dir_obj or temp_dir).resolve()  # lgtm[py/path-injection]
        # Use only the stem (filename without extension) from clip_path to keep the
        # PNG filename local to the temp directory — avoids injecting user path data
        clip_stem = Path(clip_path).stem[:64]  # cap length to avoid overly long names  # lgtm[py/path-injection]
        png_path = str(png_dir / f"overlay_{clip_stem}.png")

        try:
            clip_duration = max(0.0, float(clip_duration_seconds or 0.0))
            clip_fps = 0.0
            if clip_duration <= 0 or animation_orchestration:
                probed_duration, probed_fps = self._probe_clip_timing(clip_path)
                if clip_duration <= 0:
                    clip_duration = probed_duration
                clip_fps = probed_fps
            diagnostics["clip_duration_seconds"] = round(clip_duration, 3)
            diagnostics["clip_fps"] = round(clip_fps, 3) if clip_fps > 0 else None

            render_result = await overlay_engine.render_frame(
                template_id=template_id,
                frame_data=frame_data,
                output_path=png_path,
                analyze_animations=animation_orchestration,
            )

            resolved_png = Path(png_path).resolve()  # lgtm[py/path-injection]
            if not render_result.get("success") or not resolved_png.is_file():  # lgtm[py/path-injection]
                diagnostics.update({
                    "error": "render_failed",
                    "render_error": render_result.get("error"),
                    "render_error_type": render_result.get("error_type"),
                    "render_undefined_var": render_result.get("undefined_var"),
                    "render_elapsed_ms": render_result.get("elapsed_ms"),
                    "template_id": template_id,
                    "clip_path": clip_path,
                })
                logger.error(
                    "[OverlayCompositor] Overlay render failed for template=%s section=%s clip=%s error=%s error_type=%s undefined_var=%s",
                    template_id,
                    section,
                    clip_path,
                    render_result.get("error"),
                    render_result.get("error_type"),
                    render_result.get("undefined_var"),
                )
                self._set_last_diagnostics(diagnostics)
                return None

            animation_profile = render_result.get("animation_profile") or {}
            diagnostics["animation_profile"] = animation_profile

            static_path = self.composite_clip(clip_path, str(resolved_png), output_path)
            if not animation_orchestration:
                diagnostics["reason"] = "animation_orchestration_disabled"
                self._set_last_diagnostics(diagnostics)
                return static_path

            if not animation_profile.get("has_keyframes"):
                diagnostics["reason"] = "no_keyframe_animations_detected"
                self._set_last_diagnostics(diagnostics)
                return static_path

            if not animation_profile.get("supports_timeline_seek"):
                diagnostics["reason"] = "animations_not_seekable"
                self._set_last_diagnostics(diagnostics)
                return static_path

            if not project_dir:
                diagnostics["reason"] = "project_dir_required_for_animation_sampling"
                self._set_last_diagnostics(diagnostics)
                return static_path

            if clip_duration <= 0 or clip_fps <= 0:
                diagnostics["reason"] = "clip_timing_unavailable"
                self._set_last_diagnostics(diagnostics)
                return static_path

            from server.utils.frame_data_builder import build_frame_data

            async def build_sample_frame(elapsed: float) -> dict[str, Any]:
                sampled = build_frame_data(
                    project_dir=project_dir,
                    session_time=session_time + elapsed,
                    section=section,
                    focused_car_idx=focused_car_idx,
                    series_name=series_name,
                    track_name=track_name,
                )
                if subsession_id > 0:
                    try:
                        from server.services.data_plugin_service import data_plugin_service
                        sampled = await data_plugin_service.enrich_frame_data(sampled, subsession_id)
                    except Exception as exc:
                        logger.warning("[OverlayCompositor] Sample plugin enrichment failed: %s", exc)
                sampled["overlay_clip_elapsed_seconds"] = round(elapsed, 4)
                sampled["overlay_clip_duration_seconds"] = round(clip_duration, 4)
                return sampled

            samples = await self._build_frame_samples(clip_duration, clip_fps, build_sample_frame)
            if not samples:
                diagnostics["reason"] = "no_samples_generated"
                self._set_last_diagnostics(diagnostics)
                return static_path

            windows = self._build_animation_windows(
                samples=samples,
                fps=clip_fps,
                animation_profile=animation_profile,
                trigger_sensitivity=trigger_sensitivity,
                cooldown_frames=cooldown_frames,
                max_animated_seconds=max_animated_seconds,
            )
            if not windows:
                diagnostics["reason"] = "no_significant_frame_changes"
                self._set_last_diagnostics(diagnostics)
                return static_path

            timeline_overlays: list[dict[str, Any]] = []
            static_cache: dict[str, str] = {
                build_render_signature(frame_data): str(resolved_png),
            }
            cursor_time = 0.0

            for window_index, window in enumerate(windows):
                window_start = float(window.get("start", 0.0) or 0.0)
                window_end = min(clip_duration, float(window.get("end", window_start) or window_start))
                if window_end <= window_start:
                    continue

                if window_start > cursor_time:
                    static_idx = min(len(samples) - 1, max(0, int(math.floor(cursor_time * clip_fps))))
                    static_frame = dict(samples[static_idx]["frame_data"])
                    static_signature = build_render_signature(static_frame)
                    if static_signature not in static_cache:
                        static_png_path = str(png_dir / f"overlay_{clip_stem}_static_{len(static_cache):02d}.png")
                        static_render = await overlay_engine.render_frame(
                            template_id=template_id,
                            frame_data=static_frame,
                            output_path=static_png_path,
                        )
                        resolved_static = Path(static_png_path).resolve()
                        if not static_render.get("success") or not resolved_static.is_file():
                            diagnostics["reason"] = "static_segment_render_failed"
                            self._set_last_diagnostics(diagnostics)
                            return static_path
                        static_cache[static_signature] = str(resolved_static)

                    timeline_overlays.append({
                        "type": "static",
                        "path": static_cache[static_signature],
                        "start": cursor_time,
                        "end": window_start,
                    })

                start_index, end_index = window_indices_for_time_range(window_start, window_end, clip_fps)
                sequence_dir = png_dir / f"overlay_{clip_stem}_seq_{window_index:02d}"
                sequence_dir.mkdir(parents=True, exist_ok=True)

                frame_counter = 0
                for sample in samples[start_index:min(len(samples), end_index + 1)]:
                    progress_ms = max(0.0, (float(sample["elapsed"]) - window_start) * 1000.0)
                    animated_frame = dict(sample["frame_data"])
                    animated_frame["animation_triggers"] = list(window.get("reasons") or [])
                    animated_frame["animation_state"] = {
                        "active": True,
                        "progress_ms": round(progress_ms, 2),
                        "reason": list(window.get("reasons") or []),
                    }
                    frame_png_path = str(sequence_dir / f"frame_{frame_counter:06d}.png")
                    sequence_render = await overlay_engine.render_frame(
                        template_id=template_id,
                        frame_data=animated_frame,
                        output_path=frame_png_path,
                        animation_time_ms=progress_ms,
                    )
                    resolved_frame = Path(frame_png_path).resolve()
                    if not sequence_render.get("success") or not resolved_frame.is_file():
                        diagnostics["reason"] = "animated_sequence_render_failed"
                        self._set_last_diagnostics(diagnostics)
                        return static_path
                    frame_counter += 1

                if frame_counter > 0:
                    timeline_overlays.append({
                        "type": "sequence",
                        "pattern": str((sequence_dir / "frame_%06d.png").resolve()),
                        "start_number": 0,
                        "fps": clip_fps,
                        "start": window_start,
                        "end": window_end,
                    })

                cursor_time = window_end

            if cursor_time < clip_duration:
                static_idx = min(len(samples) - 1, max(0, int(math.floor(cursor_time * clip_fps))))
                trailing_frame = dict(samples[static_idx]["frame_data"])
                trailing_signature = build_render_signature(trailing_frame)
                if trailing_signature not in static_cache:
                    trailing_png_path = str(png_dir / f"overlay_{clip_stem}_static_tail.png")
                    trailing_render = await overlay_engine.render_frame(
                        template_id=template_id,
                        frame_data=trailing_frame,
                        output_path=trailing_png_path,
                    )
                    resolved_trailing = Path(trailing_png_path).resolve()
                    if not trailing_render.get("success") or not resolved_trailing.is_file():
                        diagnostics["reason"] = "trailing_static_render_failed"
                        self._set_last_diagnostics(diagnostics)
                        return static_path
                    static_cache[trailing_signature] = str(resolved_trailing)

                timeline_overlays.append({
                    "type": "static",
                    "path": static_cache[trailing_signature],
                    "start": cursor_time,
                    "end": clip_duration,
                })

            result_path = self.composite_clip_with_timeline_overlays(
                clip_path=clip_path,
                timeline_overlays=timeline_overlays,
                output_path=output_path,
            )
            diagnostics.update({
                "mode": "animated",
                "reason": "timeline_windows_rendered",
                "window_count": len(windows),
                "timeline_overlay_count": len(timeline_overlays),
                "windows": windows,
            })
            self._set_last_diagnostics(diagnostics)
            return result_path or static_path

        finally:
            # Clean up temp PNG
            try:
                for file_path in png_dir.rglob("*.png"):
                    file_path.resolve().unlink(missing_ok=True)
                for dir_path in sorted(
                    [path for path in png_dir.rglob("*") if path.is_dir()],
                    reverse=True,
                ):
                    dir_path.resolve().rmdir()
                if use_temp and tmp_dir_obj:
                    Path(tmp_dir_obj).resolve().rmdir()
            except OSError:
                pass

    async def render_preset_and_composite(
        self,
        clip_path: str,
        preset_id: str,
        section: str,
        output_path: str,
        overlay_engine: Any,
        frame_data: Optional[dict[str, Any]] = None,
        project_dir: Optional[str] = None,
        session_time: float = 0.0,
        focused_car_idx: Optional[int] = None,
        series_name: str = "",
        track_name: str = "",
        subsession_id: int = 0,
        clip_duration_seconds: float = 0.0,
        temp_dir: Optional[str] = None,
        animation_orchestration: bool = True,
        trigger_sensitivity: float = 1.0,
        cooldown_frames: int = 12,
        max_animated_seconds: float = 6.0,
    ) -> Optional[str]:
        """Render a preset's elements and composite over a video clip.

        Similar to ``render_and_composite`` but uses the preset's per-section
        element configuration instead of a single monolithic template.

        Args:
            clip_path:        Path to the source .mp4 clip.
            preset_id:        Preset ID to use for element configuration.
            section:          Video section (intro, race, etc.)
            output_path:      Where to save the composited .mp4.
            overlay_engine:   An initialised OverlayEngine instance.
            frame_data:       Pre-built frame_data dict (optional).
            project_dir:      Project directory for telemetry lookup.
            session_time:     Replay time in seconds.
            focused_car_idx:  iRacing car index of the hero driver.
            series_name:      Racing series label.
            track_name:       Track name label.
            temp_dir:         Directory for temp PNG files.

        Returns:
            ``output_path`` on success, ``None`` on failure.
        """
        from server.services.preset_service import preset_service
        from server.utils.element_renderer import compose_preset_html

        diagnostics: dict[str, Any] = {
            "mode": "static",
            "preset_id": preset_id,
            "section": section,
            "clip_duration_seconds": float(clip_duration_seconds or 0.0),
            "trigger_sensitivity": float(trigger_sensitivity or 1.0),
            "cooldown_frames": int(cooldown_frames or 0),
            "max_animated_seconds": float(max_animated_seconds or 0.0),
        }

        # 1. Get the preset
        preset = preset_service.get_preset(preset_id)
        if not preset:
            logger.error("[OverlayCompositor] Preset not found: %s", preset_id)
            self._set_last_diagnostics({**diagnostics, "error": "preset_not_found"})
            return None

        # 2. Build frame_data if not provided
        if frame_data is None:
            if not project_dir:
                logger.error("[OverlayCompositor] Either frame_data or project_dir required")
                self._set_last_diagnostics({**diagnostics, "error": "missing_frame_data"})
                return None
            from server.utils.frame_data_builder import build_frame_data
            frame_data = build_frame_data(
                project_dir=project_dir,
                session_time=session_time,
                section=section,
                focused_car_idx=focused_car_idx,
                series_name=series_name,
                track_name=track_name,
            )

        # Prefer real plugin data when a subsession context is available.
        if subsession_id > 0:
            try:
                from server.services.data_plugin_service import data_plugin_service
                frame_data = await data_plugin_service.enrich_frame_data(frame_data, subsession_id)
            except Exception as exc:
                logger.warning("[OverlayCompositor] Preset plugin enrichment failed: %s", exc)

        # 3. Build pagination schedule (if enabled for this section).
        schedule = self._build_pagination_schedule(
            preset=preset,
            section=section,
            frame_data=frame_data,
            clip_duration_seconds=max(0.0, float(clip_duration_seconds or 0.0)),
        )

        # 4. Render HTML page(s) to PNG via overlay engine
        resolution = overlay_engine.resolution

        use_temp = temp_dir is None
        tmp_dir_obj = tempfile.mkdtemp() if use_temp else None
        png_dir = Path(tmp_dir_obj or temp_dir).resolve()  # lgtm[py/path-injection]
        clip_stem = Path(clip_path).stem[:64]  # lgtm[py/path-injection]
        png_path = str(png_dir / f"preset_overlay_{clip_stem}.png")

        try:
            clip_duration = max(0.0, float(clip_duration_seconds or 0.0))
            clip_fps = 0.0
            if clip_duration <= 0 or animation_orchestration:
                probed_duration, probed_fps = self._probe_clip_timing(clip_path)
                if clip_duration <= 0:
                    clip_duration = probed_duration
                clip_fps = probed_fps
            diagnostics["clip_duration_seconds"] = round(clip_duration, 3)
            diagnostics["clip_fps"] = round(clip_fps, 3) if clip_fps > 0 else None

            initial_page_index = self._resolve_page_index(schedule, 0.0) if schedule else None
            initial_frame_data = {
                **frame_data,
                "overlay_clip_elapsed_seconds": 0.0,
                "overlay_clip_duration_seconds": round(clip_duration, 4),
            }
            if initial_page_index is not None:
                initial_frame_data["overlay_page_index"] = initial_page_index

            html_content = compose_preset_html(
                preset=preset,
                section=section,
                frame_data=initial_frame_data,
                resolution=resolution,
                page_index=initial_page_index,
            )
            render_result = await overlay_engine.render_raw_html(
                html_content,
                initial_frame_data,
                output_path=png_path,
                analyze_animations=animation_orchestration,
            )

            resolved_png = Path(png_path).resolve()  # lgtm[py/path-injection]
            if not render_result.get("success") or not resolved_png.is_file():
                logger.error("[OverlayCompositor] Preset render failed for %s", preset_id)
                self._set_last_diagnostics({**diagnostics, "error": "render_failed"})
                return None

            animation_profile = render_result.get("animation_profile") or {}
            diagnostics["animation_profile"] = animation_profile

            # Pagination without animation orchestration keeps the existing static-per-page path.
            if schedule and (
                not animation_orchestration
                or not animation_profile.get("has_keyframes")
                or not animation_profile.get("supports_timeline_seek")
                or clip_duration <= 0
                or clip_fps <= 0
            ):
                page_png_paths: dict[int, str] = {}
                timed_overlays: list[dict[str, float | str]] = []

                for item in schedule:
                    page_index = int(item["page_index"])
                    if page_index not in page_png_paths:
                        page_png = str(png_dir / f"preset_overlay_{clip_stem}_p{page_index}.png")
                        page_frame_data = {
                            **frame_data,
                            "overlay_clip_elapsed_seconds": float(item["start"]),
                            "overlay_clip_duration_seconds": float(clip_duration),
                            "overlay_page_index": page_index,
                        }
                        page_html = compose_preset_html(
                            preset=preset,
                            section=section,
                            frame_data=page_frame_data,
                            resolution=resolution,
                            page_index=page_index,
                        )
                        page_result = await overlay_engine.render_raw_html(
                            page_html, page_frame_data, output_path=page_png
                        )
                        resolved_page_png = Path(page_png).resolve()
                        if not page_result.get("success") or not resolved_page_png.is_file():
                            logger.error(
                                "[OverlayCompositor] Preset paginated render failed for %s page %d",
                                preset_id,
                                page_index,
                            )
                            self._set_last_diagnostics({**diagnostics, "error": "pagination_render_failed"})
                            return None
                        page_png_paths[page_index] = str(resolved_page_png)

                    timed_overlays.append({
                        "path": page_png_paths[page_index],
                        "start": float(item["start"]),
                        "end": float(item["end"]),
                    })

                diagnostics["reason"] = (
                    "pagination_static" if schedule else "static"
                )
                diagnostics["window_count"] = len(timed_overlays)
                self._set_last_diagnostics(diagnostics)
                return self.composite_clip_with_timed_overlays(
                    clip_path=clip_path,
                    timed_overlays=timed_overlays,
                    output_path=output_path,
                )

            static_path = self.composite_clip(clip_path, str(resolved_png), output_path)
            if not animation_orchestration:
                diagnostics["reason"] = "animation_orchestration_disabled"
                self._set_last_diagnostics(diagnostics)
                return static_path

            if not animation_profile.get("has_keyframes"):
                diagnostics["reason"] = "no_keyframe_animations_detected"
                self._set_last_diagnostics(diagnostics)
                return static_path

            if not animation_profile.get("supports_timeline_seek"):
                diagnostics["reason"] = "animations_not_seekable"
                self._set_last_diagnostics(diagnostics)
                return static_path

            if clip_duration <= 0 or clip_fps <= 0:
                diagnostics["reason"] = "clip_timing_unavailable"
                self._set_last_diagnostics(diagnostics)
                return static_path

            from server.utils.frame_data_builder import build_frame_data

            async def build_sample_frame(elapsed: float) -> dict[str, Any]:
                if project_dir:
                    sampled = build_frame_data(
                        project_dir=project_dir,
                        session_time=session_time + elapsed,
                        section=section,
                        focused_car_idx=focused_car_idx,
                        series_name=series_name,
                        track_name=track_name,
                    )
                else:
                    sampled = dict(frame_data)
                if subsession_id > 0:
                    try:
                        from server.services.data_plugin_service import data_plugin_service
                        sampled = await data_plugin_service.enrich_frame_data(sampled, subsession_id)
                    except Exception as exc:
                        logger.warning("[OverlayCompositor] Preset sample plugin enrichment failed: %s", exc)
                sampled["overlay_clip_elapsed_seconds"] = round(elapsed, 4)
                sampled["overlay_clip_duration_seconds"] = round(clip_duration, 4)
                page_index = self._resolve_page_index(schedule, elapsed) if schedule else None
                if page_index is not None:
                    sampled["overlay_page_index"] = page_index
                return sampled

            samples = await self._build_frame_samples(clip_duration, clip_fps, build_sample_frame)
            if not samples:
                diagnostics["reason"] = "no_samples_generated"
                self._set_last_diagnostics(diagnostics)
                return static_path

            windows = self._build_animation_windows(
                samples=samples,
                fps=clip_fps,
                animation_profile=animation_profile,
                trigger_sensitivity=trigger_sensitivity,
                cooldown_frames=cooldown_frames,
                max_animated_seconds=max_animated_seconds,
            )
            if not windows:
                diagnostics["reason"] = "no_significant_frame_changes"
                self._set_last_diagnostics(diagnostics)
                return static_path

            timeline_overlays: list[dict[str, Any]] = []
            static_cache: dict[str, str] = {
                build_render_signature(initial_frame_data): str(resolved_png),
            }
            cursor_time = 0.0

            for window_index, window in enumerate(windows):
                window_start = float(window.get("start", 0.0) or 0.0)
                window_end = min(clip_duration, float(window.get("end", window_start) or window_start))
                if window_end <= window_start:
                    continue

                if window_start > cursor_time:
                    static_idx = min(len(samples) - 1, max(0, int(math.floor(cursor_time * clip_fps))))
                    static_frame = dict(samples[static_idx]["frame_data"])
                    static_signature = build_render_signature(static_frame)
                    if static_signature not in static_cache:
                        page_index = static_frame.get("overlay_page_index")
                        static_png_path = str(png_dir / f"preset_overlay_{clip_stem}_static_{len(static_cache):02d}.png")
                        static_html = compose_preset_html(
                            preset=preset,
                            section=section,
                            frame_data=static_frame,
                            resolution=resolution,
                            page_index=page_index,
                        )
                        static_render = await overlay_engine.render_raw_html(
                            static_html,
                            static_frame,
                            output_path=static_png_path,
                        )
                        resolved_static = Path(static_png_path).resolve()
                        if not static_render.get("success") or not resolved_static.is_file():
                            diagnostics["reason"] = "static_segment_render_failed"
                            self._set_last_diagnostics(diagnostics)
                            return static_path
                        static_cache[static_signature] = str(resolved_static)

                    timeline_overlays.append({
                        "type": "static",
                        "path": static_cache[static_signature],
                        "start": cursor_time,
                        "end": window_start,
                    })

                start_index, end_index = window_indices_for_time_range(window_start, window_end, clip_fps)
                sequence_dir = png_dir / f"preset_overlay_{clip_stem}_seq_{window_index:02d}"
                sequence_dir.mkdir(parents=True, exist_ok=True)

                frame_counter = 0
                for sample in samples[start_index:min(len(samples), end_index + 1)]:
                    progress_ms = max(0.0, (float(sample["elapsed"]) - window_start) * 1000.0)
                    animated_frame = dict(sample["frame_data"])
                    animated_frame["animation_triggers"] = list(window.get("reasons") or [])
                    animated_frame["animation_state"] = {
                        "active": True,
                        "progress_ms": round(progress_ms, 2),
                        "reason": list(window.get("reasons") or []),
                    }
                    page_index = animated_frame.get("overlay_page_index")
                    frame_html = compose_preset_html(
                        preset=preset,
                        section=section,
                        frame_data=animated_frame,
                        resolution=resolution,
                        page_index=page_index,
                    )
                    frame_png_path = str(sequence_dir / f"frame_{frame_counter:06d}.png")
                    sequence_render = await overlay_engine.render_raw_html(
                        frame_html,
                        animated_frame,
                        output_path=frame_png_path,
                        animation_time_ms=progress_ms,
                    )
                    resolved_frame = Path(frame_png_path).resolve()
                    if not sequence_render.get("success") or not resolved_frame.is_file():
                        diagnostics["reason"] = "animated_sequence_render_failed"
                        self._set_last_diagnostics(diagnostics)
                        return static_path
                    frame_counter += 1

                if frame_counter > 0:
                    timeline_overlays.append({
                        "type": "sequence",
                        "pattern": str((sequence_dir / "frame_%06d.png").resolve()),
                        "start_number": 0,
                        "fps": clip_fps,
                        "start": window_start,
                        "end": window_end,
                    })

                cursor_time = window_end

            if cursor_time < clip_duration:
                static_idx = min(len(samples) - 1, max(0, int(math.floor(cursor_time * clip_fps))))
                trailing_frame = dict(samples[static_idx]["frame_data"])
                trailing_signature = build_render_signature(trailing_frame)
                if trailing_signature not in static_cache:
                    page_index = trailing_frame.get("overlay_page_index")
                    trailing_png_path = str(png_dir / f"preset_overlay_{clip_stem}_static_tail.png")
                    trailing_html = compose_preset_html(
                        preset=preset,
                        section=section,
                        frame_data=trailing_frame,
                        resolution=resolution,
                        page_index=page_index,
                    )
                    trailing_render = await overlay_engine.render_raw_html(
                        trailing_html,
                        trailing_frame,
                        output_path=trailing_png_path,
                    )
                    resolved_trailing = Path(trailing_png_path).resolve()
                    if not trailing_render.get("success") or not resolved_trailing.is_file():
                        diagnostics["reason"] = "trailing_static_render_failed"
                        self._set_last_diagnostics(diagnostics)
                        return static_path
                    static_cache[trailing_signature] = str(resolved_trailing)

                timeline_overlays.append({
                    "type": "static",
                    "path": static_cache[trailing_signature],
                    "start": cursor_time,
                    "end": clip_duration,
                })

            result_path = self.composite_clip_with_timeline_overlays(
                clip_path=clip_path,
                timeline_overlays=timeline_overlays,
                output_path=output_path,
            )
            diagnostics.update({
                "mode": "animated",
                "reason": "timeline_windows_rendered",
                "window_count": len(windows),
                "timeline_overlay_count": len(timeline_overlays),
                "windows": windows,
                "pagination_schedule": schedule,
            })
            self._set_last_diagnostics(diagnostics)
            return result_path or static_path

        finally:
            try:
                for file_path in png_dir.rglob("*.png"):
                    file_path.resolve().unlink(missing_ok=True)
                for dir_path in sorted(
                    [path for path in png_dir.rglob("*") if path.is_dir()],
                    reverse=True,
                ):
                    dir_path.resolve().rmdir()
                if use_temp and tmp_dir_obj:
                    Path(tmp_dir_obj).resolve().rmdir()
            except OSError:
                pass

    def composite_intro_video(
        self,
        base_clip_path: str,
        intro_video_path: str,
        output_path: str,
        opacity: float = 0.85,
        crf: int = 18,
        preset: str = "fast",
        timeout: int = 300,
    ) -> Optional[str]:
        """Composite an uploaded intro video over the intro section clip.

        The intro video is scaled to match the base clip's dimensions and
        overlaid with configurable opacity.  If the intro video is shorter
        than the base clip, the overlay ends when the intro video ends.
        If longer, it is trimmed to match the base clip's duration.

        Args:
            base_clip_path:   Path to the captured intro replay clip.
            intro_video_path: Path to the user-uploaded intro video.
            output_path:      Destination path for the composited output.
            opacity:          Overlay opacity (0.0–1.0, default 0.85).
            crf:              H.264 quality factor (lower = better).
            preset:           FFmpeg encoding preset.
            timeout:          Maximum FFmpeg runtime in seconds.

        Returns:
            ``output_path`` on success, ``None`` on failure.
        """
        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            logger.error("[OverlayCompositor] FFmpeg not found")
            return None

        try:
            safe_base = _safe_video_path(base_clip_path)
            safe_intro = _safe_video_path(intro_video_path)
            safe_output = _safe_output_path(output_path)
        except ValueError as exc:
            logger.error("[OverlayCompositor] Invalid path: %s", exc)
            return None

        if not Path(safe_base).is_file():
            logger.error("[OverlayCompositor] Base clip not found: %s", safe_base)
            return None
        if not Path(safe_intro).is_file():
            logger.error("[OverlayCompositor] Intro video not found: %s", safe_intro)
            return None

        # Scale the intro video, apply transparency, and overlay.
        # 'shortest=1' ensures the overlay ends when the shorter input ends.
        alpha = max(0.0, min(1.0, opacity))
        filter_complex = (
            "[1:v]scale=iw:ih,format=yuva420p,"
            f"colorchannelmixer=aa={alpha}[intro];"
            "[0:v][intro]overlay=0:0:shortest=1[out]"
        )

        cmd = [
            ffmpeg, "-hide_banner", "-loglevel", "warning", "-y",
            "-i", safe_base,
            "-i", safe_intro,
            "-filter_complex", filter_complex,
            "-map", "[out]",
            "-map", "0:a?",
            "-codec:a", "copy",
            "-codec:v", "libx264",
            "-preset", preset,
            "-crf", str(crf),
            safe_output,
        ]

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=timeout,
            )
            if result.returncode != 0:
                logger.error(
                    "[OverlayCompositor] Intro video composite failed (rc=%d): %s",
                    result.returncode,
                    result.stderr[:500],
                )
                return None
        except subprocess.TimeoutExpired:
            logger.error("[OverlayCompositor] Intro video composite timed out")
            return None
        except Exception as exc:
            logger.error("[OverlayCompositor] Intro video error: %s", exc)
            return None

        logger.info("[OverlayCompositor] Intro video composited → %s", safe_output)
        return safe_output

    async def composite_script_clips(
        self,
        clips: list[dict],
        overlay_engine: Any,
        output_dir: str,
        project_dir: Optional[str] = None,
        series_name: str = "",
        track_name: str = "",
        subsession_id: int = 0,
        focused_car_idx: Optional[int] = None,
        progress_callback: Optional[Any] = None,
        animation_orchestration: bool = True,
        trigger_sensitivity: float = 1.0,
        cooldown_frames: int = 12,
        max_animated_seconds: float = 6.0,
    ) -> list[dict]:
        """Composite overlays onto all clips in a script capture result.

        For each clip dict (as returned by
        :meth:`~server.utils.script_capture.ScriptCaptureEngine.capture_script`),
        renders the clip's ``overlay_template_id`` (falling back to
        ``"broadcast"``) and writes a new composited file alongside the original.

        Args:
            clips:             List of clip dicts with ``path``, ``section``,
                               ``start_time_seconds``, and optionally
                               ``overlay_template_id``.
            overlay_engine:    Initialised overlay engine.
            output_dir:        Directory to write composited clips.
            project_dir:       Project directory for telemetry lookup.
            series_name:       Series label for frame_data.
            track_name:        Track label for frame_data.
            focused_car_idx:   Hero driver for telemetry-based frame_data.
            progress_callback: Optional ``(index, total, clip_id) → None``.

        Returns:
            Updated clip list where each dict now has a
            ``composited_path`` key pointing to the new file.
        """
        output_path_obj = Path(output_dir).resolve()  # lgtm[py/path-injection]
        output_path_obj.mkdir(parents=True, exist_ok=True)  # lgtm[py/path-injection]
        results = []

        for i, clip in enumerate(clips):
            clip_id = clip.get("id", f"clip_{i}")
            clip_path = clip.get("path", "")
            section = clip.get("section", "race")
            session_time = clip.get("start_time_seconds", 0.0)
            clip_duration_seconds = float(clip.get("duration_seconds") or 0.0)
            if clip_duration_seconds <= 0:
                try:
                    start = float(clip.get("start_time_seconds") or 0.0)
                    end = float(clip.get("end_time_seconds") or 0.0)
                    if end > start:
                        clip_duration_seconds = end - start
                except (TypeError, ValueError):
                    clip_duration_seconds = 0.0
            template_id = clip.get("overlay_template_id", "broadcast")

            if progress_callback:
                try:
                    progress_callback(i, len(clips), clip_id)
                except Exception:
                        logger.debug("Suppressed exception in cleanup", exc_info=True)

            if not clip_path:
                logger.warning("[OverlayCompositor] Skipping clip with no path at index %d", i)
                results.append({**clip, "composited_path": None})
                continue

            # Validate the clip path — _safe_video_path resolves and checks extension
            try:
                safe_clip = _safe_video_path(clip_path)
            except ValueError as exc:
                logger.warning("[OverlayCompositor] Skipping invalid clip path: %s", exc)
                results.append({**clip, "composited_path": None})
                continue

            if not Path(safe_clip).is_file():
                logger.warning("[OverlayCompositor] Skipping missing clip: %s", safe_clip)
                results.append({**clip, "composited_path": None})
                continue

            # Build output filename from the resolved output dir + safe clip_id
            safe_id = re.sub(r"[^a-zA-Z0-9_\-]", "_", str(clip_id))[:64]
            composited_path = str(output_path_obj / f"{safe_id}_overlaid.mp4")

            # Check if this clip has a preset_id for element-based rendering
            clip_preset_id = clip.get("preset_id")
            if clip_preset_id:
                result_path = await self.render_preset_and_composite(
                    clip_path=safe_clip,
                    preset_id=clip_preset_id,
                    section=section,
                    output_path=composited_path,
                    overlay_engine=overlay_engine,
                    project_dir=project_dir,
                    session_time=session_time,
                    focused_car_idx=focused_car_idx,
                    series_name=series_name,
                    track_name=track_name,
                    subsession_id=subsession_id,
                    clip_duration_seconds=clip_duration_seconds,
                    animation_orchestration=animation_orchestration,
                    trigger_sensitivity=trigger_sensitivity,
                    cooldown_frames=cooldown_frames,
                    max_animated_seconds=max_animated_seconds,
                )
            else:
                result_path = await self.render_and_composite(
                    clip_path=safe_clip,
                    template_id=template_id,
                    output_path=composited_path,
                    overlay_engine=overlay_engine,
                    project_dir=project_dir,
                    session_time=session_time,
                    section=section,
                    focused_car_idx=focused_car_idx,
                    series_name=series_name,
                    track_name=track_name,
                    subsession_id=subsession_id,
                    clip_duration_seconds=clip_duration_seconds,
                    animation_orchestration=animation_orchestration,
                    trigger_sensitivity=trigger_sensitivity,
                    cooldown_frames=cooldown_frames,
                    max_animated_seconds=max_animated_seconds,
                )

            results.append({
                **clip,
                "composited_path": result_path,
                "overlay_diagnostics": self.last_diagnostics,
            })

        return results


# ── Module-level singleton ───────────────────────────────────────────────────

overlay_compositor = OverlayCompositor()
