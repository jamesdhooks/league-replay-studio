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
import hashlib
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

from jinja2 import Environment, FileSystemLoader, select_autoescape

from server.utils.overlay_animation import compute_profile_window_ms

logger = logging.getLogger(__name__)


def _format_exc(exc: Exception) -> str:
    """Return a non-empty, user-facing error message for exceptions."""
    msg = str(exc).strip()
    if msg:
        return msg
    return exc.__class__.__name__

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
        self._animation_profile_cache: dict[str, dict[str, Any]] = {}

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
                "error": "Playwright not installed. Run start.bat once, or use: python -m pip install playwright && python -m playwright install chromium",
            }
        except Exception as exc:
            err = _format_exc(exc)
            logger.error("[Overlay] Initialization failed: %s", err)
            if isinstance(exc, NotImplementedError):
                err = (
                    "Async subprocesses are unavailable in the active event loop "
                    "(Windows Selector loop). Restart backend with Proactor loop "
                    "support enabled."
                )
            return {"success": False, "error": err}

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

    async def _collect_animation_profile(self, cache_key: str | None = None) -> dict[str, Any]:
        if cache_key and cache_key in self._animation_profile_cache:
            return dict(self._animation_profile_cache[cache_key])

        profile = await self._page.evaluate(
            """() => {
                const animatedElements = [];
                const transitionElements = [];
                const keyframeNames = new Set();
                const parseMaxMs = (value) => {
                    if (!value) return 0;
                    return String(value)
                        .split(',')
                        .map((chunk) => chunk.trim())
                        .filter(Boolean)
                        .reduce((maxValue, token) => {
                            const lower = token.toLowerCase();
                            if (lower.endsWith('ms')) {
                                return Math.max(maxValue, parseFloat(lower.slice(0, -2)) || 0);
                            }
                            if (lower.endsWith('s')) {
                                return Math.max(maxValue, (parseFloat(lower.slice(0, -1)) || 0) * 1000);
                            }
                            return Math.max(maxValue, parseFloat(lower) || 0);
                        }, 0);
                };
                const parseIterations = (value) => {
                    if (!value) return 1;
                    return String(value)
                        .split(',')
                        .map((chunk) => chunk.trim().toLowerCase())
                        .filter(Boolean)
                        .reduce((maxValue, token) => {
                            if (token === 'infinite') return Math.max(maxValue, 1);
                            return Math.max(maxValue, parseFloat(token) || 1);
                        }, 1);
                };
                const describe = (element) => {
                    if (!element) return 'unknown';
                    if (element.id) return `#${element.id}`;
                    if (element.classList && element.classList.length) {
                        return `${element.tagName.toLowerCase()}.${Array.from(element.classList).slice(0, 3).join('.')}`;
                    }
                    return element.tagName.toLowerCase();
                };

                const animations = document.getAnimations({ subtree: true }) || [];
                animations.forEach((animation) => {
                    const effect = animation.effect;
                    const timing = effect && typeof effect.getTiming === 'function' ? effect.getTiming() : null;
                    const target = effect && effect.target ? effect.target : null;
                    const name = target ? getComputedStyle(target).animationName : 'unknown';
                    if (name && name !== 'none') keyframeNames.add(name);
                    animatedElements.push({
                        selector: describe(target),
                        name,
                        duration: `${timing && Number.isFinite(timing.duration) ? timing.duration : 0}ms`,
                        delay: `${timing && Number.isFinite(timing.delay) ? timing.delay : 0}ms`,
                        iterations: timing && Number.isFinite(timing.iterations) ? String(timing.iterations) : '1',
                    });
                });

                document.querySelectorAll('*').forEach((element) => {
                    const style = getComputedStyle(element);
                    const animationName = style.animationName || 'none';
                    const animationDuration = style.animationDuration || '0s';
                    const animationDelay = style.animationDelay || '0s';
                    const animationIterationCount = style.animationIterationCount || '1';
                    const transitionDuration = style.transitionDuration || '0s';
                    const transitionDelay = style.transitionDelay || '0s';

                    if (animationName !== 'none' && parseMaxMs(animationDuration) > 0) {
                        keyframeNames.add(animationName);
                        animatedElements.push({
                            selector: describe(element),
                            name: animationName,
                            duration: animationDuration,
                            delay: animationDelay,
                            iterations: animationIterationCount,
                        });
                    }

                    if (parseMaxMs(transitionDuration) > 0) {
                        transitionElements.push({
                            selector: describe(element),
                            property: style.transitionProperty || 'all',
                            duration: transitionDuration,
                            delay: transitionDelay,
                        });
                    }
                });

                const uniqueAnimated = [];
                const seenAnimated = new Set();
                animatedElements.forEach((entry) => {
                    const key = `${entry.selector}|${entry.name}|${entry.duration}|${entry.delay}|${entry.iterations}`;
                    if (!seenAnimated.has(key)) {
                        uniqueAnimated.push(entry);
                        seenAnimated.add(key);
                    }
                });

                const uniqueTransitions = [];
                const seenTransitions = new Set();
                transitionElements.forEach((entry) => {
                    const key = `${entry.selector}|${entry.property}|${entry.duration}|${entry.delay}`;
                    if (!seenTransitions.has(key)) {
                        uniqueTransitions.push(entry);
                        seenTransitions.add(key);
                    }
                });

                let maxWindowMs = 0;
                uniqueAnimated.forEach((entry) => {
                    maxWindowMs = Math.max(
                        maxWindowMs,
                        parseMaxMs(entry.delay) + (parseMaxMs(entry.duration) * parseIterations(entry.iterations)),
                    );
                });
                uniqueTransitions.forEach((entry) => {
                    maxWindowMs = Math.max(maxWindowMs, parseMaxMs(entry.delay) + parseMaxMs(entry.duration));
                });

                return {
                    animated_elements: uniqueAnimated.slice(0, 50),
                    transition_elements: uniqueTransitions.slice(0, 50),
                    keyframe_names: Array.from(keyframeNames),
                    live_animation_count: animations.length,
                    has_animations: uniqueAnimated.length > 0 || uniqueTransitions.length > 0,
                    has_keyframes: uniqueAnimated.length > 0,
                    has_transitions: uniqueTransitions.length > 0,
                    supports_timeline_seek: animations.length > 0,
                    max_window_ms: maxWindowMs,
                };
            }"""
        )
        profile["max_window_ms"] = round(compute_profile_window_ms(profile), 2)
        if cache_key:
            self._animation_profile_cache[cache_key] = dict(profile)
        return profile

    async def _seek_document_animations(self, animation_time_ms: float) -> dict[str, Any]:
        return await self._page.evaluate(
            """(targetMs) => {
                const animations = document.getAnimations({ subtree: true }) || [];
                let updated = 0;
                animations.forEach((animation) => {
                    try {
                        animation.pause();
                        animation.currentTime = Math.max(0, targetMs);
                        updated += 1;
                    } catch (error) {
                        // Ignore animations Playwright cannot seek.
                    }
                });
                return { updated };
            }""",
            float(animation_time_ms),
        )

    async def _prepare_rendered_html(
        self,
        rendered_html: str,
        analyze_animations: bool = False,
        animation_time_ms: float | None = None,
    ) -> dict[str, Any] | None:
        cache_key = hashlib.sha1(rendered_html.encode("utf-8")).hexdigest()
        await self._page.set_content(rendered_html, wait_until="domcontentloaded")
        await self._page.wait_for_load_state("networkidle")
        await self._page.evaluate(
            """() => new Promise((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(resolve));
            })"""
        )

        animation_profile: dict[str, Any] | None = None
        if analyze_animations or animation_time_ms is not None:
            animation_profile = await self._collect_animation_profile(cache_key=cache_key)
        if animation_time_ms is not None:
            await self._seek_document_animations(animation_time_ms)
            await self._page.evaluate(
                """() => new Promise((resolve) => {
                    requestAnimationFrame(() => requestAnimationFrame(resolve));
                })"""
            )
        return animation_profile

    # ── Frame rendering ──────────────────────────────────────────────────────

    async def render_frame(
        self,
        template_id: str,
        frame_data: dict[str, Any],
        output_path: Optional[str] = None,
        analyze_animations: bool = False,
        animation_time_ms: float | None = None,
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

            animation_profile = await self._prepare_rendered_html(
                html,
                analyze_animations=analyze_animations,
                animation_time_ms=animation_time_ms,
            )

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
            if animation_profile is not None:
                result["animation_profile"] = animation_profile
            if animation_time_ms is not None:
                result["animation_time_ms"] = round(float(animation_time_ms), 2)

            return result

        except Exception as exc:
            elapsed_ms = (time.perf_counter() - start) * 1000
            logger.error("[Overlay] render_frame failed: %s (%.1fms)", exc, elapsed_ms)
            return {"success": False, "error": _format_exc(exc), "elapsed_ms": round(elapsed_ms, 2)}

    # ── Raw HTML rendering (for editor) ────────────────────────────────────

    async def render_raw_html(
        self,
        html_content: str,
        frame_data: dict[str, Any],
        output_path: Optional[str] = None,
        analyze_animations: bool = False,
        animation_time_ms: float | None = None,
        include_rendered_html: bool = False,
        render_screenshot: bool = True,
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

            animation_profile = await self._prepare_rendered_html(
                rendered_html,
                analyze_animations=analyze_animations,
                animation_time_ms=animation_time_ms,
            )

            png_bytes: bytes = b""
            if render_screenshot:
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
            if render_screenshot:
                result["png_base64"] = base64.b64encode(png_bytes).decode("ascii")
            if render_screenshot and output_path:
                result["output_path"] = output_path
            if include_rendered_html:
                result["rendered_html"] = rendered_html
            if animation_profile is not None:
                result["animation_profile"] = animation_profile
            if animation_time_ms is not None:
                result["animation_time_ms"] = round(float(animation_time_ms), 2)

            return result

        except Exception as exc:
            elapsed_ms = (time.perf_counter() - start) * 1000
            logger.error("[Overlay] render_raw_html failed: %s (%.1fms)", exc, elapsed_ms)
            return {"success": False, "error": _format_exc(exc), "elapsed_ms": round(elapsed_ms, 2)}

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
