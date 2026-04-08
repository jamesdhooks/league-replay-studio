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

⚠️  SYNC NOTE: Stages 1–5 + 7–8 and the shared constants (BASE_SCORES,
MANDATORY_TYPES, TIER thresholds, BUCKET_BOUNDARIES, REFERENCE_SPEED_MS)
are mirrored in the frontend at:
    frontend/src/utils/highlight-scoring.js

The frontend omits Stage 6 (exposure adjustment) because it requires
cross-event accumulator state.  The server-side reprocess endpoint is
authoritative.  Keep both files in sync when changing scoring logic.
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
    # SessionLog-sourced incident types (IncidentLogDetector)
    "car_contact":  1.6,   # "Car Contact" (car-to-car) — highest incident priority
    "contact":      1.2,   # "Contact" (wall / barrier)
    "lost_control": 1.1,   # "Lost Control" (spin)
    "off_track":    0.5,   # "Off Track" (track limits)
    "turn_cutting": 0.3,   # "Turn Cutting" (lowest priority)
    # Legacy inferred types (kept for older project databases)
    "crash":        1.5,
    "spinout":      1.2,
    # Other event types
    "incident":     1.5,
    "battle":       1.3,
    "overtake":     1.0,
    "leader_change": 0.9,
    "fastest_lap":  0.7,
    "pit_stop":     0.5,
    "close_call":   0.8,
    "first_lap":    1.3,
    "last_lap":     1.3,
    "pace_lap":     0.4,
}

# These event types are always included (mandatory)
MANDATORY_TYPES = frozenset({"race_start", "race_finish", "restart"})

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

# ── Video Sections ──────────────────────────────────────────────────────────
# The final highlight video is composed of four ordered sections.
# Each non-race section uses a static "TV cam" (iRacing camera group)
# so graphics can be overlaid cleanly in a later pipeline step.

VIDEO_SECTIONS = ("intro", "qualifying_results", "race", "race_results")

# Default durations for non-race sections (seconds)
DEFAULT_SECTION_DURATIONS: dict[str, float] = {
    "intro": 10.0,
    "qualifying_results": 15.0,
    "race_results": 20.0,
    # "race" duration is determined by the event-driven timeline
}

# Preferred iRacing TV camera sources for static B-roll sections.
# Group names match iRacing's CameraInfo → Groups → GroupName entries.
# The capture engine tries each name in order, selecting the first match
# found in the session's available camera groups.
TV_CAM_PREFERENCES: dict[str, list[str]] = {
    "intro": ["Scenic", "TV Static", "TV1", "Blimp", "Pit Lane"],
    "qualifying_results": ["Pit Lane", "TV Static", "TV1", "Scenic"],
    "race_results": ["TV Static", "TV1", "Pit Lane", "Scenic", "Blimp"],
    "gap_filler": ["TV Static", "TV1", "Scenic"],
}

# Default overlay template ID to apply per section.
# These match the built-in template IDs in overlay_service.py.
# Can be overridden via section_config[section]["overlay_template_id"].
DEFAULT_SECTION_TEMPLATES: dict[str, str] = {
    "intro": "cinematic",
    "qualifying_results": "broadcast",
    "race": "broadcast",
    "race_results": "broadcast",
    "gap_filler": "minimal",
}

# Default clip-start padding (seconds) — trimmed after capture
DEFAULT_CLIP_PADDING = 0.5


# ── Scoring Pipeline ────────────────────────────────────────────────────────


def score_events(
    events: list[dict],
    weights: dict[str, float],
    race_duration: float = 0.0,
    num_drivers: int = 1,
    target_duration: float = 300.0,
    tuning: Optional[dict] = None,
) -> list[dict]:
    """Score all events through the 8-stage pipeline.

    Args:
        events: List of event dicts from the database.
        weights: User-configured per-type weights (0–100).
        race_duration: Total race duration in seconds.
        num_drivers: Number of drivers in the race.
        target_duration: Target highlight duration in seconds.
        tuning: Optional dict of iRD-inspired scoring knobs:
            battleFrontBias       — extra multiplier for front-of-field battles (default 1.0)
            preferredDriversOnly  — if True, zero-score events with no preferred driver (default False)
            preferredDrivers      — comma-separated preferred driver name substrings
            ignoreIncidentsDuringFirstLap — zero-score incidents in the first-lap bucket (default False)
            firstLapStickyPeriod  — seconds from race start to boost first-lap events (0 = off)
            lastLapStickyPeriod   — seconds before race end to boost last-lap events (0 = off)
            firstLapWeight        — multiplier for events in the first-lap window (default 1.0)
            lastLapWeight         — multiplier for events in the last-lap window (default 1.0)
            lateRaceThreshold     — race fraction after which late-race bonus applies (default 0.9)
            lateRaceMultiplier    — multiplier applied beyond lateRaceThreshold (default 1.2)

    Returns:
        List of scored event dicts with 'score', 'tier', 'bucket',
        and 'score_components' fields added.
    """
    if not events:
        logger.debug("score_events: no events to score")
        return []

    logger.info(
        "score_events: scoring %d events (race_duration=%.1fs, num_drivers=%d, target=%.1fs)",
        len(events), race_duration, num_drivers, target_duration,
    )

    # ── Extract tuning knobs ──────────────────────────────────────────────
    tuning = tuning or {}
    battle_front_bias: float = tuning.get("battleFrontBias", 1.0)
    preferred_drivers_only: bool = bool(tuning.get("preferredDriversOnly", False))
    preferred_driver_str: str = tuning.get("preferredDrivers", "") or ""
    preferred_names: list[str] = [
        n.strip().lower() for n in preferred_driver_str.split(",") if n.strip()
    ]
    ignore_incidents_first_lap: bool = bool(tuning.get("ignoreIncidentsDuringFirstLap", False))
    first_lap_sticky: float = float(tuning.get("firstLapStickyPeriod", 0))
    last_lap_sticky: float = float(tuning.get("lastLapStickyPeriod", 0))
    first_lap_weight: float = float(tuning.get("firstLapWeight", 1.0))
    last_lap_weight: float = float(tuning.get("lastLapWeight", 1.0))
    late_race_threshold: float = float(tuning.get("lateRaceThreshold", 0.9))
    late_race_multiplier: float = float(tuning.get("lateRaceMultiplier", 1.2))

    _INCIDENT_TYPES = frozenset({"incident", "crash", "spinout", "contact", "close_call"})
    _FIRST_LAP_BUCKET_END = BUCKET_BOUNDARIES["intro"][1]  # 0.15 of race
    _POST_RACE_EXCLUDED_TYPES = frozenset({
        "battle", "overtake", "incident", "crash", "spinout", "contact", "close_call",
        "leader_change", "pit_stop", "fastest_lap", "undercut", "overcut", "pit_battle",
        "first_lap",
    })

    # Pre-compute the race finish cutoff: end of the race_finish event window.
    # Events of excluded types that start after this time are cooldown-lap events
    # and should not appear in the highlight reel.
    race_finish_cutoff: Optional[float] = None
    for ev in events:
        if ev.get("event_type") == "race_finish":
            t = ev.get("end_time_seconds") or 0.0
            if race_finish_cutoff is None or t < race_finish_cutoff:
                race_finish_cutoff = t

    exposure_map: dict[int, float] = defaultdict(float)
    driver_weight = 1.0  # Equal weight for all drivers
    results = []

    for event in events:
        components: dict[str, float] = {}

        # Stage 1 — Base Score
        # Mandatory events use their natural base score (not inflated to 10)
        # so they don't distort the score range. They're force-included in selection instead.
        event_type = event.get("event_type", "")
        base = BASE_SCORES.get(event_type, 0.5)
        score = base
        components["base"] = base
        components["mandatory"] = event_type in MANDATORY_TYPES

        # Stage 2 — Position Importance Multiplier
        position = event.get("position") or 99
        if position <= 3:
            pos_mult = 2.0
        elif position <= 10:
            pos_mult = 1.5
        else:
            pos_mult = 1.0
        # Battle front bias: scale up front-of-field battles relative to mid-pack.
        # Inspired by iRD BattleFactor2 — a bias > 1.0 makes front battles comparatively
        # more likely to be selected.  Applied as a graduated multiplier so P1 battles
        # gain the full bias and P4-10 gain a partial (√bias) bump.
        if event_type == "battle" and battle_front_bias != 1.0:
            if position <= 3:
                pos_mult *= battle_front_bias
            elif position <= 10:
                pos_mult *= math.sqrt(battle_front_bias)
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
        # Overtakes during a sustained battle are more exciting (passer earned it)
        if event_type == "overtake" and metadata.get("in_battle"):
            narrative_bonus += 0.4
        evt_time = event.get("start_time_seconds", 0)
        if race_duration > 0:
            race_pct = evt_time / race_duration
            # Late-race bonus (threshold and multiplier are now tunable)
            if race_pct > late_race_threshold:
                late_race_bonus = score * (late_race_multiplier - 1)
                score *= late_race_multiplier
                narrative_bonus += late_race_bonus
        # First-lap sticky window bonus
        if first_lap_sticky > 0 and evt_time <= first_lap_sticky:
            score *= first_lap_weight
        # Last-lap sticky window bonus
        if last_lap_sticky > 0 and race_duration > 0:
            if race_duration - evt_time <= last_lap_sticky:
                score *= last_lap_weight
        score += narrative_bonus
        components["narrative_bonus"] = round(narrative_bonus, 3)

        # ── Tuning filters (applied before exposure stage) ───────────────
        # Ignore incidents during the first-lap window
        if ignore_incidents_first_lap and event_type in _INCIDENT_TYPES:
            if race_duration > 0:
                if evt_time / race_duration <= _FIRST_LAP_BUCKET_END:
                    score = 0.0
                    components["filtered"] = "ignore_incidents_first_lap"

        # Exclusive preferred-driver mode: zero out events with no preferred driver
        if preferred_drivers_only and preferred_names and event_type not in MANDATORY_TYPES:
            driver_names = event.get("driver_names") or []
            if isinstance(driver_names, str):
                try:
                    driver_names = json.loads(driver_names)
                except (json.JSONDecodeError, TypeError):
                    driver_names = []
            has_preferred = any(
                any(p in name.lower() for p in preferred_names)
                for name in driver_names
            )
            if not has_preferred:
                score = 0.0
                components["filtered"] = "preferred_drivers_only"

        # Filter cooldown-lap events: zero out excluded types that start after the
        # race finish window ends. last_lap (P2–P10 finish crossings) is exempt.
        if race_finish_cutoff is not None and event_type in _POST_RACE_EXCLUDED_TYPES:
            if evt_time > race_finish_cutoff:
                score = 0.0
                components["filtered"] = "post_race_finish"

        # Stage 6 — Exposure Adjustment
        involved = event.get("involved_drivers") or "[]"
        if isinstance(involved, str):
            try:
                involved = json.loads(involved)
            except (json.JSONDecodeError, TypeError):
                involved = []
        if num_drivers > 0 and involved:
            # Use race_duration for exposure target — we want proportional
            # representation relative to the race, not equal slices of the
            # highlight budget.
            effective_duration = race_duration if race_duration > 0 else target_duration
            target_exposure = effective_duration / max(num_drivers, 1) * driver_weight
            avg_exposure = sum(exposure_map.get(d, 0) for d in involved) / len(involved)
            exposure_adj = 1 + (target_exposure - avg_exposure) * 0.5
            exposure_adj = max(0.5, min(exposure_adj, 2.0))  # Clamp
        else:
            exposure_adj = 1.0
        score *= exposure_adj
        components["exposure_adj"] = round(exposure_adj, 3)

        # Stage 7 — User Weight Override
        user_weight = weights.get(event_type, 50) / 100.0
        score *= user_weight
        components["user_weight"] = user_weight

        # Stage 8 — Tier Classification
        score = round(score, 2)
        if score > TIER_S_THRESHOLD:
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
            "raw_score": score,
            "tier": tier,
            "bucket": bucket,
            "score_components": components,
        })

    # ── Normalize scores to 0–10 range ──────────────────────────────────
    raw_scores = [r["score"] for r in results if r["score"] > 0]
    if len(raw_scores) >= 2:
        min_raw = min(raw_scores)
        max_raw = max(raw_scores)
        score_range = max_raw - min_raw
        if score_range > 0:
            for r in results:
                if r["score"] <= 0:
                    continue
                # Normalize to 0.5–10 (floor at 0.5 so nothing maps to exactly 0)
                r["score"] = round(0.5 + ((r["score"] - min_raw) / score_range) * 9.5, 2)
                r["score_components"]["normalization"] = {
                    "raw": r["raw_score"], "min": min_raw, "max": max_raw,
                }
        else:
            for r in results:
                if r["score"] <= 0:
                    continue
                r["score"] = 5.0
                r["score_components"]["normalization"] = {
                    "raw": r["raw_score"], "min": min_raw, "max": max_raw,
                }

        # Re-classify tiers with normalized scores
        for r in results:
            s = r["score"]
            if s > TIER_S_THRESHOLD:
                r["tier"] = "S"
            elif s >= TIER_A_THRESHOLD:
                r["tier"] = "A"
            elif s >= TIER_B_THRESHOLD:
                r["tier"] = "B"
            else:
                r["tier"] = "C"

    tier_counts = defaultdict(int)
    for r in results:
        tier_counts[r["tier"]] += 1
    logger.info(
        "score_events: scored %d events — S:%d A:%d B:%d C:%d (normalized to 0-10)",
        len(results), tier_counts["S"], tier_counts["A"], tier_counts["B"], tier_counts["C"],
    )
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


# ── Full Pipeline ────────────────────────────────────────────────────────────


def generate_highlights(
    events: list[dict],
    target_duration: float = 300.0,
    weights: Optional[dict[str, float]] = None,
    constraints: Optional[dict] = None,
    overrides: Optional[dict] = None,
    race_info: Optional[dict] = None,
    tuning: Optional[dict] = None,
) -> dict:
    """Run the full highlight generation pipeline.

    Args:
        events: Raw race events from the database.
        target_duration: Target highlight duration in seconds.
        weights: Per-event-type weight overrides (0–100).
        constraints: max_driver_exposure, pip_threshold, min_severity.
        overrides: Manual overrides {event_id: action}.
        race_info: Race metadata (track, num_drivers, duration, etc.).
        tuning: iRD-inspired scoring knobs (see score_events docstring).

    Returns:
        Dict with scored_events, timeline, and metrics.
    """
    weights = weights or {}
    constraints = constraints or {}
    overrides = overrides or {}
    race_info = race_info or {}
    tuning = tuning or {}

    race_duration = race_info.get("duration", 0)
    num_drivers = race_info.get("num_drivers", 1)

    logger.info(
        "generate_highlights: %d events, target=%.1fs, overrides=%d",
        len(events), target_duration, len(overrides),
    )

    # Stage 1: Score all events
    scored = score_events(events, weights, race_duration, num_drivers, target_duration, tuning=tuning)

    # Stage 2: Apply manual overrides
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

    # Stage 7: Compute metrics
    metrics = _compute_metrics(scored, timeline, target_duration, race_duration, num_drivers)

    logger.info(
        "generate_highlights: complete — %d scored, %d timeline segments, "
        "coverage=%.1f%%, balance=%.2f",
        len(scored), len(timeline),
        metrics.get("coverage_pct", 0), metrics.get("balance", 0),
    )

    return {
        "scored_events": scored,
        "timeline": timeline,
        "metrics": metrics,
    }


def generate_video_script(
    events: list[dict],
    target_duration: float = 300.0,
    weights: Optional[dict[str, float]] = None,
    constraints: Optional[dict] = None,
    overrides: Optional[dict] = None,
    race_info: Optional[dict] = None,
    section_config: Optional[dict] = None,
    clip_padding: float = DEFAULT_CLIP_PADDING,
    tuning: Optional[dict] = None,
) -> dict:
    """Generate a full Video Composition Script with four sections.

    The script contains ordered segments for:
      1. **intro** — Static B-roll with scenic/blimp cam for title card overlay
      2. **qualifying_results** — Pit-lane / static cam for grid graphics
      3. **race** — Event-driven highlight timeline (from generate_highlights)
      4. **race_results** — Static cam for finishing order graphics

    Each segment carries enough info for the capture engine to:
      - Seek the replay to the correct point (minus clip_padding)
      - Select the right iRacing camera group
      - Start/stop recording independently
      - Name the clip for association with its script ID

    Args:
        events: Raw race events from the database.
        target_duration: Target *race* highlight duration in seconds.
        weights: Per-event-type weight overrides (0–100).
        constraints: max_driver_exposure, pip_threshold, min_severity.
        overrides: Manual overrides {event_id: action}.
        race_info: Race metadata (track, num_drivers, duration, etc.).
        section_config: Override durations/cameras per section.
        clip_padding: Seconds to pre-roll before each clip (trimmed later).

    Returns:
        Dict with 'script' (ordered segment list), 'scored_events',
        'timeline' (race section only), 'metrics', and 'sections' summary.
    """
    race_info = race_info or {}
    section_config = section_config or {}
    race_duration = race_info.get("duration", 0)

    # ── Build race section via existing pipeline ────────────────────────────
    hl_result = generate_highlights(
        events=events,
        target_duration=target_duration,
        weights=weights,
        constraints=constraints,
        overrides=overrides,
        race_info=race_info,
        tuning=tuning,
    )
    race_timeline = hl_result["timeline"]

    # Determine race start/end from the timeline or race_info
    race_start = 0.0
    race_end = race_duration
    if race_timeline:
        event_segs = [s for s in race_timeline if s.get("type") != "transition"]
        if event_segs:
            race_start = event_segs[0].get("start_time_seconds", 0)
            race_end = event_segs[-1].get("end_time_seconds", race_duration)

    # ── Build non-race sections (B-roll) ────────────────────────────────────
    script: list[dict] = []
    section_idx = 0

    for section_name in VIDEO_SECTIONS:
        if section_name == "race":
            # Inject the race event timeline segments
            race_template = section_config.get("race", {}).get(
                "overlay_template_id",
                DEFAULT_SECTION_TEMPLATES.get("race", "broadcast"),
            )
            for seg in race_timeline:
                seg_entry: dict = {
                    **seg,
                    "section": "race",
                    "clip_padding": clip_padding,
                    "overlay_template_id": seg.get("overlay_template_id") or race_template,
                }
                # Battle camera choreography hints (iRD-inspired)
                # Guides the capture engine to: open with a broadcast angle,
                # cycle through cockpit/bumper/TV views, and prefer a reverse
                # angle when the following car is looking at the car ahead.
                if seg.get("event_type") == "battle":
                    drivers = seg.get("involved_drivers") or []
                    if isinstance(drivers, str):
                        try:
                            drivers = json.loads(drivers)
                        except (json.JSONDecodeError, TypeError):
                            drivers = []
                    seg_entry["camera_hints"] = {
                        "establishing_angle": "TV1",
                        "cycle_angles": ["cockpit", "bumper", "TV1"],
                        "reverse_on_behind": True,
                        "preferred_car_idx": drivers[0] if drivers else None,
                    }
                script.append(seg_entry)
            continue

        # Static B-roll section
        cfg = section_config.get(section_name, {})
        duration = cfg.get("duration", DEFAULT_SECTION_DURATIONS.get(section_name, 10.0))
        cam_prefs = cfg.get(
            "camera_preferences",
            TV_CAM_PREFERENCES.get(section_name, ["TV Static", "TV1"]),
        )
        camera_group = cfg.get("camera_group")  # User-selected override
        overlay_template_id = cfg.get(
            "overlay_template_id",
            DEFAULT_SECTION_TEMPLATES.get(section_name, "broadcast"),
        )

        # Choose a replay time to capture this B-roll from
        if section_name == "intro":
            # Use a time shortly before the race starts (formation / grid)
            broll_time = max(0, race_start - 30)
        elif section_name == "qualifying_results":
            # Use the very start of the race session (pre-green)
            broll_time = max(0, race_start - 10)
        elif section_name == "race_results":
            # Use a time after the race ends (cooldown lap / podium)
            broll_time = race_end + 5
        else:
            broll_time = race_start

        broll_time = cfg.get("start_time_seconds", broll_time)

        section_idx += 1
        script.append({
            "id": f"section_{section_name}",
            "type": "broll",
            "section": section_name,
            "source": "tv_cam",
            "camera_preferences": cam_prefs,
            "camera_group": camera_group,
            "start_time_seconds": broll_time,
            "end_time_seconds": broll_time + duration,
            "duration": duration,
            "purpose": section_name,
            "clip_padding": clip_padding,
            "editable": True,
            "overlay_template_id": overlay_template_id,
        })

    # ── Sections summary for frontend ───────────────────────────────────────
    sections_summary = []
    for section_name in VIDEO_SECTIONS:
        segs = [s for s in script if s.get("section") == section_name]
        total_dur = sum(
            s.get("end_time_seconds", 0) - s.get("start_time_seconds", 0)
            for s in segs
        )
        sections_summary.append({
            "name": section_name,
            "segment_count": len(segs),
            "duration": round(total_dur, 1),
            "editable": section_name != "race",
        })

    return {
        "script": script,
        "scored_events": hl_result["scored_events"],
        "timeline": race_timeline,
        "metrics": hl_result["metrics"],
        "sections": sections_summary,
        "clip_padding": clip_padding,
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
