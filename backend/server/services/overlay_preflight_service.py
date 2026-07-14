"""Dry-run validation for the overlay data that composition would inject."""
from __future__ import annotations

from typing import Any, Callable

_PLACEHOLDERS = {"none", "null", "undefined", ""}
_REQUIRED_BY_SECTION = {
    "intro": ("track_name",),
    "qualifying_results": ("track_name", "standings"),
    "race": ("track_name", "driver_name"),
    "race_results": ("track_name", "standings"),
}


def preflight_overlay_data(
    clips: list[dict[str, Any]],
    *,
    frame_builder: Callable[..., dict[str, Any]],
) -> dict[str, Any]:
    """Build the exact per-clip overlay data and return blocking diagnostics."""
    reports: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for clip in clips:
        section = str(clip.get("section") or "race")
        clip_id = str(clip.get("id") or clip.get("segment_id") or "unknown")
        frame = frame_builder(
            project_dir=str(clip.get("project_dir") or ""),
            session_time=float(clip.get("start_time_seconds") or 0.0),
            section=section,
            focused_car_idx=None if section == "race" and not clip.get("lock_focus") else clip.get("focused_car_idx"),
            series_name=str(clip.get("series_name") or ""),
            track_name=str(clip.get("track_name") or ""),
            result_session_num=clip.get("result_session_num"),
            replay_session_num=clip.get("session_num"),
        )
        explicit_track = str(clip.get("track_name") or "").strip()
        if explicit_track and (frame.get("track_name") is None or str(frame.get("track_name")).strip().lower() in _PLACEHOLDERS):
            frame["track_name"] = explicit_track
        # A repaired clip may carry a driver identity proven at capture time
        # (camera group + exact car-index readback).  This is intentionally
        # limited to explicit lock-focus repairs; normal race overlays must
        # continue to resolve focus dynamically from telemetry.
        verified_driver = str(clip.get("verified_driver_name") or "").strip()
        if section == "race" and clip.get("lock_focus") and verified_driver and (
            frame.get("driver_name") is None or str(frame.get("driver_name")).strip().lower() in _PLACEHOLDERS
        ):
            frame["driver_name"] = verified_driver
            frame["driver_name_source"] = "capture_verified_lock_focus"
        issues: list[str] = []
        for key in _REQUIRED_BY_SECTION.get(section, ("track_name",)):
            value = frame.get(key)
            if key == "standings":
                if not isinstance(value, list) or not value:
                    issues.append("standings missing")
            elif value is None or str(value).strip().lower() in _PLACEHOLDERS:
                issues.append(f"{key} placeholder")
        report = {"clip_id": clip_id, "section": section, "valid": not issues, "issues": issues, "frame_data": frame}
        reports.append(report)
        if issues:
            errors.append({"clip_id": clip_id, "issues": issues})
    return {"valid": not errors, "clip_count": len(reports), "clips": reports, "errors": errors}
