"""
api_data_plugins.py
-------------------
REST endpoints for the 3rd-party data plugin system.

Prefix: ``/api/data-plugins``

Endpoints:
  GET    /                  — List all configured data plugins
  POST   /                  — Create a new data plugin
  GET    /{plugin_id}       — Get a single plugin config
  PUT    /{plugin_id}       — Update a plugin config
  DELETE /{plugin_id}       — Delete a plugin
  POST   /{plugin_id}/test  — Test plugin connectivity and validate response
  GET    /formats           — Get expected API formats for all plugin types
  GET    /variables          — Get variables contributed by enabled plugins
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from server.services.data_plugin_service import data_plugin_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/data-plugins", tags=["data-plugins"])


# ── Request models ──────────────────────────────────────────────────────────

class PluginCreateRequest(BaseModel):
    name: str
    plugin_type: str  # driver_details | race_details | championship_standings
    endpoint_url: str
    auth_method: str = "none"  # none | api_key | bearer | custom_header
    auth_config: dict[str, Any] = {}
    enabled: bool = True


class PluginUpdateRequest(BaseModel):
    name: Optional[str] = None
    plugin_type: Optional[str] = None
    endpoint_url: Optional[str] = None
    auth_method: Optional[str] = None
    auth_config: Optional[dict[str, Any]] = None
    enabled: Optional[bool] = None


# ── List / Create ───────────────────────────────────────────────────────────

@router.get("/")
async def list_plugins():
    """List all configured data plugins (auth secrets masked)."""
    return {"plugins": data_plugin_service.list_plugins()}


@router.post("/")
async def create_plugin(body: PluginCreateRequest):
    """Create a new data plugin configuration."""
    try:
        plugin = data_plugin_service.create_plugin(body.model_dump())
        return {"success": True, "plugin": plugin}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ── Single plugin CRUD ──────────────────────────────────────────────────────

@router.get("/{plugin_id}")
async def get_plugin(plugin_id: str):
    """Get a single plugin configuration."""
    plugin = data_plugin_service.get_plugin(plugin_id)
    if not plugin:
        raise HTTPException(status_code=404, detail="Plugin not found")
    return plugin


@router.put("/{plugin_id}")
async def update_plugin(plugin_id: str, body: PluginUpdateRequest):
    """Update a plugin configuration."""
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    try:
        plugin = data_plugin_service.update_plugin(plugin_id, updates)
        if not plugin:
            raise HTTPException(status_code=404, detail="Plugin not found")
        return {"success": True, "plugin": plugin}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/{plugin_id}")
async def delete_plugin(plugin_id: str):
    """Delete a data plugin."""
    if not data_plugin_service.delete_plugin(plugin_id):
        raise HTTPException(status_code=404, detail="Plugin not found")
    return {"success": True}


# ── Test connectivity ───────────────────────────────────────────────────────

@router.post("/{plugin_id}/test")
async def test_plugin(plugin_id: str):
    """Test connectivity and validate response format for a plugin."""
    result = await data_plugin_service.test_plugin(plugin_id)
    return result


# ── API format documentation ────────────────────────────────────────────────

@router.get("/formats")
async def get_formats():
    """Get the expected API request/response formats for all plugin types."""
    return {"formats": data_plugin_service.get_expected_formats()}


@router.get("/variables")
async def get_contributed_variables():
    """Get variables contributed by each enabled plugin."""
    return {"variables": data_plugin_service.get_available_variables()}
