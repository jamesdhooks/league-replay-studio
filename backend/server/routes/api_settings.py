"""
api_settings.py
----------------
REST endpoints for application settings.

GET  /api/settings       — returns all settings
PUT  /api/settings       — update settings (partial update)
"""

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Any, Dict

from server.services.settings_service import settings_service

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsUpdate(BaseModel):
    """Partial settings update. Any key/value pairs to update."""
    # Accept arbitrary keys
    class Config:
        extra = "allow"


@router.get("/")
async def get_settings() -> dict:
    """Get all application settings."""
    return settings_service.get_all()


@router.put("/")
async def update_settings(updates: Dict[str, Any]) -> dict:
    """Update application settings (partial update)."""
    return settings_service.update(updates)
