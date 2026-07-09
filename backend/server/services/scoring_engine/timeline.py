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
    DEFAULT_BUCKET_REPEAT_PENALTY,
    DEFAULT_DIVERSITY_STRENGTH,
    DEFAULT_DRIVER_COVERAGE_STRENGTH,
    DEFAULT_DRIVER_SWAP_SCORE_FLOOR,
    DEFAULT_FLOOR_BOOST,
    DEFAULT_MAX_DRIVER_COVERAGE_SWAPS,
    DEFAULT_MAX_FLOOR_REBALANCE_SWAPS,
    DEFAULT_MIX_MAX,
    DEFAULT_NEW_DRIVER_BOOST,
    DEFAULT_PIP_THRESHOLD,
    DEFAULT_REPEAT_DRIVER_PENALTY,
    DEFAULT_TARGET_UNIQUE_DRIVER_SHARE,
    DEFAULT_TYPE_DECAY_BASE,
    MANDATORY_TYPES,
    TV_CAM_PREFERENCES,
)

logger = logging.getLogger(__name__)


# ── Helper Functions ─────────────────────────────────────────────────────────


def _tier_priority(tier: str) -> int:
    """Map tier to sort priority (higher = more important)."""
    return {"S": 4, "A": 3, "B": 2, "C": 1}.get(tier, 0)


# ── Diversity / mix-balancing helpers (Balanced Selection v3) ───────────────


def _diversity_scale(diversity_strength: float) -> float:
    """Convert 0–100 slider into a multiplier. 0 disables diversity, 50 nominal, 100 aggressive."""
    return max(0.0, float(diversity_strength)) / 50.0


def _type_decay_factor(count: int, decay_base: float, scale: float) -> float:
    """Diminishing returns: Nth event of a type is worth decay_base^(N*scale) of its score."""
    if scale <= 0 or count <= 0:
        return 1.0
    base = max(0.01, min(1.0, float(decay_base)))
    return base ** (count * scale)


def _quota_pressure(
    used_share: float,
    mix_min: Optional[float],
    mix_max: Optional[float],
    floor_boost: float,
    scale: float,
) -> float:
    """Quota pressure factor.

    Returns 0 (hard exclude) if the type's used share has reached its hard cap.
    Returns >1 (boost) if the type is below its soft floor.
    Returns 1 otherwise.
    """
    if mix_max is not None and used_share >= float(mix_max):
        return 0.0
    if scale > 0 and mix_min is not None and used_share < float(mix_min):
        # Boost scales with diversity_strength; at scale=0 no boost is applied.
        return 1.0 + (float(floor_boost) - 1.0) * scale
    return 1.0


def _bucket_diversity_factor(bucket_type_count: int, repeat_penalty: float, scale: float) -> float:
    """Soft penalty for stacking same-type events inside one temporal bucket.

    Never zero — only nudges. At scale=0 returns 1.0.
    """
    if scale <= 0 or bucket_type_count <= 0:
        return 1.0
    return 1.0 / (1.0 + max(0.0, float(repeat_penalty)) * bucket_type_count * scale)


def _driver_coverage_factor(
    involved: set,
    seen_drivers: set,
    new_driver_boost: float,
    repeat_driver_penalty: float,
    driver_scale: float,
) -> float:
    """Marginal-utility factor for driver field coverage.

    Rewards events that introduce unseen drivers; mildly penalises events
    that repeat already-covered drivers.  Blended toward 1.0 by driver_scale
    so driver_coverage_strength=0 is a strict no-op.

    Args:
        involved: Set of driver IDs for this event.
        seen_drivers: Set of driver IDs already represented in the selected timeline.
        new_driver_boost: Multiplier ceiling when all drivers are new (e.g. 1.40).
        repeat_driver_penalty: Max fractional penalty when all drivers are repeats (e.g. 0.25).
        driver_scale: driver_coverage_strength / 100.  0 disables; 1 = full strength.

    Returns:
        Float factor to multiply the candidate\'s effective score by.
    """
    if driver_scale <= 0 or not involved:
        return 1.0
    unseen = involved - seen_drivers
    unseen_frac = len(unseen) / len(involved)
    raw_boost = unseen_frac * (float(new_driver_boost) - 1.0)
    raw_penalty = (1.0 - unseen_frac) * float(repeat_driver_penalty)
    raw_factor = 1.0 + raw_boost - raw_penalty
    return 1.0 + (raw_factor - 1.0) * driver_scale


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

    # ── Diversity / mix-balancing constraints (Balanced Selection v3) ──────
    # All optional. When diversity_strength == 0 every diversity term collapses
    # to 1.0 and selection reproduces the legacy strict-by-score behavior.
    diversity_strength = float(constraints.get("diversity_strength", DEFAULT_DIVERSITY_STRENGTH))
    type_decay_base = float(constraints.get("type_decay_base", DEFAULT_TYPE_DECAY_BASE))
    bucket_repeat_penalty = float(constraints.get("bucket_repeat_penalty", DEFAULT_BUCKET_REPEAT_PENALTY))
    floor_boost = float(constraints.get("floor_boost", DEFAULT_FLOOR_BOOST))
    max_floor_swaps = int(constraints.get("max_floor_rebalance_swaps", DEFAULT_MAX_FLOOR_REBALANCE_SWAPS))
    mix_min: dict[str, float] = dict(constraints.get("mix_min") or {})
    mix_max: dict[str, float] = dict(constraints.get("mix_max") or {})
    div_scale = _diversity_scale(diversity_strength)

    # ── Driver coverage constraints ────────────────────────────────────────
    driver_coverage_strength = float(constraints.get("driver_coverage_strength", DEFAULT_DRIVER_COVERAGE_STRENGTH))
    new_driver_boost = float(constraints.get("new_driver_boost", DEFAULT_NEW_DRIVER_BOOST))
    repeat_driver_penalty = float(constraints.get("repeat_driver_penalty", DEFAULT_REPEAT_DRIVER_PENALTY))
    target_unique_driver_share = float(constraints.get("target_unique_driver_share", DEFAULT_TARGET_UNIQUE_DRIVER_SHARE))
    max_driver_swaps = int(constraints.get("max_driver_coverage_swaps", DEFAULT_MAX_DRIVER_COVERAGE_SWAPS))
    driver_swap_score_floor = float(constraints.get("driver_swap_score_floor", DEFAULT_DRIVER_SWAP_SCORE_FLOOR))
    driver_scale = max(0.0, driver_coverage_strength) / 100.0

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

    # Pass 2 — Bucket fill (with optional diversity/quota balancing)
    bucket_budgets = {
        name: target_duration * (hi - lo)
        for name, (lo, hi) in BUCKET_BOUNDARIES.items()
    }
    bucket_used: dict[str, float] = defaultdict(float)
    type_count: dict[str, int] = defaultdict(int)
    type_used_duration: dict[str, float] = defaultdict(float)
    bucket_type_count: dict[tuple[str, str], int] = defaultdict(int)
    seen_drivers: set = set()  # drivers already represented in the selected timeline
    for evt in timeline:
        b = evt.get("bucket", "mid")
        t = evt.get("event_type", "unknown")
        d = _evt_selection_duration(evt, constraints)
        bucket_used[b] += d
        type_count[t] += 1
        type_used_duration[t] += d
        bucket_type_count[(b, t)] += 1
        seen_drivers.update(_get_drivers(evt))

    selected_ids = {id(e) for e in timeline}
    remaining_pool = list(remaining)
    target = max(target_duration, 1.0)

    def _effective_score(evt: dict) -> float:
        """Score after applying diversity/quota/bucket/driver-coverage factors. <=0 means skip."""
        t = evt.get("event_type", "unknown")
        b = evt.get("bucket", "mid")
        share = type_used_duration[t] / target
        q = _quota_pressure(share, mix_min.get(t), mix_max.get(t, DEFAULT_MIX_MAX), floor_boost, div_scale)
        if q <= 0:
            return 0.0
        decay = _type_decay_factor(type_count[t], type_decay_base, div_scale)
        bdiv = _bucket_diversity_factor(bucket_type_count[(b, t)], bucket_repeat_penalty, div_scale)
        dcov = _driver_coverage_factor(
            _get_drivers(evt), seen_drivers, new_driver_boost, repeat_driver_penalty, driver_scale
        )
        return max(0.0, evt.get("score", 0)) * q * decay * bdiv * dcov

    # Marginal-utility greedy: re-rank remaining each iteration so diversity
    # terms (which depend on already-selected counts) update correctly.
    while used_duration < target_duration and remaining_pool:
        best_idx = -1
        best_eff = -1.0
        best_evt = None
        for i, evt in enumerate(remaining_pool):
            if id(evt) in selected_ids:
                continue
            b = evt.get("bucket", "mid")
            budget = bucket_budgets.get(b, target_duration * 0.3)
            if bucket_used[b] >= budget:
                continue
            eff = _effective_score(evt)
            # Tier still acts as a strong tie-breaker so S/A events outrank C even with decay.
            tier_bonus = _tier_priority(evt.get("tier", "C")) * 0.001
            eff_total = eff + tier_bonus
            if eff > 0 and eff_total > best_eff:
                best_eff = eff_total
                best_idx = i
                best_evt = evt
        if best_evt is None:
            break
        evt_dur = _evt_selection_duration(best_evt, constraints)
        b = best_evt.get("bucket", "mid")
        t = best_evt.get("event_type", "unknown")
        timeline.append(best_evt)
        selected_ids.add(id(best_evt))
        used_duration += evt_dur
        bucket_used[b] += evt_dur
        type_count[t] += 1
        type_used_duration[t] += evt_dur
        bucket_type_count[(b, t)] += 1
        seen_drivers.update(_get_drivers(best_evt))
        remaining_pool.pop(best_idx)

    # Pass 2b — Overflow fill: if still under target, ignore bucket limits.
    # Hard caps (mix_max) are still respected.
    if used_duration < target_duration:
        for evt in list(remaining_pool):
            if used_duration >= target_duration:
                break
            if id(evt) in selected_ids:
                continue
            t = evt.get("event_type", "unknown")
            cap = mix_max.get(t)
            if cap is not None and (type_used_duration[t] / target) >= float(cap):
                continue
            evt_dur = _evt_selection_duration(evt, constraints)
            b = evt.get("bucket", "mid")
            timeline.append(evt)
            selected_ids.add(id(evt))
            used_duration += evt_dur
            bucket_used[b] += evt_dur
            type_count[t] += 1
            type_used_duration[t] += evt_dur
            bucket_type_count[(b, t)] += 1
            seen_drivers.update(_get_drivers(evt))

    # Pass 4 — Floor rebalance: if any mix_min is unmet, swap low-tier non-mandatory
    # selected events for the strongest unmet-floor candidates. Capped at
    # max_floor_swaps to prevent oscillation.
    diagnostics_swaps: list[dict] = []
    if div_scale > 0 and mix_min and max_floor_swaps > 0:
        swaps_done = 0
        unmet_types = [
            t for t, mn in mix_min.items()
            if (type_used_duration[t] / target) < float(mn)
        ]
        for unmet_t in unmet_types:
            if swaps_done >= max_floor_swaps:
                break
            # Best candidate of unmet type not yet selected
            cand = next(
                (e for e in remaining_pool
                 if e.get("event_type") == unmet_t
                 and id(e) not in selected_ids
                 and e.get("score", 0) > 0),
                None,
            )
            if cand is None:
                continue
            cand_dur = _evt_selection_duration(cand, constraints)
            # Find the weakest swappable selected event (non-mandatory, not force-included,
            # tier B/C, of a type that is over-floor).
            swap_target = None
            for evt in sorted(timeline, key=lambda e: e.get("score", 0)):
                if evt.get("event_type") in MANDATORY_TYPES or evt.get("force_included"):
                    continue
                if evt.get("tier") in ("S", "A"):
                    continue
                t = evt.get("event_type", "unknown")
                if t == unmet_t:
                    continue
                # Don't drop a type below its own floor
                share_after = (type_used_duration[t] - _evt_selection_duration(evt, constraints)) / target
                if t in mix_min and share_after < float(mix_min[t]):
                    continue
                swap_target = evt
                break
            if swap_target is None:
                continue
            # Perform swap
            sw_dur = _evt_selection_duration(swap_target, constraints)
            sw_t = swap_target.get("event_type", "unknown")
            sw_b = swap_target.get("bucket", "mid")
            timeline.remove(swap_target)
            selected_ids.discard(id(swap_target))
            used_duration -= sw_dur
            bucket_used[sw_b] -= sw_dur
            type_count[sw_t] -= 1
            type_used_duration[sw_t] -= sw_dur
            bucket_type_count[(sw_b, sw_t)] = max(0, bucket_type_count[(sw_b, sw_t)] - 1)

            cand_b = cand.get("bucket", "mid")
            timeline.append(cand)
            selected_ids.add(id(cand))
            used_duration += cand_dur
            bucket_used[cand_b] += cand_dur
            type_count[unmet_t] += 1
            type_used_duration[unmet_t] += cand_dur
            bucket_type_count[(cand_b, unmet_t)] += 1

            diagnostics_swaps.append({
                "in_type": unmet_t,
                "in_id": cand.get("id"),
                "out_type": sw_t,
                "out_id": swap_target.get("id"),
            })
            swaps_done += 1

    # Pass 5 — Driver coverage rebalance: if unique-driver share is below target,
    # swap low-tier repeated-driver clips for the strongest new-driver candidate.
    # Skips mandatory, force-included, and tier S/A events to protect story quality.
    diagnostics_driver_swaps: list[dict] = []
    total_race_drivers = constraints.get("num_drivers", 0)
    if driver_scale > 0 and max_driver_swaps > 0 and total_race_drivers > 0:
        current_unique = len(seen_drivers)
        coverage_target_count = int(math.ceil(total_race_drivers * target_unique_driver_share))
        driver_swaps_done = 0
        while current_unique < coverage_target_count and driver_swaps_done < max_driver_swaps:
            # Find the best unselected candidate that introduces at least one uncovered driver.
            uncovered = set(range(total_race_drivers)) - seen_drivers  # rough; works for int IDs
            # Re-derive from event data if available — check remaining_pool + all candidates
            all_pool = [e for e in candidates if id(e) not in selected_ids]
            best_cand = None
            best_cand_score = -1.0
            for evt in all_pool:
                if not (_get_drivers(evt) - seen_drivers):
                    continue  # no new drivers
                s = evt.get("score", 0)
                if s > best_cand_score:
                    best_cand_score = s
                    best_cand = evt
            if best_cand is None:
                break  # nothing introduces new drivers
            # Find the weakest swappable selected event:
            # non-mandatory, not force-included, tier B/C, score <= best_cand / driver_swap_score_floor.
            swap_target = None
            for evt in sorted(timeline, key=lambda e: e.get("score", 0)):
                if evt.get("event_type") in MANDATORY_TYPES or evt.get("force_included"):
                    continue
                if evt.get("tier") in ("S", "A"):
                    continue
                # Only swap if the candidate is strong enough relative to the displaced clip.
                if evt.get("score", 0) > 0 and best_cand_score < evt.get("score", 0) * driver_swap_score_floor:
                    continue
                # Don't swap an event that itself introduces new drivers (keep it for coverage).
                if _get_drivers(evt) - seen_drivers:
                    continue
                swap_target = evt
                break
            if swap_target is None:
                break  # can't safely swap anything
            # Perform the swap.
            sw_dur = _evt_selection_duration(swap_target, constraints)
            sw_t = swap_target.get("event_type", "unknown")
            sw_b = swap_target.get("bucket", "mid")
            timeline.remove(swap_target)
            selected_ids.discard(id(swap_target))
            used_duration -= sw_dur
            bucket_used[sw_b] -= sw_dur
            type_count[sw_t] -= 1
            type_used_duration[sw_t] -= sw_dur
            bucket_type_count[(sw_b, sw_t)] = max(0, bucket_type_count[(sw_b, sw_t)] - 1)
            # Update seen_drivers — rebuild from remaining timeline after removal.
            seen_drivers = set()
            for e in timeline:
                seen_drivers.update(_get_drivers(e))

            cand_dur = _evt_selection_duration(best_cand, constraints)
            cand_b = best_cand.get("bucket", "mid")
            cand_t = best_cand.get("event_type", "unknown")
            timeline.append(best_cand)
            selected_ids.add(id(best_cand))
            used_duration += cand_dur
            bucket_used[cand_b] += cand_dur
            type_count[cand_t] += 1
            type_used_duration[cand_t] += cand_dur
            bucket_type_count[(cand_b, cand_t)] += 1
            seen_drivers.update(_get_drivers(best_cand))

            diagnostics_driver_swaps.append({
                "in_id": best_cand.get("id"),
                "in_type": cand_t,
                "in_score": best_cand_score,
                "out_id": swap_target.get("id"),
                "out_type": sw_t,
                "out_score": swap_target.get("score", 0),
            })
            current_unique = len(seen_drivers)
            driver_swaps_done += 1

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
        "allocate_timeline: selected %d segments (%.1fs total) for %.1fs target — "
        "diversity_strength=%.0f, type_swaps=%d, driver_coverage_strength=%.0f, driver_swaps=%d, "
        "unique_drivers=%d",
        len(timeline), total_dur, target_duration, diversity_strength, len(diagnostics_swaps),
        driver_coverage_strength, len(diagnostics_driver_swaps), len(seen_drivers),
    )

    # Attach selection diagnostics for the caller. We can't set arbitrary attributes
    # on a built-in list, so we mutate the caller-provided constraints dict in place
    # under the "_diagnostics" key. The pipeline reads it back from there.
    _final_unique_drivers = len(seen_drivers)
    diagnostics = {
        "diversity_strength": diversity_strength,
        "type_used_duration": dict(type_used_duration),
        "type_share": {t: round(d / target, 4) for t, d in type_used_duration.items()},
        "mix_min": mix_min,
        "mix_max": mix_max,
        "floors_unmet": [
            t for t, mn in mix_min.items()
            if (type_used_duration[t] / target) < float(mn)
        ],
        "caps_hit": [
            t for t, mx in mix_max.items()
            if mx is not None and (type_used_duration[t] / target) >= float(mx)
        ],
        "swaps": diagnostics_swaps,
        "total_duration": total_dur,
        "target_duration": target_duration,
        # Driver coverage diagnostics
        "driver_coverage_strength": driver_coverage_strength,
        "driver_unique_count": _final_unique_drivers,
        "driver_total_count": total_race_drivers,
        "driver_coverage_pct": round(
            _final_unique_drivers / max(total_race_drivers, 1) * 100, 1
        ),
        "driver_target_unique_share": target_unique_driver_share,
        "driver_target_met": (
            _final_unique_drivers >= int(math.ceil(total_race_drivers * target_unique_driver_share))
            if total_race_drivers > 0 else True
        ),
        "driver_swaps": diagnostics_driver_swaps,
    }
    if isinstance(constraints, dict):
        constraints["_diagnostics"] = diagnostics

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
