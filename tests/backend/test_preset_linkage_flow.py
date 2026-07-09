"""Integration tests for unified design data model (html_content + style)."""

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


def test_create_preset_writes_overlay_html(isolated_preset_paths):
    """Creating a preset writes an overlay.html file alongside preset.json."""
    presets_dir, _ = isolated_preset_paths
    svc = preset_module.PresetService()

    created = svc.create_preset({
        "id": "test_html",
        "name": "HTML Test",
        "html_content": "<div>Test overlay</div>",
    })
    assert created["style"] == "custom"

    html_path = presets_dir / "test_html" / "overlay.html"
    assert html_path.exists()
    assert html_path.read_text(encoding="utf-8") == "<div>Test overlay</div>"


def test_create_preset_defaults_to_blank_html(isolated_preset_paths):
    """Creating a preset without html_content gets blank template HTML."""
    svc = preset_module.PresetService()

    created = svc.create_preset({"id": "test_blank", "name": "Blank Test"})
    html = svc.get_html_content(created["id"])
    assert html is not None
    assert "overlay" in html.lower()


def test_update_html_content(isolated_preset_paths):
    """update_html_content writes to disk and is retrievable."""
    svc = preset_module.PresetService()

    created = svc.create_preset({"id": "test_update_html", "name": "Update Test"})
    svc.update_html_content(created["id"], "<div>Updated</div>")

    html = svc.get_html_content(created["id"])
    assert html == "<div>Updated</div>"


def test_update_html_content_materializes_builtin(isolated_preset_paths):
    """Built-in presets materialize into saved editable designs on first HTML write."""
    presets_dir, _ = isolated_preset_paths
    svc = preset_module.PresetService()
    assert svc.update_html_content("broadcast_preset", "<div>Custom broadcast</div>") is True
    assert svc.get_html_content("broadcast_preset") == "<div>Custom broadcast</div>"
    assert (presets_dir / "broadcast_preset" / "preset.json").exists()


def test_duplicate_copies_html(isolated_preset_paths):
    """Duplicating a preset copies overlay HTML to the new design."""
    presets_dir, _ = isolated_preset_paths
    svc = preset_module.PresetService()

    svc.create_preset({
        "id": "source_dup",
        "name": "Source",
        "html_content": "<div>Source HTML</div>",
    })

    duplicated = svc.duplicate_preset("source_dup")
    assert duplicated is not None
    assert duplicated["is_builtin"] is False

    dup_html = svc.get_html_content(duplicated["id"])
    assert dup_html == "<div>Source HTML</div>"


def test_duplicate_builtin_copies_html(isolated_preset_paths):
    """Duplicating a built-in preset copies its HTML from the templates dir."""
    svc = preset_module.PresetService()

    duplicated = svc.duplicate_preset("broadcast_preset")
    assert duplicated is not None
    assert duplicated["is_builtin"] is False
    assert duplicated["style"] == "broadcast"

    html = svc.get_html_content(duplicated["id"])
    assert html is not None
    assert len(html) > 0


def test_builtin_presets_have_style(isolated_preset_paths):
    """Built-in presets expose their style field."""
    svc = preset_module.PresetService()

    broadcast = svc.get_preset("broadcast_preset")
    minimal = svc.get_preset("minimal_preset")
    classic = svc.get_preset("classic_preset")
    cinematic = svc.get_preset("cinematic_preset")

    assert broadcast["style"] == "broadcast"
    assert minimal["style"] == "minimal"
    assert classic["style"] == "classic"
    assert cinematic["style"] == "cinematic"


def test_builtin_html_content_readable(isolated_preset_paths):
    """Built-in presets return HTML content from their template files."""
    svc = preset_module.PresetService()

    for preset_id in ("broadcast_preset", "minimal_preset", "classic_preset", "cinematic_preset"):
        html = svc.get_html_content(preset_id)
        assert html is not None, f"No HTML for {preset_id}"
        assert "<!DOCTYPE html>" in html or "<html" in html or "<div" in html


def test_legacy_preset_migration(isolated_preset_paths):
    """Legacy preset.json files with template_id get style inferred and template_id stripped."""
    presets_dir, _ = isolated_preset_paths

    legacy_dir = presets_dir / "legacy_linked"
    legacy_dir.mkdir(parents=True, exist_ok=True)
    legacy_data = {
        "id": "legacy_linked",
        "name": "Legacy Preset",
        "description": "Created before unification",
        "version": "1.0.0",
        "sections": {section: [] for section in preset_module.VIDEO_SECTIONS},
        "variables": {},
        "intro_video_path": None,
        "template_id": "broadcast",
    }
    (legacy_dir / "preset.json").write_text(json.dumps(legacy_data), encoding="utf-8")

    svc = preset_module.PresetService()
    legacy = svc.get_preset("legacy_linked")
    assert legacy is not None
    assert legacy["style"] == "broadcast"
    assert "template_id" not in legacy


def test_legacy_preset_html_migration(isolated_preset_paths):
    """Legacy preset with template_id but no overlay.html gets HTML migrated."""
    presets_dir, _ = isolated_preset_paths

    legacy_dir = presets_dir / "legacy_html"
    legacy_dir.mkdir(parents=True, exist_ok=True)
    legacy_data = {
        "id": "legacy_html",
        "name": "Legacy HTML",
        "version": "1.0.0",
        "sections": {section: [] for section in preset_module.VIDEO_SECTIONS},
        "variables": {},
        "intro_video_path": None,
        "template_id": "broadcast",
    }
    (legacy_dir / "preset.json").write_text(json.dumps(legacy_data), encoding="utf-8")

    svc = preset_module.PresetService()
    html = svc.get_html_content("legacy_html")
    assert html is not None
    assert len(html) > 0
    # Verify it was also written to the preset dir for future access
    assert (legacy_dir / "overlay.html").exists()
