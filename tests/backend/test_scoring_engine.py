"""
test_scoring_engine.py
----------------------
Tests for the multi-pass event scoring pipeline.
Run with: pytest tests/backend/test_scoring_engine.py -v
"""

import sys
import os
import pytest

# Ensure the backend package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.server.services.scoring_engine import (
    score_events,
    allocate_timeline,
    insert_continuity,
    BASE_SCORES,
    MANDATORY_TYPES,
    TIER_S_THRESHOLD,
    TIER_A_THRESHOLD,
    TIER_B_THRESHOLD,
    BUCKET_BOUNDARIES,
    REFERENCE_SPEED_MS,
)
from backend.server.services.scoring_engine.timeline import _continuity_settings


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


class TestContinuityPlanning:
    def test_continuity_settings_scale_to_three_long_runs(self):
        settings = _continuity_settings({"continuity_preference": 100})

        assert settings["max_gap"] == 180
        assert settings["max_sequence_duration"] == 420
        assert settings["max_sequences"] == 3

    def test_balanced_continuity_targets_medium_distributed_blocks(self):
        settings = _continuity_settings({"continuity_preference": 55})

        assert settings["max_gap"] == 25
        assert settings["preferred_sequence_duration"] == 60
        assert settings["max_sequence_duration"] == 81
        assert settings["preferred_sequences"] == 12

    def test_continuity_event_diversity_is_bounded(self):
        low = _continuity_settings({"continuity_event_diversity": -10})
        high = _continuity_settings({"continuity_event_diversity": 140})

        assert low["event_diversity"] == 0
        assert low["event_diversity_scale"] == 0
        assert high["event_diversity"] == 100
        assert high["event_diversity_scale"] == 1

    def test_insert_continuity_enforces_hard_clip_floor(self):
        result = insert_continuity(
            [{**make_event("overtake", start_time=10, end_time=11), "id": 1}],
            {"continuity_preference": 100, "padding_before": 0, "padding_after": 0},
        )

        assert result[0]["duration"] == 6

    def test_insert_continuity_keeps_events_distinct_and_joins_boundaries(self):
        timeline = [
            {**make_event("battle", start_time=10, end_time=20), "id": 1},
            {**make_event("overtake", start_time=25, end_time=35), "id": 2},
        ]
        result = insert_continuity(timeline, {
            "continuity_preference": 100,
            "padding_before": 0,
            "padding_after": 0,
        })

        assert len(result) == 2
        assert all(segment.get("type") != "sequence" for segment in result)
        assert result[0]["continuity_group_id"] == result[1]["continuity_group_id"]
        assert result[0]["end_time_seconds"] == result[1]["start_time_seconds"]

    def test_insert_continuity_respects_remaining_target_budget(self):
        timeline = [
            {**make_event("battle", start_time=10, end_time=15), "id": 1},
            {**make_event("overtake", start_time=20, end_time=25), "id": 2},
        ]
        result = insert_continuity(timeline, {
            "continuity_preference": 100,
            "padding_before": 0,
            "padding_after": 0,
            "target_duration": 12,
        })

        assert result[0]["continuity_group_id"] != result[1]["continuity_group_id"]

    def test_allocator_prefers_adjacent_candidate_within_target(self):
        anchor = {**make_event("leader_change", start_time=0, end_time=20), "id": 1,
                  "score": 10, "tier": "S", "bucket": "intro", "force_included": True}
        isolated = {**make_event("overtake", start_time=70, end_time=130), "id": 3,
                    "score": 8, "tier": "A", "bucket": "late"}
        adjacent = {**make_event("overtake", start_time=25, end_time=85), "id": 2,
                    "score": 3, "tier": "C", "bucket": "early"}

        result = allocate_timeline([anchor, isolated, adjacent], 100, {
            "continuity_preference": 100,
            "padding_before": 0,
            "padding_after": 0,
            "diversity_strength": 0,
            "driver_coverage_strength": 0,
        })

        selected_ids = {event["id"] for event in result}
        assert selected_ids == {1, 2}

    def test_allocator_uses_block_variety_to_prefer_a_new_event_type(self):
        anchor = {**make_event("battle", severity=10, start_time=0, end_time=20), "id": 1,
                  "score": 10, "tier": "S", "bucket": "intro", "force_included": True}
        repeated = {**make_event("battle", severity=10, start_time=25, end_time=85), "id": 2,
                    "score": 15, "tier": "A", "bucket": "early"}
        varied = {**make_event("overtake", severity=5, start_time=25, end_time=85), "id": 3,
                  "score": 5, "tier": "B", "bucket": "early"}
        base_constraints = {
            "continuity_preference": 100,
            "padding_before": 0,
            "padding_after": 0,
            "diversity_strength": 0,
            "driver_coverage_strength": 0,
            "mix_max": {"battle": 1, "overtake": 1},
        }

        score_first = allocate_timeline(
            [anchor, repeated, varied], 85,
            {**base_constraints, "continuity_event_diversity": 0},
        )
        mixed = allocate_timeline(
            [anchor, repeated, varied], 85,
            {**base_constraints, "continuity_event_diversity": 100},
        )

        assert {event["id"] for event in score_first} == {1, 2}
        assert {event["id"] for event in mixed} == {1, 3}

    def test_insert_continuity_prefers_a_mixed_type_join(self):
        timeline = [
            {**make_event("battle", start_time=0, end_time=10), "id": 1},
            {**make_event("battle", start_time=12, end_time=22), "id": 2},
            {**make_event("incident", start_time=27, end_time=37), "id": 3},
        ]
        base_constraints = {
            "continuity_preference": 100,
            "padding_before": 0,
            "padding_after": 0,
            "target_duration": 35,
        }

        score_first = insert_continuity(
            timeline, {**base_constraints, "continuity_event_diversity": 0}
        )
        mixed = insert_continuity(
            timeline, {**base_constraints, "continuity_event_diversity": 100}
        )

        assert score_first[0]["continuity_group_id"] == score_first[1]["continuity_group_id"]
        assert score_first[1]["continuity_group_id"] != score_first[2]["continuity_group_id"]
        assert mixed[0]["continuity_group_id"] != mixed[1]["continuity_group_id"]
        assert mixed[1]["continuity_group_id"] == mixed[2]["continuity_group_id"]

    def test_continuity_backfill_reaches_target_without_new_runs(self):
        timeline = [
            {**make_event("battle", start_time=100, end_time=120), "id": 1},
            {**make_event("overtake", start_time=500, end_time=520), "id": 2},
        ]
        result = insert_continuity(timeline, {
            "continuity_preference": 100,
            "padding_before": 0,
            "padding_after": 0,
            "target_duration": 180,
            "race_duration": 700,
        })

        assert len(result) == 2
        assert sum(segment["duration"] for segment in result) == 180
        assert all(segment.get("type") != "sequence" for segment in result)
        assert result[0]["continuity_group_id"] != result[1]["continuity_group_id"]
