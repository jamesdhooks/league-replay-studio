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
) -> str:
    """Render a single element's Jinja2 template with position and frame data.

    The template receives:
      - ``frame.*``    — telemetry data (same schema as SAMPLE_FRAME_DATA)
      - ``pos.x``, ``pos.y``, ``pos.w``, ``pos.h`` — percentage position values
      - ``vars.*``     — user-defined CSS variable values

    Args:
        template_str: Jinja2 HTML template string.
        frame_data:   Per-frame overlay context.
        position:     Dict with x, y, w, h percentage values.
        variables:    User-defined variables dict.

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

    try:
        template = _jinja_env.from_string(template_str)
        return template.render(
            frame=frame_data,
            pos=pos,
            vars=var_values,
        )
    except Exception as exc:
        logger.warning("[ElementRenderer] Template render error: %s", exc)
        return f'<!-- Template error: {exc} -->'


def compose_preset_html(
    preset: dict[str, Any],
    section: str,
    frame_data: dict[str, Any],
    resolution: dict[str, int] | None = None,
    asset_base_url: str = "/api/presets",
    element_filter: str | None = None,
) -> str:
    """Compose all visible elements for a section into a single HTML document.

    This produces a full HTML page with:
      - CSS custom properties from the preset's variables
      - A relative container matching the viewport size
      - Each visible element absolutely positioned within the container
      - Jinja2-rendered content for each element

    The result is a single HTML string ready for Playwright rendering.

    Args:
        preset:        Full preset dict (sections, variables, etc.)
        section:       Which section to render (intro, race, etc.)
        frame_data:    Per-frame telemetry data.
        resolution:    Rendering resolution {width, height}. Defaults to 1920×1080.
        asset_base_url: Base URL prefix for asset image references.
        element_filter: If set, only render this specific element ID.

    Returns:
        Complete HTML document string.
    """
    if resolution is None:
        resolution = {"width": 1920, "height": 1080}

    # Get elements for this section
    sections = preset.get("sections", {})
    elements = sections.get(section, [])

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
            template_str, frame_data, pos, variables
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
