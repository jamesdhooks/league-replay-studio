from __future__ import annotations

import hashlib
import json
import math
from typing import Any


def _coerce_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_css_time_to_ms(value: str | None) -> float:
    if not value:
        return 0.0

    max_ms = 0.0
    for chunk in str(value).split(","):
        token = chunk.strip().lower()
        if not token:
            continue
        if token.endswith("ms"):
            parsed = _coerce_float(token[:-2]) or 0.0
        elif token.endswith("s"):
            parsed = (float(token[:-1]) if token[:-1] else 0.0) * 1000.0
        else:
            parsed = _coerce_float(token) or 0.0
        max_ms = max(max_ms, parsed)
    return max_ms


def parse_css_iteration_count(value: str | None) -> float:
    if not value:
        return 1.0

    max_iterations = 1.0
    for chunk in str(value).split(","):
        token = chunk.strip().lower()
        if not token:
            continue
        if token == "infinite":
            return 1.0
        try:
            max_iterations = max(max_iterations, float(token))
        except (TypeError, ValueError):
            continue
    return max_iterations


def compute_profile_window_ms(profile: dict[str, Any] | None) -> float:
    if not isinstance(profile, dict):
        return 0.0

    explicit = _coerce_float(profile.get("max_window_ms"))
    if explicit is not None and explicit > 0:
        return explicit

    max_window_ms = 0.0
    for item in profile.get("animated_elements", []) or []:
        duration_ms = parse_css_time_to_ms(item.get("duration"))
        delay_ms = parse_css_time_to_ms(item.get("delay"))
        iterations = parse_css_iteration_count(item.get("iterations"))
        max_window_ms = max(max_window_ms, delay_ms + (duration_ms * iterations))

    transition_ms = 0.0
    for item in profile.get("transition_elements", []) or []:
        duration_ms = parse_css_time_to_ms(item.get("duration"))
        delay_ms = parse_css_time_to_ms(item.get("delay"))
        transition_ms = max(transition_ms, delay_ms + duration_ms)

    return max(max_window_ms, transition_ms)


def build_render_signature(frame_data: dict[str, Any], extra: dict[str, Any] | None = None) -> str:
    subset = {
        "section": frame_data.get("section"),
        "driver_name": frame_data.get("driver_name"),
        "car_number": frame_data.get("car_number"),
        "position": frame_data.get("position"),
        "class_position": frame_data.get("class_position"),
        "current_lap": frame_data.get("current_lap"),
        "total_laps": frame_data.get("total_laps"),
        "flag": frame_data.get("flag"),
        "relative_gap": frame_data.get("relative_gap"),
        "overlay_page_index": frame_data.get("overlay_page_index"),
        "standings": [
            {
                "position": row.get("position"),
                "driver_name": row.get("driver_name"),
                "gap": row.get("gap"),
                "relative": row.get("relative"),
                "is_player": row.get("is_player"),
            }
            for row in (frame_data.get("standings") or [])[:20]
            if isinstance(row, dict)
        ],
    }
    if extra:
        subset["extra"] = extra
    payload = json.dumps(subset, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def compute_frame_data_diff(
    previous: dict[str, Any] | None,
    current: dict[str, Any],
    sensitivity: float = 1.0,
) -> dict[str, Any]:
    if previous is None:
        return {
            "changed_keys": [],
            "has_changes": False,
            "position_changed": False,
            "leader_changed": False,
            "lap_changed": False,
            "flag_changed": False,
            "gap_changed": False,
            "standings_changed": False,
            "page_changed": False,
            "significant": False,
        }

    sensitivity = max(0.25, float(sensitivity or 1.0))
    gap_threshold = 0.25 / sensitivity
    changed_keys: list[str] = []

    def add_changed(name: str, condition: bool) -> bool:
        if condition:
            changed_keys.append(name)
        return condition

    position_changed = add_changed("position", previous.get("position") != current.get("position"))
    lap_changed = add_changed("current_lap", previous.get("current_lap") != current.get("current_lap"))
    flag_changed = add_changed("flag", previous.get("flag") != current.get("flag"))
    driver_changed = add_changed("driver_name", previous.get("driver_name") != current.get("driver_name"))
    page_changed = add_changed(
        "overlay_page_index",
        previous.get("overlay_page_index") != current.get("overlay_page_index"),
    )

    previous_gap = _coerce_float(previous.get("relative_gap"))
    current_gap = _coerce_float(current.get("relative_gap"))
    gap_changed = add_changed(
        "relative_gap",
        previous_gap is not None
        and current_gap is not None
        and abs(previous_gap - current_gap) >= gap_threshold,
    )

    previous_standings = previous.get("standings") or []
    current_standings = current.get("standings") or []
    previous_signature = [
        (row.get("position"), row.get("driver_name"), row.get("gap"), row.get("relative"))
        for row in previous_standings[:20]
        if isinstance(row, dict)
    ]
    current_signature = [
        (row.get("position"), row.get("driver_name"), row.get("gap"), row.get("relative"))
        for row in current_standings[:20]
        if isinstance(row, dict)
    ]
    standings_changed = add_changed("standings", previous_signature != current_signature)

    previous_leader = previous_signature[0][1] if previous_signature else None
    current_leader = current_signature[0][1] if current_signature else None
    leader_changed = add_changed("leader", previous_leader != current_leader)

    significant = any([
        position_changed,
        lap_changed,
        flag_changed,
        driver_changed,
        gap_changed,
        standings_changed,
        page_changed,
        leader_changed,
    ])

    return {
        "changed_keys": changed_keys,
        "has_changes": bool(changed_keys),
        "position_changed": position_changed,
        "leader_changed": leader_changed,
        "lap_changed": lap_changed,
        "flag_changed": flag_changed,
        "gap_changed": gap_changed,
        "standings_changed": standings_changed,
        "page_changed": page_changed,
        "significant": significant,
    }


def merge_animation_windows(windows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not windows:
        return []

    ordered = sorted(windows, key=lambda item: (float(item.get("start", 0.0)), float(item.get("end", 0.0))))
    merged: list[dict[str, Any]] = []
    for window in ordered:
        start = float(window.get("start", 0.0))
        end = float(window.get("end", start))
        reasons = list(window.get("reasons") or [])
        if not merged or start > float(merged[-1].get("end", 0.0)):
            merged.append({
                "start": start,
                "end": end,
                "reasons": reasons,
            })
            continue

        merged[-1]["end"] = max(float(merged[-1].get("end", 0.0)), end)
        merged[-1]["reasons"] = sorted({*merged[-1].get("reasons", []), *reasons})

    return merged


def window_indices_for_time_range(start: float, end: float, fps: float) -> tuple[int, int]:
    if fps <= 0:
        return 0, 0
    start_index = max(0, int(math.floor(start * fps)))
    end_index = max(start_index, int(math.ceil(end * fps)))
    return start_index, end_index