"""
obs_integration.py
-------------------
OBS Studio / NVIDIA ShadowPlay / AMD ReLive integration utilities.

Provides:
- Capture software process detection
- Hotkey simulation (via keyboard library)
- File system watching for new recordings
- Output path discovery from OBS/ShadowPlay configuration
"""

from __future__ import annotations

import json
import logging
import os
import platform
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ── Supported capture software ──────────────────────────────────────────────

CAPTURE_SOFTWARE = {
    "obs": {
        "label": "OBS Studio",
        "process_names": ["obs64.exe", "obs32.exe", "obs.exe"],
        "default_hotkey_start": "F9",
        "default_hotkey_stop": "F9",   # OBS toggles with the same key
    },
    "shadowplay": {
        "label": "NVIDIA ShadowPlay",
        "process_names": ["nvcontainer.exe", "nvidia share.exe", "nvsphelper64.exe"],
        "default_hotkey_start": "Alt+F9",
        "default_hotkey_stop": "Alt+F9",
    },
    "relive": {
        "label": "AMD ReLive",
        "process_names": ["amddvr.exe", "amdow.exe", "radeonoverlay.exe"],
        "default_hotkey_start": "Ctrl+Shift+R",
        "default_hotkey_stop": "Ctrl+Shift+R",
    },
}


# ── Process detection ───────────────────────────────────────────────────────

def detect_capture_software() -> list[dict[str, Any]]:
    """Detect which capture software is currently running.

    Returns a list of dicts with keys: id, label, running, process_names.
    Works on Windows via tasklist; returns not-running on other platforms.
    """
    results = []
    running_processes = _get_running_processes()

    for sw_id, sw_info in CAPTURE_SOFTWARE.items():
        is_running = any(
            proc_name.lower() in running_processes
            for proc_name in sw_info["process_names"]
        )
        results.append({
            "id": sw_id,
            "label": sw_info["label"],
            "running": is_running,
            "default_hotkey_start": sw_info["default_hotkey_start"],
            "default_hotkey_stop": sw_info["default_hotkey_stop"],
        })

    return results


def is_software_running(software_id: str) -> bool:
    """Check if a specific capture software is running."""
    sw_info = CAPTURE_SOFTWARE.get(software_id)
    if not sw_info:
        return False
    running = _get_running_processes()
    return any(p.lower() in running for p in sw_info["process_names"])


def _get_running_processes() -> set[str]:
    """Get a set of running process names (lowercase) on Windows."""
    if platform.system() != "Windows":
        logger.debug("[Capture] Process detection only supported on Windows")
        return set()
    try:
        output = subprocess.check_output(
            ["tasklist", "/fo", "csv", "/nh"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        )
        processes = set()
        for line in output.strip().split("\n"):
            if line.startswith('"'):
                name = line.split('"')[1].lower()
                processes.add(name)
        return processes
    except (subprocess.SubprocessError, OSError) as exc:
        logger.warning("[Capture] Failed to list processes: %s", exc)
        return set()


# ── Hotkey simulation ───────────────────────────────────────────────────────

def send_hotkey(hotkey_string: str) -> bool:
    """Send a keyboard hotkey combination.

    Args:
        hotkey_string: Key combination like "Alt+F9", "Ctrl+Shift+R", "F9".

    Returns:
        True if the hotkey was sent successfully, False on error.
    """
    if platform.system() != "Windows":
        logger.warning("[Capture] Hotkey simulation only supported on Windows")
        return False

    try:
        import ctypes
        from ctypes import wintypes

        keys = _parse_hotkey(hotkey_string)
        if not keys:
            logger.error("[Capture] Failed to parse hotkey: %s", hotkey_string)
            return False

        # Send key down events
        for vk in keys:
            _send_key_event(vk, down=True)
            time.sleep(0.02)

        # Send key up events (in reverse order)
        for vk in reversed(keys):
            _send_key_event(vk, down=False)
            time.sleep(0.02)

        logger.info("[Capture] Sent hotkey: %s", hotkey_string)
        return True

    except Exception as exc:
        logger.error("[Capture] Failed to send hotkey %s: %s", hotkey_string, exc)
        return False


# Virtual key codes for Windows
_VK_CODES: dict[str, int] = {
    "alt": 0x12, "lalt": 0xA4, "ralt": 0xA5,
    "ctrl": 0x11, "control": 0x11, "lctrl": 0xA2, "rctrl": 0xA3,
    "shift": 0x10, "lshift": 0xA0, "rshift": 0xA1,
    "win": 0x5B, "lwin": 0x5B, "rwin": 0x5C,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73,
    "f5": 0x74, "f6": 0x75, "f7": 0x76, "f8": 0x77,
    "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
    "space": 0x20, "enter": 0x0D, "tab": 0x09,
    "escape": 0x1B, "esc": 0x1B,
}
# Add letter keys A-Z
for c in range(ord("a"), ord("z") + 1):
    _VK_CODES[chr(c)] = c - 32  # VK_A = 0x41 = 65, 'a' = 97

# Add number keys 0-9
for n in range(10):
    _VK_CODES[str(n)] = 0x30 + n


def _parse_hotkey(hotkey_string: str) -> list[int]:
    """Parse a hotkey string like 'Alt+F9' into a list of virtual key codes."""
    parts = [p.strip().lower() for p in hotkey_string.split("+")]
    vk_codes = []
    for part in parts:
        vk = _VK_CODES.get(part)
        if vk is None:
            logger.warning("[Capture] Unknown key: %s", part)
            return []
        vk_codes.append(vk)
    return vk_codes


def _send_key_event(vk: int, down: bool = True) -> None:
    """Send a single key event using Windows SendInput API."""
    import ctypes

    KEYEVENTF_KEYUP = 0x0002
    KEYEVENTF_EXTENDEDKEY = 0x0001

    # Extended keys (function keys, alt, etc.)
    extended = vk in (0x12, 0xA4, 0xA5, 0x11, 0xA2, 0xA3, 0x5B, 0x5C) or (0x70 <= vk <= 0x7B)
    flags = 0
    if extended:
        flags |= KEYEVENTF_EXTENDEDKEY
    if not down:
        flags |= KEYEVENTF_KEYUP

    # Use keybd_event for simplicity (works for most use cases)
    ctypes.windll.user32.keybd_event(vk, 0, flags, 0)


# ── Output path discovery ──────────────────────────────────────────────────

def discover_obs_output_path() -> Optional[str]:
    """Try to discover the OBS Studio recording output path from its config.

    Checks the standard OBS config location on Windows.
    Returns the output path or None if not found.
    """
    if platform.system() != "Windows":
        return None

    try:
        appdata = os.environ.get("APPDATA", "")
        if not appdata:
            return None

        # OBS stores profiles in AppData/Roaming/obs-studio/basic/profiles/
        obs_dir = Path(appdata) / "obs-studio" / "basic" / "profiles"
        if not obs_dir.exists():
            return None

        # Check all profiles for output settings
        for profile_dir in obs_dir.iterdir():
            if not profile_dir.is_dir():
                continue
            basic_ini = profile_dir / "basic.ini"
            if not basic_ini.exists():
                continue

            content = basic_ini.read_text(encoding="utf-8", errors="ignore")
            # Look for FilePath or RecFilePath
            for line in content.split("\n"):
                line = line.strip()
                if line.startswith("FilePath=") or line.startswith("RecFilePath="):
                    path = line.split("=", 1)[1].strip()
                    if path and Path(path).exists():
                        logger.info("[Capture] Found OBS output path: %s", path)
                        return path

    except Exception as exc:
        logger.warning("[Capture] Failed to discover OBS output path: %s", exc)

    return None


def discover_shadowplay_output_path() -> Optional[str]:
    """Try to discover the NVIDIA ShadowPlay recording output path.

    ShadowPlay typically uses the Videos folder or a configured path.
    """
    if platform.system() != "Windows":
        return None

    try:
        # ShadowPlay default: user's Videos folder
        videos = Path.home() / "Videos"
        if videos.exists():
            # Check for NVIDIA-specific subfolder
            nvidia_dir = videos / "Desktop"
            if nvidia_dir.exists():
                return str(nvidia_dir)
            return str(videos)
    except Exception as exc:
        logger.warning("[Capture] Failed to discover ShadowPlay path: %s", exc)

    return None


def discover_output_path(software_id: str) -> Optional[str]:
    """Discover the output path for a given capture software."""
    if software_id == "obs":
        return discover_obs_output_path()
    elif software_id == "shadowplay":
        return discover_shadowplay_output_path()
    return None


# ── File watching helpers ───────────────────────────────────────────────────

def get_recent_video_files(directory: str, since_timestamp: float,
                           extensions: tuple[str, ...] = (".mp4", ".mkv", ".flv", ".ts", ".avi")) -> list[dict]:
    """Find video files created after a given timestamp in a directory.

    Returns list of dicts: {path, size_bytes, created_at, extension}.
    """
    results = []
    try:
        dir_path = Path(directory)
        if not dir_path.exists():
            return results

        for f in dir_path.iterdir():
            if not f.is_file():
                continue
            if f.suffix.lower() not in extensions:
                continue
            stat = f.stat()
            if stat.st_ctime >= since_timestamp:
                results.append({
                    "path": str(f),
                    "size_bytes": stat.st_size,
                    "created_at": stat.st_ctime,
                    "extension": f.suffix.lower(),
                    "name": f.name,
                })

    except Exception as exc:
        logger.warning("[Capture] Error scanning directory %s: %s", directory, exc)

    return sorted(results, key=lambda x: x["created_at"], reverse=True)


def validate_video_file(file_path: str) -> dict[str, Any]:
    """Validate a captured video file.

    Checks: file exists, non-zero size, has video extension.
    Returns a validation result dict.
    """
    result = {
        "path": file_path,
        "valid": False,
        "size_bytes": 0,
        "errors": [],
    }

    try:
        p = Path(file_path)

        if not p.exists():
            result["errors"].append("File does not exist")
            return result

        stat = p.stat()
        result["size_bytes"] = stat.st_size

        if stat.st_size == 0:
            result["errors"].append("File is empty (0 bytes)")
            return result

        if stat.st_size < 1024:
            result["errors"].append("File is suspiciously small (< 1 KB)")
            return result

        valid_exts = {".mp4", ".mkv", ".flv", ".ts", ".avi", ".mov"}
        if p.suffix.lower() not in valid_exts:
            result["errors"].append(f"Unexpected extension: {p.suffix}")
            return result

        result["valid"] = True
        result["duration_estimate_seconds"] = None  # Would need ffprobe

    except Exception as exc:
        result["errors"].append(f"Validation error: {exc}")

    return result
