"""
capture_service.py
-------------------
Capture orchestration service for OBS Studio / ShadowPlay / ReLive.

Manages the capture lifecycle:
  idle → testing → ready → capturing → validating → completed

Runs a background thread to monitor file size during capture and
emit progress events via WebSocket.
"""

from __future__ import annotations

import asyncio
import logging
import platform
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from server.events import EventType, make_event
from server.services.settings_service import settings_service
from server.utils.obs_integration import (
    detect_capture_software,
    discover_output_path,
    get_recent_video_files,
    is_software_running,
    send_hotkey,
    validate_video_file,
)

logger = logging.getLogger(__name__)


# ── Capture states ──────────────────────────────────────────────────────────

class CaptureState:
    IDLE = "idle"
    TESTING = "testing"           # Hotkey test in progress
    READY = "ready"               # Test passed, ready to capture
    CAPTURING = "capturing"       # Currently recording
    VALIDATING = "validating"     # Post-capture validation
    COMPLETED = "completed"       # Capture file ready
    ERROR = "error"


# ── Capture Service ─────────────────────────────────────────────────────────

class CaptureService:
    """Singleton service managing video capture orchestration."""

    def __init__(self) -> None:
        self._state = CaptureState.IDLE
        self._capture_start_time: float = 0
        self._capture_file: Optional[str] = None
        self._capture_file_size: int = 0
        self._watch_dir: Optional[str] = None
        self._error_message: Optional[str] = None
        self._monitor_thread: Optional[threading.Thread] = None
        self._stop_monitoring = threading.Event()
        self._broadcast_fn: Optional[Callable] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._test_result: Optional[dict] = None

    # ── Properties ──────────────────────────────────────────────────────────

    @property
    def state(self) -> str:
        return self._state

    @property
    def status(self) -> dict[str, Any]:
        """Return full status snapshot."""
        elapsed = 0
        if self._state == CaptureState.CAPTURING and self._capture_start_time:
            elapsed = time.time() - self._capture_start_time

        return {
            "state": self._state,
            "elapsed_seconds": round(elapsed, 1),
            "file_path": self._capture_file,
            "file_size_bytes": self._capture_file_size,
            "watch_dir": self._watch_dir,
            "error": self._error_message,
            "test_result": self._test_result,
        }

    # ── Wiring ──────────────────────────────────────────────────────────────

    def set_broadcast_fn(self, fn: Callable) -> None:
        """Set the function used to broadcast WebSocket messages."""
        self._broadcast_fn = fn

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Set the asyncio event loop for scheduling broadcasts."""
        self._loop = loop

    def get_broadcast_fn(self) -> Optional[Callable]:
        """Return the configured WebSocket broadcast function."""
        return self._broadcast_fn

    def get_event_loop(self) -> Optional[asyncio.AbstractEventLoop]:
        """Return the asyncio event loop for scheduling async broadcasts."""
        return self._loop

    # ── Software detection ──────────────────────────────────────────────────

    def detect_software(self) -> list[dict[str, Any]]:
        """Detect available capture software."""
        return detect_capture_software()

    def get_active_software(self) -> Optional[str]:
        """Get the configured capture software ID from settings."""
        config = settings_service.get_all()
        return config.get("capture_software", "obs")

    def get_hotkeys(self) -> dict[str, str]:
        """Get configured hotkeys from settings."""
        config = settings_service.get_all()
        return {
            "start": config.get("capture_hotkey_start", ""),
            "stop": config.get("capture_hotkey_stop", ""),
        }

    def get_watch_directory(self) -> Optional[str]:
        """Get the directory to watch for new capture files."""
        config = settings_service.get_all()

        # Check user-configured path first
        custom_dir = config.get("iracing_replay_dir", "")
        if custom_dir and Path(custom_dir).exists():
            return custom_dir

        # Try auto-discovery
        software = self.get_active_software()
        if software:
            discovered = discover_output_path(software)
            if discovered:
                return discovered

        # Fallback to user's Videos folder
        videos = Path.home() / "Videos"
        if videos.exists():
            return str(videos)

        return None

    # ── Hotkey test ──────────────────────────────────────────────────────────

    async def test_hotkey(self) -> dict[str, Any]:
        """Test the start hotkey and verify recording starts.

        Sends the start hotkey, waits briefly for a new file to appear,
        then sends the stop hotkey. Returns the test result.
        """
        if self._state not in (CaptureState.IDLE, CaptureState.READY, CaptureState.ERROR):
            return {"success": False, "error": f"Cannot test in state: {self._state}"}

        self._state = CaptureState.TESTING
        self._test_result = None
        self._error_message = None

        software = self.get_active_software()
        hotkeys = self.get_hotkeys()
        watch_dir = self.get_watch_directory()

        result: dict[str, Any] = {
            "success": False,
            "software": software,
            "hotkey_start": hotkeys["start"],
            "hotkey_stop": hotkeys["stop"],
            "watch_dir": watch_dir,
            "software_running": False,
            "file_detected": False,
            "errors": [],
        }

        try:
            # Check software is running
            if software and software != "manual":
                running = is_software_running(software)
                result["software_running"] = running
                if not running:
                    result["errors"].append(
                        f"{software.upper()} is not running. Please start it first."
                    )
                    self._state = CaptureState.ERROR
                    self._error_message = result["errors"][0]
                    self._test_result = result
                    self._emit(EventType.CAPTURE_HOTKEY_TEST, result)
                    return result

            if not hotkeys["start"]:
                result["errors"].append("No start hotkey configured")
                self._state = CaptureState.ERROR
                self._error_message = result["errors"][0]
                self._test_result = result
                self._emit(EventType.CAPTURE_HOTKEY_TEST, result)
                return result

            if not watch_dir:
                result["errors"].append("No watch directory found. Configure output path in settings.")
                self._state = CaptureState.ERROR
                self._error_message = result["errors"][0]
                self._test_result = result
                self._emit(EventType.CAPTURE_HOTKEY_TEST, result)
                return result

            # Note timestamp before sending hotkey
            before_time = time.time()

            # Send start hotkey
            if platform.system() == "Windows":
                sent = send_hotkey(hotkeys["start"])
                if not sent:
                    result["errors"].append("Failed to send start hotkey")
                    self._state = CaptureState.ERROR
                    self._error_message = result["errors"][0]
                    self._test_result = result
                    self._emit(EventType.CAPTURE_HOTKEY_TEST, result)
                    return result
            else:
                logger.info("[Capture] Test: would send hotkey %s (non-Windows)", hotkeys["start"])

            # Wait briefly for file to appear
            await asyncio.sleep(3)

            # Check for new files
            if watch_dir:
                new_files = get_recent_video_files(watch_dir, before_time)
                result["file_detected"] = len(new_files) > 0
                if new_files:
                    result["detected_file"] = new_files[0]["name"]

            # Send stop hotkey to end the test recording
            stop_key = hotkeys["stop"] or hotkeys["start"]
            if platform.system() == "Windows":
                send_hotkey(stop_key)
            else:
                logger.info("[Capture] Test: would send stop hotkey %s (non-Windows)", stop_key)

            # Give it a moment to finalize
            await asyncio.sleep(1)

            # Determine success
            if result["file_detected"]:
                result["success"] = True
                self._state = CaptureState.READY
            elif platform.system() != "Windows":
                # On non-Windows, we can't actually test — assume OK
                result["success"] = True
                result["note"] = "Hotkey simulation only works on Windows; assumed OK"
                self._state = CaptureState.READY
            else:
                result["errors"].append(
                    "No recording file detected after sending hotkey. "
                    "Check that the hotkey is correct and the software is configured to record."
                )
                self._state = CaptureState.ERROR
                self._error_message = result["errors"][0] if result["errors"] else None

        except Exception as exc:
            result["errors"].append(f"Test failed: {exc}")
            self._state = CaptureState.ERROR
            self._error_message = str(exc)

        self._test_result = result
        self._emit(EventType.CAPTURE_HOTKEY_TEST, result)
        return result

    # ── Start capture ───────────────────────────────────────────────────────

    async def start_capture(self) -> dict[str, Any]:
        """Start recording via hotkey and begin file monitoring."""
        if self._state == CaptureState.CAPTURING:
            return {"success": False, "error": "Already capturing"}

        self._error_message = None
        self._capture_file = None
        self._capture_file_size = 0

        software = self.get_active_software()
        hotkeys = self.get_hotkeys()
        watch_dir = self.get_watch_directory()
        self._watch_dir = watch_dir

        if not hotkeys["start"]:
            self._state = CaptureState.ERROR
            self._error_message = "No start hotkey configured"
            return {"success": False, "error": self._error_message}

        # Check software is running
        if software and software != "manual":
            if not is_software_running(software):
                self._state = CaptureState.ERROR
                self._error_message = f"{software.upper()} is not running"
                self._emit(EventType.CAPTURE_ERROR, {"error": self._error_message})
                return {"success": False, "error": self._error_message}

        # Record the time before starting
        self._capture_start_time = time.time()

        # Send the start hotkey
        if platform.system() == "Windows":
            if not send_hotkey(hotkeys["start"]):
                self._state = CaptureState.ERROR
                self._error_message = "Failed to send start hotkey"
                self._emit(EventType.CAPTURE_ERROR, {"error": self._error_message})
                return {"success": False, "error": self._error_message}
        else:
            logger.info("[Capture] Would send start hotkey %s (non-Windows)", hotkeys["start"])

        self._state = CaptureState.CAPTURING
        self._emit(EventType.CAPTURE_STARTED, {
            "software": software,
            "watch_dir": watch_dir,
        })

        # Start background file monitor
        self._stop_monitoring.clear()
        self._monitor_thread = threading.Thread(
            target=self._monitor_loop, daemon=True, name="capture-monitor"
        )
        self._monitor_thread.start()

        return {"success": True, "state": self._state}

    # ── Stop capture ────────────────────────────────────────────────────────

    async def stop_capture(self) -> dict[str, Any]:
        """Stop recording and validate the capture file."""
        if self._state != CaptureState.CAPTURING:
            return {"success": False, "error": f"Not capturing (state: {self._state})"}

        hotkeys = self.get_hotkeys()
        stop_key = hotkeys["stop"] or hotkeys["start"]

        # Send the stop hotkey
        if platform.system() == "Windows":
            if not send_hotkey(stop_key):
                logger.warning("[Capture] Failed to send stop hotkey")
        else:
            logger.info("[Capture] Would send stop hotkey %s (non-Windows)", stop_key)

        # Stop the monitor thread
        self._stop_monitoring.set()
        if self._monitor_thread:
            self._monitor_thread.join(timeout=5)

        self._state = CaptureState.VALIDATING
        elapsed = time.time() - self._capture_start_time if self._capture_start_time else 0

        # Give the capture software a moment to finalize the file
        await asyncio.sleep(2)

        # Discover the capture file
        capture_file = self._find_capture_file()

        if capture_file:
            self._capture_file = capture_file["path"]
            self._capture_file_size = capture_file["size_bytes"]

            # Validate
            validation = validate_video_file(capture_file["path"])

            if validation["valid"]:
                self._state = CaptureState.COMPLETED
                result_data = {
                    "file_path": capture_file["path"],
                    "file_name": capture_file["name"],
                    "size_bytes": capture_file["size_bytes"],
                    "elapsed_seconds": round(elapsed, 1),
                    "validation": validation,
                }
                self._emit(EventType.CAPTURE_STOPPED, result_data)
                self._emit(EventType.CAPTURE_VALIDATED, validation)
                return {"success": True, **result_data}
            else:
                self._state = CaptureState.ERROR
                self._error_message = "; ".join(validation["errors"])
                self._emit(EventType.CAPTURE_ERROR, {"error": self._error_message, "validation": validation})
                return {"success": False, "error": self._error_message, "validation": validation}
        else:
            self._state = CaptureState.ERROR
            self._error_message = "No capture file found after recording"
            self._emit(EventType.CAPTURE_ERROR, {"error": self._error_message})
            return {"success": False, "error": self._error_message}

    # ── Reset ───────────────────────────────────────────────────────────────

    def reset(self) -> None:
        """Reset capture state to idle."""
        self._stop_monitoring.set()
        self._state = CaptureState.IDLE
        self._capture_start_time = 0
        self._capture_file = None
        self._capture_file_size = 0
        self._watch_dir = None
        self._error_message = None
        self._test_result = None

    # ── Internal helpers ────────────────────────────────────────────────────

    def _find_capture_file(self) -> Optional[dict]:
        """Find the most recent video file created since capture started."""
        if not self._watch_dir or not self._capture_start_time:
            return None

        # Allow 5s tolerance before start time (file may be created slightly before hotkey takes effect)
        files = get_recent_video_files(self._watch_dir, self._capture_start_time - 5)
        return files[0] if files else None

    def _monitor_loop(self) -> None:
        """Background thread: monitor capture progress (file size, elapsed time)."""
        logger.info("[Capture] Monitor thread started")

        while not self._stop_monitoring.is_set():
            try:
                elapsed = time.time() - self._capture_start_time if self._capture_start_time else 0

                # Check for new/growing file
                capture_file = self._find_capture_file()
                if capture_file:
                    self._capture_file = capture_file["path"]
                    self._capture_file_size = capture_file["size_bytes"]
                    self._emit(EventType.CAPTURE_FILE_DETECTED, {
                        "file_path": capture_file["path"],
                        "file_name": capture_file["name"],
                    })

                # Emit progress
                self._emit(EventType.CAPTURE_PROGRESS, {
                    "elapsed_seconds": round(elapsed, 1),
                    "file_size_bytes": self._capture_file_size,
                    "file_path": self._capture_file,
                    "state": self._state,
                })

            except Exception as exc:
                logger.error("[Capture] Monitor error: %s", exc)

            self._stop_monitoring.wait(timeout=2)  # Update every 2 seconds

        logger.info("[Capture] Monitor thread stopped")

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
            # Direct call if we're already in the right context
            try:
                self._broadcast_fn(message)
            except Exception:
                    logger.debug("Suppressed exception in cleanup", exc_info=True)


# ── Module-level singleton ──────────────────────────────────────────────────

capture_service = CaptureService()
