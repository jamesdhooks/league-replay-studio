"""Tests for manual persisted capture clip validation and recovery."""

import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "backend"))

from server.routes import api_capture
from server.services.project_service import project_service
from server.services.script_state_service import CAPTURE_UNCAPTURED, script_state_service
from server.utils import script_capture


def test_recover_corrupt_clip_deletes_file_resets_state_and_manifest(tmp_path, monkeypatch):
    project_dir = tmp_path / "project"
    clip_path = project_dir / "clips" / "corrupt.mp4"
    clip_path.parent.mkdir(parents=True)
    clip_path.write_bytes(b"not a video")

    script_state_service.lock_script(str(project_dir), [{
        "id": "seg_1",
        "type": "event",
        "section": "race",
        "start_time_seconds": 1,
        "end_time_seconds": 2,
    }])
    script_state_service.mark_captured(str(project_dir), "seg_1", str(clip_path))
    project = {
        "id": 7,
        "project_dir": str(project_dir),
        "clips_manifest": [{"id": "seg_1", "path": str(clip_path)}],
        "capture_manifest": [{"id": "seg_1", "path": str(clip_path)}],
    }
    saved_metadata = {}

    monkeypatch.setattr(project_service, "get_project", lambda project_id: project if project_id == 7 else None)
    monkeypatch.setattr(project_service, "save_project_metadata", lambda project_id, metadata: saved_metadata.update(metadata))
    monkeypatch.setattr(script_capture, "find_capture_ffprobe", lambda: "ffprobe")
    monkeypatch.setattr(
        script_capture,
        "validate_capture_clip_file",
        lambda path, segment_ids: {
            "path": path,
            "valid": False,
            "size_bytes": 11,
            "duration_seconds": None,
            "errors": ["simulated corrupt clip"],
            "segment_ids": segment_ids,
            "ffprobe_path": "ffprobe",
        },
    )
    monkeypatch.setitem(api_capture._script_capture_state, "running", False)

    report = api_capture._recover_corrupt_persisted_capture_clips(7)

    assert report["checked"] == 1
    assert report["recovery"]["deleted_clip_count"] == 1
    assert report["recovery"]["reset_segment_ids"] == ["seg_1"]
    assert not clip_path.exists()
    assert script_state_service.get_segment_states(str(project_dir))["seg_1"]["capture_state"] == CAPTURE_UNCAPTURED
    assert saved_metadata == {"clips_manifest": [], "capture_manifest": []}
    assert (project_dir / "capture_logs" / "latest_clip_validation.json").exists()


def test_validation_report_includes_uncaptured_events(tmp_path, monkeypatch):
    project_dir = tmp_path / "project"
    (project_dir / "clips").mkdir(parents=True)
    script_state_service.lock_script(str(project_dir), [
        {"id": "captured", "type": "event", "section": "race", "start_time_seconds": 1, "end_time_seconds": 2},
        {"id": "missing", "type": "event", "section": "race", "start_time_seconds": 3, "end_time_seconds": 4, "event_type": "battle"},
    ])
    clip_path = project_dir / "clips" / "captured.mp4"
    clip_path.write_bytes(b"video")
    script_state_service.mark_captured(str(project_dir), "captured", str(clip_path))
    project = {"id": 7, "project_dir": str(project_dir)}

    monkeypatch.setattr(project_service, "get_project", lambda project_id: project if project_id == 7 else None)
    monkeypatch.setattr(script_capture, "find_capture_ffprobe", lambda: "ffprobe")
    monkeypatch.setattr(script_capture, "validate_capture_clip_file", lambda path, segment_ids: {
        "path": path, "valid": True, "size_bytes": 5, "duration_seconds": 1, "errors": [], "segment_ids": segment_ids, "ffprobe_path": "ffprobe",
    })

    report, _, _ = api_capture._validate_persisted_capture_clips(7)

    assert report["capture_audit"] == {"total_event_count": 2, "captured_event_count": 1, "missing_event_count": 1}
    assert report["missing_events"] == [{
        "segment_id": "missing", "capture_state": "uncaptured", "section": "race", "event_type": "battle", "start_time": 3, "end_time": 4,
    }]


def test_validation_report_excludes_non_capturable_bridge_segments(tmp_path, monkeypatch):
    project_dir = tmp_path / "project"
    (project_dir / "clips").mkdir(parents=True)
    script = [
        {"id": "event", "type": "event", "section": "race", "start_time_seconds": 1, "end_time_seconds": 2},
        {"id": "bridge", "type": "bridge", "section": "race", "start_time_seconds": 2, "end_time_seconds": 3},
    ]
    script_state_service.lock_script(str(project_dir), script)
    # Simulate legacy persisted bridge state produced before bridge segments
    # were removed from the capture-state model.
    state = script_state_service.load_state(str(project_dir))
    state["segments"]["bridge"] = {"capture_state": "uncaptured", "section": "race"}
    script_state_service.save_state(str(project_dir), state)
    project = {"id": 7, "project_dir": str(project_dir), "script": script}

    monkeypatch.setattr(project_service, "get_project", lambda project_id: project if project_id == 7 else None)
    monkeypatch.setattr(script_capture, "find_capture_ffprobe", lambda: "ffprobe")
    monkeypatch.setattr(script_capture, "find_capture_ffmpeg", lambda _=None: "ffmpeg")

    report, _, _ = api_capture._validate_persisted_capture_clips(7)

    assert report["missing_events"] == [{
        "segment_id": "event", "capture_state": "uncaptured", "section": "race", "event_type": "event", "start_time": 1, "end_time": 2,
    }]
    assert report["capture_audit"] == {"total_event_count": 1, "captured_event_count": 0, "missing_event_count": 1}


def test_manual_validation_job_returns_progress_and_final_report(monkeypatch):
    completed_report = {"checked": 2, "passed": 2, "failed": [], "progress_log": []}

    def fake_validate(project_id, progress_callback=None):
        progress_callback({"checked": 1, "total": 2, "percentage": 50, "message": "one.mp4: passed", "level": "success"})
        progress_callback({"checked": 2, "total": 2, "percentage": 100, "message": "two.mp4: passed", "level": "success"})
        return completed_report, "", {"id": project_id}

    monkeypatch.setattr(api_capture, "_validate_persisted_capture_clips", fake_validate)
    monkeypatch.setitem(api_capture._script_capture_state, "running", False)

    started = api_capture._start_persisted_clip_validation(7, "validate")
    deadline = time.time() + 2
    while time.time() < deadline:
        with api_capture._clip_validation_lock:
            status = dict(api_capture._clip_validation_state)
        if not status["running"]:
            break
        time.sleep(0.01)

    assert started["accepted"] is True
    assert started["running"] is True
    assert status["running"] is False
    assert status["percentage"] == 100
    assert status["report"] == completed_report
    assert [entry["message"] for entry in status["logs"]][-2:] == ["one.mp4: passed", "two.mp4: passed"]


def test_validation_status_restores_latest_report_after_backend_reload(tmp_path, monkeypatch):
    project_dir = tmp_path / "project"
    reports_dir = project_dir / "capture_logs"
    reports_dir.mkdir(parents=True)
    report = {
        "project_id": 7,
        "checked": 3,
        "passed": 2,
        "failed": [{"path": "corrupt.mp4"}],
        "validator_available": True,
        "progress_log": [{"message": "corrupt.mp4: failed", "level": "error"}],
    }
    (reports_dir / "latest_clip_validation.json").write_text(json.dumps(report), encoding="utf-8")
    monkeypatch.setattr(project_service, "get_project", lambda project_id: {"id": 7, "project_dir": str(project_dir)} if project_id == 7 else None)
    monkeypatch.setattr(api_capture, "_clip_validation_state", {
        "running": False, "job_id": None, "project_id": None, "mode": None,
        "checked": 0, "total": 0, "percentage": 0, "message": "Idle",
        "logs": [], "report": None, "error": None, "started_at": None, "completed_at": None,
    })

    status = asyncio.run(api_capture.get_persisted_clip_validation_status(7))

    assert status["message"] == "Validation report restored from disk"
    assert status["report"] == report
    assert status["report"]["validator_available"] is True
