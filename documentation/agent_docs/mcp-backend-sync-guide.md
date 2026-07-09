# MCP And Backend Sync Guide

## Purpose

League Replay Studio exposes backend features to agents through `backend/server/mcp_lrs_server.py` and the agent REST facade in `backend/server/routes/api_agent.py`. These surfaces must stay aligned with backend capabilities so agents can safely create projects, run the Auto pipeline, inspect files/logs, edit overlays, validate outputs, and upload to YouTube.

## Non-Negotiable Rule

Any backend change that affects an agent-relevant capability must include the matching MCP and agent-facade update in the same change.

Agent-relevant capabilities include:
- project creation, auto naming, project metadata, project files, and project summaries
- Auto pipeline presets, start/monitor/pause/resume/cancel/retry/skip/reset behavior
- workflow step status, logs, configuration, validation, and artifacts
- overlay design editing, validation, revision history, restore, and preview rendering
- YouTube metadata preview, upload status, quota, upload start/cancel, and upload safety policy
- iRacing session context, replay/camera/capture readiness, and preflight checks

## Required Update Pattern

When adding or changing a backend feature:
1. Decide whether agents should see or control it.
2. If yes, expose it through the highest-level safe REST contract first, usually `/api/agent/...`.
3. Add or update the matching MCP tool in `mcp_lrs_server.py`.
4. Update `/api/agent/capabilities` if the feature changes available actions, presets, flags, policies, or support level.
5. Add or update tests that prove the MCP tool calls the intended REST endpoint with the intended payload.
6. Run the focused MCP/backend validation before finishing.

## Source Of Truth

MCP tools must call LRS APIs. They must not directly mutate project files, pipeline state, overlay templates, or upload state outside backend-owned APIs.

Use REST/backend services for:
- optimistic locking and revision snapshots
- project path safety
- pipeline lifecycle state
- validation/preflight behavior
- WebSocket broadcasts
- YouTube upload policy

## Compatibility

`backend/server/mcp_overlay_server.py` is a compatibility shim for older overlay-only MCP configurations. Keep it working when moving or renaming MCP internals.

## Testing

Minimum focused validation for MCP/backend sync:

```bash
py -3.11 -m pytest tests\backend\test_agent_facade.py tests\backend\test_mcp_overlay_server.py -q
```

Add tests when:
- a new MCP tool is added
- an MCP payload changes
- `/api/agent/capabilities` changes
- upload safety policy changes
- project file access behavior changes
- overlay preview/revision behavior changes

## Common Mistakes To Avoid

- Adding a backend feature but leaving MCP unaware of it.
- Changing a REST payload without updating MCP routing tests.
- Letting MCP write files directly instead of using backend APIs.
- Exposing a low-level mutating raw API tool when a safer task-specific tool is possible.
- Allowing public YouTube upload without an explicit confirmation field.
