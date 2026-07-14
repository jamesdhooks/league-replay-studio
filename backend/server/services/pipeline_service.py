"""
pipeline_service.py
--------------------
One-click automated pipeline service.

Manages the full pipeline lifecycle:
  Analysis → Editing → Capture → Export → Upload

Supports:
- Sequential step execution with real-time progress
- Pause/resume/cancel/retry per step
- Pipeline configuration presets CRUD
- Failure recovery from failed step (not from scratch)
- Persistent state in SQLite for crash recovery
- Optional YouTube upload as final step
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Optional

from server.config import DATA_DIR
from server.events import EventType, make_event
from server.services.run_log_file_service import run_log_file_service

logger = logging.getLogger(__name__)


def _format_race_time(seconds: float) -> str:
    """Format race session time as M:SS or H:MM:SS."""
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


# ── Pipeline States ─────────────────────────────────────────────────────────

class PipelineState(str, Enum):
    """Pipeline run states."""
    IDLE = "idle"
    RUNNING = "running"
    PAUSED = "paused"
    WAITING_INTERVENTION = "waiting_intervention"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"


class StepState(str, Enum):
    """Individual step states."""
    PENDING = "pending"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    SKIPPED = "skipped"
    FAILED = "failed"


class StepName(str, Enum):
    """Pipeline step identifiers."""
    ANALYSIS = "analysis"
    EDITING = "editing"
    CAPTURE = "capture"
    COMPOSE = "compose"
    EXPORT = "export"
    UPLOAD = "upload"


class FailureAction(str, Enum):
    """Action to take on step failure."""
    PAUSE = "pause"    # Default: pause pipeline for user intervention
    SKIP = "skip"      # Skip the failed step and continue
    ABORT = "abort"    # Abort the entire pipeline


# ── Pipeline Step ───────────────────────────────────────────────────────────

@dataclass
class PipelineStep:
    """Represents a single step in the pipeline."""
    name: StepName
    state: StepState = StepState.PENDING
    progress: float = 0.0
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    error: Optional[str] = None
    output: dict = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Convert to serializable dict."""
        return {
            "name": self.name.value,
            "state": self.state.value,
            "progress": self.progress,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "error": self.error,
            "output": self.output,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PipelineStep:
        """Create from dict."""
        return cls(
            name=StepName(data["name"]),
            state=StepState(data["state"]),
            progress=data.get("progress", 0.0),
            started_at=data.get("started_at"),
            completed_at=data.get("completed_at"),
            error=data.get("error"),
            output=data.get("output", {}),
        )


# ── Pipeline Run ────────────────────────────────────────────────────────────

@dataclass
class PipelineRun:
    """Represents a full pipeline execution."""
    run_id: str
    project_id: int
    state: PipelineState = PipelineState.IDLE
    current_step: Optional[StepName] = None
    steps: dict[StepName, PipelineStep] = field(default_factory=dict)
    config: dict = field(default_factory=dict)
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    error: Optional[str] = None
    log_file_path: Optional[str] = None

    def __post_init__(self):
        """Initialise default steps if empty."""
        if not self.steps:
            self.steps = {
                StepName.ANALYSIS: PipelineStep(name=StepName.ANALYSIS),
                StepName.EDITING: PipelineStep(name=StepName.EDITING),
                StepName.CAPTURE: PipelineStep(name=StepName.CAPTURE),
                StepName.COMPOSE: PipelineStep(name=StepName.COMPOSE),
                StepName.EXPORT: PipelineStep(name=StepName.EXPORT),
                StepName.UPLOAD: PipelineStep(name=StepName.UPLOAD),
            }

    def to_dict(self) -> dict[str, Any]:
        """Convert to serializable dict."""
        return {
            "run_id": self.run_id,
            "project_id": self.project_id,
            "state": self.state.value,
            "current_step": self.current_step.value if self.current_step else None,
            "steps": {k.value: v.to_dict() for k, v in self.steps.items()},
            "config": self.config,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "error": self.error,
            "log_file_path": self.log_file_path,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PipelineRun:
        """Create from dict."""
        steps = {}
        for step_name, step_data in data.get("steps", {}).items():
            step_enum = StepName(step_name)
            steps[step_enum] = PipelineStep.from_dict(step_data)

        return cls(
            run_id=data["run_id"],
            project_id=data["project_id"],
            state=PipelineState(data["state"]),
            current_step=StepName(data["current_step"]) if data.get("current_step") else None,
            steps=steps,
            config=data.get("config", {}),
            started_at=data.get("started_at"),
            completed_at=data.get("completed_at"),
            error=data.get("error"),
            log_file_path=data.get("log_file_path"),
        )


# ── Pipeline Preset ─────────────────────────────────────────────────────────

# ── Execution Spec Keys ─────────────────────────────────────────────────────
# These are the canonical keys for the full Pipeline Execution Spec.
# Anything not in this set is rejected as an unknown field when validating.
EXECUTION_SPEC_FIELDS = frozenset({
    # ── Execution path (step toggles) ──────────────────────────────────────
    # These fields are NOT stored in presets.  They are set at run-time via
    # CLI flags or per-project augmentations in the control-state envelope.
    "skip_capture", "skip_analysis", "skip_compose", "skip_export",
    "auto_edit",          # False = skip highlight-selection / editing step
    "upload_to_youtube",  # True  = run the upload step after export
    # ── Preset config (step behaviour/quality) ─────────────────────────────
    # Upload
    "youtube_privacy",
    # Export
    "export_preset", "output_dir",
    # Highlight/editing config (applies when auto_edit is active)
    "highlight_config",       # dict: weights, target_duration, min_severity, params, overrides
    # Overlay
    "overlay_preset_id", "overlay_variables",
    # Capture
    "capture_mode",           # "auto" | "script" | "legacy"
    # Error handling
    "failure_action", "notify_on_completion",
    # Runtime flags
    "non_interactive",        # bool: suppress all user-intervention steps
    "video_script",           # list[dict]: pre-built composition script (runtime only)
})

# Subset of EXECUTION_SPEC_FIELDS that represent execution-path toggles.
# These are intentionally excluded from PipelinePreset storage.
STEP_TOGGLE_FIELDS = frozenset({
    "skip_capture", "skip_analysis", "skip_compose", "skip_export",
    "auto_edit", "upload_to_youtube",
})


@dataclass
class PipelinePreset:
    """Pipeline configuration preset.

    Stores *how* each step is configured (quality, behaviour, error handling),
    NOT which steps to run.  Step on/off toggles (skip_capture, auto_edit, etc.)
    are execution-path decisions supplied at run-time via CLI flags or
    per-project augmentations in the control-state envelope.
    """
    id: str
    name: str
    description: str = ""
    schema_version: int = 1
    # Export
    export_preset: Optional[str] = None
    output_dir: Optional[str] = None
    # Highlight config snapshot
    highlight_config: dict = field(default_factory=dict)
    # Overlay
    overlay_preset_id: Optional[str] = None
    overlay_variables: dict = field(default_factory=dict)
    # Capture
    capture_mode: str = "auto"   # "auto" | "script" | "legacy"
    # Upload config (privacy applies when upload step is active)
    youtube_privacy: str = "unlisted"
    # Error handling
    failure_action: FailureAction = FailureAction.PAUSE
    notify_on_completion: str = "toast"
    # Runtime flags
    non_interactive: bool = False
    # Metadata
    created_at: Optional[float] = None
    updated_at: Optional[float] = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to serializable dict."""
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "schema_version": self.schema_version,
            "export_preset": self.export_preset,
            "output_dir": self.output_dir,
            "highlight_config": self.highlight_config,
            "overlay_preset_id": self.overlay_preset_id,
            "overlay_variables": self.overlay_variables,
            "capture_mode": self.capture_mode,
            "youtube_privacy": self.youtube_privacy,
            "failure_action": self.failure_action.value,
            "notify_on_completion": self.notify_on_completion,
            "non_interactive": self.non_interactive,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PipelinePreset:
        """Create from dict.  Step-toggle keys are silently ignored."""
        return cls(
            id=data["id"],
            name=data["name"],
            description=data.get("description", ""),
            schema_version=data.get("schema_version", 1),
            export_preset=data.get("export_preset"),
            output_dir=data.get("output_dir"),
            highlight_config=data.get("highlight_config") or {},
            overlay_preset_id=data.get("overlay_preset_id"),
            overlay_variables=data.get("overlay_variables") or {},
            capture_mode=data.get("capture_mode", "auto"),
            youtube_privacy=data.get("youtube_privacy", "unlisted"),
            failure_action=FailureAction(data.get("failure_action", "pause")),
            notify_on_completion=data.get("notify_on_completion", "toast"),
            non_interactive=data.get("non_interactive", False),
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
        )


# ── Database Schema ─────────────────────────────────────────────────────────

_PIPELINE_SCHEMA = """
CREATE TABLE IF NOT EXISTS pipeline_runs (
    run_id          TEXT PRIMARY KEY,
    project_id      INTEGER NOT NULL,
    state           TEXT NOT NULL DEFAULT 'idle',
    current_step    TEXT,
    steps_json      TEXT NOT NULL DEFAULT '{}',
    config_json     TEXT NOT NULL DEFAULT '{}',
    started_at      REAL,
    completed_at    REAL,
    error           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pipeline_presets (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    description     TEXT DEFAULT '',
    config_json     TEXT NOT NULL DEFAULT '{}',
    created_at      REAL,
    updated_at      REAL
);

CREATE TABLE IF NOT EXISTS pipeline_step_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT NOT NULL,
    step            TEXT NOT NULL,
    level           TEXT NOT NULL DEFAULT 'info',
    ts              REAL NOT NULL,
    message         TEXT NOT NULL DEFAULT '',
    detail          TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (run_id) REFERENCES pipeline_runs(run_id)
);

CREATE TABLE IF NOT EXISTS project_control_state (
    project_id      INTEGER NOT NULL,
    preset_id       TEXT NOT NULL DEFAULT '',
    augmentations_json TEXT NOT NULL DEFAULT '{}',
    updated_at      REAL,
    PRIMARY KEY (project_id)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project ON pipeline_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_state ON pipeline_runs(state);
CREATE INDEX IF NOT EXISTS idx_step_logs_run ON pipeline_step_logs(run_id);
"""


# ── Pipeline Service ────────────────────────────────────────────────────────

class PipelineService:
    """Singleton service managing one-click automated pipelines."""

    def __init__(self) -> None:
        self._current_run: Optional[PipelineRun] = None
        self._presets: dict[str, PipelinePreset] = {}
        self._broadcast_fn: Optional[Callable] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._executor_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._pause_event = threading.Event()
        self._lock = threading.Lock()
        self._db_path = DATA_DIR / "pipeline.db"
        self._init_db()
        self._load_presets()
        self._restore_interrupted_run()

    # ── Database ────────────────────────────────────────────────────────────

    def _get_connection(self) -> sqlite3.Connection:
        """Return a connection to the pipeline database."""
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self._db_path), timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_db(self) -> None:
        """Initialise the pipeline database and run incremental migrations."""
        conn = self._get_connection()
        try:
            conn.executescript(_PIPELINE_SCHEMA)
            conn.commit()
            # Migration: rename legacy table/column if they still exist.
            tables = {r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()}
            if "project_pipeline_overrides" in tables and "project_control_state" not in tables:
                conn.execute(
                    "ALTER TABLE project_pipeline_overrides RENAME TO project_control_state"
                )
                conn.commit()
                logger.info("[Pipeline] Migrated table project_pipeline_overrides → project_control_state")
            if "project_control_state" in tables:
                cols = {r[1] for r in conn.execute(
                    "PRAGMA table_info(project_control_state)"
                ).fetchall()}
                if "override_json" in cols and "augmentations_json" not in cols:
                    conn.execute(
                        "ALTER TABLE project_control_state RENAME COLUMN override_json TO augmentations_json"
                    )
                    conn.commit()
                    logger.info("[Pipeline] Migrated column override_json → augmentations_json")

            # Migration: remove legacy built-in presets that are no longer relevant.
            deleted = conn.execute(
                """
                DELETE FROM pipeline_presets
                WHERE id IN ('quick-highlight', 'full-pipeline', 'analysis-only')
                """
            ).rowcount
            if deleted:
                conn.commit()
                logger.info("[Pipeline] Removed %d legacy default presets", deleted)
            logger.info("[Pipeline] Database initialised at %s", self._db_path)
        finally:
            conn.close()

    def _persist_run(self, run: PipelineRun) -> None:
        """Persist the current pipeline run to the database."""
        conn = self._get_connection()
        try:
            conn.execute(
                """
                INSERT OR REPLACE INTO pipeline_runs
                (run_id, project_id, state, current_step, steps_json, config_json,
                 started_at, completed_at, error, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                """,
                (
                    run.run_id,
                    run.project_id,
                    run.state.value,
                    run.current_step.value if run.current_step else None,
                    json.dumps({k.value: v.to_dict() for k, v in run.steps.items()}),
                    json.dumps(run.config),
                    run.started_at,
                    run.completed_at,
                    run.error,
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def _load_run(self, run_id: str) -> Optional[PipelineRun]:
        """Load a pipeline run from the database."""
        conn = self._get_connection()
        try:
            row = conn.execute(
                "SELECT * FROM pipeline_runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if row:
                return PipelineRun.from_dict({
                    "run_id": row["run_id"],
                    "project_id": row["project_id"],
                    "state": row["state"],
                    "current_step": row["current_step"],
                    "steps": json.loads(row["steps_json"]),
                    "config": json.loads(row["config_json"]),
                    "started_at": row["started_at"],
                    "completed_at": row["completed_at"],
                    "error": row["error"],
                })
            return None
        finally:
            conn.close()

    @staticmethod
    def _step_order() -> list[StepName]:
        return [
            StepName.ANALYSIS,
            StepName.EDITING,
            StepName.CAPTURE,
            StepName.COMPOSE,
            StepName.EXPORT,
            StepName.UPLOAD,
        ]

    def _next_actionable_step(self, run: PipelineRun) -> Optional[StepName]:
        for step_name in self._step_order():
            step = run.steps.get(step_name)
            if not step:
                continue
            if step.state in (StepState.PENDING, StepState.RUNNING, StepState.PAUSED, StepState.FAILED):
                return step_name
        return None

    def _normalize_run_for_recovery(self, run: PipelineRun) -> bool:
        """Repair stale persisted run state after process restart.

        Rules:
        - In-flight step states (running/paused) are reset to pending.
        - Skip-toggled steps are forced to skipped.
        - Any recovered active run is paused for explicit user resume.
        - current_step is re-derived from step states.
        """
        changed = False

        # Crash-safe reset of in-flight step markers.
        for step_name in self._step_order():
            step = run.steps.get(step_name)
            if not step:
                continue
            if step.state in (StepState.RUNNING, StepState.PAUSED):
                step.state = StepState.PENDING
                step.progress = 0.0
                step.started_at = None
                step.completed_at = None
                step.error = None
                changed = True

        # Re-apply execution-path skips from saved run config.
        skip_map = {
            StepName.ANALYSIS: bool(run.config.get("skip_analysis", False)),
            StepName.CAPTURE: bool(run.config.get("skip_capture", False)),
            StepName.COMPOSE: bool(run.config.get("skip_compose", False)),
            StepName.EXPORT: bool(run.config.get("skip_export", False)),
            StepName.UPLOAD: not bool(run.config.get("upload_to_youtube", False)),
        }
        for step_name, should_skip in skip_map.items():
            if not should_skip:
                continue
            step = run.steps.get(step_name)
            if not step:
                continue
            if step.state in (StepState.PENDING, StepState.RUNNING, StepState.PAUSED):
                step.state = StepState.SKIPPED
                step.progress = 0.0
                step.started_at = None
                step.completed_at = step.completed_at or run.started_at or time.time()
                step.error = None
                changed = True

        if run.state in (PipelineState.RUNNING, PipelineState.PAUSED, PipelineState.WAITING_INTERVENTION):
            if run.state != PipelineState.PAUSED:
                run.state = PipelineState.PAUSED
                changed = True

            next_step = self._next_actionable_step(run)
            if run.current_step != next_step:
                run.current_step = next_step
                changed = True

        return changed

    def _restore_interrupted_run(self) -> None:
        """Restore any interrupted pipeline run after app restart."""
        conn = self._get_connection()
        try:
            row = conn.execute(
                """
                SELECT * FROM pipeline_runs
                WHERE state IN ('running', 'paused', 'waiting_intervention')
                ORDER BY updated_at DESC
                LIMIT 1
                """,
            ).fetchone()
            if row:
                run = PipelineRun.from_dict({
                    "run_id": row["run_id"],
                    "project_id": row["project_id"],
                    "state": row["state"],
                    "current_step": row["current_step"],
                    "steps": json.loads(row["steps_json"]),
                    "config": json.loads(row["config_json"]),
                    "started_at": row["started_at"],
                    "completed_at": row["completed_at"],
                    "error": row["error"],
                })
                # Normalize stale in-flight step state for safe resume.
                self._normalize_run_for_recovery(run)
                self._current_run = run
                self._persist_run(run)
                logger.info("[Pipeline] Restored interrupted run: %s", run.run_id)
        finally:
            conn.close()

    def _load_presets(self) -> None:
        """Load pipeline presets from the database."""
        conn = self._get_connection()
        try:
            rows = conn.execute("SELECT * FROM pipeline_presets").fetchall()
            for row in rows:
                config = json.loads(row["config_json"])
                config["id"] = row["id"]
                config["name"] = row["name"]
                config["description"] = row["description"]
                config["created_at"] = row["created_at"]
                config["updated_at"] = row["updated_at"]
                preset = PipelinePreset.from_dict(config)
                self._presets[preset.id] = preset
            logger.info("[Pipeline] Loaded %d presets", len(self._presets))
        finally:
            conn.close()

    def _save_preset(self, preset: PipelinePreset) -> None:
        """Save a preset to the database."""
        conn = self._get_connection()
        try:
            config = preset.to_dict()
            # Remove fields stored in separate columns
            for key in ("id", "name", "description", "created_at", "updated_at"):
                config.pop(key, None)

            conn.execute(
                """
                INSERT OR REPLACE INTO pipeline_presets
                (id, name, description, config_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    preset.id,
                    preset.name,
                    preset.description,
                    json.dumps(config),
                    preset.created_at,
                    preset.updated_at,
                ),
            )
            conn.commit()
        finally:
            conn.close()

    # ── Wiring ──────────────────────────────────────────────────────────────

    def set_broadcast_fn(self, fn: Callable) -> None:
        """Set the function used to broadcast WebSocket messages."""
        self._broadcast_fn = fn

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Set the asyncio event loop for scheduling broadcasts."""
        self._loop = loop

    def _broadcast(self, event: str, data: dict) -> None:
        """Broadcast an event via WebSocket."""
        if self._broadcast_fn and self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(
                self._broadcast_fn({"event": event, "data": data}),
                self._loop,
            )

    # ── Run Logging ─────────────────────────────────────────────────────────

    def _log_step(
        self,
        step: StepName,
        message: str,
        level: str = "info",
        detail: str = "",
    ) -> None:
        """Persist and broadcast a step-level log entry."""
        run_id = self._current_run.run_id if self._current_run else ""
        if not run_id:
            return

        ts = time.time()
        entry = {
            "run_id": run_id,
            "project_id": self._current_run.project_id if self._current_run else None,
            "step": step.value,
            "level": level,
            "ts": ts,
            "message": message,
            "detail": detail,
        }
        run_log_file_service.append_entry(
            self._current_run.log_file_path if self._current_run else None,
            entry,
            latest_path=run_log_file_service.latest_path_for(
                self._current_run.log_file_path if self._current_run else None
            ),
            metadata={
                "current_step": self._current_run.current_step.value
                if self._current_run and self._current_run.current_step else None,
            },
            state=self._current_run.state.value if self._current_run else None,
            error=self._current_run.error if self._current_run else None,
        )

        # Persist
        try:
            conn = self._get_connection()
            try:
                conn.execute(
                    """
                    INSERT INTO pipeline_step_logs (run_id, step, level, ts, message, detail)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (run_id, step.value, level, ts, message, detail),
                )
                conn.commit()
            finally:
                conn.close()
        except Exception as exc:
            logger.debug("[Pipeline] Log persist error: %s", exc)

        # Broadcast to frontend
        self._broadcast("pipeline:log", entry)

    def get_run_logs(
        self,
        run_id: str,
        limit: int = 200,
        step: Optional[str] = None,
        level: Optional[str] = None,
    ) -> list[dict]:
        """Return persisted log entries for a run."""
        conn = self._get_connection()
        try:
            query = "SELECT * FROM pipeline_step_logs WHERE run_id = ?"
            params: list[Any] = [run_id]
            if step:
                query += " AND step = ?"
                params.append(step)
            if level:
                query += " AND level = ?"
                params.append(level)
            query += " ORDER BY ts DESC LIMIT ?"
            params.append(limit)
            rows = conn.execute(query, params).fetchall()
            return [
                {
                    "id": row["id"],
                    "run_id": row["run_id"],
                    "step": row["step"],
                    "level": row["level"],
                    "ts": row["ts"],
                    "message": row["message"],
                    "detail": row["detail"],
                }
                for row in reversed(rows)  # Return ascending order
            ]
        finally:
            conn.close()

    # ── Project Control State (internal helpers) ───────────────────────────

    def _get_project_augmentations(self, project_id: int) -> dict:
        """Return the saved pipeline preset + augmentations for a project.

        This is an internal helper used by get_project_control_state and
        get_effective_config.  External callers should use get_project_control_state.
        """
        conn = self._get_connection()
        try:
            row = conn.execute(
                "SELECT * FROM project_control_state WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            if row:
                return {
                    "project_id": project_id,
                    "preset_id": row["preset_id"] or "",
                    "overrides": json.loads(row["augmentations_json"]),
                    "updated_at": row["updated_at"],
                }
            return {"project_id": project_id, "preset_id": "", "overrides": {}, "updated_at": None}
        finally:
            conn.close()

    def _save_project_augmentations(
        self,
        project_id: int,
        preset_id: str = "",
        overrides: Optional[dict] = None,
    ) -> dict:
        """Persist pipeline preset + augmentations for a project.

        Only keys from EXECUTION_SPEC_FIELDS are written; all others are
        silently discarded.  External callers should use save_project_control_state.
        """
        clean_augmentations: dict = {}
        for k, v in (overrides or {}).items():
            if k in EXECUTION_SPEC_FIELDS:
                clean_augmentations[k] = v
            else:
                logger.warning("[Pipeline] Ignoring unknown augmentation key: %s", k)

        conn = self._get_connection()
        try:
            conn.execute(
                """
                INSERT OR REPLACE INTO project_control_state
                    (project_id, preset_id, augmentations_json, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (project_id, preset_id, json.dumps(clean_augmentations), time.time()),
            )
            conn.commit()
        finally:
            conn.close()

        return self._get_project_augmentations(project_id)

    def get_project_control_state(self, project_id: int) -> dict:
        """Return unified persisted control state for a project.

        This aggregates controls that currently live across multiple stores
        (pipeline overrides DB, analysis DB, and script_state.json) so the
        frontend can treat them as one canonical state envelope.
        """
        from server.services.project_service import project_service
        from server.services.analysis_db import (
            init_analysis_db,
            get_project_db,
            load_tuning_params,
            get_highlight_config,
        )
        from server.services.script_state_service import script_state_service

        project = project_service.get_project(project_id)
        if not project:
            raise ValueError(f"Project not found: {project_id}")

        project_dir = project.get("project_dir", "")
        state_record = self._get_project_augmentations(project_id)
        effective = self.get_effective_config(project_id=project_id)

        tuning_params = None
        highlight_config = None
        if project_dir:
            try:
                init_analysis_db(project_dir)
                conn = get_project_db(project_dir)
                try:
                    tuning_params = load_tuning_params(conn)
                    highlight_config = get_highlight_config(conn)
                finally:
                    conn.close()
            except Exception:
                tuning_params = None
                highlight_config = None

        script_state = script_state_service.load_state(project_dir) if project_dir else {}
        composition_config = script_state_service.get_composition_config(project_dir) if project_dir else {}
        overlay_ui_config = script_state_service.get_overlay_ui_config(project_dir) if project_dir else {}
        pip_config = script_state_service.get_pip_config(project_dir) if project_dir else {}

        return {
            "project_id": project_id,
            "schema_version": 1,
            "preset_id": state_record.get("preset_id") or "",
            "overrides": state_record.get("overrides") or {},
            "effective_config": effective,
            "controls": {
                "pipeline": {
                    "preset_id": state_record.get("preset_id") or "",
                    "overrides": state_record.get("overrides") or {},
                },
                "analysis": {
                    "tuning_params": tuning_params,
                    "highlight_config": highlight_config,
                },
                "capture": {
                    "capture_mode": script_state.get("preferred_capture_mode"),
                    "capture_range": script_state.get("capture_range"),
                    "preferred_segment_ids": script_state.get("preferred_segment_ids") or [],
                },
                "compose": {
                    "composition_config": composition_config,
                },
                "overlay": {
                    "overlay_ui_config": overlay_ui_config,
                    "pip_config": pip_config,
                },
            },
            "updated_at": state_record.get("updated_at"),
        }

    def save_project_control_state(self, project_id: int, payload: dict) -> dict:
        """Persist unified project control state envelope.

        Writes through to existing persistence layers for backward
        compatibility while exposing a single save contract.
        """
        from server.services.project_service import project_service
        from server.services.analysis_db import (
            init_analysis_db,
            get_project_db,
            save_tuning_params,
            save_highlight_config,
        )
        from server.services.script_state_service import script_state_service

        project = project_service.get_project(project_id)
        if not project:
            raise ValueError(f"Project not found: {project_id}")

        controls = payload.get("controls") or {}
        project_dir = project.get("project_dir", "")

        # 1) Pipeline preset + overrides
        pipeline_controls = controls.get("pipeline") or {}
        top_preset_id = payload.get("preset_id")
        preset_id = top_preset_id if top_preset_id is not None else (pipeline_controls.get("preset_id") or "")
        overrides = payload.get("overrides") if payload.get("overrides") is not None else pipeline_controls.get("overrides")
        self._save_project_augmentations(
            project_id=project_id,
            preset_id=preset_id or "",
            overrides=overrides or {},
        )

        # 2) Analysis controls
        analysis_controls = controls.get("analysis") or {}
        tuning_params = analysis_controls.get("tuning_params")
        highlight_config = analysis_controls.get("highlight_config")
        if project_dir and (tuning_params is not None or highlight_config is not None):
            init_analysis_db(project_dir)
            conn = get_project_db(project_dir)
            try:
                if isinstance(tuning_params, dict):
                    save_tuning_params(conn, tuning_params)
                if isinstance(highlight_config, dict):
                    weights = highlight_config.get("weights") or {}
                    target_duration = highlight_config.get("target_duration")
                    min_severity = int(highlight_config.get("min_severity", 0) or 0)
                    cfg_overrides = highlight_config.get("overrides") or {}
                    params = highlight_config.get("params") or {}
                    save_highlight_config(
                        conn,
                        weights=weights,
                        target_duration=target_duration,
                        min_severity=min_severity,
                        overrides=cfg_overrides,
                        params=params,
                    )
            finally:
                conn.close()

        # 3) Capture/compose/overlay controls (script_state)
        if project_dir:
            capture_controls = controls.get("capture") or {}
            compose_controls = controls.get("compose") or {}
            overlay_controls = controls.get("overlay") or {}

            if capture_controls.get("capture_mode") is not None:
                script_state_service.set_capture_mode(project_dir, capture_controls.get("capture_mode"))

            if "capture_range" in capture_controls:
                cap_range = capture_controls.get("capture_range")
                if isinstance(cap_range, dict):
                    script_state_service.set_capture_range(
                        project_dir,
                        cap_range.get("start"),
                        cap_range.get("end"),
                    )
                else:
                    script_state_service.set_capture_range(project_dir, None, None)

            if "preferred_segment_ids" in capture_controls:
                script_state_service.set_preferred_segment_ids(
                    project_dir,
                    capture_controls.get("preferred_segment_ids") or [],
                )

            if "composition_config" in compose_controls and isinstance(compose_controls.get("composition_config"), dict):
                script_state_service.set_composition_config(project_dir, compose_controls.get("composition_config") or {})

            if "overlay_ui_config" in overlay_controls and isinstance(overlay_controls.get("overlay_ui_config"), dict):
                script_state_service.update_overlay_ui_config(project_dir, overlay_controls.get("overlay_ui_config") or {})

            if "pip_config" in overlay_controls and isinstance(overlay_controls.get("pip_config"), dict):
                script_state_service.update_pip_config(project_dir, overlay_controls.get("pip_config") or {})

        return self.get_project_control_state(project_id)

    def get_effective_config(
        self,
        project_id: int,
        preset_id: Optional[str] = None,
        runtime_overrides: Optional[dict] = None,
    ) -> dict:
        """Resolve the effective execution config for a project run.

        Merge precedence (last wins):
          1. Global preset defaults
          2. Per-project augmentations (using project's saved preset_id unless overridden)
          3. Runtime overrides (e.g. CLI flags)
          4. Auto-populated project data (video_script from project DB)
        """
        # 1. Start with global preset
        proj_state = self._get_project_augmentations(project_id)
        resolved_preset_id = preset_id or proj_state.get("preset_id") or None

        effective: dict = {}
        if resolved_preset_id and resolved_preset_id in self._presets:
            effective = dict(self._presets[resolved_preset_id].to_dict())
        elif self._presets:
            # Fall back to first non-builtin default
            first_preset = next(iter(self._presets.values()))
            effective = dict(first_preset.to_dict())

        # 2. Apply project-level augmentations
        for k, v in proj_state.get("overrides", {}).items():
            if k in EXECUTION_SPEC_FIELDS:
                effective[k] = v

        # 3. Apply runtime overrides (CLI flags / frontend start config)
        for k, v in (runtime_overrides or {}).items():
            if k in EXECUTION_SPEC_FIELDS:
                effective[k] = v

        # 4. Auto-populate video_script from project record if not supplied explicitly
        if not effective.get("video_script"):
            try:
                from server.services.project_service import project_service
                project = project_service.get_project(project_id)
                if project and isinstance(project.get("script"), list) and project["script"]:
                    effective["video_script"] = project["script"]
            except Exception:
                pass  # Non-fatal — capture will fall back to legacy mode

        effective["resolved_preset_id"] = resolved_preset_id
        effective["project_id"] = project_id
        return effective

    def preflight_check(
        self,
        project_id: int,
        preset_id: Optional[str] = None,
        config: Optional[dict] = None,
    ) -> list[dict]:
        """Validate that the pipeline can start for a project.

        Returns a list of issue dicts:
          { "level": "error"|"warning", "code": str, "message": str }

        An empty list means all checks passed.
        """
        issues: list[dict] = []

        def _issue(level: str, code: str, message: str) -> None:
            issues.append({"level": level, "code": code, "message": message})

        # ── 1. Check not already running ─────────────────────────────────
        with self._lock:
            if self._current_run and self._current_run.state == PipelineState.RUNNING:
                _issue("error", "ALREADY_RUNNING", "A pipeline is already running")
                return issues  # No point checking further

        # ── 2. Check project exists ───────────────────────────────────────
        try:
            from server.services.project_service import project_service
            project = project_service.get_project(project_id)
        except Exception:
            project = None

        if not project:
            _issue("error", "PROJECT_NOT_FOUND", f"Project {project_id} not found")
            return issues

        # ── 3. Resolve effective config ───────────────────────────────────
        try:
            effective = self.get_effective_config(
                project_id=project_id,
                preset_id=preset_id,
                runtime_overrides=config,
            )
        except Exception as exc:
            _issue("error", "CONFIG_RESOLVE_FAILED", f"Could not resolve config: {exc}")
            return issues

        # ── 4. Output directory is writable ───────────────────────────────
        output_dir = effective.get("output_dir") or project.get("project_dir", "")
        if output_dir:
            output_path = Path(output_dir)
            if not output_path.exists():
                try:
                    output_path.mkdir(parents=True, exist_ok=True)
                except Exception:
                    _issue("error", "OUTPUT_DIR_NOT_WRITABLE",
                           f"Output directory cannot be created: {output_dir}")
            elif not os.access(str(output_path), os.W_OK):
                _issue("error", "OUTPUT_DIR_NOT_WRITABLE",
                       f"Output directory is not writable: {output_dir}")

        # ── 5. Capture prerequisites ──────────────────────────────────────
        if not effective.get("skip_capture"):
            from server.services.iracing_bridge import bridge as iracing_bridge
            if not iracing_bridge.is_connected:
                # Check if a replay file already exists as fallback
                replay_file = project.get("replay_file", "")
                if not replay_file or not Path(replay_file).exists():
                    _issue("error", "IRACING_NOT_CONNECTED",
                           "iRacing is not connected and no replay file found — capture will fail")
                else:
                    _issue("warning", "IRACING_NOT_CONNECTED_REPLAY_OK",
                           "iRacing is not connected but replay file exists — capture will be skipped")

        # ── 6. Analysis prerequisites ─────────────────────────────────────
        if not effective.get("skip_analysis"):
            replay_file = project.get("replay_file", "")
            if not replay_file:
                _issue("warning", "NO_REPLAY_FILE",
                       "No replay file set — analysis requires a replay file or prior capture")

        # ── 7. Export preset exists ───────────────────────────────────────
        export_preset_name = effective.get("export_preset")
        if export_preset_name:
            try:
                from server.services.encoding_service import encoding_service
                presets = encoding_service.list_presets() if hasattr(encoding_service, "list_presets") else []
                names = [p.get("name", "") for p in presets]
                if export_preset_name not in names and export_preset_name not in [p.get("id", "") for p in presets]:
                    _issue("warning", "EXPORT_PRESET_NOT_FOUND",
                           f"Export preset '{export_preset_name}' not found — default will be used")
            except Exception:
                pass  # Non-fatal

        # ── 8. Upload readiness ───────────────────────────────────────────
        if effective.get("upload_to_youtube"):
            try:
                from server.services.youtube_service import youtube_service
                if not youtube_service.is_authenticated:
                    _issue("warning", "YOUTUBE_NOT_AUTHENTICATED",
                           "YouTube upload is enabled but not authenticated — upload step will fail")
            except Exception:
                pass  # Non-fatal

        return issues

    # ── Status ──────────────────────────────────────────────────────────────

    @property
    def status(self) -> dict[str, Any]:
        """Return current pipeline status."""
        with self._lock:
            if self._current_run:
                return {
                    "run": self._current_run.to_dict(),
                    "is_running": self._current_run.state == PipelineState.RUNNING,
                    "is_paused": self._current_run.state == PipelineState.PAUSED,
                    "can_resume": self._current_run.state in (
                        PipelineState.PAUSED,
                        PipelineState.WAITING_INTERVENTION,
                    ),
                }
            return {
                "run": None,
                "is_running": False,
                "is_paused": False,
                "can_resume": False,
            }

    def get_run_history(self, limit: int = 20) -> list[dict]:
        """Get recent pipeline run history."""
        conn = self._get_connection()
        try:
            rows = conn.execute(
                """
                SELECT * FROM pipeline_runs
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            return [
                PipelineRun.from_dict({
                    "run_id": row["run_id"],
                    "project_id": row["project_id"],
                    "state": row["state"],
                    "current_step": row["current_step"],
                    "steps": json.loads(row["steps_json"]),
                    "config": json.loads(row["config_json"]),
                    "started_at": row["started_at"],
                    "completed_at": row["completed_at"],
                    "error": row["error"],
                }).to_dict()
                for row in rows
            ]
        finally:
            conn.close()

    # ── Presets ─────────────────────────────────────────────────────────────

    def list_presets(self) -> list[dict]:
        """List all pipeline presets."""
        return [p.to_dict() for p in self._presets.values()]

    def get_preset(self, preset_id: str) -> Optional[dict]:
        """Get a single preset by ID."""
        preset = self._presets.get(preset_id)
        return preset.to_dict() if preset else None

    def create_preset(self, data: dict) -> dict:
        """Create a new pipeline preset."""
        preset_id = data.get("id") or str(uuid.uuid4())[:8]
        now = time.time()

        preset = PipelinePreset(
            id=preset_id,
            name=data["name"],
            description=data.get("description", ""),
            export_preset=data.get("export_preset"),
            output_dir=data.get("output_dir"),
            highlight_config=data.get("highlight_config") or {},
            overlay_preset_id=data.get("overlay_preset_id"),
            overlay_variables=data.get("overlay_variables") or {},
            capture_mode=data.get("capture_mode", "auto"),
            youtube_privacy=data.get("youtube_privacy", "unlisted"),
            failure_action=FailureAction(data.get("failure_action", "pause")),
            notify_on_completion=data.get("notify_on_completion", "toast"),
            non_interactive=data.get("non_interactive", False),
            created_at=now,
            updated_at=now,
        )

        self._save_preset(preset)
        self._presets[preset.id] = preset
        logger.info("[Pipeline] Created preset: %s", preset.name)
        return preset.to_dict()

    def update_preset(self, preset_id: str, data: dict) -> Optional[dict]:
        """Update an existing preset."""
        preset = self._presets.get(preset_id)
        if not preset:
            return None

        preset.name = data.get("name", preset.name)
        preset.description = data.get("description", preset.description)
        preset.export_preset = data.get("export_preset", preset.export_preset)
        preset.output_dir = data.get("output_dir", preset.output_dir)
        preset.highlight_config = data.get("highlight_config", preset.highlight_config)
        preset.overlay_preset_id = data.get("overlay_preset_id", preset.overlay_preset_id)
        preset.overlay_variables = data.get("overlay_variables", preset.overlay_variables)
        preset.capture_mode = data.get("capture_mode", preset.capture_mode)
        preset.youtube_privacy = data.get("youtube_privacy", preset.youtube_privacy)
        preset.failure_action = FailureAction(data.get("failure_action", preset.failure_action.value))
        preset.notify_on_completion = data.get("notify_on_completion", preset.notify_on_completion)
        preset.non_interactive = data.get("non_interactive", preset.non_interactive)
        preset.updated_at = time.time()

        self._save_preset(preset)
        logger.info("[Pipeline] Updated preset: %s", preset.name)
        return preset.to_dict()

    def delete_preset(self, preset_id: str) -> bool:
        """Delete a preset."""
        if preset_id not in self._presets:
            return False

        conn = self._get_connection()
        try:
            conn.execute("DELETE FROM pipeline_presets WHERE id = ?", (preset_id,))
            conn.commit()
        finally:
            conn.close()

        del self._presets[preset_id]
        logger.info("[Pipeline] Deleted preset: %s", preset_id)
        return True

    # ── Pipeline Control ────────────────────────────────────────────────────

    def start(
        self,
        project_id: int,
        preset_id: Optional[str] = None,
        config: Optional[dict] = None,
    ) -> dict:
        """Start a new pipeline run.

        Merges effective config using: global preset → project overrides → runtime config.

        Args:
            project_id: The project to run the pipeline for.
            preset_id: Optional global preset ID. Falls back to project's saved preset.
            config: Optional runtime overrides (CLI flags, frontend custom config).

        Returns:
            The new pipeline run status dict.
        """
        with self._lock:
            # Check for existing run
            if self._current_run and self._current_run.state == PipelineState.RUNNING:
                raise ValueError("Pipeline already running")

            # Build effective config via 3-layer merge
            run_config = self.get_effective_config(
                project_id=project_id,
                preset_id=preset_id,
                runtime_overrides=config,
            )

            # Create new run
            run = PipelineRun(
                run_id=str(uuid.uuid4())[:8],
                project_id=project_id,
                state=PipelineState.RUNNING,
                config=run_config,
                started_at=time.time(),
            )
            project_dir = None
            try:
                from server.services.project_service import project_service
                project = project_service.get_project(project_id)
                project_dir = project.get("project_dir") if project else None
            except Exception:
                project_dir = None
            run.log_file_path = run_log_file_service.start_run(
                scope="pipeline",
                run_id=run.run_id,
                project_id=project_id,
                project_dir=project_dir,
                metadata={
                    "preset_id": preset_id,
                    "resolved_preset_id": run_config.get("resolved_preset_id"),
                    "config": run_config,
                },
            )

            # Configure step initial states based on config
            if run_config.get("skip_capture", False):
                run.steps[StepName.CAPTURE].state = StepState.SKIPPED
            if run_config.get("skip_analysis", False):
                run.steps[StepName.ANALYSIS].state = StepState.SKIPPED
            if run_config.get("skip_compose", False):
                run.steps[StepName.COMPOSE].state = StepState.SKIPPED
            if run_config.get("skip_export", False):
                run.steps[StepName.EXPORT].state = StepState.SKIPPED
            if not run_config.get("upload_to_youtube", False):
                run.steps[StepName.UPLOAD].state = StepState.SKIPPED

            # Set an immediate actionable step so frontend status is never null.
            run.current_step = self._next_actionable_step(run)

            self._current_run = run
            self._persist_run(run)

            # Start execution thread
            self._stop_event.clear()
            self._pause_event.clear()
            self._executor_thread = threading.Thread(
                target=self._execute_pipeline,
                name="PipelineExecutor",
                daemon=True,
            )
            self._executor_thread.start()

            logger.info("[Pipeline] Started run %s for project %d", run.run_id, project_id)
            self._broadcast("pipeline:started", run.to_dict())

            return run.to_dict()

    def pause(self) -> dict:
        """Pause the current pipeline run."""
        with self._lock:
            if not self._current_run:
                raise ValueError("No pipeline running")
            if self._current_run.state != PipelineState.RUNNING:
                raise ValueError("Pipeline not running")

            self._pause_event.set()
            self._current_run.state = PipelineState.PAUSED
            if self._current_run.current_step:
                self._current_run.steps[self._current_run.current_step].state = StepState.PAUSED
            self._persist_run(self._current_run)

            logger.info("[Pipeline] Paused run %s", self._current_run.run_id)
            self._broadcast("pipeline:paused", self._current_run.to_dict())

            return self._current_run.to_dict()

    def resume(self) -> dict:
        """Resume a paused pipeline run."""
        with self._lock:
            if not self._current_run:
                raise ValueError("No pipeline to resume")
            if self._current_run.state not in (
                PipelineState.PAUSED,
                PipelineState.WAITING_INTERVENTION,
            ):
                raise ValueError("Pipeline not paused")

            self._pause_event.clear()
            self._current_run.state = PipelineState.RUNNING
            if self._current_run.current_step:
                step = self._current_run.steps[self._current_run.current_step]
                if step.state == StepState.PAUSED:
                    step.state = StepState.RUNNING
            self._persist_run(self._current_run)

            # Restart executor if not running
            if not self._executor_thread or not self._executor_thread.is_alive():
                self._stop_event.clear()
                self._executor_thread = threading.Thread(
                    target=self._execute_pipeline,
                    name="PipelineExecutor",
                    daemon=True,
                )
                self._executor_thread.start()

            logger.info("[Pipeline] Resumed run %s", self._current_run.run_id)
            self._broadcast("pipeline:resumed", self._current_run.to_dict())

            return self._current_run.to_dict()

    def cancel(self) -> dict:
        """Cancel the current pipeline run."""
        with self._lock:
            if not self._current_run:
                raise ValueError("No pipeline running")

            self._stop_event.set()
            self._pause_event.set()  # Release any pause wait
            self._current_run.state = PipelineState.CANCELLED
            self._current_run.completed_at = time.time()
            if self._current_run.current_step:
                step = self._current_run.steps[self._current_run.current_step]
                if step.state in (StepState.RUNNING, StepState.PAUSED):
                    step.state = StepState.FAILED
                    step.error = "Cancelled by user"
            self._persist_run(self._current_run)

            logger.info("[Pipeline] Cancelled run %s", self._current_run.run_id)
            self._broadcast("pipeline:cancelled", self._current_run.to_dict())

            return self._current_run.to_dict()

    def reset(self, project_id: Optional[int] = None) -> dict:
        """Reset pipeline state so execution can restart from the beginning.

        Stops any current run, clears in-memory active run, and marks
        matching persisted runs as cancelled for traceability.
        """
        with self._lock:
            self._stop_event.set()
            self._pause_event.set()

            # Mark current run as cancelled before dropping it.
            if self._current_run:
                if project_id is None or self._current_run.project_id == project_id:
                    self._current_run.state = PipelineState.CANCELLED
                    self._current_run.error = "Reset by user"
                    self._current_run.completed_at = time.time()
                    self._persist_run(self._current_run)
                    cancelled_run = self._current_run.to_dict()
                    self._current_run = None
                else:
                    cancelled_run = None
            else:
                cancelled_run = None

            # Keep history but ensure any active rows are no longer resumable.
            conn = self._get_connection()
            try:
                if project_id is None:
                    conn.execute(
                        """
                        UPDATE pipeline_runs
                        SET state = 'cancelled',
                            error = COALESCE(error, 'Reset by user'),
                            completed_at = COALESCE(completed_at, ?),
                            updated_at = datetime('now')
                        WHERE state IN ('running', 'paused', 'waiting_intervention')
                        """,
                        (time.time(),),
                    )
                else:
                    conn.execute(
                        """
                        UPDATE pipeline_runs
                        SET state = 'cancelled',
                            error = COALESCE(error, 'Reset by user'),
                            completed_at = COALESCE(completed_at, ?),
                            updated_at = datetime('now')
                        WHERE project_id = ?
                          AND state IN ('running', 'paused', 'waiting_intervention')
                        """,
                        (time.time(), project_id),
                    )
                conn.commit()
            finally:
                conn.close()

            payload = {
                "run": None,
                "reset": True,
                "project_id": project_id,
                "cancelled_run": cancelled_run,
            }
            self._broadcast("pipeline:reset", payload)
            logger.info("[Pipeline] Reset requested (project_id=%s)", project_id)
            return payload

    def retry_step(self, step_name: str) -> dict:
        """Retry a failed step."""
        with self._lock:
            if not self._current_run:
                raise ValueError("No pipeline to retry")

            step_enum = StepName(step_name)
            step = self._current_run.steps.get(step_enum)
            if not step:
                raise ValueError(f"Unknown step: {step_name}")
            if step.state != StepState.FAILED:
                raise ValueError(f"Step {step_name} is not failed")

            # Reset step state
            step.state = StepState.PENDING
            step.progress = 0.0
            step.error = None
            step.started_at = None
            step.completed_at = None
            step.output = {}

            # Reset pipeline state
            self._current_run.state = PipelineState.RUNNING
            self._current_run.current_step = step_enum
            self._current_run.error = None
            self._persist_run(self._current_run)

            # Release a paused executor before deciding whether a new thread is needed.
            # A failure-action pause keeps the original executor alive while it waits.
            self._stop_event.clear()
            self._pause_event.clear()

            # Restart executor only when there is no waiting executor to resume.
            if not self._executor_thread or not self._executor_thread.is_alive():
                self._executor_thread = threading.Thread(
                    target=self._execute_pipeline,
                    name="PipelineExecutor",
                    daemon=True,
                )
                self._executor_thread.start()

            logger.info("[Pipeline] Retrying step %s", step_name)
            self._broadcast("pipeline:step_retry", {
                "run": self._current_run.to_dict(),
                "step": step_name,
            })

            return self._current_run.to_dict()

    def skip_step(self, step_name: str) -> dict:
        """Skip a failed step and continue."""
        with self._lock:
            if not self._current_run:
                raise ValueError("No pipeline to skip step")

            step_enum = StepName(step_name)
            step = self._current_run.steps.get(step_enum)
            if not step:
                raise ValueError(f"Unknown step: {step_name}")
            if step.state != StepState.FAILED:
                raise ValueError(f"Step {step_name} is not failed")

            # Skip the step
            step.state = StepState.SKIPPED
            step.completed_at = time.time()

            # Find next step and continue
            self._current_run.state = PipelineState.RUNNING
            self._persist_run(self._current_run)

            # Restart executor
            if not self._executor_thread or not self._executor_thread.is_alive():
                self._stop_event.clear()
                self._pause_event.clear()
                self._executor_thread = threading.Thread(
                    target=self._execute_pipeline,
                    name="PipelineExecutor",
                    daemon=True,
                )
                self._executor_thread.start()

            logger.info("[Pipeline] Skipped step %s", step_name)
            self._broadcast("pipeline:step_skipped", {
                "run": self._current_run.to_dict(),
                "step": step_name,
            })

            return self._current_run.to_dict()

    # ── Pipeline Execution ──────────────────────────────────────────────────

    def _execute_pipeline(self) -> None:
        """Execute the pipeline steps in sequence (runs in background thread)."""
        logger.info("[Pipeline] Executor thread started")

        step_order = [
            StepName.ANALYSIS,
            StepName.EDITING,
            StepName.CAPTURE,
            StepName.COMPOSE,
            StepName.EXPORT,
            StepName.UPLOAD,
        ]

        step_handlers = {
            StepName.CAPTURE: self._execute_capture,
            StepName.ANALYSIS: self._execute_analysis,
            StepName.EDITING: self._execute_editing,
            StepName.COMPOSE: self._execute_compose,
            StepName.EXPORT: self._execute_export,
            StepName.UPLOAD: self._execute_upload,
        }

        try:
            # Find first pending step
            start_index = 0
            with self._lock:
                if self._current_run and self._current_run.current_step:
                    try:
                        start_index = step_order.index(self._current_run.current_step)
                    except ValueError:
                        pass

            for step_name in step_order[start_index:]:
                if self._stop_event.is_set():
                    logger.info("[Pipeline] Executor stopped")
                    return

                # Check pause
                while self._pause_event.is_set() and not self._stop_event.is_set():
                    time.sleep(0.1)

                if self._stop_event.is_set():
                    return

                with self._lock:
                    if not self._current_run:
                        return
                    step = self._current_run.steps[step_name]

                    # Skip if already completed or skipped
                    if step.state in (StepState.COMPLETED, StepState.SKIPPED):
                        continue

                    # Mark as running
                    step.state = StepState.RUNNING
                    step.started_at = time.time()
                    self._current_run.current_step = step_name
                    self._persist_run(self._current_run)

                logger.info("[Pipeline] Executing step: %s", step_name.value)
                self._broadcast("pipeline:step_started", {
                    "run_id": self._current_run.run_id,
                    "step": step_name.value,
                })

                try:
                    # Execute the step
                    handler = step_handlers[step_name]
                    handler()

                    # Mark completed
                    with self._lock:
                        if self._current_run:
                            step = self._current_run.steps[step_name]
                            step.state = StepState.COMPLETED
                            step.progress = 100.0
                            step.completed_at = time.time()
                            self._persist_run(self._current_run)

                    self._broadcast("pipeline:step_completed", {
                        "run_id": self._current_run.run_id,
                        "step": step_name.value,
                    })

                except Exception as exc:
                    logger.exception("[Pipeline] Step %s failed", step_name.value)

                    with self._lock:
                        if not self._current_run:
                            return
                        step = self._current_run.steps[step_name]
                        step.state = StepState.FAILED
                        step.error = str(exc)
                        step.completed_at = time.time()

                        # Handle failure according to config
                        failure_action = FailureAction(
                            self._current_run.config.get("failure_action", "pause")
                        )
                        if failure_action == FailureAction.ABORT:
                            self._current_run.state = PipelineState.FAILED
                            self._current_run.error = f"Step {step_name.value} failed: {exc}"
                            self._current_run.completed_at = time.time()
                        elif failure_action == FailureAction.SKIP:
                            step.state = StepState.SKIPPED
                            # Continue to next step
                        else:  # PAUSE
                            self._current_run.state = PipelineState.WAITING_INTERVENTION
                            self._pause_event.set()

                        self._persist_run(self._current_run)

                    self._broadcast("pipeline:step_error", {
                        "run_id": self._current_run.run_id,
                        "step": step_name.value,
                        "error": str(exc),
                    })

                    if failure_action == FailureAction.ABORT:
                        self._broadcast("pipeline:failed", self._current_run.to_dict())
                        return
                    elif failure_action == FailureAction.PAUSE:
                        # A retry must start from the failed step, not let this
                        # executor advance to later steps after being unpaused.
                        return

            # All steps completed
            with self._lock:
                if self._current_run and self._current_run.state == PipelineState.RUNNING:
                    self._current_run.state = PipelineState.COMPLETED
                    self._current_run.completed_at = time.time()
                    self._persist_run(self._current_run)

            self._broadcast("pipeline:completed", self._current_run.to_dict())
            logger.info("[Pipeline] Run %s completed successfully", self._current_run.run_id)

        except Exception as exc:
            logger.exception("[Pipeline] Executor error")
            with self._lock:
                if self._current_run:
                    self._current_run.state = PipelineState.FAILED
                    self._current_run.error = str(exc)
                    self._current_run.completed_at = time.time()
                    self._persist_run(self._current_run)
            self._broadcast("pipeline:failed", {
                "run_id": self._current_run.run_id if self._current_run else None,
                "error": str(exc),
            })

    # ── Step Implementations ────────────────────────────────────────────────
    # These are placeholder implementations that will call the actual services

    def _update_step_progress(self, step_name: StepName, progress: float, output: Optional[dict] = None) -> None:
        """Update step progress and broadcast."""
        with self._lock:
            if self._current_run:
                step = self._current_run.steps[step_name]
                step.progress = progress
                if output:
                    step.output.update(output)
                self._persist_run(self._current_run)

        self._broadcast("pipeline:step_progress", {
            "run_id": self._current_run.run_id if self._current_run else None,
            "project_id": self._current_run.project_id if self._current_run else None,
            "step": step_name.value,
            "progress": progress,
            "output": output,
        })

    def _execute_capture(self) -> None:
        """Execute the capture step.

        Two capture modes:
          A. **Script-based** (preferred) — Uses the Video Composition Script
             to capture individual clips for each segment (intro, qualifying,
             race events, results), then compiles them.
          B. **Legacy full-race** — Captures the entire race in one pass.

        The script-based mode is used when generate_video_script results
        are available from the editing step.
        """
        from server.services.capture_service import capture_service
        from server.services.iracing_bridge import bridge as iracing_bridge
        from server.services.analysis_db import get_project_db

        logger.info("[Pipeline] Starting capture step")

        with self._lock:
            config = self._current_run.config if self._current_run else {}
            project_id = self._current_run.project_id if self._current_run else 0

        if config.get("skip_capture"):
            logger.info("[Pipeline] Skipping capture (configured)")
            return

        # Check if video already exists
        from server.services.project_service import project_service
        project = project_service.get_project(project_id)
        if project and project.get("replay_file") and Path(project["replay_file"]).exists():
            logger.info("[Pipeline] Video already exists, skipping capture")
            self._update_step_progress(StepName.CAPTURE, 100.0, {
                "file": project["replay_file"],
                "skipped_reason": "Video already exists",
            })
            return

        if not iracing_bridge.is_connected:
            raise RuntimeError("iRacing is not connected — cannot capture")

        # ── Try script-based capture first ──────────────────────────────────
        video_script = config.get("video_script")
        if video_script and isinstance(video_script, list) and len(video_script) > 0:
            self._execute_script_capture(
                iracing_bridge, project_id, project, video_script, config
            )
            return

        # ── Legacy full-race capture (fallback) ─────────────────────────────
        project_dir = project.get("project_dir", "") if project else ""
        race_start_frame = 0

        if project_dir:
            try:
                conn = get_project_db(project_dir)
                row = conn.execute(
                    "SELECT value FROM analysis_meta WHERE key = ?",
                    ("race_start_frame",),
                ).fetchone()
                if row:
                    race_start_frame = int(row["value"])
                conn.close()
            except Exception as exc:
                logger.warning("[Pipeline] Could not read analysis meta: %s", exc)

        self._update_step_progress(StepName.CAPTURE, 5.0, {
            "message": "Rewinding replay to race start...",
        })

        # ── Rewind replay to race start ─────────────────────────────────────
        iracing_bridge.set_replay_speed(0)
        time.sleep(0.3)
        iracing_bridge.seek_to_frame(race_start_frame)
        time.sleep(1.0)

        self._update_step_progress(StepName.CAPTURE, 10.0, {
            "message": "Starting recording...",
        })

        # ── Start recording ─────────────────────────────────────────────────
        if self._loop:
            future = asyncio.run_coroutine_threadsafe(
                capture_service.start_capture(), self._loop
            )
            result = future.result(timeout=10)
            if not result.get("success"):
                raise RuntimeError(
                    f"Failed to start capture: {result.get('error', 'unknown')}"
                )
        else:
            raise RuntimeError("No event loop available for capture")

        time.sleep(0.5)

        # ── Play replay at 1× and monitor for race end ─────────────────────
        iracing_bridge.set_replay_speed(1)

        SESSION_STATE_CHECKERED = 5
        SESSION_STATE_COOLDOWN = 6
        poll_interval = 1.0  # check once per second
        last_session_time = 0.0
        capture_started = time.monotonic()
        MAX_CAPTURE_DURATION = 7200  # 2 hours safety limit

        try:
            while not self._stop_event.is_set():
                if self._pause_event.is_set():
                    iracing_bridge.set_replay_speed(0)
                    raise InterruptedError("Capture paused")

                elapsed = time.monotonic() - capture_started
                if elapsed > MAX_CAPTURE_DURATION:
                    logger.warning("[Pipeline] Capture hit safety time limit")
                    break

                snapshot = iracing_bridge.capture_snapshot()
                if snapshot:
                    session_state = snapshot.get("session_state", 0)
                    session_time = snapshot.get("session_time", 0.0)

                    if session_time > last_session_time:
                        last_session_time = session_time

                    # Estimate progress from session time
                    # (rough — we don't know total race time ahead of time)
                    progress = min(90.0, 10.0 + (elapsed / 60.0) * 5.0)
                    self._update_step_progress(StepName.CAPTURE, progress, {
                        "message": f"Recording... {_format_race_time(session_time)}",
                        "session_time": session_time,
                    })

                    # Race finished: wait for cooldown then stop
                    if session_state >= SESSION_STATE_COOLDOWN:
                        logger.info("[Pipeline] Race cooldown reached, finishing capture")
                        time.sleep(3.0)  # capture a few extra seconds
                        break
                    elif session_state >= SESSION_STATE_CHECKERED:
                        logger.info("[Pipeline] Checkered flag — waiting for cooldown")
                        # Continue loop, waiting for cooldown state

                time.sleep(poll_interval)

        finally:
            # ── Stop recording ──────────────────────────────────────────────
            iracing_bridge.set_replay_speed(0)

            if self._loop:
                future = asyncio.run_coroutine_threadsafe(
                    capture_service.stop_capture(), self._loop
                )
                try:
                    stop_result = future.result(timeout=10)
                    capture_file = stop_result.get("file")
                    if capture_file:
                        logger.info("[Pipeline] Capture file: %s", capture_file)
                except Exception as exc:
                    logger.warning("[Pipeline] Error stopping capture: %s", exc)

        self._update_step_progress(StepName.CAPTURE, 100.0, {
            "message": "Capture complete",
        })
        logger.info("[Pipeline] Capture step completed")

    def _execute_script_capture(
        self,
        iracing_bridge: Any,
        project_id: int,
        project: dict,
        video_script: list[dict],
        config: dict,
    ) -> None:
        """Execute script-based capture for a Video Composition Script.

        For each segment: pause → seek → set camera → record → trim → save.
        """
        from server.utils.script_capture import ScriptCaptureEngine
        from server.utils.capture_engine import CaptureEngine
        from server.services.project_service import project_service

        project_dir = project.get("project_dir", "")
        clips_dir = str(Path(project_dir) / "clips")
        clip_padding = config.get("clip_padding", 0.5)
        validate_clips = bool(config.get("validate_clips", True))
        retry_failed_clip_validation = bool(config.get("retry_failed_clip_validation", False))
        clip_validation_retry_limit = max(0, min(5, int(config.get("clip_validation_retry_limit", 1) or 0)))

        self._update_step_progress(StepName.CAPTURE, 5.0, {
            "message": "Starting script-based capture...",
            "mode": "script",
        })

        cameras = getattr(iracing_bridge, "cameras", []) or []

        capture_engine = CaptureEngine()
        if not capture_engine.is_running:
            capture_engine.start(fps=30, quality=80, max_width=1920)

        def progress_cb(data: dict) -> None:
            pct = 10.0
            step = data.get("step", "")
            seg_idx = data.get("segment_index", 0)
            seg_total = data.get("segment_total", 1)
            if step == "capturing" and seg_total > 0:
                pct = 10.0 + (seg_idx / seg_total) * 80.0
            elif step == "strategy_computed":
                pct = 8.0
            elif step == "clip_validation":
                pct = 90.0
            elif step in {"clip_validation_retry", "clip_validation_complete"}:
                pct = 91.0
            self._update_step_progress(StepName.CAPTURE, pct, data)

        try:
            engine = ScriptCaptureEngine(
                output_dir=clips_dir,
                clip_padding=clip_padding,
                clip_padding_after=config.get("clip_padding_after", 1.0),
                progress_callback=progress_cb,
                contiguous_gap_threshold=config.get("contiguous_gap_threshold", 1.0),
                validate_clips=validate_clips,
                retry_failed_clip_validation=retry_failed_clip_validation,
                clip_validation_retry_limit=clip_validation_retry_limit,
            )

            clips = engine.capture_script(
                script=video_script,
                iracing_bridge=iracing_bridge,
                capture_engine=capture_engine,
                available_cameras=cameras,
            )

            if not clips:
                raise RuntimeError("No clips were captured")

            project_service.save_project_metadata(project_id, {
                "clips_manifest": engine.composition_manifest,
                "capture_manifest": engine.composition_manifest,
            })

            self._update_step_progress(StepName.CAPTURE, 92.0, {
                "message": "Capture complete — clips ready for Compose",
                "clips": len(clips),
            })

            self._update_step_progress(StepName.CAPTURE, 100.0, {
                "message": "Script capture complete",
                "clips": len(clips),
            })
        finally:
            capture_engine.stop()

    def _execute_analysis(self) -> None:
        """Execute the analysis step."""
        logger.info("[Pipeline] Starting analysis step")

        with self._lock:
            config = self._current_run.config if self._current_run else {}
            project_id = self._current_run.project_id if self._current_run else 0

        if config.get("skip_analysis"):
            logger.info("[Pipeline] Skipping analysis (configured)")
            self._log_step(StepName.ANALYSIS, "Analysis skipped (configured)", level="info")
            return

        # Import analysis manager + DB helpers
        from server.services.replay_analysis import analysis_manager
        from server.services.analysis_db import (
            init_analysis_db,
            get_project_db,
            get_analysis_status as db_get_analysis_status,
        )
        from server.services.project_service import project_service
        from server.services.iracing_bridge import bridge as iracing_bridge

        project = project_service.get_project(project_id)
        if not project:
            raise RuntimeError(f"Project {project_id} not found")
        project_dir = project.get("project_dir") or ""
        if not project_dir:
            raise RuntimeError(f"Project {project_id} has no project_dir")

        # Check if analysis already exists
        try:
            init_analysis_db(project_dir)
            conn = get_project_db(project_dir)
            try:
                status = db_get_analysis_status(conn)
            finally:
                conn.close()

            if status and status.get("status") == "completed":
                logger.info("[Pipeline] Analysis already exists, skipping")
                self._log_step(StepName.ANALYSIS, "Analysis already exists — reusing results", level="info")
                self._update_step_progress(StepName.ANALYSIS, 100.0, {
                    "skipped_reason": "Analysis already exists",
                })
                return
        except Exception as exc:
            logger.debug("[Pipeline] Could not check analysis status: %s", exc)

        # Define progress callback
        def on_progress(event_type: str, data: dict) -> None:
            if event_type == "step_completed":
                # Analysis emits progress_percent (0-100) via replay_analysis.
                progress = float(data.get("progress_percent", data.get("progress", 0)) or 0)
                progress = max(0.0, min(progress, 100.0))
                self._update_step_progress(StepName.ANALYSIS, progress, data)
                message = data.get("message") or data.get("description") or f"Analysis progress: {progress:.0f}%"
                self._log_step(StepName.ANALYSIS, message, level="info")

        self._log_step(StepName.ANALYSIS, "Starting replay analysis", level="info")

        # Launch analysis worker (pipeline-owned run).
        session_info = dict(iracing_bridge.session_data) if iracing_bridge.is_connected else {}
        if not self._loop or not self._loop.is_running():
            raise RuntimeError("No running event loop available for analysis")

        async def _start_analysis_task() -> bool:
            return analysis_manager.start(
                project_id=project_id,
                project_dir=project_dir,
                session_info=session_info,
                on_progress=on_progress,
            )

        started = asyncio.run_coroutine_threadsafe(
            _start_analysis_task(),
            self._loop,
        ).result(timeout=10)
        if not started:
            raise RuntimeError("Analysis is already running for this project")

        self._update_step_progress(StepName.ANALYSIS, 1.0, {
            "message": "Analysis worker started",
        })

        # Wait for completion
        idle_checks = 0
        while True:
            if self._stop_event.is_set():
                analysis_manager.cancel(project_id)
                raise InterruptedError("Analysis cancelled")
            if self._pause_event.is_set():
                raise InterruptedError("Analysis paused")

            manager_status = (analysis_manager.get_status(project_id) or {}).get("status")
            if manager_status == "running":
                idle_checks = 0
                time.sleep(0.5)
                continue

            # Manager is idle: inspect persisted analysis run status.
            try:
                conn = get_project_db(project_dir)
                try:
                    db_status = db_get_analysis_status(conn)
                finally:
                    conn.close()
            except Exception as exc:
                raise RuntimeError(f"Failed reading analysis status: {exc}") from exc

            state = str(db_status.get("status") or "").lower()
            if state == "completed":
                event_count = int(db_status.get("total_events") or db_status.get("event_count") or 0)
                self._update_step_progress(StepName.ANALYSIS, 100.0, {
                    "event_count": event_count,
                })
                self._log_step(StepName.ANALYSIS, f"Analysis complete — {event_count} events detected", level="success")
                break

            if state == "error":
                err = db_status.get("error_message") or "Analysis failed"
                self._log_step(StepName.ANALYSIS, f"Analysis failed: {err}", level="error")
                raise RuntimeError(err)

            idle_checks += 1
            if idle_checks >= 40:
                raise RuntimeError(f"Analysis exited without terminal status (last db status={state or 'none'})")

            time.sleep(0.5)

        logger.info("[Pipeline] Analysis step completed")

    def _execute_editing(self) -> None:
        """Execute the editing step (apply highlight configuration)."""
        logger.info("[Pipeline] Starting editing step")

        with self._lock:
            config = self._current_run.config if self._current_run else {}
            project_id = self._current_run.project_id if self._current_run else 0

        if not config.get("auto_edit", True):
            # Non-interactive mode: skip editing if no script exists
            if config.get("non_interactive", False):
                self._log_step(StepName.EDITING, "Non-interactive mode: editing step skipped (no auto_edit)", level="warning")
                return

            # Wait for user intervention
            with self._lock:
                if self._current_run:
                    self._current_run.state = PipelineState.WAITING_INTERVENTION
                    self._persist_run(self._current_run)

            self._log_step(StepName.EDITING, "Waiting for user to configure highlight selections", level="info")
            self._broadcast("pipeline:waiting_intervention", {
                "run_id": self._current_run.run_id if self._current_run else None,
                "step": StepName.EDITING.value,
                "message": "Please configure highlight selections and resume the pipeline",
            })

            self._pause_event.set()
            while self._pause_event.is_set() and not self._stop_event.is_set():
                time.sleep(0.1)

            if self._stop_event.is_set():
                raise InterruptedError("Editing cancelled")

            with self._lock:
                if self._current_run:
                    self._current_run.state = PipelineState.RUNNING
                    self._persist_run(self._current_run)
        else:
            # Auto-apply default highlight config
            # This would apply pre-configured highlight weights/settings
            self._update_step_progress(StepName.EDITING, 50.0)
            time.sleep(0.5)
            self._update_step_progress(StepName.EDITING, 100.0, {
                "auto_applied": True,
            })

        logger.info("[Pipeline] Editing step completed")

    def _execute_compose(self) -> None:
        """Execute the compose step — trim, overlay and stitch captured clips."""
        logger.info("[Pipeline] Starting compose step")

        with self._lock:
            config = self._current_run.config if self._current_run else {}
            project_id = self._current_run.project_id if self._current_run else 0

        if config.get("skip_compose"):
            logger.info("[Pipeline] Skipping compose (configured)")
            return

        from server.services.composition_service import composition_service
        from server.services.project_service import project_service

        project = project_service.get_project(project_id)
        if not project:
            raise ValueError(f"Project {project_id} not found")

        script = project.get("script") or []
        clips_manifest = project.get("clips_manifest") or []

        if not clips_manifest:
            raise ValueError("No captured clips found — run the Capture step first")
        if not script:
            raise ValueError("No composition script — run the Editing step first")

        output_dir = project.get("project_dir", "")
        if not output_dir:
            raise ValueError("Project directory not set")

        result = composition_service.submit_job(
            project_id=project_id,
            script=script,
            clips_manifest=clips_manifest,
            output_dir=output_dir,
            preset_id=config.get("compose_preset", "1080p"),
        )

        if not result.get("success"):
            raise RuntimeError(result.get("error", "Composition job failed to start"))

        job_id = result["job"]["job_id"]

        # Monitor progress
        while True:
            if self._stop_event.is_set():
                composition_service.cancel_job(job_id)
                raise InterruptedError("Compose cancelled")
            if self._pause_event.is_set():
                time.sleep(0.5)
                continue

            job_status = composition_service.get_job(job_id)
            if not job_status:
                raise RuntimeError("Compose job lost")

            progress = job_status.get("progress", 0)
            self._update_step_progress(StepName.COMPOSE, progress, {
                "job_id": job_id,
                "output_file": job_status.get("output_file"),
            })

            state = job_status.get("state")
            if state == "completed":
                with self._lock:
                    if self._current_run:
                        self._current_run.steps[StepName.COMPOSE].output["output_file"] = job_status.get("output_file")
                break
            if state == "error":
                raise RuntimeError(job_status.get("error", "Composition failed"))
            if state == "cancelled":
                raise InterruptedError("Compose cancelled")

            time.sleep(0.5)

        logger.info("[Pipeline] Compose step completed")

    def _execute_export(self) -> None:
        """Execute the export step."""
        logger.info("[Pipeline] Starting export step")

        with self._lock:
            config = self._current_run.config if self._current_run else {}
            project_id = self._current_run.project_id if self._current_run else 0

        from server.services.encoding_service import encoding_service
        from server.services.project_service import project_service

        # Get project
        project = project_service.get_project(project_id)
        if not project:
            raise ValueError(f"Project {project_id} not found")

        # Export the composed video, never the source .rpy replay file.
        compose_step = self._current_run.steps[StepName.COMPOSE] if self._current_run else None
        input_file = compose_step.output.get("output_file") if compose_step else None
        if not input_file or not Path(input_file).is_file():
            # Recovery path: a completed compose can survive a server restart even
            # when the in-memory pipeline run does not. Use the newest composed MP4.
            project_dir = Path(project.get("project_dir") or "")
            composed_files = sorted(
                project_dir.glob("composed_*.mp4"),
                key=lambda item: item.stat().st_mtime,
                reverse=True,
            ) if project_dir.is_dir() else []
            input_file = str(composed_files[0]) if composed_files else None
        if not input_file or not Path(input_file).is_file():
            raise ValueError("No composed video file to export")

        # Submit to the supported encoder queue. `submit_job` owns output naming,
        # validation, GPU selection, and the asynchronous encoding lifecycle.
        export_preset = config.get("export_preset") or "1080p"
        output_dir = str(Path(project.get("project_dir") or "") / "Encoded")
        result = encoding_service.submit_job(
            project_id=project_id,
            input_file=input_file,
            output_dir=output_dir,
            preset_id=export_preset,
            job_type="full",
        )
        if not result.get("success"):
            raise RuntimeError(result.get("error", "Export job failed to start"))
        job_id = result["job"]["job_id"]

        # Monitor progress
        while True:
            if self._stop_event.is_set():
                encoding_service.cancel_job(job_id)
                raise InterruptedError("Export cancelled")
            if self._pause_event.is_set():
                # Encoding can't really be paused, so we wait
                time.sleep(0.5)
                continue

            job_status = encoding_service.get_job(job_id)
            if not job_status:
                raise RuntimeError("Export job lost")

            progress = job_status.get("progress", {}).get("percentage", 0)
            self._update_step_progress(StepName.EXPORT, progress, {
                "job_id": job_id,
                "output_file": job_status.get("output_file"),
            })

            state = job_status.get("state")
            if state == "completed":
                with self._lock:
                    if self._current_run:
                        self._current_run.steps[StepName.EXPORT].output["output_file"] = job_status.get("output_file")
                break
            if state == "error":
                raise RuntimeError(job_status.get("error", "Export failed"))
            if state == "cancelled":
                raise InterruptedError("Export cancelled")

            time.sleep(0.5)

        logger.info("[Pipeline] Export step completed")

    def _execute_upload(self) -> None:
        """Execute the YouTube upload step."""
        logger.info("[Pipeline] Starting upload step")

        with self._lock:
            config = self._current_run.config if self._current_run else {}
            project_id = self._current_run.project_id if self._current_run else 0

        if not config.get("upload_to_youtube", False):
            logger.info("[Pipeline] Skipping upload (not configured)")
            return

        from server.services.youtube_service import youtube_service
        from server.services.project_service import project_service

        # Check YouTube connection
        connection_status = asyncio.run_coroutine_threadsafe(
            youtube_service.get_connection_status(),
            self._loop,
        ).result(timeout=10)

        if connection_status.get("state") != "connected":
            raise RuntimeError("YouTube not connected. Please connect in settings.")

        # Get project and export file
        project = project_service.get_project(project_id)
        if not project:
            raise ValueError(f"Project {project_id} not found")

        # Get the export output file
        export_step = self._current_run.steps[StepName.EXPORT] if self._current_run else None
        output_file = export_step.output.get("output_file") if export_step else None

        if not output_file or not Path(output_file).exists():
            raise ValueError("No export file to upload")

        # Prepare upload
        title = project.get("name", "League Replay Studio Export")
        description = f"Exported from {project.get('track_name', 'Unknown Track')}"
        privacy = config.get("youtube_privacy", "unlisted")

        # Start upload
        job_id = asyncio.run_coroutine_threadsafe(
            youtube_service.upload_video(
                project_id=project_id,
                file_path=output_file,
                title=title,
                description=description,
                privacy=privacy,
            ),
            self._loop,
        ).result(timeout=30)

        # Monitor progress
        while True:
            if self._stop_event.is_set():
                asyncio.run_coroutine_threadsafe(
                    youtube_service.cancel_upload(job_id),
                    self._loop,
                ).result(timeout=10)
                raise InterruptedError("Upload cancelled")
            if self._pause_event.is_set():
                time.sleep(0.5)
                continue

            upload_status = youtube_service.get_upload_status()
            current_job = upload_status.get("current_job")

            if current_job and current_job.get("job_id") == job_id:
                progress = current_job.get("progress", 0) * 100
                self._update_step_progress(StepName.UPLOAD, progress, {
                    "job_id": job_id,
                    "bytes_sent": current_job.get("bytes_sent", 0),
                    "total_bytes": current_job.get("total_bytes", 0),
                })

                state = current_job.get("state")
                if state == "completed":
                    self._update_step_progress(StepName.UPLOAD, 100.0, {
                        "video_id": current_job.get("video_id"),
                        "video_url": current_job.get("video_url"),
                    })
                    break
                if state == "error":
                    raise RuntimeError(current_job.get("error", "Upload failed"))
            else:
                # Job finished and cleared
                break

            time.sleep(0.5)

        logger.info("[Pipeline] Upload step completed")


# ── Singleton instance ──────────────────────────────────────────────────────

pipeline_service = PipelineService()
