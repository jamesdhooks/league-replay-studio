import asyncio
import os
import sys

from fastapi import HTTPException
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "backend"))

from server.routes import api_agent, api_analysis, api_capture
from server.routes.api_agent import StepControlRequest, UploadStartRequest, start_agent_youtube_upload
from server.routes.api_projects import build_auto_project_name


def test_auto_project_name_matches_ui_style():
    name, source = build_auto_project_name(
        {
            "series_name": "GT Sprint",
            "track_name": "Road America",
            "race_week": 7,
        }
    )

    assert name == "GT Sprint Week 7 - Road America"
    assert source == "race_details_series_week_track"


def test_agent_upload_blocks_public_without_confirmation():
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            start_agent_youtube_upload(
                UploadStartRequest(
                    file_path="C:/exports/replay.mp4",
                    title="Race Replay",
                    privacy="public",
                    confirm_public=False,
                )
            )
        )

    assert exc_info.value.status_code == 403


def test_agent_capture_start_delegates_to_script_capture(monkeypatch):
    project = {"id": 7, "script": [{"id": "intro", "type": "broll"}]}
    monkeypatch.setattr(api_agent, "_project_or_404", lambda project_id: project)

    received = {}

    async def fake_start_script_capture(request):
        received["request"] = request
        return {"accepted": True, "project_id": request.project_id}

    monkeypatch.setattr(api_capture, "start_script_capture", fake_start_script_capture)

    result = asyncio.run(
        api_agent.control_agent_step(
            7,
            "capture",
            StepControlRequest(
                action="start",
                config={
                    "capture_mode": "specific_segments",
                    "segment_ids": ["intro"],
                    "capture_resolution": "720p",
                    "validate_clips": True,
                    "retry_failed_clip_validation": True,
                    "clip_validation_retry_limit": 2,
                },
            ),
        )
    )

    assert result["success"] is True
    assert result["engine"] == "script_capture"
    assert received["request"].project_id == 7
    assert received["request"].script == project["script"]
    assert received["request"].capture_mode == "specific_segments"
    assert received["request"].segment_ids == ["intro"]
    assert received["request"].capture_resolution == "720p"
    assert received["request"].validate_clips is True
    assert received["request"].retry_failed_clip_validation is True
    assert received["request"].clip_validation_retry_limit == 2


def test_agent_capabilities_include_capture_validation_controls():
    capabilities = asyncio.run(api_agent.get_agent_capabilities())

    validation = capabilities["capture"]["clip_validation"]
    assert capabilities["features"]["capture_decode_validation"] is True
    assert capabilities["features"]["capture_validation_retry"] is True
    assert capabilities["features"]["manual_capture_clip_validation"] is True
    assert capabilities["features"]["capture_reset_with_trash"] is True
    assert capabilities["features"]["obs_websocket_control"] is True
    assert capabilities["features"]["continuity_aware_script_generation"] is True
    assert capabilities["highlights"]["target_duration_scope"] == "final_video"
    assert capabilities["highlights"]["continuity"]["config_path"].endswith("continuityPreference")
    assert capabilities["highlights"]["continuity"]["retained_gaps_count_toward_target"] is True
    assert capabilities["highlights"]["continuity"]["target_fill_preserved"] is True
    assert capabilities["highlights"]["continuity"]["minimum_clip_duration_seconds"] == 6
    assert capabilities["highlights"]["continuity"]["max_groups_at_100"] == 3
    assert "block_variety" in capabilities["highlights"]["continuity"]["selection_model"]
    assert capabilities["highlights"]["continuity"]["script_segment_type"] == "event"
    assert capabilities["highlights"]["continuity"]["continuity_group_field"] == "continuity_group_id"
    assert capabilities["highlights"]["continuity"]["advanced_constraints"] == [
        "continuity_block_duration",
        "continuity_block_count",
        "continuity_gap_reach",
        "continuity_event_diversity",
    ]
    assert validation["validator"] == "ffprobe+ffmpeg-decode"
    assert "retry_failed_clip_validation" in validation["config_keys"]
    assert validation["manual_actions"] == ["validate", "delete_and_reset_corrupt"]
    assert validation["status_endpoint"].endswith("/capture/validate-clips/status")
    assert capabilities["capture"]["recapture"]["capture_all_archives_existing"] is True


def test_agent_highlight_generation_clamps_and_delegates(monkeypatch):
    received = {}

    async def fake_generate(project_id, request):
        received["project_id"] = project_id
        received["request"] = request
        return {"script": [{"id": "prod_1"}]}

    monkeypatch.setattr(api_analysis, "generate_video_script_endpoint", fake_generate)
    result = asyncio.run(api_agent.generate_agent_highlight_script(
        7,
        api_agent.HighlightScriptRequest(
            target_duration=300,
            continuity_preference=140,
            continuity_block_duration=75,
            continuity_block_count=8,
            continuity_gap_reach=35,
            continuity_event_diversity=140,
            dry_run=True,
        ),
    ))

    assert result["script"][0]["id"] == "prod_1"
    assert received["project_id"] == 7
    assert received["request"].constraints["continuity_preference"] == 100
    assert received["request"].constraints["continuity_block_duration"] == 75
    assert received["request"].constraints["continuity_block_count"] == 8
    assert received["request"].constraints["continuity_gap_reach"] == 35
    assert received["request"].constraints["continuity_event_diversity"] == 100
    assert received["request"].persist is False



def test_agent_manual_capture_validation_delegates_to_capture_route(monkeypatch):
    project = {"id": 7, "project_dir": "C:/projects/7"}
    monkeypatch.setattr(api_agent, "_project_or_404", lambda project_id: project)

    received = {}

    async def fake_validate(request):
        received["project_id"] = request.project_id
        return {"checked": 3, "failed": []}

    monkeypatch.setattr(api_capture, "validate_persisted_script_capture", fake_validate)

    result = asyncio.run(
        api_agent.validate_agent_capture_clips(
            7,
            api_agent.CaptureClipValidationRequest(recover_corrupt=False),
        )
    )

    assert result == {"checked": 3, "failed": []}
    assert received["project_id"] == 7


def test_agent_capture_start_requires_segment_ids_for_specific_segments(monkeypatch):
    monkeypatch.setattr(api_agent, "_project_or_404", lambda project_id: {"id": project_id, "script": [{"id": "intro"}]})

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            api_agent.control_agent_step(
                7,
                "capture",
                StepControlRequest(action="start", config={"capture_mode": "specific_segments"}),
            )
        )

    assert exc_info.value.status_code == 400
    assert "segment_ids" in str(exc_info.value.detail)
