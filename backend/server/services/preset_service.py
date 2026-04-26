"""
preset_service.py
-----------------
Overlay preset management service.

A preset is a complete overlay configuration containing:
  - Per-section element lists (intro, qualifying_results, race, race_results)
  - Each element: id, name, template HTML, position (%), z-index, visible flag
  - Custom variables (colors, fonts) referenced by element templates
  - Asset references (uploaded images/logos stored globally)
  - Resolution-independent positioning using percentage-based layout

Storage:
  {DATA_DIR}/overlay_presets/{preset_id}/
    preset.json      — metadata + element configs + variables
    assets/          — uploaded images/logos for this preset
"""

from __future__ import annotations

import json
import logging
import shutil
import uuid
import copy
from pathlib import Path
from typing import Any, Optional

from server.config import DATA_DIR
from server.utils.overlay_engine import BUILTIN_TEMPLATES_DIR

logger = logging.getLogger(__name__)

# ── Storage paths ────────────────────────────────────────────────────────────

PRESETS_DIR = DATA_DIR / "overlay_presets"
GLOBAL_ASSETS_DIR = DATA_DIR / "overlay_assets"

# ── Safe ID validation ───────────────────────────────────────────────────────

import re
_SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")
_SAFE_ASSET_VAR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")

def _safe_id(value: str) -> str:
    if not value or not _SAFE_ID_RE.match(value):
        raise ValueError(f"Invalid identifier: {value!r}")
    return value


def _safe_filename(filename: str) -> str:
    """Sanitize a filename, stripping path separators and traversal sequences."""
    # Strip directory components
    name = Path(filename).name
    # Remove anything not alphanumeric, underscore, hyphen, or dot
    name = re.sub(r'[^a-zA-Z0-9_.\-]', '_', name)
    # Collapse consecutive dots to prevent traversal
    name = re.sub(r'\.{2,}', '.', name)
    # Strip leading dots
    name = name.lstrip('.')
    return name or f"file_{uuid.uuid4().hex[:8]}"


def _ensure_within(path: Path, parent: Path) -> Path:
    """Resolve *path* and verify it stays within *parent*."""
    resolved = path.resolve()
    if not str(resolved).startswith(str(parent.resolve())):
        raise ValueError(f"Path escapes allowed directory: {resolved}")
    return resolved

# ── Video sections ───────────────────────────────────────────────────────────

VIDEO_SECTIONS = ("intro", "qualifying_results", "race", "race_results")

# ── Default element templates ────────────────────────────────────────────────

DEFAULT_ELEMENTS: dict[str, list[dict[str, Any]]] = {
    "intro": [
        {
            "id": "title_card",
            "name": "Title Card",
            "template": """<div style="position:absolute; left:{{pos.x}}%; top:{{pos.y}}%; width:{{pos.w}}%; height:{{pos.h}}%;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  font-family: var(--font-primary, 'Inter', sans-serif); color: var(--color-primary, #ffffff);">
  <div style="font-size: clamp(1.5rem, 3vw, 4rem); font-weight: 800; text-transform: uppercase;
    text-shadow: 0 4px 24px rgba(0,0,0,0.9); letter-spacing: 0.1em;">
    {{ frame.series_name | default('Race Series') }}
  </div>
  <div style="font-size: clamp(0.8rem, 1.5vw, 2rem); font-weight: 400; margin-top: 0.5em;
    text-shadow: 0 2px 12px rgba(0,0,0,0.7); color: var(--color-secondary, #cccccc);">
    {{ frame.track_name | default('Circuit') }}
  </div>
</div>""",
            "position": {"x": 15, "y": 30, "w": 70, "h": 40},
            "z_index": 10,
            "visible": True,
        },
    ],
    "qualifying_results": [
        {
            "id": "grid_standings",
            "name": "Starting Grid",
            "template": """<div style="position:absolute; left:{{pos.x}}%; top:{{pos.y}}%; width:{{pos.w}}%; height:{{pos.h}}%;
  font-family: var(--font-primary, 'Inter', sans-serif); color: var(--color-primary, #ffffff);">
  <div style="font-size: clamp(0.7rem, 1.2vw, 1.2rem); font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.15em; margin-bottom: 0.5em; text-shadow: 0 2px 8px rgba(0,0,0,0.8);
    color: var(--color-accent, #3B82F6);">
    Starting Grid
  </div>
    {% for entry in frame.standings[page_start:page_end] %}
  <div style="display:flex; align-items:center; gap: 0.5em; padding: 0.25em 0.5em;
    margin-bottom: 2px; border-radius: 4px;
    background: {% if entry.is_player %}rgba(59,130,246,0.6){% else %}rgba(0,0,0,0.65){% endif %};
        font-size: clamp(0.5rem, 0.9vw, 0.9rem);"
        id="grid-row-{{ page_key }}-{{ entry.position | default(loop.index + page_start) }}"
        data-page-key="{{ page_key }}">
    <span style="font-weight:700; min-width:1.5em; text-align:right;">{{ entry.position }}</span>
    <span style="flex:1; font-weight:{% if entry.is_player %}700{% else %}400{% endif %};">{{ entry.driver_name }}</span>
    <span style="opacity:0.7; font-variant-numeric:tabular-nums;">{{ entry.car_number }}</span>
  </div>
  {% endfor %}
</div>""",
            "position": {"x": 5, "y": 10, "w": 25, "h": 80},
                        "pagination": {"enabled": True, "items_per_page": 10, "cycle_duration_seconds": 0},
            "z_index": 10,
            "visible": True,
        },
    ],
    "race": [
        {
            "id": "timing_tower",
            "name": "Timing Tower",
            "template": """<div style="position:absolute; left:{{pos.x}}%; top:{{pos.y}}%; width:{{pos.w}}%; height:{{pos.h}}%;
  font-family: var(--font-primary, 'Inter', sans-serif); color: var(--color-primary, #ffffff);">
  {% for entry in frame.standings[:8] %}
  <div style="display:flex; align-items:center; gap:0.4em; padding:0.2em 0.5em;
    margin-bottom:1px; font-size: clamp(0.45rem, 0.8vw, 0.85rem);
    background: {% if entry.is_player %}rgba(59,130,246,0.85){% else %}rgba(0,0,0,0.75){% endif %};
    {% if loop.first %}border-radius: 4px 4px 0 0;{% endif %}
    {% if loop.last %}border-radius: 0 0 4px 4px;{% endif %}">
    <span style="font-weight:700; min-width:1.2em; text-align:right; font-size:0.85em;">{{ entry.position }}</span>
    <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{{ entry.driver_name }}</span>
    <span style="opacity:0.6; font-variant-numeric:tabular-nums; font-size:0.85em;">{{ entry.gap }}</span>
  </div>
  {% endfor %}
</div>""",
            "position": {"x": 1, "y": 8, "w": 18, "h": 50},
            "z_index": 10,
            "visible": True,
        },
        {
            "id": "focused_driver",
            "name": "Focused Driver",
            "template": """<div style="position:absolute; left:{{pos.x}}%; top:{{pos.y}}%; width:{{pos.w}}%; height:{{pos.h}}%;
  display:flex; align-items:flex-end; gap:0.8em;
  font-family: var(--font-primary, 'Inter', sans-serif); color: var(--color-primary, #ffffff);">
    <div style="width:4px; height:70%; border-radius:2px; background: {{ frame.team_color | default('#3B82F6') }};"></div>
  <div>
    <div style="font-size: clamp(1.2rem, 2.5vw, 3rem); font-weight:900;
      text-shadow: 0 2px 16px rgba(0,0,0,0.8);">
      P{{ frame.position | default(1) }}
    </div>
    <div style="font-size: clamp(0.7rem, 1.2vw, 1.5rem); font-weight:600;
      text-shadow: 0 1px 8px rgba(0,0,0,0.6);">
      {{ frame.driver_name | default('Driver') }}
    </div>
    <div style="font-size: clamp(0.5rem, 0.8vw, 0.9rem); opacity:0.7;
      text-shadow: 0 1px 4px rgba(0,0,0,0.5);">
      {{ frame.car_name | default('Car') }}{% if frame.irating is defined %} · {{ frame.irating }} iR{% endif %}
    </div>
  </div>
</div>""",
            "position": {"x": 3, "y": 78, "w": 30, "h": 18},
            "z_index": 10,
            "visible": True,
        },
        {
            "id": "lap_counter",
            "name": "Lap Counter",
            "template": """<div style="position:absolute; left:{{pos.x}}%; top:{{pos.y}}%; width:{{pos.w}}%; height:{{pos.h}}%;
  display:flex; flex-direction:column; align-items:flex-end; justify-content:center;
  font-family: var(--font-primary, 'Inter', sans-serif); color: var(--color-primary, #ffffff);">
  <div style="font-size: clamp(0.4rem, 0.6vw, 0.65rem); text-transform:uppercase;
    letter-spacing:0.15em; opacity:0.6; text-shadow: 0 1px 4px rgba(0,0,0,0.8);">
    Lap
  </div>
  <div style="font-size: clamp(0.9rem, 1.5vw, 1.8rem); font-weight:700;
    font-variant-numeric:tabular-nums; text-shadow: 0 2px 8px rgba(0,0,0,0.7);">
    {{ frame.current_lap | default(1) }}<span style="opacity:0.4; font-size:0.6em;">/{{ frame.total_laps | default(20) }}</span>
  </div>
  {% if frame.last_lap_time is defined %}
  <div style="font-size: clamp(0.4rem, 0.7vw, 0.75rem); font-variant-numeric:tabular-nums;
    opacity:0.7; text-shadow: 0 1px 4px rgba(0,0,0,0.6);">
    {{ frame.last_lap_time }}
  </div>
  {% endif %}
</div>""",
            "position": {"x": 85, "y": 2, "w": 13, "h": 10},
            "z_index": 10,
            "visible": True,
        },
    ],
    "race_results": [
        {
            "id": "final_standings",
            "name": "Final Standings",
            "template": """<div style="position:absolute; left:{{pos.x}}%; top:{{pos.y}}%; width:{{pos.w}}%; height:{{pos.h}}%;
  font-family: var(--font-primary, 'Inter', sans-serif); color: var(--color-primary, #ffffff);">
  <div style="font-size: clamp(0.8rem, 1.4vw, 1.4rem); font-weight:700; text-transform:uppercase;
    letter-spacing:0.15em; margin-bottom:0.5em; text-shadow: 0 2px 8px rgba(0,0,0,0.8);
    color: var(--color-accent, #F59E0B);">
    Race Results
  </div>
    {% for entry in frame.standings[page_start:page_end] %}
  <div style="display:flex; align-items:center; gap:0.5em; padding:0.3em 0.6em;
    margin-bottom:2px; border-radius:4px;
    background: {% if entry.position == 1 %}rgba(245,158,11,0.5){% elif entry.is_player %}rgba(59,130,246,0.6){% else %}rgba(0,0,0,0.65){% endif %};
        font-size: clamp(0.5rem, 0.9vw, 0.9rem);"
        id="results-row-{{ page_key }}-{{ entry.position | default(loop.index + page_start) }}"
        data-page-key="{{ page_key }}">
    <span style="font-weight:700; min-width:1.5em; text-align:right;">{{ entry.position }}</span>
    <span style="flex:1; font-weight:{% if entry.is_player or entry.position == 1 %}700{% else %}400{% endif %};">{{ entry.driver_name }}</span>
    <span style="opacity:0.7; font-variant-numeric:tabular-nums;">{{ entry.gap }}</span>
  </div>
  {% endfor %}
</div>""",
            "position": {"x": 25, "y": 10, "w": 50, "h": 80},
                        "pagination": {"enabled": True, "items_per_page": 10, "cycle_duration_seconds": 0},
            "z_index": 10,
            "visible": True,
        },
    ],
}

# ── Default custom variables ─────────────────────────────────────────────────

DEFAULT_VARIABLES: dict[str, Any] = {
    "--color-primary": {"value": "#ffffff", "type": "color", "label": "Primary Color"},
    "--color-secondary": {"value": "#cccccc", "type": "color", "label": "Secondary Color"},
    "--color-accent": {"value": "#3B82F6", "type": "color", "label": "Accent Color"},
    "--color-background": {"value": "rgba(0,0,0,0.75)", "type": "color", "label": "Background Color"},
    "--font-primary": {"value": "'Inter', sans-serif", "type": "font", "label": "Primary Font"},
    "--font-mono": {"value": "'JetBrains Mono', monospace", "type": "font", "label": "Monospace Font"},
}


# ── Built-in presets ─────────────────────────────────────────────────────────

def _load_builtin_html(style: str) -> str:
    """Read the overlay.html for a built-in design style."""
    html_path = BUILTIN_TEMPLATES_DIR / style / "overlay.html"
    if html_path.exists():
        return html_path.read_text(encoding="utf-8")
    return ""


def _make_builtin_preset(
    preset_id: str,
    name: str,
    description: str,
    style: str,
    variables: dict | None = None,
) -> dict[str, Any]:
    return {
        "id": preset_id,
        "name": name,
        "description": description,
        "style": style,
        "is_builtin": True,
        "version": "1.0.0",
        "sections": {section: DEFAULT_ELEMENTS.get(section, []) for section in VIDEO_SECTIONS},
        "variables": variables or dict(DEFAULT_VARIABLES),
        "intro_video_path": None,
    }


BUILTIN_PRESETS: list[dict[str, Any]] = [
    _make_builtin_preset(
        "broadcast_preset",
        "Broadcast",
        "Full broadcast-style overlay with timing tower, driver card, and lap counter",
        style="broadcast",
    ),
    _make_builtin_preset(
        "minimal_preset",
        "Minimal",
        "Clean minimal overlay — position badge and driver name only",
        style="minimal",
        variables={
            **DEFAULT_VARIABLES,
            "--color-accent": {"value": "#10B981", "type": "color", "label": "Accent Color"},
        },
    ),
    _make_builtin_preset(
        "classic_preset",
        "Classic",
        "Traditional racing overlay with classic timing board layout",
        style="classic",
        variables={
            **DEFAULT_VARIABLES,
            "--color-accent": {"value": "#F59E0B", "type": "color", "label": "Accent Color"},
            "--font-primary": {"value": "'Courier New', monospace", "type": "font", "label": "Primary Font"},
        },
    ),
    _make_builtin_preset(
        "cinematic_preset",
        "Cinematic",
        "Cinematic lower-third overlay for dramatic replays",
        style="cinematic",
        variables={
            **DEFAULT_VARIABLES,
            "--color-accent": {"value": "#8B5CF6", "type": "color", "label": "Accent Color"},
        },
    ),
]


# ── Preset Service ───────────────────────────────────────────────────────────

class PresetService:
    """Manages overlay presets with per-section element configurations."""

    def __init__(self) -> None:
        self._custom_presets: list[dict[str, Any]] = []
        PRESETS_DIR.mkdir(parents=True, exist_ok=True)
        GLOBAL_ASSETS_DIR.mkdir(parents=True, exist_ok=True)
        self._load_custom_presets()

    # ── CRUD ─────────────────────────────────────────────────────────────────

    def get_presets(self) -> list[dict[str, Any]]:
        """List all presets with custom overrides taking precedence over built-ins."""
        custom_by_id = {preset["id"]: preset for preset in self._custom_presets}
        merged: list[dict[str, Any]] = []

        for builtin in BUILTIN_PRESETS:
            merged.append(custom_by_id.pop(builtin["id"], builtin))

        merged.extend(custom_by_id.values())
        return merged

    def get_preset(self, preset_id: str) -> Optional[dict[str, Any]]:
        """Get a single preset by ID."""
        for p in self.get_presets():
            if p["id"] == preset_id:
                return p
        return None

    def _get_builtin_preset(self, preset_id: str) -> Optional[dict[str, Any]]:
        for preset in BUILTIN_PRESETS:
            if preset["id"] == preset_id:
                return preset
        return None

    def _materialize_builtin_preset(self, preset_id: str) -> Optional[dict[str, Any]]:
        builtin = self._get_builtin_preset(preset_id)
        if not builtin:
            return None

        editable = copy.deepcopy(builtin)
        editable["is_builtin"] = False

        self._save_preset(editable)

        preset_dir = PRESETS_DIR / preset_id
        preset_dir.mkdir(parents=True, exist_ok=True)
        html_content = _load_builtin_html(editable.get("style", "blank"))
        (preset_dir / "overlay.html").write_text(html_content, encoding="utf-8")

        self._update_in_memory(editable)
        logger.info("[Preset] Materialized built-in preset for editing: %s", preset_id)
        return editable

    def _get_or_materialize_editable_preset(self, preset_id: str) -> Optional[dict[str, Any]]:
        preset_id = _safe_id(preset_id)
        preset = self.get_preset(preset_id)
        if not preset:
            return None
        if preset.get("is_builtin"):
            return self._materialize_builtin_preset(preset_id)
        return preset

    def create_preset(self, data: dict[str, Any]) -> dict[str, Any]:
        """Create a new custom preset."""
        preset_id = data.get("id") or f"preset_{uuid.uuid4().hex[:8]}"
        preset_id = _safe_id(preset_id)

        style = data.get("style", "custom")

        preset: dict[str, Any] = {
            "id": preset_id,
            "name": data.get("name", "Custom Preset"),
            "description": data.get("description", ""),
            "style": style,
            "is_builtin": False,
            "version": "1.0.0",
            "sections": data.get("sections", {section: [] for section in VIDEO_SECTIONS}),
            "variables": data.get("variables", dict(DEFAULT_VARIABLES)),
            "intro_video_path": data.get("intro_video_path"),
        }

        self._save_preset(preset)

        # Write overlay HTML content
        html_content = data.get("html_content")
        if not html_content:
            # New designs start with blank template HTML
            html_content = _load_builtin_html("blank")
        preset_dir = PRESETS_DIR / preset_id
        preset_dir.mkdir(parents=True, exist_ok=True)
        (preset_dir / "overlay.html").write_text(html_content, encoding="utf-8")

        self._update_in_memory(preset)
        logger.info("[Preset] Created: %s", preset_id)
        return preset

    def update_preset(self, preset_id: str, updates: dict[str, Any]) -> Optional[dict[str, Any]]:
        """Update a preset, materializing built-ins into editable saved presets on first write."""
        preset = self._get_or_materialize_editable_preset(preset_id)
        if not preset:
            return None

        preset_id = preset["id"]

        for key in ("name", "description", "style", "sections", "variables", "intro_video_path"):
            if key in updates:
                preset[key] = updates[key]

        # Write overlay HTML content if provided
        if "html_content" in updates:
            preset_dir = PRESETS_DIR / preset_id
            preset_dir.mkdir(parents=True, exist_ok=True)
            (preset_dir / "overlay.html").write_text(updates["html_content"], encoding="utf-8")

        # Bump version
        preset["version"] = _bump_version(preset.get("version", "1.0.0"))

        self._save_preset(preset)
        self._update_in_memory(preset)
        logger.info("[Preset] Updated: %s", preset_id)
        return preset

    def delete_preset(self, preset_id: str) -> bool:
        """Delete a saved preset or saved override by ID."""
        preset_id = _safe_id(preset_id)
        custom_preset = next((preset for preset in self._custom_presets if preset["id"] == preset_id), None)
        if not custom_preset:
            return False

        preset_dir = PRESETS_DIR / preset_id
        if preset_dir.exists():
            shutil.rmtree(preset_dir)

        self._custom_presets = [p for p in self._custom_presets if p["id"] != preset_id]
        logger.info("[Preset] Deleted: %s", preset_id)
        return True

    def duplicate_preset(self, preset_id: str) -> Optional[dict[str, Any]]:
        """Duplicate a preset as a new custom preset, including HTML content."""
        preset = self.get_preset(preset_id)
        if not preset:
            return None

        import copy
        new_preset = copy.deepcopy(preset)
        new_preset["id"] = f"preset_{uuid.uuid4().hex[:8]}"
        new_preset["name"] = f"{preset['name']} (Copy)"
        new_preset["is_builtin"] = False
        new_preset["version"] = "1.0.0"

        # Copy HTML content from source design
        html_content = self.get_html_content(preset_id)
        if html_content:
            new_preset["html_content"] = html_content

        return self.create_preset(new_preset)

    def export_preset(self, preset_id: str) -> Optional[dict[str, Any]]:
        """Export a preset as a JSON-serializable dict."""
        return self.get_preset(preset_id)

    def import_preset(self, data: dict[str, Any]) -> dict[str, Any]:
        """Import a preset from exported data."""
        data["is_builtin"] = False
        data["id"] = f"preset_{uuid.uuid4().hex[:8]}"
        # Strip legacy template_id field
        data.pop("template_id", None)
        return self.create_preset(data)

    # ── HTML content management ──────────────────────────────────────────────

    def get_html_content(self, preset_id: str) -> Optional[str]:
        """Get overlay HTML content for a design.

        Built-in designs read from backend/server/templates/{style}/.
        Custom designs read from {PRESETS_DIR}/{preset_id}/overlay.html.
        """
        preset = self.get_preset(preset_id)
        if not preset:
            return None

        if preset.get("is_builtin"):
            style = preset.get("style", "broadcast")
            return _load_builtin_html(style)

        # Custom preset — read from preset directory
        html_path = PRESETS_DIR / preset_id / "overlay.html"
        if html_path.exists():
            return html_path.read_text(encoding="utf-8")

        # Backward compat: try migrating from legacy template_id
        return self._migrate_legacy_html(preset)

    def update_html_content(self, preset_id: str, html_content: str) -> bool:
        """Update overlay HTML content, materializing built-ins into editable saved presets on first write."""
        preset = self._get_or_materialize_editable_preset(preset_id)
        if not preset:
            return False

        preset_id = preset["id"]

        preset_dir = PRESETS_DIR / preset_id
        preset_dir.mkdir(parents=True, exist_ok=True)
        (preset_dir / "overlay.html").write_text(html_content, encoding="utf-8")
        return True

    def _migrate_legacy_html(self, preset: dict[str, Any]) -> Optional[str]:
        """Fallback: return blank HTML for presets with no overlay.html."""
        return _load_builtin_html("blank") or None

    # ── Element management ───────────────────────────────────────────────────

    def add_element(self, preset_id: str, section: str, element: dict[str, Any]) -> Optional[dict[str, Any]]:
        """Add an overlay element to a section within a preset."""
        preset = self._get_or_materialize_editable_preset(preset_id)
        if not preset:
            return None
        if section not in VIDEO_SECTIONS:
            return None

        element_id = element.get("id") or f"elem_{uuid.uuid4().hex[:8]}"
        element["id"] = element_id
        element.setdefault("name", "New Element")
        element.setdefault("template", "<div>{{ frame.driver_name }}</div>")
        element.setdefault("position", {"x": 10, "y": 10, "w": 20, "h": 10})
        element.setdefault("z_index", 10)
        element.setdefault("visible", True)

        sections = preset.get("sections", {})
        section_elements = sections.get(section, [])
        section_elements.append(element)
        sections[section] = section_elements
        preset["sections"] = sections

        self.update_preset(preset_id, {"sections": sections})
        return element

    def update_element(self, preset_id: str, section: str, element_id: str, updates: dict[str, Any]) -> Optional[dict[str, Any]]:
        """Update an element within a preset section."""
        preset = self._get_or_materialize_editable_preset(preset_id)
        if not preset:
            return None

        sections = preset.get("sections", {})
        elements = sections.get(section, [])

        for i, elem in enumerate(elements):
            if elem["id"] == element_id:
                for key in ("name", "template", "position", "z_index", "visible"):
                    if key in updates:
                        elem[key] = updates[key]
                elements[i] = elem
                sections[section] = elements
                self.update_preset(preset_id, {"sections": sections})
                return elem

        return None

    def remove_element(self, preset_id: str, section: str, element_id: str) -> bool:
        """Remove an element from a preset section."""
        preset = self._get_or_materialize_editable_preset(preset_id)
        if not preset:
            return False

        sections = preset.get("sections", {})
        elements = sections.get(section, [])
        new_elements = [e for e in elements if e["id"] != element_id]

        if len(new_elements) == len(elements):
            return False

        sections[section] = new_elements
        self.update_preset(preset_id, {"sections": sections})
        return True

    # ── Asset management ─────────────────────────────────────────────────────

    @staticmethod
    def _normalize_asset_scope(scope: str | None) -> str:
        normalized = (scope or "global").strip().lower()
        if normalized not in {"global", "project"}:
            raise ValueError(f"Invalid asset scope: {scope!r}")
        return normalized

    def _get_global_asset_dir(self, preset_id: str) -> Path:
        safe_pid = _safe_id(preset_id)
        asset_dir = GLOBAL_ASSETS_DIR / safe_pid
        asset_dir.mkdir(parents=True, exist_ok=True)
        return asset_dir

    def _get_project_asset_dir(self, preset_id: str, project_id: int) -> Path:
        from server.services.project_service import project_service

        project = project_service.get_project(int(project_id))
        if not project:
            raise ValueError(f"Project not found: {project_id}")

        project_dir = Path(str(project.get("project_dir", ""))).resolve()
        if not project_dir.exists():
            raise ValueError(f"Project directory does not exist: {project_dir}")

        safe_pid = _safe_id(preset_id)
        asset_dir = project_dir / "overlays" / "assets" / safe_pid
        asset_dir.mkdir(parents=True, exist_ok=True)
        return asset_dir

    @staticmethod
    def _manifest_path(asset_dir: Path) -> Path:
        return asset_dir / "manifest.json"

    @staticmethod
    def _load_asset_manifest(asset_dir: Path) -> dict[str, Any]:
        manifest_path = PresetService._manifest_path(asset_dir)
        if not manifest_path.exists():
            return {"variables": {}}
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {"variables": {}}

        variables = data.get("variables") if isinstance(data, dict) else {}
        if not isinstance(variables, dict):
            variables = {}
        clean_vars: dict[str, str] = {}
        for key, value in variables.items():
            if isinstance(key, str) and isinstance(value, str):
                clean_vars[key] = value
        return {"variables": clean_vars}

    @staticmethod
    def _save_asset_manifest(asset_dir: Path, manifest: dict[str, Any]) -> None:
        manifest_path = PresetService._manifest_path(asset_dir)
        variables = manifest.get("variables", {}) if isinstance(manifest, dict) else {}
        if not isinstance(variables, dict):
            variables = {}
        clean_vars: dict[str, str] = {}
        for key, value in variables.items():
            if isinstance(key, str) and isinstance(value, str):
                clean_vars[key] = value
        manifest_path.write_text(
            json.dumps({"variables": clean_vars}, indent=2),
            encoding="utf-8",
        )

    @staticmethod
    def _build_inverse_mapping(mapping: dict[str, Any]) -> dict[str, list[str]]:
        inverse: dict[str, list[str]] = {}
        for variable_name, filename in mapping.items():
            if not isinstance(variable_name, str) or not isinstance(filename, str):
                continue
            inverse.setdefault(filename, []).append(variable_name)
        for filename in list(inverse.keys()):
            inverse[filename].sort()
        return inverse

    @staticmethod
    def _sanitize_variable_name(variable_name: str) -> str:
        cleaned = (variable_name or "").strip()
        if not _SAFE_ASSET_VAR_RE.match(cleaned):
            raise ValueError(
                "Invalid variable name. Use letters/numbers/underscore and start with a letter or underscore"
            )
        return cleaned

    def get_asset_variable_bindings(self, preset_id: str, project_id: int | None = None) -> dict[str, dict[str, dict[str, str]]]:
        global_dir = self._get_global_asset_dir(preset_id)
        global_manifest = self._load_asset_manifest(global_dir)
        global_vars = dict(global_manifest.get("variables") or {})

        project_vars: dict[str, str] = {}
        if project_id is not None:
            try:
                project_dir = self._get_project_asset_dir(preset_id, int(project_id))
                project_manifest = self._load_asset_manifest(project_dir)
                project_vars = dict(project_manifest.get("variables") or {})
            except ValueError:
                project_vars = {}

        defaults = {
            var_name: {"scope": "global", "filename": filename}
            for var_name, filename in global_vars.items()
            if isinstance(var_name, str) and isinstance(filename, str)
        }
        overrides = {
            var_name: {"scope": "project", "filename": filename}
            for var_name, filename in project_vars.items()
            if isinstance(var_name, str) and isinstance(filename, str)
        }
        effective = dict(defaults)
        effective.update(overrides)

        return {
            "defaults": defaults,
            "overrides": overrides,
            "effective": effective,
        }

    def upload_asset(
        self,
        preset_id: str,
        filename: str,
        content: bytes,
        scope: str = "global",
        project_id: int | None = None,
        variable_name: str | None = None,
    ) -> dict[str, Any]:
        """Upload an image asset for a preset into the global or project store."""
        normalized_scope = self._normalize_asset_scope(scope)
        safe_name = _safe_filename(filename) or f"asset_{uuid.uuid4().hex[:8]}.png"

        if normalized_scope == "global":
            asset_dir = self._get_global_asset_dir(preset_id)
        else:
            if project_id is None:
                raise ValueError("project_id is required for project-scoped assets")
            asset_dir = self._get_project_asset_dir(preset_id, int(project_id))

        asset_path = (asset_dir / safe_name).resolve()
        asset_path.write_bytes(content)

        if variable_name:
            self.set_asset_variable(
                preset_id=preset_id,
                variable_name=variable_name,
                filename=safe_name,
                scope=normalized_scope,
                project_id=project_id,
                clear=False,
            )

        logger.info(
            "[Preset] Asset uploaded: preset=%s scope=%s project=%s file=%s",
            preset_id,
            normalized_scope,
            project_id,
            safe_name,
        )

        return {
            "preset_id": preset_id,
            "scope": normalized_scope,
            "project_id": project_id,
            "filename": safe_name,
            "path": str(asset_path),
            "size_bytes": len(content),
            "variable_name": variable_name.strip() if isinstance(variable_name, str) and variable_name.strip() else None,
        }

    def list_assets(self, preset_id: str, project_id: int | None = None) -> dict[str, Any]:
        """List assets and variable mappings for a preset and optional project context."""
        global_dir = self._get_global_asset_dir(preset_id)
        project_dir: Path | None = None

        if project_id is not None:
            try:
                project_dir = self._get_project_asset_dir(preset_id, int(project_id))
            except ValueError:
                project_dir = None

        bindings = self.get_asset_variable_bindings(preset_id, project_id)
        default_inverse = self._build_inverse_mapping({
            var_name: binding.get("filename")
            for var_name, binding in (bindings.get("defaults") or {}).items()
            if isinstance(binding, dict)
        })
        override_inverse = self._build_inverse_mapping({
            var_name: binding.get("filename")
            for var_name, binding in (bindings.get("overrides") or {}).items()
            if isinstance(binding, dict)
        })
        effective_inverse: dict[str, list[str]] = {}
        for var_name, binding in (bindings.get("effective") or {}).items():
            if not isinstance(binding, dict):
                continue
            filename = binding.get("filename")
            if not isinstance(filename, str):
                continue
            effective_inverse.setdefault(filename, []).append(var_name)
        for filename in list(effective_inverse.keys()):
            effective_inverse[filename].sort()

        assets: list[dict[str, Any]] = []

        def _collect(dir_path: Path | None, scope_name: str) -> None:
            if not dir_path or not dir_path.exists():
                return
            for file_path in sorted(dir_path.iterdir(), key=lambda p: p.name.lower()):
                if not file_path.is_file() or file_path.name == "manifest.json":
                    continue
                filename = file_path.name
                assets.append({
                    "filename": filename,
                    "scope": scope_name,
                    "size_bytes": file_path.stat().st_size,
                    "path": str(file_path),
                    "assigned_default_variables": default_inverse.get(filename, []) if scope_name == "global" else [],
                    "assigned_override_variables": override_inverse.get(filename, []) if scope_name == "project" else [],
                    "assigned_effective_variables": effective_inverse.get(filename, []),
                })

        _collect(global_dir, "global")
        _collect(project_dir, "project")

        return {
            "assets": assets,
            "variable_defaults": bindings.get("defaults", {}),
            "variable_overrides": bindings.get("overrides", {}),
            "variable_effective": bindings.get("effective", {}),
        }

    def delete_asset(
        self,
        preset_id: str,
        filename: str,
        scope: str = "global",
        project_id: int | None = None,
    ) -> bool:
        """Delete an asset file from the selected scope and remove related variable bindings."""
        normalized_scope = self._normalize_asset_scope(scope)
        safe_name = _safe_filename(filename)

        if normalized_scope == "global":
            asset_dir = self._get_global_asset_dir(preset_id)
        else:
            if project_id is None:
                raise ValueError("project_id is required for project-scoped assets")
            asset_dir = self._get_project_asset_dir(preset_id, int(project_id))

        asset_path = (asset_dir / safe_name).resolve()
        if not asset_path.exists() or not asset_path.is_file():
            return False

        asset_path.unlink()

        manifest = self._load_asset_manifest(asset_dir)
        variables = dict(manifest.get("variables") or {})
        changed = False
        for key in list(variables.keys()):
            if variables.get(key) == safe_name:
                variables.pop(key, None)
                changed = True
        if changed:
            manifest["variables"] = variables
            self._save_asset_manifest(asset_dir, manifest)

        return True

    def move_asset_scope(
        self,
        preset_id: str,
        filename: str,
        target_scope: str,
        project_id: int | None = None,
        source_scope: str | None = None,
    ) -> dict[str, Any]:
        """Move an asset between global and project stores, preserving variable bindings."""
        normalized_target = self._normalize_asset_scope(target_scope)
        safe_name = _safe_filename(filename)

        candidate_scopes = [self._normalize_asset_scope(source_scope)] if source_scope else ["global", "project"]

        source_dir: Path | None = None
        source_scope_resolved: str | None = None
        source_path: Path | None = None

        for candidate in candidate_scopes:
            if candidate == "global":
                candidate_dir = self._get_global_asset_dir(preset_id)
            else:
                if project_id is None:
                    continue
                candidate_dir = self._get_project_asset_dir(preset_id, int(project_id))
            candidate_path = (candidate_dir / safe_name).resolve()
            if candidate_path.exists() and candidate_path.is_file():
                source_dir = candidate_dir
                source_scope_resolved = candidate
                source_path = candidate_path
                break

        if source_dir is None or source_scope_resolved is None or source_path is None:
            raise FileNotFoundError(f"Asset not found: {safe_name}")

        if source_scope_resolved == normalized_target:
            return {
                "filename": safe_name,
                "source_scope": source_scope_resolved,
                "target_scope": normalized_target,
                "project_id": project_id,
                "moved": False,
            }

        if normalized_target == "global":
            target_dir = self._get_global_asset_dir(preset_id)
        else:
            if project_id is None:
                raise ValueError("project_id is required when moving to project scope")
            target_dir = self._get_project_asset_dir(preset_id, int(project_id))

        target_name = safe_name
        target_path = (target_dir / target_name).resolve()
        if target_path.exists():
            stem = Path(safe_name).stem
            suffix = Path(safe_name).suffix
            index = 1
            while target_path.exists():
                target_name = f"{stem}_{index}{suffix}"
                target_path = (target_dir / target_name).resolve()
                index += 1

        shutil.move(str(source_path), str(target_path))

        source_manifest = self._load_asset_manifest(source_dir)
        target_manifest = self._load_asset_manifest(target_dir)
        source_vars = dict(source_manifest.get("variables") or {})
        target_vars = dict(target_manifest.get("variables") or {})

        moved_vars: list[str] = []
        for var_name, bound_filename in list(source_vars.items()):
            if bound_filename != safe_name:
                continue
            moved_vars.append(var_name)
            source_vars.pop(var_name, None)
            target_vars[var_name] = target_name

        source_manifest["variables"] = source_vars
        target_manifest["variables"] = target_vars
        self._save_asset_manifest(source_dir, source_manifest)
        self._save_asset_manifest(target_dir, target_manifest)

        return {
            "filename": target_name,
            "old_filename": safe_name,
            "source_scope": source_scope_resolved,
            "target_scope": normalized_target,
            "project_id": project_id,
            "moved": True,
            "moved_variables": sorted(moved_vars),
        }

    def set_asset_variable(
        self,
        preset_id: str,
        variable_name: str,
        filename: str | None,
        scope: str = "global",
        project_id: int | None = None,
        clear: bool = False,
    ) -> dict[str, Any]:
        """Assign or clear an asset variable mapping for default/global or project override scope."""
        normalized_scope = self._normalize_asset_scope(scope)
        clean_var = self._sanitize_variable_name(variable_name)

        if normalized_scope == "global":
            asset_dir = self._get_global_asset_dir(preset_id)
        else:
            if project_id is None:
                raise ValueError("project_id is required for project-scoped variable mappings")
            asset_dir = self._get_project_asset_dir(preset_id, int(project_id))

        manifest = self._load_asset_manifest(asset_dir)
        variables = dict(manifest.get("variables") or {})

        if clear or not filename:
            variables.pop(clean_var, None)
            manifest["variables"] = variables
            self._save_asset_manifest(asset_dir, manifest)
            return {
                "variable_name": clean_var,
                "scope": normalized_scope,
                "project_id": project_id,
                "cleared": True,
                "filename": None,
            }

        safe_name = _safe_filename(filename)
        asset_path = (asset_dir / safe_name).resolve()
        if not asset_path.exists() or not asset_path.is_file():
            raise FileNotFoundError(f"Asset not found for mapping: {safe_name}")

        variables[clean_var] = safe_name
        manifest["variables"] = variables
        self._save_asset_manifest(asset_dir, manifest)

        return {
            "variable_name": clean_var,
            "scope": normalized_scope,
            "project_id": project_id,
            "cleared": False,
            "filename": safe_name,
        }

    def get_asset_path(
        self,
        preset_id: str,
        filename: str,
        scope: str = "global",
        project_id: int | None = None,
    ) -> Optional[Path]:
        """Get the filesystem path for an asset in global or project scope."""
        normalized_scope = self._normalize_asset_scope(scope)
        safe_name = _safe_filename(filename)

        try:
            if normalized_scope == "global":
                asset_dir = self._get_global_asset_dir(preset_id)
            else:
                if project_id is None:
                    return None
                asset_dir = self._get_project_asset_dir(preset_id, int(project_id))
        except ValueError:
            return None

        asset_path = (asset_dir / safe_name).resolve()
        return asset_path if asset_path.exists() and asset_path.is_file() else None

    def get_asset_variable_urls(self, preset_id: str, project_id: int | None = None) -> dict[str, str]:
        """Return effective template variable -> asset URL mappings."""
        bindings = self.get_asset_variable_bindings(preset_id, project_id)
        effective = bindings.get("effective") or {}
        result: dict[str, str] = {}

        for var_name, binding in effective.items():
            if not isinstance(binding, dict):
                continue
            filename = binding.get("filename")
            scope = binding.get("scope")
            if not isinstance(filename, str) or not isinstance(scope, str):
                continue
            if scope == "project":
                if project_id is None:
                    continue
                url = f"/api/presets/{preset_id}/assets/{filename}?scope=project&project_id={int(project_id)}"
            else:
                url = f"/api/presets/{preset_id}/assets/{filename}?scope=global"
            result[var_name] = url

        return result

    # ── Intro video ──────────────────────────────────────────────────────────

    def upload_intro_video(self, preset_id: str, filename: str, content: bytes) -> dict[str, Any]:
        """Upload an intro video for a preset."""
        safe_pid = _safe_id(preset_id)
        safe_name = _safe_filename(filename)
        if not safe_name.lower().endswith(('.mp4', '.mov', '.webm')):
            safe_name += '.mp4'

        video_dir = PRESETS_DIR / safe_pid / "intro_video"
        video_dir.mkdir(parents=True, exist_ok=True)

        # Remove existing intro video files
        for existing in video_dir.iterdir():
            if existing.is_file():
                existing.unlink()

        video_path = _ensure_within(video_dir / safe_name, PRESETS_DIR)
        video_path.write_bytes(content)

        # Update preset
        preset = self._get_or_materialize_editable_preset(preset_id)
        if preset:
            self.update_preset(preset_id, {"intro_video_path": str(video_path)})

        logger.info("[Preset] Intro video uploaded: %s/%s", safe_pid, safe_name)
        return {
            "preset_id": preset_id,
            "filename": safe_name,
            "path": str(video_path),
            "size_bytes": len(content),
        }

    def delete_intro_video(self, preset_id: str) -> bool:
        """Delete the intro video for a preset."""
        safe_pid = _safe_id(preset_id)
        video_dir = PRESETS_DIR / safe_pid / "intro_video"
        if video_dir.exists():
            shutil.rmtree(video_dir)
        preset = self._get_or_materialize_editable_preset(preset_id)
        if preset:
            self.update_preset(preset_id, {"intro_video_path": None})
        return True

    # ── Internal ─────────────────────────────────────────────────────────────

    def _save_preset(self, preset: dict[str, Any]) -> None:
        preset_dir = PRESETS_DIR / preset["id"]
        preset_dir.mkdir(parents=True, exist_ok=True)
        (preset_dir / "preset.json").write_text(
            json.dumps(preset, indent=2, default=str), encoding="utf-8"
        )

    def _load_custom_presets(self) -> None:
        self._custom_presets = []
        if not PRESETS_DIR.exists():
            return
        for preset_path in PRESETS_DIR.glob("*/preset.json"):
            try:
                data = json.loads(preset_path.read_text(encoding="utf-8"))
                data["is_builtin"] = False
                data.setdefault("style", "custom")

                # Legacy migration: infer style from old template_id
                legacy_template_id = data.pop("template_id", None)
                if data.get("style") == "custom" and legacy_template_id:
                    data["style"] = legacy_template_id

                # Legacy migration: if no overlay.html exists, migrate from template
                preset_dir = preset_path.parent
                html_path = preset_dir / "overlay.html"
                if not html_path.exists() and legacy_template_id:
                    html_content = _load_builtin_html(legacy_template_id)
                    if html_content:
                        html_path.write_text(html_content, encoding="utf-8")
                        logger.info("[Preset] Migrated HTML from template '%s' for preset '%s'",
                                    legacy_template_id, data.get("id"))

                self._custom_presets.append(data)
            except (json.JSONDecodeError, OSError) as exc:
                logger.warning("[Preset] Failed to load %s: %s", preset_path, exc)

    def _update_in_memory(self, preset: dict[str, Any]) -> None:
        for i, p in enumerate(self._custom_presets):
            if p["id"] == preset["id"]:
                self._custom_presets[i] = preset
                return
        self._custom_presets.append(preset)


def _bump_version(version: str) -> str:
    """Bump patch version: 1.0.0 → 1.0.1"""
    try:
        parts = version.split(".")
        parts[-1] = str(int(parts[-1]) + 1)
        return ".".join(parts)
    except Exception:
        return "1.0.1"


# ── Module-level singleton ──────────────────────────────────────────────────

preset_service = PresetService()
