"""
scoring_engine.py
-----------------
Multi-pass event scoring pipeline for the highlight generation system.

Replaces the single-pass formula (score = severity × weight/100) with:
  Stage 1: Base score by event type
  Stage 2: Position importance multiplier
  Stage 3: Position change multiplier
  Stage 4: Consequence weighting (speed_ms, positions lost, race impact)
  Stage 5: Narrative bonus (chain length, recency)
  Stage 6: Exposure adjustment (driver screen-time balance)
  Stage 7: User weight override
  Stage 8: Tier classification (S/A/B/C)

Plus multi-pass timeline allocation:
  Pass 1: Must-have events (mandatory types + Tier S)
  Pass 2: Bucket fill (intro/early/mid/late)
  Pass 3: Smoothing (repetition, spacing, exposure rebalance)
  Gap handling: B-roll insertion for gaps ≥ 8s
"""

from __future__ import annotations

import json
import logging
import math
from collections import defaultdict
from typing import Any, Optional

logger = logging.getLogger(__name__)


# ── Base scores by event type ────────────────────────────────────────────────

BASE_SCORES: dict[str, float] = {
    "crash": 1.5,
    "incident": 1.5,
    "battle": 1.3,
    "spinout": 1.2,
    "overtake": 1.0,
    "leader_change": 0.9,
    "fastest_lap": 0.7,
    "pit_stop": 0.5,
    "contact": 1.2,
    "close_call": 0.8,
}

# These event types are always included (mandatory)
MANDATORY_TYPES = frozenset({"first_lap", "last_lap", "restart", "pace_lap"})

# Tier thresholds
TIER_S_THRESHOLD = 9.0
TIER_A_THRESHOLD = 7.0
TIER_B_THRESHOLD = 5.0

# Timeline bucket boundaries (fraction of total race)
BUCKET_BOUNDARIES = {
    "intro": (0.0, 0.15),
    "early": (0.15, 0.40),
    "mid": (0.40, 0.70),
    "late": (0.70, 1.0),
}

# Supported transition types
VALID_TRANSITIONS = frozenset({"cut", "fade", "crossfade", "whip", "zoom"})

# B-roll gap threshold in seconds
BROLL_GAP_THRESHOLD = 8.0

# Default PIP threshold score
DEFAULT_PIP_THRESHOLD = 7.0

# Reference speed for normalisation (70 m/s ≈ 250 km/h)
REFERENCE_SPEED_MS = 70.0


# ── Scoring Pipeline ────────────────────────────────────────────────────────


def score_events(
    events: list[dict],
    weights: dict[str, float],
    race_duration: float = 0.0,
    num_drivers: int = 1,
    target_duration: float = 300.0,
) -> list[dict]:
    """Score all events through the 8-stage pipeline.

    Args:
        events: List of event dicts from the database.
        weights: User-configured per-type weights (0–100).
        race_duration: Total race duration in seconds.
        num_drivers: Number of drivers in the race.
        target_duration: Target highlight duration in seconds.

    Returns:
        List of scored event dicts with 'score', 'tier', 'bucket',
        and 'score_components' fields added.
    """
    if not events:
        return []

    exposure_map: dict[int, float] = defaultdict(float)
    driver_weight = 1.0  # Equal weight for all drivers
    results = []

    for event in events:
        components: dict[str, float] = {}

        # Stage 1 — Base Score
        event_type = event.get("event_type", "")
        if event_type in MANDATORY_TYPES:
            score = 10.0  # Mandatory events always included
            components["base"] = 10.0
        else:
            base = BASE_SCORES.get(event_type, 0.5)
            score = base
            components["base"] = base

        # Stage 2 — Position Importance Multiplier
        position = event.get("position") or 99
        if position <= 3:
            pos_mult = 2.0
        elif position <= 10:
            pos_mult = 1.5
        else:
            pos_mult = 1.0
        score *= pos_mult
        components["position"] = pos_mult

        # Stage 3 — Position Change Multiplier
        metadata = event.get("metadata") or {}
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata)
            except (json.JSONDecodeError, TypeError):
                metadata = {}
        position_delta = abs(metadata.get("position_delta", 0))
        pos_change_mult = 1 + position_delta * 0.3
        score *= pos_change_mult
        components["position_change"] = pos_change_mult

        # Stage 4 — Consequence Weighting
        positions_lost = abs(metadata.get("positions_lost", 0))
        speed_ms = metadata.get("speed_ms") or event.get("speed_ms") or 0
        damage_severity = min(speed_ms / REFERENCE_SPEED_MS, 1.0) if speed_ms else 0
        race_impact = metadata.get("race_impact", 0)
        consequence = (positions_lost * 0.3) + (damage_severity * 0.4) + (race_impact * 0.3)
        score *= (1 + consequence)
        components["consequence"] = round(consequence, 3)

        # Stage 5 — Narrative Bonus
        narrative_bonus = 0.0
        if event_type == "battle":
            chain_length = metadata.get("chain_length", 2)
            narrative_bonus += math.log(chain_length + 1) * 0.5
        if race_duration > 0:
            race_pct = event.get("start_time_seconds", 0) / race_duration
            if race_pct > 0.9:
                score *= 1.2
                narrative_bonus += score * 0.2 - score  # Track the bonus
        score += narrative_bonus
        components["narrative_bonus"] = round(narrative_bonus, 3)

        # Stage 6 — Exposure Adjustment
        involved = event.get("involved_drivers") or "[]"
        if isinstance(involved, str):
            try:
                involved = json.loads(involved)
            except (json.JSONDecodeError, TypeError):
                involved = []
        if num_drivers > 0 and involved:
            target_exposure = target_duration / max(num_drivers, 1) * driver_weight
            avg_exposure = sum(exposure_map.get(d, 0) for d in involved) / len(involved)
            exposure_adj = 1 + (target_exposure - avg_exposure) * 0.5
            exposure_adj = max(0.5, min(exposure_adj, 2.0))  # Clamp
        else:
            exposure_adj = 1.0
        score *= exposure_adj
        components["exposure_adj"] = round(exposure_adj, 3)

        # Stage 7 — User Weight Override
        user_weight = weights.get(event_type, 50) / 100.0
        if event_type not in MANDATORY_TYPES:
            score *= user_weight
        components["user_weight"] = user_weight

        # Stage 8 — Tier Classification
        score = round(score, 2)
        if event_type in MANDATORY_TYPES:
            tier = "S"
        elif score > TIER_S_THRESHOLD:
            tier = "S"
        elif score >= TIER_A_THRESHOLD:
            tier = "A"
        elif score >= TIER_B_THRESHOLD:
            tier = "B"
        else:
            tier = "C"

        # Determine bucket based on race position
        bucket = "mid"
        if race_duration > 0:
            pct = event.get("start_time_seconds", 0) / race_duration
            for bname, (lo, hi) in BUCKET_BOUNDARIES.items():
                if lo <= pct < hi:
                    bucket = bname
                    break

        # Update exposure map
        evt_duration = max(0, event.get("end_time_seconds", 0) - event.get("start_time_seconds", 0))
        for d in involved:
            exposure_map[d] += evt_duration

        results.append({
            **event,
            "score": score,
            "tier": tier,
            "bucket": bucket,
            "score_components": components,
        })

    return results


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
        return []

    constraints = constraints or {}
    pip_threshold = constraints.get("pip_threshold", DEFAULT_PIP_THRESHOLD)
    max_driver_exposure = constraints.get("max_driver_exposure", 0.25)
    min_severity = constraints.get("min_severity", 0)

    # Filter by minimum severity
    candidates = [e for e in scored_events if e.get("severity", 0) >= min_severity or e.get("tier") == "S"]

    # Sort by score descending within each tier
    candidates.sort(key=lambda e: (-_tier_priority(e["tier"]), -e["score"]))

    # Pass 1 — Must-have events
    must_have = []
    remaining = []
    for evt in candidates:
        if evt.get("tier") == "S" or evt.get("event_type") in MANDATORY_TYPES:
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

    for evt in remaining:
        if used_duration >= target_duration:
            break
        bucket = evt.get("bucket", "mid")
        budget = bucket_budgets.get(bucket, target_duration * 0.3)
        if bucket_used[bucket] >= budget:
            continue
        evt_dur = _evt_duration(evt)
        timeline.append(evt)
        used_duration += evt_dur
        bucket_used[bucket] += evt_dur

    # Pass 3 — Smoothing
    timeline = _smooth_timeline(timeline, pip_threshold, max_driver_exposure)

    # Sort by time
    timeline.sort(key=lambda e: e.get("start_time_seconds", 0))

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
    """Insert b-roll gap filler segments where gaps are ≥ threshold."""
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
                        "start_time": prev_end,
                        "end_time": cur_start,
                        "start_time_seconds": prev_end,
                        "end_time_seconds": cur_start,
                        "purpose": "gap_filler",
                    })
        result.append(seg)
    return result


# ── Video Composition Script Builder ─────────────────────────────────────────


def build_composition_script(
    timeline: list[dict],
    race_info: Optional[dict] = None,
    render_config: Optional[dict] = None,
    total_events: int = 0,
    llm_used: bool = False,
    llm_model: str = "",
    llm_prompt_hash: str = "",
    validation_status: str = "passed",
) -> dict:
    """Build a Video Composition Script JSON from a finalized timeline.

    The script is a declarative, fully validated document that serves as the
    single source of truth for the render engine.
    """
    race_info = race_info or {}
    render_config = render_config or {}

    segments = []
    for i, seg in enumerate(timeline):
        seg_type = seg.get("type", "event")
        seg_id = seg.get("id", f"seg_{i + 1:03d}")

        if seg_type == "transition":
            segments.append({
                "id": seg_id,
                "type": "transition",
                "transition_type": seg.get("transition_type", "cut"),
                "duration": seg.get("duration", 0.5),
                "from_segment": seg.get("from_segment", ""),
                "to_segment": seg.get("to_segment", ""),
            })
        elif seg_type == "broll":
            segments.append({
                "id": seg_id,
                "type": "broll",
                "source": seg.get("source", "track_side_camera"),
                "start_time": seg.get("start_time_seconds", 0),
                "end_time": seg.get("end_time_seconds", 0),
                "purpose": seg.get("purpose", "gap_filler"),
            })
        elif seg_type == "pip":
            segments.append({
                "id": seg_id,
                "type": "pip",
                "primary": seg.get("primary", {}),
                "secondary": seg.get("secondary", {}),
                "start_time": seg.get("start_time_seconds", 0),
                "end_time": seg.get("end_time_seconds", 0),
                "synchronization": {"mode": "time_aligned"},
            })
        else:
            # Event segment
            duration = max(0, seg.get("end_time_seconds", 0) - seg.get("start_time_seconds", 0))
            segments.append({
                "id": seg_id,
                "type": "event",
                "source_event_id": seg.get("id", ""),
                "start_time": seg.get("start_time_seconds", 0),
                "end_time": seg.get("end_time_seconds", 0),
                "duration": round(duration, 2),
                "drivers": seg.get("involved_drivers", []),
                "priority_score": seg.get("score", 0),
                "notes": seg.get("notes", ""),
                "camera": seg.get("camera", {
                    "mode": "auto",
                    "angle": "broadcast",
                    "follow_driver": None,
                }),
                "capture": seg.get("capture", {
                    "padding_before": 2.0,
                    "padding_after": 3.0,
                }),
                "pip": None,
            })

    # Calculate totals
    event_segments = [s for s in segments if s["type"] == "event"]
    total_duration = sum(s.get("duration", s.get("end_time", 0) - s.get("start_time", 0)) for s in event_segments)
    selected_count = len(event_segments)

    # Driver exposure
    driver_exposure: dict[str, float] = defaultdict(float)
    for s in event_segments:
        dur = s.get("duration", 0)
        for d in s.get("drivers", []):
            driver_key = str(d)
            driver_exposure[driver_key] += dur
    if total_duration > 0:
        driver_exposure = {k: round(v / total_duration, 3) for k, v in driver_exposure.items()}

    return {
        "version": "1.0",
        "meta": {
            "title": race_info.get("title", "League Race Highlights"),
            "source_race_id": race_info.get("race_id", ""),
            "generated_at": race_info.get("generated_at", ""),
            "duration_seconds": round(total_duration, 1),
            "generator": {
                "algorithm_version": "scoring_v3",
                "llm_used": llm_used,
                "llm_model": llm_model if llm_used else "",
            },
        },
        "timeline": segments,
        "render": {
            "resolution": render_config.get("resolution", {"width": 1920, "height": 1080}),
            "frame_rate": render_config.get("frame_rate", 60),
            "codec": render_config.get("codec", "h264"),
            "bitrate": render_config.get("bitrate", "10M"),
            "output_format": render_config.get("output_format", "mp4"),
            "pip_enabled": render_config.get("pip_enabled", True),
        },
        "metadata": {
            "total_events_considered": total_events,
            "events_selected": selected_count,
            "events_rejected": total_events - selected_count,
            "driver_exposure": dict(driver_exposure),
            "llm_used": llm_used,
            "llm_prompt_hash": llm_prompt_hash if llm_used else "",
            "validation_status": validation_status,
        },
    }


def validate_composition_script(script: dict, target_duration: float = 300.0,
                                 max_driver_exposure: float = 0.25) -> tuple[bool, list[str]]:
    """Validate a Video Composition Script against all constraints.

    Returns:
        (is_valid, list_of_error_messages)
    """
    errors = []
    timeline = script.get("timeline", [])

    # 1. Duration within ±5s of target
    event_segs = [s for s in timeline if s.get("type") == "event"]
    actual_duration = sum(s.get("duration", 0) for s in event_segs)
    if abs(actual_duration - target_duration) > 5.0 and target_duration > 0:
        errors.append(f"Duration {actual_duration:.1f}s exceeds ±5s tolerance of target {target_duration:.1f}s")

    # 2. No overlapping non-PIP segments
    for i in range(len(event_segs) - 1):
        end_i = event_segs[i].get("end_time", 0)
        start_next = event_segs[i + 1].get("start_time", 0)
        if end_i > start_next:
            errors.append(f"Segments {event_segs[i]['id']} and {event_segs[i+1]['id']} overlap")

    # 3. Transition types valid
    for seg in timeline:
        if seg.get("type") == "transition":
            tt = seg.get("transition_type", "")
            if tt not in VALID_TRANSITIONS:
                errors.append(f"Invalid transition type '{tt}' in {seg.get('id', '?')}")

    # 4. Driver exposure check
    metadata = script.get("metadata", {})
    for driver, exposure in metadata.get("driver_exposure", {}).items():
        if exposure > max_driver_exposure:
            errors.append(f"Driver {driver} exposure {exposure:.2%} exceeds max {max_driver_exposure:.2%}")

    return len(errors) == 0, errors


# ── Full Pipeline ────────────────────────────────────────────────────────────


def generate_highlights(
    events: list[dict],
    target_duration: float = 300.0,
    weights: Optional[dict[str, float]] = None,
    constraints: Optional[dict] = None,
    overrides: Optional[dict] = None,
    race_info: Optional[dict] = None,
) -> dict:
    """Run the full highlight generation pipeline.

    Args:
        events: Raw race events from the database.
        target_duration: Target highlight duration in seconds.
        weights: Per-event-type weight overrides (0–100).
        constraints: max_driver_exposure, pip_threshold, min_severity.
        overrides: Manual overrides {event_id: action}.
        race_info: Race metadata (track, num_drivers, duration, etc.).

    Returns:
        Dict with scored_events, timeline, script, and metrics.
    """
    weights = weights or {}
    constraints = constraints or {}
    overrides = overrides or {}
    race_info = race_info or {}

    race_duration = race_info.get("duration", 0)
    num_drivers = race_info.get("num_drivers", 1)

    # Stage 1: Score all events
    scored = score_events(events, weights, race_duration, num_drivers, target_duration)

    # Stage 2: Apply manual overrides (pre-LLM)
    scored = _apply_overrides(scored, overrides, phase="pre")

    # Stage 3: Allocate timeline
    timeline = allocate_timeline(scored, target_duration, constraints)

    # Stage 4: Resolve conflicts
    pip_threshold = constraints.get("pip_threshold", DEFAULT_PIP_THRESHOLD)
    timeline = resolve_conflicts(timeline, pip_threshold)

    # Stage 5: Insert b-roll for gaps
    timeline = insert_broll(timeline)

    # Stage 6: Insert transitions
    timeline = insert_transitions(timeline)

    # Stage 7: Build composition script
    script = build_composition_script(
        timeline,
        race_info=race_info,
        total_events=len(events),
    )

    # Stage 8: Compute metrics
    metrics = _compute_metrics(scored, timeline, target_duration, race_duration, num_drivers)

    return {
        "scored_events": scored,
        "timeline": timeline,
        "script": script,
        "metrics": metrics,
    }


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


def _share_drivers(a: dict, b: dict) -> bool:
    """Check if two events share any involved drivers."""
    drivers_a = _get_drivers(a)
    drivers_b = _get_drivers(b)
    return bool(drivers_a & drivers_b)


def _get_drivers(event: dict) -> set:
    """Get set of involved drivers from event."""
    involved = event.get("involved_drivers", [])
    if isinstance(involved, str):
        try:
            involved = json.loads(involved)
        except (json.JSONDecodeError, TypeError):
            involved = []
    return set(involved)


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
                     max_driver_exposure: float) -> list[dict]:
    """Pass 3 — Smoothing: repetition, spacing, exposure rebalance."""
    if len(timeline) < 2:
        return timeline

    # Sort by time for smoothing
    timeline.sort(key=lambda e: e.get("start_time_seconds", 0))

    # Remove back-to-back same-type events unless score differential > 2
    smoothed = [timeline[0]]
    for evt in timeline[1:]:
        prev = smoothed[-1]
        if (evt.get("event_type") == prev.get("event_type")
                and abs(evt.get("score", 0) - prev.get("score", 0)) <= 2.0):
            # Skip repetitive event unless it scores significantly higher
            if evt.get("score", 0) > prev.get("score", 0):
                smoothed[-1] = evt  # Replace with higher scoring
        else:
            smoothed.append(evt)

    return smoothed


def _apply_overrides(events: list[dict], overrides: dict, phase: str = "pre") -> list[dict]:
    """Apply manual overrides to scored events.

    Pre-LLM overrides: force_include, force_exclude, swap
    Post-LLM overrides: adjust_padding, set_pip
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
