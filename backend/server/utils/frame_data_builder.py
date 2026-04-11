"""
frame_data_builder.py
---------------------
Build an overlay ``frame_data`` dict from the per-project analysis database.

The returned dict matches the schema expected by overlay templates (the same
shape as ``SAMPLE_FRAME_DATA`` in ``overlay_service.py``) so any template can
be rendered with real telemetry at any point in a replay.

Usage::

    from server.utils.frame_data_builder import build_frame_data

    frame = build_frame_data(
        project_dir="/path/to/project",
        session_time=1234.5,
        section="race",
        focused_car_idx=3,
        series_name="iRacing Formula 4",
        track_name="Brands Hatch",
    )
    # pass `frame` to overlay_service.render_frame(template_id, frame)
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from server.services.analysis_db import get_project_db

logger = logging.getLogger(__name__)

# Gap display precision: gaps narrower than this threshold (in seconds)
# are shown with millisecond precision (e.g. "+3.456"); wider gaps
# use decisecond precision (e.g. "+72.1") to avoid long strings.
_GAP_PRECISION_THRESHOLD = 60.0


# ── Helpers ──────────────────────────────────────────────────────────────────

def _format_lap_time(seconds: float) -> Optional[str]:
    """Convert a raw seconds value to a lap-time string (M:SS.mmm).

    Returns ``None`` for invalid/unset values (≤ 0).
    """
    if seconds is None or seconds <= 0:
        return None
    minutes = int(seconds // 60)
    remaining = seconds - minutes * 60
    return f"{minutes}:{remaining:06.3f}"


def _format_session_time(session_time: float) -> str:
    """Convert raw session seconds to HH:MM:SS string."""
    total = max(0, int(session_time))
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def _empty_frame_data(section: str) -> dict[str, Any]:
    """Return a minimal frame_data dict when telemetry is unavailable.

    Includes all keys from ``SAMPLE_FRAME_DATA`` so templates can reference
    them safely without undefined-variable errors.
    """
    return {
        # Core session
        "section": section,
        "series_name": "",
        "track_name": "",
        "current_lap": 0,
        "total_laps": 0,
        "session_time": "00:00:00",
        "flag": "green",
        # Focused driver
        "driver_name": None,
        "car_name": None,
        "car_number": "",
        "position": None,
        "class_position": None,
        "irating": 0,
        "iracing_cust_id": 0,
        "team_color": "#3B82F6",
        "last_lap_time": None,
        "best_lap_time": None,
        "incident_count": 0,
        # Computed telemetry
        "relative_gap": None,
        "speed_kph": 0.0,
        "lap_pct": 0.0,
        "fuel_level": None,
        "fuel_used_lap": None,
        "fuel_avg_lap": None,
        "fuel_laps_remaining": None,
        "fuel_laps_remaining_conservative": None,
        "fuel_delta": None,
        "pit_window_start": None,
        "pit_window_end": None,
        # Standings
        "standings": [],
        # Championship (from 3rd party data plugin)
        "championship_standings": [],
        # 3rd party enrichment
        "race_season": None,
        "race_week": None,
        "race_date": None,
        "venue_display_name": None,
        "driver_nickname": None,
        "driver_avatar": None,
    }


# ── Public API ───────────────────────────────────────────────────────────────

def build_frame_data(
    project_dir: str,
    session_time: float,
    section: str = "race",
    focused_car_idx: Optional[int] = None,
    series_name: str = "",
    track_name: str = "",
) -> dict[str, Any]:
    """Build a complete overlay ``frame_data`` dict from telemetry.

    Finds the recorded snapshot nearest to ``session_time`` in the project's
    analysis database and reconstructs the full overlay context from it.

    Args:
        project_dir:       Root directory of the project (contains project.db).
        session_time:      Target time in seconds within the replay session.
        section:           Which video section is being rendered —
                           ``"intro"``, ``"qualifying_results"``,
                           ``"race"``, or ``"race_results"``.
        focused_car_idx:   iRacing car index of the "hero" driver to highlight.
                           Falls back to ``cam_car_idx`` from the telemetry
                           snapshot when ``None``.
        series_name:       Racing series name (not stored in the DB; pass from
                           the project / session data if available).
        track_name:        Track name (same as above).

    Returns:
        A ``dict`` ready to pass directly to
        ``overlay_service.render_frame(template_id, frame_data)``.
        All keys from ``SAMPLE_FRAME_DATA`` are present; values may be
        ``None`` when the underlying telemetry is absent.
    """
    logger.debug(
        "[FrameDataBuilder] building frame: session_time=%.2f, section=%s, car_idx=%s",
        session_time, section, focused_car_idx,
    )
    try:
        conn = get_project_db(project_dir)
    except Exception as exc:
        logger.warning("[FrameDataBuilder] Cannot open project DB at %s: %s", project_dir, exc)
        return _empty_frame_data(section)

    try:
        # ── 1. Find the nearest recorded tick ────────────────────────────────
        tick_row = conn.execute(
            """
            SELECT * FROM race_ticks
            ORDER BY ABS(session_time - ?) ASC
            LIMIT 1
            """,
            (session_time,),
        ).fetchone()

        if not tick_row:
            logger.debug("[FrameDataBuilder] No ticks found for session_time=%.2f", session_time)
            return _empty_frame_data(section)

        tick = dict(tick_row)
        tick_id: int = tick["id"]

        # ── 2. Fetch car states for this tick, ordered by race position ──────
        cs_rows = conn.execute(
            """
            SELECT * FROM car_states
            WHERE tick_id = ?
            ORDER BY position ASC
            """,
            (tick_id,),
        ).fetchall()
        car_states = [dict(r) for r in cs_rows]

        # ── 3. Fetch driver metadata ─────────────────────────────────────────
        driver_rows = conn.execute(
            "SELECT * FROM drivers WHERE is_spectator = 0"
        ).fetchall()
        drivers: dict[int, dict] = {r["car_idx"]: dict(r) for r in driver_rows}

        # ── 4. Determine focused car ─────────────────────────────────────────
        if focused_car_idx is None:
            focused_car_idx = tick.get("cam_car_idx")

        focused_state: Optional[dict] = None
        if focused_car_idx is not None:
            focused_state = next(
                (cs for cs in car_states if cs["car_idx"] == focused_car_idx),
                None,
            )
        if focused_state is None and car_states:
            # Fall back to P1 when the focused car isn't present in this tick
            focused_state = car_states[0]
            focused_car_idx = focused_state["car_idx"]

        focused_driver = drivers.get(focused_car_idx or -1, {})

        # ── 5. Build standings with gap-to-leader + relative ────────────────
        # CarIdxEstTime is the estimated time remaining to complete the
        # current lap.  The difference between P1's est_time and another
        # car's est_time gives a reasonable in-race gap proxy.
        standings: list[dict[str, Any]] = []
        leader_est: Optional[float] = None
        # Build ordered list so we can compute car-to-car relative later
        cs_est_times: list[Optional[float]] = []

        for cs in car_states[:20]:
            if cs["position"] == 1:
                leader_est = cs.get("est_time")
            drv = drivers.get(cs["car_idx"], {})
            driver_name = (
                drv.get("user_name")
                or f"Car #{drv.get('car_number') or cs['car_idx']}"
            )
            standings.append({
                "position": cs["position"],
                "driver_name": driver_name,
                "car_number": drv.get("car_number", ""),
                "is_player": cs["car_idx"] == focused_car_idx,
                "iracing_cust_id": drv.get("iracing_cust_id", 0),
                "gap": "Leader",
                "relative": None,
                # Placeholders for 3rd party enrichment
                "nickname": None,
                "avatar": None,
            })
            cs_est_times.append(cs.get("est_time"))

        # Fill in gaps and relative (car-to-car-ahead) once we know est_times
        for i, (cs, entry) in enumerate(zip(car_states[:20], standings)):
            est = cs.get("est_time")
            # Gap to leader
            if cs["position"] == 1:
                entry["gap"] = "Leader"
            elif leader_est is not None and est is not None and est >= leader_est:
                gap_secs = est - leader_est
                entry["gap"] = (
                    f"+{gap_secs:.3f}"
                    if gap_secs < _GAP_PRECISION_THRESHOLD
                    else f"+{gap_secs:.1f}"
                )
            else:
                entry["gap"] = "---"

            # Relative to car directly ahead (position-based ordering)
            if i > 0 and est is not None:
                prev_est = cs_est_times[i - 1]
                if prev_est is not None:
                    rel_secs = est - prev_est
                    if 0 <= rel_secs < _GAP_PRECISION_THRESHOLD:
                        entry["relative"] = f"+{rel_secs:.3f}"
                    elif rel_secs >= _GAP_PRECISION_THRESHOLD:
                        entry["relative"] = f"+{rel_secs:.1f}"

        # ── 5b. Compute relative_gap for the focused driver ──────────────────
        focused_relative: Optional[str] = None
        if focused_state:
            for entry in standings:
                if entry.get("is_player"):
                    focused_relative = entry.get("relative")
                    break

        # ── 6. Derive flag status ────────────────────────────────────────────
        if tick.get("flag_checkered"):
            flag = "checkered"
        elif tick.get("flag_red"):
            flag = "red"
        elif tick.get("flag_yellow"):
            flag = "yellow"
        else:
            flag = "green"

        # ── 7. Format lap times for the focused driver ───────────────────────
        best_lap_time: Optional[str] = None
        if focused_state:
            raw_best = focused_state.get("best_lap_time", -1.0) or -1.0
            best_lap_time = _format_lap_time(raw_best)

        # ── 8. Compute speed in kph from speed_ms ────────────────────────────
        speed_kph = 0.0
        lap_pct_val = 0.0
        if focused_state:
            raw_speed = focused_state.get("speed_ms")
            if raw_speed is not None and raw_speed > 0:
                speed_kph = round(raw_speed * 3.6, 1)
            lap_pct_val = focused_state.get("lap_pct", 0.0) or 0.0

        # ── 9. Assemble final frame_data dict ────────────────────────────────
        frame_data: dict[str, Any] = {
            # Core session
            "section": section,
            "series_name": series_name or "",
            "track_name": track_name or "",
            "current_lap": tick.get("race_laps", 0),
            "total_laps": 0,       # not stored in DB; caller may override
            "session_time": _format_session_time(session_time),
            "flag": flag,
            # Focused driver — populated below if we have state
            "driver_name": None,
            "car_name": None,
            "car_number": "",
            "position": None,
            "class_position": None,
            "irating": 0,
            "iracing_cust_id": 0,
            "team_color": "#3B82F6",
            "last_lap_time": None,   # not captured in DB schema
            "best_lap_time": best_lap_time,
            "incident_count": 0,     # not stored per-tick
            # Computed telemetry
            "relative_gap": focused_relative,
            "speed_kph": speed_kph,
            "lap_pct": round(lap_pct_val, 4),
            "fuel_level": None,        # requires fuel telemetry (not yet captured)
            "fuel_used_lap": None,
            "fuel_avg_lap": None,
            "fuel_laps_remaining": None,
            "fuel_laps_remaining_conservative": None,
            "fuel_delta": None,
            "pit_window_start": None,
            "pit_window_end": None,
            # Standings
            "standings": standings,
            # Championship (populated by data plugin layer)
            "championship_standings": [],
            # 3rd party enrichment (populated by data plugin layer)
            "race_season": None,
            "race_week": None,
            "race_date": None,
            "venue_display_name": None,
            "driver_nickname": None,
            "driver_avatar": None,
        }

        if focused_state and focused_driver:
            frame_data.update({
                "driver_name": focused_driver.get("user_name") or None,
                "car_name": focused_driver.get("car_class_name") or None,
                "car_number": focused_driver.get("car_number", ""),
                "position": focused_state.get("position"),
                "class_position": focused_state.get("class_position"),
                "iracing_cust_id": focused_driver.get("iracing_cust_id", 0),
            })

        return frame_data

    except Exception as exc:
        logger.error("[FrameDataBuilder] Error building frame data: %s", exc)
        return _empty_frame_data(section)
    finally:
        conn.close()
