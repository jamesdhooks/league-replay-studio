from server.utils.overlay_animation import (
    compute_frame_data_diff,
    compute_profile_window_ms,
    merge_animation_windows,
    parse_css_time_to_ms,
)


def test_parse_css_time_to_ms_uses_longest_value():
    assert parse_css_time_to_ms("120ms, 0.75s, 50ms") == 750.0


def test_compute_profile_window_ms_combines_delay_duration_and_iterations():
    profile = {
        "animated_elements": [
            {
                "duration": "0.4s",
                "delay": "120ms",
                "iterations": "2",
            }
        ],
        "transition_elements": [],
    }

    assert compute_profile_window_ms(profile) == 920.0


def test_compute_frame_data_diff_detects_page_and_standings_changes():
    previous = {
        "position": 2,
        "current_lap": 4,
        "flag": "green",
        "driver_name": "Driver A",
        "overlay_page_index": 0,
        "relative_gap": 0.2,
        "standings": [
            {"position": 1, "driver_name": "Leader", "gap": "Leader", "relative": None},
            {"position": 2, "driver_name": "Driver A", "gap": "+0.200", "relative": "+0.200"},
        ],
    }
    current = {
        "position": 1,
        "current_lap": 4,
        "flag": "green",
        "driver_name": "Driver A",
        "overlay_page_index": 1,
        "relative_gap": 0.0,
        "standings": [
            {"position": 1, "driver_name": "Driver A", "gap": "Leader", "relative": None},
            {"position": 2, "driver_name": "Leader", "gap": "+0.100", "relative": "+0.100"},
        ],
    }

    diff = compute_frame_data_diff(previous, current)

    assert diff["significant"] is True
    assert "position" in diff["changed_keys"]
    assert "overlay_page_index" in diff["changed_keys"]
    assert "standings" in diff["changed_keys"]


def test_merge_animation_windows_unions_overlaps_and_reasons():
    merged = merge_animation_windows([
        {"start": 1.0, "end": 2.0, "reasons": ["position"]},
        {"start": 1.8, "end": 2.5, "reasons": ["standings"]},
        {"start": 3.0, "end": 3.4, "reasons": ["flag"]},
    ])

    assert merged == [
        {"start": 1.0, "end": 2.5, "reasons": ["position", "standings"]},
        {"start": 3.0, "end": 3.4, "reasons": ["flag"]},
    ]