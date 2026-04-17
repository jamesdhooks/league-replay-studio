"""Integration tests for per-segment overlay_preset_id assignment persistence.

Covers the path: PATCH /projects/{id} with a script payload containing
overlay_preset_id on individual segments → stored in project.json (not the
projects.db column) via the project_service allowed_meta split.
"""

from pathlib import Path
import os
import sys
import json

import pytest

# Ensure the backend package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "backend"))

import server.services.db as db_module
import server.services.project_service as project_module


@pytest.fixture
def isolated_project_env(tmp_path, monkeypatch):
    """Redirect DB and project directories to isolated temp paths."""
    db_path = tmp_path / "projects.db"
    projects_dir = tmp_path / "projects"
    projects_dir.mkdir()

    monkeypatch.setattr(db_module, "DB_PATH", db_path)
    monkeypatch.setattr(project_module, "PROJECTS_DIR", projects_dir)
    monkeypatch.setattr(project_module, "DATA_DIR", tmp_path)

    # Re-initialise the DB schema against the temp path
    db_module.init_db()

    return {"tmp_path": tmp_path, "projects_dir": projects_dir}


def _make_script(overrides=None):
    """Return a minimal two-segment script for test purposes."""
    overrides = overrides or {}
    return [
        {
            "id": "seg_intro",
            "type": "intro",
            "section": "intro",
            "start_time_seconds": 0,
            "end_time_seconds": 10,
            **overrides.get("seg_intro", {}),
        },
        {
            "id": "seg_race_1",
            "type": "battle",
            "event_type": "battle",
            "section": "race",
            "start_time_seconds": 100,
            "end_time_seconds": 115,
            **overrides.get("seg_race_1", {}),
        },
    ]


def test_script_with_overlay_preset_id_written_to_project_json(isolated_project_env):
    """overlay_preset_id on script segments persists to project.json only (not DB columns)."""
    svc = project_module.ProjectService()
    project = svc.create_project(
        name="Script Assignment Test",
        track_name="Silverstone",
    )
    project_id = project["id"]

    script = _make_script({"seg_race_1": {"overlay_preset_id": "broadcast_preset"}})
    result = svc.update_project(project_id, {"script": script})

    assert result is not None, "update_project must return the updated project"

    # Verify the script was persisted to project.json
    project_dir = Path(result["project_dir"])
    meta_path = project_dir / "project.json"
    assert meta_path.exists(), "project.json must exist after update"

    meta = json.loads(meta_path.read_text())
    assert "script" in meta, "script key must appear in project.json"

    saved_script = meta["script"]
    race_seg = next((s for s in saved_script if s["id"] == "seg_race_1"), None)
    assert race_seg is not None
    assert race_seg["overlay_preset_id"] == "broadcast_preset"


def test_overlay_preset_id_not_stored_in_db_column(isolated_project_env):
    """overlay_preset_id must NOT be written as a DB column (SQL injection guard)."""
    svc = project_module.ProjectService()
    project = svc.create_project(name="DB Column Safety Test")
    project_id = project["id"]

    # Attempting to inject overlay_preset_id directly into updates should be silently
    # ignored for the DB path (it is in allowed_meta, not allowed_db).
    script = _make_script({"seg_race_1": {"overlay_preset_id": "minimal_preset"}})
    svc.update_project(project_id, {"script": script, "overlay_preset_id": "should_be_ignored"})

    # Confirm the DB row has no 'overlay_preset_id' column (schema-level check)
    conn = db_module.get_connection()
    try:
        columns = [row[1] for row in conn.execute("PRAGMA table_info(projects)").fetchall()]
    finally:
        conn.close()

    assert "overlay_preset_id" not in columns, (
        "overlay_preset_id must never be written as a DB column"
    )


def test_multiple_segments_each_with_different_design_preserved(isolated_project_env):
    """Multiple segments with distinct overlay_preset_id values all survive a round-trip."""
    svc = project_module.ProjectService()
    project = svc.create_project(name="Multi-Segment Design Test")
    project_id = project["id"]

    script = [
        {
            "id": "seg_a",
            "type": "battle",
            "section": "race",
            "start_time_seconds": 0,
            "end_time_seconds": 10,
            "overlay_preset_id": "broadcast_preset",
        },
        {
            "id": "seg_b",
            "type": "battle",
            "section": "race",
            "start_time_seconds": 20,
            "end_time_seconds": 30,
            "overlay_preset_id": "minimal_preset",
        },
        {
            "id": "seg_c",
            "type": "battle",
            "section": "race",
            "start_time_seconds": 40,
            "end_time_seconds": 50,
            # No overlay_preset_id — inherits global default
        },
    ]

    result = svc.update_project(project_id, {"script": script})
    assert result is not None

    project_dir = Path(result["project_dir"])
    meta = json.loads((project_dir / "project.json").read_text())
    saved = {s["id"]: s for s in meta["script"]}

    assert saved["seg_a"]["overlay_preset_id"] == "broadcast_preset"
    assert saved["seg_b"]["overlay_preset_id"] == "minimal_preset"
    assert "overlay_preset_id" not in saved["seg_c"], (
        "Segment with no design override must not have overlay_preset_id in script"
    )


def test_segment_design_cleared_on_next_update(isolated_project_env):
    """Saving a script segment without overlay_preset_id clears a previous override."""
    svc = project_module.ProjectService()
    project = svc.create_project(name="Clear Override Test")
    project_id = project["id"]

    # First write: seg has an override
    script_with_override = [
        {
            "id": "seg_x",
            "type": "battle",
            "section": "race",
            "start_time_seconds": 0,
            "end_time_seconds": 10,
            "overlay_preset_id": "broadcast_preset",
        }
    ]
    svc.update_project(project_id, {"script": script_with_override})

    # Second write: same segment without overlay_preset_id (user cleared it)
    script_cleared = [
        {
            "id": "seg_x",
            "type": "battle",
            "section": "race",
            "start_time_seconds": 0,
            "end_time_seconds": 10,
        }
    ]
    result = svc.update_project(project_id, {"script": script_cleared})
    assert result is not None

    project_dir = Path(result["project_dir"])
    meta = json.loads((project_dir / "project.json").read_text())
    saved_seg = next(s for s in meta["script"] if s["id"] == "seg_x")
    assert "overlay_preset_id" not in saved_seg, (
        "overlay_preset_id must be absent after clearing the design override"
    )
