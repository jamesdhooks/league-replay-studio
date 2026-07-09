import asyncio
import base64
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "backend"))

from server import mcp_lrs_server


def run_async(coro):
    return asyncio.run(coro)


def test_mcp_overlay_tools_route_to_lrs_api_with_expected_payloads(monkeypatch):
    calls = []

    async def fake_request(method, path, json_body=None):
        calls.append((method, path, json_body))
        return {"success": True, "path": path}

    monkeypatch.setattr(mcp_lrs_server, "_request", fake_request)

    run_async(mcp_lrs_server.list_overlay_designs())
    run_async(mcp_lrs_server.get_overlay_html("podium"))
    run_async(
        mcp_lrs_server.update_overlay_html(
            "podium",
            "<html>updated</html>",
            "expected-hash",
            "Tighten podium layout",
        )
    )
    run_async(mcp_lrs_server.validate_overlay_html("podium", "<html>check</html>", project_id=12))
    run_async(mcp_lrs_server.list_overlay_revisions("podium"))
    run_async(mcp_lrs_server.restore_overlay_revision("podium", "rev-1", expected_sha256="current-hash"))
    run_async(
        mcp_lrs_server.render_overlay_preview(
            "podium",
            section="qualifying",
            project_id=12,
            frame_data={"driver": "Ada"},
            save_artifacts=False,
        )
    )
    run_async(
        mcp_lrs_server.render_overlay_html_preview(
            "podium",
            "<html>draft</html>",
            project_id=12,
            frame_data={"driver": "Ada"},
            save_artifacts=False,
        )
    )

    assert calls == [
        ("GET", "/presets", None),
        ("GET", "/presets/podium/html", None),
        (
            "PUT",
            "/presets/podium/html",
            {
                "html_content": "<html>updated</html>",
                "expected_sha256": "expected-hash",
                "summary": "Tighten podium layout",
                "author": "codex",
                "source": "mcp",
            },
        ),
        (
            "POST",
            "/presets/podium/validate-html",
            {
                "html_content": "<html>check</html>",
                "project_id": 12,
                "render_screenshot": False,
            },
        ),
        ("GET", "/presets/podium/revisions", None),
        (
            "POST",
            "/presets/podium/revisions/rev-1/restore",
            {
                "expected_sha256": "current-hash",
                "summary": "Restore rev-1",
                "author": "codex",
                "source": "mcp",
            },
        ),
        (
            "POST",
            "/presets/podium/render-preview",
            {
                "section": "qualifying",
                "project_id": 12,
                "frame_data": {"driver": "Ada"},
                "prefer_html_content": True,
                "include_rendered_html": True,
                "render_screenshot": True,
                "include_debug": True,
            },
        ),
        (
            "POST",
            "/presets/podium/editor-preview",
            {
                "html_content": "<html>draft</html>",
                "project_id": 12,
                "frame_data": {"driver": "Ada"},
                "include_rendered_html": True,
                "render_screenshot": True,
            },
        ),
    ]


def test_mcp_preview_artifacts_are_written_for_agent_inspection(tmp_path, monkeypatch):
    png_bytes = b"not-really-a-png-but-good-enough-for-base64"
    png_base64 = base64.b64encode(png_bytes).decode("ascii")
    monkeypatch.setattr(mcp_lrs_server, "PREVIEW_ARTIFACT_DIR", tmp_path)

    result = mcp_lrs_server._attach_preview_artifacts(
        {
            "success": True,
            "png_base64": png_base64,
            "rendered_html": "<html><body>Preview</body></html>",
        },
        preset_id="podium/main",
        section="race",
        save_artifacts=True,
    )

    artifacts = result["preview_artifacts"]
    assert artifacts["image_data_url"] == f"data:image/png;base64,{png_base64}"
    assert artifacts["png_path"].endswith("-podium-main-race.png")
    assert artifacts["html_path"].endswith("-podium-main-race.html")
    assert Path(artifacts["png_path"]).read_bytes() == png_bytes
    assert Path(artifacts["html_path"]).read_text(encoding="utf-8") == "<html><body>Preview</body></html>"


def test_generic_mcp_tools_route_auto_pipeline_and_project_calls(monkeypatch):
    calls = []

    async def fake_request(method, path, json_body=None):
        calls.append((method, path, json_body))
        if path == "/pipeline/status":
            return {"current_run": {"run_id": "run-1", "state": "completed"}}
        return {"success": True, "path": path}

    monkeypatch.setattr(mcp_lrs_server, "_request", fake_request)

    run_async(mcp_lrs_server.get_lrs_capabilities())
    run_async(mcp_lrs_server.create_replay_project(name="", preset_id="fast", auto_start=True))
    run_async(mcp_lrs_server.start_auto_pipeline(12, preset_id="fast", config={"upload_to_youtube": False}))
    run_async(mcp_lrs_server.monitor_auto_pipeline(run_id="run-1"))
    run_async(mcp_lrs_server.control_workflow_step(12, "pipeline", "restart", preset_id="fast"))
    run_async(mcp_lrs_server.validate_replay_project(12, scope="upload"))
    run_async(mcp_lrs_server.list_project_files(12))
    run_async(mcp_lrs_server.read_project_file(12, "project.json"))
    run_async(mcp_lrs_server.start_youtube_upload("C:/out.mp4", "Title", privacy="unlisted", project_id=12))

    assert calls[:9] == [
        ("GET", "/agent/capabilities", None),
        (
            "POST",
            "/agent/replay-jobs",
            {
                "source": "current_iracing_session",
                "name": "",
                "replay_file": "",
                "preset_id": "fast",
                "auto_start": True,
                "config": {},
            },
        ),
        (
            "POST",
            "/pipeline/start",
            {"project_id": 12, "preset_id": "fast", "config": {"upload_to_youtube": False}},
        ),
        ("GET", "/pipeline/status", None),
        ("GET", "/pipeline/runs/run-1/logs?limit=200", None),
        (
            "POST",
            "/agent/projects/12/steps/pipeline/control",
            {"action": "restart", "preset_id": "fast", "config": {}, "run_id": None},
        ),
        ("GET", "/agent/projects/12/validate?scope=upload", None),
        ("GET", "/agent/projects/12/files", None),
        ("GET", "/agent/projects/12/files/read?path=project.json", None),
    ]
    assert calls[9] == (
        "POST",
        "/agent/youtube/upload/start",
        {
            "file_path": "C:/out.mp4",
            "title": "Title",
            "description": "",
            "tags": [],
            "privacy": "unlisted",
            "project_id": 12,
            "playlist_id": None,
            "confirm_public": False,
        },
    )
