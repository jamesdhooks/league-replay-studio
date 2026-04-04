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
from pathlib import Path
from typing import Any, Optional

from server.config import DATA_DIR

logger = logging.getLogger(__name__)

# ── Storage paths ────────────────────────────────────────────────────────────

PRESETS_DIR = DATA_DIR / "overlay_presets"
GLOBAL_ASSETS_DIR = DATA_DIR / "overlay_assets"

# ── Safe ID validation ───────────────────────────────────────────────────────

import re
_SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

def _safe_id(value: str) -> str:
    if not value or not _SAFE_ID_RE.match(value):
        raise ValueError(f"Invalid identifier: {value!r}")
    return value

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
  {% for entry in frame.standings[:10] %}
  <div style="display:flex; align-items:center; gap: 0.5em; padding: 0.25em 0.5em;
    margin-bottom: 2px; border-radius: 4px;
    background: {% if entry.is_player %}rgba(59,130,246,0.6){% else %}rgba(0,0,0,0.65){% endif %};
    font-size: clamp(0.5rem, 0.9vw, 0.9rem);">
    <span style="font-weight:700; min-width:1.5em; text-align:right;">{{ entry.position }}</span>
    <span style="flex:1; font-weight:{% if entry.is_player %}700{% else %}400{% endif %};">{{ entry.driver_name }}</span>
    <span style="opacity:0.7; font-variant-numeric:tabular-nums;">{{ entry.car_number }}</span>
  </div>
  {% endfor %}
</div>""",
            "position": {"x": 5, "y": 10, "w": 25, "h": 80},
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
  <div style="width:4px; height:70%; border-radius:2px; background: {{ frame.team_color | default(var(--color-accent, '#3B82F6')) }};"></div>
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
  {% for entry in frame.standings %}
  <div style="display:flex; align-items:center; gap:0.5em; padding:0.3em 0.6em;
    margin-bottom:2px; border-radius:4px;
    background: {% if entry.position == 1 %}rgba(245,158,11,0.5){% elif entry.is_player %}rgba(59,130,246,0.6){% else %}rgba(0,0,0,0.65){% endif %};
    font-size: clamp(0.5rem, 0.9vw, 0.9rem);">
    <span style="font-weight:700; min-width:1.5em; text-align:right;">{{ entry.position }}</span>
    <span style="flex:1; font-weight:{% if entry.is_player or entry.position == 1 %}700{% else %}400{% endif %};">{{ entry.driver_name }}</span>
    <span style="opacity:0.7; font-variant-numeric:tabular-nums;">{{ entry.gap }}</span>
  </div>
  {% endfor %}
</div>""",
            "position": {"x": 25, "y": 10, "w": 50, "h": 80},
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

def _make_builtin_preset(preset_id: str, name: str, description: str, variables: dict | None = None) -> dict[str, Any]:
    return {
        "id": preset_id,
        "name": name,
        "description": description,
        "is_builtin": True,
        "version": "1.0.0",
        "sections": {section: DEFAULT_ELEMENTS.get(section, []) for section in VIDEO_SECTIONS},
        "variables": variables or dict(DEFAULT_VARIABLES),
        "intro_video_path": None,
    }


BUILTIN_PRESETS: list[dict[str, Any]] = [
    _make_builtin_preset("broadcast_preset", "Broadcast", "Full broadcast-style overlay with timing tower, driver card, and lap counter"),
    _make_builtin_preset("minimal_preset", "Minimal", "Clean minimal overlay — position badge and driver name only",
                         variables={
                             **DEFAULT_VARIABLES,
                             "--color-accent": {"value": "#10B981", "type": "color", "label": "Accent Color"},
                         }),
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
        """List all presets (built-in + custom)."""
        return BUILTIN_PRESETS + self._custom_presets

    def get_preset(self, preset_id: str) -> Optional[dict[str, Any]]:
        """Get a single preset by ID."""
        for p in self.get_presets():
            if p["id"] == preset_id:
                return p
        return None

    def create_preset(self, data: dict[str, Any]) -> dict[str, Any]:
        """Create a new custom preset."""
        preset_id = data.get("id") or f"preset_{uuid.uuid4().hex[:8]}"
        preset_id = _safe_id(preset_id)

        preset: dict[str, Any] = {
            "id": preset_id,
            "name": data.get("name", "Custom Preset"),
            "description": data.get("description", ""),
            "is_builtin": False,
            "version": "1.0.0",
            "sections": data.get("sections", {section: [] for section in VIDEO_SECTIONS}),
            "variables": data.get("variables", dict(DEFAULT_VARIABLES)),
            "intro_video_path": data.get("intro_video_path"),
        }

        self._save_preset(preset)
        self._update_in_memory(preset)
        logger.info("[Preset] Created: %s", preset_id)
        return preset

    def update_preset(self, preset_id: str, updates: dict[str, Any]) -> Optional[dict[str, Any]]:
        """Update a custom preset. Built-in presets cannot be modified."""
        preset_id = _safe_id(preset_id)
        preset = self.get_preset(preset_id)
        if not preset or preset.get("is_builtin"):
            return None

        for key in ("name", "description", "sections", "variables", "intro_video_path"):
            if key in updates:
                preset[key] = updates[key]

        # Bump version
        preset["version"] = _bump_version(preset.get("version", "1.0.0"))

        self._save_preset(preset)
        self._update_in_memory(preset)
        logger.info("[Preset] Updated: %s", preset_id)
        return preset

    def delete_preset(self, preset_id: str) -> bool:
        """Delete a custom preset. Built-in presets cannot be deleted."""
        preset_id = _safe_id(preset_id)
        preset = self.get_preset(preset_id)
        if not preset or preset.get("is_builtin"):
            return False

        preset_dir = PRESETS_DIR / preset_id
        if preset_dir.exists():
            shutil.rmtree(preset_dir)

        self._custom_presets = [p for p in self._custom_presets if p["id"] != preset_id]
        logger.info("[Preset] Deleted: %s", preset_id)
        return True

    def duplicate_preset(self, preset_id: str) -> Optional[dict[str, Any]]:
        """Duplicate a preset as a new custom preset."""
        preset = self.get_preset(preset_id)
        if not preset:
            return None

        import copy
        new_preset = copy.deepcopy(preset)
        new_preset["id"] = f"preset_{uuid.uuid4().hex[:8]}"
        new_preset["name"] = f"{preset['name']} (Copy)"
        new_preset["is_builtin"] = False
        new_preset["version"] = "1.0.0"

        return self.create_preset(new_preset)

    def export_preset(self, preset_id: str) -> Optional[dict[str, Any]]:
        """Export a preset as a JSON-serializable dict."""
        return self.get_preset(preset_id)

    def import_preset(self, data: dict[str, Any]) -> dict[str, Any]:
        """Import a preset from exported data."""
        data["is_builtin"] = False
        data["id"] = f"preset_{uuid.uuid4().hex[:8]}"
        return self.create_preset(data)

    # ── Element management ───────────────────────────────────────────────────

    def add_element(self, preset_id: str, section: str, element: dict[str, Any]) -> Optional[dict[str, Any]]:
        """Add an overlay element to a section within a preset."""
        preset = self.get_preset(preset_id)
        if not preset or preset.get("is_builtin"):
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
        preset = self.get_preset(preset_id)
        if not preset or preset.get("is_builtin"):
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
        preset = self.get_preset(preset_id)
        if not preset or preset.get("is_builtin"):
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

    def upload_asset(self, preset_id: str, filename: str, content: bytes) -> dict[str, Any]:
        """Upload an image asset for a preset.

        Assets are stored globally in {DATA_DIR}/overlay_assets/{preset_id}/
        """
        safe_pid = _safe_id(preset_id)
        # Sanitize filename
        safe_name = re.sub(r'[^a-zA-Z0-9_.\-]', '_', filename)
        if not safe_name:
            safe_name = f"asset_{uuid.uuid4().hex[:8]}.png"

        asset_dir = GLOBAL_ASSETS_DIR / safe_pid
        asset_dir.mkdir(parents=True, exist_ok=True)
        asset_path = asset_dir / safe_name

        asset_path.write_bytes(content)
        logger.info("[Preset] Asset uploaded: %s/%s", safe_pid, safe_name)

        return {
            "preset_id": preset_id,
            "filename": safe_name,
            "path": str(asset_path),
            "size_bytes": len(content),
        }

    def list_assets(self, preset_id: str) -> list[dict[str, Any]]:
        """List all assets for a preset."""
        safe_pid = _safe_id(preset_id)
        asset_dir = GLOBAL_ASSETS_DIR / safe_pid
        if not asset_dir.exists():
            return []

        assets = []
        for f in asset_dir.iterdir():
            if f.is_file():
                assets.append({
                    "filename": f.name,
                    "size_bytes": f.stat().st_size,
                    "path": str(f),
                })
        return assets

    def delete_asset(self, preset_id: str, filename: str) -> bool:
        """Delete an asset file."""
        safe_pid = _safe_id(preset_id)
        safe_name = re.sub(r'[^a-zA-Z0-9_.\-]', '_', filename)
        asset_path = GLOBAL_ASSETS_DIR / safe_pid / safe_name
        if asset_path.exists():
            asset_path.unlink()
            return True
        return False

    def get_asset_path(self, preset_id: str, filename: str) -> Optional[Path]:
        """Get the filesystem path for an asset."""
        safe_pid = _safe_id(preset_id)
        safe_name = re.sub(r'[^a-zA-Z0-9_.\-]', '_', filename)
        asset_path = GLOBAL_ASSETS_DIR / safe_pid / safe_name
        return asset_path if asset_path.exists() else None

    # ── Intro video ──────────────────────────────────────────────────────────

    def upload_intro_video(self, preset_id: str, filename: str, content: bytes) -> dict[str, Any]:
        """Upload an intro video for a preset."""
        safe_pid = _safe_id(preset_id)
        safe_name = re.sub(r'[^a-zA-Z0-9_.\-]', '_', filename)
        if not safe_name.lower().endswith(('.mp4', '.mov', '.webm')):
            safe_name += '.mp4'

        video_dir = PRESETS_DIR / safe_pid / "intro_video"
        video_dir.mkdir(parents=True, exist_ok=True)

        # Remove existing intro video files
        for existing in video_dir.iterdir():
            if existing.is_file():
                existing.unlink()

        video_path = video_dir / safe_name
        video_path.write_bytes(content)

        # Update preset
        preset = self.get_preset(preset_id)
        if preset and not preset.get("is_builtin"):
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
        preset = self.get_preset(preset_id)
        if preset and not preset.get("is_builtin"):
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
