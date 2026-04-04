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


# ── Frontend error reporting ─────────────────────────────────────────────────

import logging as _logging

_frontend_logger = _logging.getLogger("frontend")


class FrontendErrorReport(BaseModel):
    """Error report from the frontend React application."""
    message: str
    source: str = "unknown"     # Component or module name
    stack: str = ""             # JavaScript stack trace
    level: str = "error"        # error | warning | info
    category: str = "UI"        # UI, NETWORK, RENDER, etc.
    user_agent: str = ""


@router.post("/report-error")
async def report_frontend_error(report: FrontendErrorReport) -> dict:
    """Receive and log errors from the frontend application.

    This allows the backend log to capture frontend errors for unified debugging.
    """
    log_fn = {
        "error": _frontend_logger.error,
        "warning": _frontend_logger.warning,
        "info": _frontend_logger.info,
    }.get(report.level, _frontend_logger.error)

    log_fn(
        "[%s] %s — source: %s | stack: %s",
        report.category,
        report.message,
        report.source,
        report.stack[:200] if report.stack else "(none)",
    )

    return {"status": "logged"}


@router.get("/logs")
async def get_recent_logs(lines: int = 100) -> dict:
    """Return the most recent log lines from the application log file.

    Query params:
        lines: Number of recent lines to return (default: 100, max: 500).
    """
    from server.config import LOG_DIR

    lines = min(lines, 500)
    log_path = LOG_DIR / "app.log"

    if not log_path.exists():
        return {"lines": [], "total_size": 0}

    try:
        content = log_path.read_text(encoding="utf-8", errors="replace")
        all_lines = content.strip().split("\n")
        recent = all_lines[-lines:] if len(all_lines) > lines else all_lines
        return {
            "lines": recent,
            "total_lines": len(all_lines),
            "total_size": log_path.stat().st_size,
        }
    except OSError:
        return {"lines": [], "total_size": 0}

