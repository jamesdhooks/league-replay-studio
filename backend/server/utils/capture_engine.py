"""
capture_engine.py  --  Zero-copy FFmpeg capture pipeline (v4)
-------------------------------------------------------------
High-performance multi-backend capture engine for iRacing window streaming.

Hot-path design rules:
  - NO PIL in the capture/encode loop (numpy arrays only)
  - JPEG encoding via FFmpeg subprocess (uses libjpeg-turbo SIMD, not Pillow)
  - dxcam drives its own FPS via target_fps (no Python sleep jitter)
  - PrintWindow writes directly into a pre-allocated numpy buffer
  - Writer threads decouple capture from pipe I/O (frame dropping > latency)

Architecture::

    Capture Thread          deque(2)     Preview Writer      Reader Thread
    +----------------+   +--------+    +---------------+   +-----------+
    | dxcam / PW     |-->| frames |==> | FFmpeg stdin  |-->| SOI/EOI   |
    | -> numpy BGR   |   | (drop) |    | -c:v mjpeg    |   | scanner   |
    +----------------+   +--------+    +---------------+   +-----------+
            |                                                     |
            |            deque(2)    Record Writer (CPU mode)      v
            +----------->| frames |==> FFmpeg stdin -> file  latest_jpeg
                         | (drop) |    -c:v h264_nvenc
                         +--------+

    GPU recording mode (alternative -- no Python in hot path):
    +-------------------------------------------------------------+
    | FFmpeg subprocess: -f gdigrab -> h264_nvenc -> output.mp4   |
    | Python only spawns and stops the process (control plane)     |
    +-------------------------------------------------------------+

Capture backends:
  1. native -- C++ DXGI Desktop Duplication service (shared memory, best).
  2. dxcam  -- Python DXGI Desktop Duplication, 60-240 FPS, GPU-backed.
  3. PrintWindow -- Win32 GDI, ~10-20 FPS, last resort (black for DX games).

Recording modes:
  - "gpu":  FFmpeg gdigrab captures directly -> NVENC.  Zero Python hot path.
  - "cpu":  Capture thread -> queue -> writer thread -> FFmpeg stdin pipe.
  - "auto": Tries GPU first, falls back to CPU.

Usage::

    engine = CaptureEngine()
    engine.start(fps=30, quality=70, max_width=1280)
    jpeg = engine.latest_jpeg   # bytes or None

    # GPU-native recording (recommended -- zero Python in hot path)
    engine.start_recording("output.mp4", mode="gpu")

    # CPU pipe recording (fallback, allows per-frame processing)
    engine.start_recording("output.mp4", mode="cpu")

    engine.stop_recording()
    engine.stop()
"""

from __future__ import annotations

import collections
import ctypes
import ctypes.wintypes
import logging
import platform
import signal
import subprocess
import threading
import time
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

_IS_WINDOWS = platform.system() == "Windows"

# ---------------------------------------------------------------------------
# JPEG encoder  (cv2.imencode — already a project dependency)
# ---------------------------------------------------------------------------

_cv2 = None
try:
    import cv2 as _cv2_mod
    _cv2 = _cv2_mod
except ImportError:
    pass

# ---------------------------------------------------------------------------
# dxcam availability
# ---------------------------------------------------------------------------

_dxcam = None
_dxcam_available = False
_native_available = False

if _IS_WINDOWS:
    try:
        import dxcam as _dxcam_mod  # type: ignore[import-untyped]
        _dxcam = _dxcam_mod
        _dxcam_available = True
        logger.info("[CaptureEngine] dxcam available")
    except ImportError:
        logger.info("[CaptureEngine] dxcam not installed")
    except Exception as exc:
        logger.warning("[CaptureEngine] dxcam import failed: %s", exc)

    try:
        from server.utils.native_capture_bridge import NativeCaptureBridge, _find_native_exe
        _native_available = _find_native_exe() is not None
        if _native_available:
            logger.info("[CaptureEngine] native capture service available")
        else:
            logger.info("[CaptureEngine] native capture exe not found")
    except Exception as exc:
        logger.info("[CaptureEngine] native capture bridge not available: %s", exc)


# ---------------------------------------------------------------------------
# BITMAPINFOHEADER (module-level, created once)
# ---------------------------------------------------------------------------

class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize",          ctypes.wintypes.DWORD),
        ("biWidth",         ctypes.wintypes.LONG),
        ("biHeight",        ctypes.wintypes.LONG),
        ("biPlanes",        ctypes.wintypes.WORD),
        ("biBitCount",      ctypes.wintypes.WORD),
        ("biCompression",   ctypes.wintypes.DWORD),
        ("biSizeImage",     ctypes.wintypes.DWORD),
        ("biXPelsPerMeter", ctypes.wintypes.LONG),
        ("biYPelsPerMeter", ctypes.wintypes.LONG),
        ("biClrUsed",       ctypes.wintypes.DWORD),
        ("biClrImportant",  ctypes.wintypes.DWORD),
    ]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _find_ffmpeg() -> Optional[str]:
    """Re-use gpu_detection's finder so we don't duplicate logic."""
    try:
        from server.utils.gpu_detection import find_ffmpeg
        return find_ffmpeg()
    except Exception:
        import shutil
        return shutil.which("ffmpeg")


def _scale_dims(src_w: int, src_h: int, max_w: int) -> tuple[int, int]:
    """Return (dst_w, dst_h) scaled to fit *max_w*, both divisible by 2."""
    if src_w <= max_w:
        # Ensure even
        return src_w & ~1, src_h & ~1
    ratio = max_w / src_w
    dst_w = int(src_w * ratio) & ~1
    dst_h = int(src_h * ratio) & ~1
    return max(2, dst_w), max(2, dst_h)


# ===========================================================================
# CaptureEngine
# ===========================================================================

class CaptureEngine:
    """Multi-backend capture engine with FFmpeg MJPEG encoding.

    All frames stay as numpy arrays until they hit FFmpeg's stdin.
    FFmpeg does the scaling, colour-space conversion, and JPEG encoding
    using SIMD-optimised libjpeg-turbo -- far faster than Pillow.
    """

    def __init__(self, backend: str = "auto") -> None:
        self._backend_pref = backend
        self._active_backend: Optional[str] = None
        self._running = False

        # Threads / subprocess
        self._capture_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

        # Output: latest JPEG (swapped atomically, no lock needed for reads
        # because bytes objects are immutable and ref assignment is atomic in
        # CPython.)
        self._latest_jpeg: Optional[bytes] = None

        # Params (set by start())
        self._fps: int = 30
        self._quality: int = 70
        self._max_width: int = 1280
        self._out_w: int = 0
        self._out_h: int = 0
        self._src_w: int = 0
        self._src_h: int = 0
        self._frame_nbytes: int = 0  # per-frame byte count for BGR24

        # dxcam state
        self._dxcam_camera = None
        self._dxcam_started = False
        self._dxcam_region: Optional[tuple[int, int, int, int]] = None
        self._dxcam_create_fails: int = 0        # consecutive _dxcam.create() failures
        self._dxcam_create_next_try: float = 0.0  # monotonic backoff deadline

        # PrintWindow cached GDI state
        self._pw_hwnd: Optional[int] = None
        self._pw_gdi_w: int = 0
        self._pw_gdi_h: int = 0
        self._pw_hwnd_dc: Optional[int] = None
        self._pw_mem_dc: Optional[int] = None
        self._pw_bitmap: Optional[int] = None
        self._pw_np_buf: Optional[np.ndarray] = None  # pre-allocated BGRA buffer
        self._pw_bmi = _BITMAPINFOHEADER()
        self._pw_last_hwnd_check: float = 0.0

        # Native capture bridge (C++ DXGI/WGC service)
        self._native_bridge: Optional[object] = None
        self._native_hwnd: Optional[int] = None   # last HWND sent to C++ service
        self._native_wgc_ok: Optional[bool] = None  # None=untested True=WGC False=use DXGI rect

        # Metrics
        self._frame_count: int = 0
        self._start_time: float = 0.0
        self._last_fps: float = 0.0
        self._metrics_lock = threading.Lock()
        self._mw_start: float = 0.0  # metrics window start
        self._mw_frames: int = 0

        # Recording (GPU-accelerated H.264/HEVC to file)
        self._record_proc: Optional[subprocess.Popen] = None
        self._record_path: Optional[str] = None
        self._recording: bool = False
        self._record_codec: Optional[str] = None
        self._recording_mode: Optional[str] = None  # "gpu" | "cpu"

        # Writer thread queues (for CPU recording only)
        self._record_queue: collections.deque = collections.deque(maxlen=2)
        self._record_writer: Optional[threading.Thread] = None
        self._frames_dropped: int = 0

        # H.264 live stream feed queue (filled by capture loop, drained by endpoint thread)
        self._h264_queue: collections.deque = collections.deque(maxlen=4)
        self._h264_streaming: bool = False
        self._h264_gen: int = 0  # generation token — prevents stale stop from killing a newer stream

    # -- Properties ---------------------------------------------------------

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def active_backend(self) -> Optional[str]:
        return self._active_backend

    @property
    def latest_jpeg(self) -> Optional[bytes]:
        return self._latest_jpeg  # atomic read in CPython

    @property
    def metrics(self) -> dict:
        with self._metrics_lock:
            return {
                "running": self._running,
                "backend": self._active_backend,
                "fps": round(self._last_fps, 1),
                "total_frames": self._frame_count,
                "frames_dropped": self._frames_dropped,
                "uptime_seconds": (
                    round(time.monotonic() - self._start_time, 1)
                    if self._running else 0
                ),
                "resolution": (
                    f"{self._out_w}x{self._out_h}" if self._out_w else None
                ),
                "recording": self._recording,
                "recording_mode": self._recording_mode,
                "record_path": self._record_path,
                "record_codec": self._record_codec,
            }

    # -- Lifecycle ----------------------------------------------------------

    def start(
        self,
        fps: int = 30,
        quality: int = 70,
        max_width: int = 1280,
    ) -> None:
        if self._running:
            logger.warning("[CaptureEngine] already running")
            return

        # Read capture_backend preference from settings (if available)
        try:
            from server.services.settings_service import settings_service
            pref = settings_service.get("preview_backend", "auto")
            if pref and isinstance(pref, str):
                self._backend_pref = pref
        except Exception:
            pass  # keep default

        self._fps = max(1, min(fps, 60))
        self._quality = max(10, min(quality, 100))
        self._max_width = max(320, min(max_width, 3840))
        self._stop_event.clear()
        self._frame_count = 0
        self._start_time = time.monotonic()
        self._mw_start = time.monotonic()
        self._mw_frames = 0
        self._running = True

        self._active_backend = self._choose_backend()
        logger.info(
            "[CaptureEngine] start backend=%s fps=%d q=%d max_w=%d",
            self._active_backend, self._fps, self._quality, self._max_width,
        )

        self._capture_thread = threading.Thread(
            target=self._capture_loop, daemon=True, name="cap-grab",
        )
        self._capture_thread.start()

    def update_params(
        self,
        quality: Optional[int] = None,
        max_width: Optional[int] = None,
        fps: Optional[int] = None,
    ) -> None:
        """Live-update quality/resolution/fps without restarting the engine."""
        if quality is not None:
            self._quality = max(10, min(quality, 100))
        if max_width is not None:
            self._max_width = max(320, min(max_width, 3840))
        if fps is not None:
            self._fps = max(1, min(fps, 60))
        logger.info(
            "[CaptureEngine] update_params q=%d max_w=%d fps=%d",
            self._quality, self._max_width, self._fps,
        )

    def start_h264_feed(self) -> int:
        """Enable the raw-frame queue so the H.264 endpoint can drain it.

        Returns a generation token that the caller must pass to stop_h264_feed()
        to prevent a stale cleanup from killing a newer concurrent stream.
        """
        self._h264_gen += 1
        self._h264_queue.clear()
        self._h264_streaming = True
        return self._h264_gen

    def stop_h264_feed(self, gen: int) -> None:
        """Disable the raw-frame queue only if *gen* matches the current generation.

        Passing the token returned by start_h264_feed() ensures that a delayed
        cleanup from an old request never silences a newer stream that already
        called start_h264_feed().
        """
        if gen != self._h264_gen:
            return  # stale cleanup — a newer stream is already running
        self._h264_streaming = False
        self._h264_queue.clear()

    def stop(self) -> None:
        if not self._running:
            return
        logger.info("[CaptureEngine] stopping...")
        self._stop_event.set()
        self._running = False

        if self._capture_thread:
            self._capture_thread.join(timeout=5)
        if self._record_writer:
            self._record_writer.join(timeout=5)

        self._kill_recorder()
        self._cleanup_native()
        self._cleanup_dxcam()
        self._release_pw_gdi()
        self._record_queue.clear()
        self._h264_streaming = False
        self._h264_queue.clear()
        logger.info("[CaptureEngine] stopped")

    # -- Backend selection --------------------------------------------------

    def _choose_backend(self) -> str:
        """Select capture backend.

        Priority order (configurable via backend preference):
          1. native  -- C++ DXGI Desktop Duplication service (best)
          2. dxcam   -- Python DXGI library (good, default fallback)
          3. printwindow -- Win32 GDI (last resort, black for DX games)

        When backend_pref is "auto", the first available is used.
        """
        pref = self._backend_pref

        # Explicit preference
        if pref == "native" and _native_available:
            return "native"
        if pref == "dxcam" and _dxcam_available:
            return "dxcam"
        if pref == "printwindow":
            return "printwindow"

        # Auto: try native first, then dxcam, then printwindow
        if pref == "auto":
            if _native_available:
                return "native"
            if _dxcam_available:
                return "dxcam"
            return "printwindow"

        # Fallback for any unrecognised pref
        if _native_available:
            return "native"
        if _dxcam_available:
            return "dxcam"
        return "printwindow"

    # -- Recording to file --------------------------------------------------

    def start_recording(
        self,
        output_path: str,
        codec: str = "auto",
        preset: str = "p4",
        cq: int = 23,
        mode: str = "auto",
    ) -> dict:
        """Start recording to file with GPU-accelerated encoding.

        Supports two recording modes:

          - ``"gpu"``:  FFmpeg captures directly via gdigrab -> NVENC encoder.
                        Zero Python in the recording hot path.  Best perf.
          - ``"cpu"``:  Capture thread -> queue -> writer thread -> FFmpeg stdin.
                        Allows per-frame processing.  Fallback if gdigrab fails.
          - ``"auto"``: Tries GPU mode first, falls back to CPU mode.

        Args:
            output_path: Path to the output video file (e.g. "output.mp4").
            codec: FFmpeg codec name or "auto" to detect best GPU encoder.
            preset: Encoder preset (NVENC: p1-p7, x264: ultrafast-veryslow).
            cq: Constant quality value (lower = higher quality).
            mode: Recording mode: "auto", "gpu", or "cpu".

        Returns:
            Dict with recording status info.
        """
        if not self._running:
            raise RuntimeError("Capture engine must be running before recording")
        if self._recording:
            self.stop_recording()

        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            raise RuntimeError("FFmpeg not found in PATH")

        # Detect best GPU encoder
        ffmpeg_codec = codec
        if codec == "auto":
            try:
                from server.utils.gpu_detection import get_best_encoder
                enc = get_best_encoder("h264")
                ffmpeg_codec = enc["ffmpeg_codec"]
            except Exception:
                ffmpeg_codec = "libx264"

        # Try GPU mode first (gdigrab -> encoder, no Python in hot path)
        if mode in ("auto", "gpu"):
            result = self._start_gpu_recording(
                ffmpeg, ffmpeg_codec, output_path, preset, cq,
            )
            if result:
                return result
            if mode == "gpu":
                raise RuntimeError(
                    "GPU recording (gdigrab) failed -- window not found or not visible"
                )
            logger.info(
                "[CaptureEngine] GPU recording unavailable, falling back to CPU pipe"
            )

        # CPU pipe mode (fallback or explicit)
        return self._start_cpu_recording(
            ffmpeg, ffmpeg_codec, output_path, preset, cq,
        )

    def _start_gpu_recording(
        self, ffmpeg: str, codec: str, output_path: str,
        preset: str, cq: int,
    ) -> Optional[dict]:
        """Start recording via FFmpeg gdigrab -> encoder (zero Python hot path).

        FFmpeg captures the desktop region corresponding to the iRacing window
        and encodes directly -- no numpy, no pipe writes, no Python overhead.
        """
        from server.utils.window_capture import _find_iracing_hwnd, _get_window_rect

        hwnd = _find_iracing_hwnd()
        if hwnd is None:
            return None
        rect = _get_window_rect(hwnd)
        if not rect:
            return None

        x, y = rect["left"], rect["top"]
        w, h = rect["width"] & ~1, rect["height"] & ~1  # even dimensions
        if w < 100 or h < 100:
            return None

        cmd = [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "gdigrab",
            "-framerate", str(self._fps),
            "-offset_x", str(x),
            "-offset_y", str(y),
            "-video_size", f"{w}x{h}",
            "-i", "desktop",
        ]
        cmd += self._encoder_flags(codec, preset, cq)
        cmd += ["-pix_fmt", "yuv420p", output_path]

        logger.info(
            "[CaptureEngine] GPU recording: gdigrab %dx%d+%d+%d -> %s -> %s",
            w, h, x, y, codec, output_path,
        )

        try:
            cflags = subprocess.CREATE_NEW_PROCESS_GROUP if _IS_WINDOWS else 0
            self._record_proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=cflags,
            )
            # Quick sanity check -- if process dies immediately, gdigrab failed
            time.sleep(0.3)
            if self._record_proc.poll() is not None:
                stderr = ""
                if self._record_proc.stderr:
                    stderr = self._record_proc.stderr.read().decode(
                        errors="replace"
                    )[:200]
                logger.warning("[CaptureEngine] gdigrab failed: %s", stderr)
                self._record_proc = None
                return None
        except Exception as exc:
            logger.warning("[CaptureEngine] gdigrab start failed: %s", exc)
            return None

        self._record_path = output_path
        self._record_codec = codec
        self._recording_mode = "gpu"
        self._recording = True

        return {
            "status": "recording",
            "mode": "gpu",
            "path": output_path,
            "codec": codec,
            "resolution": f"{w}x{h}",
            "fps": self._fps,
        }

    def _start_cpu_recording(
        self, ffmpeg: str, codec: str, output_path: str,
        preset: str, cq: int,
    ) -> dict:
        """Start recording via capture -> queue -> writer thread -> FFmpeg stdin."""
        if self._src_w == 0 or self._src_h == 0:
            raise RuntimeError(
                "No frames captured yet -- wait for stream to initialise"
            )

        cmd = [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "rawvideo",
            "-pixel_format", "bgr24",
            "-video_size", f"{self._src_w}x{self._src_h}",
            "-framerate", str(self._fps),
            "-i", "pipe:0",
        ]
        cmd += self._encoder_flags(codec, preset, cq)
        cmd += ["-pix_fmt", "yuv420p", output_path]

        logger.info(
            "[CaptureEngine] CPU recording: %s -> %s", codec, output_path,
        )

        self._record_proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=self._src_w * self._src_h * 3 * 4,
        )
        self._record_path = output_path
        self._record_codec = codec
        self._recording_mode = "cpu"

        # Clear queue and start dedicated writer thread
        self._record_queue.clear()
        self._record_writer = threading.Thread(
            target=self._record_writer_loop, daemon=True, name="cap-record-wr",
        )
        self._record_writer.start()

        # Set flag LAST -- capture thread checks this before enqueuing
        self._recording = True

        return {
            "status": "recording",
            "mode": "cpu",
            "path": output_path,
            "codec": codec,
            "resolution": f"{self._src_w}x{self._src_h}",
            "fps": self._fps,
        }

    @staticmethod
    def _encoder_flags(codec: str, preset: str, cq: int) -> list[str]:
        """Return encoder-specific FFmpeg flags for the given codec."""
        if "nvenc" in codec:
            return [
                "-c:v", codec, "-preset", preset, "-tune", "ll",
                "-rc", "constqp", "-qp", str(cq),
            ]
        if "amf" in codec:
            return [
                "-c:v", codec, "-quality", "quality", "-rc", "cqp",
                "-qp_i", str(cq), "-qp_p", str(cq),
            ]
        if "qsv" in codec:
            return [
                "-c:v", codec, "-preset", "medium",
                "-global_quality", str(cq),
            ]
        return ["-c:v", codec, "-preset", "medium", "-crf", str(cq)]

    def stop_recording(self) -> dict:
        """Stop recording and finalise the output file."""
        if not self._recording:
            return {"status": "not_recording"}

        # Clear flag FIRST -- writer threads / capture will stop producing
        self._recording = False
        path = self._record_path
        codec = self._record_codec
        mode = self._recording_mode

        # Wait for record writer to drain (CPU mode only)
        if self._record_writer:
            self._record_writer.join(timeout=5)
            self._record_writer = None
        self._record_queue.clear()

        self._kill_recorder()
        self._record_path = None
        self._record_codec = None
        self._recording_mode = None

        return {"status": "stopped", "path": path, "codec": codec, "mode": mode}

    def _kill_recorder(self) -> None:
        proc = self._record_proc
        if proc is None:
            return
        try:
            if self._recording_mode == "gpu":
                # GPU mode (gdigrab): graceful shutdown via CTRL_BREAK
                if _IS_WINDOWS:
                    proc.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    proc.terminate()
            else:
                # CPU mode: close stdin to signal end-of-stream
                if proc.stdin and not proc.stdin.closed:
                    proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=30)  # allow time for encoder to flush
        except Exception:
            proc.kill()
        self._record_proc = None

    # ======================================================================
    # Capture loop  (grabs frames, enqueues for writer threads)
    # ======================================================================

    def _capture_loop(self) -> None:
        """Grab frames and enqueue for writer threads.

        Backend fallback chain:
          1. native  -- C++ DXGI Desktop Duplication service (shared memory,
                        works regardless of window focus, best performance)
          2. dxcam   -- Python DXGI library (good, captures screen region)
          3. printwindow -- Win32 GDI (last resort; returns black for DX games)

        Each backend is tried until it fails permanently, then we fall through
        to the next one.  Once a backend succeeds, it stays active until it
        crashes or produces no frames for 3 seconds.
        """
        # Determine starting backend tier
        use_native = (self._active_backend == "native")
        use_dxcam  = (self._active_backend == "dxcam")
        native_dead = False
        dxcam_dead  = False
        dxcam_started_at: float = 0.0
        dxcam_first_frame = False
        native_restart_count: int = 0
        MAX_NATIVE_RESTARTS: int = 3
        retry_native_at: float = 0.0  # monotonic time to retry native from PrintWindow
        native_hwnd_set_at: float = 0.0  # when HWND was last successfully sent to bridge
        native_last_status_log: float = 0.0  # throttle status() diagnostic polls

        # Start native bridge if that's our backend
        if use_native:
            if not self._start_native_bridge():
                logger.warning("[CaptureEngine] native bridge failed to start, "
                               "falling back to dxcam")
                native_dead = True
                use_native = False
                if _dxcam_available:
                    use_dxcam = True
                    self._active_backend = "dxcam"
                else:
                    self._active_backend = "printwindow"

        native_started_at: float = time.monotonic() if use_native else 0.0
        native_first_frame = False
        native_last_frame_at: float = 0.0

        while not self._stop_event.is_set():
            t0 = time.monotonic()
            frame: Optional[np.ndarray] = None
            backend_used = "printwindow"  # default for pacing

            try:
                # ── Tier 1: Native C++ capture ────────────────────────
                if use_native and not native_dead:
                    backend_used = "native"
                    frame = self._grab_native()

                    # Reject frames from transitional WGC states (e.g. the
                    # window chrome grab at 174×32 before the game renders).
                    # A real iRacing frame is always at least 320×200.
                    if frame is not None and (frame.shape[1] < 320 or frame.shape[0] < 200):
                        logger.debug(
                            "[CaptureEngine] native: ignoring undersized frame (%dx%d)",
                            frame.shape[1], frame.shape[0],
                        )
                        frame = None

                    if frame is not None:
                        if not native_first_frame:
                            logger.info("[CaptureEngine] native: first frame received")
                            native_first_frame = True
                        native_last_frame_at = time.monotonic()
                        native_started_at = time.monotonic()
                    else:
                        if native_started_at == 0.0:
                            native_started_at = time.monotonic()

                        now_t = time.monotonic()
                        # Use hwnd_set_at as anchor if available (more accurate
                        # — only start the clock once we know the bridge has a target)
                        hwnd_set = self._native_hwnd_set_at
                        stall_since = hwnd_set if (hwnd_set > 0 and not native_first_frame) else native_started_at
                        elapsed = now_t - stall_since

                        # Throttled diagnostic: every 2 s while waiting, query
                        # the C++ service for its own status so we can log WHY
                        # frames aren't arriving.
                        if now_t - native_last_status_log >= 2.0 and elapsed >= 1.0:
                            native_last_status_log = now_t
                            bridge_status = None
                            try:
                                bridge_status = self._native_bridge.status() if self._native_bridge else None
                            except Exception:
                                pass
                            is_alive = (
                                self._native_bridge is not None
                                and getattr(self._native_bridge, '_proc', None) is not None
                                and self._native_bridge._proc.poll() is None
                            )
                            logger.info(
                                "[CaptureEngine] native: waiting for frames "
                                "(elapsed=%.1fs hwnd=%s proc_alive=%s bridge_status=%s)",
                                elapsed, self._native_hwnd, is_alive, bridge_status,
                            )

                        if not native_first_frame and elapsed > 8.0:
                            # Check if the process is still alive before deciding
                            is_alive = (
                                self._native_bridge is not None
                                and getattr(self._native_bridge, '_proc', None) is not None
                                and self._native_bridge._proc.poll() is None
                            )
                            if not is_alive:
                                logger.warning(
                                    "[CaptureEngine] native: process died before "
                                    "first frame — restarting immediately"
                                )
                            self._cleanup_native()
                            if native_restart_count < MAX_NATIVE_RESTARTS:
                                native_restart_count += 1
                                sleep_s = 1.5 * native_restart_count  # back off: 1.5, 3, 4.5 s
                                logger.warning(
                                    "[CaptureEngine] native: no frame in %.0fs — "
                                    "restarting bridge (attempt %d/%d, backoff=%.1fs)",
                                    elapsed, native_restart_count, MAX_NATIVE_RESTARTS, sleep_s,
                                )
                                time.sleep(sleep_s)
                                if self._start_native_bridge():
                                    native_first_frame = False
                                    native_last_frame_at = 0.0
                                    native_started_at = time.monotonic()
                                    native_last_status_log = 0.0
                                else:
                                    logger.warning("[CaptureEngine] native: restart %d failed",
                                                   native_restart_count)
                                    native_dead = True
                                    use_native = False
                                    if _dxcam_available:
                                        use_dxcam = True
                                        dxcam_started_at = 0.0
                                        self._active_backend = "dxcam"
                                    else:
                                        self._active_backend = "printwindow"
                                        retry_native_at = time.monotonic() + 30.0
                            else:
                                logger.warning(
                                    "[CaptureEngine] native: no frame in %.0fs "
                                    "(max %d restarts exhausted) — falling back to dxcam",
                                    elapsed, MAX_NATIVE_RESTARTS,
                                )
                                native_dead = True
                                use_native = False
                                if _dxcam_available:
                                    use_dxcam = True
                                    dxcam_started_at = 0.0
                                    self._active_backend = "dxcam"
                                else:
                                    self._active_backend = "printwindow"
                                    retry_native_at = time.monotonic() + 30.0
                        elif (
                            native_first_frame
                            and native_last_frame_at > 0
                            and (now_t - native_last_frame_at) > 5.0
                        ):
                            is_alive = (
                                self._native_bridge is not None
                                and getattr(self._native_bridge, '_proc', None) is not None
                                and self._native_bridge._proc.poll() is None
                            )
                            stall_s = now_t - native_last_frame_at
                            self._cleanup_native()
                            if native_restart_count < MAX_NATIVE_RESTARTS:
                                native_restart_count += 1
                                sleep_s = 1.5 * native_restart_count
                                logger.warning(
                                    "[CaptureEngine] native: frame stall %.0fs "
                                    "(proc_alive=%s) — restarting bridge "
                                    "(attempt %d/%d, backoff=%.1fs)",
                                    stall_s, is_alive,
                                    native_restart_count, MAX_NATIVE_RESTARTS, sleep_s,
                                )
                                time.sleep(sleep_s)
                                if self._start_native_bridge():
                                    native_first_frame = False
                                    native_last_frame_at = 0.0
                                    native_started_at = time.monotonic()
                                    native_last_status_log = 0.0
                                else:
                                    logger.warning("[CaptureEngine] native: restart %d failed",
                                                   native_restart_count)
                                    native_dead = True
                                    use_native = False
                                    if _dxcam_available:
                                        use_dxcam = True
                                        dxcam_started_at = 0.0
                                        self._active_backend = "dxcam"
                                    else:
                                        self._active_backend = "printwindow"
                                        retry_native_at = time.monotonic() + 30.0
                            else:
                                logger.warning(
                                    "[CaptureEngine] native: frame stall %.0fs "
                                    "(max %d restarts exhausted) — falling back to dxcam",
                                    stall_s, MAX_NATIVE_RESTARTS,
                                )
                                native_dead = True
                                use_native = False
                                if _dxcam_available:
                                    use_dxcam = True
                                    dxcam_started_at = 0.0
                                    self._active_backend = "dxcam"
                                else:
                                    self._active_backend = "printwindow"
                                    retry_native_at = time.monotonic() + 30.0

                # ── Tier 2: dxcam ─────────────────────────────────────
                elif use_dxcam and not dxcam_dead:
                    backend_used = "dxcam"
                    frame = self._grab_dxcam()

                    if frame is not None:
                        if not dxcam_first_frame:
                            logger.info("[CaptureEngine] dxcam: first frame received")
                            dxcam_first_frame = True
                        dxcam_started_at = time.monotonic()
                    else:
                        if dxcam_started_at == 0.0:
                            dxcam_started_at = time.monotonic()
                        if (
                            not dxcam_first_frame
                            and (time.monotonic() - dxcam_started_at) > 8.0
                        ):
                            logger.warning(
                                "[CaptureEngine] dxcam: no frame in 8 s, "
                                "falling back to PrintWindow"
                            )
                            self._cleanup_dxcam()
                            dxcam_dead = True
                            use_dxcam = False
                            self._active_backend = "printwindow"
                            if _native_available:
                                retry_native_at = time.monotonic() + 30.0

                # ── Tier 3: PrintWindow (last resort) ─────────────────
                else:
                    backend_used = "printwindow"
                    # Periodically retry native backend (e.g. after DXGI releases)
                    if (
                        _native_available and native_dead
                        and retry_native_at > 0
                        and time.monotonic() >= retry_native_at
                    ):
                        logger.info("[CaptureEngine] PrintWindow: retrying native backend")
                        self._cleanup_native()
                        time.sleep(0.5)
                        if self._start_native_bridge():
                            native_dead = False
                            use_native = True
                            native_first_frame = False
                            native_last_frame_at = 0.0
                            native_started_at = time.monotonic()
                            native_restart_count = 0
                            retry_native_at = 0.0
                            self._active_backend = "native"
                        else:
                            retry_native_at = time.monotonic() + 30.0
                    frame = self._grab_printwindow()

            except Exception:
                logger.warning("[CaptureEngine] grab exception (%s)",
                               backend_used, exc_info=True)
                if backend_used == "native":
                    self._cleanup_native()
                    native_dead = True
                    use_native = False
                    if _dxcam_available:
                        use_dxcam = True
                        self._active_backend = "dxcam"
                    else:
                        self._active_backend = "printwindow"
                elif backend_used == "dxcam":
                    self._cleanup_dxcam()
                    dxcam_dead = True
                    use_dxcam = False
                    self._active_backend = "printwindow"

            if frame is not None:
                h, w = frame.shape[:2]
                self._src_w, self._src_h = w, h

                # ── Direct JPEG encode (replaces FFmpeg MJPEG pipe) ───
                # Scale down if wider than max_width
                out_frame = frame
                if _cv2 is not None and w > self._max_width:
                    out_w, out_h = _scale_dims(w, h, self._max_width)
                    out_frame = _cv2.resize(frame, (out_w, out_h),
                                            interpolation=_cv2.INTER_LINEAR)
                    self._out_w, self._out_h = out_w, out_h
                else:
                    self._out_w, self._out_h = w & ~1, h & ~1

                # Encode JPEG directly — no subprocess, no pipe, no parsing
                jpeg = self._encode_jpeg(out_frame)
                if jpeg is not None:
                    self._latest_jpeg = jpeg

                    # Metrics
                    with self._metrics_lock:
                        self._frame_count += 1
                        self._mw_frames += 1
                        now2 = time.monotonic()
                        window = now2 - self._mw_start
                        if window >= 1.0:
                            self._last_fps = self._mw_frames / window
                            self._mw_start = now2
                            self._mw_frames = 0

                # Enqueue for CPU recording writer (if active)
                if self._recording and self._recording_mode == "cpu":
                    if len(self._record_queue) >= self._record_queue.maxlen:
                        self._frames_dropped += 1
                    self._record_queue.append(frame)

                # Enqueue scaled frame for H.264 live stream feed (if active).
                # Always copy: out_frame may be a view into a pre-allocated buffer
                # (e.g. PrintWindow's self._pw_np_buf) that is overwritten next tick.
                if self._h264_streaming:
                    self._h264_queue.append(out_frame.copy())

            # Pacing: native/dxcam have their own timing; PrintWindow needs manual
            if backend_used == "printwindow":
                elapsed = time.monotonic() - t0
                sleep_time = max(0.001, (1.0 / self._fps) - elapsed)
                time.sleep(sleep_time)
            elif frame is None:
                # native/dxcam: no new frame this tick -- brief yield
                time.sleep(0.002)

    # ======================================================================
    # Direct JPEG encoding  (replaces FFmpeg MJPEG subprocess pipeline)
    # ======================================================================

    def _encode_jpeg(self, frame: np.ndarray) -> Optional[bytes]:
        """Encode a BGR numpy frame to JPEG bytes.

        Uses cv2.imencode (backed by libjpeg-turbo SIMD) when available,
        falls back to Pillow.  No subprocess, no pipe, no SOI/EOI parsing.
        """
        if _cv2 is not None:
            params = [_cv2.IMWRITE_JPEG_QUALITY, self._quality]
            if self._quality >= 85:
                # 4:4:4 chroma subsampling — avoids colour blurring at high quality
                # Guard with getattr: IMWRITE_JPEG_SAMPLING_FACTOR requires OpenCV >= 4.1.1
                sampling_key = getattr(_cv2, 'IMWRITE_JPEG_SAMPLING_FACTOR', None)
                if sampling_key is not None:
                    params.extend([sampling_key, 0x111111])
            ok, buf = _cv2.imencode(".jpg", frame, params)
            return buf.tobytes() if ok else None

        # Pillow fallback (slower, but works)
        try:
            from PIL import Image
            import io
            img = Image.fromarray(frame[:, :, ::-1])  # BGR -> RGB
            out = io.BytesIO()
            img.save(out, "JPEG", quality=self._quality)
            return out.getvalue()
        except Exception:
            return None

    # ======================================================================
    # Writer threads (for recording only -- preview uses direct encode now)
    # ======================================================================

    def _record_writer_loop(self) -> None:
        """Drain record queue -> recording FFmpeg stdin (CPU pipe mode only).

        Only active when ``recording_mode == "cpu"``.  Runs in its own
        thread to isolate recording pipe writes from both capture and preview.
        """
        while not self._stop_event.is_set() and self._recording:
            try:
                frame = self._record_queue.popleft()
            except IndexError:
                time.sleep(0.001)
                continue

            proc = self._record_proc
            if proc is None or proc.stdin is None or proc.stdin.closed:
                continue

            try:
                proc.stdin.write(memoryview(frame))
            except (BrokenPipeError, OSError):
                logger.warning("[CaptureEngine] recording pipe broken")
                self._recording = False
                break

    # ======================================================================
    # Native C++ capture backend  (DXGI via shared memory)
    # ======================================================================

    def _start_native_bridge(self) -> bool:
        """Launch the C++ capture service and connect."""
        try:
            from server.utils.native_capture_bridge import NativeCaptureBridge
            bridge = NativeCaptureBridge()
            if not bridge.start():
                return False
            self._native_bridge = bridge
            self._native_hwnd = None
            return True
        except Exception:
            logger.warning("[CaptureEngine] native bridge start failed", exc_info=True)
            return False

    def _grab_native(self) -> Optional[np.ndarray]:
        """Grab a frame from the C++ capture service via shared memory."""
        bridge = self._native_bridge
        if bridge is None:
            return None

        # Refresh iRacing HWND periodically; prefer WGC, fall back to DXGI rect
        now = time.monotonic()
        if self._native_hwnd is None or (now - self._pw_last_hwnd_check > 2.0):
            from server.utils.window_capture import _find_iracing_hwnd, _get_window_rect
            hwnd = _find_iracing_hwnd()
            if hwnd is not None:
                hwnd_int = hwnd if isinstance(hwnd, int) else (ctypes.cast(
                    hwnd, ctypes.c_void_p).value or 0)
                if hwnd_int != self._native_hwnd or self._native_wgc_ok is None:
                    # Try WGC first (unless we already know it's unavailable)
                    if self._native_wgc_ok is not False:
                        logger.debug("[CaptureEngine] native: trying set_hwnd(%d)", hwnd_int)
                        ok = bridge.set_hwnd(hwnd_int)
                        if ok:
                            self._native_hwnd = hwnd_int
                            self._native_wgc_ok = True
                            self._native_hwnd_set_at = now
                            logger.info("[CaptureEngine] native: WGC set_hwnd OK "
                                        "(hwnd=%d) — waiting for frames", hwnd_int)
                        else:
                            logger.info("[CaptureEngine] native: WGC set_hwnd failed "
                                        "(hwnd=%d) — falling back to DXGI set_region", hwnd_int)
                            self._native_wgc_ok = False
                    # DXGI rect fallback when WGC is unavailable
                    if self._native_wgc_ok is False:
                        rect = _get_window_rect(hwnd)
                        if rect:
                            logger.debug("[CaptureEngine] native: set_region "
                                         "(%d,%d) %dx%d",
                                         rect["left"], rect["top"],
                                         rect["width"], rect["height"])
                            ok2 = bridge.set_region(
                                rect["left"], rect["top"],
                                rect["width"], rect["height"],
                            )
                            if ok2:
                                self._native_hwnd = hwnd_int
                                self._native_hwnd_set_at = now
            else:
                logger.debug("[CaptureEngine] native: iRacing window not found")
            self._pw_last_hwnd_check = now

        return bridge.grab_frame()

    @property
    def _native_hwnd_set_at(self) -> float:
        return getattr(self, "_native_hwnd_set_at_val", 0.0)

    @_native_hwnd_set_at.setter
    def _native_hwnd_set_at(self, v: float) -> None:
        self._native_hwnd_set_at_val = v

    def _cleanup_native(self) -> None:
        """Stop and release the native capture bridge."""
        bridge = self._native_bridge
        if bridge is not None:
            try:
                bridge.stop()
            except Exception:
                pass
        self._native_bridge = None
        self._native_hwnd = None
        self._native_wgc_ok = None

    # ======================================================================
    # dxcam backend -- returns numpy BGR24 array, NO PIL
    # ======================================================================

    def _grab_dxcam(self) -> Optional[np.ndarray]:
        if _dxcam is None:
            return None

        from server.utils.window_capture import _find_iracing_hwnd, _get_window_rect

        # Refresh window rect periodically
        now = time.monotonic()
        if self._dxcam_region is None or now - self._pw_last_hwnd_check > 2.0:
            hwnd = _find_iracing_hwnd()
            if hwnd is None:
                return None
            rect = _get_window_rect(hwnd)
            if not rect:
                return None
            self._dxcam_region = (
                rect["left"], rect["top"],
                rect["left"] + rect["width"],
                rect["top"] + rect["height"],
            )
            self._pw_last_hwnd_check = now

        try:
            if self._dxcam_camera is None:
                if time.monotonic() < self._dxcam_create_next_try:
                    return None  # still in backoff window — don't retry yet
                # output_color="BGR" gives us BGR numpy arrays directly
                self._dxcam_camera = _dxcam.create(output_color="BGR")
                self._dxcam_create_fails = 0  # successful create resets the counter

            if not self._dxcam_started:
                self._dxcam_camera.start(
                    target_fps=self._fps,
                    region=self._dxcam_region,
                )
                self._dxcam_started = True
                time.sleep(0.05)  # let first frame arrive

            frame = self._dxcam_camera.get_latest_frame()
            if frame is None:
                return None

            # frame is already BGR numpy uint8 -- ensure C-contiguous
            if not frame.flags["C_CONTIGUOUS"]:
                frame = np.ascontiguousarray(frame)
            return frame

        except Exception as exc:
            # DXGI_ERROR_NOT_CURRENTLY_AVAILABLE (-2005270494): DXGI Desktop
            # Duplication is exclusive — another process holds it.  Back off
            # rather than spamming a full traceback on every frame tick.
            _DXGI_BUSY = -2005270494
            is_dxgi_busy = (exc.args[0] if exc.args else None) == _DXGI_BUSY
            self._dxcam_camera = None
            self._dxcam_started = False
            self._dxcam_create_fails += 1
            backoff = 2.0 if self._dxcam_create_fails < 3 else 4.0
            self._dxcam_create_next_try = time.monotonic() + backoff
            if self._dxcam_create_fails == 1:
                logger.warning(
                    "[CaptureEngine] dxcam init failed: %s%s",
                    exc,
                    " (DXGI exclusive lock held; will retry with backoff)"
                    if is_dxgi_busy else "",
                )
            if self._dxcam_create_fails >= 3:
                # Three consecutive failures — signal outer loop to abandon dxcam
                raise
            return None

    def _cleanup_dxcam(self) -> None:
        if self._dxcam_camera is not None:
            try:
                if self._dxcam_started:
                    self._dxcam_camera.stop()
            except Exception:
                pass
            try:
                del self._dxcam_camera
            except Exception:
                pass
        self._dxcam_camera = None
        self._dxcam_started = False
        self._dxcam_region = None

    # ======================================================================
    # PrintWindow backend -- returns numpy BGR24 array, NO PIL
    # ======================================================================

    def _grab_printwindow(self) -> Optional[np.ndarray]:
        if not _IS_WINDOWS:
            return None

        from server.utils.window_capture import _find_iracing_hwnd

        now = time.monotonic()
        if now - self._pw_last_hwnd_check > 2.0 or self._pw_hwnd is None:
            new_hwnd = _find_iracing_hwnd()
            if new_hwnd != self._pw_hwnd:
                self._release_pw_gdi()
            self._pw_hwnd = new_hwnd
            self._pw_last_hwnd_check = now

        if self._pw_hwnd is None:
            return None

        try:
            user32 = ctypes.windll.user32  # type: ignore[attr-defined]
            gdi32  = ctypes.windll.gdi32   # type: ignore[attr-defined]

            client_rect = ctypes.wintypes.RECT()
            user32.GetClientRect(self._pw_hwnd, ctypes.byref(client_rect))
            w, h = client_rect.right, client_rect.bottom
            if w < 100 or h < 100:
                return None

            if not self._ensure_pw_gdi(w, h):
                return None

            # PW_CLIENTONLY=1 | PW_RENDERFULLCONTENT=2
            ok = user32.PrintWindow(self._pw_hwnd, self._pw_mem_dc, 3)
            if not ok:
                ok = user32.PrintWindow(self._pw_hwnd, self._pw_mem_dc, 1)
            if not ok:
                return None

            gdi32.GetDIBits(
                self._pw_mem_dc, self._pw_bitmap, 0, h,
                self._pw_np_buf.ctypes.data,  # write directly into numpy
                ctypes.byref(self._pw_bmi), 0,
            )

            # pw_np_buf is BGRA (h, w, 4) -- strip alpha to BGR (h, w, 3)
            bgr = self._pw_np_buf[:, :, :3]
            # Ensure contiguous for FFmpeg stdin
            if not bgr.flags["C_CONTIGUOUS"]:
                bgr = np.ascontiguousarray(bgr)
            return bgr

        except Exception:
            logger.debug("[CaptureEngine] PrintWindow error", exc_info=True)
            self._release_pw_gdi()
            return None

    def _ensure_pw_gdi(self, w: int, h: int) -> bool:
        """Allocate or reuse GDI contexts + bitmap + numpy buffer."""
        if (w == self._pw_gdi_w
                and h == self._pw_gdi_h
                and self._pw_mem_dc is not None):
            return True

        self._release_pw_gdi()
        try:
            user32 = ctypes.windll.user32  # type: ignore[attr-defined]
            gdi32  = ctypes.windll.gdi32   # type: ignore[attr-defined]

            hwnd_dc = user32.GetDC(self._pw_hwnd)
            if not hwnd_dc:
                return False
            mem_dc  = gdi32.CreateCompatibleDC(hwnd_dc)
            bitmap  = gdi32.CreateCompatibleBitmap(hwnd_dc, w, h)
            if not bitmap:
                gdi32.DeleteDC(mem_dc)
                user32.ReleaseDC(self._pw_hwnd, hwnd_dc)
                return False
            gdi32.SelectObject(mem_dc, bitmap)

            bmi = self._pw_bmi
            bmi.biSize        = ctypes.sizeof(_BITMAPINFOHEADER)
            bmi.biWidth       = w
            bmi.biHeight      = -h  # top-down
            bmi.biPlanes      = 1
            bmi.biBitCount    = 32
            bmi.biCompression = 0

            self._pw_hwnd_dc  = hwnd_dc
            self._pw_mem_dc   = mem_dc
            self._pw_bitmap   = bitmap
            self._pw_np_buf   = np.empty((h, w, 4), dtype=np.uint8)
            self._pw_gdi_w    = w
            self._pw_gdi_h    = h
            return True
        except Exception:
            return False

    def _release_pw_gdi(self) -> None:
        if not _IS_WINDOWS:
            return
        try:
            gdi32  = ctypes.windll.gdi32   # type: ignore[attr-defined]
            user32 = ctypes.windll.user32  # type: ignore[attr-defined]
            if self._pw_bitmap:
                gdi32.DeleteObject(self._pw_bitmap)
            if self._pw_mem_dc:
                gdi32.DeleteDC(self._pw_mem_dc)
            if self._pw_hwnd_dc and self._pw_hwnd:
                user32.ReleaseDC(self._pw_hwnd, self._pw_hwnd_dc)
        except Exception:
            pass
        self._pw_hwnd_dc = self._pw_mem_dc = self._pw_bitmap = None
        self._pw_np_buf = None
        self._pw_gdi_w = self._pw_gdi_h = 0


# -- Singleton --------------------------------------------------------------

capture_engine = CaptureEngine()
