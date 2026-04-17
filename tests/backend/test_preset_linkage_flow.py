"""Integration tests for preset/template linkage behavior."""

from pathlib import Path
import os
import sys
import json

import pytest

# Ensure the backend package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "backend"))

import server.services.preset_service as preset_module


@pytest.fixture
def isolated_preset_paths(tmp_path, monkeypatch):
    """Point preset storage to a temporary test directory."""
    presets_dir = tmp_path / "overlay_presets"
    assets_dir = tmp_path / "overlay_assets"
    monkeypatch.setattr(preset_module, "PRESETS_DIR", presets_dir)
    monkeypatch.setattr(preset_module, "GLOBAL_ASSETS_DIR", assets_dir)
    return presets_dir, assets_dir


def test_create_update_reload_template_link(isolated_preset_paths):
    """A created preset keeps template_id through update and service reload."""
    svc = preset_module.PresetService()

    created = svc.create_preset({
        "id": "custom_link_flow",
        "name": "Custom Link Flow",
        "template_id": "blank",
    })
    assert created["template_id"] == "blank"

    updated = svc.update_preset(created["id"], {"template_id": "broadcast"})
    assert updated is not None
    assert updated["template_id"] == "broadcast"

    reloaded = preset_module.PresetService()
    loaded = reloaded.get_preset(created["id"])
    assert loaded is not None
    assert loaded["template_id"] == "broadcast"


def test_duplicate_builtin_and_relink_template(isolated_preset_paths):
    """Duplicating a built-in preset creates editable copy that can be relinked."""
    svc = preset_module.PresetService()

    duplicated = svc.duplicate_preset("broadcast_preset")
    assert duplicated is not None
    assert duplicated["is_builtin"] is False
    assert duplicated["template_id"] == "broadcast"

    relinked = svc.update_preset(duplicated["id"], {"template_id": "blank"})
    assert relinked is not None
    assert relinked["template_id"] == "blank"


def test_legacy_preset_backfills_missing_template_id(isolated_preset_paths):
    """Legacy preset.json files without template_id are loaded with safe default."""
    presets_dir, _ = isolated_preset_paths

    legacy_dir = presets_dir / "legacy_no_template"
    legacy_dir.mkdir(parents=True, exist_ok=True)
    legacy_data = {
        "id": "legacy_no_template",
        "name": "Legacy Preset",
        "description": "Created before template linkage",
        "version": "1.0.0",
        "sections": {section: [] for section in preset_module.VIDEO_SECTIONS},
        "variables": {},
        "intro_video_path": None,
    }
    (legacy_dir / "preset.json").write_text(json.dumps(legacy_data), encoding="utf-8")

    svc = preset_module.PresetService()
    legacy = svc.get_preset("legacy_no_template")
    assert legacy is not None
    assert "template_id" in legacy
    assert legacy["template_id"] is None


def test_builtin_presets_have_canonical_template_links(isolated_preset_paths):
    """Built-in presets expose canonical template mappings used by the UI."""
    svc = preset_module.PresetService()

    broadcast = svc.get_preset("broadcast_preset")
    minimal = svc.get_preset("minimal_preset")

    assert broadcast is not None
    assert minimal is not None
    assert broadcast["template_id"] == "broadcast"
    assert minimal["template_id"] == "minimal"
