from server.services.analysis_db import assign_event_replay_sessions, get_project_db, init_analysis_db
from server.services.replay_analysis import TelemetryWriter
from server.utils.frame_data_builder import build_frame_data


def _snapshot(session_num: int, session_time: float, frame: int, lap_pct: float) -> dict:
    return {
        "data": {
            "replay_session_num": session_num,
            "session_time": session_time,
            "replay_frame": frame,
            "session_state": 4,
            "race_laps": 1,
            "cam_car_idx": 0,
            "flags": 0,
            "flag_yellow": 0,
            "flag_red": 0,
            "flag_checkered": 0,
            "track_length": 4000.0,
            "incident_counts": [0],
            "car_states": [{
                "car_idx": 0,
                "position": 1,
                "class_position": 1,
                "lap": 1,
                "lap_pct": lap_pct,
                "surface": 3,
                "est_time": session_time,
                "best_lap_time": 90.0,
            }],
        }
    }


def _write_overlapping_ticks(conn) -> None:
    writer = TelemetryWriter(conn)
    writer.write_tick(_snapshot(2, 15.0, 100, 0.25))
    writer.write_tick(_snapshot(4, 15.0, 200, 0.25))
    writer.flush()


def test_telemetry_writer_persists_overlapping_heat_session_clocks(tmp_path):
    init_analysis_db(str(tmp_path))
    conn = get_project_db(str(tmp_path))
    try:
        _write_overlapping_ticks(conn)
        rows = conn.execute(
            "SELECT replay_session_num, session_time, replay_frame FROM race_ticks ORDER BY id"
        ).fetchall()
        assert [(r["replay_session_num"], r["session_time"], r["replay_frame"]) for r in rows] == [(2, 15.0, 100), (4, 15.0, 200)]
    finally:
        conn.close()


def test_telemetry_writer_resets_speed_baseline_at_session_boundary(tmp_path):
    init_analysis_db(str(tmp_path))
    conn = get_project_db(str(tmp_path))
    try:
        writer = TelemetryWriter(conn)
        writer.write_tick(_snapshot(2, 10.0, 100, 0.20))
        writer.write_tick(_snapshot(2, 11.0, 116, 0.30))
        writer.write_tick(_snapshot(4, 10.0, 200, 0.20))
        writer.flush()
        speeds = [r["speed_ms"] for r in conn.execute("SELECT speed_ms FROM car_states ORDER BY id").fetchall()]
        assert speeds[0] is None and speeds[1] is not None and speeds[2] is None
    finally:
        conn.close()


def test_frame_data_lookup_filters_overlapping_session_clocks(tmp_path):
    init_analysis_db(str(tmp_path))
    conn = get_project_db(str(tmp_path))
    try:
        _write_overlapping_ticks(conn)
        conn.execute("UPDATE race_ticks SET race_laps = 2 WHERE replay_session_num = 2")
        conn.execute("UPDATE race_ticks SET race_laps = 9 WHERE replay_session_num = 4")
        conn.commit()
    finally:
        conn.close()
    assert build_frame_data(str(tmp_path), 15.0, replay_session_num=2)["current_lap"] == 2
    assert build_frame_data(str(tmp_path), 15.0, replay_session_num=4)["current_lap"] == 9


def test_event_session_mapper_uses_global_replay_frame(tmp_path):
    init_analysis_db(str(tmp_path))
    conn = get_project_db(str(tmp_path))
    try:
        _write_overlapping_ticks(conn)
        events = [
            {"event_type": "incident", "start_frame": 101},
            {"event_type": "overtake", "start_frame": 199},
        ]
        assign_event_replay_sessions(conn, events)
        assert [event["replay_session_num"] for event in events] == [2, 4]
    finally:
        conn.close()
