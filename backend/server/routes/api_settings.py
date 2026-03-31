"""
api_settings.py
----------------
REST endpoints for application settings.

GET   /api/settings       — returns all settings
PUT   /api/settings       — update settings (partial update, validated)
POST  /api/settings/reset — reset all settings to defaults
"""

from fastapi import APIRouter, HTTPException
from typing import Any, Dict

from server.services.settings_service import settings_service, SettingsValidationError

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("/")
async def get_settings() -> dict:
    """Get all application settings."""
    return settings_service.get_all()


@router.put("/")
async def update_settings(updates: Dict[str, Any]) -> dict:
    """Update application settings (partial update).

    Validates all values before applying. Returns the full settings dict.
    Returns 422 if any values are invalid.
    """
    try:
        return settings_service.update(updates)
    except SettingsValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail={"error": "validation_error", "message": str(exc), "errors": exc.errors},
        )


@router.post("/reset")
async def reset_settings() -> dict:
    """Reset all settings to their default values."""
    return settings_service.reset_to_defaults()
