"""
api_system.py
--------------
System information and health check endpoints.

GET /api/system/info     — system info (version, platform, etc.)
GET /api/system/health   — health check
"""

import platform
import sys
from datetime import datetime, timezone

from fastapi import APIRouter

from version import __version__, APP_NAME

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/health")
async def health_check() -> dict:
    """Health check endpoint."""
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@router.get("/info")
async def system_info() -> dict:
    """System information including version, platform, and capabilities."""
    return {
        "app_name": APP_NAME,
        "version": __version__,
        "python_version": sys.version,
        "platform": platform.system(),
        "platform_version": platform.version(),
        "architecture": platform.machine(),
        "frozen": getattr(sys, "frozen", False),
    }
