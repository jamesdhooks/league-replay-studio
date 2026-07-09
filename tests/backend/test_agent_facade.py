import asyncio
import os
import sys

from fastapi import HTTPException
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "backend"))

from server.routes.api_agent import UploadStartRequest, start_agent_youtube_upload
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
