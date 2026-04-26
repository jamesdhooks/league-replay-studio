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

# ── Composition scope modes ──────────────────────────────────────────────────

COMPOSE_MODE_ALL        = "all"
COMPOSE_MODE_CAPTURED   = "captured_only"
COMPOSE_MODE_SPECIFIC   = "specific_segments"
COMPOSE_MODE_REGION     = "region"

VALID_COMPOSE_MODES = {COMPOSE_MODE_ALL, COMPOSE_MODE_CAPTURED, COMPOSE_MODE_SPECIFIC, COMPOSE_MODE_REGION}

# ── Gap policies ─────────────────────────────────────────────────────────────

GAP_POLICY_COMPRESS   = "compress_gaps"
GAP_POLICY_FILL_BLACK = "fill_black"
GAP_POLICY_FADE       = "fade_bridge"

VALID_GAP_POLICIES = {GAP_POLICY_COMPRESS, GAP_POLICY_FILL_BLACK, GAP_POLICY_FADE}

DEFAULT_COMPOSITION_CONFIG: dict = {
    "mode": COMPOSE_MODE_ALL,
    "selected_segment_ids": [],
    "region_start_seconds": None,
    "region_end_seconds": None,
    "gap_policy": GAP_POLICY_COMPRESS,
}

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
            "preferred_capture_mode": MODE_ALL,
            "preferred_segment_ids": [],
            "preferred_composition_config": dict(DEFAULT_COMPOSITION_CONFIG),
            "trash": [],              # list of {segment_id, clip_path, invalidated_at, reason}
            "overlay_ui_config": {
                "ui_zoom": 1.0,
                "selected_preset_id": None,
            },
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

    def get_capture_mode(self, project_dir: str) -> str:
        """Get the preferred capture mode for this project."""
        state = self.load_state(project_dir)
        mode = state.get("preferred_capture_mode", MODE_ALL)
        return mode if mode in VALID_CAPTURE_MODES else MODE_ALL

    def set_capture_mode(self, project_dir: str, mode: str) -> str:
        """Persist preferred capture mode for this project."""
        normalized = (mode or MODE_ALL).strip().lower()
        if normalized not in VALID_CAPTURE_MODES:
            raise ValueError(f"Invalid capture mode: {mode}")
        state = self.load_state(project_dir)
        state["preferred_capture_mode"] = normalized
        self.save_state(project_dir, state)
        return normalized

    def get_preferred_segment_ids(self, project_dir: str) -> list[str]:
        """Return the persisted specific-segment selection for capture mode."""
        state = self.load_state(project_dir)
        segment_ids = state.get("preferred_segment_ids", [])
        if not isinstance(segment_ids, list):
            return []
        return [str(segment_id).strip() for segment_id in segment_ids if str(segment_id).strip()]

    def set_preferred_segment_ids(self, project_dir: str, segment_ids: list[str] | None) -> list[str]:
        """Persist the specific-segment selection for capture mode."""
        normalized = [
            str(segment_id).strip()
            for segment_id in (segment_ids or [])
            if str(segment_id).strip()
        ]
        state = self.load_state(project_dir)
        state["preferred_segment_ids"] = normalized
        self.save_state(project_dir, state)
        return normalized

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
        selected_ids = {
            str(s).strip()
            for s in (segment_ids or [])
            if str(s).strip()
        }

        # Also apply capture_range if set
        capture_range = time_range or state.get("capture_range")

        result = []
        for seg in script:
            if seg.get("type") in {"transition", "bridge"}:
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
                if str(seg_id).strip() in selected_ids:
                    result.append(seg)
            elif mode == MODE_TIME_RANGE:
                # Already filtered by capture_range above
                result.append(seg)

        return result

    # ── Composition Config ───────────────────────────────────────────────────

    def _normalize_composition_config(self, raw: dict | None) -> dict:
        """Validate and normalise a composition config dict.

        Unknown keys are dropped; missing keys fall back to defaults.
        """
        raw = raw or {}
        mode = str(raw.get("mode", COMPOSE_MODE_ALL)).strip().lower()
        if mode not in VALID_COMPOSE_MODES:
            mode = COMPOSE_MODE_ALL

        selected_ids = raw.get("selected_segment_ids") or []
        if not isinstance(selected_ids, list):
            selected_ids = []
        selected_ids = [str(s).strip() for s in selected_ids if str(s).strip()]

        region_start = raw.get("region_start_seconds")
        region_end = raw.get("region_end_seconds")
        try:
            region_start = float(region_start) if region_start is not None else None
        except (TypeError, ValueError):
            region_start = None
        try:
            region_end = float(region_end) if region_end is not None else None
        except (TypeError, ValueError):
            region_end = None

        gap_policy = str(raw.get("gap_policy", GAP_POLICY_COMPRESS)).strip().lower()
        if gap_policy not in VALID_GAP_POLICIES:
            gap_policy = GAP_POLICY_COMPRESS

        return {
            "mode": mode,
            "selected_segment_ids": selected_ids,
            "region_start_seconds": region_start,
            "region_end_seconds": region_end,
            "gap_policy": gap_policy,
        }

    def get_composition_config(self, project_dir: str) -> dict:
        """Return the preferred composition config, normalised with defaults."""
        state = self.load_state(project_dir)
        raw = state.get("preferred_composition_config")
        return self._normalize_composition_config(raw)

    def set_composition_config(self, project_dir: str, updates: dict) -> dict:
        """Merge *updates* into the persisted composition config.

        Performs validation and returns the normalised config.
        """
        state = self.load_state(project_dir)
        existing = state.get("preferred_composition_config") or {}
        merged = {**existing, **updates}
        normalised = self._normalize_composition_config(merged)
        state["preferred_composition_config"] = normalised
        self.save_state(project_dir, state)
        logger.info("[ScriptState] Composition config saved: mode=%s gap=%s", normalised["mode"], normalised["gap_policy"])
        return normalised

    def filter_manifest_by_composition_config(
        self,
        project_dir: str,
        script: list[dict],
        clips_manifest: list[dict],
        config: dict | None = None,
    ) -> tuple[list[dict], list[dict]]:
        """Filter *script* and *clips_manifest* according to a composition config.

        Args:
            project_dir:    Project directory for capture-state lookup.
            script:         Full video script (may include transition entries).
            clips_manifest: Captured clips manifest.
            config:         Composition config dict (normalised). Defaults to
                            persisted config if omitted.

        Returns:
            ``(filtered_script, filtered_manifest)`` tuple — both lists contain
            only the segments / clips that should be composed.
        """
        if config is None:
            config = self.get_composition_config(project_dir)

        mode = config.get("mode", COMPOSE_MODE_ALL)
        selected_ids: set[str] = {s for s in config.get("selected_segment_ids", []) if s}
        region_start = config.get("region_start_seconds")
        region_end = config.get("region_end_seconds")

        seg_states = self.get_segment_states(project_dir)

        def _seg_id(item: dict) -> str:
            return str(item.get("id") or item.get("segment_id") or "").strip()

        kept_ids: set[str] = set()
        filtered_script: list[dict] = []

        for seg in script:
            seg_type = str(seg.get("type", "")).lower()
            if seg_type in {"transition", "bridge"}:
                filtered_script.append(seg)
                continue

            sid = _seg_id(seg)
            seg_start = float(seg.get("start_time_seconds", 0))
            seg_end = float(seg.get("end_time_seconds", seg_start))

            if mode == COMPOSE_MODE_ALL:
                keep = True
            elif mode == COMPOSE_MODE_CAPTURED:
                cap_state = seg_states.get(sid, {}).get("capture_state", CAPTURE_UNCAPTURED)
                keep = cap_state == CAPTURE_CAPTURED
            elif mode == COMPOSE_MODE_SPECIFIC:
                keep = sid in selected_ids
            elif mode == COMPOSE_MODE_REGION:
                r_start = float(region_start) if region_start is not None else 0.0
                r_end = float(region_end) if region_end is not None else float("inf")
                # overlap: segment and region share any time
                keep = seg_end > r_start and seg_start < r_end
            else:
                keep = True

            if keep:
                filtered_script.append(seg)
                if sid:
                    kept_ids.add(sid)

        filtered_manifest = [c for c in clips_manifest if _seg_id(c) in kept_ids]
        return filtered_script, filtered_manifest

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

    def get_overlay_ui_config(self, project_dir: str) -> dict:
        """Get persisted overlay preview UI configuration."""
        state = self.load_state(project_dir)
        config = state.get("overlay_ui_config", {})
        defaults = self._default_state()["overlay_ui_config"]
        ui_zoom = config.get("ui_zoom", defaults["ui_zoom"])
        try:
            ui_zoom = float(ui_zoom)
        except (TypeError, ValueError):
            ui_zoom = defaults["ui_zoom"]
        ui_zoom = max(0.5, min(2.0, ui_zoom))
        selected_preset_id = config.get("selected_preset_id", defaults.get("selected_preset_id"))
        if selected_preset_id is not None:
            selected_preset_id = str(selected_preset_id).strip() or None
        return {
            "ui_zoom": ui_zoom,
            "selected_preset_id": selected_preset_id,
        }

    def update_overlay_ui_config(self, project_dir: str, updates: dict) -> dict:
        """Update persisted overlay preview UI configuration."""
        state = self.load_state(project_dir)
        current = self.get_overlay_ui_config(project_dir)

        if "ui_zoom" in updates and updates["ui_zoom"] is not None:
            try:
                zoom_value = float(updates["ui_zoom"])
            except (TypeError, ValueError):
                zoom_value = current["ui_zoom"]
            current["ui_zoom"] = max(0.5, min(2.0, zoom_value))

        if "selected_preset_id" in updates:
            raw = updates.get("selected_preset_id")
            if raw is None:
                current["selected_preset_id"] = None
            else:
                preset_id = str(raw).strip()
                current["selected_preset_id"] = preset_id or None

        state["overlay_ui_config"] = current
        self.save_state(project_dir, state)
        return current

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
