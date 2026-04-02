"""
native_capture_bridge.py -- Python bridge to the C++ capture service
--------------------------------------------------------------------
Manages the lrs_capture.exe lifecycle and reads frames from shared memory.

Frame transport:
  - C++ writes BGRA frames into a Windows shared-memory region
  - Python maps the same region and reads numpy arrays directly (zero-copy)

Control:
  - Commands sent via named pipe (length-prefixed JSON)
  - C++ responds with JSON status

Usage::

    bridge = NativeCaptureBridge()
    bridge.start()                       # launches lrs_capture.exe
    bridge.set_region(0, 0, 1920, 1080)  # crop to iRacing window
    frame = bridge.grab_frame()          # returns BGR numpy array or None
    bridge.stop()                        # kills the process
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes
import json
import logging
import mmap
import os
import platform
import struct
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

_IS_WINDOWS = platform.system() == "Windows"

# Must match frame_buffer.h constants
SHM_NAME = "Local\\LRS_CaptureFrame"
MAX_FRAME_BYTES = 3840 * 2160 * 4   # ~33 MB
HEADER_SIZE = 48                      # sizeof(FrameHeader) = 8+4+4+4+4+4+12 = 40 → padded to match C struct
PIPE_NAME = r"\\.\pipe\LRS_CaptureControl"

# ── FrameHeader layout (must match C++ struct) ─────────────────────────────
# struct FrameHeader {
#     uint64_t frame_id;      // 8 bytes
#     uint32_t width;         // 4
#     uint32_t height;        // 4
#     uint32_t stride;        // 4
#     uint32_t pixel_format;  // 4
#     uint32_t data_size;     // 4
#     uint32_t _reserved[3];  // 12
# };
HEADER_STRUCT = struct.Struct("<Q5I3I")  # 8 + 5*4 + 3*4 = 40 bytes


def _find_native_exe() -> Optional[Path]:
    """Locate lrs_capture.exe next to this module or in known build dirs."""
    # here = backend/server/utils/
    here = Path(__file__).resolve().parent
    # backend_dir = backend/
    backend_dir = here.parent.parent
    candidates = [
        # Development build location: backend/native_capture/build/Release/
        backend_dir / "native_capture" / "build" / "Release" / "lrs_capture.exe",
        backend_dir / "native_capture" / "build" / "lrs_capture.exe",
        backend_dir / "native_capture" / "lrs_capture.exe",
        # Alongside the Python file (deployed/bundled)
        here / "lrs_capture.exe",
        # PyInstaller _internal layout  
        backend_dir / "lrs_capture.exe",
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


class NativeCaptureBridge:
    """Manages the C++ capture service process and reads frames via shared memory."""

    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._shm_handle = None
        self._shm_mmap: Optional[mmap.mmap] = None
        self._pipe_handle = None
        self._last_frame_id: int = 0
        self._lock = threading.Lock()
        self._running = False

    @property
    def is_running(self) -> bool:
        return self._running and self._proc is not None and self._proc.poll() is None

    # ── Lifecycle ──────────────────────────────────────────────────────────

    def start(self, output_index: int = 0, timeout: float = 5.0) -> bool:
        """Launch the C++ capture service and connect to shared memory.

        Returns True on success, False if the native exe is missing or
        fails to start.
        """
        if self._running:
            return True

        exe = _find_native_exe()
        if not exe:
            logger.warning("[NativeCapture] lrs_capture.exe not found")
            return False

        logger.info("[NativeCapture] Starting %s", exe)

        try:
            self._proc = subprocess.Popen(
                [str(exe), "--output", str(output_index)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except OSError as exc:
            logger.error("[NativeCapture] Failed to launch: %s", exc)
            return False

        # Wait for the READY marker on stdout
        deadline = time.monotonic() + timeout
        ready = False
        while time.monotonic() < deadline:
            if self._proc.poll() is not None:
                stderr_out = self._proc.stderr.read().decode(errors="replace")
                logger.error("[NativeCapture] Process exited early: %s", stderr_out)
                self._proc = None
                return False
            line = self._proc.stdout.readline().decode(errors="replace").strip()
            if line == "READY":
                ready = True
                break

        if not ready:
            logger.error("[NativeCapture] Timed out waiting for READY")
            self.stop()
            return False

        # Connect to shared memory
        if not self._open_shm():
            logger.error("[NativeCapture] Failed to open shared memory")
            self.stop()
            return False

        self._running = True
        logger.info("[NativeCapture] Service started (PID %d)", self._proc.pid)
        return True

    def stop(self) -> None:
        """Stop the C++ capture service."""
        self._running = False

        # Send stop command (best-effort)
        try:
            self._send_command({"cmd": "stop"})
        except Exception:
            pass

        self._close_pipe()
        self._close_shm()

        if self._proc:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=3)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
            self._proc = None

        logger.info("[NativeCapture] Service stopped")

    # ── Frame reading ──────────────────────────────────────────────────────

    def grab_frame(self) -> Optional[np.ndarray]:
        """Read the latest frame from shared memory.

        Returns a BGR24 numpy array, or None if no new frame is available.
        """
        if not self._running or self._shm_mmap is None:
            return None

        try:
            # Read header from shared memory
            self._shm_mmap.seek(0)
            header_bytes = self._shm_mmap.read(HEADER_STRUCT.size)
            if len(header_bytes) < HEADER_STRUCT.size:
                return None

            (frame_id, width, height, stride, pixel_format,
             data_size, _r1, _r2, _r3) = HEADER_STRUCT.unpack(header_bytes)

            # Check if this is a new frame
            if frame_id == 0 or frame_id == self._last_frame_id:
                return None

            if data_size == 0 or width == 0 or height == 0:
                return None

            if data_size > MAX_FRAME_BYTES:
                return None

            # Read pixel data
            self._shm_mmap.seek(HEADER_SIZE)
            pixel_bytes = self._shm_mmap.read(data_size)
            if len(pixel_bytes) < data_size:
                return None

            self._last_frame_id = frame_id

            # Create numpy array (BGR24)
            frame = np.frombuffer(pixel_bytes, dtype=np.uint8).reshape(height, width, 3)
            # Make a contiguous copy so the shared memory can be overwritten
            return np.ascontiguousarray(frame)

        except Exception:
            logger.debug("[NativeCapture] grab_frame error", exc_info=True)
            return None

    def set_region(self, x: int, y: int, w: int, h: int) -> bool:
        """Tell the C++ service to crop to a specific screen region."""
        resp = self._send_command({"cmd": "set_region", "x": x, "y": y, "w": w, "h": h})
        return resp is not None and resp.get("status") == "ok"

    def status(self) -> Optional[dict]:
        """Query the C++ service status."""
        return self._send_command({"cmd": "status"})

    # ── Shared memory ──────────────────────────────────────────────────────

    def _open_shm(self) -> bool:
        """Open the shared memory region created by the C++ service."""
        if not _IS_WINDOWS:
            return False

        try:
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]

            # OpenFileMapping
            FILE_MAP_READ = 0x0004
            handle = kernel32.OpenFileMappingA(
                FILE_MAP_READ,
                False,
                SHM_NAME.encode("ascii"),
            )
            if not handle:
                logger.error("[NativeCapture] OpenFileMapping failed: %d",
                             kernel32.GetLastError())
                return False

            self._shm_handle = handle

            # MapViewOfFile
            ptr = kernel32.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0)
            if not ptr:
                logger.error("[NativeCapture] MapViewOfFile failed")
                kernel32.CloseHandle(handle)
                self._shm_handle = None
                return False

            # Wrap in mmap-like interface via ctypes buffer
            # We create a writable buffer from the mapped memory
            buf = (ctypes.c_char * (HEADER_STRUCT.size + MAX_FRAME_BYTES)).from_address(ptr)
            self._shm_mmap = memoryview(buf)
            # Actually, let's use a simpler approach: read from the mapped pointer
            # Store the raw pointer and size for direct reads
            self._shm_ptr = ptr
            self._shm_buf = buf
            # Create a fake mmap-like object
            self._shm_mmap = _ShmReader(ptr, HEADER_STRUCT.size + MAX_FRAME_BYTES)

            return True

        except Exception:
            logger.error("[NativeCapture] SHM open failed", exc_info=True)
            return False

    def _close_shm(self) -> None:
        """Release shared memory mappings."""
        if not _IS_WINDOWS:
            return
        try:
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            if hasattr(self, '_shm_ptr') and self._shm_ptr:
                kernel32.UnmapViewOfFile(self._shm_ptr)
                self._shm_ptr = None
            if self._shm_handle:
                kernel32.CloseHandle(self._shm_handle)
                self._shm_handle = None
        except Exception:
            pass
        self._shm_mmap = None

    # ── Named pipe IPC ─────────────────────────────────────────────────────

    def _ensure_pipe(self) -> bool:
        """Connect to the named pipe if not already connected."""
        if self._pipe_handle is not None:
            return True

        if not _IS_WINDOWS:
            return False

        try:
            handle = ctypes.windll.kernel32.CreateFileA(  # type: ignore[attr-defined]
                PIPE_NAME.encode("ascii"),
                0xC0000000,  # GENERIC_READ | GENERIC_WRITE
                0,           # no sharing
                None,        # default security
                3,           # OPEN_EXISTING
                0,           # default attributes
                None,
            )
            if handle == -1 or handle == 0xFFFFFFFF:
                return False
            self._pipe_handle = handle
            return True
        except Exception:
            return False

    def _send_command(self, cmd: dict) -> Optional[dict]:
        """Send a JSON command and read the JSON response."""
        with self._lock:
            if not self._ensure_pipe():
                return None

            try:
                payload = json.dumps(cmd).encode("utf-8")
                length_prefix = struct.pack("<I", len(payload))

                kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
                written = ctypes.wintypes.DWORD(0)

                # Write length + payload
                kernel32.WriteFile(
                    self._pipe_handle, length_prefix, 4,
                    ctypes.byref(written), None
                )
                kernel32.WriteFile(
                    self._pipe_handle, payload, len(payload),
                    ctypes.byref(written), None
                )
                kernel32.FlushFileBuffers(self._pipe_handle)

                # Read response length
                resp_len_buf = (ctypes.c_char * 4)()
                bytes_read = ctypes.wintypes.DWORD(0)
                kernel32.ReadFile(
                    self._pipe_handle, resp_len_buf, 4,
                    ctypes.byref(bytes_read), None
                )
                resp_len = struct.unpack("<I", bytes(resp_len_buf))[0]

                if resp_len == 0 or resp_len > 1024 * 1024:
                    return None

                # Read response payload
                resp_buf = (ctypes.c_char * resp_len)()
                kernel32.ReadFile(
                    self._pipe_handle, resp_buf, resp_len,
                    ctypes.byref(bytes_read), None
                )
                resp_json = bytes(resp_buf).decode("utf-8")
                return json.loads(resp_json)

            except Exception:
                logger.debug("[NativeCapture] pipe error", exc_info=True)
                self._close_pipe()
                return None

    def _close_pipe(self) -> None:
        """Close the named pipe handle."""
        if self._pipe_handle is not None:
            try:
                ctypes.windll.kernel32.CloseHandle(self._pipe_handle)  # type: ignore[attr-defined]
            except Exception:
                pass
            self._pipe_handle = None


class _ShmReader:
    """Minimal file-like reader over a raw memory-mapped pointer."""

    def __init__(self, ptr: int, size: int) -> None:
        self._ptr = ptr
        self._size = size
        self._pos = 0

    def seek(self, pos: int) -> None:
        self._pos = pos

    def read(self, n: int) -> bytes:
        if self._pos + n > self._size:
            n = self._size - self._pos
        if n <= 0:
            return b""
        buf = (ctypes.c_char * n).from_address(self._ptr + self._pos)
        self._pos += n
        return bytes(buf)
