"""Tests for versioned overlay HTML writes and rollback snapshots."""

import os
import sys

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "backend"))

import server.routes.api_preset as api_preset
import server.services.preset_service as preset_module
from server.services.overlay_revision_service import html_sha256, overlay_revision_service


@pytest.fixture
def isolated_bridge(tmp_path, monkeypatch):
    presets_dir = tmp_path / "overlay_presets"
    assets_dir = tmp_path / "overlay_assets"
    monkeypatch.setattr(preset_module, "PRESETS_DIR", presets_dir)
    monkeypatch.setattr(preset_module, "GLOBAL_ASSETS_DIR", assets_dir)

    service = preset_module.PresetService()
    events = []
    monkeypatch.setattr(api_preset, "preset_service", service)
    monkeypatch.setattr(api_preset, "_broadcast_fn", lambda message: events.append(message))
    return service, presets_dir, events


def test_versioned_html_write_creates_revision_and_broadcasts(isolated_bridge):
    service, presets_dir, events = isolated_bridge
    service.create_preset({
        "id": "bridge_test",
        "name": "Bridge Test",
        "html_content": "<div>Before</div>",
    })

    result = api_preset._save_html_with_revision(
        "bridge_test",
        "<div>After</div>",
        summary="Codex edit",
        author="codex",
        source="mcp",
        expected_sha256=html_sha256("<div>Before</div>"),
    )

    assert result["success"] is True
    normalized_after = api_preset._ensure_local_tailwind_runtime("<div>After</div>")
    assert service.get_html_content("bridge_test") == normalized_after
    revision = result["revision"]
    revision_dir = presets_dir / "bridge_test" / "revisions" / revision["revision_id"]
    assert (revision_dir / "preset.json").exists()
    assert (revision_dir / "overlay.html").read_text(encoding="utf-8") == "<div>Before</div>"
    assert revision["base_sha256"] == html_sha256("<div>Before</div>")
    assert revision["result_sha256"] == html_sha256(normalized_after)
    assert [event["event"] for event in events] == [
        "overlay:template_revision_created",
        "overlay:template_updated",
    ]
    assert events[-1]["data"]["source"] == "mcp"
    assert events[-1]["data"]["sha256"] == html_sha256(normalized_after)


def test_versioned_html_write_rejects_stale_checksum(isolated_bridge):
    service, presets_dir, events = isolated_bridge
    service.create_preset({
        "id": "stale_test",
        "name": "Stale Test",
        "html_content": "<div>Current</div>",
    })

    with pytest.raises(HTTPException) as exc_info:
        api_preset._save_html_with_revision(
            "stale_test",
            "<div>Replacement</div>",
            summary="Bad write",
            author="codex",
            source="mcp",
            expected_sha256=html_sha256("<div>Old</div>"),
        )

    assert exc_info.value.status_code == 409
    assert service.get_html_content("stale_test") == "<div>Current</div>"
    assert not (presets_dir / "stale_test" / "revisions").exists()
    assert events == []


def test_restore_revision_uses_revision_html(isolated_bridge):
    service, _, _ = isolated_bridge
    service.create_preset({
        "id": "restore_test",
        "name": "Restore Test",
        "html_content": "<div>v1</div>",
    })

    first = api_preset._save_html_with_revision(
        "restore_test",
        "<div>v2</div>",
        summary="v2",
        author="user",
        source="ui",
        expected_sha256=html_sha256("<div>v1</div>"),
    )
    api_preset._save_html_with_revision(
        "restore_test",
        "<div>v3</div>",
        summary="v3",
        author="user",
        source="ui",
        expected_sha256=html_sha256(service.get_html_content("restore_test")),
    )

    revision = overlay_revision_service.get_revision(
        "restore_test",
        first["revision"]["revision_id"],
    )
    result = api_preset._save_html_with_revision(
        "restore_test",
        revision["html_content"],
        summary="Restore v1",
        author="user",
        source="ui",
        expected_sha256=html_sha256(service.get_html_content("restore_test")),
    )

    assert result["success"] is True
    assert service.get_html_content("restore_test") == api_preset._ensure_local_tailwind_runtime("<div>v1</div>")


def test_versioned_html_write_materializes_builtin_before_snapshot(isolated_bridge):
    service, presets_dir, _ = isolated_bridge
    current_html = service.get_html_content("broadcast_preset")

    result = api_preset._save_html_with_revision(
        "broadcast_preset",
        "<div>Custom built-in</div>",
        summary="Customize built-in",
        author="codex",
        source="mcp",
        expected_sha256=html_sha256(current_html),
    )

    revision_dir = presets_dir / "broadcast_preset" / "revisions" / result["revision"]["revision_id"]
    assert (presets_dir / "broadcast_preset" / "preset.json").exists()
    assert (revision_dir / "preset.json").exists()
    assert (revision_dir / "overlay.html").read_text(encoding="utf-8") == current_html
    assert service.get_html_content("broadcast_preset") == api_preset._ensure_local_tailwind_runtime(
        "<div>Custom built-in</div>"
    )
