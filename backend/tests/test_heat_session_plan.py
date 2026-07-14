from server.services.heat_session_plan import build_session_plan, materialize_heat_script, requires_full_replay_scan, update_session_anchor


def _sessions():
    return [
        {"index": 1, "type": "Open Qualify", "name": "Open Qualify", "has_results": True},
        {"index": 2, "type": "Race", "name": "HEAT 1", "has_results": True},
        {"index": 3, "type": "Race", "name": "HEAT 2", "has_results": False},
        {"index": 4, "type": "Race", "name": "FEATURE", "has_results": True},
    ]


def test_explicit_heat_feature_plan_excludes_incomplete_heat():
    plan = build_session_plan(_sessions())
    assert plan["format"] == "heat"
    assert [stage["section"] for stage in plan["stages"]] == [
        "qualifying_results", "heat", "heat_results", "race", "race_results"
    ]
    assert plan["heat_sessions"] == [{"session_num": 2, "label": "Heat 1"}]


def test_heat_plan_requires_full_replay_scan_for_measured_anchors():
    assert requires_full_replay_scan(build_session_plan(_sessions())) is True
    assert requires_full_replay_scan(build_session_plan([
        {"index": 1, "type": "Race", "name": "Race 1", "has_results": True},
        {"index": 2, "type": "Race", "name": "Race 2", "has_results": True},
    ])) is False


def test_materializes_heat_before_feature_with_exact_result_sessions():
    plan = build_session_plan(_sessions())
    feature = [
        {"id": "feature_event", "type": "event", "section": "race", "start_time_seconds": 10, "end_time_seconds": 20},
        {"id": "feature_results", "type": "broll", "section": "race_results", "start_time_seconds": 30, "end_time_seconds": 45},
    ]
    script = materialize_heat_script(
        plan, feature, {
            "2": {"race_start_session_time": 100.0, "race_finish_session_time": 160.0},
            "4": {"race_start_session_time": 200.0, "race_finish_session_time": 300.0},
        }
    )
    assert [segment["section"] for segment in script] == [
        "qualifying_results", "heat", "heat_results", "race", "race_results"
    ]
    assert script[1]["session_num"] == 2
    assert script[1]["end_time_seconds"] == 160.0
    assert script[2]["start_time_seconds"] == 160.0
    assert script[2]["result_session_num"] == 2
    assert script[3]["session_num"] == 4
    assert script[4]["result_session_num"] == 4


def test_refuses_unanchored_heat_instead_of_reusing_feature_timeline():
    plan = build_session_plan(_sessions())
    try:
        materialize_heat_script(plan, [], {"4": {"race_start_session_time": 200.0}})
    except ValueError as exc:
        assert "Heat session 2" in str(exc)
    else:
        raise AssertionError("unanchored heat must not be materialized")


def test_session_anchor_records_same_session_green_and_checkered_once():
    anchors = {}
    planned = {2, 4}
    assert update_session_anchor(anchors, {
        "replay_session_num": 2, "session_state": 4,
        "replay_frame": 100, "session_time": 12.5,
    }, planned) is True
    assert update_session_anchor(anchors, {
        "replay_session_num": 2, "session_state": 5,
        "replay_frame": 900, "session_time": 142.5,
    }, planned) is True
    assert update_session_anchor(anchors, {
        "replay_session_num": 2, "session_state": 6,
        "replay_frame": 901, "session_time": 142.6,
    }, planned) is False
    assert anchors == {"2": {
        "race_start_frame": 100, "race_start_session_time": 12.5,
        "race_finish_frame": 900, "race_finish_session_time": 142.5,
    }}


def test_generic_multi_race_remains_standard():
    plan = build_session_plan([
        {"index": 1, "type": "Race", "name": "Race 1", "has_results": True},
        {"index": 2, "type": "Race", "name": "Race 2", "has_results": True},
    ])
    assert plan["format"] == "standard"
    assert plan["feature_session_num"] == 2
