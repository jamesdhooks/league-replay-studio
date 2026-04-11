"""
Tests for script_state_service — script lock, segment hashing, capture state,
trash bin, capture range filtering, and PiP configuration.
"""

import json
import os
import shutil
import sys
import tempfile

import pytest

# Ensure the backend package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "backend"))

from server.services.script_state_service import (
    ScriptStateService,
    _segment_hash,
    CAPTURE_UNCAPTURED,
    CAPTURE_CAPTURED,
    CAPTURE_INVALIDATED,
    CAPTURE_CAPTURING,
    MODE_ALL,
    MODE_UNCAPTURED,
    MODE_SPECIFIC,
    MODE_TIME_RANGE,
)


@pytest.fixture
def project_dir():
    """Create a temporary project directory."""
    d = tempfile.mkdtemp(prefix="lrs_test_")
    clips_dir = os.path.join(d, "clips")
    os.makedirs(clips_dir)
    yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def svc():
    return ScriptStateService()


@pytest.fixture
def sample_script():
    """A minimal video script with 3 segments."""
    return [
        {
            "id": "seg_1",
            "type": "event",
            "section": "race",
            "start_time_seconds": 10.0,
            "end_time_seconds": 25.0,
            "driver_name": "Max",
            "camera_group": "TV1",
            "event_type": "overtake",
        },
        {
            "id": "seg_2",
            "type": "event",
            "section": "race",
            "start_time_seconds": 30.0,
            "end_time_seconds": 45.0,
            "driver_name": "Lewis",
            "camera_group": "TV2",
            "event_type": "battle",
        },
        {
            "id": "seg_3",
            "type": "transition",
            "section": "race",
            "start_time_seconds": 25.0,
            "end_time_seconds": 30.0,
        },
        {
            "id": "seg_4",
            "type": "pip",
            "section": "race",
            "start_time_seconds": 50.0,
            "end_time_seconds": 65.0,
            "driver_name": "Charles",
            "camera_group": "TV3",
            "event_type": "incident",
            "pip": {"primaryEventId": 1, "secondaryEventId": 2},
        },
    ]


# ── Hash Tests ───────────────────────────────────────────────────────────────

class TestSegmentHash:
    def test_deterministic(self, sample_script):
        """Same segment data produces the same hash."""
        h1 = _segment_hash(sample_script[0])
        h2 = _segment_hash(sample_script[0])
        assert h1 == h2

    def test_different_time_different_hash(self, sample_script):
        """Changing time range changes the hash."""
        seg = dict(sample_script[0])
        h1 = _segment_hash(seg)
        seg["start_time_seconds"] = 11.0
        h2 = _segment_hash(seg)
        assert h1 != h2

    def test_different_driver_different_hash(self, sample_script):
        """Changing driver changes the hash."""
        seg = dict(sample_script[0])
        h1 = _segment_hash(seg)
        seg["driver_name"] = "Carlos"
        h2 = _segment_hash(seg)
        assert h1 != h2

    def test_different_camera_different_hash(self, sample_script):
        """Changing camera changes the hash."""
        seg = dict(sample_script[0])
        h1 = _segment_hash(seg)
        seg["camera_group"] = "Chase"
        h2 = _segment_hash(seg)
        assert h1 != h2

    def test_hash_length(self, sample_script):
        """Hash is 12 hex characters."""
        h = _segment_hash(sample_script[0])
        assert len(h) == 12
        assert all(c in "0123456789abcdef" for c in h)


# ── Lock / Unlock Tests ─────────────────────────────────────────────────────

class TestScriptLock:
    def test_lock_creates_state(self, svc, project_dir, sample_script):
        state = svc.lock_script(project_dir, sample_script)
        assert state["script_locked"] is True
        # Transitions are excluded
        assert "seg_3" not in state["segments"]
        # Non-transitions included (including pip)
        assert "seg_1" in state["segments"]
        assert "seg_2" in state["segments"]
        assert "seg_4" in state["segments"]
        assert state["segments"]["seg_1"]["capture_state"] == CAPTURE_UNCAPTURED
        assert state["segments"]["seg_4"]["is_pip"] is True

    def test_unlock(self, svc, project_dir, sample_script):
        svc.lock_script(project_dir, sample_script)
        state = svc.unlock_script(project_dir)
        assert state["script_locked"] is False

    def test_is_locked(self, svc, project_dir, sample_script):
        assert svc.is_locked(project_dir) is False
        svc.lock_script(project_dir, sample_script)
        assert svc.is_locked(project_dir) is True
        svc.unlock_script(project_dir)
        assert svc.is_locked(project_dir) is False

    def test_lock_persists_to_disk(self, svc, project_dir, sample_script):
        svc.lock_script(project_dir, sample_script)
        state_path = os.path.join(project_dir, "capture_state.json")
        assert os.path.exists(state_path)
        data = json.loads(open(state_path).read())
        assert data["script_locked"] is True


# ── Capture State Tracking ───────────────────────────────────────────────────

class TestCaptureState:
    def test_mark_captured(self, svc, project_dir, sample_script):
        svc.lock_script(project_dir, sample_script)
        svc.mark_captured(project_dir, "seg_1", "/clips/seg_1.mp4")
        states = svc.get_segment_states(project_dir)
        assert states["seg_1"]["capture_state"] == CAPTURE_CAPTURED
        assert states["seg_1"]["clip_path"] == "/clips/seg_1.mp4"

    def test_mark_capturing(self, svc, project_dir, sample_script):
        svc.lock_script(project_dir, sample_script)
        svc.mark_capturing(project_dir, "seg_1")
        states = svc.get_segment_states(project_dir)
        assert states["seg_1"]["capture_state"] == CAPTURE_CAPTURING

    def test_mark_uncaptured(self, svc, project_dir, sample_script):
        svc.lock_script(project_dir, sample_script)
        svc.mark_captured(project_dir, "seg_1", "/clips/seg_1.mp4")
        # Create a dummy file for the clip
        clip_path = os.path.join(project_dir, "clips", "seg_1.mp4")
        open(clip_path, "w").close()
        svc.mark_uncaptured(project_dir, "seg_1")
        states = svc.get_segment_states(project_dir)
        assert states["seg_1"]["capture_state"] == CAPTURE_UNCAPTURED
        assert states["seg_1"]["clip_path"] is None

    def test_capture_summary(self, svc, project_dir, sample_script):
        svc.lock_script(project_dir, sample_script)
        summary = svc.get_capture_summary(project_dir)
        assert summary["total"] == 3  # 3 non-transition segments
        assert summary["uncaptured"] == 3
        assert summary["captured"] == 0
        assert summary["complete"] is False

        svc.mark_captured(project_dir, "seg_1", "/clips/seg_1.mp4")
        svc.mark_captured(project_dir, "seg_2", "/clips/seg_2.mp4")
        svc.mark_captured(project_dir, "seg_4", "/clips/seg_4.mp4")
        summary = svc.get_capture_summary(project_dir)
        assert summary["captured"] == 3
        assert summary["complete"] is True


# ── Hash Comparison (Regeneration) ───────────────────────────────────────────

class TestCompareAndUpdate:
    def test_no_changes_retains_all(self, svc, project_dir, sample_script):
        svc.lock_script(project_dir, sample_script)
        svc.mark_captured(project_dir, "seg_1", "/clips/seg_1.mp4")
        svc.mark_captured(project_dir, "seg_2", "/clips/seg_2.mp4")

        # Re-compare with the same script
        result = svc.compare_and_update(project_dir, sample_script)
        assert result["retained"] == 2
        assert result["invalidated"] == 0
        # seg_4 was uncaptured, so it stays new
        assert result["new"] == 1

    def test_changed_segment_invalidated(self, svc, project_dir, sample_script):
        svc.lock_script(project_dir, sample_script)
        # Create dummy clip file
        clip_path = os.path.join(project_dir, "clips", "seg_1.mp4")
        open(clip_path, "w").close()
        svc.mark_captured(project_dir, "seg_1", clip_path)

        # Modify seg_1's driver
        modified_script = [dict(s) for s in sample_script]
        modified_script[0]["driver_name"] = "Lando"

        result = svc.compare_and_update(project_dir, modified_script)
        assert result["invalidated"] == 1
        assert result["retained"] == 0
        # Check clip moved to trash
        state = svc.load_state(project_dir)
        assert len(state["trash"]) == 1
        assert state["trash"][0]["segment_id"] == "seg_1"
        assert state["trash"][0]["reason"] == "script_changed"

    def test_removed_segment_trashed(self, svc, project_dir, sample_script):
        svc.lock_script(project_dir, sample_script)
        clip_path = os.path.join(project_dir, "clips", "seg_2.mp4")
        open(clip_path, "w").close()
        svc.mark_captured(project_dir, "seg_2", clip_path)

        # Remove seg_2 from script
        short_script = [s for s in sample_script if s["id"] != "seg_2"]
        result = svc.compare_and_update(project_dir, short_script)
        assert result["invalidated"] == 1


# ── Capture Range / Filtering ────────────────────────────────────────────────

class TestCaptureRange:
    def test_set_and_clear_range(self, svc, project_dir):
        state = svc.set_capture_range(project_dir, 10.0, 50.0)
        assert state["capture_range"] == {"start": 10.0, "end": 50.0}

        state = svc.set_capture_range(project_dir, None, None)
        assert state["capture_range"] is None

    def test_filter_all(self, svc, project_dir, sample_script):
        svc.lock_script(project_dir, sample_script)
        result = svc.filter_segments_by_mode(project_dir, sample_script, MODE_ALL)
        # Excludes transitions
        assert len(result) == 3

    def test_filter_uncaptured(self, svc, project_dir, sample_script):
        svc.lock_script(project_dir, sample_script)
        svc.mark_captured(project_dir, "seg_1", "/clips/seg_1.mp4")
        result = svc.filter_segments_by_mode(project_dir, sample_script, MODE_UNCAPTURED)
        ids = [s["id"] for s in result]
        assert "seg_1" not in ids
        assert "seg_2" in ids
        assert "seg_4" in ids

    def test_filter_specific(self, svc, project_dir, sample_script):
        svc.lock_script(project_dir, sample_script)
        result = svc.filter_segments_by_mode(
            project_dir, sample_script, MODE_SPECIFIC, segment_ids=["seg_2"]
        )
        assert len(result) == 1
        assert result[0]["id"] == "seg_2"

    def test_filter_time_range(self, svc, project_dir, sample_script):
        svc.lock_script(project_dir, sample_script)
        result = svc.filter_segments_by_mode(
            project_dir, sample_script, MODE_TIME_RANGE,
            time_range={"start": 20.0, "end": 55.0}
        )
        # seg_1 (10-25) overlaps, seg_2 (30-45) inside, seg_4 (50-65) overlaps
        ids = [s["id"] for s in result]
        assert "seg_1" in ids
        assert "seg_2" in ids
        assert "seg_4" in ids


# ── Trash Bin ────────────────────────────────────────────────────────────────

class TestTrashBin:
    def test_empty_trash(self, svc, project_dir, sample_script):
        svc.lock_script(project_dir, sample_script)
        # Create and trash a clip
        clip_path = os.path.join(project_dir, "clips", "seg_1.mp4")
        open(clip_path, "w").close()
        svc.mark_captured(project_dir, "seg_1", clip_path)
        svc.invalidate_segment(project_dir, "seg_1", "test")

        trash = svc.get_trash(project_dir)
        assert len(trash) == 1

        deleted = svc.empty_trash(project_dir)
        assert deleted == 1
        assert svc.get_trash(project_dir) == []

    def test_restore_from_trash(self, svc, project_dir, sample_script):
        svc.lock_script(project_dir, sample_script)
        clip_path = os.path.join(project_dir, "clips", "seg_1.mp4")
        open(clip_path, "w").close()
        svc.mark_captured(project_dir, "seg_1", clip_path)
        svc.invalidate_segment(project_dir, "seg_1", "test")

        # Clip should be in trash dir
        assert not os.path.exists(clip_path)

        # Restore
        success = svc.restore_from_trash(project_dir, "seg_1")
        assert success is True
        assert os.path.exists(clip_path)

        states = svc.get_segment_states(project_dir)
        assert states["seg_1"]["capture_state"] == CAPTURE_CAPTURED


# ── PiP Configuration ───────────────────────────────────────────────────────

class TestPipConfig:
    def test_default_config(self, svc, project_dir):
        config = svc.get_pip_config(project_dir)
        assert config["position"] == "bottom-right"
        assert config["scale"] == 0.3
        assert config["show_live_badge"] is True

    def test_update_config(self, svc, project_dir):
        config = svc.update_pip_config(project_dir, {
            "position": "top-left",
            "scale": 0.4,
            "show_live_badge": False,
        })
        assert config["position"] == "top-left"
        assert config["scale"] == 0.4
        assert config["show_live_badge"] is False

        # Verify persistence
        config2 = svc.get_pip_config(project_dir)
        assert config2["position"] == "top-left"

    def test_unknown_keys_ignored(self, svc, project_dir):
        config = svc.update_pip_config(project_dir, {
            "position": "top-right",
            "unknown_key": "should_be_ignored",
        })
        assert config["position"] == "top-right"
        assert "unknown_key" not in config


# ── Lock Preserves Captured on Re-lock ───────────────────────────────────────

class TestRelockPreserves:
    def test_relock_preserves_captured_if_hash_matches(self, svc, project_dir, sample_script):
        """Re-locking with the same script preserves captured clips."""
        svc.lock_script(project_dir, sample_script)
        svc.mark_captured(project_dir, "seg_1", "/clips/seg_1.mp4")

        # Re-lock with same script
        state = svc.lock_script(project_dir, sample_script)
        assert state["segments"]["seg_1"]["capture_state"] == CAPTURE_CAPTURED
        assert state["segments"]["seg_1"]["clip_path"] == "/clips/seg_1.mp4"

    def test_relock_resets_if_hash_changes(self, svc, project_dir, sample_script):
        """Re-locking with changed script resets capture state."""
        svc.lock_script(project_dir, sample_script)
        svc.mark_captured(project_dir, "seg_1", "/clips/seg_1.mp4")

        modified = [dict(s) for s in sample_script]
        modified[0]["driver_name"] = "Lando"
        state = svc.lock_script(project_dir, modified)
        assert state["segments"]["seg_1"]["capture_state"] == CAPTURE_UNCAPTURED
