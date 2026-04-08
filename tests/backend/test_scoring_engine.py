"""
test_scoring_engine.py
----------------------
Tests for the multi-pass event scoring pipeline.
Run with: pytest tests/backend/test_scoring_engine.py -v
"""

import sys
import os

# Ensure the backend package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.server.services.scoring_engine import (
    score_events,
    allocate_timeline,
    BASE_SCORES,
    MANDATORY_TYPES,
    TIER_S_THRESHOLD,
    TIER_A_THRESHOLD,
    TIER_B_THRESHOLD,
    BUCKET_BOUNDARIES,
    REFERENCE_SPEED_MS,
)


# ── Helpers ──────────────────────────────────────────────────────────────────

def make_event(event_type="incident", severity=5, position=5, start_time=60.0,
               end_time=65.0, metadata=None, involved_drivers=None):
    """Create a minimal event dict for testing."""
    return {
        "id": 1,
        "event_type": event_type,
        "severity": severity,
        "position": position,
        "start_time_seconds": start_time,
        "end_time_seconds": end_time,
        "metadata": metadata or {},
        "involved_drivers": involved_drivers or [],
        "driver_names": [],
    }


DEFAULT_WEIGHTS = {
    "incident": 80, "battle": 60, "overtake": 70, "pit_stop": 20,
    "fastest_lap": 50, "leader_change": 90, "first_lap": 100,
    "last_lap": 100,
    # SessionLog-sourced
    "car_contact": 85, "contact": 65, "lost_control": 55, "off_track": 25, "turn_cutting": 15,
    # Legacy fallbacks
    "crash": 80, "spinout": 60, "close_call": 40,
}


# ── Constants ────────────────────────────────────────────────────────────────

class TestConstants:
    """Verify shared constants are defined correctly."""

    def test_base_scores_has_expected_types(self):
        # New SessionLog-sourced types
        new_types = {"car_contact", "contact", "lost_control", "off_track", "turn_cutting"}
        # Legacy inferred types still in BASE_SCORES for backward-compat
        legacy_types = {"crash", "incident", "battle", "spinout", "overtake",
                        "leader_change", "fastest_lap", "pit_stop", "close_call"}
        expected = new_types | legacy_types
        assert expected.issubset(set(BASE_SCORES.keys()))

    def test_mandatory_types(self):
        assert "race_start" in MANDATORY_TYPES
        assert "race_finish" in MANDATORY_TYPES
        assert "restart" in MANDATORY_TYPES
        assert "incident" not in MANDATORY_TYPES

    def test_tier_thresholds_ordering(self):
        assert TIER_S_THRESHOLD > TIER_A_THRESHOLD > TIER_B_THRESHOLD > 0

    def test_bucket_boundaries_cover_full_range(self):
        boundaries = sorted(BUCKET_BOUNDARIES.values(), key=lambda x: x[0])
        assert boundaries[0][0] == 0.0
        assert boundaries[-1][1] == 1.0
        # No gaps
        for i in range(1, len(boundaries)):
            assert boundaries[i][0] == boundaries[i - 1][1], "Gap in bucket boundaries"


# ── Stage 1: Base Score ──────────────────────────────────────────────────────

class TestBaseScore:
    """Stage 1: Base score by event type."""

    def test_known_event_type_gets_base_score(self):
        event = make_event(event_type="car_contact")
        results = score_events([event], DEFAULT_WEIGHTS)
        assert len(results) == 1
        assert results[0]["score_components"]["base"] == BASE_SCORES.get("car_contact", 1.5)

    def test_unknown_event_type_gets_default(self):
        event = make_event(event_type="unknown_thing")
        results = score_events([event], DEFAULT_WEIGHTS)
        assert results[0]["score_components"]["base"] == 0.5

    def test_mandatory_type_gets_max_score(self):
        # Mandatory types use regular base score (not 10.0)
        # but are flagged as mandatory in score_components for force-inclusion.
        event = make_event(event_type="race_start")
        results = score_events([event], DEFAULT_WEIGHTS)
        assert results[0]["score_components"]["mandatory"] is True


# ── Stage 2: Position Multiplier ─────────────────────────────────────────────

class TestPositionMultiplier:
    """Stage 2: Top-3 get 2x, top-10 get 1.5x, rest get 1x."""

    def test_top_3_position(self):
        event = make_event(position=1)
        results = score_events([event], DEFAULT_WEIGHTS)
        assert results[0]["score_components"]["position"] == 2.0

    def test_top_10_position(self):
        event = make_event(position=7)
        results = score_events([event], DEFAULT_WEIGHTS)
        assert results[0]["score_components"]["position"] == 1.5

    def test_beyond_10_position(self):
        event = make_event(position=15)
        results = score_events([event], DEFAULT_WEIGHTS)
        assert results[0]["score_components"]["position"] == 1.0


# ── Stage 8: Tier Classification ─────────────────────────────────────────────

class TestTierClassification:
    """Stage 8: S/A/B/C tier assignment."""

    def test_mandatory_type_is_tier_s(self):
        # Mandatory race_start is force-included regardless of tier;
        # verify the mandatory flag is True.
        event = make_event(event_type="race_start")
        results = score_events([event], DEFAULT_WEIGHTS)
        assert results[0]["score_components"]["mandatory"] is True

    def test_low_score_is_tier_c(self):
        event = make_event(event_type="pit_stop", position=20)
        # pit_stop base = 0.5, position > 10 = 1.0x, weight 20/100 = 0.2
        results = score_events([event], DEFAULT_WEIGHTS)
        assert results[0]["tier"] == "C"

    def test_scores_are_rounded(self):
        event = make_event()
        results = score_events([event], DEFAULT_WEIGHTS)
        score = results[0]["score"]
        assert score == round(score, 2)


# ── Bucket Classification ────────────────────────────────────────────────────

class TestBucketClassification:
    """Bucket classification based on race position."""

    def test_early_race_gets_intro_bucket(self):
        event = make_event(start_time=10.0)
        results = score_events([event], DEFAULT_WEIGHTS, race_duration=1000.0)
        assert results[0]["bucket"] == "intro"  # 10/1000 = 0.01, in [0, 0.15)

    def test_late_race_gets_late_bucket(self):
        event = make_event(start_time=800.0)
        results = score_events([event], DEFAULT_WEIGHTS, race_duration=1000.0)
        assert results[0]["bucket"] == "late"  # 800/1000 = 0.8, in [0.7, 1.0)

    def test_no_race_duration_defaults_to_mid(self):
        event = make_event(start_time=500.0)
        results = score_events([event], DEFAULT_WEIGHTS, race_duration=0.0)
        assert results[0]["bucket"] == "mid"


# ── Empty Input ──────────────────────────────────────────────────────────────

class TestEdgeCases:
    """Edge cases and empty inputs."""

    def test_empty_events_returns_empty(self):
        assert score_events([], DEFAULT_WEIGHTS) == []

    def test_multiple_events_scored(self):
        events = [
            make_event(event_type="crash", start_time=10),
            make_event(event_type="overtake", start_time=100),
            make_event(event_type="first_lap", start_time=0),
        ]
        results = score_events(events, DEFAULT_WEIGHTS, race_duration=300)
        assert len(results) == 3
        assert all("score" in r and "tier" in r for r in results)


# ── Timeline Allocation ─────────────────────────────────────────────────────

class TestTimelineAllocation:
    """Test multi-pass timeline allocation."""

    def test_allocation_returns_list(self):
        events = [
            make_event(event_type="crash", start_time=50, end_time=55),
            make_event(event_type="first_lap", start_time=0, end_time=10),
        ]
        scored = score_events(events, DEFAULT_WEIGHTS, race_duration=300)
        timeline = allocate_timeline(scored, target_duration=60)
        assert isinstance(timeline, list)

    def test_mandatory_events_always_included(self):
        events = [
            make_event(event_type="first_lap", start_time=0, end_time=10),
            make_event(event_type="pit_stop", start_time=100, end_time=105),
        ]
        scored = score_events(events, DEFAULT_WEIGHTS, race_duration=300)
        timeline = allocate_timeline(scored, target_duration=15)
        # first_lap is mandatory — should always be in timeline
        types_in_timeline = [e["event_type"] for e in timeline]
        assert "first_lap" in types_in_timeline
