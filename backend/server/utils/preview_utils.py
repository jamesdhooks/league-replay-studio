"""
preview_utils.py
-----------------
FFmpeg-based utilities for video preview generation.

Provides functions for tiered preview generation:
  1. Keyframe index — extract keyframe timestamps (~5 s)
  2. Sprite sheet thumbnails — generate contact sheets for timeline scrubbing (~30–60 s)
  3. Proxy video — transcode to 540p30 for playback (~1–3 min)
  4. Full-resolution frame — extract a single frame at a given timestamp
  5. Audio extraction — extract audio track to separate file (~5 s)
  6. Video info — duration, resolution, fps, codec metadata
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


# ── FFmpeg discovery ────────────────────────────────────────────────────────

def _find_binary(name: str) -> Optional[str]:
    """Find an FFmpeg binary (ffmpeg or ffprobe) on the system PATH."""
    import shutil
    return shutil.which(name)


def _get_ffmpeg() -> str:
    """Return the path to ffmpeg, or raise if not found."""
    path = _find_binary("ffmpeg")
    if not path:
        raise FileNotFoundError("ffmpeg not found on PATH")
    return path


def _get_ffprobe() -> str:
    """Return the path to ffprobe, or raise if not found."""
    path = _find_binary("ffprobe")
    if not path:
        raise FileNotFoundError("ffprobe not found on PATH")
    return path


# ── Video info ──────────────────────────────────────────────────────────────

def get_video_info(input_file: str) -> dict[str, Any]:
    """Get video file metadata using ffprobe.
    
    Returns:
        Dict with keys: duration, width, height, fps, codec, audio_codec,
        file_size, format_name.
    """
    ffprobe = _get_ffprobe()
    cmd = [
        ffprobe, "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        input_file,
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            logger.error("[Preview] ffprobe error: %s", result.stderr)
            return {}
        
        data = json.loads(result.stdout)
        fmt = data.get("format", {})
        
        video_stream = None
        audio_stream = None
        for stream in data.get("streams", []):
            if stream.get("codec_type") == "video" and not video_stream:
                video_stream = stream
            elif stream.get("codec_type") == "audio" and not audio_stream:
                audio_stream = stream
        
        duration = float(fmt.get("duration", 0))
        
        info: dict[str, Any] = {
            "duration": duration,
            "file_size": int(fmt.get("size", 0)),
            "format_name": fmt.get("format_name", ""),
        }
        
        if video_stream:
            info["width"] = int(video_stream.get("width", 0))
            info["height"] = int(video_stream.get("height", 0))
            info["codec"] = video_stream.get("codec_name", "")
            # Parse fps from r_frame_rate (e.g. "60/1")
            r_fps = video_stream.get("r_frame_rate", "0/1")
            if "/" in r_fps:
                num, den = r_fps.split("/")
                info["fps"] = round(float(num) / float(den), 2) if float(den) else 0
            else:
                info["fps"] = float(r_fps)
        
        if audio_stream:
            info["audio_codec"] = audio_stream.get("codec_name", "")
            info["audio_sample_rate"] = int(audio_stream.get("sample_rate", 0))
        
        return info
    except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError) as exc:
        logger.error("[Preview] Failed to get video info: %s", exc)
        return {}


# ── Keyframe index ──────────────────────────────────────────────────────────

def build_keyframe_index(input_file: str, output_file: str) -> list[float]:
    """Extract keyframe timestamps from a video file.
    
    Uses ffprobe to find all I-frame (keyframe) timestamps.
    Writes the index as JSON to output_file.
    
    Args:
        input_file: Source video path.
        output_file: Path to write keyframe index JSON.
    
    Returns:
        List of keyframe timestamps in seconds.
    """
    ffprobe = _get_ffprobe()
    cmd = [
        ffprobe, "-v", "quiet",
        "-select_streams", "v:0",
        "-show_entries", "packet=pts_time,flags",
        "-of", "csv=print_section=0",
        input_file,
    ]
    
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0:
            logger.error("[Preview] Keyframe index error: %s", result.stderr)
            return []
        
        keyframes: list[float] = []
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            parts = line.split(",")
            if len(parts) >= 2 and "K" in parts[1]:
                try:
                    ts = float(parts[0])
                    keyframes.append(round(ts, 3))
                except (ValueError, IndexError):
                    continue
        
        # Write index to file
        Path(output_file).parent.mkdir(parents=True, exist_ok=True)
        Path(output_file).write_text(
            json.dumps({"keyframes": keyframes, "count": len(keyframes)}, indent=2),
            encoding="utf-8",
        )
        
        logger.info("[Preview] Keyframe index: %d keyframes from %s", len(keyframes), input_file)
        return keyframes
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.error("[Preview] Keyframe index failed: %s", exc)
        return []


# ── Sprite sheet generation ─────────────────────────────────────────────────

def generate_sprite_sheets(
    input_file: str,
    output_dir: str,
    duration: float,
    thumb_width: int = 160,
    thumb_height: int = 90,
    cols: int = 10,
    rows: int = 10,
    interval: float = 1.0,
    on_progress: Any = None,
) -> list[dict[str, Any]]:
    """Generate sprite sheet contact images for timeline scrubbing.
    
    Each sprite sheet contains cols × rows thumbnails at the given interval.
    
    Args:
        input_file: Source video path.
        output_dir: Directory to write sprite sheet images.
        duration: Video duration in seconds.
        thumb_width: Width of each thumbnail.
        thumb_height: Height of each thumbnail.
        cols: Number of columns per sheet.
        rows: Number of rows per sheet.
        interval: Seconds between thumbnails.
        on_progress: Optional callback(percentage: float).
    
    Returns:
        List of sprite sheet metadata dicts.
    """
    ffmpeg = _get_ffmpeg()
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    
    thumbs_per_sheet = cols * rows
    total_thumbs = max(1, int(math.ceil(duration / interval)))
    num_sheets = max(1, int(math.ceil(total_thumbs / thumbs_per_sheet)))
    
    sheets: list[dict[str, Any]] = []
    
    for sheet_idx in range(num_sheets):
        start_thumb = sheet_idx * thumbs_per_sheet
        start_time = start_thumb * interval
        end_thumb = min(start_thumb + thumbs_per_sheet, total_thumbs)
        count = end_thumb - start_thumb
        
        actual_rows = max(1, int(math.ceil(count / cols)))
        sheet_file = str(Path(output_dir) / f"sprite_{sheet_idx:04d}.jpg")
        
        # Use the fps filter to extract frames at the interval, then tile them
        cmd = [
            ffmpeg, "-y",
            "-ss", str(start_time),
            "-t", str(count * interval),
            "-i", input_file,
            "-vf", (
                f"fps=1/{interval},"
                f"scale={thumb_width}:{thumb_height}:force_original_aspect_ratio=decrease,"
                f"pad={thumb_width}:{thumb_height}:(ow-iw)/2:(oh-ih)/2,"
                f"tile={cols}x{actual_rows}"
            ),
            "-frames:v", "1",
            "-q:v", "5",
            sheet_file,
        ]
        
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=120,
            )
            if result.returncode != 0:
                logger.warning("[Preview] Sprite sheet %d error: %s", sheet_idx, result.stderr[:200])
                continue
            
            sheet_meta = {
                "index": sheet_idx,
                "file": sheet_file,
                "start_time": start_time,
                "interval": interval,
                "thumb_width": thumb_width,
                "thumb_height": thumb_height,
                "cols": cols,
                "rows": actual_rows,
                "count": count,
            }
            sheets.append(sheet_meta)
            
            if on_progress:
                pct = ((sheet_idx + 1) / num_sheets) * 100
                on_progress(pct)
                
        except (subprocess.TimeoutExpired, OSError) as exc:
            logger.error("[Preview] Sprite sheet %d failed: %s", sheet_idx, exc)
            continue
    
    # Write sprite sheet index
    index_path = Path(output_dir) / "sprites.json"
    index_data = {
        "sheets": sheets,
        "total_thumbs": total_thumbs,
        "interval": interval,
        "thumb_width": thumb_width,
        "thumb_height": thumb_height,
        "cols": cols,
    }
    index_path.write_text(json.dumps(index_data, indent=2), encoding="utf-8")
    
    logger.info("[Preview] Generated %d sprite sheets (%d thumbnails)", len(sheets), total_thumbs)
    return sheets


# ── Proxy video ─────────────────────────────────────────────────────────────

def generate_proxy_video(
    input_file: str,
    output_file: str,
    width: int = 960,
    height: int = 540,
    fps: int = 30,
    on_progress: Any = None,
) -> bool:
    """Transcode source video to a low-res proxy for preview playback.
    
    Args:
        input_file: Source video path.
        output_file: Output proxy video path.
        width: Proxy width (default 960).
        height: Proxy height (default 540).
        fps: Proxy frame rate (default 30).
        on_progress: Optional callback(percentage: float).
    
    Returns:
        True if successful.
    """
    ffmpeg = _get_ffmpeg()
    Path(output_file).parent.mkdir(parents=True, exist_ok=True)
    
    # Get source duration for progress calculation
    info = get_video_info(input_file)
    duration = info.get("duration", 0)
    
    cmd = [
        ffmpeg, "-y",
        "-i", input_file,
        "-vf", f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2",
        "-r", str(fps),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "28",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        "-progress", "pipe:1",
        "-nostats",
        output_file,
    ]
    
    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        
        current_time = 0.0
        for line in iter(process.stdout.readline, ""):
            line = line.strip()
            if line.startswith("out_time_us="):
                try:
                    us = int(line.split("=")[1])
                    current_time = us / 1_000_000
                    if duration > 0 and on_progress:
                        pct = min(99.0, (current_time / duration) * 100)
                        on_progress(pct)
                except (ValueError, IndexError):
                    pass
            elif line == "progress=end":
                if on_progress:
                    on_progress(100.0)
        
        process.wait(timeout=600)
        
        if process.returncode != 0:
            stderr = process.stderr.read() if process.stderr else ""
            logger.error("[Preview] Proxy generation failed: %s", stderr[:500])
            return False
        
        # Verify output exists and has size
        out = Path(output_file)
        if not out.exists() or out.stat().st_size < 1000:
            logger.error("[Preview] Proxy output file missing or too small")
            return False
        
        logger.info("[Preview] Proxy video generated: %s (%.1f MB)", output_file, out.stat().st_size / 1e6)
        return True
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.error("[Preview] Proxy generation error: %s", exc)
        if process:
            process.kill()
        return False


# ── Full-resolution frame extraction ────────────────────────────────────────

def extract_frame(
    input_file: str,
    timestamp: float,
    output_file: str,
    quality: int = 2,
) -> bool:
    """Extract a single full-resolution frame at the given timestamp.
    
    Args:
        input_file: Source video path.
        timestamp: Time in seconds.
        output_file: Output image path (JPEG).
        quality: JPEG quality (2 = high, 31 = low).
    
    Returns:
        True if successful.
    """
    ffmpeg = _get_ffmpeg()
    Path(output_file).parent.mkdir(parents=True, exist_ok=True)
    
    cmd = [
        ffmpeg, "-y",
        "-ss", str(timestamp),
        "-i", input_file,
        "-frames:v", "1",
        "-q:v", str(quality),
        output_file,
    ]
    
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            logger.warning("[Preview] Frame extraction error at %.2fs: %s", timestamp, result.stderr[:200])
            return False
        
        if not Path(output_file).exists():
            return False
        
        return True
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.error("[Preview] Frame extraction failed: %s", exc)
        return False


# ── Audio extraction ────────────────────────────────────────────────────────

def extract_audio(
    input_file: str,
    output_file: str,
    codec: str = "aac",
    bitrate: str = "192k",
) -> bool:
    """Extract the audio track from a video file.
    
    Args:
        input_file: Source video path.
        output_file: Output audio path (e.g., .m4a or .aac).
        codec: Audio codec (default aac).
        bitrate: Audio bitrate (default 192k).
    
    Returns:
        True if successful.
    """
    ffmpeg = _get_ffmpeg()
    Path(output_file).parent.mkdir(parents=True, exist_ok=True)
    
    cmd = [
        ffmpeg, "-y",
        "-i", input_file,
        "-vn",
        "-c:a", codec,
        "-b:a", bitrate,
        output_file,
    ]
    
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            logger.warning("[Preview] Audio extraction error: %s", result.stderr[:200])
            return False
        
        if not Path(output_file).exists() or Path(output_file).stat().st_size < 100:
            return False
        
        logger.info("[Preview] Audio extracted: %s", output_file)
        return True
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.error("[Preview] Audio extraction failed: %s", exc)
        return False
