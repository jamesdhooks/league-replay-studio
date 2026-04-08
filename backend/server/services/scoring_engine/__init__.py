"""
scoring_engine — Multi-pass event scoring pipeline for highlight generation.

Package structure:
  constants.py  — Shared constants (BASE_SCORES, thresholds, video sections)
  scoring.py    — 8-stage scoring pipeline (score_events)
  timeline.py   — Timeline allocation, conflict resolution, transitions, b-roll
  pipeline.py   — High-level entry points (generate_highlights, generate_video_script)

All public names are re-exported here so existing imports like
    from server.services.scoring_engine import score_events
continue to work unchanged.
"""

from .constants import (
    BASE_SCORES,
    BROLL_GAP_THRESHOLD,
    BUCKET_BOUNDARIES,
    DEFAULT_CLIP_PADDING,
    DEFAULT_PIP_THRESHOLD,
    DEFAULT_SECTION_DURATIONS,
    DEFAULT_SECTION_TEMPLATES,
    MANDATORY_TYPES,
    REFERENCE_SPEED_MS,
    TIER_A_THRESHOLD,
    TIER_B_THRESHOLD,
    TIER_S_THRESHOLD,
    TV_CAM_PREFERENCES,
    VALID_TRANSITIONS,
    VIDEO_SECTIONS,
)
from .pipeline import generate_highlights, generate_video_script
from .scoring import score_events
from .timeline import allocate_timeline, insert_broll, insert_transitions, resolve_conflicts

__all__ = [
    # Constants
    "BASE_SCORES",
    "BROLL_GAP_THRESHOLD",
    "BUCKET_BOUNDARIES",
    "DEFAULT_CLIP_PADDING",
    "DEFAULT_PIP_THRESHOLD",
    "DEFAULT_SECTION_DURATIONS",
    "DEFAULT_SECTION_TEMPLATES",
    "MANDATORY_TYPES",
    "REFERENCE_SPEED_MS",
    "TIER_A_THRESHOLD",
    "TIER_B_THRESHOLD",
    "TIER_S_THRESHOLD",
    "TV_CAM_PREFERENCES",
    "VALID_TRANSITIONS",
    "VIDEO_SECTIONS",
    # Functions
    "score_events",
    "allocate_timeline",
    "resolve_conflicts",
    "insert_transitions",
    "insert_broll",
    "generate_highlights",
    "generate_video_script",
]
