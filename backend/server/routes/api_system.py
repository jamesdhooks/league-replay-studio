"""
api_system.py
--------------
System information and health check endpoints.

GET  /api/system/info           — system info (version, platform, etc.)
GET  /api/system/health         — health check
GET  /api/system/update-check   — check for updates
POST /api/system/browse         — open native folder/file picker dialog
"""

import platform
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from version import __version__, APP_NAME
from server.services.update_service import update_service

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


@router.get("/update-check")
async def check_for_updates(force: bool = False) -> dict:
    """Check for available updates via GitHub Releases API.

    Query params:
        force: Bypass cached result and check immediately.
    """
    info = await update_service.check_for_updates(force=force)
    return info.to_dict()


class BrowseRequest(BaseModel):
    mode: str = "folder"  # "folder" or "file"
    title: str = "Select"
    initial_dir: str = ""
    file_types: Optional[list[list[str]]] = None  # e.g. [["Replay Files", "*.rpy"]]


@router.post("/browse")
async def browse_dialog(req: BrowseRequest) -> dict:
    """Open a native folder or file picker dialog.

    Returns the selected path or empty string if cancelled.
    """
    import asyncio

    result = {"path": ""}

    def _run_dialog():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)

            initial = req.initial_dir if req.initial_dir and Path(req.initial_dir).exists() else str(Path.home())

            if req.mode == "folder":
                path = filedialog.askdirectory(
                    title=req.title,
                    initialdir=initial,
                )
            else:
                filetypes = [tuple(ft) for ft in req.file_types] if req.file_types else [("All Files", "*.*")]
                path = filedialog.askopenfilename(
                    title=req.title,
                    initialdir=initial,
                    filetypes=filetypes,
                )

            root.destroy()
            result["path"] = path or ""
        except Exception:
            result["path"] = ""

    # tkinter must run on a non-asyncio thread
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _run_dialog)

    return result
