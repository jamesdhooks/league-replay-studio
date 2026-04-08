"""
scoring.py
----------
Multi-pass event scoring pipeline (Stages 1–8).

Scores events through:
  Stage 1: Base score by event type
  Stage 2: Position importance multiplier
  Stage 3: Position change multiplier
  Stage 4: Consequence weighting
  Stage 5: Narrative bonus
  Stage 6: Exposure adjustment
  Stage 7: User weight override
  Stage 8: Tier classification (S/A/B/C)
"""

from __future__ import annotations

import json
import logging
import math
from collections import defaultdict
from typing import Optional

from .constants import (
    BASE_SCORES,
    BUCKET_BOUNDARIES,
    MANDATORY_TYPES,
    REFERENCE_SPEED_MS,
    TIER_A_THRESHOLD,
    TIER_B_THRESHOLD,
    TIER_S_THRESHOLD,
)

logger = logging.getLogger(__name__)


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
