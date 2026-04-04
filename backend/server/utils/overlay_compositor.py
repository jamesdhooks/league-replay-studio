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
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Optional

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
            "-filter_complex", "[0:v][1:v]overlay=0:0[out]",
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
        temp_dir: Optional[str] = None,
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
        # 1. Build frame_data from telemetry if not provided
        if frame_data is None:
            if not project_dir:
                logger.error(
                    "[OverlayCompositor] Either frame_data or project_dir must be provided"
                )
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
            render_result = await overlay_engine.render_frame(
                template_id=template_id,
                frame_data=frame_data,
                output_path=png_path,
            )

            resolved_png = Path(png_path).resolve()  # lgtm[py/path-injection]
            if not render_result.get("success") or not resolved_png.is_file():  # lgtm[py/path-injection]
                logger.error(
                    "[OverlayCompositor] Overlay render failed for template %s", template_id
                )
                return None

            # 3. Composite the validated PNG over the clip
            return self.composite_clip(clip_path, str(resolved_png), output_path)

        finally:
            # Clean up temp PNG
            try:
                Path(png_path).resolve().unlink(missing_ok=True)
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
        temp_dir: Optional[str] = None,
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

        # 1. Get the preset
        preset = preset_service.get_preset(preset_id)
        if not preset:
            logger.error("[OverlayCompositor] Preset not found: %s", preset_id)
            return None

        # 2. Build frame_data if not provided
        if frame_data is None:
            if not project_dir:
                logger.error("[OverlayCompositor] Either frame_data or project_dir required")
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

        # 3. Compose the preset's elements into a single HTML document
        resolution = overlay_engine.resolution
        html_content = compose_preset_html(
            preset=preset,
            section=section,
            frame_data=frame_data,
            resolution=resolution,
        )

        # 4. Render HTML to PNG via overlay engine
        use_temp = temp_dir is None
        tmp_dir_obj = tempfile.mkdtemp() if use_temp else None
        png_dir = Path(tmp_dir_obj or temp_dir).resolve()  # lgtm[py/path-injection]
        clip_stem = Path(clip_path).stem[:64]  # lgtm[py/path-injection]
        png_path = str(png_dir / f"preset_overlay_{clip_stem}.png")

        try:
            render_result = await overlay_engine.render_raw_html(
                html_content, frame_data, output_path=png_path
            )

            resolved_png = Path(png_path).resolve()  # lgtm[py/path-injection]
            if not render_result.get("success") or not resolved_png.is_file():
                logger.error("[OverlayCompositor] Preset render failed for %s", preset_id)
                return None

            return self.composite_clip(clip_path, str(resolved_png), output_path)

        finally:
            try:
                Path(png_path).resolve().unlink(missing_ok=True)
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
        focused_car_idx: Optional[int] = None,
        progress_callback: Optional[Any] = None,
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
            template_id = clip.get("overlay_template_id", "broadcast")

            if progress_callback:
                try:
                    progress_callback(i, len(clips), clip_id)
                except Exception:
                    pass

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
                )

            results.append({**clip, "composited_path": result_path})

        return results


# ── Module-level singleton ───────────────────────────────────────────────────

overlay_compositor = OverlayCompositor()
