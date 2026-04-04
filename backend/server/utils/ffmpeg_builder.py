"""
ffmpeg_builder.py
------------------
FFmpeg command builder for encoding.

Builds FFmpeg command lines from:
- Input video file
- Encoder selection (NVENC/AMF/QSV/CPU)
- Export presets (YouTube, Discord, Archive, Custom)
- EDL (Edit Decision List) to complex filtergraph
- Progress output parsing
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


# ── Export Presets ───────────────────────────────────────────────────────────

DEFAULT_PRESETS: list[dict[str, Any]] = [
    {
        "id": "youtube_1080p60",
        "name": "YouTube 1080p60",
        "description": "Optimized for YouTube — 1080p at 60fps, high bitrate",
        "resolution_width": 1920,
        "resolution_height": 1080,
        "fps": 60,
        "codec_family": "h264",
        "video_bitrate_mbps": 12,
        "audio_bitrate_kbps": 192,
        "quality_preset": "medium",
        "is_builtin": True,
    },
    {
        "id": "discord_720p30",
        "name": "Discord 720p30",
        "description": "Compact for Discord — 720p at 30fps, lower bitrate",
        "resolution_width": 1280,
        "resolution_height": 720,
        "fps": 30,
        "codec_family": "h264",
        "video_bitrate_mbps": 5,
        "audio_bitrate_kbps": 128,
        "quality_preset": "fast",
        "is_builtin": True,
    },
    {
        "id": "archive_4k",
        "name": "Archive 4K",
        "description": "Maximum quality — 4K at native fps, H.265",
        "resolution_width": 3840,
        "resolution_height": 2160,
        "fps": 60,
        "codec_family": "h265",
        "video_bitrate_mbps": 40,
        "audio_bitrate_kbps": 320,
        "quality_preset": "slow",
        "is_builtin": True,
    },
    {
        "id": "custom",
        "name": "Custom",
        "description": "User-defined settings",
        "resolution_width": 1920,
        "resolution_height": 1080,
        "fps": 60,
        "codec_family": "h264",
        "video_bitrate_mbps": 12,
        "audio_bitrate_kbps": 192,
        "quality_preset": "medium",
        "is_builtin": True,
    },
]


# ── Quality preset mapping ──────────────────────────────────────────────────

# Maps quality_preset to encoder-specific options
QUALITY_PRESETS = {
    "h264_nvenc": {
        "fast":   ["-preset", "p4", "-tune", "hq", "-rc", "vbr"],
        "medium": ["-preset", "p5", "-tune", "hq", "-rc", "vbr"],
        "slow":   ["-preset", "p7", "-tune", "hq", "-rc", "vbr"],
    },
    "hevc_nvenc": {
        "fast":   ["-preset", "p4", "-tune", "hq", "-rc", "vbr"],
        "medium": ["-preset", "p5", "-tune", "hq", "-rc", "vbr"],
        "slow":   ["-preset", "p7", "-tune", "hq", "-rc", "vbr"],
    },
    "h264_amf": {
        "fast":   ["-quality", "speed"],
        "medium": ["-quality", "balanced"],
        "slow":   ["-quality", "quality"],
    },
    "hevc_amf": {
        "fast":   ["-quality", "speed"],
        "medium": ["-quality", "balanced"],
        "slow":   ["-quality", "quality"],
    },
    "h264_qsv": {
        "fast":   ["-preset", "faster"],
        "medium": ["-preset", "medium"],
        "slow":   ["-preset", "slower"],
    },
    "hevc_qsv": {
        "fast":   ["-preset", "faster"],
        "medium": ["-preset", "medium"],
        "slow":   ["-preset", "slower"],
    },
    "libx264": {
        "fast":   ["-preset", "fast"],
        "medium": ["-preset", "medium"],
        "slow":   ["-preset", "slow"],
    },
    "libx265": {
        "fast":   ["-preset", "fast"],
        "medium": ["-preset", "medium"],
        "slow":   ["-preset", "slow"],
    },
}


# ── FFmpeg command builder ──────────────────────────────────────────────────

def build_encode_command(
    ffmpeg_path: str,
    input_file: str,
    output_file: str,
    encoder_codec: str,
    preset: dict[str, Any],
    edl: Optional[list[dict]] = None,
    gpu_index: int = 0,
) -> list[str]:
    """Build a complete FFmpeg encoding command.

    Args:
        ffmpeg_path: Path to ffmpeg binary.
        input_file: Source video file path.
        output_file: Output file path.
        encoder_codec: FFmpeg codec name (e.g. "h264_nvenc", "libx264").
        preset: Export preset dict with resolution, fps, bitrate, etc.
        edl: Optional edit decision list (list of segment dicts).
        gpu_index: GPU index for multi-GPU systems.

    Returns:
        List of command arguments for subprocess.
    """
    cmd = [ffmpeg_path, "-hide_banner", "-y"]

    # GPU selection for NVIDIA
    if "nvenc" in encoder_codec:
        cmd.extend(["-hwaccel", "cuda", "-hwaccel_device", str(gpu_index)])

    # Input file
    cmd.extend(["-i", input_file])

    # Progress output for parsing
    cmd.extend(["-progress", "pipe:1", "-stats_period", "0.5"])

    # Build filtergraph
    filters = _build_filtergraph(preset, edl)
    if filters:
        cmd.extend(["-filter_complex", filters, "-map", "[vout]", "-map", "0:a?"])
    else:
        cmd.extend(["-map", "0:v:0", "-map", "0:a?"])

    # Video codec & encoder options
    cmd.extend(["-c:v", encoder_codec])

    # Quality preset options
    quality = preset.get("quality_preset", "medium")
    quality_opts = QUALITY_PRESETS.get(encoder_codec, {}).get(quality, [])
    cmd.extend(quality_opts)

    # Bitrate
    bitrate_mbps = preset.get("video_bitrate_mbps", 12)
    cmd.extend(["-b:v", f"{bitrate_mbps}M", "-maxrate", f"{int(bitrate_mbps * 1.5)}M"])

    # Buffer size (2× bitrate)
    cmd.extend(["-bufsize", f"{bitrate_mbps * 2}M"])

    # Resolution (only if not in filtergraph already)
    if not edl:
        w = preset.get("resolution_width", 1920)
        h = preset.get("resolution_height", 1080)
        cmd.extend(["-vf", f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"])

    # Framerate
    fps = preset.get("fps", 60)
    cmd.extend(["-r", str(fps)])

    # Audio codec
    audio_bitrate = preset.get("audio_bitrate_kbps", 192)
    cmd.extend(["-c:a", "aac", "-b:a", f"{audio_bitrate}k"])

    # Container options for MP4
    cmd.extend(["-movflags", "+faststart"])

    # Output file
    cmd.append(output_file)

    return cmd


def _build_filtergraph(
    preset: dict[str, Any],
    edl: Optional[list[dict]] = None,
) -> Optional[str]:
    """Build an FFmpeg complex filtergraph from EDL segments and preset.

    Args:
        preset: Export preset with resolution, fps.
        edl: Edit decision list — list of segment dicts with start_time, end_time.

    Returns:
        Filtergraph string or None if no complex filter needed.
    """
    if not edl or len(edl) == 0:
        return None

    w = preset.get("resolution_width", 1920)
    h = preset.get("resolution_height", 1080)

    # Build trim + setpts + scale for each segment, then concatenate
    parts = []
    for i, segment in enumerate(edl):
        start = segment.get("start_time", 0)
        end = segment.get("end_time", start + 10)
        parts.append(
            f"[0:v]trim=start={start}:end={end},setpts=PTS-STARTPTS,"
            f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2[v{i}]"
        )

    # Audio segments
    audio_parts = []
    for i, segment in enumerate(edl):
        start = segment.get("start_time", 0)
        end = segment.get("end_time", start + 10)
        audio_parts.append(
            f"[0:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS[a{i}]"
        )

    # Concatenation
    n = len(edl)
    v_inputs = "".join(f"[v{i}]" for i in range(n))
    a_inputs = "".join(f"[a{i}]" for i in range(n))
    concat = f"{v_inputs}{a_inputs}concat=n={n}:v=1:a=1[vout][aout]"

    all_parts = parts + audio_parts + [concat]
    return ";".join(all_parts)


# ── Progress parsing ────────────────────────────────────────────────────────

def parse_progress_line(line: str, duration_seconds: float) -> Optional[dict[str, Any]]:
    """Parse an FFmpeg progress output line.

    FFmpeg with -progress pipe:1 outputs key=value pairs.
    We extract: out_time_us, fps, speed, bitrate.

    Args:
        line: A single line from FFmpeg progress output.
        duration_seconds: Total expected duration for percentage calculation.

    Returns:
        Progress dict or None if not a progress line.
    """
    line = line.strip()
    if "=" not in line:
        return None

    key, _, value = line.partition("=")
    key = key.strip()
    value = value.strip()

    # We accumulate progress data across lines.
    # The caller should maintain state; we just parse individual keys here.
    return {"key": key, "value": value}


def compute_progress(progress_data: dict[str, str], duration_seconds: float) -> dict[str, Any]:
    """Compute human-readable progress from accumulated FFmpeg progress data.

    Args:
        progress_data: Dict of key=value pairs from FFmpeg progress output.
        duration_seconds: Total expected duration in seconds.

    Returns:
        Dict with percentage, eta_seconds, fps, speed, current_time, bitrate.
    """
    result: dict[str, Any] = {
        "percentage": 0,
        "eta_seconds": None,
        "fps": 0,
        "speed": "",
        "current_time_seconds": 0,
        "bitrate": "",
    }

    # Parse out_time_us (microseconds) or out_time
    out_time_us = progress_data.get("out_time_us")
    out_time = progress_data.get("out_time")

    current_seconds = 0
    if out_time_us and out_time_us != "N/A":
        try:
            current_seconds = int(out_time_us) / 1_000_000
        except (ValueError, TypeError):
            pass
    elif out_time and out_time != "N/A":
        current_seconds = _parse_time_string(out_time)

    result["current_time_seconds"] = round(current_seconds, 2)

    if duration_seconds > 0:
        pct = min(100, (current_seconds / duration_seconds) * 100)
        result["percentage"] = round(pct, 1)

    # FPS
    fps_str = progress_data.get("fps", "0")
    try:
        result["fps"] = float(fps_str)
    except (ValueError, TypeError):
        pass

    # Speed
    speed = progress_data.get("speed", "")
    result["speed"] = speed.strip()

    # ETA calculation from speed
    if speed and "x" in speed and duration_seconds > 0:
        try:
            speed_factor = float(speed.replace("x", "").strip())
            if speed_factor > 0:
                remaining_seconds = duration_seconds - current_seconds
                result["eta_seconds"] = round(remaining_seconds / speed_factor, 0)
        except (ValueError, TypeError):
            pass

    # Bitrate
    result["bitrate"] = progress_data.get("bitrate", "").strip()

    return result


def _parse_time_string(time_str: str) -> float:
    """Parse an FFmpeg time string like '00:12:34.567890' to seconds."""
    match = re.match(r"(\d+):(\d+):(\d+)\.?(\d*)", time_str)
    if not match:
        return 0
    h, m, s, frac = match.groups()
    total = int(h) * 3600 + int(m) * 60 + int(s)
    if frac:
        total += int(frac) / (10 ** len(frac))
    return total


# ── Video file info ─────────────────────────────────────────────────────────

def get_video_duration(ffprobe_path: str, input_file: str) -> Optional[float]:
    """Get the duration of a video file in seconds using ffprobe.

    Args:
        ffprobe_path: Path to ffprobe binary.
        input_file: Video file path.

    Returns:
        Duration in seconds, or None if detection fails.
    """
    try:
        result = subprocess.run(
            [
                ffprobe_path,
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                input_file,
            ],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0 and result.stdout.strip():
            return float(result.stdout.strip())
    except (subprocess.SubprocessError, ValueError, OSError) as exc:
        logger.warning("[FFmpeg] Failed to get duration for %s: %s", input_file, exc)
    return None


def validate_output_file(file_path: str, ffprobe_path: Optional[str] = None) -> dict[str, Any]:
    """Validate an encoded output file.

    Checks: file exists, non-zero size, valid container (via ffprobe if available).

    Returns:
        Validation result dict.
    """
    result: dict[str, Any] = {
        "path": file_path,
        "valid": False,
        "size_bytes": 0,
        "duration_seconds": None,
        "errors": [],
    }

    try:
        p = Path(file_path)
        if not p.exists():
            result["errors"].append("Output file does not exist")
            return result

        stat = p.stat()
        result["size_bytes"] = stat.st_size

        if stat.st_size == 0:
            result["errors"].append("Output file is empty")
            return result

        if stat.st_size < 1024:
            result["errors"].append("Output file is suspiciously small (< 1 KB)")
            return result

        # Use ffprobe to verify the file is valid
        if ffprobe_path:
            duration = get_video_duration(ffprobe_path, file_path)
            if duration is not None and duration > 0:
                result["duration_seconds"] = round(duration, 2)
                result["valid"] = True
            else:
                result["errors"].append("Could not read duration from output file")
        else:
            # Without ffprobe, trust that a non-empty MP4 is valid
            result["valid"] = True

    except Exception as exc:
        result["errors"].append(f"Validation error: {exc}")

    return result
