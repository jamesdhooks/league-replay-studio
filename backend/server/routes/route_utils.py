"""
route_utils.py
--------------
Shared helpers for route handlers to reduce boilerplate.

Provides project/DB lookup helpers and a safe endpoint decorator
that standardizes error handling across all API routes.
"""

from __future__ import annotations

import functools
import logging
from typing import Any

from fastapi import HTTPException

from server.services.project_service import project_service
from server.services.analysis_db import get_project_db, init_analysis_db

logger = logging.getLogger(__name__)


def get_project_or_404(project_id: int) -> dict:
    """Look up a project by ID or raise 404."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found")
    return project


def get_project_dir_or_404(project_id: int) -> str:
    """Look up a project's directory by ID or raise 404."""
    return get_project_or_404(project_id)["project_dir"]


def get_project_db_or_404(project_id: int):
    """Look up project and return an initialized analysis DB connection, or raise 404.

    Returns (conn, project_dir) tuple. Caller is responsible for closing conn.
    """
    project_dir = get_project_dir_or_404(project_id)
    init_analysis_db(project_dir)
    conn = get_project_db(project_dir)
    return conn, project_dir


def safe_endpoint(context: str = "API"):
    """Decorator that wraps a route handler with standard error handling.

    - Re-raises HTTPException as-is
    - Catches all other exceptions, logs them, and returns 500

    Usage:
        @router.get("/path")
        @safe_endpoint("Analysis")
        async def my_endpoint(...):
            ...
    """
    def decorator(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            try:
                return await fn(*args, **kwargs)
            except HTTPException:
                raise
            except Exception as exc:
                logger.error("[%s] %s error: %s", context, fn.__name__, exc, exc_info=True)
                raise HTTPException(status_code=500, detail=str(exc)) from exc
        return wrapper
    return decorator
