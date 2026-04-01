"""
gpu_detection.py
-----------------
GPU hardware encoder detection for FFmpeg.

Detects available GPU encoding capabilities:
- NVENC (NVIDIA)
- AMF (AMD)
- QSV (Intel QuickSync)
- CPU fallback (libx264/libx265)

Uses FFmpeg's built-in encoder listing to verify availability.
"""

from __future__ import annotations

import logging
import platform
import re
import shutil
import subprocess
from typing import Any, Optional

logger = logging.getLogger(__name__)


# ── Encoder definitions ─────────────────────────────────────────────────────

ENCODERS = {
    "nvenc_h264": {
        "id": "nvenc_h264",
        "ffmpeg_codec": "h264_nvenc",
        "label": "NVIDIA NVENC (H.264)",
        "vendor": "nvidia",
        "type": "gpu",
        "codec_family": "h264",
    },
    "nvenc_h265": {
        "id": "nvenc_h265",
        "ffmpeg_codec": "hevc_nvenc",
        "label": "NVIDIA NVENC (H.265)",
        "vendor": "nvidia",
        "type": "gpu",
        "codec_family": "h265",
    },
    "amf_h264": {
        "id": "amf_h264",
        "ffmpeg_codec": "h264_amf",
        "label": "AMD AMF (H.264)",
        "vendor": "amd",
        "type": "gpu",
        "codec_family": "h264",
    },
    "amf_h265": {
        "id": "amf_h265",
        "ffmpeg_codec": "hevc_amf",
        "label": "AMD AMF (H.265)",
        "vendor": "amd",
        "type": "gpu",
        "codec_family": "h265",
    },
    "qsv_h264": {
        "id": "qsv_h264",
        "ffmpeg_codec": "h264_qsv",
        "label": "Intel QuickSync (H.264)",
        "vendor": "intel",
        "type": "gpu",
        "codec_family": "h264",
    },
    "qsv_h265": {
        "id": "qsv_h265",
        "ffmpeg_codec": "hevc_qsv",
        "label": "Intel QuickSync (H.265)",
        "vendor": "intel",
        "type": "gpu",
        "codec_family": "h265",
    },
    "cpu_h264": {
        "id": "cpu_h264",
        "ffmpeg_codec": "libx264",
        "label": "CPU (libx264)",
        "vendor": "cpu",
        "type": "cpu",
        "codec_family": "h264",
    },
    "cpu_h265": {
        "id": "cpu_h265",
        "ffmpeg_codec": "libx265",
        "label": "CPU (libx265)",
        "vendor": "cpu",
        "type": "cpu",
        "codec_family": "h265",
    },
}


# ── FFmpeg detection ────────────────────────────────────────────────────────

def find_ffmpeg() -> Optional[str]:
    """Find the ffmpeg binary path."""
    path = shutil.which("ffmpeg")
    if path:
        logger.info("[GPU] Found ffmpeg: %s", path)
        return path
    logger.warning("[GPU] ffmpeg not found in PATH")
    return None


def find_ffprobe() -> Optional[str]:
    """Find the ffprobe binary path."""
    path = shutil.which("ffprobe")
    if path:
        return path
    logger.warning("[GPU] ffprobe not found in PATH")
    return None


def get_ffmpeg_version() -> Optional[str]:
    """Get the installed FFmpeg version string."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return None
    try:
        result = subprocess.run(
            [ffmpeg, "-version"],
            capture_output=True, text=True, timeout=10,
        )
        first_line = result.stdout.split("\n")[0] if result.stdout else ""
        match = re.search(r"ffmpeg version (\S+)", first_line)
        return match.group(1) if match else first_line.strip()
    except (subprocess.SubprocessError, OSError) as exc:
        logger.warning("[GPU] Failed to get ffmpeg version: %s", exc)
        return None


# ── Encoder detection ───────────────────────────────────────────────────────

def get_available_ffmpeg_encoders() -> set[str]:
    """Get the set of encoder names supported by the installed FFmpeg."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return set()

    try:
        result = subprocess.run(
            [ffmpeg, "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=10,
        )
        encoders = set()
        for line in result.stdout.split("\n"):
            # Lines like: " V..... h264_nvenc           NVIDIA NVENC H.264 encoder"
            match = re.match(r"\s+[VASD.]+\s+(\S+)", line)
            if match:
                encoders.add(match.group(1))
        return encoders
    except (subprocess.SubprocessError, OSError) as exc:
        logger.warning("[GPU] Failed to list ffmpeg encoders: %s", exc)
        return set()


def detect_gpu_encoders() -> list[dict[str, Any]]:
    """Detect which GPU encoders are available.

    Checks each known encoder against FFmpeg's encoder list.
    Returns a list of available encoder info dicts.

    Priority order: NVENC > AMF > QSV > CPU
    """
    available_ffmpeg = get_available_ffmpeg_encoders()
    ffmpeg_path = find_ffmpeg()

    results = []

    for enc_id, enc_info in ENCODERS.items():
        available = enc_info["ffmpeg_codec"] in available_ffmpeg
        results.append({
            **enc_info,
            "available": available,
        })

    # Sort: available first, then by priority (nvidia > amd > intel > cpu)
    vendor_priority = {"nvidia": 0, "amd": 1, "intel": 2, "cpu": 3}
    results.sort(key=lambda e: (not e["available"], vendor_priority.get(e["vendor"], 99)))

    return results


def get_best_encoder(codec_family: str = "h264") -> dict[str, Any]:
    """Get the best available encoder for a given codec family.

    Priority: NVENC > AMF > QSV > CPU fallback.

    Args:
        codec_family: "h264" or "h265"

    Returns:
        Encoder info dict with 'available' key.
    """
    encoders = detect_gpu_encoders()

    for enc in encoders:
        if enc["codec_family"] == codec_family and enc["available"]:
            return enc

    # Return CPU fallback even if not explicitly available
    fallback_id = f"cpu_{codec_family}"
    return {**ENCODERS.get(fallback_id, ENCODERS["cpu_h264"]), "available": True}


def detect_gpus() -> dict[str, Any]:
    """Detect all GPU encoding capabilities.

    Returns a summary dict for the frontend with:
    - ffmpeg_available: bool
    - ffmpeg_version: str
    - encoders: list of encoder dicts
    - best_h264: best available H.264 encoder
    - best_h265: best available H.265 encoder
    - gpu_count: number of GPUs detected
    """
    ffmpeg_path = find_ffmpeg()
    ffmpeg_version = get_ffmpeg_version()
    encoders = detect_gpu_encoders()

    best_h264 = get_best_encoder("h264")
    best_h265 = get_best_encoder("h265")

    # Count distinct GPU vendors with available encoders
    gpu_vendors = {
        e["vendor"]
        for e in encoders
        if e["available"] and e["type"] == "gpu"
    }

    return {
        "ffmpeg_available": ffmpeg_path is not None,
        "ffmpeg_path": ffmpeg_path,
        "ffmpeg_version": ffmpeg_version,
        "encoders": encoders,
        "best_h264": best_h264,
        "best_h265": best_h265,
        "gpu_vendors": sorted(gpu_vendors),
        "gpu_count": len(gpu_vendors),
        "has_gpu_encoder": len(gpu_vendors) > 0,
    }
