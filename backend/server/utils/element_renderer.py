"""
element_renderer.py
-------------------
Composes overlay elements from a preset into a single HTML document.

Each element has percentage-based positioning (x%, y%, width%, height%) and
its own Jinja2 template.  This module assembles all visible elements for a
given section into one full-resolution HTML page, ready for Playwright rendering.

Resolution-Independent Design:
  - All positions use CSS percentages (left:X%, top:Y%, width:W%, height:H%)
  - Font sizes use clamp() for responsive scaling
  - Elements are absolutely positioned within a 100% × 100% container
"""

from __future__ import annotations

import logging
import math
from typing import Any, Optional

from jinja2 import Environment, BaseLoader, select_autoescape

logger = logging.getLogger(__name__)


def _create_string_env() -> Environment:
    """Create a Jinja2 environment for rendering template strings."""
    return Environment(
        loader=BaseLoader(),
        autoescape=select_autoescape(["html"]),
    )


_jinja_env = _create_string_env()


def render_element_template(
    template_str: str,
    frame_data: dict[str, Any],
    position: dict[str, float],
    variables: dict[str, Any] | None = None,
    pagination: dict[str, Any] | None = None,
    page_index: int = 0,
) -> str:
    """Render a single element's Jinja2 template with position and frame data.

    The template receives:
      - ``frame.*``    — telemetry data (same schema as SAMPLE_FRAME_DATA)
      - ``pos.x``, ``pos.y``, ``pos.w``, ``pos.h`` — percentage position values
      - ``vars.*``     — user-defined CSS variable values
      - ``page_start``, ``page_end`` — slice indices for paginated lists
      - ``page_index``, ``total_pages`` — current page number and total

    Args:
        template_str: Jinja2 HTML template string.
        frame_data:   Per-frame overlay context.
        position:     Dict with x, y, w, h percentage values.
        variables:    User-defined variables dict.
        pagination:   Optional pagination config
                      ``{ enabled: bool, items_per_page: int }``.
        page_index:   Which page to render (0-based) when pagination is active.

    Returns:
        Rendered HTML string for this element.
    """
    # Build position context
    pos = {
        "x": position.get("x", 0),
        "y": position.get("y", 0),
        "w": position.get("w", 100),
        "h": position.get("h", 100),
    }

    # Build variable values (extract 'value' from {value, type, label} dicts)
    var_values = {}
    if variables:
        for k, v in variables.items():
            if isinstance(v, dict):
                var_values[k] = v.get("value", "")
            else:
                var_values[k] = v

    # Build pagination context — compute page_start / page_end slice indices
    items_per_page = 20  # default: show all
    if pagination and pagination.get("enabled"):
        items_per_page = pagination.get("items_per_page", 10)

    standings = frame_data.get("standings", [])
    total_pages = max(1, -(-len(standings) // items_per_page))  # ceil division
    safe_page_index = page_index % total_pages
    page_start = safe_page_index * items_per_page
    page_end = page_start + items_per_page
    page_key = f"page-{safe_page_index + 1}-rows-{page_start}-{min(page_end, len(standings))}"

    try:
        template = _jinja_env.from_string(template_str)
        return template.render(
            frame=frame_data,
            pos=pos,
            vars=var_values,
            page_start=page_start,
            page_end=page_end,
            page_index=safe_page_index,
            total_pages=total_pages,
            page_key=page_key,
        )
    except Exception as exc:
        logger.warning("[ElementRenderer] Template render error: %s", exc)
        return f'<!-- Template error: {exc} -->'


def _resolve_auto_page_index(
    elements: list[dict[str, Any]],
    frame_data: dict[str, Any],
) -> int:
    """Resolve page index from section elapsed time and pagination settings.

    Uses the first enabled pagination config in the section.
    """
    standings = frame_data.get("standings", [])
    if not isinstance(standings, list) or not standings:
        return 0

    pagination = None
    for element in elements:
        pag = element.get("pagination")
        if isinstance(pag, dict) and pag.get("enabled"):
            pagination = pag
            break

    if not pagination:
        return 0

    try:
        items_per_page = int(pagination.get("items_per_page", 10) or 10)
    except (TypeError, ValueError):
        items_per_page = 10
    items_per_page = max(1, items_per_page)

    total_pages = max(1, math.ceil(len(standings) / items_per_page))
    if total_pages <= 1:
        return 0

    elapsed = frame_data.get("overlay_section_elapsed_seconds", frame_data.get("overlay_clip_elapsed_seconds", 0.0))
    duration = frame_data.get("overlay_section_duration_seconds", frame_data.get("overlay_clip_duration_seconds", 0.0))

    try:
        elapsed_seconds = max(0.0, float(elapsed or 0.0))
    except (TypeError, ValueError):
        elapsed_seconds = 0.0
    try:
        duration_seconds = max(0.0, float(duration or 0.0))
    except (TypeError, ValueError):
        duration_seconds = 0.0

    try:
        fixed_interval = float(pagination.get("cycle_duration_seconds", 0.0) or 0.0)
    except (TypeError, ValueError):
        fixed_interval = 0.0

    if fixed_interval > 0:
        interval = fixed_interval
    elif duration_seconds > 0:
        interval = duration_seconds / total_pages
    else:
        interval = 1.0

    interval = max(0.001, interval)
    return int(elapsed_seconds / interval) % total_pages


def compose_preset_html(
    preset: dict[str, Any],
    section: str,
    frame_data: dict[str, Any],
    resolution: dict[str, int] | None = None,
    asset_base_url: str = "/api/presets",
    element_filter: str | None = None,
    page_index: int | None = None,
) -> str:
    """Compose all visible elements for a section into a single HTML document.

    This produces a full HTML page with:
      - CSS custom properties from the preset's variables
      - A relative container matching the viewport size
      - Each visible element absolutely positioned within the container
      - Jinja2-rendered content for each element
      - Pagination support for list-based elements

    The result is a single HTML string ready for Playwright rendering.

    Args:
        preset:        Full preset dict (sections, variables, etc.)
        section:       Which section to render (intro, race, etc.)
        frame_data:    Per-frame telemetry data.
        resolution:    Rendering resolution {width, height}. Defaults to 1920×1080.
        asset_base_url: Base URL prefix for asset image references.
        element_filter: If set, only render this specific element ID.
        page_index:    Page index for paginated elements (0-based).

    Returns:
        Complete HTML document string.
    """
    # Get elements for this section
    sections = preset.get("sections", {})
    elements = sections.get(section, [])

    resolved_page_index = page_index
    if resolved_page_index is None:
        resolved_page_index = _resolve_auto_page_index(elements, frame_data)

    logger.debug(
        "[ElementRenderer] compose_preset_html: section=%s, preset=%s, page=%d",
        section, preset.get("id", "?"), resolved_page_index,
    )
    if resolution is None:
        resolution = {"width": 1920, "height": 1080}

    # Filter to specific element if requested
    if element_filter:
        elements = [e for e in elements if e.get("id") == element_filter]

    # Build CSS custom variables
    variables = preset.get("variables", {})
    css_var_declarations = []
    for name, val in variables.items():
        value = val.get("value", "") if isinstance(val, dict) else val
        css_var_declarations.append(f"  {name}: {value};")
    css_vars_block = "\n".join(css_var_declarations)

    # Build the asset URL resolver for this preset
    preset_id = preset.get("id", "")

    # Start building the HTML document
    html_parts = [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '  <meta charset="UTF-8">',
        f'  <meta name="viewport" content="width={resolution["width"]}, height={resolution["height"]}">',
        '  <style>',
        '    * { margin: 0; padding: 0; box-sizing: border-box; }',
        f'    html, body {{ width: {resolution["width"]}px; height: {resolution["height"]}px; background: transparent; overflow: hidden; }}',
        '    :root {',
        css_vars_block,
        '    }',
        '    .overlay-container {',
        '      position: relative;',
        '      width: 100%;',
        '      height: 100%;',
        '    }',
        '    .overlay-element {',
        '      position: absolute;',
        '      overflow: hidden;',
        '    }',
        '    @import url("https://fonts.googleapis.com/css2?family=Inter:wght@100..900&family=JetBrains+Mono:wght@100..800&display=swap");',
        '  </style>',
        '</head>',
        '<body>',
        '  <div class="overlay-container">',
    ]

    # Render each visible element
    for elem in sorted(elements, key=lambda e: e.get("z_index", 0)):
        if not elem.get("visible", True):
            continue

        elem_id = elem.get("id", "unknown")
        pos = elem.get("position", {"x": 0, "y": 0, "w": 100, "h": 100})
        z_index = elem.get("z_index", 10)
        template_str = elem.get("template", "")

        # Render this element's Jinja2 template
        rendered_content = render_element_template(
            template_str, frame_data, pos, variables,
            pagination=elem.get("pagination"),
            page_index=resolved_page_index,
        )

        html_parts.append(
            f'    <div class="overlay-element" id="elem-{elem_id}" '
            f'style="left:{pos.get("x", 0)}%; top:{pos.get("y", 0)}%; '
            f'width:{pos.get("w", 100)}%; height:{pos.get("h", 100)}%; '
            f'z-index:{z_index};">'
        )
        html_parts.append(f'      {rendered_content}')
        html_parts.append('    </div>')

    html_parts.extend([
        '  </div>',
        '</body>',
        '</html>',
    ])

    return "\n".join(html_parts)
