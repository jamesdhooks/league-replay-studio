# League Replay Studio Agent Guidance

This file applies to the entire repository.

## MCP And Backend Sync

When changing backend features, project workflow behavior, Auto pipeline behavior, overlay editing, project files, YouTube upload, or any REST API that an agent may need, keep the MCP bridge in sync in the same change.

Required checklist:
- Update `backend/server/mcp_lrs_server.py` when a new agent-relevant capability is added, renamed, removed, or has a request/response contract change.
- Update `backend/server/routes/api_agent.py` when the MCP bridge needs a safer or higher-level REST facade instead of calling low-level routes directly.
- Keep `/api/agent/capabilities` accurate for workflow steps, Auto pipeline actions, manual step actions, feature flags, presets, upload policy, and current support level.
- Preserve `backend/server/mcp_overlay_server.py` as a compatibility shim unless the MCP launch configuration has been migrated everywhere.
- Add or update focused MCP routing tests in `tests/backend/test_mcp_overlay_server.py` and backend facade tests in `tests/backend/test_agent_facade.py`.
- If a backend route or service changes in a way that could break MCP, run the focused MCP/facade tests before calling the work complete.

Validation command:

```bash
py -3.11 -m pytest tests\backend\test_agent_facade.py tests\backend\test_mcp_overlay_server.py -q
```

## Source Of Truth

REST APIs and backend services remain the source of truth. MCP tools are adapters for agents and must not bypass LRS validation, revisioning, pipeline state, file safety, or upload policy.

## Preferred Agent Flow

Agents should prefer the existing Auto pipeline:
1. Create or select a project.
2. Pick/apply a workflow preset.
3. Start the Auto pipeline.
4. Monitor status and logs.
5. Validate artifacts.
6. Use manual step controls only for recovery or targeted reruns.
