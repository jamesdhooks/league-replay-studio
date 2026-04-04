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

PIPE_NAME = r"\\.\pipe\LRS_CaptureControl"

# Timeout for a single pipe command round-trip (seconds)
PIPE_CMD_TIMEOUT = 2.0

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

# Byte offset where pixel data starts in the SHM region.
# Must match sizeof(FrameHeader) from frame_buffer.h (with #pragma pack(1)).
HEADER_SIZE = HEADER_STRUCT.size  # 40 bytes; was wrongly 48 — caused 8-byte data misalignment


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

        # Throttled logging counters
        self._grab_calls: int = 0
        self._grab_frames: int = 0
        self._last_grab_log: float = 0.0
        self._last_pipe_warn: float = 0.0

        # Background output drainer threads
        self._stdout_drainer: Optional[threading.Thread] = None
        self._stderr_drainer: Optional[threading.Thread] = None

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
            logger.debug("[NativeCapture] start() called but already running")
            return True

        exe = _find_native_exe()
        if not exe:
            logger.warning("[NativeCapture] lrs_capture.exe not found in any candidate path")
            return False

        logger.info("[NativeCapture] Starting %s (output_index=%d, timeout=%.1fs)",
                    exe, output_index, timeout)

        try:
            self._proc = subprocess.Popen(
                [str(exe), "--output", str(output_index)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            logger.info("[NativeCapture] Process spawned (PID %d), waiting for READY...",
                        self._proc.pid)
        except OSError as exc:
            logger.error("[NativeCapture] Failed to launch exe: %s", exc)
            return False

        # Wait for the READY marker on stdout
        deadline = time.monotonic() + timeout
        ready = False
        lines_seen: list[str] = []
        while time.monotonic() < deadline:
            if self._proc.poll() is not None:
                # Process exited before sending READY
                try:
                    stderr_out = self._proc.stderr.read().decode(errors="replace").strip()
                except Exception:
                    stderr_out = "(could not read stderr)"
                logger.error(
                    "[NativeCapture] Process exited early (code=%s) before READY. "
                    "stdout lines=%s stderr=%r",
                    self._proc.returncode, lines_seen, stderr_out[:500],
                )
                self._proc = None
                return False

            try:
                line = self._proc.stdout.readline().decode(errors="replace").strip()
            except Exception as exc:
                logger.error("[NativeCapture] stdout readline error: %s", exc)
                break

            if line:
                lines_seen.append(line)
                logger.debug("[NativeCapture] exe stdout: %r", line)

            if line == "READY":
                ready = True
                elapsed = timeout - (deadline - time.monotonic())
                logger.info("[NativeCapture] READY received in %.2fs", elapsed)
                break

        if not ready:
            try:
                stderr_out = self._proc.stderr.read().decode(errors="replace").strip()
            except Exception:
                stderr_out = "(could not read stderr)"
            logger.error(
                "[NativeCapture] Timed out (%.1fs) waiting for READY. "
                "stdout lines=%s stderr=%r",
                timeout, lines_seen, stderr_out[:500],
            )
            self.stop()
            return False

        # Connect to shared memory before starting drainer threads
        logger.info("[NativeCapture] Connecting to shared memory region %r ...", SHM_NAME)
        if not self._open_shm():
            logger.error("[NativeCapture] Failed to open shared memory — stopping service")
            self.stop()
            return False

        # Start background threads to drain stdout/stderr so the pipe
        # buffer never fills up and stalls the C++ process.
        self._stdout_drainer = threading.Thread(
            target=self._drain_stdout,
            daemon=True,
            name="native-stdout",
        )
        self._stderr_drainer = threading.Thread(
            target=self._drain_stderr,
            daemon=True,
            name="native-stderr",
        )
        self._stdout_drainer.start()
        self._stderr_drainer.start()
        logger.debug("[NativeCapture] stdout/stderr drainer threads started")

        self._running = True
        logger.info("[NativeCapture] Service started (PID %d)", self._proc.pid)
        return True

    def stop(self) -> None:
        """Stop the C++ capture service."""
        logger.info("[NativeCapture] Stopping service...")
        self._running = False

        # Send stop command (best-effort, non-blocking)
        try:
            self._send_command({"cmd": "stop"})
        except Exception:
                logger.debug("Suppressed exception in cleanup", exc_info=True)

        self._close_pipe()
        self._close_shm()

        if self._proc:
            pid = self._proc.pid
            try:
                self._proc.terminate()
                self._proc.wait(timeout=3)
                logger.info("[NativeCapture] Process %d terminated cleanly", pid)
            except Exception:
                try:
                    self._proc.kill()
                    logger.warning("[NativeCapture] Process %d force-killed", pid)
                except Exception:
                        logger.debug("Suppressed exception in cleanup", exc_info=True)
            self._proc = None

        logger.info("[NativeCapture] Service stopped")

    # ── Background output drainers ─────────────────────────────────────────

    def _drain_stdout(self) -> None:
        """Read and log any stdout lines from the C++ process.

        Must run in a background thread — if stdout fills up, the C++ process
        will block on write() which stalls the entire service including IPC.
        """
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        try:
            for raw in proc.stdout:
                line = raw.decode(errors="replace").rstrip()
                if line:
                    logger.debug("[NativeCapture/stdout] %s", line)
        except Exception:
                logger.debug("Suppressed exception in cleanup", exc_info=True)
        logger.debug("[NativeCapture] stdout drainer exited")

    def _drain_stderr(self) -> None:
        """Read and log any stderr lines from the C++ process.

        stderr is where assertion failures, DXGI errors, and other C++
        diagnostics appear.
        """
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        try:
            for raw in proc.stderr:
                line = raw.decode(errors="replace").rstrip()
                if line:
                    logger.warning("[NativeCapture/stderr] %s", line)
        except Exception:
                logger.debug("Suppressed exception in cleanup", exc_info=True)
        logger.debug("[NativeCapture] stderr drainer exited")

    # ── Frame reading ──────────────────────────────────────────────────────

    def grab_frame(self) -> Optional[np.ndarray]:
        """Read the latest frame from shared memory.

        Returns a BGR24 numpy array, or None if no new frame is available.
        Logs a throttled status line (~every 5 seconds).
        """
        if not self._running or self._shm_mmap is None:
            return None

        self._grab_calls += 1

        try:
            # ── Sequence-lock read ────────────────────────────────────────
            # Read frame_id BEFORE reading the rest of the header/pixels.
            # After reading all pixel data we re-read frame_id and compare.
            # If it changed, the C++ producer wrote a new frame while we were
            # reading → torn data → discard and try again next tick.
            self._shm_mmap.seek(0)
            pre_id_bytes = self._shm_mmap.read(8)
            if len(pre_id_bytes) < 8:
                return None
            (pre_frame_id,) = struct.unpack('<Q', pre_id_bytes)

            # Read full header from shared memory
            self._shm_mmap.seek(0)
            header_bytes = self._shm_mmap.read(HEADER_STRUCT.size)
            if len(header_bytes) < HEADER_STRUCT.size:
                logger.debug("[NativeCapture] grab_frame: header too short (%d bytes)",
                             len(header_bytes))
                return None

            (frame_id, width, height, stride, pixel_format,
             data_size, _r1, _r2, _r3) = HEADER_STRUCT.unpack(header_bytes)

            # Throttled status log every 5 seconds
            now = time.monotonic()
            if now - self._last_grab_log >= 5.0:
                proc_alive = self._proc is not None and self._proc.poll() is None
                logger.info(
                    "[NativeCapture] status: running=%s proc_alive=%s "
                    "calls=%d frames=%d frame_id=%d shm=(%dx%d sz=%d stride=%d fmt=%d)",
                    self._running, proc_alive,
                    self._grab_calls, self._grab_frames,
                    frame_id, width, height, data_size, stride, pixel_format,
                )
                self._last_grab_log = now

            # Check if this is a new frame
            if frame_id == 0 or frame_id == self._last_frame_id:
                return None

            if data_size == 0 or width == 0 or height == 0:
                logger.debug("[NativeCapture] grab_frame: empty frame header "
                             "(id=%d w=%d h=%d sz=%d)", frame_id, width, height, data_size)
                return None

            # Determine the true byte count to read.
            # stride = bytes per row as written by C++.  Use it directly when
            # non-zero; fall back to data_size so older builds still work.
            bytes_per_row = stride if stride > 0 else (data_size // height if height else 0)
            read_size = bytes_per_row * height if bytes_per_row > 0 else data_size

            if read_size > MAX_FRAME_BYTES:
                logger.warning("[NativeCapture] grab_frame: read_size %d exceeds max %d "
                               "(stride=%d w=%d h=%d)", read_size, MAX_FRAME_BYTES,
                               stride, width, height)
                return None

            # Read pixel data
            self._shm_mmap.seek(HEADER_SIZE)
            pixel_bytes = self._shm_mmap.read(read_size)
            if len(pixel_bytes) < read_size:
                logger.debug("[NativeCapture] grab_frame: short pixel read "
                             "(%d < %d)", len(pixel_bytes), read_size)
                return None

            # ── Sequence-lock verification ────────────────────────────
            # Re-read frame_id to confirm C++ didn't update the frame
            # while we were reading pixel data.
            self._shm_mmap.seek(0)
            post_id_bytes = self._shm_mmap.read(8)
            if len(post_id_bytes) >= 8:
                (post_frame_id,) = struct.unpack('<Q', post_id_bytes)
                if post_frame_id != pre_frame_id:
                    # Producer wrote a new frame mid-read → torn data → skip
                    logger.debug(
                        "[NativeCapture] grab_frame: torn read detected "
                        "(pre_id=%d post_id=%d) — discarding frame",
                        pre_frame_id, post_frame_id,
                    )
                    return None

            self._last_frame_id = frame_id
            self._grab_frames += 1

            # Decode to BGR24 numpy array, handling BGRA stride correctly.
            arr = np.frombuffer(pixel_bytes, dtype=np.uint8)
            if bytes_per_row == width * 4:
                # BGRA layout (DXGI/WGC native) — reshape to (H, W, 4) then drop alpha
                bgra = arr.reshape(height, width, 4)
                frame = np.ascontiguousarray(bgra[:, :, :3])  # drop A → BGR
            elif bytes_per_row == width * 3:
                # Packed BGR24 — reshape directly
                frame = np.ascontiguousarray(arr.reshape(height, width, 3))
            else:
                # Unknown stride: extract the first width*3 bytes from each row
                logger.warning("[NativeCapture] grab_frame: unexpected stride %d "
                               "(expected %d for BGR or %d for BGRA) — slicing rows",
                               bytes_per_row, width * 3, width * 4)
                rows = arr.reshape(height, bytes_per_row)
                frame = np.ascontiguousarray(rows[:, : width * 3].reshape(height, width, 3))

            return frame

        except Exception:
            logger.debug("[NativeCapture] grab_frame error", exc_info=True)
            return None

    def set_region(self, x: int, y: int, w: int, h: int) -> bool:
        """Tell the C++ service to crop to a specific screen region (DXGI mode)."""
        logger.debug("[NativeCapture] set_region(%d, %d, %d, %d)", x, y, w, h)
        resp = self._send_command({"cmd": "set_region", "x": x, "y": y, "w": w, "h": h})
        ok = resp is not None and resp.get("status") == "ok"
        if ok:
            logger.info("[NativeCapture] region set to (%d,%d) %dx%d", x, y, w, h)
        else:
            logger.warning("[NativeCapture] set_region failed (resp=%s)", resp)
        return ok

    def set_hwnd(self, hwnd: int) -> bool:
        """Tell the C++ service to capture a specific window via WGC (preferred)."""
        logger.debug("[NativeCapture] set_hwnd(%d)", hwnd)
        resp = self._send_command({"cmd": "set_hwnd", "hwnd": hwnd})
        ok = resp is not None and resp.get("status") == "ok"
        if ok:
            mode = resp.get("mode", "?")
            logger.info("[NativeCapture] HWND %d captured (mode=%s)", hwnd, mode)
        else:
            logger.warning("[NativeCapture] set_hwnd failed (resp=%s)", resp)
        return ok

    def status(self) -> Optional[dict]:
        """Query the C++ service status."""
        logger.debug("[NativeCapture] sending status command")
        return self._send_command({"cmd": "status"})

    # ── Shared memory ──────────────────────────────────────────────────────

    def _open_shm(self) -> bool:
        """Open the shared memory region created by the C++ service."""
        if not _IS_WINDOWS:
            logger.warning("[NativeCapture] _open_shm: not Windows, skipping")
            return False

        try:
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]

            # Fix 64-bit pointer handling: MapViewOfFile returns LPVOID (8 bytes on
            # 64-bit Windows).  Without an explicit restype ctypes defaults to c_int
            # (32-bit) and silently truncates the upper 32 bits → wrong address →
            # crash when the SHM is mapped above the 4 GB boundary.
            kernel32.OpenFileMappingA.restype = ctypes.c_void_p
            kernel32.MapViewOfFile.restype = ctypes.c_void_p
            kernel32.MapViewOfFile.argtypes = [
                ctypes.wintypes.HANDLE,   # hFileMappingObject
                ctypes.wintypes.DWORD,    # dwDesiredAccess
                ctypes.wintypes.DWORD,    # dwFileOffsetHigh
                ctypes.wintypes.DWORD,    # dwFileOffsetLow
                ctypes.c_size_t,          # dwNumberOfBytesToMap
            ]
            # UnmapViewOfFile must receive the full 64-bit address
            kernel32.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
            kernel32.UnmapViewOfFile.restype  = ctypes.wintypes.BOOL

            # OpenFileMapping
            FILE_MAP_READ = 0x0004
            logger.debug("[NativeCapture] OpenFileMappingA(%r, FILE_MAP_READ)", SHM_NAME)
            handle = kernel32.OpenFileMappingA(
                FILE_MAP_READ,
                False,
                SHM_NAME.encode("ascii"),
            )
            if not handle:
                err = ctypes.windll.kernel32.GetLastError()
                logger.error("[NativeCapture] OpenFileMappingA failed (error=%d). "
                             "Is the C++ service running and has it created the SHM?", err)
                return False

            self._shm_handle = int(handle)  # store as plain int (c_void_p)
            logger.debug("[NativeCapture] SHM handle opened: 0x%x", self._shm_handle)

            # MapViewOfFile — with c_void_p restype this is the full 64-bit address;
            # NULL (failure) is returned as Python None.
            ptr = kernel32.MapViewOfFile(self._shm_handle, FILE_MAP_READ, 0, 0, 0)
            if not ptr:
                err = ctypes.windll.kernel32.GetLastError()
                logger.error("[NativeCapture] MapViewOfFile failed (error=%d)", err)
                kernel32.CloseHandle(self._shm_handle)
                self._shm_handle = None
                return False

            ptr = int(ptr)  # ensure plain Python int for arithmetic
            shm_total = HEADER_STRUCT.size + MAX_FRAME_BYTES
            logger.info("[NativeCapture] SHM mapped at ptr=0x%x, size=%d bytes (%.1f MB)",
                        ptr, shm_total, shm_total / 1024 / 1024)

            # Wrap the raw pointer in our file-like reader
            self._shm_ptr = ptr
            self._shm_mmap = _ShmReader(ptr, shm_total)

            return True

        except Exception:
            logger.error("[NativeCapture] SHM open raised exception", exc_info=True)
            return False

    def _close_shm(self) -> None:
        """Release shared memory mappings."""
        if not _IS_WINDOWS:
            return
        try:
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            # Re-apply argtypes so UnmapViewOfFile receives the full 64-bit address
            kernel32.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
            kernel32.UnmapViewOfFile.restype  = ctypes.wintypes.BOOL
            if hasattr(self, '_shm_ptr') and self._shm_ptr:
                kernel32.UnmapViewOfFile(self._shm_ptr)
                self._shm_ptr = None
                logger.debug("[NativeCapture] SHM unmapped")
            if self._shm_handle:
                kernel32.CloseHandle(self._shm_handle)
                self._shm_handle = None
                logger.debug("[NativeCapture] SHM handle closed")
        except Exception:
            logger.debug("[NativeCapture] _close_shm error", exc_info=True)
        self._shm_mmap = None

    # ── Named pipe IPC ─────────────────────────────────────────────────────

    def _ensure_pipe(self) -> bool:
        """Connect to the named pipe if not already connected."""
        if self._pipe_handle is not None:
            return True

        if not _IS_WINDOWS:
            return False

        try:
            logger.debug("[NativeCapture] connecting to pipe %r", PIPE_NAME)
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
                err = ctypes.windll.kernel32.GetLastError()
                now = time.monotonic()
                if now - self._last_pipe_warn >= 10.0:
                    logger.warning("[NativeCapture] pipe connect failed (error=%d). "
                                   "IPC commands will be skipped.", err)
                    self._last_pipe_warn = now
                return False
            self._pipe_handle = handle
            logger.info("[NativeCapture] pipe connected (handle=%d)", handle)
            return True
        except Exception:
            logger.debug("[NativeCapture] _ensure_pipe exception", exc_info=True)
            return False

    def _send_command(self, cmd: dict) -> Optional[dict]:
        """Send a JSON command and read the JSON response.

        Runs the actual I/O in a daemon thread so it cannot block the caller
        indefinitely.  If no response arrives within PIPE_CMD_TIMEOUT seconds,
        the command is abandoned and None is returned.
        """
        result: list[Optional[dict]] = [None]

        def _do() -> None:
            result[0] = self._send_command_blocking(cmd)

        worker = threading.Thread(target=_do, daemon=True, name="native-pipe-cmd")
        worker.start()
        worker.join(timeout=PIPE_CMD_TIMEOUT)

        if worker.is_alive():
            now = time.monotonic()
            if now - self._last_pipe_warn >= 10.0:
                logger.warning(
                    "[NativeCapture] pipe command %r timed out after %.1fs — "
                    "service may be unresponsive; IPC will be skipped",
                    cmd.get("cmd"), PIPE_CMD_TIMEOUT,
                )
                self._last_pipe_warn = now
            # Don't close the pipe here — the worker thread holds it; let it finish
            # in its own time since it's a daemon thread.
            return None

        return result[0]

    def _send_command_blocking(self, cmd: dict) -> Optional[dict]:
        """Blocking version of _send_command (runs inside a timeout thread)."""
        with self._lock:
            if not self._ensure_pipe():
                return None

            try:
                payload = json.dumps(cmd).encode("utf-8")
                length_prefix = struct.pack("<I", len(payload))

                kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
                written = ctypes.wintypes.DWORD(0)

                logger.debug("[NativeCapture] pipe write: cmd=%r (%d bytes)",
                             cmd.get("cmd"), len(payload))

                # Write length + payload
                ok1 = kernel32.WriteFile(
                    self._pipe_handle, length_prefix, 4,
                    ctypes.byref(written), None,
                )
                ok2 = kernel32.WriteFile(
                    self._pipe_handle, payload, len(payload),
                    ctypes.byref(written), None,
                )
                kernel32.FlushFileBuffers(self._pipe_handle)

                if not ok1 or not ok2:
                    err = kernel32.GetLastError()
                    logger.warning("[NativeCapture] pipe write failed (error=%d)", err)
                    self._close_pipe()
                    return None

                # Read response length
                resp_len_buf = (ctypes.c_char * 4)()
                bytes_read = ctypes.wintypes.DWORD(0)
                ok3 = kernel32.ReadFile(
                    self._pipe_handle, resp_len_buf, 4,
                    ctypes.byref(bytes_read), None,
                )
                if not ok3 or bytes_read.value < 4:
                    err = kernel32.GetLastError()
                    logger.warning("[NativeCapture] pipe read (length) failed "
                                   "(error=%d, read=%d)", err, bytes_read.value)
                    self._close_pipe()
                    return None

                resp_len = struct.unpack("<I", bytes(resp_len_buf))[0]
                if resp_len == 0 or resp_len > 1024 * 1024:
                    logger.warning("[NativeCapture] pipe: invalid response length %d",
                                   resp_len)
                    return None

                # Read response payload
                resp_buf = (ctypes.c_char * resp_len)()
                ok4 = kernel32.ReadFile(
                    self._pipe_handle, resp_buf, resp_len,
                    ctypes.byref(bytes_read), None,
                )
                if not ok4:
                    err = kernel32.GetLastError()
                    logger.warning("[NativeCapture] pipe read (payload) failed "
                                   "(error=%d)", err)
                    self._close_pipe()
                    return None

                resp_json = bytes(resp_buf).decode("utf-8")
                parsed = json.loads(resp_json)
                logger.debug("[NativeCapture] pipe response: %s", parsed)
                return parsed

            except Exception:
                logger.warning("[NativeCapture] pipe command exception", exc_info=True)
                self._close_pipe()
                return None

    def _close_pipe(self) -> None:
        """Close the named pipe handle."""
        if self._pipe_handle is not None:
            try:
                ctypes.windll.kernel32.CloseHandle(self._pipe_handle)  # type: ignore[attr-defined]
                logger.debug("[NativeCapture] pipe handle closed")
            except Exception:
                    logger.debug("Suppressed exception in cleanup", exc_info=True)
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
