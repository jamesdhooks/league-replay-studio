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

import json
import time
import threading
from collections import deque
from pathlib import Path
from typing import Any, Callable

MAX_ENTRIES = 500  # keep last N commands in memory


class CommandLog:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: deque[dict] = deque(maxlen=MAX_ENTRIES)
        self._broadcast_fn: Callable | None = None
        self._seq = 0
        self._file_path: Path | None = None
        self._file_max_bytes = 2_000_000

    # ── Configuration ──────────────────────────────────────────────────────

    def set_broadcast_fn(self, fn: Callable) -> None:
        """Set the async broadcast function (called with the WS message dict)."""
        self._broadcast_fn = fn

    def configure_file(self, file_path: Path, max_bytes: int = 2_000_000) -> None:
        """Enable persistent JSONL logging for command entries."""
        self._file_path = file_path
        self._file_max_bytes = max(100_000, int(max_bytes))
        self._file_path.parent.mkdir(parents=True, exist_ok=True)
        self._truncate_if_needed()

    def _truncate_if_needed(self) -> None:
        if self._file_path is None or not self._file_path.exists():
            return
        try:
            if self._file_path.stat().st_size > self._file_max_bytes:
                # Keep the tail so the most recent interactions remain available.
                tail = self._file_path.read_bytes()[-200_000:]
                self._file_path.write_bytes(tail)
        except OSError:
            pass

    def _append_file(self, entry: dict) -> None:
        if self._file_path is None:
            return
        try:
            line = json.dumps(entry, ensure_ascii=False)
            with self._file_path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass

    # ── Recording ─────────────────────────────────────────────────────────

    def record(self, command: str, params: dict[str, Any] | None = None,
               result: str = "ok", source: str = "unknown") -> None:
        """Add a command entry and broadcast it via WebSocket if wired up."""
        with self._lock:
            self._seq += 1
            entry = {
                "seq":     self._seq,
                "ts":      time.time(),
                "command": command,
                "params":  params or {},
                "result":  result,
                "source":  source,
            }
            self._entries.append(entry)
            self._truncate_if_needed()
            self._append_file(entry)

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
