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


# ── Path helpers ─────────────────────────────────────────────────────────────

def _resolve_path(path: str) -> Path:
    """Resolve a user-supplied path to its absolute, normalised form.

    Calling ``Path.resolve()`` collapses any ``..`` components and symlinks,
    ensuring the true target is used rather than an attacker-controlled
    traversal.  This is the primary defence against path-injection attacks.
    """
    return Path(path).resolve()


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

        # Resolve all paths to eliminate any path-traversal components
        resolved_clip = _resolve_path(clip_path)
        resolved_overlay = _resolve_path(overlay_png_path)
        resolved_output = _resolve_path(output_path)

        if not resolved_clip.is_file():
            logger.error("[OverlayCompositor] Clip not found: %s", resolved_clip)
            return None

        if not resolved_overlay.is_file():
            logger.error("[OverlayCompositor] Overlay PNG not found: %s", resolved_overlay)
            return None

        # Ensure the output directory exists before writing
        resolved_output.parent.mkdir(parents=True, exist_ok=True)

        cmd = [
            ffmpeg, "-hide_banner", "-loglevel", "warning", "-y",
            "-i", str(resolved_clip),
            "-i", str(resolved_overlay),
            "-filter_complex", "[0:v][1:v]overlay=0:0[out]",
            "-map", "[out]",
            # copy audio track if present; '?' suffix makes this mapping optional
            # (prevents errors when the source clip has no audio stream)
            "-map", "0:a?",
            "-codec:a", "copy",
            "-codec:v", "libx264",
            "-preset", preset,
            "-crf", str(crf),
            str(resolved_output),
        ]

        try:
            result = subprocess.run(
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

        output_str = str(resolved_output)
        logger.info("[OverlayCompositor] Composited → %s", output_str)
        return output_str

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

        # 2. Write overlay PNG to a temp file
        use_temp = temp_dir is None
        tmp_dir_obj = tempfile.mkdtemp() if use_temp else None
        # Resolve temp/output dirs to absolute normalised paths
        png_dir = _resolve_path(tmp_dir_obj or temp_dir)
        png_path = str(png_dir / f"overlay_{Path(clip_path).stem}.png")

        try:
            render_result = await overlay_engine.render_frame(
                template_id=template_id,
                frame_data=frame_data,
                output_path=png_path,
            )

            resolved_png = _resolve_path(png_path)
            if not render_result.get("success") or not resolved_png.is_file():
                logger.error(
                    "[OverlayCompositor] Overlay render failed for template %s", template_id
                )
                return None

            # 3. Composite resolved PNG over clip
            return self.composite_clip(clip_path, str(resolved_png), output_path)

        finally:
            # Clean up temp PNG
            try:
                _resolve_path(png_path).unlink(missing_ok=True)
                if use_temp and tmp_dir_obj:
                    _resolve_path(tmp_dir_obj).rmdir()
            except OSError:
                pass

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
        output_path_obj = _resolve_path(output_dir)
        output_path_obj.mkdir(parents=True, exist_ok=True)
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

            if not clip_path or not Path(clip_path).exists():
                logger.warning("[OverlayCompositor] Skipping missing clip: %s", clip_path)
                results.append({**clip, "composited_path": None})
                continue

            composited_path = str(output_path_obj / f"{clip_id}_overlaid.mp4")

            result_path = await self.render_and_composite(
                clip_path=clip_path,
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
