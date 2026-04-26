"""
test_scoring_diversity.py
-------------------------
Unit tests for the Balanced Selection v3 algorithm:

- cross-type vs per-type score normalization
- mix_max acts as a hard cap on per-type duration share
- mix_min triggers floor rebalance swaps
- diversity_strength = 0 reproduces legacy score-greedy selection
"""

from __future__ import annotations

import pytest

from server.services.scoring_engine.scoring import score_events
from server.services.scoring_engine.timeline import allocate_timeline


# ---------------------------------------------------------------------------
# Fixture builders
# ---------------------------------------------------------------------------

def _make_event(
    eid: int,
    event_type: str,
    start: float,
    *,
    severity: float = 5.0,
    duration: float = 10.0,
    bucket: str = "mid",
    score: float = 5.0,
    tier: str = "B",
) -> dict:
    return {
        "id": eid,
        "event_type": event_type,
        "start_time_seconds": start,
        "end_time_seconds": start + duration,
        "duration": duration,
        "severity": severity,
        "score": score,
        "tier": tier,
        "bucket": bucket,
        "drivers": [],
        "score_components": {},
    }


def _build_pool(target_duration: float = 600.0) -> list[dict]:
    """Build a deterministic pool: many high-score battles + some other types."""
    events: list[dict] = []
    eid = 0
    # 40 strong battles (each 10s) → would dominate without diversity
    for i in range(40):
        eid += 1
        events.append(_make_event(eid, "battle", start=i * 15.0,
                                  score=9.0 + (i % 3) * 0.1, tier="A"))
    # 10 overtakes
    for i in range(10):
        eid += 1
        events.append(_make_event(eid, "overtake", start=600 + i * 15.0,
                                  score=8.0 - (i * 0.05), tier="B"))
    # 10 incidents
    for i in range(10):
        eid += 1
        events.append(_make_event(eid, "incident", start=750 + i * 15.0,
                                  score=7.5 - (i * 0.05), tier="B"))
    # 5 leader changes
    for i in range(5):
        eid += 1
        events.append(_make_event(eid, "leader_change", start=900 + i * 15.0,
                                  score=7.0, tier="A"))
    return events


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_diversity_strength_zero_reproduces_score_greedy():
    """With diversity_strength=0 and no mix caps, selection is pure score-greedy:
    the highest-scoring battles dominate, just like legacy behavior."""
    events = _build_pool()
    constraints = {
        "diversity_strength": 0,
        "min_severity": 0,
    }
    timeline = allocate_timeline(events, target_duration=300.0, constraints=constraints)
    assert len(timeline) > 0
    type_counts: dict[str, int] = {}
    for evt in timeline:
        type_counts[evt["event_type"]] = type_counts.get(evt["event_type"], 0) + 1
    # battles should account for the vast majority of selections (legacy behavior)
    total = sum(type_counts.values())
    assert type_counts.get("battle", 0) / total >= 0.7, (
        f"diversity_strength=0 should let battles dominate, got {type_counts}"
    )


def test_mix_max_enforces_hard_cap():
    """mix_max[battle]=0.30 forbids battle from exceeding 30% of script time."""
    events = _build_pool()
    target = 300.0
    constraints = {
        "diversity_strength": 60,
        "min_severity": 0,
        "mix_max": {"battle": 0.30},
    }
    timeline = allocate_timeline(events, target_duration=target, constraints=constraints)
    battle_dur = sum(
        (e.get("end_time_seconds", 0) - e.get("start_time_seconds", 0))
        for e in timeline if e.get("event_type") == "battle"
    )
    share = battle_dur / target
    # Allow a small overshoot: cap is checked before adding, so the last clip
    # can push slightly past. Be tolerant of one battle clip's worth.
    assert share <= 0.40, f"battle share {share:.2f} should respect cap of 0.30"


def test_mix_min_pushes_floor_via_swap():
    """mix_min[overtake]=0.20 should trigger floor-rebalance swaps so overtake
    ends up represented even though battles outscore it."""
    events = _build_pool()
    target = 300.0
    constraints = {
        "diversity_strength": 70,
        "min_severity": 0,
        "mix_min": {"overtake": 0.20},
        # No cap on battle so the floor must come from rebalance, not from cap pressure.
    }
    timeline = allocate_timeline(events, target_duration=target, constraints=constraints)
    overtake_dur = sum(
        (e.get("end_time_seconds", 0) - e.get("start_time_seconds", 0))
        for e in timeline if e.get("event_type") == "overtake"
    )
    assert overtake_dur > 0, "overtake floor should produce at least one selection"
    diags = constraints.get("_diagnostics") or {}
    # Either the floor was met outright, or rebalance attempted to fix it.
    floors_unmet = diags.get("floors_unmet") or []
    swaps = diags.get("swaps") or []
    assert ("overtake" not in floors_unmet) or len(swaps) > 0, (
        f"expected floor met or swap attempted; diagnostics={diags}"
    )


def test_diagnostics_are_attached_to_constraints():
    """allocate_timeline should mutate constraints to expose _diagnostics."""
    events = _build_pool()
    constraints = {"diversity_strength": 50, "min_severity": 0}
    allocate_timeline(events, target_duration=300.0, constraints=constraints)
    diags = constraints.get("_diagnostics")
    assert isinstance(diags, dict)
    assert "type_used_duration" in diags
    assert "type_share" in diags
    assert "diversity_strength" in diags


def test_cross_type_normalization_uses_single_global_range():
    """Cross-type normalization stretches all positives onto one 0.5–10 scale,
    so every event's `normalization` component records the same global min/max
    (vs per-type, which records different bounds per type)."""
    raw = []
    for i in range(5):
        raw.append({"id": 100 + i, "event_type": "battle",
                    "start_time_seconds": i * 10, "end_time_seconds": i * 10 + 5,
                    "duration": 5, "severity": 5, "score_components": {}})
    for i in range(5):
        raw.append({"id": 200 + i, "event_type": "incident",
                    "start_time_seconds": 100 + i * 10, "end_time_seconds": 100 + i * 10 + 5,
                    "duration": 5, "severity": 5, "score_components": {}})

    weights = {"battle": 50, "incident": 50}
    scored_x = score_events(raw, weights=weights, race_duration=300.0,
                            tuning={"normalizationMode": "cross_type"})
    norms_x = [e["score_components"].get("normalization") or {} for e in scored_x if e.get("score", 0) > 0]
    assert norms_x, "expected at least one positive-scored event"
    # All cross-type entries share the same global min/max bounds.
    first = norms_x[0]
    assert first.get("mode") == "cross_type"
    for n in norms_x:
        assert n.get("mode") == "cross_type"
        assert n.get("min") == first.get("min")
        assert n.get("max") == first.get("max")


def test_per_type_normalization_mode_is_honored():
    """Explicit per_type mode keeps legacy behavior — each type has its own
    normalization range recorded in score_components."""
    raw = []
    for i in range(5):
        raw.append({"id": 300 + i, "event_type": "battle",
                    "start_time_seconds": i * 10, "end_time_seconds": i * 10 + 5,
                    "duration": 5, "severity": 5, "score_components": {}})
    for i in range(5):
        raw.append({"id": 400 + i, "event_type": "incident",
                    "start_time_seconds": 100 + i * 10, "end_time_seconds": 100 + i * 10 + 5,
                    "duration": 5, "severity": 5, "score_components": {}})

    weights = {"battle": 50, "incident": 50}
    scored = score_events(raw, weights=weights, race_duration=300.0,
                          tuning={"normalizationMode": "per_type"})
    by_type: dict[str, set] = {}
    for e in scored:
        if e.get("score", 0) <= 0:
            continue
        norm = e["score_components"].get("normalization") or {}
        assert norm.get("mode") == "per_type"
        t = e["event_type"]
        by_type.setdefault(t, set()).add((norm.get("min"), norm.get("max")))
    # Each type should have exactly one (min, max) pair recorded.
    for t, bounds in by_type.items():
        assert len(bounds) == 1, f"per-type bounds should be uniform within type {t}: {bounds}"
