"""
command_log.py
--------------
Thread-safe ring buffer that records every command sent to iRacing and
optionally broadcasts each entry via WebSocket.

Usage:
    from server.utils.command_log import command_log

    # At startup (app.py):
    command_log.set_broadcast_fn(my_broadcast_fn)

    # At each iRacing API call:
    command_log.record("seek-time", {"session_time_ms": 12345, "session_num": 0})
"""

from __future__ import annotations

import time
import threading
from collections import deque
from typing import Any, Callable

MAX_ENTRIES = 500  # keep last N commands in memory


class CommandLog:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: deque[dict] = deque(maxlen=MAX_ENTRIES)
        self._broadcast_fn: Callable | None = None
        self._seq = 0

    # ── Configuration ──────────────────────────────────────────────────────

    def set_broadcast_fn(self, fn: Callable) -> None:
        """Set the async broadcast function (called with the WS message dict)."""
        self._broadcast_fn = fn

    # ── Recording ─────────────────────────────────────────────────────────

    def record(self, command: str, params: dict[str, Any] | None = None,
               result: str = "ok") -> None:
        """Add a command entry and broadcast it via WebSocket if wired up."""
        with self._lock:
            self._seq += 1
            entry = {
                "seq":     self._seq,
                "ts":      time.time(),
                "command": command,
                "params":  params or {},
                "result":  result,
            }
            self._entries.append(entry)

        if self._broadcast_fn is not None:
            msg = {"event": "iracing:command", "data": entry}
            try:
                self._broadcast_fn(msg)
            except Exception:
                pass

    # ── Query ──────────────────────────────────────────────────────────────

    def get_all(self) -> list[dict]:
        """Return all stored entries (oldest first)."""
        with self._lock:
            return list(self._entries)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


command_log = CommandLog()
