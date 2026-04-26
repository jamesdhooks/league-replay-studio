"""
project_service.py
-------------------
Project management — CRUD, step navigation, directory management,
replay file discovery, duplication, and file browser.

Stores the project registry in a global SQLite database (data/projects.db).
Each project also gets its own directory with a project.json metadata file
and a project.db SQLite database for events/telemetry/etc.
"""

from __future__ import annotations

import json
import logging
import re
import os
import subprocess
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from server.config import PROJECTS_DIR, DATA_DIR
from server.services.db import get_connection, init_db, row_to_dict

logger = logging.getLogger(__name__)

# Valid workflow steps in order
WORKFLOW_STEPS = ["pipeline", "analysis", "editing", "overlay", "capture", "compose", "export", "upload"]


def _normalize(text: str) -> str:
    """Lowercase and strip non-alphanumeric characters for fuzzy comparison."""
    return re.sub(r"[^a-z0-9]", "", text.lower())


def fuzzy_match_replay(
    project_name: str,
    replay_files: list[dict],
) -> Optional[dict]:
    """Fuzzy-match a project name against replay filenames."""
    if not project_name or not replay_files:
        return None

    words = _normalize(project_name)
    tokens = [w for w in re.findall(r"[a-z0-9]{2,}", project_name.lower())
              if w not in {"the", "of", "at", "in", "on"}]
    if not tokens:
        return None

    best: dict | None = None
    best_score = 0.0

    for f in replay_files:
        fname = _normalize(Path(f["name"]).stem)
        if not fname:
            continue
        hits = sum(1 for t in tokens if t in fname)
        score = hits / len(tokens) if tokens else 0.0
        if words and words in fname:
            score = max(score, 0.95)
        if score > best_score:
            best_score = score
            best = f

    if best and best_score >= 0.5:
        return {**best, "match_score": round(best_score, 2)}
    return None

# Standard project sub-directories created for every new project
PROJECT_SUBDIRS = [
    "replay", "captures", "preview", "preview/sprites",
    "compositions", "exports", "logs", "overlays", "overlays/templates",
    "overlays/rendered", "overlays/assets",
]


class ProjectService:
    """Manages the project lifecycle — create, list, update, delete, duplicate."""

    def __init__(self) -> None:
        init_db()
        logger.info("[Projects] ProjectService initialised")

    # ── List / Get ────────────────────────────────────────────────────────────

    def list_projects(
        self,
        search: str = "",
        track: str = "",
        step: str = "",
        sort_by: str = "updated_at",
        sort_dir: str = "desc",
    ) -> list[dict]:
        """Return all projects, optionally filtered and sorted."""
        allowed_sort = {"name", "created_at", "updated_at", "track_name", "current_step"}
        if sort_by not in allowed_sort:
            sort_by = "updated_at"
        if sort_dir not in ("asc", "desc"):
            sort_dir = "desc"

        query = "SELECT * FROM projects WHERE 1=1"
        params: list[Any] = []

        if search:
            query += " AND (name LIKE ? OR track_name LIKE ?)"
            like = f"%{search}%"
            params.extend([like, like])
        if track:
            query += " AND track_name LIKE ?"
            params.append(f"%{track}%")
        if step and step in WORKFLOW_STEPS:
            query += " AND current_step = ?"
            params.append(step)

        # sort_by and sort_dir are already validated against allowlists above,
        # so the f-string is safe from SQL injection. We use the validated values
        # directly since SQLite doesn't support parameterised ORDER BY.
        # nosemgrep: python.lang.security.audit.formatted-sql-query
        query += f" ORDER BY {sort_by} {sort_dir}"  # noqa: S608

        conn = get_connection()
        try:
            rows = conn.execute(query, params).fetchall()
            return [row_to_dict(r) for r in rows]
        finally:
            conn.close()

    def get_project(self, project_id: int) -> Optional[dict]:
        """Return a single project by ID, or None."""
        conn = get_connection()
        try:
            row = conn.execute(
                "SELECT * FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
            if not row:
                return None

            project = row_to_dict(row)
            # Enrich with persisted per-project metadata (script, clips manifest, etc.).
            meta = self._load_project_json(project.get("project_dir", ""))
            for key in (
                "script",
                "script_sections",
                "script_generated_at",
                "clips_manifest",
                "capture_manifest",
                "preferred_capture_mode",
                "last_composition_output",
                "last_composition_completed_at",
                "last_composition_job_id",
                "subsession_id",
            ):
                if key in meta:
                    project[key] = meta[key]
            return project
        finally:
            conn.close()

    def save_project_metadata(self, project_id: int, updates: dict) -> bool:
        """Persist arbitrary metadata keys into a project's project.json."""
        project = self.get_project(project_id)
        if not project:
            return False
        self._update_project_json(project["project_dir"], updates)
        return True

    # ── Create ────────────────────────────────────────────────────────────────

    def create_project(
        self,
        name: str,
        replay_file: str = "",
        project_dir: str = "",
        track_name: str = "",
        session_type: str = "",
        num_drivers: int = 0,
        num_laps: int = 0,
    ) -> dict:
        """Create a new project with directory structure and metadata files."""
        if not name or not name.strip():
            raise ValueError("Project name is required")

        name = name.strip()

        # Resolve project directory
        if project_dir:
            proj_path = Path(project_dir).resolve()
        else:
            # Auto-generate under PROJECTS_DIR
            safe_name = _safe_dirname(name)
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            proj_path = (PROJECTS_DIR / f"{safe_name}_{timestamp}").resolve()

        # Create directory structure
        proj_path.mkdir(parents=True, exist_ok=True)
        for sub in PROJECT_SUBDIRS:
            (proj_path / sub).mkdir(parents=True, exist_ok=True)

        # Copy replay file into project if provided
        actual_replay = ""
        if replay_file:
            src = Path(replay_file).resolve()
            if src.exists() and src.is_file():
                dest = (proj_path / "replay" / src.name).resolve()
                # Validate the destination is within the project directory
                if not str(dest).startswith(str(proj_path)):
                    raise ValueError("Replay file destination escapes project directory")
                shutil.copy2(str(src), str(dest))
                actual_replay = str(dest)
                logger.info("[Projects] Copied replay file: %s → %s", src, dest)
            else:
                actual_replay = replay_file  # Reference in-place

        now = datetime.now(timezone.utc).isoformat()

        # Write project.json metadata
        meta = {
            "name": name,
            "version": "1.0.0",
            "created_at": now,
            "updated_at": now,
            "current_step": "analysis",
            "track_name": track_name,
            "session_type": session_type,
            "replay_file": actual_replay,
            "preferred_capture_mode": "all",
        }
        (proj_path / "project.json").write_text(
            json.dumps(meta, indent=2), encoding="utf-8"
        )

        # Insert into registry database
        conn = get_connection()
        try:
            cursor = conn.execute(
                """INSERT INTO projects
                   (name, created_at, updated_at, track_name, session_type,
                    num_drivers, num_laps, replay_file, project_dir, current_step)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'analysis')""",
                (name, now, now, track_name, session_type,
                 num_drivers, num_laps, actual_replay, str(proj_path)),
            )
            conn.commit()
            project_id = cursor.lastrowid
            logger.info("[Projects] Created project #%d: '%s' at %s", project_id, name, proj_path)
            return self.get_project(project_id)  # type: ignore[return-value]
        finally:
            conn.close()

    # ── Update ────────────────────────────────────────────────────────────────

    def update_project(self, project_id: int, updates: dict) -> Optional[dict]:
        """Update project fields. Returns the updated project or None."""
        project = self.get_project(project_id)
        if not project:
            return None

        allowed_db = {
            "name", "track_name", "session_type", "num_drivers",
            "num_laps", "replay_file", "current_step",
        }
        allowed_meta = {
            "script", "script_sections", "script_generated_at",
            "clips_manifest", "capture_manifest", "subsession_id",
        }

        db_updates = {k: v for k, v in updates.items() if k in allowed_db}
        meta_updates = {k: v for k, v in updates.items() if k in allowed_meta}

        if not db_updates and not meta_updates:
            return project

        if "current_step" in db_updates and db_updates["current_step"] not in WORKFLOW_STEPS:
            raise ValueError(f"Invalid step: {db_updates['current_step']}")

        now = datetime.now(timezone.utc).isoformat()
        db_updates["updated_at"] = now

        # Build SET clause using only validated column names from the allowlist.
        # Keys are guaranteed to be in `allowed` by the filter above.
        # nosemgrep: python.lang.security.audit.formatted-sql-query
        set_clause = ", ".join(f"{k} = ?" for k in db_updates)  # noqa: S608
        values = list(db_updates.values()) + [project_id]

        conn = get_connection()
        try:
            conn.execute(
                f"UPDATE projects SET {set_clause} WHERE id = ?", values
            )
            conn.commit()

            # Update project.json too
            self._update_project_json(project["project_dir"], {
                **db_updates,
                **meta_updates,
            })

            logger.info("[Projects] Updated project #%d: %s", project_id, list({**db_updates, **meta_updates}.keys()))
            return self.get_project(project_id)
        finally:
            conn.close()

    # ── Delete ────────────────────────────────────────────────────────────────

    def delete_project(self, project_id: int, delete_files: bool = False) -> bool:
        """Delete a project from the registry. Optionally delete files."""
        project = self.get_project(project_id)
        if not project:
            return False

        conn = get_connection()
        try:
            conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
            conn.commit()
        finally:
            conn.close()

        if delete_files:
            proj_dir = Path(project["project_dir"])
            if proj_dir.exists() and proj_dir.is_dir():
                try:
                    shutil.rmtree(str(proj_dir))
                    logger.info("[Projects] Deleted project directory: %s", proj_dir)
                except OSError as exc:
                    logger.warning("[Projects] Could not delete directory: %s", exc)

        logger.info("[Projects] Deleted project #%d", project_id)
        return True

    # ── Duplicate ─────────────────────────────────────────────────────────────

    def duplicate_project(self, project_id: int) -> Optional[dict]:
        """Duplicate a project with a new name and directory."""
        original = self.get_project(project_id)
        if not original:
            return None

        new_name = f"{original['name']} (copy)"
        return self.create_project(
            name=new_name,
            replay_file=original.get("replay_file", ""),
            track_name=original.get("track_name", ""),
            session_type=original.get("session_type", ""),
            num_drivers=original.get("num_drivers", 0),
            num_laps=original.get("num_laps", 0),
        )

    # ── Step Navigation ───────────────────────────────────────────────────────

    def get_step_status(self, project_id: int) -> Optional[dict]:
        """Return step progression info for a project."""
        project = self.get_project(project_id)
        if not project:
            return None

        current = project["current_step"]
        current_idx = WORKFLOW_STEPS.index(current) if current in WORKFLOW_STEPS else 0

        steps = []
        for i, step_id in enumerate(WORKFLOW_STEPS):
            if i < current_idx:
                status = "completed"
            elif i == current_idx:
                status = "active"
            else:
                status = "pending"
            steps.append({"id": step_id, "status": status, "index": i})

        return {
            "current_step": current,
            "current_index": current_idx,
            "steps": steps,
        }

    def set_step(self, project_id: int, step: str) -> Optional[dict]:
        """Set the project to a specific workflow step."""
        if step not in WORKFLOW_STEPS:
            raise ValueError(f"Invalid step: {step}. Must be one of {WORKFLOW_STEPS}")
        return self.update_project(project_id, {"current_step": step})

    def advance_step(self, project_id: int) -> Optional[dict]:
        """Advance the project to the next workflow step."""
        project = self.get_project(project_id)
        if not project:
            return None

        current = project["current_step"]
        idx = WORKFLOW_STEPS.index(current) if current in WORKFLOW_STEPS else 0
        if idx < len(WORKFLOW_STEPS) - 1:
            return self.set_step(project_id, WORKFLOW_STEPS[idx + 1])
        return project  # Already at last step

    # ── Replay File Discovery ─────────────────────────────────────────────────

    def discover_replay_files(self, directory: str = "") -> list[dict]:
        """Scan a directory (default: iRacing replays dir) for .rpy files."""
        search_dirs: list[Path] = []

        if directory:
            search_dirs.append(Path(directory))
        else:
            # Try common iRacing replay directories
            home = Path.home()
            candidates = [
                home / "Documents" / "iRacing" / "replays",
                home / "Documents" / "iRacing" / "replay",
                home / "iRacing" / "replays",
            ]
            for d in candidates:
                if d.exists():
                    search_dirs.append(d)

        files: list[dict] = []
        for search_dir in search_dirs:
            if not search_dir.exists():
                continue
            for f in search_dir.rglob("*.rpy"):
                try:
                    stat = f.stat()
                    files.append({
                        "path": str(f),
                        "name": f.name,
                        "size_bytes": stat.st_size,
                        "modified_at": datetime.fromtimestamp(
                            stat.st_mtime, tz=timezone.utc
                        ).isoformat(),
                        "directory": str(f.parent),
                    })
                except OSError:
                    continue

        # Sort newest first
        files.sort(key=lambda x: x["modified_at"], reverse=True)
        return files

    # ── File Browser ──────────────────────────────────────────────────────────

    def get_project_files(self, project_id: int) -> Optional[dict]:
        """Return a structured view of the project directory tree."""
        project = self.get_project(project_id)
        if not project:
            return None

        proj_dir = Path(project["project_dir"])
        if not proj_dir.exists():
            return {"project_id": project_id, "categories": [], "total_size": 0}

        categories = []
        total_size = 0

        # Define category mapping
        category_defs = [
            {"name": "replay", "label": "Replay Files", "description": "Replay Files", "dirs": ["replay"]},
            # Support legacy/new naming so script-capture clips always appear.
            {"name": "captures", "label": "Captures", "description": "Captured Video", "dirs": ["captures", "clips"]},
            {"name": "preview", "label": "Preview Assets", "description": "Preview Assets", "dirs": ["preview"]},
            {"name": "compose", "label": "Compositions", "description": "Composed Output", "dirs": ["compositions"]},
            {"name": "exports", "label": "Encoded", "description": "Encoded Video", "dirs": ["Encoded", "exports"]},
            {"name": "overlays", "label": "Overlays", "description": "Overlay Templates", "dirs": ["overlays"]},
            {"name": "logs", "label": "Logs", "description": "Log Files", "dirs": ["logs"]},
        ]

        for category in category_defs:
            existing_dirs = [proj_dir / d for d in category["dirs"] if (proj_dir / d).exists()]
            if not existing_dirs:
                continue

            cat_files = []
            cat_size = 0
            for cat_path in existing_dirs:
                for f in sorted(cat_path.rglob("*")):
                    if f.is_file():
                        try:
                            stat = f.stat()
                            size = stat.st_size
                            cat_size += size
                            total_size += size
                            cat_files.append({
                                "name": f.name,
                                "path": str(f.relative_to(proj_dir)),
                                "size_bytes": size,
                                "extension": f.suffix.lower(),
                                "modified_at": datetime.fromtimestamp(
                                    stat.st_mtime, tz=timezone.utc
                                ).isoformat(),
                            })
                        except OSError:
                            continue

            categories.append({
                "name": category["name"],
                "label": category["label"],
                "description": category["description"],
                "files": cat_files,
                "file_count": len(cat_files),
                "total_size": cat_size,
            })

        # Also include root-level files (project.json, etc.)
        root_files = []
        for f in sorted(proj_dir.iterdir()):
            if f.is_file():
                try:
                    stat = f.stat()
                    size = stat.st_size
                    total_size += size
                    root_files.append({
                        "name": f.name,
                        "path": f.name,
                        "size_bytes": size,
                        "extension": f.suffix.lower(),
                        "modified_at": datetime.fromtimestamp(
                            stat.st_mtime, tz=timezone.utc
                        ).isoformat(),
                    })
                except OSError:
                    continue

        if root_files:
            categories.insert(0, {
                "name": "root",
                "label": "Project",
                "description": "Project Files",
                "files": root_files,
                "file_count": len(root_files),
                "total_size": sum(f["size_bytes"] for f in root_files),
            })

        return {
            "project_id": project_id,
            "project_dir": str(proj_dir),
            "categories": categories,
            "total_size": total_size,
        }

    # ── File Content & Serving ───────────────────────────────────────────────

    def get_file_content(self, project_id: int, rel_path: str) -> Optional[dict]:
        """Read a project file and return its text content."""
        project = self.get_project(project_id)
        if not project:
            return None

        proj_dir = Path(project["project_dir"]).resolve()
        file_path = (proj_dir / rel_path).resolve()

        # Prevent path traversal
        if not str(file_path).startswith(str(proj_dir)):
            return {"error": "Path escapes project directory"}

        if not file_path.exists() or not file_path.is_file():
            return {"error": "File not found"}

        # Limit to reasonable text file sizes (10 MB)
        max_size = 10 * 1024 * 1024
        if file_path.stat().st_size > max_size:
            return {"error": "File too large to display as text"}

        try:
            content = file_path.read_text(encoding="utf-8", errors="replace")
            return {"content": content}
        except OSError as exc:
            return {"error": f"Cannot read file: {exc}"}

    def resolve_file_path(self, project_id: int, rel_path: str) -> Optional[dict]:
        """Resolve a relative file path within a project directory for serving."""
        project = self.get_project(project_id)
        if not project:
            return None

        proj_dir = Path(project["project_dir"]).resolve()
        file_path = (proj_dir / rel_path).resolve()

        # Prevent path traversal
        if not str(file_path).startswith(str(proj_dir)):
            return {"error": "Path escapes project directory"}

        if not file_path.exists() or not file_path.is_file():
            return {"error": "File not found"}

        return {"absolute_path": str(file_path), "filename": file_path.name}

    def open_project_directory(self, project_id: int, rel_path: str = "") -> Optional[dict]:
        """Open a project's root directory or a project-relative path in the OS file explorer."""
        project = self.get_project(project_id)
        if not project:
            return None

        proj_dir = Path(project["project_dir"]).resolve()
        if not proj_dir.exists() or not proj_dir.is_dir():
            return {"error": "Project directory not found"}

        target = proj_dir
        if rel_path:
            candidate = (proj_dir / rel_path).resolve()
            if not str(candidate).startswith(str(proj_dir)):
                return {"error": "Path escapes project directory"}
            target = candidate.parent if candidate.is_file() else candidate
            if not target.exists():
                return {"error": "Target path not found"}

        try:
            if os.name == "nt":
                os.startfile(str(target))  # type: ignore[attr-defined]
            elif os.name == "posix":
                try:
                    subprocess.Popen(["xdg-open", str(target)])  # noqa: S603
                except OSError:
                    subprocess.Popen(["open", str(target)])  # noqa: S603
            else:
                return {"error": "Opening directories is not supported on this platform"}
        except Exception as exc:
            return {"error": f"Failed to open project directory: {exc}"}

        return {"opened": True, "project_dir": str(proj_dir), "target": str(target)}

    def delete_project_files(self, project_id: int, rel_paths: list[str]) -> Optional[dict]:
        """Delete one or more files inside a project directory.

        Returns a summary with deleted and failed paths.
        """
        project = self.get_project(project_id)
        if not project:
            return None

        proj_dir = Path(project["project_dir"]).resolve()
        protected = {"project.json", "project.db"}
        deleted: list[str] = []
        failed: list[dict[str, str]] = []

        for rel_path in rel_paths or []:
            rel = str(rel_path or "").strip()
            if not rel:
                continue

            if rel in protected:
                failed.append({"path": rel, "error": "Protected project file"})
                continue

            target = (proj_dir / rel).resolve()
            if not str(target).startswith(str(proj_dir)):
                failed.append({"path": rel, "error": "Path escapes project directory"})
                continue

            if not target.exists() or not target.is_file():
                failed.append({"path": rel, "error": "File not found"})
                continue

            try:
                target.unlink()
                deleted.append(rel)
            except OSError as exc:
                failed.append({"path": rel, "error": f"Cannot delete file: {exc}"})

        return {
            "deleted": deleted,
            "failed": failed,
            "deleted_count": len(deleted),
            "failed_count": len(failed),
        }

    # ── Private helpers ───────────────────────────────────────────────────────

    @staticmethod
    def _update_project_json(project_dir: str, updates: dict) -> None:
        """Update the project.json file in the project directory."""
        meta_path = Path(project_dir) / "project.json"
        if not meta_path.exists():
            return
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            for k, v in updates.items():
                meta[k] = v
            meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("[Projects] Failed to update project.json: %s", exc)

    @staticmethod
    def _load_project_json(project_dir: str) -> dict:
        """Load raw project.json metadata for a project directory."""
        if not project_dir:
            return {}
        meta_path = Path(project_dir) / "project.json"
        if not meta_path.exists():
            return {}
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}


def _safe_dirname(name: str) -> str:
    """Convert a project name to a safe directory name."""
    import re
    safe = re.sub(r'[^\w\s-]', '', name.lower())
    safe = re.sub(r'[\s]+', '_', safe.strip())
    return safe or "project"


# Singleton instance
project_service = ProjectService()
