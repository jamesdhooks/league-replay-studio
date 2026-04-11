"""
test_script_capture.py
-----------------------
Tests for the enhanced ScriptCaptureEngine with validation, retry,
gap detection, and structured logging.
"""

import time
from unittest.mock import MagicMock, patch, PropertyMock

import pytest

# Import the module under test
import sys
import os

# Ensure the backend package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "backend"))

from server.utils.script_capture import (
    ScriptCaptureEngine,
    CaptureLogEntry,
    DEFAULT_CLIP_PADDING,
    DEFAULT_CLIP_PADDING_AFTER,
    MAX_SEEK_RETRIES,
    MAX_CAMERA_RETRIES,
    SEEK_TOLERANCE_MS,
    CONTIGUOUS_GAP_THRESHOLD,
    _sanitize_filename,
    _format_race_time,
)


# ── Fixtures ────────────────────────────────────────────────────────────────

def make_iracing_bridge(session_time=100.0, cam_group=5, cam_car_idx=3):
    """Create a mock IRacingBridge with configurable telemetry readback."""
    bridge = MagicMock()
    bridge.get_replay_session_num.return_value = 2
    bridge.replay_search_session_time.return_value = True
    bridge.set_replay_speed.return_value = True
    bridge.cam_switch_car.return_value = True
    bridge.cam_switch_position.return_value = True
    bridge.cameras = [
        {"group_name": "TV1", "group_num": 1},
        {"group_name": "Cockpit", "group_num": 2},
        {"group_name": "TV Scenic", "group_num": 5},
    ]
    bridge.capture_snapshot.return_value = {
        "session_time": session_time,
        "cam_group_num": cam_group,
        "cam_car_idx": cam_car_idx,
    }
    return bridge


def make_capture_engine():
    """Create a mock CaptureEngine."""
    engine = MagicMock()
    engine.is_running = True
    return engine


def make_script(segments=None):
    """Create a simple 3-segment test script."""
    if segments:
        return segments
    return [
        {
            "id": "seg_001",
            "section": "race",
            "type": "event",
            "event_type": "overtake",
            "start_time_seconds": 100.0,
            "end_time_seconds": 110.0,
            "camera_preferences": ["TV1"],
            "involved_drivers": [3],
            "driver_names": ["Driver A"],
        },
        {
            "id": "seg_002",
            "section": "race",
            "type": "event",
            "event_type": "battle",
            "start_time_seconds": 200.0,
            "end_time_seconds": 220.0,
            "camera_preferences": ["Cockpit"],
            "involved_drivers": [7],
            "driver_names": ["Driver B"],
        },
        {
            "id": "seg_003",
            "section": "race_results",
            "type": "section",
            "start_time_seconds": 500.0,
            "end_time_seconds": 520.0,
            "camera_preferences": ["TV Scenic"],
        },
    ]


# ── Tests ───────────────────────────────────────────────────────────────────

class TestCaptureLogEntry:
    """Tests for the CaptureLogEntry dataclass."""

    def test_basic_serialization(self):
        entry = CaptureLogEntry(
            timestamp=1000.1234,
            segment_id="seg_001",
            action="seek",
            detail="Seeking to 1:40",
            success=True,
        )
        d = entry.to_dict()
        assert d["timestamp"] == 1000.123
        assert d["segment_id"] == "seg_001"
        assert d["action"] == "seek"
        assert d["success"] is True
        assert "attempt" not in d  # attempt=1 is default, not included

    def test_failure_with_attempt(self):
        entry = CaptureLogEntry(
            timestamp=1000.0,
            segment_id="seg_002",
            action="validate",
            detail="Camera validation failed",
            success=False,
            attempt=3,
            expected={"group": 5},
            actual={"group": 2},
        )
        d = entry.to_dict()
        assert d["success"] is False
        assert d["attempt"] == 3
        assert d["expected"] == {"group": 5}
        assert d["actual"] == {"group": 2}


class TestHelpers:
    """Tests for helper functions."""

    def test_sanitize_filename_strips_special_chars(self):
        assert _sanitize_filename("hello world!@#$") == "hello_world____"

    def test_sanitize_filename_limits_length(self):
        long_name = "a" * 200
        result = _sanitize_filename(long_name)
        assert len(result) <= 64

    def test_sanitize_filename_empty(self):
        assert _sanitize_filename("") == "clip"
        assert _sanitize_filename(None) == "clip"

    def test_format_race_time(self):
        assert _format_race_time(0) == "0:00"
        assert _format_race_time(65) == "1:05"
        assert _format_race_time(3661) == "1:01:01"


class TestStrategyComputation:
    """Tests for gap detection / strategy computation."""

    def test_basic_strategy_computation(self):
        engine = ScriptCaptureEngine(output_dir="/tmp/test_clips")
        script = make_script()
        strategies = engine._compute_strategies(script)

        assert len(strategies) == 3

        # First segment: no previous, so not contiguous_with_prev
        assert strategies[0]["contiguous_with_prev"] is False
        assert strategies[0]["strategy"] == "new_recording"

        # seg_002 starts at 200, seg_001 ends at 110 => gap=90 => not contiguous
        assert strategies[1]["contiguous_with_prev"] is False
        assert strategies[1]["strategy"] == "new_recording"

    def test_contiguous_segments_detected(self):
        engine = ScriptCaptureEngine(
            output_dir="/tmp/test_clips",
            contiguous_gap_threshold=2.0,
        )
        # Two segments that are 0.5s apart
        segments = [
            {"id": "a", "start_time_seconds": 100, "end_time_seconds": 110},
            {"id": "b", "start_time_seconds": 110.5, "end_time_seconds": 120},
        ]
        strategies = engine._compute_strategies(segments)

        assert strategies[0]["contiguous_with_next"] is True
        assert strategies[1]["contiguous_with_prev"] is True
        assert strategies[1]["strategy"] == "continue"

    def test_gap_segments_separate(self):
        engine = ScriptCaptureEngine(
            output_dir="/tmp/test_clips",
            contiguous_gap_threshold=1.0,
        )
        # Two segments that are 50s apart
        segments = [
            {"id": "a", "start_time_seconds": 100, "end_time_seconds": 110},
            {"id": "b", "start_time_seconds": 160, "end_time_seconds": 170},
        ]
        strategies = engine._compute_strategies(segments)

        assert strategies[0]["contiguous_with_next"] is False
        assert strategies[1]["contiguous_with_prev"] is False
        assert strategies[1]["strategy"] == "new_recording"


class TestValidatedSeek:
    """Tests for seek validation with retry logic."""

    @patch("server.utils.script_capture.time.sleep")
    def test_seek_succeeds_on_first_try(self, mock_sleep):
        engine = ScriptCaptureEngine(output_dir="/tmp/test_clips")
        bridge = make_iracing_bridge(session_time=98.0)

        result = engine._validated_seek("seg_001", bridge, 98.0)

        assert result is True
        assert bridge.replay_search_session_time.call_count == 1
        # Check log entries
        log = engine.capture_log
        assert any(e["action"] == "seek" for e in log)
        assert any(e["action"] == "validate" and e["success"] for e in log)

    @patch("server.utils.script_capture.time.sleep")
    def test_seek_retries_on_drift(self, mock_sleep):
        engine = ScriptCaptureEngine(output_dir="/tmp/test_clips")
        bridge = make_iracing_bridge()

        # First snapshot returns wrong time, second is correct
        bridge.capture_snapshot.side_effect = [
            {"session_time": 50.0, "cam_group_num": 5, "cam_car_idx": 3},  # wrong
            {"session_time": 98.0, "cam_group_num": 5, "cam_car_idx": 3},  # correct
        ]

        result = engine._validated_seek("seg_001", bridge, 98.0)

        assert result is True
        assert bridge.replay_search_session_time.call_count == 2
        log = engine.capture_log
        retries = [e for e in log if e["action"] == "retry"]
        assert len(retries) >= 1

    @patch("server.utils.script_capture.time.sleep")
    def test_seek_fails_after_max_retries(self, mock_sleep):
        engine = ScriptCaptureEngine(output_dir="/tmp/test_clips")
        bridge = make_iracing_bridge(session_time=0.0)
        bridge.capture_snapshot.return_value = {"session_time": 0.0}

        result = engine._validated_seek("seg_001", bridge, 98.0)

        assert result is False
        assert bridge.replay_search_session_time.call_count == MAX_SEEK_RETRIES


class TestValidatedCameraSwitch:
    """Tests for camera switch validation with retry logic."""

    @patch("server.utils.script_capture.time.sleep")
    def test_camera_switch_succeeds(self, mock_sleep):
        engine = ScriptCaptureEngine(output_dir="/tmp/test_clips")
        bridge = make_iracing_bridge(cam_group=5, cam_car_idx=3)

        result = engine._validated_camera_switch("seg_001", bridge, 5, 3)

        assert result is True
        assert bridge.cam_switch_car.call_count == 1

    @patch("server.utils.script_capture.time.sleep")
    def test_camera_switch_retries_on_wrong_group(self, mock_sleep):
        engine = ScriptCaptureEngine(output_dir="/tmp/test_clips")
        bridge = make_iracing_bridge()

        # First returns wrong group, second is correct
        bridge.capture_snapshot.side_effect = [
            {"session_time": 100.0, "cam_group_num": 2, "cam_car_idx": 3},  # wrong
            {"session_time": 100.0, "cam_group_num": 5, "cam_car_idx": 3},  # correct
        ]

        result = engine._validated_camera_switch("seg_001", bridge, 5, 3)

        assert result is True
        assert bridge.cam_switch_car.call_count == 2

    @patch("server.utils.script_capture.time.sleep")
    def test_camera_switch_leader_position(self, mock_sleep):
        engine = ScriptCaptureEngine(output_dir="/tmp/test_clips")
        bridge = make_iracing_bridge(cam_group=1)

        result = engine._validated_camera_switch("seg_001", bridge, 1, None)

        assert result is True
        bridge.cam_switch_position.assert_called_once_with(0, 1)


class TestCaptureScript:
    """Integration tests for the full capture_script workflow."""

    @patch("server.utils.script_capture.time.sleep")
    def test_captures_all_segments(self, mock_sleep):
        engine = ScriptCaptureEngine(output_dir="/tmp/test_clips")
        bridge = make_iracing_bridge(session_time=98.0)
        capture_eng = make_capture_engine()

        clips = engine.capture_script(
            script=make_script(),
            iracing_bridge=bridge,
            capture_engine=capture_eng,
        )

        # Should capture 3 clips (all segments are non-contiguous)
        assert len(clips) == 3
        assert all(c["section"] in ("race", "race_results") for c in clips)
        assert all(c["path"].endswith(".mp4") for c in clips)

    @patch("server.utils.script_capture.time.sleep")
    def test_captures_contiguous_as_single_clip(self, mock_sleep):
        engine = ScriptCaptureEngine(
            output_dir="/tmp/test_clips",
            contiguous_gap_threshold=2.0,
        )
        bridge = make_iracing_bridge(session_time=98.0)
        capture_eng = make_capture_engine()

        # Two contiguous segments
        script = [
            {"id": "a", "section": "race", "type": "event",
             "start_time_seconds": 100, "end_time_seconds": 110,
             "camera_preferences": ["TV1"], "involved_drivers": [3]},
            {"id": "b", "section": "race", "type": "event",
             "start_time_seconds": 110.5, "end_time_seconds": 120,
             "camera_preferences": ["TV1"], "involved_drivers": [3]},
        ]

        clips = engine.capture_script(
            script=script,
            iracing_bridge=bridge,
            capture_engine=capture_eng,
        )

        # Should capture 1 clip covering both segments
        assert len(clips) == 1
        assert set(clips[0]["segments"]) == {"a", "b"}

    @patch("server.utils.script_capture.time.sleep")
    def test_skips_transitions_and_zero_duration(self, mock_sleep):
        engine = ScriptCaptureEngine(output_dir="/tmp/test_clips")
        bridge = make_iracing_bridge(session_time=98.0)
        capture_eng = make_capture_engine()

        script = [
            {"id": "trans", "type": "transition", "start_time_seconds": 10, "end_time_seconds": 11},
            {"id": "zero", "type": "event", "start_time_seconds": 20, "end_time_seconds": 20},
            {"id": "real", "section": "race", "type": "event",
             "start_time_seconds": 100, "end_time_seconds": 110,
             "camera_preferences": ["TV1"]},
        ]

        clips = engine.capture_script(
            script=script,
            iracing_bridge=bridge,
            capture_engine=capture_eng,
        )

        assert len(clips) == 1
        assert clips[0]["id"] == "real"

    @patch("server.utils.script_capture.time.sleep")
    def test_cancel_stops_capture(self, mock_sleep):
        engine = ScriptCaptureEngine(output_dir="/tmp/test_clips")
        bridge = make_iracing_bridge(session_time=98.0)
        capture_eng = make_capture_engine()

        # Cancel after first segment's recording starts
        original_start = capture_eng.start_recording
        call_count = [0]
        def start_and_cancel(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] >= 1:
                engine.cancel()
            return original_start(*args, **kwargs)

        capture_eng.start_recording = start_and_cancel

        clips = engine.capture_script(
            script=make_script(),
            iracing_bridge=bridge,
            capture_engine=capture_eng,
        )

        # Only 1 segment should have been captured before cancel
        assert len(clips) <= 2

    @patch("server.utils.script_capture.time.sleep")
    def test_structured_log_populated(self, mock_sleep):
        engine = ScriptCaptureEngine(output_dir="/tmp/test_clips")
        bridge = make_iracing_bridge(session_time=98.0)
        capture_eng = make_capture_engine()

        engine.capture_script(
            script=make_script()[:1],
            iracing_bridge=bridge,
            capture_engine=capture_eng,
        )

        log = engine.capture_log
        assert len(log) > 0
        actions = set(e["action"] for e in log)
        assert "seek" in actions
        assert "info" in actions

    @patch("server.utils.script_capture.time.sleep")
    def test_strategies_populated(self, mock_sleep):
        engine = ScriptCaptureEngine(output_dir="/tmp/test_clips")
        bridge = make_iracing_bridge(session_time=98.0)
        capture_eng = make_capture_engine()

        engine.capture_script(
            script=make_script(),
            iracing_bridge=bridge,
            capture_engine=capture_eng,
        )

        strats = engine.segment_strategies
        assert len(strats) == 3
        assert all("segment_id" in s for s in strats)
        assert all("strategy" in s for s in strats)

    @patch("server.utils.script_capture.time.sleep")
    def test_progress_callback_fired(self, mock_sleep):
        progress_events = []
        engine = ScriptCaptureEngine(
            output_dir="/tmp/test_clips",
            progress_callback=lambda d: progress_events.append(d),
        )
        bridge = make_iracing_bridge(session_time=98.0)
        capture_eng = make_capture_engine()

        engine.capture_script(
            script=make_script()[:1],
            iracing_bridge=bridge,
            capture_engine=capture_eng,
        )

        steps = [e.get("step") for e in progress_events]
        assert "strategy_computed" in steps
        assert "capturing" in steps
        assert "capture_complete" in steps


class TestClipNaming:
    """Tests for clip name generation."""

    def test_build_clip_name_basic(self):
        engine = ScriptCaptureEngine(output_dir="/tmp/test_clips")
        name = engine._build_clip_name(
            "seg_001", "race", "event",
            {"event_type": "overtake", "driver_names": ["Hamilton", "Verstappen"]},
            0,
        )
        assert "000" in name
        assert "race" in name
        assert "event" in name
        assert "overtake" in name
        assert "Hamilton" in name

    def test_build_clip_name_length_limit(self):
        engine = ScriptCaptureEngine(output_dir="/tmp/test_clips")
        name = engine._build_clip_name(
            "a" * 100, "race", "event",
            {"event_type": "x" * 100},
            999,
        )
        assert len(name) <= 64
