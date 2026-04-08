"""
timeline.py
-----------
Timeline allocation, conflict resolution, transitions, and b-roll insertion.
"""

from __future__ import annotations

import json
import logging
import math
from collections import defaultdict
from typing import Any, Optional

from .constants import (
    BROLL_GAP_THRESHOLD,
    BUCKET_BOUNDARIES,
    DEFAULT_PIP_THRESHOLD,
    MANDATORY_TYPES,
    TV_CAM_PREFERENCES,
)

logger = logging.getLogger(__name__)


# ── Helper Functions ─────────────────────────────────────────────────────────


def _tier_priority(tier: str) -> int:
    """Map tier to sort priority (higher = more important)."""
    return {"S": 4, "A": 3, "B": 2, "C": 1}.get(tier, 0)


def _evt_duration(event: dict) -> float:
    """Get event duration in seconds."""
    return max(0, event.get("end_time_seconds", 0) - event.get("start_time_seconds", 0))


def _find_overlap(seg: dict, resolved: list[dict]) -> Optional[dict]:
    """Find any segment in resolved that overlaps with seg."""
    s_start = seg.get("start_time_seconds", 0)
    s_end = seg.get("end_time_seconds", 0)
    for r in resolved:
        r_start = r.get("start_time_seconds", 0)
        r_end = r.get("end_time_seconds", 0)
        if s_start < r_end and s_end > r_start:
            return r
    return None


def _get_drivers(event: dict) -> set:
    """Get set of involved drivers from event."""
    involved = event.get("involved_drivers", [])
    if isinstance(involved, str):
        try:
            involved = json.loads(involved)
        except (json.JSONDecodeError, TypeError):
            involved = []
    return set(involved)


def _share_drivers(a: dict, b: dict) -> bool:
    """Check if two events share any involved drivers."""
    drivers_a = _get_drivers(a)
    drivers_b = _get_drivers(b)
    return bool(drivers_a & drivers_b)


def _merge_clips(a: dict, b: dict) -> dict:
    """Merge two overlapping clips into one extended clip."""
    start = min(a.get("start_time_seconds", 0), b.get("start_time_seconds", 0))
    end = max(a.get("end_time_seconds", 0), b.get("end_time_seconds", 0))
    higher = a if a.get("score", 0) >= b.get("score", 0) else b
    drivers = list(_get_drivers(a) | _get_drivers(b))
    return {
        **higher,
        "start_time_seconds": start,
        "end_time_seconds": end,
        "involved_drivers": drivers,
    }


def _make_pip(a: dict, b: dict) -> dict:
    """Create a PIP segment from two high-scoring events."""
    primary = a if a.get("score", 0) >= b.get("score", 0) else b
    secondary = b if primary is a else a
    return {
        **primary,
        "type": "pip",
        "primary": {
            "source_event_id": primary.get("id", ""),
            "region": "full",
        },
        "secondary": {
            "source_event_id": secondary.get("id", ""),
            "region": "pip",
            "pip_position": "bottom_right",
            "pip_scale": 0.35,
        },
    }


def _replace_in_list(lst: list, old: Any, new: Any) -> None:
    """Replace old item with new in list."""
    for i, item in enumerate(lst):
        if item is old:
            lst[i] = new
            return


def _smooth_timeline(timeline: list[dict], pip_threshold: float,
                     max_driver_exposure: float,
                     target_duration: float = 0) -> list[dict]:
    """Pass 3 — Smoothing: repetition, spacing, exposure rebalance.

    Will not remove events if doing so would drop total duration below
    the target_duration.
    """
    if len(timeline) < 2:
        return timeline

    # Sort by time for smoothing
    timeline.sort(key=lambda e: e.get("start_time_seconds", 0))

    # Compute a relative score threshold (15% of observed score range)
    scores = [e.get("score", 0) for e in timeline]
    score_range = max(scores) - min(scores) if scores else 0
    threshold = max(score_range * 0.15, 0.5)  # Minimum 0.5 for narrow score distributions

    # Track total duration to avoid dropping below target
    current_duration = sum(_evt_duration(e) for e in timeline)

    # Remove back-to-back same-type events unless score differential is significant
    smoothed = [timeline[0]]
    for evt in timeline[1:]:
        prev = smoothed[-1]
        if (evt.get("event_type") == prev.get("event_type")
                and abs(evt.get("score", 0) - prev.get("score", 0)) <= threshold):
            # Would removing the lower-scored one drop us below target?
            loser = prev if evt.get("score", 0) > prev.get("score", 0) else evt
            loser_dur = _evt_duration(loser)
            if target_duration > 0 and (current_duration - loser_dur) < target_duration:
                # Keep both — can't afford to lose duration
                smoothed.append(evt)
            else:
                # Keep the higher-scoring one
                current_duration -= loser_dur
                if evt.get("score", 0) > prev.get("score", 0):
                    smoothed[-1] = evt
        else:
            smoothed.append(evt)

    return smoothed


def _apply_overrides(events: list[dict], overrides: dict, phase: str = "pre") -> list[dict]:
    """Apply manual overrides to scored events.

    Pre-allocation overrides: force_include, force_exclude, swap
    Post-allocation overrides: adjust_padding, set_pip
    """
    if not overrides:
        return events

    result = []
    for evt in events:
        eid = str(evt.get("id", ""))
        action = overrides.get(eid)
        if not action:
            result.append(evt)
            continue

        if phase == "pre":
            if action == "force_include" or action == "highlight":
                evt = {**evt, "tier": "S", "force_included": True}
            elif action == "force_exclude" or action == "exclude":
                continue  # Remove from candidates
            elif action == "full-video":
                evt = {**evt, "force_full_video": True}
        elif phase == "post":
            if isinstance(action, dict) and "padding_before" in action:
                capture = evt.get("capture", {})
                capture.update(action)
                evt = {**evt, "capture": capture}

        result.append(evt)

    return result


def _compute_metrics(scored: list[dict], timeline: list[dict],
                     target_duration: float, race_duration: float,
                     num_drivers: int) -> dict:
    """Compute highlight quality metrics."""
    event_segments = [s for s in timeline if s.get("type") not in ("transition", "broll")]
    highlight_duration = sum(_evt_duration(e) for e in event_segments)

    # Event counts by type
    type_counts: dict[str, int] = defaultdict(int)
    type_durations: dict[str, float] = defaultdict(float)
    for evt in event_segments:
        etype = evt.get("event_type", "unknown")
        type_counts[etype] += 1
        type_durations[etype] += _evt_duration(evt)

    # Tier distribution
    tier_counts: dict[str, int] = defaultdict(int)
    for evt in scored:
        tier_counts[evt.get("tier", "C")] += 1

    # Coverage percentage
    coverage = (highlight_duration / race_duration * 100) if race_duration > 0 else 0

    # Balance score (inverse of stddev of type counts)
    counts = list(type_counts.values()) or [0]
    mean_count = sum(counts) / max(len(counts), 1)
    variance = sum((c - mean_count) ** 2 for c in counts) / max(len(counts), 1)
    balance = max(0, 100 - math.sqrt(variance) * 10)

    # Pacing score (inverse of stddev of time gaps)
    times = sorted(e.get("start_time_seconds", 0) for e in event_segments)
    if len(times) > 1:
        gaps = [times[i + 1] - times[i] for i in range(len(times) - 1)]
        mean_gap = sum(gaps) / len(gaps)
        gap_variance = sum((g - mean_gap) ** 2 for g in gaps) / len(gaps)
        pacing = max(0, 100 - math.sqrt(gap_variance) * 2)
    else:
        pacing = 100

    # Driver coverage
    all_drivers = set()
    for evt in event_segments:
        drivers = _get_drivers(evt)
        all_drivers.update(drivers)
    driver_coverage = (len(all_drivers) / max(num_drivers, 1) * 100) if num_drivers > 0 else 0

    return {
        "total_duration": round(highlight_duration, 1),
        "target_duration": target_duration,
        "event_count": len(event_segments),
        "total_events": len(scored),
        "coverage_percent": round(coverage, 1),
        "balance_score": round(balance, 1),
        "pacing_score": round(pacing, 1),
        "driver_coverage": round(driver_coverage, 1),
        "drivers_included": len(all_drivers),
        "drivers_total": num_drivers,
        "type_counts": dict(type_counts),
        "type_durations": {k: round(v, 1) for k, v in type_durations.items()},
        "tier_counts": dict(tier_counts),
    }


# ── Timeline Allocation ──────────────────────────────────────────────────────


def allocate_timeline(
    scored_events: list[dict],
    target_duration: float,
    constraints: Optional[dict] = None,
) -> list[dict]:
    """Multi-pass timeline allocation.

    Pass 1: Must-have events (mandatory + Tier S)
    Pass 2: Bucket fill by local score
    Pass 3: Smoothing (repetition, spacing, exposure)

    Args:
        scored_events: Events with score/tier/bucket from score_events().
        target_duration: Target highlight duration in seconds.
        constraints: Optional dict with pip_threshold, max_driver_exposure, min_severity.

    Returns:
        Ordered list of selected timeline segments.
    """
    if not scored_events:
        logger.debug("allocate_timeline: no events to allocate")
        return []

    constraints = constraints or {}
    pip_threshold = constraints.get("pip_threshold", DEFAULT_PIP_THRESHOLD)
    max_driver_exposure = constraints.get("max_driver_exposure", 0.25)
    min_severity = constraints.get("min_severity", 0)

    # Filter by minimum severity
    candidates = [e for e in scored_events if e.get("severity", 0) >= min_severity or e.get("tier") == "S"]

    # Sort by score descending within each tier
    candidates.sort(key=lambda e: (-_tier_priority(e["tier"]), -e["score"]))

    # Pass 1 — Must-have events (mandatory types always included regardless of score)
    must_have = []
    remaining = []
    for evt in candidates:
        if evt.get("event_type") in MANDATORY_TYPES:
            must_have.append(evt)
        else:
            remaining.append(evt)

    timeline = list(must_have)
    used_duration = sum(_evt_duration(e) for e in timeline)

    # Pass 2 — Bucket fill
    bucket_budgets = {
        name: target_duration * (hi - lo)
        for name, (lo, hi) in BUCKET_BOUNDARIES.items()
    }
    bucket_used: dict[str, float] = defaultdict(float)
    for evt in timeline:
        bucket_used[evt.get("bucket", "mid")] += _evt_duration(evt)

    selected_ids = {id(e) for e in timeline}
    for evt in remaining:
        if used_duration >= target_duration:
            break
        bucket = evt.get("bucket", "mid")
        budget = bucket_budgets.get(bucket, target_duration * 0.3)
        if bucket_used[bucket] >= budget:
            continue
        evt_dur = _evt_duration(evt)
        timeline.append(evt)
        selected_ids.add(id(evt))
        used_duration += evt_dur
        bucket_used[bucket] += evt_dur

    # Pass 2b — Overflow fill: if still under target, ignore bucket limits
    if used_duration < target_duration:
        for evt in remaining:
            if used_duration >= target_duration:
                break
            if id(evt) in selected_ids:
                continue
            evt_dur = _evt_duration(evt)
            timeline.append(evt)
            selected_ids.add(id(evt))
            used_duration += evt_dur

    # Pass 3 — Smoothing
    timeline = _smooth_timeline(timeline, pip_threshold, max_driver_exposure, target_duration)

    # Sort by time
    timeline.sort(key=lambda e: e.get("start_time_seconds", 0))

    total_dur = sum(
        e.get("end_time_seconds", 0) - e.get("start_time_seconds", 0)
        for e in timeline
    )
    logger.info(
        "allocate_timeline: selected %d segments (%.1fs total) for %.1fs target",
        len(timeline), total_dur, target_duration,
    )
    return timeline


def resolve_conflicts(timeline: list[dict], pip_threshold: float = DEFAULT_PIP_THRESHOLD) -> list[dict]:
    """Resolve overlapping events in the timeline.

    1. Shared drivers → merge into extended clip
    2. Both above pip_threshold → PIP segment
    3. Otherwise keep higher-scored event
    """
    if len(timeline) < 2:
        return timeline

    resolved: list[dict] = []
    for seg in timeline:
        conflict = _find_overlap(seg, resolved)
        if conflict is None:
            resolved.append(seg)
        elif _share_drivers(seg, conflict):
            merged = _merge_clips(seg, conflict)
            _replace_in_list(resolved, conflict, merged)
        elif seg["score"] >= pip_threshold and conflict["score"] >= pip_threshold:
            pip = _make_pip(seg, conflict)
            _replace_in_list(resolved, conflict, pip)
        else:
            winner = seg if seg["score"] > conflict["score"] else conflict
            _replace_in_list(resolved, conflict, winner)

    return resolved


def insert_transitions(timeline: list[dict]) -> list[dict]:
    """Insert transition segments between adjacent clips."""
    if len(timeline) < 2:
        return list(timeline)

    result = []
    for i, seg in enumerate(timeline):
        result.append(seg)
        if i < len(timeline) - 1:
            gap = timeline[i + 1].get("start_time_seconds", 0) - seg.get("end_time_seconds", 0)
            transition_type = "cut" if gap < 3.0 else "crossfade"
            result.append({
                "id": f"trans_{i + 1:03d}",
                "type": "transition",
                "transition_type": transition_type,
                "duration": min(0.5, max(gap, 0)),
                "from_segment": seg.get("id", f"seg_{i:03d}"),
                "to_segment": timeline[i + 1].get("id", f"seg_{i + 1:03d}"),
            })
    return result


def insert_broll(timeline: list[dict], gap_threshold: float = BROLL_GAP_THRESHOLD) -> list[dict]:
    """Insert b-roll gap filler segments where gaps are ≥ threshold.

    Each b-roll segment includes camera_preferences from TV_CAM_PREFERENCES
    so the capture engine can select an appropriate iRacing TV cam.
    """
    if len(timeline) < 2:
        return list(timeline)

    result = []
    broll_idx = 0
    for i, seg in enumerate(timeline):
        if i > 0 and seg.get("type") != "transition":
            prev = result[-1] if result else None
            if prev:
                prev_end = prev.get("end_time_seconds", 0)
                cur_start = seg.get("start_time_seconds", 0)
                gap = cur_start - prev_end
                if gap >= gap_threshold:
                    broll_idx += 1
                    result.append({
                        "id": f"broll_{broll_idx:03d}",
                        "type": "broll",
                        "source": "track_side_camera",
                        "camera_preferences": TV_CAM_PREFERENCES.get("gap_filler", []),
                        "start_time": prev_end,
                        "end_time": cur_start,
                        "start_time_seconds": prev_end,
                        "end_time_seconds": cur_start,
                        "purpose": "gap_filler",
                    })
        result.append(seg)
    return result
