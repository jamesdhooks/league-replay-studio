from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

from server.config import LOG_DIR


class DebugLogService:
    """Write structured debug events to an explicit debug.log JSONL file."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._file_path: Path = LOG_DIR / "debug.log"
        self._max_bytes = 10_000_000
        self._tail_keep_bytes = 750_000

    def configure_file(self, file_path: Path, max_bytes: int = 10_000_000) -> None:
        self._file_path = file_path
        self._max_bytes = max(500_000, int(max_bytes))
        self._file_path.parent.mkdir(parents=True, exist_ok=True)

    def _truncate_if_needed(self) -> None:
        if not self._file_path.exists():
            return
        try:
            if self._file_path.stat().st_size > self._max_bytes:
                tail = self._file_path.read_bytes()[-self._tail_keep_bytes :]
                self._file_path.write_bytes(tail)
        except OSError:
            pass

    def write(self, event: str, payload: dict[str, Any]) -> None:
        entry = {
            "ts": time.time(),
            "event": event,
            "payload": payload,
        }
        with self._lock:
            self._file_path.parent.mkdir(parents=True, exist_ok=True)
            self._truncate_if_needed()
            try:
                with self._file_path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
            except OSError:
                pass


debug_log_service = DebugLogService()
