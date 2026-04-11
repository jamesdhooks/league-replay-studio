"""
script_state_service.py
-----------------------
Manages script lock, per-segment capture state, segment content hashing,
capture range selection, and invalidated clip trash bin.

State is persisted in the project directory as ``capture_state.json``
so it survives app restarts.

Key concepts:
  - **Script Lock**: Once locked, only camera/driver adjustments allowed
    in the editing phase. Unlocking re-generates the script and uses hashing
    to detect which segments changed.
  - **Segment Hash**: A deterministic hash of (start_time, end_time, driver,
    camera, section, event_type) — if these change after re-generation,
    the corresponding clip is invalidated.
  - **Capture State**: Each segment is one of: uncaptured, captured,
    invalidated, capturing.
  - **Capture Range**: Optional start/end time bounds that filter which
    segments are captured.
  - **Trash Bin**: Invalidated clips are moved to ``clips/trash/`` for
    convenient cleanup.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import time
from pathlib import Path

logger = logging.getLogger(__name__)

# ── Segment capture states ──────────────────────────────────────────────────

CAPTURE_UNCAPTURED  = "uncaptured"
CAPTURE_CAPTURED    = "captured"
CAPTURE_INVALIDATED = "invalidated"
CAPTURE_CAPTURING   = "capturing"

VALID_CAPTURE_STATES = {CAPTURE_UNCAPTURED, CAPTURE_CAPTURED, CAPTURE_INVALIDATED, CAPTURE_CAPTURING}

# ── Capture modes ───────────────────────────────────────────────────────────

MODE_ALL           = "all"
MODE_UNCAPTURED    = "uncaptured_only"
MODE_SPECIFIC      = "specific_segments"
MODE_TIME_RANGE    = "time_range"

VALID_CAPTURE_MODES = {MODE_ALL, MODE_UNCAPTURED, MODE_SPECIFIC, MODE_TIME_RANGE}

# File name for persisted state
STATE_FILE = "capture_state.json"


def _segment_hash(seg: dict) -> str:
    """Compute a deterministic content hash for a script segment.

    The hash covers the key properties that, if changed, would require
    re-capture: time range, driver, camera, section, event type.

    Returns:
        A 12-character hex digest.
    """
    # Use repr of sorted tuple for determinism
    key_fields = (
        round(float(seg.get("start_time_seconds", 0)), 3),
        round(float(seg.get("end_time_seconds", 0)), 3),
        str(seg.get("driver_name", "")),
        str(seg.get("car_idx", "")),
        str(seg.get("camera_group", seg.get("camera_name", ""))),
        str(seg.get("section", "")),
        str(seg.get("event_type", seg.get("type", ""))),
    )
    raw = repr(key_fields).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:12]


class ScriptStateService:
    """Per-project script lock and capture state management."""

    # ── Load / Save ─────────────────────────────────────────────────────────

    @staticmethod
    def _state_path(project_dir: str) -> Path:
        return Path(project_dir) / STATE_FILE

    @staticmethod
    def _trash_dir(project_dir: str) -> Path:
        return Path(project_dir) / "clips" / "trash"

    def load_state(self, project_dir: str) -> dict:
        """Load persisted capture state, or return defaults."""
        path = self._state_path(project_dir)
        if path.exists():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                logger.warning("[ScriptState] Failed to load %s: %s", path, exc)
        return self._default_state()

    def save_state(self, project_dir: str, state: dict) -> None:
        """Persist capture state to disk."""
        path = self._state_path(project_dir)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(state, indent=2), encoding="utf-8")
        except OSError as exc:
            logger.error("[ScriptState] Failed to save %s: %s", path, exc)

    @staticmethod
    def _default_state() -> dict:
        return {
            "script_locked": False,
            "locked_at": None,
            "segments": {},           # segment_id → {hash, capture_state, clip_path, ...}
            "capture_range": None,    # {start: float, end: float} or None
            "trash": [],              # list of {segment_id, clip_path, invalidated_at, reason}
            "pip_config": {           # PiP overlay configuration
                "enabled": False,
                "position": "bottom-right",   # top-left, top-right, bottom-left, bottom-right
                "scale": 0.3,                 # 0.1 – 0.5
                "margin": 16,                 # px from corner
                "border": True,
                "border_color": "#ffffff",
                "border_width": 2,
                "show_live_badge": True,
            },
        }

    # ── Script Lock ─────────────────────────────────────────────────────────

    def lock_script(self, project_dir: str, script: list[dict]) -> dict:
        """Lock the script and initialize per-segment capture state.

        Args:
            project_dir: Project directory path.
            script: The video script segments to lock.

        Returns:
            Updated state dict.
        """
        state = self.load_state(project_dir)
        segments = {}
        for seg in script:
            if seg.get("type") == "transition":
                continue
            seg_id = seg.get("id", seg.get("segment_id", ""))
            if not seg_id:
                continue
            seg_hash = _segment_hash(seg)
            # Preserve existing capture state if hash matches
            existing = state.get("segments", {}).get(seg_id, {})
            if existing.get("hash") == seg_hash and existing.get("capture_state") == CAPTURE_CAPTURED:
                segments[seg_id] = existing
            else:
                segments[seg_id] = {
                    "hash": seg_hash,
                    "capture_state": CAPTURE_UNCAPTURED,
                    "clip_path": None,
                    "section": seg.get("section", "race"),
                    "start_time": seg.get("start_time_seconds", 0),
                    "end_time": seg.get("end_time_seconds", 0),
                    "event_type": seg.get("event_type", seg.get("type", "")),
                    "is_pip": bool(seg.get("pip")),
                }

        state["script_locked"] = True
        state["locked_at"] = time.time()
        state["segments"] = segments
        self.save_state(project_dir, state)
        logger.info("[ScriptState] Script locked with %d segments", len(segments))
        return state

    def unlock_script(self, project_dir: str) -> dict:
        """Unlock the script.  Does NOT delete clips — the user must
        regenerate the script, which triggers hash comparison.

        Returns:
            Updated state dict.
        """
        state = self.load_state(project_dir)
        state["script_locked"] = False
        self.save_state(project_dir, state)
        logger.info("[ScriptState] Script unlocked")
        return state

    def is_locked(self, project_dir: str) -> bool:
        """Check if the script is currently locked."""
        return self.load_state(project_dir).get("script_locked", False)

    # ── Script Regeneration / Hash Comparison ───────────────────────────────

    def compare_and_update(self, project_dir: str, new_script: list[dict]) -> dict:
        """Compare a new script against the locked state.

        For each segment:
          - If hash matches → keep ``captured`` state (clip is still valid)
          - If hash changed → mark ``invalidated`` and move clip to trash
          - If segment is new → mark ``uncaptured``
          - If segment was removed → move clip to trash

        Returns:
            Dict with ``retained``, ``invalidated``, ``new`` counts
            and the full updated state.
        """
        state = self.load_state(project_dir)
        old_segments = state.get("segments", {})
        new_segments = {}
        retained = 0
        invalidated = 0
        new_count = 0

        # Build new segment map
        new_ids = set()
        for seg in new_script:
            if seg.get("type") == "transition":
                continue
            seg_id = seg.get("id", seg.get("segment_id", ""))
            if not seg_id:
                continue
            new_ids.add(seg_id)
            seg_hash = _segment_hash(seg)
            existing = old_segments.get(seg_id, {})

            if existing.get("hash") == seg_hash and existing.get("capture_state") == CAPTURE_CAPTURED:
                # Hash matches — retain clip
                new_segments[seg_id] = existing
                retained += 1
            elif existing.get("capture_state") == CAPTURE_CAPTURED:
                # Hash changed — invalidate
                self._trash_clip(project_dir, state, seg_id, existing, "script_changed")
                new_segments[seg_id] = {
                    "hash": seg_hash,
                    "capture_state": CAPTURE_UNCAPTURED,
                    "clip_path": None,
                    "section": seg.get("section", "race"),
                    "start_time": seg.get("start_time_seconds", 0),
                    "end_time": seg.get("end_time_seconds", 0),
                    "event_type": seg.get("event_type", seg.get("type", "")),
                    "is_pip": bool(seg.get("pip")),
                }
                invalidated += 1
            else:
                # New or previously uncaptured segment
                new_segments[seg_id] = {
                    "hash": seg_hash,
                    "capture_state": CAPTURE_UNCAPTURED,
                    "clip_path": None,
                    "section": seg.get("section", "race"),
                    "start_time": seg.get("start_time_seconds", 0),
                    "end_time": seg.get("end_time_seconds", 0),
                    "event_type": seg.get("event_type", seg.get("type", "")),
                    "is_pip": bool(seg.get("pip")),
                }
                new_count += 1

        # Segments removed from new script
        for seg_id, info in old_segments.items():
            if seg_id not in new_ids and info.get("capture_state") == CAPTURE_CAPTURED:
                self._trash_clip(project_dir, state, seg_id, info, "segment_removed")
                invalidated += 1

        state["segments"] = new_segments
        self.save_state(project_dir, state)

        result = {
            "retained": retained,
            "invalidated": invalidated,
            "new": new_count,
            "total": len(new_segments),
            "state": state,
        }
        logger.info(
            "[ScriptState] Compare: retained=%d, invalidated=%d, new=%d",
            retained, invalidated, new_count,
        )
        return result

    # ── Per-Segment Capture State ───────────────────────────────────────────

    def mark_captured(self, project_dir: str, segment_id: str, clip_path: str) -> None:
        """Mark a segment as captured with its clip path."""
        state = self.load_state(project_dir)
        if segment_id in state["segments"]:
            state["segments"][segment_id]["capture_state"] = CAPTURE_CAPTURED
            state["segments"][segment_id]["clip_path"] = clip_path
            state["segments"][segment_id]["captured_at"] = time.time()
            self.save_state(project_dir, state)

    def mark_capturing(self, project_dir: str, segment_id: str) -> None:
        """Mark a segment as currently being captured."""
        state = self.load_state(project_dir)
        if segment_id in state["segments"]:
            state["segments"][segment_id]["capture_state"] = CAPTURE_CAPTURING
            self.save_state(project_dir, state)

    def mark_uncaptured(self, project_dir: str, segment_id: str) -> None:
        """Reset a segment to uncaptured (e.g. for recapture)."""
        state = self.load_state(project_dir)
        if segment_id in state["segments"]:
            old_info = state["segments"][segment_id]
            if old_info.get("clip_path") and old_info.get("capture_state") == CAPTURE_CAPTURED:
                self._trash_clip(project_dir, state, segment_id, old_info, "recapture_requested")
            state["segments"][segment_id]["capture_state"] = CAPTURE_UNCAPTURED
            state["segments"][segment_id]["clip_path"] = None
            self.save_state(project_dir, state)

    def invalidate_segment(self, project_dir: str, segment_id: str, reason: str = "manual") -> None:
        """Invalidate a segment's capture (e.g. camera/driver change in editing)."""
        state = self.load_state(project_dir)
        seg_info = state.get("segments", {}).get(segment_id)
        if seg_info and seg_info.get("capture_state") == CAPTURE_CAPTURED:
            self._trash_clip(project_dir, state, segment_id, seg_info, reason)
            seg_info["capture_state"] = CAPTURE_UNCAPTURED
            seg_info["clip_path"] = None
            self.save_state(project_dir, state)

    def get_segment_states(self, project_dir: str) -> dict:
        """Return all segment capture states."""
        state = self.load_state(project_dir)
        return state.get("segments", {})

    def get_capture_summary(self, project_dir: str) -> dict:
        """Return a summary of capture progress."""
        state = self.load_state(project_dir)
        segments = state.get("segments", {})
        total = len(segments)
        captured = sum(1 for s in segments.values() if s.get("capture_state") == CAPTURE_CAPTURED)
        uncaptured = sum(1 for s in segments.values() if s.get("capture_state") == CAPTURE_UNCAPTURED)
        invalidated_count = sum(1 for s in segments.values() if s.get("capture_state") == CAPTURE_INVALIDATED)
        capturing = sum(1 for s in segments.values() if s.get("capture_state") == CAPTURE_CAPTURING)
        return {
            "total": total,
            "captured": captured,
            "uncaptured": uncaptured,
            "invalidated": invalidated_count,
            "capturing": capturing,
            "complete": captured == total and total > 0,
            "script_locked": state.get("script_locked", False),
        }

    # ── Capture Range ───────────────────────────────────────────────────────

    def set_capture_range(self, project_dir: str, start: float | None, end: float | None) -> dict:
        """Set optional capture range to limit which segments are captured.

        Pass ``None`` for both to clear the range (capture all).
        """
        state = self.load_state(project_dir)
        if start is not None and end is not None:
            state["capture_range"] = {"start": float(start), "end": float(end)}
        else:
            state["capture_range"] = None
        self.save_state(project_dir, state)
        return state

    def filter_segments_by_mode(
        self,
        project_dir: str,
        script: list[dict],
        mode: str = MODE_ALL,
        segment_ids: list[str] | None = None,
        time_range: dict | None = None,
    ) -> list[dict]:
        """Filter script segments based on capture mode.

        Args:
            project_dir: Project directory.
            script: Full video script.
            mode: One of MODE_ALL, MODE_UNCAPTURED, MODE_SPECIFIC, MODE_TIME_RANGE.
            segment_ids: Specific segment IDs (for MODE_SPECIFIC).
            time_range: ``{start, end}`` dict (for MODE_TIME_RANGE).

        Returns:
            Filtered list of segments to capture.
        """
        state = self.load_state(project_dir)
        segments_state = state.get("segments", {})

        # Also apply capture_range if set
        capture_range = time_range or state.get("capture_range")

        result = []
        for seg in script:
            if seg.get("type") == "transition":
                continue
            seg_id = seg.get("id", seg.get("segment_id", ""))

            # Apply capture range filter
            if capture_range:
                seg_start = float(seg.get("start_time_seconds", 0))
                seg_end = float(seg.get("end_time_seconds", 0))
                range_start = float(capture_range.get("start", 0))
                range_end = float(capture_range.get("end", float("inf")))
                # Check overlap (not contained — overlap is sufficient)
                if seg_end <= range_start or seg_start >= range_end:
                    continue

            seg_state = segments_state.get(seg_id, {}).get("capture_state", CAPTURE_UNCAPTURED)

            if mode == MODE_ALL:
                result.append(seg)
            elif mode == MODE_UNCAPTURED:
                if seg_state in (CAPTURE_UNCAPTURED, CAPTURE_INVALIDATED):
                    result.append(seg)
            elif mode == MODE_SPECIFIC:
                if segment_ids and seg_id in segment_ids:
                    result.append(seg)
            elif mode == MODE_TIME_RANGE:
                # Already filtered by capture_range above
                result.append(seg)

        return result

    # ── Trash Bin ───────────────────────────────────────────────────────────

    def _trash_clip(self, project_dir: str, state: dict, segment_id: str, seg_info: dict, reason: str) -> None:
        """Move a clip to the trash directory."""
        clip_path = seg_info.get("clip_path")
        if not clip_path:
            return

        src = Path(clip_path)
        if not src.exists():
            logger.debug("[ScriptState] Clip not found for trash: %s", clip_path)
            return

        trash_dir = self._trash_dir(project_dir)
        trash_dir.mkdir(parents=True, exist_ok=True)
        dest = trash_dir / src.name

        # Avoid overwrite — append timestamp
        if dest.exists():
            stem = src.stem
            suffix = src.suffix
            dest = trash_dir / f"{stem}_{int(time.time())}{suffix}"

        try:
            shutil.move(str(src), str(dest))
            state.setdefault("trash", []).append({
                "segment_id": segment_id,
                "original_path": clip_path,
                "trash_path": str(dest),
                "invalidated_at": time.time(),
                "reason": reason,
                "section": seg_info.get("section", ""),
                "event_type": seg_info.get("event_type", ""),
            })
            logger.info("[ScriptState] Trashed clip %s → %s (reason: %s)", src.name, dest, reason)
        except OSError as exc:
            logger.warning("[ScriptState] Failed to trash %s: %s", clip_path, exc)

    def get_trash(self, project_dir: str) -> list[dict]:
        """Return the trash bin contents."""
        state = self.load_state(project_dir)
        return state.get("trash", [])

    def empty_trash(self, project_dir: str) -> int:
        """Delete all trashed clips from disk and clear the trash list.

        Returns:
            Number of files deleted.
        """
        state = self.load_state(project_dir)
        trash = state.get("trash", [])
        deleted = 0
        for entry in trash:
            path = Path(entry.get("trash_path", ""))
            if path.exists():
                try:
                    path.unlink()
                    deleted += 1
                except OSError as exc:
                    logger.warning("[ScriptState] Failed to delete %s: %s", path, exc)
        state["trash"] = []
        self.save_state(project_dir, state)
        logger.info("[ScriptState] Emptied trash: %d files deleted", deleted)
        return deleted

    def restore_from_trash(self, project_dir: str, segment_id: str) -> bool:
        """Restore a specific clip from trash back to its original location.

        Returns:
            True if restored successfully.
        """
        state = self.load_state(project_dir)
        trash = state.get("trash", [])
        for i, entry in enumerate(trash):
            if entry.get("segment_id") == segment_id:
                src = Path(entry["trash_path"])
                dest = Path(entry["original_path"])
                if src.exists():
                    try:
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        shutil.move(str(src), str(dest))
                        # Restore segment state
                        if segment_id in state.get("segments", {}):
                            state["segments"][segment_id]["capture_state"] = CAPTURE_CAPTURED
                            state["segments"][segment_id]["clip_path"] = str(dest)
                        trash.pop(i)
                        state["trash"] = trash
                        self.save_state(project_dir, state)
                        logger.info("[ScriptState] Restored %s from trash", segment_id)
                        return True
                    except OSError as exc:
                        logger.warning("[ScriptState] Restore failed: %s", exc)
                        return False
        return False

    # ── PiP Configuration ───────────────────────────────────────────────────

    def get_pip_config(self, project_dir: str) -> dict:
        """Get PiP overlay configuration."""
        state = self.load_state(project_dir)
        return state.get("pip_config", self._default_state()["pip_config"])

    def update_pip_config(self, project_dir: str, updates: dict) -> dict:
        """Update PiP overlay configuration."""
        state = self.load_state(project_dir)
        pip = state.get("pip_config", self._default_state()["pip_config"])
        # Only allow known keys
        allowed = {"enabled", "position", "scale", "margin", "border",
                    "border_color", "border_width", "show_live_badge"}
        for key, value in updates.items():
            if key in allowed:
                pip[key] = value
        state["pip_config"] = pip
        self.save_state(project_dir, state)
        return pip


# Module-level singleton
script_state_service = ScriptStateService()
