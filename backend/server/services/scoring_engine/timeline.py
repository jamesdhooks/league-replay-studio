"""
timeline.py
-----------
Timeline allocation, conflict resolution, transitions, and gap-filler insertion.
"""

from __future__ import annotations

import json
import logging
import math
from collections import defaultdict
from typing import Any, Optional

from .constants import (
    BROLL_GAP_THRESHOLD,
    MAX_BROLL_FILLER_DURATION,
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


def _evt_selection_duration(event: dict, constraints: Optional[dict] = None) -> float:
    """Get selection duration including per-event lead-in/follow-out padding.

    This mirrors frontend selection budgeting so point events (0s core duration)
    still consume timeline budget based on capture padding.
    """
    constraints = constraints or {}
    core = _evt_duration(event)

    metadata = event.get("metadata") or {}
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except (json.JSONDecodeError, TypeError):
            metadata = {}

    event_type = event.get("event_type")
    by_type = constraints.get("padding_by_type") or {}
    type_cfg = by_type.get(event_type) or {}

    default_before = max(0.0, float(constraints.get("padding_before", 0.0)))
    default_after = max(0.0, float(constraints.get("padding_after", 0.0)))

    before = metadata.get("padding_before", type_cfg.get("before", default_before))
    after = metadata.get("padding_after", type_cfg.get("after", default_after))

    before = max(0.0, float(before or 0.0))
    after = max(0.0, float(after or 0.0))
    return core + before + after


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
                     target_duration: float = 0,
                     constraints: Optional[dict] = None) -> list[dict]:
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
    current_duration = sum(_evt_selection_duration(e, constraints) for e in timeline)

    # Remove back-to-back same-type events unless score differential is significant
    smoothed = [timeline[0]]
    for evt in timeline[1:]:
        prev = smoothed[-1]
        if (evt.get("event_type") == prev.get("event_type")
                and abs(evt.get("score", 0) - prev.get("score", 0)) <= threshold):
            # Never collapse away force-included events.
            if evt.get("force_included") or prev.get("force_included"):
                smoothed.append(evt)
                continue
            # Would removing the lower-scored one drop us below target?
            loser = prev if evt.get("score", 0) > prev.get("score", 0) else evt
            loser_dur = _evt_selection_duration(loser, constraints)
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
    event_segments = [s for s in timeline if s.get("type") not in ("transition", "broll", "bridge")]
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

    # Filter by minimum severity. Force-included events always remain candidates.
    # force_full_video events are intentionally excluded from highlight allocation.
    candidates = [
        e for e in scored_events
        if (
            e.get("force_included")
            or e.get("severity", 0) >= min_severity
            or e.get("tier") == "S"
        ) and not e.get("force_full_video")
    ]

    # Sort by score descending within each tier
    candidates.sort(key=lambda e: (-_tier_priority(e["tier"]), -e["score"]))

    # Pass 1 — Must-have events
    # Always include:
    # - mandatory event types
    # - force-included events (manual highlight override)
    must_have = []
    remaining = []
    for evt in candidates:
        if evt.get("event_type") in MANDATORY_TYPES or evt.get("force_included"):
            must_have.append(evt)
        else:
            remaining.append(evt)

    timeline = list(must_have)
    used_duration = sum(_evt_selection_duration(e, constraints) for e in timeline)

    # Pass 2 — Bucket fill
    bucket_budgets = {
        name: target_duration * (hi - lo)
        for name, (lo, hi) in BUCKET_BOUNDARIES.items()
    }
    bucket_used: dict[str, float] = defaultdict(float)
    for evt in timeline:
        bucket_used[evt.get("bucket", "mid")] += _evt_selection_duration(evt, constraints)

    selected_ids = {id(e) for e in timeline}
    for evt in remaining:
        if used_duration >= target_duration:
            break
        bucket = evt.get("bucket", "mid")
        budget = bucket_budgets.get(bucket, target_duration * 0.3)
        if bucket_used[bucket] >= budget:
            continue
        evt_dur = _evt_selection_duration(evt, constraints)
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
            evt_dur = _evt_selection_duration(evt, constraints)
            timeline.append(evt)
            selected_ids.add(id(evt))
            used_duration += evt_dur

    # Pass 3 — Smoothing
    timeline = _smooth_timeline(
        timeline,
        pip_threshold,
        max_driver_exposure,
        target_duration,
        constraints,
    )

    # Sort by time
    timeline.sort(key=lambda e: e.get("start_time_seconds", 0))

    total_dur = sum(_evt_selection_duration(e, constraints) for e in timeline)
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
        elif seg.get("force_included") and not conflict.get("force_included"):
            _replace_in_list(resolved, conflict, seg)
        elif conflict.get("force_included") and not seg.get("force_included"):
            continue
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


def insert_broll(
    timeline: list[dict],
    gap_threshold: float = BROLL_GAP_THRESHOLD,
    contextual_events: Optional[list[dict]] = None,
    target_duration: float = 0,
) -> list[dict]:
    """Insert gap fillers where gaps are ≥ threshold.

    Strategy:
      1) Prefer contextual race events from unselected candidates in the gap.
      2) Fall back to scenic b-roll only for remaining uncovered gap.
      3) Stop inserting once total timeline duration reaches *target_duration*
         (with a small tolerance) so the final script isn't bloated.

    This keeps the edit focused on actual race action and improves field coverage.
    """
    if len(timeline) < 2:
        return list(timeline)

    # Compute baseline timeline duration (selected events only, no broll yet).
    _base_duration = sum(
        max(0.0, s.get("end_time_seconds", 0) - s.get("start_time_seconds", 0))
        for s in timeline
        if s.get("type") not in ("transition",)
    )
    # Budget for gap-filler content.  0 or negative means no limit.
    _broll_budget = max(0.0, target_duration - _base_duration) if target_duration > 0 else float("inf")
    _broll_used = 0.0

    def _drivers_from(evt: dict) -> set:
        return _get_drivers(evt)

    def _choose_context_events(
        gap_start: float,
        gap_end: float,
        selected_source_ids: set,
        seen_drivers: set,
        type_counts: dict,
    ) -> list[dict]:
        if not contextual_events:
            return []

        # Candidate event overlaps this gap and is not already selected in timeline.
        pool = []
        for evt in contextual_events:
            evt_id = evt.get("id")
            if evt_id in selected_source_ids:
                continue
            if evt.get("score", 0) <= 0:
                continue
            s = evt.get("start_time_seconds", 0)
            e = evt.get("end_time_seconds", 0)
            if e <= gap_start or s >= gap_end:
                continue
            pool.append(evt)

        if not pool:
            return []

        chosen = []
        cursor = gap_start
        used_ids = set()

        # Greedy fill: up to 3 clips per gap to avoid over-fragmentation.
        for _ in range(3):
            if cursor >= gap_end - 0.5:
                break

            best = None
            best_rank = -1e9
            for evt in pool:
                evt_id = evt.get("id")
                if evt_id in used_ids:
                    continue
                s = evt.get("start_time_seconds", 0)
                e = evt.get("end_time_seconds", 0)
                if e <= cursor or s >= gap_end:
                    continue

                clip_start = max(cursor, s)
                clip_end = min(gap_end, e)
                clip_dur = max(0.0, clip_end - clip_start)
                if clip_dur < 1.0:
                    continue

                drivers = _drivers_from(evt)
                new_driver_count = len(drivers - seen_drivers)
                etype = evt.get("event_type", "unknown")
                rarity_bonus = 1.0 / (1.0 + type_counts.get(etype, 0))
                score_term = min(6.0, max(0.0, evt.get("score", 0))) / 6.0
                fit_term = clip_dur / max(1.0, min(gap_end - cursor, MAX_BROLL_FILLER_DURATION))

                # Prefer clips that reduce representation gaps over raw score alone.
                rank = (new_driver_count * 1.6) + (rarity_bonus * 1.2) + (fit_term * 1.0) + (score_term * 0.4)
                if rank > best_rank:
                    best_rank = rank
                    best = (evt, clip_start, clip_end)

            if not best:
                break

            evt, clip_start, clip_end = best
            evt_id = evt.get("id")
            used_ids.add(evt_id)
            selected_source_ids.add(evt_id)

            etype = evt.get("event_type", "unknown")
            type_counts[etype] = type_counts.get(etype, 0) + 1
            seen_drivers.update(_drivers_from(evt))

            chosen.append({
                **evt,
                "type": "context",
                "source_event_id": evt_id,
                "start_time": clip_start,
                "end_time": clip_end,
                "start_time_seconds": clip_start,
                "end_time_seconds": clip_end,
                "duration": clip_end - clip_start,
                "purpose": "context_gap_fill",
            })
            cursor = clip_end

        return chosen

    # Build context about already-selected content for balancing priorities.
    selected_source_ids = set()
    seen_drivers = set()
    type_counts: dict[str, int] = defaultdict(int)
    for seg in timeline:
        if seg.get("type") in ("transition", "broll"):
            continue
        src = seg.get("source_event_id", seg.get("id"))
        if src is not None:
            selected_source_ids.add(src)
        seen_drivers.update(_drivers_from(seg))
        et = seg.get("event_type", "unknown")
        type_counts[et] += 1

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
                    # 1) Prefer contextual race-event clips in this gap.
                    context_clips = _choose_context_events(
                        prev_end,
                        cur_start,
                        selected_source_ids,
                        seen_drivers,
                        type_counts,
                    )
                    for c in context_clips:
                        c_dur = max(0.0, c.get("end_time_seconds", 0) - c.get("start_time_seconds", 0))
                        if _broll_used + c_dur > _broll_budget:
                            break
                        result.append(c)
                        _broll_used += c_dur

                    # Recompute remaining gap after context clips.
                    prev_end = result[-1].get("end_time_seconds", prev_end) if result else prev_end
                    gap = cur_start - prev_end

                if gap >= gap_threshold and _broll_used < _broll_budget:
                    # 2) Fallback bridge filler only for unresolved remainder.
                    # Insert brief bridge clips (capped to budget) so the final
                    # script stays near the target duration.
                    fill_cursor = prev_end
                    while (cur_start - fill_cursor) >= gap_threshold:
                        if _broll_used >= _broll_budget:
                            break
                        broll_idx += 1
                        remaining_budget = _broll_budget - _broll_used
                        broll_end = min(cur_start, fill_cursor + min(MAX_BROLL_FILLER_DURATION, remaining_budget))
                        broll_dur = max(0.0, broll_end - fill_cursor)
                        if broll_dur < 1.0:
                            break
                        result.append({
                            "id": f"bridge_{broll_idx:03d}",
                            "type": "bridge",
                            "source": "track_side_camera",
                            "camera_preferences": TV_CAM_PREFERENCES.get("gap_filler", []),
                            "start_time": fill_cursor,
                            "end_time": broll_end,
                            "start_time_seconds": fill_cursor,
                            "end_time_seconds": broll_end,
                            "duration": broll_dur,
                            "purpose": "bridge_gap_fill",
                        })
                        _broll_used += broll_dur
                        fill_cursor = broll_end
        result.append(seg)
    return result
