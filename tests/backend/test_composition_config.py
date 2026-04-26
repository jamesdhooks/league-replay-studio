"""
Tests for compose scope + gap policy — script_state_service composition config
helpers and composition API filtering logic.
"""

import os
import shutil
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "backend"))

from server.services.script_state_service import (
    ScriptStateService,
    CAPTURE_CAPTURED,
    CAPTURE_UNCAPTURED,
    COMPOSE_MODE_ALL,
    COMPOSE_MODE_CAPTURED,
    COMPOSE_MODE_SPECIFIC,
    COMPOSE_MODE_REGION,
    GAP_POLICY_COMPRESS,
    GAP_POLICY_FILL_BLACK,
    GAP_POLICY_FADE,
    VALID_COMPOSE_MODES,
    VALID_GAP_POLICIES,
    DEFAULT_COMPOSITION_CONFIG,
)


# ── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture
def project_dir():
    d = tempfile.mkdtemp(prefix="lrs_comptest_")
    yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def svc():
    return ScriptStateService()


@pytest.fixture
def script():
    """3 non-overlapping race segments."""
    return [
        {"id": "seg1", "type": "race", "section": "race", "start_time_seconds": 0.0, "end_time_seconds": 10.0},
        {"id": "seg2", "type": "race", "section": "race", "start_time_seconds": 20.0, "end_time_seconds": 30.0},
        {"id": "seg3", "type": "race", "section": "race", "start_time_seconds": 40.0, "end_time_seconds": 50.0},
    ]


@pytest.fixture
def manifest():
    return [
        {"id": "seg1", "path": "/clips/seg1.mp4"},
        {"id": "seg2", "path": "/clips/seg2.mp4"},
        {"id": "seg3", "path": "/clips/seg3.mp4"},
    ]


# ── Constants ─────────────────────────────────────────────────────────────────

def test_valid_compose_modes():
    assert COMPOSE_MODE_ALL in VALID_COMPOSE_MODES
    assert COMPOSE_MODE_CAPTURED in VALID_COMPOSE_MODES
    assert COMPOSE_MODE_SPECIFIC in VALID_COMPOSE_MODES
    assert COMPOSE_MODE_REGION in VALID_COMPOSE_MODES


def test_valid_gap_policies():
    assert GAP_POLICY_COMPRESS in VALID_GAP_POLICIES
    assert GAP_POLICY_FILL_BLACK in VALID_GAP_POLICIES
    assert GAP_POLICY_FADE in VALID_GAP_POLICIES


def test_default_composition_config_shape():
    assert DEFAULT_COMPOSITION_CONFIG["mode"] == COMPOSE_MODE_ALL
    assert DEFAULT_COMPOSITION_CONFIG["gap_policy"] == GAP_POLICY_COMPRESS
    assert isinstance(DEFAULT_COMPOSITION_CONFIG["selected_segment_ids"], list)


# ── Persistence helpers ───────────────────────────────────────────────────────

def test_get_composition_config_defaults(svc, project_dir):
    cfg = svc.get_composition_config(project_dir)
    assert cfg["mode"] == COMPOSE_MODE_ALL
    assert cfg["gap_policy"] == GAP_POLICY_COMPRESS
    assert cfg["selected_segment_ids"] == []
    assert cfg["region_start_seconds"] is None


def test_set_composition_config_roundtrip(svc, project_dir):
    saved = svc.set_composition_config(project_dir, {
        "mode": COMPOSE_MODE_SPECIFIC,
        "selected_segment_ids": ["seg1", "seg3"],
        "gap_policy": GAP_POLICY_FILL_BLACK,
    })
    assert saved["mode"] == COMPOSE_MODE_SPECIFIC
    assert saved["selected_segment_ids"] == ["seg1", "seg3"]
    assert saved["gap_policy"] == GAP_POLICY_FILL_BLACK

    loaded = svc.get_composition_config(project_dir)
    assert loaded == saved


def test_set_composition_config_partial_update(svc, project_dir):
    svc.set_composition_config(project_dir, {"mode": COMPOSE_MODE_REGION, "region_start_seconds": 5.0})
    svc.set_composition_config(project_dir, {"gap_policy": GAP_POLICY_FADE})
    cfg = svc.get_composition_config(project_dir)
    assert cfg["mode"] == COMPOSE_MODE_REGION
    assert cfg["region_start_seconds"] == 5.0
    assert cfg["gap_policy"] == GAP_POLICY_FADE


def test_invalid_mode_falls_back_to_all(svc, project_dir):
    cfg = svc._normalize_composition_config({"mode": "bogus"})
    assert cfg["mode"] == COMPOSE_MODE_ALL


def test_invalid_gap_policy_falls_back_to_compress(svc, project_dir):
    cfg = svc._normalize_composition_config({"gap_policy": "explode"})
    assert cfg["gap_policy"] == GAP_POLICY_COMPRESS


def test_selected_ids_normalised(svc, project_dir):
    cfg = svc._normalize_composition_config({"selected_segment_ids": [" seg1 ", "seg2", ""]})
    assert cfg["selected_segment_ids"] == ["seg1", "seg2"]


# ── Filter: all ───────────────────────────────────────────────────────────────

def test_filter_mode_all(svc, project_dir, script, manifest):
    svc.lock_script(project_dir, script)
    fscript, fmanifest = svc.filter_manifest_by_composition_config(
        project_dir, script, manifest, {"mode": COMPOSE_MODE_ALL, "selected_segment_ids": [], "gap_policy": GAP_POLICY_COMPRESS}
    )
    assert len(fscript) == 3
    assert len(fmanifest) == 3


# ── Filter: captured_only ─────────────────────────────────────────────────────

def test_filter_mode_captured_only(svc, project_dir, script, manifest):
    svc.lock_script(project_dir, script)
    # Mark seg1 and seg3 as captured
    svc.mark_captured(project_dir, "seg1", "/clips/seg1.mp4")
    svc.mark_captured(project_dir, "seg3", "/clips/seg3.mp4")

    fscript, fmanifest = svc.filter_manifest_by_composition_config(
        project_dir, script, manifest,
        {"mode": COMPOSE_MODE_CAPTURED, "selected_segment_ids": [], "gap_policy": GAP_POLICY_COMPRESS}
    )
    ids = [s["id"] for s in fscript]
    manifest_ids = [c["id"] for c in fmanifest]
    assert "seg1" in ids
    assert "seg3" in ids
    assert "seg2" not in ids
    assert set(manifest_ids) == {"seg1", "seg3"}


# ── Filter: specific_segments ─────────────────────────────────────────────────

def test_filter_mode_specific(svc, project_dir, script, manifest):
    svc.lock_script(project_dir, script)
    fscript, fmanifest = svc.filter_manifest_by_composition_config(
        project_dir, script, manifest,
        {"mode": COMPOSE_MODE_SPECIFIC, "selected_segment_ids": ["seg2"], "gap_policy": GAP_POLICY_COMPRESS}
    )
    assert len(fscript) == 1
    assert fscript[0]["id"] == "seg2"
    assert fmanifest[0]["id"] == "seg2"


def test_filter_mode_specific_empty_selection(svc, project_dir, script, manifest):
    svc.lock_script(project_dir, script)
    fscript, fmanifest = svc.filter_manifest_by_composition_config(
        project_dir, script, manifest,
        {"mode": COMPOSE_MODE_SPECIFIC, "selected_segment_ids": [], "gap_policy": GAP_POLICY_COMPRESS}
    )
    assert len(fscript) == 0
    assert len(fmanifest) == 0


# ── Filter: region ────────────────────────────────────────────────────────────

def test_filter_mode_region_overlap(svc, project_dir, script, manifest):
    """Segments that overlap [5, 25] → seg1 (0–10) and seg2 (20–30)."""
    svc.lock_script(project_dir, script)
    fscript, fmanifest = svc.filter_manifest_by_composition_config(
        project_dir, script, manifest,
        {
            "mode": COMPOSE_MODE_REGION,
            "selected_segment_ids": [],
            "region_start_seconds": 5.0,
            "region_end_seconds": 25.0,
            "gap_policy": GAP_POLICY_COMPRESS,
        }
    )
    ids = [s["id"] for s in fscript]
    assert "seg1" in ids
    assert "seg2" in ids
    assert "seg3" not in ids


def test_filter_mode_region_no_overlap(svc, project_dir, script, manifest):
    svc.lock_script(project_dir, script)
    fscript, fmanifest = svc.filter_manifest_by_composition_config(
        project_dir, script, manifest,
        {"mode": COMPOSE_MODE_REGION, "selected_segment_ids": [], "region_start_seconds": 100.0, "region_end_seconds": 200.0, "gap_policy": GAP_POLICY_COMPRESS}
    )
    assert len(fscript) == 0
    assert len(fmanifest) == 0


# ── Filter: transition entries are preserved ──────────────────────────────────

def test_transition_entries_preserved(svc, project_dir, manifest):
    mixed_script = [
        {"id": "seg1", "type": "race", "section": "race", "start_time_seconds": 0.0, "end_time_seconds": 10.0},
        {"type": "transition", "duration": 1.5},
        {"id": "seg2", "type": "race", "section": "race", "start_time_seconds": 20.0, "end_time_seconds": 30.0},
    ]
    svc.lock_script(project_dir, [s for s in mixed_script if s.get("id")])
    fscript, _ = svc.filter_manifest_by_composition_config(
        project_dir, mixed_script, manifest,
        {"mode": COMPOSE_MODE_ALL, "selected_segment_ids": [], "gap_policy": GAP_POLICY_COMPRESS}
    )
    types = [s.get("type") for s in fscript]
    assert "transition" in types
