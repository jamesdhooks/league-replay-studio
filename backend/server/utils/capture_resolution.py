"""
capture_resolution.py
---------------------
Shared capture-window resolution presets.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import HTTPException

_FALLBACK_CONFIG: dict[str, Any] = {
    "default": "1080p",
    "presets": [
        {
            "id": "1080p",
            "label": "1080p",
            "width": 1920,
            "height": 1080,
            "description": "Standard Full HD capture target",
        },
        {
            "id": "1440p",
            "label": "1440p",
            "width": 2560,
            "height": 1440,
            "description": "High-quality QHD capture target",
        },
    ],
}


def _shared_config_path() -> Path:
    # backend/server/utils -> repo root -> shared/capture_resolutions.json
    return Path(__file__).resolve().parents[3] / "shared" / "capture_resolutions.json"


@lru_cache(maxsize=1)
def get_capture_resolution_config() -> dict[str, Any]:
    path = _shared_config_path()
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return _FALLBACK_CONFIG


def get_capture_resolution_presets() -> list[dict[str, Any]]:
    config = get_capture_resolution_config()
    presets = []
    for preset in config.get("presets", []):
        preset_id = str(preset.get("id") or "").strip()
        width = int(preset.get("width") or 0)
        height = int(preset.get("height") or 0)
        if not preset_id or width < 320 or height < 240:
            continue
        presets.append({
            "id": preset_id,
            "label": str(preset.get("label") or preset_id),
            "width": width,
            "height": height,
            "description": str(preset.get("description") or ""),
        })
    return presets


def resolve_capture_resolution(value: str | None) -> tuple[str, int, int]:
    config = get_capture_resolution_config()
    default_id = str(config.get("default") or "1080p")
    preset_id = (value or default_id).strip().lower()
    presets = {preset["id"].lower(): preset for preset in get_capture_resolution_presets()}

    if preset_id not in presets:
        allowed = ", ".join(sorted(presets)) or default_id
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported capture resolution '{value}'. Choose one of: {allowed}.",
        )

    preset = presets[preset_id]
    return preset["id"], int(preset["width"]), int(preset["height"])
