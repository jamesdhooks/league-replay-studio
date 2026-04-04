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

    def __post_init__(self):
        """Initialise default steps if empty."""
        if not self.steps:
            self.steps = {
                StepName.ANALYSIS: PipelineStep(name=StepName.ANALYSIS),
                StepName.EDITING: PipelineStep(name=StepName.EDITING),
                StepName.CAPTURE: PipelineStep(name=StepName.CAPTURE),
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
        )


# ── Pipeline Preset ─────────────────────────────────────────────────────────

@dataclass
class PipelinePreset:
    """Pipeline configuration preset."""
    id: str
    name: str
    description: str = ""
    skip_capture: bool = False     # Skip capture if video already exists
    skip_analysis: bool = False    # Skip analysis if events already exist
    auto_edit: bool = True         # Automatically apply highlight config
    export_preset: Optional[str] = None  # Encoding preset ID
    upload_to_youtube: bool = False
    youtube_privacy: str = "unlisted"
    failure_action: FailureAction = FailureAction.PAUSE
    notify_on_completion: str = "toast"  # "toast", "system", "none"
    created_at: Optional[float] = None
    updated_at: Optional[float] = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to serializable dict."""
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "skip_capture": self.skip_capture,
            "skip_analysis": self.skip_analysis,
            "auto_edit": self.auto_edit,
            "export_preset": self.export_preset,
            "upload_to_youtube": self.upload_to_youtube,
            "youtube_privacy": self.youtube_privacy,
            "failure_action": self.failure_action.value,
            "notify_on_completion": self.notify_on_completion,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PipelinePreset:
        """Create from dict."""
        return cls(
            id=data["id"],
            name=data["name"],
            description=data.get("description", ""),
            skip_capture=data.get("skip_capture", False),
            skip_analysis=data.get("skip_analysis", False),
            auto_edit=data.get("auto_edit", True),
            export_preset=data.get("export_preset"),
            upload_to_youtube=data.get("upload_to_youtube", False),
            youtube_privacy=data.get("youtube_privacy", "unlisted"),
            failure_action=FailureAction(data.get("failure_action", "pause")),
            notify_on_completion=data.get("notify_on_completion", "toast"),
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

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project ON pipeline_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_state ON pipeline_runs(state);
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
        """Initialise the pipeline database."""
        conn = self._get_connection()
        try:
            conn.executescript(_PIPELINE_SCHEMA)
            conn.commit()
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
                # Set to paused state for manual resume
                run.state = PipelineState.PAUSED
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

        # Add default presets if none exist
        if not self._presets:
            self._create_default_presets()

    def _create_default_presets(self) -> None:
        """Create default pipeline presets."""
        defaults = [
            PipelinePreset(
                id="quick-highlight",
                name="Quick Highlights",
                description="Capture, analyse, export highlights — no upload",
                auto_edit=True,
                upload_to_youtube=False,
                failure_action=FailureAction.PAUSE,
            ),
            PipelinePreset(
                id="full-pipeline",
                name="Full Pipeline",
                description="Complete pipeline including YouTube upload",
                auto_edit=True,
                upload_to_youtube=True,
                youtube_privacy="unlisted",
                failure_action=FailureAction.PAUSE,
            ),
            PipelinePreset(
                id="analysis-only",
                name="Analysis Only",
                description="Capture and analyse — stop before export",
                skip_capture=True,
                auto_edit=False,
                upload_to_youtube=False,
                failure_action=FailureAction.PAUSE,
            ),
        ]
        for preset in defaults:
            preset.created_at = time.time()
            preset.updated_at = time.time()
            self._save_preset(preset)
            self._presets[preset.id] = preset

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
            skip_capture=data.get("skip_capture", False),
            skip_analysis=data.get("skip_analysis", False),
            auto_edit=data.get("auto_edit", True),
            export_preset=data.get("export_preset"),
            upload_to_youtube=data.get("upload_to_youtube", False),
            youtube_privacy=data.get("youtube_privacy", "unlisted"),
            failure_action=FailureAction(data.get("failure_action", "pause")),
            notify_on_completion=data.get("notify_on_completion", "toast"),
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
        preset.skip_capture = data.get("skip_capture", preset.skip_capture)
        preset.skip_analysis = data.get("skip_analysis", preset.skip_analysis)
        preset.auto_edit = data.get("auto_edit", preset.auto_edit)
        preset.export_preset = data.get("export_preset", preset.export_preset)
        preset.upload_to_youtube = data.get("upload_to_youtube", preset.upload_to_youtube)
        preset.youtube_privacy = data.get("youtube_privacy", preset.youtube_privacy)
        preset.failure_action = FailureAction(data.get("failure_action", preset.failure_action.value))
        preset.notify_on_completion = data.get("notify_on_completion", preset.notify_on_completion)
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

        Args:
            project_id: The project to run the pipeline for.
            preset_id: Optional preset ID to use for configuration.
            config: Optional config dict (merged with preset if both provided).

        Returns:
            The new pipeline run status dict.
        """
        with self._lock:
            # Check for existing run
            if self._current_run and self._current_run.state == PipelineState.RUNNING:
                raise ValueError("Pipeline already running")

            # Build configuration
            run_config = {}
            if preset_id and preset_id in self._presets:
                run_config = self._presets[preset_id].to_dict()
            if config:
                run_config.update(config)

            # Create new run
            run = PipelineRun(
                run_id=str(uuid.uuid4())[:8],
                project_id=project_id,
                state=PipelineState.RUNNING,
                config=run_config,
                started_at=time.time(),
            )

            # Configure steps based on config
            if run_config.get("skip_capture", False):
                run.steps[StepName.CAPTURE].state = StepState.SKIPPED
            if run_config.get("skip_analysis", False):
                run.steps[StepName.ANALYSIS].state = StepState.SKIPPED
            if not run_config.get("upload_to_youtube", False):
                run.steps[StepName.UPLOAD].state = StepState.SKIPPED

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
            StepName.EXPORT,
            StepName.UPLOAD,
        ]

        step_handlers = {
            StepName.CAPTURE: self._execute_capture,
            StepName.ANALYSIS: self._execute_analysis,
            StepName.EDITING: self._execute_editing,
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
                        # Wait for user intervention
                        while self._pause_event.is_set() and not self._stop_event.is_set():
                            time.sleep(0.1)
                        if self._stop_event.is_set():
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
        Then compile all clips into a single video.
        """
        from server.utils.script_capture import ScriptCaptureEngine
        from server.utils.capture_engine import CaptureEngine

        project_dir = project.get("project_dir", "")
        clips_dir = str(Path(project_dir) / "clips")
        clip_padding = config.get("clip_padding", 0.5)

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
            seg_idx = data.get("segment_index", 0)
            seg_total = data.get("segment_total", 1)
            if seg_total > 0:
                pct = 10.0 + (seg_idx / seg_total) * 80.0
            self._update_step_progress(StepName.CAPTURE, pct, data)

        try:
            engine = ScriptCaptureEngine(
                output_dir=clips_dir,
                clip_padding=clip_padding,
                progress_callback=progress_cb,
            )

            clips = engine.capture_script(
                script=video_script,
                iracing_bridge=iracing_bridge,
                capture_engine=capture_engine,
                available_cameras=cameras,
            )

            if not clips:
                raise RuntimeError("No clips were captured")

            self._update_step_progress(StepName.CAPTURE, 92.0, {
                "message": "Compiling clips...",
            })

            output_path = str(Path(project_dir) / "highlight_compiled.mp4")
            compiled = engine.compile_clips(output_path)

            if compiled:
                logger.info("[Pipeline] Script capture compiled → %s", compiled)
            else:
                logger.warning("[Pipeline] Clip compilation failed")

            self._update_step_progress(StepName.CAPTURE, 100.0, {
                "message": "Script capture complete",
                "clips": len(clips),
                "compiled_path": compiled,
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
            return

        # Import analysis manager
        from server.services.replay_analysis import analysis_manager
        from server.services.analysis_db import get_analysis_status as db_get_analysis_status

        # Check if analysis already exists
        try:
            from server.services.project_service import project_service
            project = project_service.get_project(project_id)
            if project:
                project_dir = Path(project["project_dir"])
                status = db_get_analysis_status(project_dir)
                if status and status.get("status") == "completed":
                    logger.info("[Pipeline] Analysis already exists, skipping")
                    self._update_step_progress(StepName.ANALYSIS, 100.0, {
                        "skipped_reason": "Analysis already exists",
                    })
                    return
        except Exception as exc:
            logger.debug("[Pipeline] Could not check analysis status: %s", exc)

        # Define progress callback
        def on_progress(event_type: str, data: dict) -> None:
            if event_type == "step_completed":
                # Map analysis progress to 0-100
                progress = min(data.get("progress", 0), 100)
                self._update_step_progress(StepName.ANALYSIS, progress, data)

        # Start analysis
        analysis_manager.analyze(project_id, on_progress=on_progress)

        # Wait for completion
        while True:
            if self._stop_event.is_set():
                analysis_manager.cancel(project_id)
                raise InterruptedError("Analysis cancelled")
            if self._pause_event.is_set():
                raise InterruptedError("Analysis paused")

            status = analysis_manager.get_status(project_id)
            if status.get("status") == "completed":
                break
            if status.get("status") == "error":
                raise RuntimeError(status.get("error", "Analysis failed"))

            time.sleep(0.5)

        logger.info("[Pipeline] Analysis step completed")

    def _execute_editing(self) -> None:
        """Execute the editing step (apply highlight configuration)."""
        logger.info("[Pipeline] Starting editing step")

        with self._lock:
            config = self._current_run.config if self._current_run else {}
            project_id = self._current_run.project_id if self._current_run else 0

        if not config.get("auto_edit", True):
            # Wait for user intervention
            with self._lock:
                if self._current_run:
                    self._current_run.state = PipelineState.WAITING_INTERVENTION
                    self._persist_run(self._current_run)

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

        # Get input file
        input_file = project.get("replay_file", "")
        if not input_file or not Path(input_file).exists():
            raise ValueError("No video file to export")

        # Start encoding
        export_preset = config.get("export_preset", "youtube_1080p60")
        job_id = encoding_service.start_job(
            project_id=project_id,
            input_file=input_file,
            preset_id=export_preset,
            job_type="highlight",
        )

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
