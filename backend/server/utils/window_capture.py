"""
window_capture.py
-----------------
Captures the iRacing simulator window as a JPEG image.

Uses Win32 PrintWindow API for true application-level capture (like Zoom
screen share — captures the window content even when obscured by other windows).
Falls back to mss screen-region capture if PrintWindow fails.

Supports automatic iRacing window detection with a manual override
so the user can pick a specific window via the UI.

For MJPEG streaming, use the ``StreamCapture`` class which keeps a
persistent mss context and cached HWND for much higher throughput.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes
import io
import logging
import platform
import time
from typing import Optional


class _POINT(ctypes.Structure):  # noqa: N801
    _fields_ = [
        ("x", ctypes.wintypes.LONG),
        ("y", ctypes.wintypes.LONG),
    ]

logger = logging.getLogger(__name__)

_IS_WINDOWS = platform.system() == "Windows"

# iRacing window titles to search for (in priority order)
_IRACING_TITLES = ("iRacing.com Simulator", "iRacing")

# Manual override — when set, capture this HWND instead of auto-detecting
_override_hwnd: Optional[int] = None


def set_capture_target(hwnd: Optional[int]) -> None:
    """Set a manual window handle override for capture, or None to auto-detect."""
    global _override_hwnd
    _override_hwnd = hwnd
    logger.info("Capture target set to hwnd=%s", hwnd)


def get_capture_target() -> Optional[int]:
    """Return the current manual override HWND, or None if auto-detecting."""
    return _override_hwnd


def list_visible_windows() -> list[dict]:
    """Return a list of visible windows with titles and handles.

    Each entry: { hwnd: int, title: str, is_iracing: bool }
    Filters out windows with empty titles and tiny windows.
    """
    if not _IS_WINDOWS:
        return []

    results: list[dict] = []
    try:
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        _WNDENUMPROC = ctypes.WINFUNCTYPE(
            ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM,
        )
        buf = ctypes.create_unicode_buffer(256)

        def _enum_callback(hwnd: int, _: int) -> bool:
            if not user32.IsWindowVisible(hwnd):
                return True
            user32.GetWindowTextW(hwnd, buf, 256)
            title = buf.value.strip()
            if not title:
                return True
            # Filter out tiny / minimised windows
            rect = ctypes.wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            w = rect.right - rect.left
            h = rect.bottom - rect.top
            if w < 100 or h < 100:
                return True
            results.append({
                "hwnd": hwnd,
                "title": title,
                "is_iracing": "iracing" in title.lower(),
            })
            return True

        user32.EnumWindows(_WNDENUMPROC(_enum_callback), 0)
    except Exception:
        logger.debug("Failed to enumerate windows", exc_info=True)

    return results


def _get_window_rect(hwnd: int) -> Optional[dict]:
    """Get the visible bounding rect for a specific HWND.

    Uses ``DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`` when available
    (Windows 10+) to return the *actual* visible frame — this excludes the
    invisible DWM border that Windows adds around maximised and snapped windows,
    which causes ``GetWindowRect`` to report coordinates slightly outside the
    monitor bounds (e.g. ``left=-8``).  If that would make ``dxcam``'s region
    clip off the edge of the screen, capture would fail.

    Falls back to ``GetClientRect`` + ``ClientToScreen`` if DWM is unavailable
    (e.g. RDP sessions with DWM composition disabled).
    """
    if not _IS_WINDOWS:
        return None
    try:
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        if not user32.IsWindow(hwnd):
            return None

        rect = ctypes.wintypes.RECT()
        got_rect = False

        # ── Primary: DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS) ──────
        # Returns the real visible bounds, which are narrower than GetWindowRect
        # for maximised windows that extend ~8 px beyond the monitor edge.
        try:
            dwmapi = ctypes.windll.dwmapi  # type: ignore[attr-defined]
            _DWMWA_EXTENDED_FRAME_BOUNDS = 9
            hr = dwmapi.DwmGetWindowAttribute(
                hwnd,
                _DWMWA_EXTENDED_FRAME_BOUNDS,
                ctypes.byref(rect),
                ctypes.sizeof(rect),
            )
            got_rect = (hr == 0)  # S_OK == 0
        except Exception:
            logger.debug("DwmGetWindowAttribute failed, will use GetClientRect fallback", exc_info=True)
        # GetClientRect gives the content-area dimensions (no title-bar / chrome);
        # ClientToScreen maps the top-left corner to screen coordinates.
        if not got_rect:
            client_rect = ctypes.wintypes.RECT()
            user32.GetClientRect(hwnd, ctypes.byref(client_rect))
            pt = _POINT(0, 0)
            user32.ClientToScreen(hwnd, ctypes.byref(pt))
            rect.left   = pt.x
            rect.top    = pt.y
            rect.right  = pt.x + client_rect.right
            rect.bottom = pt.y + client_rect.bottom
            got_rect = True

        if not got_rect:
            return None

        # Clamp to on-screen coordinates — never pass negative or zero-area
        # regions to dxcam / gdigrab.
        left   = max(0, rect.left)
        top    = max(0, rect.top)
        right  = max(left, rect.right)
        bottom = max(top, rect.bottom)
        w = right - left
        h = bottom - top
        if w > 100 and h > 100:
            return {"left": left, "top": top, "width": w, "height": h}
        return None
    except Exception:
        return None


def _find_iracing_hwnd() -> Optional[int]:
    """Find the iRacing window HWND.

    If a manual override is set, uses that directly.
    Otherwise auto-detects by title.
    """
    if not _IS_WINDOWS:
        return None

    # Manual override takes priority
    if _override_hwnd is not None:
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        if user32.IsWindow(_override_hwnd):
            return _override_hwnd
        logger.debug("Override hwnd=%s no longer valid, falling back", _override_hwnd)

    try:
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]

        # 1) Exact title match
        for title in _IRACING_TITLES:
            hwnd = user32.FindWindowW(None, title)
            if hwnd:
                return hwnd

        # 2) Fallback: enumerate visible windows, partial title match
        _WNDENUMPROC = ctypes.WINFUNCTYPE(
            ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM,
        )
        buf = ctypes.create_unicode_buffer(256)
        candidates: list[int] = []

        def _enum_callback(hwnd: int, _: int) -> bool:
            if user32.IsWindowVisible(hwnd):
                user32.GetWindowTextW(hwnd, buf, 256)
                if "iracing" in buf.value.lower():
                    candidates.append(hwnd)
            return True

        user32.EnumWindows(_WNDENUMPROC(_enum_callback), 0)
        if candidates:
            return candidates[0]

    except Exception:
        logger.debug("Failed to find iRacing window", exc_info=True)

    return None


def find_iracing_window() -> Optional[dict]:
    """Find the iRacing window and return its bounding rectangle."""
    hwnd = _find_iracing_hwnd()
    if hwnd is None:
        return None
    return _get_window_rect(hwnd)


def _capture_with_printwindow(hwnd: int) -> Optional["Image.Image"]:
    """Capture window content using Win32 PrintWindow API.

    This captures the actual window content (like Zoom app-share),
    even if other windows are on top.
    """
    try:
        from PIL import Image  # type: ignore[import]
    except ImportError:
        return None

    try:
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        gdi32 = ctypes.windll.gdi32  # type: ignore[attr-defined]

        # Get client rect (content area without title bar/borders)
        client_rect = ctypes.wintypes.RECT()
        user32.GetClientRect(hwnd, ctypes.byref(client_rect))
        w = client_rect.right
        h = client_rect.bottom

        if w < 100 or h < 100:
            return None

        # Create device contexts and bitmap
        hwnd_dc = user32.GetDC(hwnd)
        mem_dc = gdi32.CreateCompatibleDC(hwnd_dc)
        bitmap = gdi32.CreateCompatibleBitmap(hwnd_dc, w, h)
        old_bitmap = gdi32.SelectObject(mem_dc, bitmap)

        # PrintWindow with PW_CLIENTONLY | PW_RENDERFULLCONTENT
        # PW_CLIENTONLY = 1, PW_RENDERFULLCONTENT = 2
        result = user32.PrintWindow(hwnd, mem_dc, 3)

        if not result:
            # Fallback: try without PW_RENDERFULLCONTENT
            result = user32.PrintWindow(hwnd, mem_dc, 1)

        if not result:
            gdi32.SelectObject(mem_dc, old_bitmap)
            gdi32.DeleteObject(bitmap)
            gdi32.DeleteDC(mem_dc)
            user32.ReleaseDC(hwnd, hwnd_dc)
            return None

        # Read bitmap bits
        bmi = _BITMAPINFOHEADER()
        bmi.biSize        = ctypes.sizeof(_BITMAPINFOHEADER)
        bmi.biWidth       = w
        bmi.biHeight      = -h  # top-down
        bmi.biPlanes      = 1
        bmi.biBitCount    = 32
        bmi.biCompression = 0  # BI_RGB

        buf_size = w * h * 4
        raw_data = ctypes.create_string_buffer(buf_size)

        gdi32.GetDIBits(
            mem_dc, bitmap, 0, h,
            raw_data, ctypes.byref(bmi), 0,  # DIB_RGB_COLORS
        )

        # Clean up GDI resources
        gdi32.SelectObject(mem_dc, old_bitmap)
        gdi32.DeleteObject(bitmap)
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(hwnd, hwnd_dc)

        # Convert BGRA to RGB via Pillow
        img = Image.frombuffer("RGBA", (w, h), raw_data, "raw", "BGRA", 0, 1)
        return img.convert("RGB")

    except Exception:
        logger.debug("PrintWindow capture failed", exc_info=True)
        return None


def capture_iracing_screenshot(
    max_width: int = 640,
    quality: int = 70,
) -> Optional[bytes]:
    """
    Capture the iRacing window as JPEG bytes.

    Uses PrintWindow API for true app-level capture (not blocked by overlapping
    windows). Falls back to mss screen-region capture if PrintWindow fails.

    Returns None if the window can't be found or capture fails.
    Resizes to *max_width* pixels wide (preserving aspect ratio) for performance.
    """
    try:
        from PIL import Image  # type: ignore[import]
    except ImportError:
        logger.warning("Pillow not installed — screenshot unavailable")
        return None

    hwnd = _find_iracing_hwnd()

    img: Optional[Image.Image] = None

    # Try PrintWindow first (app-level capture, not blocked by overlapping windows)
    if hwnd is not None:
        img = _capture_with_printwindow(hwnd)

    # Fallback to mss screen-region capture
    if img is None:
        try:
            import mss  # type: ignore[import]
        except ImportError:
            logger.warning("mss not installed — screenshot unavailable")
            return None

        region = find_iracing_window()
        if not region:
            return None

        try:
            with mss.mss() as sct:
                raw = sct.grab(region)
                img = Image.frombytes("RGB", raw.size, raw.rgb)
        except Exception:
            logger.debug("mss fallback capture failed", exc_info=True)
            return None

    if img is None:
        return None

    try:
        # Resize to thumbnail for bandwidth
        ratio = max_width / img.width
        if ratio < 1:
            new_size = (max_width, int(img.height * ratio))
            img = img.resize(new_size, Image.LANCZOS)

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        return buf.getvalue()
    except Exception:
        logger.debug("Failed to encode screenshot", exc_info=True)
        return None


# ── BITMAPINFOHEADER (module-level to avoid re-defining ctypes Structure each frame) ──

class _BITMAPINFOHEADER(ctypes.Structure):  # noqa: N801
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


# ── Streaming-optimised capture ───────────────────────────────────────────────

class StreamCapture:
    """High-performance window capture for MJPEG streaming.

    Uses PrintWindow with *cached* GDI device-contexts and bitmap so we avoid
    per-frame allocation overhead.  PrintWindow captures the actual window
    content regardless of what other windows are on top — ``mss``/DXGI screen
    grabs are NOT used here because they would capture whatever is visually
    composited at those screen coordinates (e.g. a browser sitting in front).

    All Win32 calls are synchronous and blocking, so this MUST be called from
    a thread-pool (``loop.run_in_executor``) to avoid blocking the async loop.
    """

    def __init__(self) -> None:
        self._hwnd: Optional[int] = None
        self._last_hwnd_check: float = 0.0
        # Cached GDI state — recreated only when hwnd/dimensions change
        self._gdi_hwnd: Optional[int] = None
        self._gdi_w: int = 0
        self._gdi_h: int = 0
        self._hwnd_dc: Optional[int] = None
        self._mem_dc:  Optional[int] = None
        self._bitmap:  Optional[int] = None
        self._pixel_buf: Optional[ctypes.Array] = None
        self._bmi = _BITMAPINFOHEADER()

    # ── Public API ────────────────────────────────────────────────────────────

    def capture_frame(self, max_width: int = 1280, quality: int = 70) -> Optional[bytes]:
        """Return a JPEG-encoded frame or None if the window is unavailable."""
        if not _IS_WINDOWS:
            return None

        # Refresh HWND cache every 2 s
        now = time.monotonic()
        if now - self._last_hwnd_check > 2.0 or self._hwnd is None:
            new_hwnd = _find_iracing_hwnd()
            if new_hwnd != self._hwnd:
                self._release_gdi()  # size/window changed — must reallocate
            self._hwnd = new_hwnd
            self._last_hwnd_check = now

        if self._hwnd is None:
            return None

        try:
            from PIL import Image  # type: ignore[import]
        except ImportError:
            return None

        img = self._printwindow_cached(Image)
        if img is None:
            return None

        return _encode_jpeg(img, max_width, quality, Image)

    def close(self) -> None:
        self._release_gdi()

    # ── GDI cache management ──────────────────────────────────────────────────

    def _ensure_gdi(self, w: int, h: int) -> bool:
        """Allocate (or reuse) GDI device contexts + bitmap for (hwnd, w, h)."""
        if (self._hwnd == self._gdi_hwnd
                and w == self._gdi_w
                and h == self._gdi_h
                and self._mem_dc is not None):
            return True  # already good

        self._release_gdi()
        if not _IS_WINDOWS or self._hwnd is None:
            return False

        try:
            user32 = ctypes.windll.user32  # type: ignore[attr-defined]
            gdi32  = ctypes.windll.gdi32   # type: ignore[attr-defined]

            hwnd_dc = user32.GetDC(self._hwnd)
            if not hwnd_dc:
                return False
            mem_dc  = gdi32.CreateCompatibleDC(hwnd_dc)
            bitmap  = gdi32.CreateCompatibleBitmap(hwnd_dc, w, h)
            if not bitmap:
                gdi32.DeleteDC(mem_dc)
                user32.ReleaseDC(self._hwnd, hwnd_dc)
                return False

            gdi32.SelectObject(mem_dc, bitmap)

            # Pre-fill the BITMAPINFOHEADER (stays constant while size is unchanged)
            bmi = self._bmi
            bmi.biSize        = ctypes.sizeof(_BITMAPINFOHEADER)
            bmi.biWidth       = w
            bmi.biHeight      = -h  # top-down
            bmi.biPlanes      = 1
            bmi.biBitCount    = 32
            bmi.biCompression = 0

            self._hwnd_dc  = hwnd_dc
            self._mem_dc   = mem_dc
            self._bitmap   = bitmap
            self._pixel_buf = ctypes.create_string_buffer(w * h * 4)
            self._gdi_hwnd = self._hwnd
            self._gdi_w    = w
            self._gdi_h    = h
            return True

        except Exception:
            logger.debug("GDI cache alloc failed", exc_info=True)
            return False

    def _release_gdi(self) -> None:
        if not _IS_WINDOWS:
            return
        try:
            gdi32  = ctypes.windll.gdi32   # type: ignore[attr-defined]
            user32 = ctypes.windll.user32  # type: ignore[attr-defined]
            if self._bitmap:
                gdi32.DeleteObject(self._bitmap)
            if self._mem_dc:
                gdi32.DeleteDC(self._mem_dc)
            if self._hwnd_dc and self._gdi_hwnd:
                user32.ReleaseDC(self._gdi_hwnd, self._hwnd_dc)
        except Exception:
            pass
        self._hwnd_dc = self._mem_dc = self._bitmap = self._pixel_buf = None
        self._gdi_hwnd = None
        self._gdi_w = self._gdi_h = 0

    # ── Capture impl ──────────────────────────────────────────────────────────

    def _printwindow_cached(self, Image: type) -> Optional["Image.Image"]:
        """PrintWindow into the cached GDI context — no per-frame allocations."""
        try:
            user32 = ctypes.windll.user32  # type: ignore[attr-defined]
            gdi32  = ctypes.windll.gdi32   # type: ignore[attr-defined]

            client_rect = ctypes.wintypes.RECT()
            user32.GetClientRect(self._hwnd, ctypes.byref(client_rect))
            w, h = client_rect.right, client_rect.bottom
            if w < 100 or h < 100:
                return None

            if not self._ensure_gdi(w, h):
                return None

            # PW_CLIENTONLY=1 | PW_RENDERFULLCONTENT=2
            ok = user32.PrintWindow(self._hwnd, self._mem_dc, 3)
            if not ok:
                ok = user32.PrintWindow(self._hwnd, self._mem_dc, 1)
            if not ok:
                return None

            gdi32.GetDIBits(
                self._mem_dc, self._bitmap, 0, h,
                self._pixel_buf, ctypes.byref(self._bmi), 0,
            )

            return Image.frombuffer(
                "RGBA", (w, h), self._pixel_buf, "raw", "BGRA", 0, 1,
            ).convert("RGB")

        except Exception:
            logger.debug("Cached PrintWindow failed", exc_info=True)
            self._release_gdi()  # force re-init next frame
            return None


def _encode_jpeg(img: "Image.Image", max_width: int, quality: int, Image: type) -> bytes:
    """Resize (if needed) and JPEG-encode a PIL Image."""
    if img.width > max_width:
        new_h = int(img.height * max_width / img.width)
        img = img.resize((max_width, new_h), Image.BILINEAR)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=False)
    return buf.getvalue()
