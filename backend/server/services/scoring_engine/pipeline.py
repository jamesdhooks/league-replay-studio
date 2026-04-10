"""
pipeline.py
-----------
High-level pipeline entry points: generate_highlights() and generate_video_script().
"""

from __future__ import annotations

import json
import logging
import math
import random
from typing import Optional

from .constants import (
    DEFAULT_CLIP_PADDING,
    DEFAULT_PIP_THRESHOLD,
    DEFAULT_SECTION_DURATIONS,
    DEFAULT_SECTION_TEMPLATES,
    TV_CAM_PREFERENCES,
    VIDEO_SECTIONS,
)
from .scoring import score_events
from .timeline import (
    _apply_overrides,
    _compute_metrics,
    allocate_timeline,
    insert_broll,
    insert_transitions,
    resolve_conflicts,
)

logger = logging.getLogger(__name__)


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

    # Stage 5: Insert contextual bridge fillers for gaps
    timeline = insert_broll(timeline, gap_threshold=0.05, contextual_events=scored, target_duration=target_duration)

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
    clip_padding_after: float = 5.0,
        padding_by_type: Optional[dict] = None,
    tuning: Optional[dict] = None,
    camera_weights: Optional[dict[str, float]] = None,
    camera_recency_penalty: float = 0.5,
    camera_recency_decay: float = 30.0,
) -> dict:
    """Generate a full Video Composition Script with four sections.

    The script contains ordered segments for:
    1. **intro** — Static TV-cam section for title card overlay
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
        tuning: iRD-inspired scoring knobs (see score_events docstring).

    Returns:
        Dict with 'script' (ordered segment list), 'scored_events',
        'timeline' (race section only), 'metrics', and 'sections' summary.
    """
    race_info = race_info or {}
    section_config = section_config or {}
    camera_weights = camera_weights or {}
    padding_by_type = padding_by_type or {}
    overrides = overrides or {}
    race_duration = race_info.get("duration", 0)

    # If highlights were already applied to DB, honor those flags when building
    # the final script so selected events are not dropped by a fresh re-allocation.
    # included_in_highlight == 1 -> highlight, == 0 -> exclude.
    applied_overrides: dict[str, str] = {}
    for evt in events:
        eid = evt.get("id")
        if eid is None:
            continue
        flag = evt.get("included_in_highlight")
        if flag == 1:
            applied_overrides[str(eid)] = "highlight"
        elif flag == 0:
            applied_overrides[str(eid)] = "exclude"

    # Applied flags are authoritative for "apply to timeline" behavior.
    effective_overrides = {**overrides, **applied_overrides}

    # ── Build race section via existing pipeline ────────────────────────────
    script_constraints = {
        **(constraints or {}),
        "padding_before": clip_padding,
        "padding_after": clip_padding_after,
        "padding_by_type": padding_by_type,
    }

    hl_result = generate_highlights(
        events=events,
        target_duration=target_duration,
        weights=weights,
        constraints=script_constraints,
        overrides=effective_overrides,
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
            # Extract tuning params that affect timeline/camera behaviour
            _camera_sticky = float((tuning or {}).get("cameraStickyPeriod", 20))
            _battle_sticky = float((tuning or {}).get("battleStickyPeriod", 15))

            # Enforce minimum battle clip duration (battleStickyPeriod)
            for seg in race_timeline:
                if seg.get("event_type") == "battle" and _battle_sticky > 0:
                    seg_dur = seg.get("end_time_seconds", 0) - seg.get("start_time_seconds", 0)
                    if seg_dur < _battle_sticky:
                        seg["end_time_seconds"] = seg["start_time_seconds"] + _battle_sticky

            # Prepare probabilistic camera state (only if camera_weights are configured)
            _cam_last_used: dict[str, float] = {}  # camera_name -> session_time last chosen
            _cam_last_chosen: str | None = None  # name of last camera picked
            _use_cam_selection = bool(camera_weights)
            _cam_names = sorted(camera_weights.keys())
            for seg in race_timeline:
                _is_filler = seg.get("type") in ("bridge", "broll", "context")
                seg_entry: dict = {
                    **seg,
                    "section": "race",
                        "clip_padding": 0 if _is_filler else padding_by_type.get(seg.get("event_type"), {}).get("before", clip_padding),
                        "clip_padding_after": 0 if _is_filler else padding_by_type.get(seg.get("event_type"), {}).get("after", clip_padding_after),
                    "overlay_template_id": seg.get("overlay_template_id") or race_template,
                }
                # Assign camera_preferences for non-transition, non-broll segments
                if _use_cam_selection and seg.get("type") not in ("transition", "broll"):
                    seg_time = seg.get("start_time_seconds", 0.0)

                    # Camera sticky period: reuse last camera if within hold window
                    if (
                        _cam_last_chosen is not None
                        and _cam_last_chosen in _cam_names
                        and _camera_sticky > 0
                    ):
                        last_t = _cam_last_used.get(_cam_last_chosen)
                        if last_t is not None and (seg_time - last_t) < _camera_sticky:
                            others = sorted(
                                (c for c in _cam_names if c != _cam_last_chosen),
                                key=lambda c: camera_weights.get(c, 0),
                                reverse=True,
                            )
                            seg_entry["camera_preferences"] = [_cam_last_chosen, *others]
                            _cam_last_used[_cam_last_chosen] = seg_time
                            # Still record battle hints below, then append
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

                    # Compute effective weight for each camera using recency penalty
                    effective: dict[str, float] = {}
                    for cam in _cam_names:
                        base = max(0.0, camera_weights[cam])
                        last_t = _cam_last_used.get(cam)
                        if last_t is not None and camera_recency_decay > 0:
                            elapsed = max(0.0, seg_time - last_t)
                            penalty_factor = 1.0 - camera_recency_penalty * math.exp(-elapsed / camera_recency_decay)
                        else:
                            penalty_factor = 1.0
                        effective[cam] = base * max(0.0, penalty_factor)
                    total_weight = sum(effective.values())
                    if total_weight > 0:
                        # Weighted random camera selection
                        r = random.uniform(0.0, total_weight)
                        cumulative = 0.0
                        chosen = _cam_names[0]
                        for cam in _cam_names:
                            cumulative += effective[cam]
                            if r <= cumulative:
                                chosen = cam
                                break
                        # Build camera_preferences: chosen first, then rest sorted by effective weight
                        others = sorted(
                            (c for c in _cam_names if c != chosen),
                            key=lambda c: effective[c],
                            reverse=True,
                        )
                        seg_entry["camera_preferences"] = [chosen, *others]
                        _cam_last_used[chosen] = seg_time
                        _cam_last_chosen = chosen
                    elif _cam_names:
                        # All weights zero — use first camera as fallback
                        seg_entry["camera_preferences"] = list(_cam_names)
                        _cam_last_chosen = _cam_names[0]
                # Battle camera choreography hints (iRD-inspired)
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
            broll_time = max(0, race_start - 30)
        elif section_name == "qualifying_results":
            broll_time = max(0, race_start - 10)
        elif section_name == "race_results":
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
            "clip_padding_after": clip_padding_after,
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
        "clip_padding_after": clip_padding_after,
    }
