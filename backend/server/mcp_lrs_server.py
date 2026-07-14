"""
mcp_lrs_server.py
-----------------
Generic MCP stdio bridge for League Replay Studio.

REST APIs remain the source of truth. This bridge exposes agent-friendly tools
for project creation, Auto pipeline control, workflow inspection, files,
YouTube upload control, and overlay editing.
"""

from __future__ import annotations

import base64
import os
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

try:
    from mcp.server.fastmcp import FastMCP
except ImportError as exc:  # pragma: no cover - exercised by launch environment
    raise SystemExit(
        "The MCP SDK is required to run the LRS bridge. Install backend requirements first "
        "(missing package: mcp)."
    ) from exc


API_BASE = os.environ.get("LRS_API_URL", "http://127.0.0.1:6369/api").rstrip("/")
REQUEST_TIMEOUT_SECONDS = 30.0
PREVIEW_ARTIFACT_DIR = Path(
    os.environ.get(
        "LRS_MCP_PREVIEW_DIR",
        str(Path(tempfile.gettempdir()) / "league-replay-studio" / "overlay-previews"),
    )
)

mcp = FastMCP("league-replay-studio")


async def _request(method: str, path: str, json_body: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{API_BASE}{path}"
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        response = await client.request(method, url, json=json_body)
    try:
        payload = response.json()
    except ValueError:
        payload = {"message": response.text}
    if response.status_code >= 400:
        return {
            "success": False,
            "status_code": response.status_code,
            "error": payload,
        }
    if isinstance(payload, dict):
        return payload
    return {"success": True, "data": payload}


def _safe_name(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value.strip()).strip("-")
    return cleaned[:80] or "overlay"


def _attach_preview_artifacts(
    result: dict[str, Any],
    *,
    preset_id: str,
    section: str,
    save_artifacts: bool,
) -> dict[str, Any]:
    if not save_artifacts or not result.get("success"):
        return result

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    stem = f"{timestamp}-{_safe_name(preset_id)}-{_safe_name(section)}"
    PREVIEW_ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

    artifacts: dict[str, Any] = {}
    png_base64 = result.get("png_base64")
    if isinstance(png_base64, str) and png_base64:
        png_path = PREVIEW_ARTIFACT_DIR / f"{stem}.png"
        png_path.write_bytes(base64.b64decode(png_base64))
        artifacts["png_path"] = str(png_path)
        artifacts["image_data_url"] = f"data:image/png;base64,{png_base64}"

    rendered_html = result.get("rendered_html")
    if isinstance(rendered_html, str) and rendered_html:
        html_path = PREVIEW_ARTIFACT_DIR / f"{stem}.html"
        html_path.write_text(rendered_html, encoding="utf-8")
        artifacts["html_path"] = str(html_path)

    if artifacts:
        result = dict(result)
        result["preview_artifacts"] = artifacts
    return result


async def _poll_pipeline_until_terminal(
    *,
    poll_interval_seconds: float,
    timeout_seconds: float,
) -> dict[str, Any]:
    terminal = {"completed", "cancelled", "failed"}
    start = time.monotonic()
    last_status: dict[str, Any] = {}
    while time.monotonic() - start <= timeout_seconds:
        last_status = await _request("GET", "/pipeline/status")
        run = last_status.get("current_run") or last_status.get("run") or {}
        state = str(run.get("state") or last_status.get("state") or "").lower()
        if state in terminal:
            return {"terminal": True, "status": last_status}
        await _sleep(poll_interval_seconds)
    return {"terminal": False, "status": last_status, "timeout_seconds": timeout_seconds}


async def _sleep(seconds: float) -> None:
    import asyncio

    await asyncio.sleep(max(0.1, seconds))


# ── Capabilities / Projects ────────────────────────────────────────────────

@mcp.tool()
async def get_lrs_capabilities() -> dict[str, Any]:
    """Return agent-safe LRS capabilities, presets, and current iRacing summary."""
    return await _request("GET", "/agent/capabilities")


@mcp.tool()
async def get_iracing_context() -> dict[str, Any]:
    """Return current iRacing connection/session context."""
    return await _request("GET", "/iracing/status")


@mcp.tool()
async def create_replay_project(
    name: str = "",
    replay_file: str = "",
    preset_id: str | None = None,
    auto_start: bool = False,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create a replay project from the current iRacing session, optionally starting Auto."""
    return await _request(
        "POST",
        "/agent/replay-jobs",
        {
            "source": "current_iracing_session",
            "name": name,
            "replay_file": replay_file,
            "preset_id": preset_id,
            "auto_start": auto_start,
            "config": config or {},
        },
    )


@mcp.tool()
async def list_replay_projects(search: str = "", step: str = "", track: str = "") -> dict[str, Any]:
    """List replay projects."""
    from urllib.parse import urlencode

    query = urlencode({k: v for k, v in {"search": search, "step": step, "track": track}.items() if v})
    path = f"/projects?{query}" if query else "/projects"
    projects = await _request("GET", path)
    return {"projects": projects} if isinstance(projects, list) else projects


@mcp.tool()
async def get_replay_project(project_id: int, include_files: bool = True, include_validation: bool = True) -> dict[str, Any]:
    """Get an agent-oriented project summary."""
    return await _request(
        "GET",
        f"/agent/projects/{project_id}/summary?include_files={str(include_files).lower()}&include_validation={str(include_validation).lower()}",
    )


# ── Auto Pipeline / Workflow ───────────────────────────────────────────────

@mcp.tool()
async def list_workflow_presets() -> dict[str, Any]:
    """List Auto pipeline presets."""
    return await _request("GET", "/pipeline/presets")


@mcp.tool()
async def get_project_control_state(project_id: int) -> dict[str, Any]:
    """Get the canonical project control-state envelope."""
    return await _request("GET", f"/pipeline/projects/{project_id}/control-state")


@mcp.tool()
async def set_project_control_state(
    project_id: int,
    preset_id: str = "",
    overrides: dict[str, Any] | None = None,
    controls: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Save the canonical project control-state envelope."""
    return await _request(
        "PUT",
        f"/pipeline/projects/{project_id}/control-state",
        {
            "preset_id": preset_id,
            "overrides": overrides or {},
            "controls": controls or {"pipeline": {"preset_id": preset_id, "overrides": overrides or {}}},
        },
    )


@mcp.tool()
async def start_auto_pipeline(
    project_id: int,
    preset_id: str | None = None,
    config: dict[str, Any] | None = None,
    wait: bool = False,
    timeout_seconds: float = 3600,
    poll_interval_seconds: float = 5,
) -> dict[str, Any]:
    """Start LRS Auto and optionally monitor it; continuity lives at highlight_config.params.continuityPreference."""
    result = await _request(
        "POST",
        "/pipeline/start",
        {"project_id": project_id, "preset_id": preset_id, "config": config or {}},
    )
    if not wait or not result.get("run"):
        return result
    result = dict(result)
    result["monitor"] = await _poll_pipeline_until_terminal(
        poll_interval_seconds=poll_interval_seconds,
        timeout_seconds=timeout_seconds,
    )
    return result


@mcp.tool()
async def monitor_auto_pipeline(
    run_id: str | None = None,
    wait: bool = False,
    timeout_seconds: float = 3600,
    poll_interval_seconds: float = 5,
    log_limit: int = 200,
) -> dict[str, Any]:
    """Get or wait on Auto pipeline status with logs."""
    status = await _poll_pipeline_until_terminal(
        poll_interval_seconds=poll_interval_seconds,
        timeout_seconds=timeout_seconds,
    ) if wait else {"terminal": False, "status": await _request("GET", "/pipeline/status")}
    logs = await get_workflow_logs(run_id=run_id, limit=log_limit)
    return {"status": status.get("status"), "terminal": status.get("terminal"), "logs": logs}


@mcp.tool()
async def pause_auto_pipeline() -> dict[str, Any]:
    """Pause the active Auto pipeline."""
    return await _request("POST", "/pipeline/pause")


@mcp.tool()
async def resume_auto_pipeline() -> dict[str, Any]:
    """Resume the active Auto pipeline."""
    return await _request("POST", "/pipeline/resume")


@mcp.tool()
async def cancel_auto_pipeline() -> dict[str, Any]:
    """Cancel the active Auto pipeline."""
    return await _request("POST", "/pipeline/cancel")


@mcp.tool()
async def retry_auto_pipeline_step(step_name: str) -> dict[str, Any]:
    """Retry a failed Auto pipeline step."""
    return await _request("POST", "/pipeline/retry", {"step_name": step_name})


@mcp.tool()
async def skip_auto_pipeline_step(step_name: str) -> dict[str, Any]:
    """Skip a failed Auto pipeline step and continue."""
    return await _request("POST", "/pipeline/skip", {"step_name": step_name})


@mcp.tool()
async def reset_auto_pipeline(project_id: int | None = None) -> dict[str, Any]:
    """Reset active Auto pipeline state."""
    return await _request("POST", "/pipeline/reset", {"project_id": project_id})


@mcp.tool()
async def get_workflow_status(project_id: int | None = None) -> dict[str, Any]:
    """Get Auto pipeline status, optionally with project summary."""
    if project_id is not None:
        return await get_replay_project(project_id)
    return await _request("GET", "/pipeline/status")


@mcp.tool()
async def get_workflow_logs(run_id: str | None = None, step: str | None = None, level: str | None = None, limit: int = 200) -> dict[str, Any]:
    """Get Auto pipeline run logs."""
    from urllib.parse import urlencode

    if not run_id:
        status = await _request("GET", "/pipeline/status")
        run = status.get("current_run") or status.get("run") or {}
        run_id = run.get("run_id")
    if not run_id:
        return {"run_id": None, "logs": []}
    query = urlencode({k: v for k, v in {"step": step, "level": level, "limit": limit}.items() if v is not None})
    return await _request("GET", f"/pipeline/runs/{run_id}/logs?{query}")


@mcp.tool()
async def control_workflow_step(
    project_id: int,
    step: str,
    action: str,
    preset_id: str | None = None,
    config: dict[str, Any] | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    """Manual fallback control for a workflow step."""
    return await _request(
        "POST",
        f"/agent/projects/{project_id}/steps/{step}/control",
        {
            "action": action,
            "preset_id": preset_id,
            "config": config or {},
            "run_id": run_id,
        },
    )


@mcp.tool()
async def validate_replay_project(project_id: int, scope: str = "all") -> dict[str, Any]:
    """Validate project readiness/artifacts."""
    return await _request("GET", f"/agent/projects/{project_id}/validate?scope={scope}")


@mcp.tool()
async def validate_capture_clips(project_id: int, delete_and_reset_corrupt: bool = False) -> dict[str, Any]:
    """Run ffprobe on captured clips; optionally delete/reset confirmed corrupt events."""
    return await _request(
        "POST",
        f"/agent/projects/{project_id}/capture/validate-clips",
        {"recover_corrupt": delete_and_reset_corrupt},
    )


@mcp.tool()
async def generate_highlight_script(
    project_id: int,
    target_duration: float = 720,
    continuity_preference: int = 0,
    continuity_block_duration: int = 0,
    continuity_block_count: int = 0,
    continuity_gap_reach: int = 0,
    continuity_event_diversity: int = 0,
    weights: dict[str, int] | None = None,
    min_severity: int = 0,
    overrides: dict[str, str] | None = None,
    section_config: dict[str, Any] | None = None,
    clip_padding: float = 2.0,
    clip_padding_after: float = 1.0,
    padding_by_type: dict[str, Any] | None = None,
    tuning: dict[str, Any] | None = None,
    camera_weights: dict[str, Any] | None = None,
    camera_recency_penalty: float = 0.5,
    camera_recency_decay: float = 30.0,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Generate a target-filled script; set dry_run=True to inspect it without replacing project state."""
    return await _request(
        "POST",
        f"/agent/projects/{project_id}/highlights/generate-script",
        {
            "target_duration": target_duration,
            "continuity_preference": continuity_preference,
            "continuity_block_duration": continuity_block_duration,
            "continuity_block_count": continuity_block_count,
            "continuity_gap_reach": continuity_gap_reach,
            "continuity_event_diversity": continuity_event_diversity,
            "weights": weights or {},
            "min_severity": min_severity,
            "overrides": overrides or {},
            "section_config": section_config or {},
            "clip_padding": clip_padding,
            "clip_padding_after": clip_padding_after,
            "padding_by_type": padding_by_type or {},
            "tuning": tuning or {},
            "camera_weights": camera_weights or {},
            "camera_recency_penalty": camera_recency_penalty,
            "camera_recency_decay": camera_recency_decay,
            "dry_run": dry_run,
        },
    )


@mcp.tool()
async def get_capture_clip_validation_status(project_id: int) -> dict[str, Any]:
    """Monitor an in-progress manual capture clip validation or recovery job."""
    return await _request("GET", f"/agent/projects/{project_id}/capture/validate-clips/status")


@mcp.tool()
async def clear_capture_clips(project_id: int) -> dict[str, Any]:
    """Archive all captured clips to project trash and reset them for a fresh capture pass."""
    return await _request("POST", f"/script-state/{project_id}/clear-captures", {})


# ── Project Files ──────────────────────────────────────────────────────────

@mcp.tool()
async def list_project_files(project_id: int) -> dict[str, Any]:
    """List project files with categories and safe relative paths."""
    return await _request("GET", f"/agent/projects/{project_id}/files")


@mcp.tool()
async def read_project_file(project_id: int, path: str) -> dict[str, Any]:
    """Read a text project file by project-relative path."""
    from urllib.parse import quote

    return await _request("GET", f"/agent/projects/{project_id}/files/read?path={quote(path)}")


@mcp.tool()
async def get_project_artifact(project_id: int, path: str) -> dict[str, Any]:
    """Resolve a project artifact to the app's safe serve URL."""
    from urllib.parse import quote

    return {
        "project_id": project_id,
        "path": path,
        "serve_url": f"{API_BASE}/projects/{project_id}/files/serve?path={quote(path)}",
    }


# ── YouTube ────────────────────────────────────────────────────────────────

@mcp.tool()
async def preview_youtube_upload(
    title_template: str,
    description_template: str,
    project_data: dict[str, Any],
) -> dict[str, Any]:
    """Preview rendered YouTube metadata."""
    return await _request(
        "POST",
        "/youtube/upload/preview",
        {
            "title_template": title_template,
            "description_template": description_template,
            "project_data": project_data,
        },
    )


@mcp.tool()
async def start_youtube_upload(
    file_path: str,
    title: str,
    description: str = "",
    tags: list[str] | None = None,
    privacy: str = "unlisted",
    project_id: int | None = None,
    playlist_id: str | None = None,
    confirm_public: bool = False,
) -> dict[str, Any]:
    """Start a YouTube upload with public-upload confirmation protection."""
    return await _request(
        "POST",
        "/agent/youtube/upload/start",
        {
            "file_path": file_path,
            "title": title,
            "description": description,
            "tags": tags or [],
            "privacy": privacy,
            "project_id": project_id,
            "playlist_id": playlist_id,
            "confirm_public": confirm_public,
        },
    )


@mcp.tool()
async def get_youtube_upload_status() -> dict[str, Any]:
    """Get YouTube connection, quota, and upload status."""
    return await _request("GET", "/agent/youtube/status")


@mcp.tool()
async def cancel_youtube_upload(job_id: str) -> dict[str, Any]:
    """Cancel a YouTube upload."""
    return await _request("POST", f"/youtube/upload/cancel/{job_id}")


# ── Overlay Tools ──────────────────────────────────────────────────────────

@mcp.tool()
async def list_overlay_designs() -> dict[str, Any]:
    """List available overlay designs/presets."""
    return await _request("GET", "/presets")


@mcp.tool()
async def get_overlay_html(preset_id: str) -> dict[str, Any]:
    """Read overlay HTML and checksum for optimistic edits."""
    return await _request("GET", f"/presets/{preset_id}/html")


@mcp.tool()
async def update_overlay_html(
    preset_id: str,
    html_content: str,
    expected_sha256: str,
    summary: str,
) -> dict[str, Any]:
    """Save overlay HTML through LRS with revision history and live refresh."""
    return await _request(
        "PUT",
        f"/presets/{preset_id}/html",
        {
            "html_content": html_content,
            "expected_sha256": expected_sha256,
            "summary": summary,
            "author": "codex",
            "source": "mcp",
        },
    )


@mcp.tool()
async def validate_overlay_html(
    preset_id: str,
    html_content: str,
    project_id: int | None = None,
    render_screenshot: bool = False,
) -> dict[str, Any]:
    """Validate Jinja2/HTML rendering without saving."""
    return await _request(
        "POST",
        f"/presets/{preset_id}/validate-html",
        {
            "html_content": html_content,
            "project_id": project_id,
            "render_screenshot": render_screenshot,
        },
    )


@mcp.tool()
async def list_overlay_revisions(preset_id: str) -> dict[str, Any]:
    """List revision snapshots for an overlay design."""
    return await _request("GET", f"/presets/{preset_id}/revisions")


@mcp.tool()
async def restore_overlay_revision(
    preset_id: str,
    revision_id: str,
    expected_sha256: str | None = None,
    summary: str | None = None,
) -> dict[str, Any]:
    """Restore a revision snapshot through LRS."""
    return await _request(
        "POST",
        f"/presets/{preset_id}/revisions/{revision_id}/restore",
        {
            "expected_sha256": expected_sha256,
            "summary": summary or f"Restore {revision_id}",
            "author": "codex",
            "source": "mcp",
        },
    )


@mcp.tool()
async def render_overlay_preview(
    preset_id: str,
    section: str = "race",
    project_id: int | None = None,
    frame_data: dict[str, Any] | None = None,
    render_screenshot: bool = True,
    include_rendered_html: bool = True,
    include_debug: bool = True,
    save_artifacts: bool = True,
) -> dict[str, Any]:
    """Render the saved overlay design and return inspectable preview artifacts."""
    result = await _request(
        "POST",
        f"/presets/{preset_id}/render-preview",
        {
            "section": section,
            "project_id": project_id,
            "frame_data": frame_data or {},
            "prefer_html_content": True,
            "include_rendered_html": include_rendered_html,
            "render_screenshot": render_screenshot,
            "include_debug": include_debug,
        },
    )
    return _attach_preview_artifacts(
        result,
        preset_id=preset_id,
        section=section,
        save_artifacts=save_artifacts,
    )


@mcp.tool()
async def render_overlay_html_preview(
    preset_id: str,
    html_content: str,
    project_id: int | None = None,
    frame_data: dict[str, Any] | None = None,
    render_screenshot: bool = True,
    include_rendered_html: bool = True,
    save_artifacts: bool = True,
) -> dict[str, Any]:
    """Render unsaved overlay HTML so agents can inspect a proposed edit before saving."""
    result = await _request(
        "POST",
        f"/presets/{preset_id}/editor-preview",
        {
            "html_content": html_content,
            "project_id": project_id,
            "frame_data": frame_data or {},
            "include_rendered_html": include_rendered_html,
            "render_screenshot": render_screenshot,
        },
    )
    return _attach_preview_artifacts(
        result,
        preset_id=preset_id,
        section="draft",
        save_artifacts=save_artifacts,
    )


@mcp.tool()
async def lrs_api_get(path: str) -> dict[str, Any]:
    """Read-only diagnostic escape hatch for LRS API GET requests."""
    clean_path = path if path.startswith("/") else f"/{path}"
    return await _request("GET", clean_path)


if __name__ == "__main__":
    mcp.run()
