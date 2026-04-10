"""
constants.py
------------
Shared constants for the scoring engine pipeline.

⚠️  SYNC NOTE: BASE_SCORES, MANDATORY_TYPES, TIER thresholds,
BUCKET_BOUNDARIES, and REFERENCE_SPEED_MS are mirrored in the frontend at:
    frontend/src/utils/highlight-scoring.js
Keep both files in sync when changing scoring logic.
"""

from __future__ import annotations

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
MAX_BROLL_FILLER_DURATION = 15.0  # Cap b-roll gap fillers to avoid inflating total edit duration

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
TV_CAM_PREFERENCES: dict[str, list[str]] = {
    "intro": ["Scenic", "TV Static", "TV1", "Blimp", "Pit Lane"],
    "qualifying_results": ["Pit Lane", "TV Static", "TV1", "Scenic"],
    "race_results": ["TV Static", "TV1", "Pit Lane", "Scenic", "Blimp"],
    "gap_filler": ["TV Static", "TV1", "Scenic"],
}

# Default overlay template ID to apply per section.
DEFAULT_SECTION_TEMPLATES: dict[str, str] = {
    "intro": "cinematic",
    "qualifying_results": "broadcast",
    "race": "broadcast",
    "race_results": "broadcast",
    "gap_filler": "minimal",
}

# Default clip-start padding (seconds) — trimmed after capture
DEFAULT_CLIP_PADDING = 0.5
