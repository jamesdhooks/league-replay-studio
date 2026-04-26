"""
project_watch_service.py
------------------------
Project directory watcher that emits websocket events when files change.

This uses lightweight polling so it works cross-platform without optional
native filesystem watcher dependencies.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from pathlib import Path
from typing import Any, Callable

from server.events import EventType, make_event
from server.services.project_service import project_service

logger = logging.getLogger(__name__)


class ProjectWatchService:
    """Poll project directories and emit project:files_changed events."""

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._broadcast_fn: Callable | None = None
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._poll_interval_seconds = 1.0
        self._last_signature: dict[int, tuple[int, int, int]] = {}

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def set_broadcast_fn(self, fn: Callable) -> None:
        self._broadcast_fn = fn

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="project-watch")
        self._thread.start()
        logger.info("[ProjectWatch] Started")

    def stop(self) -> None:
        self._stop_event.set()
        logger.info("[ProjectWatch] Stopped")

    def _emit(self, event_type: str, data: dict[str, Any]) -> None:
        if not self._broadcast_fn:
            return
        message = make_event(event_type, data)
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(self._broadcast_fn(message), self._loop)
        else:
            try:
                self._broadcast_fn(message)
            except Exception:
                logger.debug("Suppressed exception in project watch emit", exc_info=True)

    @staticmethod
    def _signature_for_project_dir(project_dir: str) -> tuple[int, int, int] | None:
        if not project_dir:
            return None

        root = Path(project_dir)
        if not root.exists() or not root.is_dir():
            return None

        file_count = 0
        total_size = 0
        latest_mtime_ns = 0

        try:
            for file_path in root.rglob("*"):
                if not file_path.is_file():
                    continue
                try:
                    stat = file_path.stat()
                except OSError:
                    continue
                file_count += 1
                total_size += int(stat.st_size)
                latest_mtime_ns = max(latest_mtime_ns, int(stat.st_mtime_ns))
        except OSError:
            return None

        return (file_count, total_size, latest_mtime_ns)

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                projects = project_service.list_projects(sort_by="id", sort_dir="asc")
                active_project_ids = set()

                for project in projects:
                    project_id = int(project.get("id", 0) or 0)
                    if project_id <= 0:
                        continue
                    active_project_ids.add(project_id)

                    signature = self._signature_for_project_dir(project.get("project_dir", ""))
                    if signature is None:
                        continue

                    prev = self._last_signature.get(project_id)
                    if prev is None:
                        self._last_signature[project_id] = signature
                        continue

                    if signature != prev:
                        self._last_signature[project_id] = signature
                        self._emit(EventType.PROJECT_FILES_CHANGED, {
                            "project_id": project_id,
                            "file_count": signature[0],
                            "total_size": signature[1],
                            "changed_at": time.time(),
                        })

                # Remove stale cache entries for deleted projects.
                stale = [pid for pid in self._last_signature if pid not in active_project_ids]
                for pid in stale:
                    self._last_signature.pop(pid, None)

            except Exception:
                logger.exception("[ProjectWatch] Poll cycle failed")

            self._stop_event.wait(self._poll_interval_seconds)


project_watch_service = ProjectWatchService()
