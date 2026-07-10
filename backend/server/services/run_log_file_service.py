"""
run_log_file_service.py
-----------------------
Durable timestamped JSON run logs for long-running workflow steps.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from server.config import DATA_DIR

logger = logging.getLogger(__name__)

_SAFE_ID_RE = re.compile(r"[^a-zA-Z0-9_.-]+")


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def _safe_id(value: str) -> str:
    cleaned = _SAFE_ID_RE.sub("_", str(value or "run")).strip("_")
    return cleaned[:80] or "run"


class RunLogFileService:
    """Write full run-log snapshots to timestamped JSON files.

    Each append rewrites the full JSON payload so a crash still leaves the
    latest complete entry list on disk. A stable ``latest_<scope>.json`` is
    also updated for quick inspection.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()

    def start_run(
        self,
        *,
        scope: str,
        run_id: str,
        project_id: int | None = None,
        project_dir: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str | None:
        log_path, latest_path = self._paths(scope, run_id, project_dir)
        payload = {
            "schema": "league-replay-studio.run-log",
            "schema_version": 1,
            "scope": scope,
            "run_id": run_id,
            "project_id": project_id,
            "created_at": _utc_iso(),
            "updated_at": _utc_iso(),
            "entry_count": 0,
            "metadata": metadata or {},
            "entries": [],
        }
        if self._write_payload(log_path, payload, latest_path):
            return str(log_path)
        return None

    def append_entry(
        self,
        log_file_path: str | None,
        entry: dict[str, Any],
        *,
        latest_path: str | None = None,
        metadata: dict[str, Any] | None = None,
        state: str | None = None,
        error: str | None = None,
    ) -> None:
        if not log_file_path:
            return
        with self._lock:
            path = Path(log_file_path)
            payload = self._read_payload(path)
            entries = payload.setdefault("entries", [])
            entries.append(entry)
            payload["entry_count"] = len(entries)
            payload["updated_at"] = _utc_iso()
            if metadata:
                current = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
                current.update(metadata)
                payload["metadata"] = current
            if state:
                payload["state"] = state
            if error:
                payload["error"] = error
            self._write_payload(path, payload, Path(latest_path) if latest_path else None)

    def write_snapshot(
        self,
        log_file_path: str | None,
        entries: list[dict[str, Any]],
        *,
        latest_path: str | None = None,
        metadata: dict[str, Any] | None = None,
        state: str | None = None,
        error: str | None = None,
    ) -> None:
        if not log_file_path:
            return
        with self._lock:
            path = Path(log_file_path)
            payload = self._read_payload(path)
            payload["entries"] = list(entries)
            payload["entry_count"] = len(entries)
            payload["updated_at"] = _utc_iso()
            if metadata:
                current = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
                current.update(metadata)
                payload["metadata"] = current
            if state:
                payload["state"] = state
            if error:
                payload["error"] = error
            self._write_payload(path, payload, Path(latest_path) if latest_path else None)

    def latest_path_for(self, log_file_path: str | None) -> str | None:
        if not log_file_path:
            return None
        path = Path(log_file_path)
        payload = self._read_payload(path)
        scope = payload.get("scope") or path.parent.name
        return str(path.parent / f"latest_{_safe_id(scope)}.json")

    def _paths(self, scope: str, run_id: str, project_dir: str | None) -> tuple[Path, Path]:
        safe_scope = _safe_id(scope)
        safe_run_id = _safe_id(run_id)
        if project_dir:
            base_dir = Path(project_dir) / "run_logs" / safe_scope
        else:
            base_dir = DATA_DIR / "run_logs" / safe_scope
        base_dir.mkdir(parents=True, exist_ok=True)
        log_path = base_dir / f"{safe_scope}_{safe_run_id}_{_stamp()}.json"
        latest_path = base_dir / f"latest_{safe_scope}.json"
        return log_path, latest_path

    def _read_payload(self, path: Path) -> dict[str, Any]:
        try:
            if path.is_file():
                payload = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(payload, dict):
                    return payload
        except Exception as exc:
            logger.debug("[RunLog] Could not read %s: %s", path, exc)
        return {
            "schema": "league-replay-studio.run-log",
            "schema_version": 1,
            "created_at": _utc_iso(),
            "entries": [],
        }

    def _write_payload(self, path: Path, payload: dict[str, Any], latest_path: Path | None) -> bool:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            serialized = json.dumps(payload, indent=2, ensure_ascii=True, default=str)
            tmp_path = path.with_suffix(path.suffix + ".tmp")
            tmp_path.write_text(serialized, encoding="utf-8")
            tmp_path.replace(path)
            if latest_path:
                latest_path.write_text(serialized, encoding="utf-8")
            return True
        except Exception as exc:
            logger.error("[RunLog] Failed writing %s: %s", path, exc)
            return False


run_log_file_service = RunLogFileService()
