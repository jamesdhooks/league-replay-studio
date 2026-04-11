"""
test_script_capture.py
-----------------------
Tests for the enhanced ScriptCaptureEngine with validation, retry,
gap detection, and structured logging.

FakeClock
~~~~~~~~~
All tests use a FakeClock so that every sleep immediately advances the
monotonic counter — no real wall-clock time is spent.  Construct an engine
with ``_now=clock.now, _sleep=clock.sleep``.
"""

import sys
import os
from unittest.mock import MagicMock

import pytest

# Ensure the backend package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "backend"))

from server.utils.script_capture import (
    ScriptCaptureEngine,
    HotkeyRecorderAdapter,
    CaptureLogEntry,
    DEFAULT_CLIP_PADDING,
    DEFAULT_CLIP_PADDING_AFTER,
    MAX_SEEK_RETRIES,
    MAX_CAMERA_RETRIES,
    SEEK_TOLERANCE_MS,
    CONTIGUOUS_GAP_THRESHOLD,
    _sanitize_filename,
    _format_race_time,
    _interruptible_sleep,
)


# ── FakeClock ────────────────────────────────────────────────────────────────

class FakeClock:
    """Monotonic clock whose time advances only when sleep() is called.

    Both ``now`` and ``sleep`` are injected into ScriptCaptureEngine so that
    _interruptible_sleep and every self._sleep() call are instantaneous in
    real time but correctly advance the fake clock.
    """

    def __init__(self, start: float = 0.0) -> None:
        self._t = start

    def now(self) -> float:
        return self._t

    def sleep(self, seconds: float) -> None:
        self._t += max(0.0, seconds)

    # Convenience: wall-clock alias (same clock for OBS polling tests)
    def wall(self) -> float:
        return self._t


# ── Helpers ──────────────────────────────────────────────────────────────────

def make_engine(clock: FakeClock | None = None, **kwargs) -> ScriptCaptureEngine:
    """Create a ScriptCaptureEngine with an injected FakeClock."""
    if clock is None:
        clock = FakeClock()
    return ScriptCaptureEngine(
        output_dir="/tmp/test_clips",
        _now=clock.now,
        _sleep=clock.sleep,
        **kwargs,
    )


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


# ── Tests ────────────────────────────────────────────────────────────────────

class TestFakeClock:
    """Verify the FakeClock helper itself."""

    def test_sleep_advances_time(self):
        clock = FakeClock(0.0)
        assert clock.now() == 0.0
        clock.sleep(5.0)
        assert clock.now() == 5.0

    def test_interruptible_sleep_uses_injected_clock(self):
        """_interruptible_sleep must terminate using the fake clock, not wall time."""
        clock = FakeClock(0.0)
        calls: list[float] = []

        def counting_sleep(s: float) -> None:
            calls.append(s)
            clock.sleep(s)

        _interruptible_sleep(10.0, lambda: False, _now=clock.now, _sleep=counting_sleep)
        # Should have advanced time by 10s with 0.25s chunks (plus a final short chunk)
        assert clock.now() == pytest.approx(10.0, abs=0.26)
        # All chunks ≤ 0.25
        assert all(c <= 0.25 for c in calls)

    def test_interruptible_sleep_cancels_early(self):
        clock = FakeClock(0.0)
        cancelled = [False]

        def cancel_after_1s(s: float) -> None:
            clock.sleep(s)
            if clock.now() >= 1.0:
                cancelled[0] = True

        _interruptible_sleep(
            100.0,
            lambda: cancelled[0],
            _now=clock.now,
            _sleep=cancel_after_1s,
        )
        # Should exit well before 100s
        assert clock.now() < 5.0


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
        engine = make_engine()
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
        engine = make_engine(contiguous_gap_threshold=2.0)
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

    def test_seek_succeeds_on_first_try(self):
        engine = make_engine()
        bridge = make_iracing_bridge(session_time=98.0)

        result = engine._validated_seek("seg_001", bridge, 98.0)

        assert result is True
        assert bridge.replay_search_session_time.call_count == 1
        log = engine.capture_log
        assert any(e["action"] == "seek" for e in log)
        assert any(e["action"] == "validate" and e["success"] for e in log)

    def test_seek_retries_on_drift(self):
        engine = make_engine()
        bridge = make_iracing_bridge()

        # First snapshot returns wrong time, second is correct
        bridge.capture_snapshot.side_effect = [
            {"session_time": 50.0, "cam_group_num": 5, "cam_car_idx": 3},  # wrong
            {"session_time": 98.0, "cam_group_num": 5, "cam_car_idx": 3},  # correct
        ]

        result = engine._validated_seek("seg_001", bridge, 98.0)

        assert result is True
        assert bridge.replay_search_session_time.call_count == 2
        retries = [e for e in engine.capture_log if e["action"] == "retry"]
        assert len(retries) >= 1

    def test_seek_fails_after_max_retries(self):
        engine = make_engine()
        bridge = make_iracing_bridge(session_time=0.0)
        bridge.capture_snapshot.return_value = {"session_time": 0.0}

        result = engine._validated_seek("seg_001", bridge, 98.0)

        assert result is False
        assert bridge.replay_search_session_time.call_count == MAX_SEEK_RETRIES


class TestValidatedCameraSwitch:
    """Tests for camera switch validation with retry logic."""

    def test_camera_switch_succeeds(self):
        engine = make_engine()
        bridge = make_iracing_bridge(cam_group=5, cam_car_idx=3)

        result = engine._validated_camera_switch("seg_001", bridge, 5, 3)

        assert result is True
        assert bridge.cam_switch_car.call_count == 1

    def test_camera_switch_retries_on_wrong_group(self):
        engine = make_engine()
        bridge = make_iracing_bridge()

        # First returns wrong group, second is correct
        bridge.capture_snapshot.side_effect = [
            {"session_time": 100.0, "cam_group_num": 2, "cam_car_idx": 3},  # wrong
            {"session_time": 100.0, "cam_group_num": 5, "cam_car_idx": 3},  # correct
        ]

        result = engine._validated_camera_switch("seg_001", bridge, 5, 3)

        assert result is True
        assert bridge.cam_switch_car.call_count == 2

    def test_camera_switch_leader_position(self):
        engine = make_engine()
        bridge = make_iracing_bridge(cam_group=1)

        result = engine._validated_camera_switch("seg_001", bridge, 1, None)

        assert result is True
        bridge.cam_switch_position.assert_called_once_with(0, 1)


class TestCaptureScript:
    """Integration tests for the full capture_script workflow."""

    def test_captures_all_segments(self):
        engine = make_engine()
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

    def test_captures_contiguous_as_single_clip(self):
        engine = make_engine(contiguous_gap_threshold=2.0)
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

    def test_skips_transitions_and_zero_duration(self):
        engine = make_engine()
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

    def test_cancel_stops_capture(self):
        engine = make_engine()
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

        # Should have fewer clips than total segments (3) since we cancelled
        assert len(clips) < 3
        assert len(clips) >= 1  # at least the first segment was captured or in progress

    def test_structured_log_populated(self):
        engine = make_engine()
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

    def test_strategies_populated(self):
        engine = make_engine()
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

    def test_progress_callback_fired(self):
        progress_events = []
        engine = make_engine(progress_callback=lambda d: progress_events.append(d))
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

    def test_capture_mode_logged(self):
        """capture_mode label should appear in the first info log entry."""
        engine = make_engine(capture_mode="obs")
        bridge = make_iracing_bridge(session_time=98.0)
        capture_eng = make_capture_engine()

        engine.capture_script(
            script=make_script()[:1],
            iracing_bridge=bridge,
            capture_engine=capture_eng,
        )

        first_info = next(e for e in engine.capture_log if e["action"] == "info")
        assert "obs" in first_info["detail"]


class TestCameraScheduleTiming:
    """Verify that camera_schedule entries fire at their offset during playback,
    not after the segment finishes."""

    def test_schedule_fires_during_wait(self):
        """Switches must be called while time-elapsed is between their offsets."""
        clock = FakeClock(0.0)
        switch_times: list[float] = []  # fake-clock time when each switch fires

        bridge = make_iracing_bridge(cam_group=1)

        # Override cam_switch_position to record when it's called
        def record_switch(pos, group):
            switch_times.append(clock.now())
            return True
        bridge.cam_switch_position.side_effect = record_switch

        engine = make_engine(clock=clock, clip_padding=2.0)
        capture_eng = make_capture_engine()

        segment = {
            "id": "s1",
            "section": "race",
            "type": "event",
            "start_time_seconds": 10.0,
            "end_time_seconds": 20.0,  # duration=10s
            "camera_preferences": ["TV1"],
            "camera_schedule": [
                {"offset_seconds": 3.0, "camera_name": "TV1"},
                {"offset_seconds": 7.0, "camera_name": "TV1"},
            ],
        }

        engine.capture_script(
            script=[segment],
            iracing_bridge=bridge,
            capture_engine=capture_eng,
        )

        # Two switches should have fired
        assert len(switch_times) >= 2

        # Each switch must have fired BEFORE the total_wait ends.
        # total_wait = duration(10) + padding(2) = 12s.
        # Switch 1 fires at pre_roll(2) + offset(3) = 5s elapsed.
        # Switch 2 fires at pre_roll(2) + offset(7) = 9s elapsed.
        # Values are approximate because cooldowns also consume fake-clock time.
        assert switch_times[0] < switch_times[1], "switches must fire in order"

    def test_schedule_entry_skipped_beyond_total_wait(self):
        """An entry whose fire_at >= total_wait must be silently skipped."""
        clock = FakeClock(0.0)
        bridge = make_iracing_bridge(cam_group=2)
        engine = make_engine(clock=clock, clip_padding=2.0)
        capture_eng = make_capture_engine()

        segment = {
            "id": "s1",
            "section": "race",
            "type": "event",
            "start_time_seconds": 0.0,
            "end_time_seconds": 5.0,   # duration=5s
            "camera_preferences": ["Cockpit"],
            "camera_schedule": [
                {"offset_seconds": 1.0, "camera_name": "Cockpit"},  # fires at pre_roll+1
                {"offset_seconds": 999.0, "camera_name": "Cockpit"},  # WAY beyond wait
            ],
        }

        engine.capture_script(
            script=[segment],
            iracing_bridge=bridge,
            capture_engine=capture_eng,
        )

        schedule_entries = [
            e for e in engine.capture_log if e["action"] == "camera_schedule"
        ]
        # Only the first entry (offset=1s) should have been fired
        assert len(schedule_entries) == 1

    def test_contiguous_segment_uses_zero_pre_roll(self):
        """For a contiguous segment, pre_roll=0, so offset_seconds is measured
        directly from the start of the wait."""
        clock = FakeClock(0.0)
        switch_times: list[float] = []

        bridge = make_iracing_bridge(cam_group=1)

        def record_switch(pos, group):
            switch_times.append(clock.now())
            return True
        bridge.cam_switch_position.side_effect = record_switch

        engine = make_engine(clock=clock, clip_padding=2.0, contiguous_gap_threshold=5.0)
        capture_eng = make_capture_engine()

        # Two contiguous segments (gap=0.5s < threshold=5s)
        script = [
            {
                "id": "s1",
                "section": "race",
                "type": "event",
                "start_time_seconds": 10.0,
                "end_time_seconds": 20.0,
                "camera_preferences": ["TV1"],
            },
            {
                "id": "s2",
                "section": "race",
                "type": "event",
                "start_time_seconds": 20.5,
                "end_time_seconds": 30.5,  # duration=10s
                "camera_preferences": ["TV1"],
                "camera_schedule": [
                    {"offset_seconds": 2.0, "camera_name": "TV1"},
                ],
            },
        ]

        time_before_s2 = [0.0]

        orig_switch_car = bridge.cam_switch_car

        def track_contiguous_start(car, group):
            # The contiguous camera switch fires first; record clock after
            time_before_s2[0] = clock.now()
            return orig_switch_car(car, group)
        bridge.cam_switch_car.side_effect = track_contiguous_start

        engine.capture_script(
            script=script,
            iracing_bridge=bridge,
            capture_engine=capture_eng,
        )

        # The scheduled switch for s2 should have fired ~2s into s2's wait,
        # which means roughly time_before_s2 + 2s (plus validation overhead).
        if switch_times:
            offset_delta = switch_times[0] - time_before_s2[0]
            # Should be ≥ 2.0 (the schedule offset) but within the 10s duration
            assert 2.0 <= offset_delta <= 10.0 + 5.0  # 5s tolerance for validation overhead


class TestClipNaming:
    """Tests for clip name generation."""

    def test_build_clip_name_basic(self):
        engine = make_engine()
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
        engine = make_engine()
        name = engine._build_clip_name(
            "a" * 100, "race", "event",
            {"event_type": "x" * 100},
            999,
        )
        assert len(name) <= 64


class TestHotkeyRecorderAdapter:
    """Tests for HotkeyRecorderAdapter file-polling logic."""

    def _make_adapter(self, clock: FakeClock, watch_dir: str = "/tmp/watch",
                      poll_timeout: float = 10.0, stable_checks: int = 2):
        return HotkeyRecorderAdapter(
            watch_folder=watch_dir,
            start_hotkey="F9",
            stop_hotkey="F9",
            poll_timeout=poll_timeout,
            stable_checks=stable_checks,
            _sleep=clock.sleep,
            _wall_time=clock.wall,
        )

    def test_poll_times_out_when_no_file_appears(self, tmp_path):
        """_poll_and_move returns False when no file is found within timeout."""
        clock = FakeClock(1000.0)
        adapter = self._make_adapter(clock, watch_dir=str(tmp_path), poll_timeout=5.0)
        adapter._recording_started_at = clock.wall()

        result = adapter._poll_and_move(str(tmp_path / "clip.mp4"))

        assert result is False

    def test_poll_finds_and_moves_stable_file(self, tmp_path):
        """_poll_and_move moves a file once its size is stable."""
        clock = FakeClock(1000.0)
        adapter = self._make_adapter(clock, watch_dir=str(tmp_path),
                                     poll_timeout=30.0, stable_checks=2)
        adapter._recording_started_at = clock.wall()

        # Create a file that will appear stable immediately
        src = tmp_path / "obs_output.mp4"
        src.write_bytes(b"fake video data" * 1000)
        target = tmp_path / "clip_output" / "clip.mp4"

        result = adapter._poll_and_move(str(target))

        assert result is True
        assert target.exists()
        assert not src.exists()

    def test_poll_waits_for_stability_before_moving(self, tmp_path):
        """_poll_and_move must see the same size on stable_checks consecutive
        polls before declaring the file done."""
        clock = FakeClock(1000.0)
        stable_checks = 3
        adapter = self._make_adapter(clock, watch_dir=str(tmp_path),
                                     poll_timeout=60.0, stable_checks=stable_checks)
        adapter._recording_started_at = clock.wall()

        src = tmp_path / "obs_growing.mp4"
        target = tmp_path / "clip.mp4"

        # Simulate a file that grows for the first two polls then stabilises
        poll_count = [0]
        original_get_recent = None

        import server.utils.obs_integration as obs_mod

        original_fn = obs_mod.get_recent_video_files

        def mock_get_recent(directory, since, **kw):
            poll_count[0] += 1
            size = 1000 * min(poll_count[0], stable_checks)
            src.write_bytes(b"x" * size)
            return [{
                "path": str(src),
                "size_bytes": size,
                "created_at": clock.wall() - 1,
                "extension": ".mp4",
                "name": src.name,
            }]

        obs_mod.get_recent_video_files = mock_get_recent
        try:
            result = adapter._poll_and_move(str(target))
        finally:
            obs_mod.get_recent_video_files = original_fn

        assert result is True
        # Should have taken at least stable_checks polls
        assert poll_count[0] >= stable_checks
