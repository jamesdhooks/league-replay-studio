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
import re
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
    """Convert raw session seconds to MM:SS (<1h) or HH:MM:SS (>=1h)."""
    total = max(0, int(session_time))
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    if h <= 0:
        return f"{m:02d}:{s:02d}"
    return f"{h:02d}:{m:02d}:{s:02d}"


def _make_driver_short_name(name: Optional[str]) -> str:
    """Build a deterministic motorsport-style short name.

    Prefers the surname and returns an uppercase 3-letter token.
    Falls back to the first available alpha characters from the full name.
    """
    if not name:
        return "DRV"

    parts = [part for part in re.split(r"\s+", name.strip()) if part]
    candidate = parts[-1] if parts else name.strip()
    letters = re.sub(r"[^A-Za-z]", "", candidate).upper()
    if len(letters) >= 3:
        return letters[:3]

    fallback = re.sub(r"[^A-Za-z]", "", "".join(parts)).upper()
    if len(fallback) >= 3:
        return fallback[:3]
    if fallback:
        return fallback.ljust(3, fallback[-1])[:3]
    return "DRV"


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
        "session_time": "00:00",
        "session_time_seconds": 0.0,
        "replay_frame": 0,
        "frame_timestamp_ms": 0,
        "flag": "green",
        # Focused driver
        "driver_name": None,
        "driver_short_name": None,
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
        "qualifying_standings": [],
        "final_standings": [],
        # Championship (from 3rd party data plugin)
        "championship_standings": [],
        # 3rd party enrichment
        "race_season": None,
        "race_week": None,
        "race_date": None,
        "race_date_friendly": None,
        "track_name": None,
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
        def load_tick_standings(tick_id: int) -> list[dict[str, Any]]:
            rows = conn.execute(
                """
                SELECT * FROM car_states
                WHERE tick_id = ?
                ORDER BY position ASC
                """,
                (tick_id,),
            ).fetchall()
            states = [dict(r) for r in rows]
            if not states:
                return []

            entries: list[dict[str, Any]] = []
            leader_est_local: Optional[float] = None
            est_times: list[Optional[float]] = []
            for state in states[:20]:
                if state.get("position") == 1:
                    leader_est_local = state.get("est_time")
                drv = drivers.get(state.get("car_idx", -1), {})
                driver_name = drv.get("user_name") or f"Car #{drv.get('car_number') or state.get('car_idx', '?')}"
                entries.append({
                    "position": state.get("position", 0),
                    "driver_name": driver_name,
                    "driver_short_name": _make_driver_short_name(driver_name),
                    "car_number": drv.get("car_number", ""),
                    "is_player": state.get("car_idx") == focused_car_idx,
                    "iracing_cust_id": drv.get("iracing_cust_id", 0),
                    "gap": "Leader",
                    "gap_to_leader": "Leader",
                    "relative": None,
                    "best_lap_time": _format_lap_time(state.get("best_lap_time", -1.0) or -1.0),
                    "fastest_lap_time": _format_lap_time(state.get("best_lap_time", -1.0) or -1.0),
                    "qualifying_time": None,
                    "average_lap_time": None,
                    "incidents": None,
                    "laps_completed": state.get("lap", 0),
                    "reason_out": "",
                    "nickname": None,
                    "avatar": None,
                })
                est_times.append(state.get("est_time"))

            for idx, (state, entry) in enumerate(zip(states[:20], entries)):
                est = state.get("est_time")
                if state.get("position") == 1:
                    entry["gap"] = "Leader"
                    entry["gap_to_leader"] = "Leader"
                    entry["relative"] = "LEADER"
                elif leader_est_local is not None and est is not None and est >= leader_est_local:
                    gap_secs = est - leader_est_local
                    formatted_gap = (
                        f"+{gap_secs:.3f}"
                        if gap_secs < _GAP_PRECISION_THRESHOLD
                        else f"+{gap_secs:.1f}"
                    )
                    entry["gap"] = formatted_gap
                    entry["gap_to_leader"] = formatted_gap
                else:
                    entry["gap"] = "---"
                    entry["gap_to_leader"] = "---"

                if idx > 0 and est is not None:
                    prev_est = est_times[idx - 1]
                    if prev_est is not None:
                        rel_secs = est - prev_est
                        if 0 <= rel_secs < _GAP_PRECISION_THRESHOLD:
                            entry["relative"] = f"+{rel_secs:.3f}"
                        elif rel_secs >= _GAP_PRECISION_THRESHOLD:
                            entry["relative"] = f"+{rel_secs:.1f}"
            return entries

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

        has_session_results = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_results'"
        ).fetchone() is not None

        has_incident_log = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='incident_log'"
        ).fetchone() is not None

        has_lap_completions = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='lap_completions'"
        ).fetchone() is not None

        # ── Fetch total_laps from analysis_meta ──────────────────────────────
        total_laps_meta: int = 0
        meta_row = conn.execute(
            "SELECT value FROM analysis_meta WHERE key = 'total_laps' LIMIT 1"
        ).fetchone()
        if meta_row:
            try:
                total_laps_meta = int(meta_row["value"])
            except (ValueError, TypeError):
                pass

        def _resolve_session_num(type_tokens_priority: list[str], pick: str) -> Optional[int]:
            """Deterministically select a session_num for a given session category.

            Checks exact UPPER() match first (e.g. 'QUALIFY', 'RACE'), then falls
            back to a LIKE substring match so mixed-case or extended names still work.
            ``pick='first'`` selects the earliest session; ``'last'`` selects the latest.
            """
            if not has_session_results:
                return None
            order = "ASC" if pick == "first" else "DESC"
            # Phase 1: exact upper-case match on any of the priority tokens
            for token in type_tokens_priority:
                row = conn.execute(
                    f"""
                    SELECT session_num FROM session_results
                    WHERE UPPER(session_type) = ?
                    GROUP BY session_num
                    ORDER BY session_num {order}
                    LIMIT 1
                    """,
                    (token.upper(),),
                ).fetchone()
                if row:
                    return int(row["session_num"])
            # Phase 2: fallback substring LIKE match on the first (most specific) token
            row = conn.execute(
                f"""
                SELECT session_num FROM session_results
                WHERE LOWER(session_type) LIKE ?
                GROUP BY session_num
                ORDER BY session_num {order}
                LIMIT 1
                """,
                (f"%{type_tokens_priority[0].lower()}%",),
            ).fetchone()
            return int(row["session_num"]) if row else None

        def load_session_results_standings(
            session_type_token: str,
            pick: str,
            time_field: str,
        ) -> list[dict[str, Any]]:
            if not has_session_results:
                return []

            # Canonical iRacing session type strings, most specific first
            _TYPE_MAP: dict[str, list[str]] = {
                "qual": ["QUALIFY", "QUALIFYING", "QUAL"],
                "race": ["RACE"],
                "practice": ["PRACTICE"],
            }
            priority_tokens = _TYPE_MAP.get(session_type_token.lower(), [session_type_token])
            session_num = _resolve_session_num(priority_tokens, pick)
            if session_num is None:
                return []

            rows = conn.execute(
                """
                SELECT sr.*, d.user_name, d.car_number, d.iracing_cust_id
                FROM session_results sr
                LEFT JOIN drivers d ON d.car_idx = sr.car_idx
                WHERE sr.session_num = ?
                ORDER BY sr.position ASC
                """,
                (session_num,),
            ).fetchall()
            results = [dict(r) for r in rows if (r["position"] or 0) > 0]
            if not results:
                return []

            entries: list[dict[str, Any]] = []
            metric_vals: list[Optional[float]] = []
            leader_metric: Optional[float] = None

            for row in results[:20]:
                metric = row.get(time_field)
                if metric is not None and metric >= 0:
                    if leader_metric is None:
                        leader_metric = metric
                else:
                    metric = None

                metric_vals.append(metric)
                drv = drivers.get(row.get("car_idx", -1), {})
                entries.append({
                    "position": row.get("position", 0),
                    "driver_name": (
                        row.get("user_name")
                        or drv.get("user_name")
                        or f"Car #{row.get('car_idx', '?')}"
                    ),
                    "driver_short_name": _make_driver_short_name(
                        row.get("user_name")
                        or drv.get("user_name")
                        or f"Car #{row.get('car_idx', '?')}"
                    ),
                    "car_number": row.get("car_number") or drv.get("car_number", ""),
                    "is_player": row.get("car_idx") == focused_car_idx,
                    "iracing_cust_id": row.get("iracing_cust_id") or drv.get("iracing_cust_id", 0),
                    "gap": "Leader",
                    "gap_to_leader": "Leader",
                    "relative": None,
                    "best_lap_time": _format_lap_time(row.get("fastest_time", -1.0) or -1.0),
                    "fastest_lap_time": _format_lap_time(row.get("fastest_time", -1.0) or -1.0),
                    "qualifying_time": _format_lap_time(row.get("fastest_time", -1.0) or -1.0),
                    "average_lap_time": _format_lap_time(
                        (row.get("total_time") / row.get("lap"))
                        if (row.get("lap") or 0) > 0 and (row.get("total_time") or -1) > 0
                        else -1.0
                    ),
                    "incidents": row.get("incidents", 0),
                    "laps_completed": row.get("lap", 0),
                    "reason_out": row.get("reason_out", ""),
                    "nickname": None,
                    "avatar": None,
                })

            for idx, (row, entry) in enumerate(zip(results[:20], entries)):
                metric = metric_vals[idx]
                if idx == 0:
                    entry["gap"] = "Leader"
                    entry["gap_to_leader"] = "Leader"
                    entry["relative"] = "LEADER"
                elif metric is not None and leader_metric is not None and metric >= leader_metric:
                    gap_secs = metric - leader_metric
                    formatted_gap = (
                        f"+{gap_secs:.3f}"
                        if gap_secs < _GAP_PRECISION_THRESHOLD
                        else f"+{gap_secs:.1f}"
                    )
                    entry["gap"] = formatted_gap
                    entry["gap_to_leader"] = formatted_gap
                else:
                    # Fallback to iRacing YAML gap/interval fields if present.
                    raw_gap = row.get("gap")
                    if raw_gap is not None and raw_gap >= 0:
                        formatted_gap = (
                            f"+{raw_gap:.3f}"
                            if raw_gap < _GAP_PRECISION_THRESHOLD
                            else f"+{raw_gap:.1f}"
                        )
                        entry["gap"] = formatted_gap
                        entry["gap_to_leader"] = formatted_gap
                    else:
                        entry["gap"] = "---"
                        entry["gap_to_leader"] = "---"

                if idx > 0:
                    prev_metric = metric_vals[idx - 1]
                    if metric is not None and prev_metric is not None and metric >= prev_metric:
                        rel_secs = metric - prev_metric
                        entry["relative"] = (
                            f"+{rel_secs:.3f}"
                            if rel_secs < _GAP_PRECISION_THRESHOLD
                            else f"+{rel_secs:.1f}"
                        )
                    else:
                        raw_interval = row.get("interval")
                        if raw_interval is not None and raw_interval >= 0:
                            entry["relative"] = (
                                f"+{raw_interval:.3f}"
                                if raw_interval < _GAP_PRECISION_THRESHOLD
                                else f"+{raw_interval:.1f}"
                            )

            return entries

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
                "driver_short_name": _make_driver_short_name(driver_name),
                "car_number": drv.get("car_number", ""),
                "is_player": cs["car_idx"] == focused_car_idx,
                "iracing_cust_id": drv.get("iracing_cust_id", 0),
                "gap": "Leader",
                "gap_to_leader": "Leader",
                "relative": None,
                "best_lap_time": _format_lap_time(cs.get("best_lap_time", -1.0) or -1.0),
                "fastest_lap_time": _format_lap_time(cs.get("best_lap_time", -1.0) or -1.0),
                "qualifying_time": None,
                "average_lap_time": None,
                "incidents": None,
                "laps_completed": cs.get("lap", 0),
                "reason_out": "",
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
                entry["gap_to_leader"] = "Leader"
                entry["relative"] = "LEADER"
            elif leader_est is not None and est is not None and est >= leader_est:
                gap_secs = est - leader_est
                formatted_gap = (
                    f"+{gap_secs:.3f}"
                    if gap_secs < _GAP_PRECISION_THRESHOLD
                    else f"+{gap_secs:.1f}"
                )
                entry["gap"] = formatted_gap
                entry["gap_to_leader"] = formatted_gap
            else:
                entry["gap"] = "---"
                entry["gap_to_leader"] = "---"

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

        # ── 5c. Build section-specific standings snapshots ───────────────────
        # Qualifying snapshot: earliest tick in captured race session where
        # positions are assigned (typically pre-grid / opening moments).
        # Final snapshot: latest tick with assigned positions.
        qualifying_authoritative = load_session_results_standings(
            session_type_token="qual",
            pick="first",
            time_field="fastest_time",
        )
        final_authoritative = load_session_results_standings(
            session_type_token="race",
            pick="last",
            time_field="total_time",
        )

        qualifying_tick_row = conn.execute(
            """
            SELECT DISTINCT rt.id
            FROM race_ticks rt
            JOIN car_states cs ON cs.tick_id = rt.id
            WHERE cs.position > 0
            ORDER BY rt.session_time ASC
            LIMIT 1
            """
        ).fetchone()
        qualifying_tick_standings = load_tick_standings(int(qualifying_tick_row["id"])) if qualifying_tick_row else []
        qualifying_standings = qualifying_authoritative or qualifying_tick_standings

        final_tick_row = conn.execute(
            """
            SELECT DISTINCT rt.id
            FROM race_ticks rt
            JOIN car_states cs ON cs.tick_id = rt.id
            WHERE cs.position > 0
            ORDER BY rt.session_time DESC
            LIMIT 1
            """
        ).fetchone()
        final_tick_standings = load_tick_standings(int(final_tick_row["id"])) if final_tick_row else []
        final_standings = final_authoritative or final_tick_standings

        section_standings = standings
        if section in {"qualifying", "qualifying_results"} and qualifying_standings:
            section_standings = qualifying_standings
        elif section in {"results", "race_results"} and final_standings:
            section_standings = final_standings

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

        # ── 7b. last_lap_time — derive from lap_completions ──────────────────
        last_lap_time: Optional[str] = None
        if focused_car_idx is not None and has_lap_completions:
            lc_rows = conn.execute(
                """
                SELECT rt.session_time AS completion_time
                FROM lap_completions lc
                JOIN race_ticks rt ON rt.id = lc.tick_id
                WHERE lc.car_idx = ? AND rt.session_time <= ?
                ORDER BY rt.session_time DESC
                LIMIT 2
                """,
                (focused_car_idx, session_time),
            ).fetchall()
            if len(lc_rows) == 2:
                t_latest = lc_rows[0]["completion_time"]
                t_prev = lc_rows[1]["completion_time"]
                lap_dur = float(t_latest) - float(t_prev)
                if 20.0 < lap_dur < 600.0:
                    last_lap_time = _format_lap_time(lap_dur)

        # ── 7c. incident_count — from incident_log or session_results ────────
        incident_count: int = 0
        if focused_car_idx is not None:
            if has_incident_log:
                inc_row = conn.execute(
                    "SELECT COALESCE(SUM(incident_points), 0) AS total FROM incident_log WHERE car_idx = ?",
                    (focused_car_idx,),
                ).fetchone()
                if inc_row:
                    incident_count = int(inc_row["total"] or 0)
            if incident_count == 0 and has_session_results:
                # Fall back to session_results for the race session
                race_session_num = _resolve_session_num(["RACE"], "last")
                if race_session_num is not None:
                    sr_row = conn.execute(
                        "SELECT incidents FROM session_results WHERE session_num = ? AND car_idx = ? LIMIT 1",
                        (race_session_num, focused_car_idx),
                    ).fetchone()
                    if sr_row:
                        incident_count = int(sr_row["incidents"] or 0)

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
            "total_laps": total_laps_meta,
            "session_time": _format_session_time(session_time),
            "session_time_seconds": round(float(session_time), 3),
            "replay_frame": tick.get("replay_frame", 0),
            "frame_timestamp_ms": int(round(float(session_time) * 1000.0)),
            "flag": flag,
            # Focused driver — populated below if we have state
            "driver_name": None,
            "driver_short_name": None,
            "car_name": None,
            "car_number": "",
            "position": None,
            "class_position": None,
            "irating": 0,
            "iracing_cust_id": 0,
            "team_color": "#3B82F6",
            "last_lap_time": last_lap_time,
            "best_lap_time": best_lap_time,
            "incident_count": incident_count,
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
            "standings": section_standings,
            "qualifying_standings": qualifying_standings,
            "final_standings": final_standings,
            # Championship (populated by data plugin layer)
            "championship_standings": [],
            # 3rd party enrichment (populated by data plugin layer)
            "race_season": None,
            "race_week": None,
            "race_date": None,
            "race_date_friendly": None,
            "track_name": None,
            "driver_nickname": None,
            "driver_avatar": None,
        }

        if focused_state and focused_driver:
            frame_data.update({
                "driver_name": focused_driver.get("user_name") or None,
                "driver_short_name": _make_driver_short_name(focused_driver.get("user_name") or None),
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
