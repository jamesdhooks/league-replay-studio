from __future__ import annotations

from server.utils.script_capture import ScriptCaptureEngine


def test_cross_session_segments_are_never_marked_contiguous() -> None:
    capture = ScriptCaptureEngine(output_dir=".")
    strategies = capture._compute_strategies([
        {
            "id": "heat_1_results",
            "section": "heat_results",
            "session_num": 2,
            "start_time_seconds": 100.0,
            "end_time_seconds": 110.0,
        },
        {
            "id": "feature_start",
            "section": "race",
            "session_num": 4,
            "start_time_seconds": 100.0,
            "end_time_seconds": 110.0,
        },
    ])

    assert strategies[0]["contiguous_with_next"] is False
    assert strategies[1]["contiguous_with_prev"] is False
    assert strategies[1]["strategy"] == "new_recording"


def test_same_session_nearby_segments_remain_contiguous() -> None:
    capture = ScriptCaptureEngine(output_dir=".")
    strategies = capture._compute_strategies([
        {
            "id": "feature_start",
            "session_num": 4,
            "start_time_seconds": 100.0,
            "end_time_seconds": 110.0,
        },
        {
            "id": "feature_finish",
            "session_num": 4,
            "start_time_seconds": 111.0,
            "end_time_seconds": 120.0,
        },
    ])

    assert strategies[0]["contiguous_with_next"] is True
    assert strategies[1]["contiguous_with_prev"] is True
