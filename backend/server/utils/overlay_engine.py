"""
overlay_engine.py
-----------------
Playwright headless Chromium + Jinja2 overlay rendering engine.

Provides:
  - ``render_frame()``  — render a single overlay frame as transparent PNG (~5–15 ms)
  - ``batch_render_for_export()``  — pre-render a full overlay sequence to PNG files
  - Resolution-aware rendering (1080p / 1440p / 4K)
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

from jinja2 import Environment, FileSystemLoader, select_autoescape

logger = logging.getLogger(__name__)

# ── Resolution presets ───────────────────────────────────────────────────────

RESOLUTIONS: dict[str, dict[str, int]] = {
    "1080p": {"width": 1920, "height": 1080},
    "1440p": {"width": 2560, "height": 1440},
    "4k":    {"width": 3840, "height": 2160},
}

DEFAULT_RESOLUTION = "1080p"


# ── Template directories ────────────────────────────────────────────────────

BUILTIN_TEMPLATES_DIR = Path(__file__).parent.parent / "templates"


# ── Jinja2 Environment ──────────────────────────────────────────────────────

def _create_jinja_env(template_dirs: list[Path]) -> Environment:
    """Create a Jinja2 environment from one or more template directories."""
    loaders = [str(d) for d in template_dirs if d.exists()]
    if not loaders:
        loaders = [str(BUILTIN_TEMPLATES_DIR)]
    return Environment(
        loader=FileSystemLoader(loaders),
        autoescape=select_autoescape(["html"]),
    )


# ── Overlay Engine ──────────────────────────────────────────────────────────

class OverlayEngine:
    """Headless Chromium overlay renderer using Playwright + Jinja2.

    The engine maintains a persistent browser context for fast frame rendering.
    Templates are Jinja2 HTML files that receive per-frame data context.
    """

    def __init__(self) -> None:
        self._browser = None
        self._context = None
        self._page = None
        self._playwright = None
        self._initialized = False
        self._jinja_env: Optional[Environment] = None
        self._current_resolution = RESOLUTIONS[DEFAULT_RESOLUTION].copy()
        self._custom_template_dirs: list[Path] = []

    @property
    def initialized(self) -> bool:
        return self._initialized

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def initialize(self, resolution: str = DEFAULT_RESOLUTION) -> dict[str, Any]:
        """Initialise Playwright headless Chromium with persistent browser context.

        Args:
            resolution: One of '1080p', '1440p', '4k'.

        Returns:
            Status dict with initialization result.
        """
        if self._initialized:
            return {"success": True, "message": "Already initialized"}

        res = RESOLUTIONS.get(resolution, RESOLUTIONS[DEFAULT_RESOLUTION])
        self._current_resolution = res.copy()

        try:
            from playwright.async_api import async_playwright

            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(
                headless=True,
                args=[
                    "--disable-gpu",
                    "--disable-dev-shm-usage",
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                ],
            )
            self._context = await self._browser.new_context(
                viewport={"width": res["width"], "height": res["height"]},
                device_scale_factor=1,
                has_touch=False,
            )
            self._page = await self._context.new_page()

            # Set transparent background
            await self._page.evaluate("document.body.style.background = 'transparent'")

            self._initialized = True
            logger.info(
                "[Overlay] Playwright initialized at %dx%d",
                res["width"], res["height"],
            )
            return {
                "success": True,
                "resolution": resolution,
                "width": res["width"],
                "height": res["height"],
            }

        except ImportError:
            logger.warning("[Overlay] Playwright not installed — overlay rendering unavailable")
            return {
                "success": False,
                "error": "Playwright not installed. Run: pip install playwright && playwright install chromium",
            }
        except Exception as exc:
            logger.error("[Overlay] Initialization failed: %s", exc)
            return {"success": False, "error": str(exc)}

    async def shutdown(self) -> None:
        """Close the browser and release resources."""
        if self._page:
            await self._page.close()
            self._page = None
        if self._context:
            await self._context.close()
            self._context = None
        if self._browser:
            await self._browser.close()
            self._browser = None
        if self._playwright:
            await self._playwright.stop()
            self._playwright = None
        self._initialized = False
        logger.info("[Overlay] Playwright shut down")

    # ── Jinja2 template rendering ────────────────────────────────────────────

    def set_custom_template_dirs(self, dirs: list[Path]) -> None:
        """Set additional template directories (for per-project overrides)."""
        self._custom_template_dirs = dirs
        self._jinja_env = None  # Force re-creation

    def _get_jinja_env(self) -> Environment:
        """Get or create the Jinja2 environment."""
        if self._jinja_env is None:
            all_dirs = list(self._custom_template_dirs) + [BUILTIN_TEMPLATES_DIR]
            self._jinja_env = _create_jinja_env(all_dirs)
        return self._jinja_env

    def render_template_html(
        self,
        template_id: str,
        context: dict[str, Any],
    ) -> str:
        """Render a Jinja2 template to HTML string.

        Args:
            template_id: Template directory name (e.g., 'broadcast').
            context: Per-frame data context.

        Returns:
            Rendered HTML string.
        """
        env = self._get_jinja_env()
        template_path = f"{template_id}/overlay.html"
        try:
            template = env.get_template(template_path)
            return template.render(**context)
        except Exception as exc:
            logger.error("[Overlay] Template render failed (%s): %s", template_id, exc)
            raise

    # ── Frame rendering ──────────────────────────────────────────────────────

    async def render_frame(
        self,
        template_id: str,
        frame_data: dict[str, Any],
        output_path: Optional[str] = None,
    ) -> dict[str, Any]:
        """Render a single overlay frame as a transparent PNG.

        Target: ~5–15 ms per frame.

        Args:
            template_id: Template to use (e.g., 'broadcast').
            frame_data: Per-frame context (positions, driver, lap, etc.).
            output_path: Optional path to save PNG. If None, returns bytes.

        Returns:
            Dict with rendering result including timing.
        """
        if not self._initialized or not self._page:
            return {"success": False, "error": "Engine not initialized"}

        start = time.perf_counter()

        try:
            # Render the Jinja2 template to HTML
            html = self.render_template_html(template_id, {
                "frame": frame_data,
                "resolution": self._current_resolution,
            })

            # Set the page content
            await self._page.set_content(html, wait_until="domcontentloaded")

            # Screenshot with transparent background
            screenshot_opts: dict[str, Any] = {
                "type": "png",
                "omit_background": True,
                "full_page": False,
            }
            if output_path:
                screenshot_opts["path"] = output_path

            png_bytes = await self._page.screenshot(**screenshot_opts)

            elapsed_ms = (time.perf_counter() - start) * 1000

            result: dict[str, Any] = {
                "success": True,
                "elapsed_ms": round(elapsed_ms, 2),
                "width": self._current_resolution["width"],
                "height": self._current_resolution["height"],
                "size_bytes": len(png_bytes),
            }
            if output_path:
                result["output_path"] = output_path
            else:
                result["png_bytes"] = png_bytes

            return result

        except Exception as exc:
            elapsed_ms = (time.perf_counter() - start) * 1000
            logger.error("[Overlay] render_frame failed: %s (%.1fms)", exc, elapsed_ms)
            return {"success": False, "error": str(exc), "elapsed_ms": round(elapsed_ms, 2)}

    # ── Raw HTML rendering (for editor) ────────────────────────────────────

    async def render_raw_html(
        self,
        html_content: str,
        frame_data: dict[str, Any],
        output_path: Optional[str] = None,
    ) -> dict[str, Any]:
        """Render raw HTML content directly (bypassing template files).

        Used by the in-app editor for live preview. The HTML is rendered
        through Jinja2 string rendering, then set as page content.

        Args:
            html_content: Raw HTML/Jinja2 string to render.
            frame_data: Per-frame context data.
            output_path: Optional path to save PNG.

        Returns:
            Dict with rendering result including base64 PNG data.
        """
        import base64

        if not self._initialized or not self._page:
            return {"success": False, "error": "Engine not initialized"}

        start = time.perf_counter()

        try:
            # Render Jinja2 expressions in the raw HTML
            from jinja2 import Template as JinjaTemplate

            try:
                jinja_tmpl = JinjaTemplate(html_content)
                rendered_html = jinja_tmpl.render(
                    frame=frame_data,
                    resolution=self._current_resolution,
                )
            except Exception as tmpl_exc:
                return {
                    "success": False,
                    "error": f"Template error: {tmpl_exc}",
                    "elapsed_ms": round((time.perf_counter() - start) * 1000, 2),
                }

            # Set the page content
            await self._page.set_content(rendered_html, wait_until="domcontentloaded")

            # Screenshot with transparent background
            screenshot_opts: dict[str, Any] = {
                "type": "png",
                "omit_background": True,
                "full_page": False,
            }
            if output_path:
                screenshot_opts["path"] = output_path

            png_bytes = await self._page.screenshot(**screenshot_opts)

            elapsed_ms = (time.perf_counter() - start) * 1000

            result: dict[str, Any] = {
                "success": True,
                "elapsed_ms": round(elapsed_ms, 2),
                "width": self._current_resolution["width"],
                "height": self._current_resolution["height"],
                "size_bytes": len(png_bytes),
                "png_base64": base64.b64encode(png_bytes).decode("ascii"),
            }
            if output_path:
                result["output_path"] = output_path

            return result

        except Exception as exc:
            elapsed_ms = (time.perf_counter() - start) * 1000
            logger.error("[Overlay] render_raw_html failed: %s (%.1fms)", exc, elapsed_ms)
            return {"success": False, "error": str(exc), "elapsed_ms": round(elapsed_ms, 2)}

    # ── Batch rendering ──────────────────────────────────────────────────────

    async def batch_render_for_export(
        self,
        template_id: str,
        frames: list[dict[str, Any]],
        output_dir: str,
        on_progress: Any = None,
    ) -> dict[str, Any]:
        """Pre-render a full overlay sequence to PNG files.

        Args:
            template_id: Template to use.
            frames: List of per-frame data dicts.
            output_dir: Directory to write PNG files.
            on_progress: Optional callback(frame_index, total_frames, elapsed_ms).

        Returns:
            Batch result with timing statistics.
        """
        if not self._initialized:
            return {"success": False, "error": "Engine not initialized"}

        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)

        total = len(frames)
        rendered = 0
        errors = 0
        total_ms = 0.0

        logger.info("[Overlay] Batch render: %d frames → %s", total, output_dir)

        for idx, frame_data in enumerate(frames):
            file_path = str(out / f"overlay_{idx:06d}.png")
            result = await self.render_frame(template_id, frame_data, output_path=file_path)

            if result.get("success"):
                rendered += 1
                total_ms += result.get("elapsed_ms", 0)
            else:
                errors += 1
                logger.warning("[Overlay] Frame %d failed: %s", idx, result.get("error"))

            if on_progress and callable(on_progress):
                try:
                    on_progress(idx, total, result.get("elapsed_ms", 0))
                except Exception:
                    pass

        avg_ms = total_ms / rendered if rendered > 0 else 0

        logger.info(
            "[Overlay] Batch complete: %d/%d rendered (avg %.1fms/frame, %d errors)",
            rendered, total, avg_ms, errors,
        )

        return {
            "success": errors == 0,
            "total_frames": total,
            "rendered_frames": rendered,
            "error_count": errors,
            "total_ms": round(total_ms, 2),
            "avg_ms_per_frame": round(avg_ms, 2),
            "output_dir": output_dir,
        }

    # ── Resolution ───────────────────────────────────────────────────────────

    async def set_resolution(self, resolution: str) -> dict[str, Any]:
        """Change the rendering resolution.

        Args:
            resolution: One of '1080p', '1440p', '4k'.

        Returns:
            Result dict.
        """
        res = RESOLUTIONS.get(resolution)
        if not res:
            return {"success": False, "error": f"Unknown resolution: {resolution}"}

        self._current_resolution = res.copy()

        if self._page:
            await self._page.set_viewport_size(
                {"width": res["width"], "height": res["height"]}
            )

        return {
            "success": True,
            "resolution": resolution,
            "width": res["width"],
            "height": res["height"],
        }

    @property
    def resolution(self) -> dict[str, Any]:
        """Current rendering resolution."""
        return self._current_resolution.copy()


# ── Module-level singleton ──────────────────────────────────────────────────

overlay_engine = OverlayEngine()
