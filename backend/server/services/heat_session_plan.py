"""Metadata-driven replay session planning for heat/feature race ladders.

A replay is treated as a heat ladder only when its authoritative iRacing
SessionInfo uses explicit Heat plus Feature/Consolation labels.  Generic
multiple Race sessions must remain standard multi-race replays.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any


def _label(session: dict[str, Any]) -> str:
    return f"{session.get('type', '')} {session.get('name', '')}".casefold()


def _session_num(session: dict[str, Any]) -> int:
    return int(session.get("index", -1))


def _has_results(session: dict[str, Any]) -> bool:
    """Treat an explicitly false/zero result marker as incomplete.

    Live bridge callers derive this from ResultsPositions.  Omission preserves
    backwards compatibility for saved fixtures which only include session labels.
    """
    value = session.get("has_results", True)
    return bool(value)


def _display_name(session: dict[str, Any], fallback: str) -> str:
    name = str(session.get("name") or "").strip()
    return name.title() if name else fallback


def build_session_plan(sessions: list[dict[str, Any]]) -> dict[str, Any]:
    """Build the ordered production plan from authoritative SessionInfo entries."""
    ordered = sorted((s for s in sessions if _session_num(s) >= 0), key=_session_num)
    qualifying = next((s for s in ordered if "qual" in _label(s)), None)
    explicit_heats = [s for s in ordered if "heat" in _label(s) and _has_results(s)]
    finals = [
        s for s in ordered
        if ("feature" in _label(s) or "consolation" in _label(s)) and _has_results(s)
    ]

    is_heat = bool(explicit_heats and finals)
    if is_heat:
        final = finals[-1]
        stages: list[dict[str, Any]] = []
        if qualifying is not None:
            stages.append({"section": "qualifying_results", "session_num": _session_num(qualifying), "result_session_num": _session_num(qualifying), "label": "Qualifying"})
        race_anchors: list[dict[str, Any]] = []
        heat_sessions: list[dict[str, Any]] = []
        for heat in explicit_heats:
            session_num = _session_num(heat)
            label = _display_name(heat, f"Heat {len(heat_sessions) + 1}")
            heat_sessions.append({"session_num": session_num, "label": label})
            stages.extend([
                {"section": "heat", "session_num": session_num, "label": label},
                {"section": "heat_results", "session_num": session_num, "result_session_num": session_num, "label": f"{label} Results"},
            ])
            race_anchors.extend([
                {"session_num": session_num, "event_type": "race_start", "label": label},
                {"session_num": session_num, "event_type": "race_finish", "label": label},
            ])
        final_num = _session_num(final)
        final_label = _display_name(final, "Feature")
        stages.extend([
            {"section": "race", "session_num": final_num, "label": final_label},
            {"section": "race_results", "session_num": final_num, "result_session_num": final_num, "label": f"{final_label} Results"},
        ])
        race_anchors.extend([
            {"session_num": final_num, "event_type": "race_start", "label": final_label},
            {"session_num": final_num, "event_type": "race_finish", "label": final_label},
        ])
        return {"format": "heat", "qualifying_session_num": _session_num(qualifying) if qualifying else None, "heat_sessions": heat_sessions, "feature_session_num": final_num, "stages": stages, "race_anchors": race_anchors}

    races = [s for s in ordered if "race" in _label(s)]
    final = races[-1] if races else None
    final_num = _session_num(final) if final else 0
    stages = []
    if qualifying is not None:
        stages.append({"section": "qualifying_results", "session_num": _session_num(qualifying), "result_session_num": _session_num(qualifying), "label": "Qualifying"})
    stages.extend([
        {"section": "race", "session_num": final_num, "label": "Race"},
        {"section": "race_results", "session_num": final_num, "result_session_num": final_num, "label": "Race Results"},
    ])
    return {"format": "standard", "qualifying_session_num": _session_num(qualifying) if qualifying else None, "heat_sessions": [], "feature_session_num": final_num, "stages": stages, "race_anchors": [{"session_num": final_num, "event_type": "race_start", "label": "Race"}, {"session_num": final_num, "event_type": "race_finish", "label": "Race"}]}


def requires_full_replay_scan(session_plan: dict[str, Any]) -> bool:
    """Heat ladders need a start-to-finish pass to observe every Heat anchor."""
    return session_plan.get("format") == "heat"


def update_session_anchor(
    session_anchors: dict[str, dict[str, Any]],
    snapshot: dict[str, Any],
    planned_sessions: set[int],
    *,
    racing_state: int = 4,
    checkered_state: int = 5,
) -> bool:
    """Record measured green/checkered anchors for one planned replay session.

    Session clocks are local; callers must pass the replay session number contained
    in each snapshot and retain this mapping through script/capture generation.
    """
    session_num = int(snapshot.get("replay_session_num", snapshot.get("session_num", -1)) or -1)
    if session_num not in planned_sessions:
        return False
    key = str(session_num)
    anchor = session_anchors.setdefault(key, {})
    state = int(snapshot.get("session_state", 0) or 0)
    changed = False
    if state == racing_state and "race_start_frame" not in anchor:
        anchor["race_start_frame"] = int(snapshot.get("replay_frame", 0) or 0)
        anchor["race_start_session_time"] = float(snapshot.get("session_time", 0.0) or 0.0)
        changed = True
    if state >= checkered_state and "race_finish_frame" not in anchor:
        anchor["race_finish_frame"] = int(snapshot.get("replay_frame", 0) or 0)
        anchor["race_finish_session_time"] = float(snapshot.get("session_time", 0.0) or 0.0)
        changed = True
    return changed


def materialize_heat_script(
    session_plan: dict[str, Any],
    feature_segments: list[dict[str, Any]],
    session_anchors: dict[str, dict[str, Any]],
    static_duration: float = 15.0,
) -> list[dict[str, Any]]:
    """Compose explicit Heat stages around a Feature highlight timeline.

    Heat footage is deliberately limited to measured session-local anchor clips
    until per-session event telemetry is available.  Missing Heat anchors are a
    hard error rather than a mislabeled Feature clip.
    """
    if session_plan.get("format") != "heat":
        return feature_segments

    feature_session = int(session_plan["feature_session_num"])
    out: list[dict[str, Any]] = []
    for stage in session_plan.get("stages", []):
        section = stage["section"]
        session_num = int(stage["session_num"])
        if section == "qualifying_results":
            out.append({"id": "qualifying_results", "type": "broll", "section": section, "session_num": session_num, "result_session_num": session_num, "start_time_seconds": 0.0, "end_time_seconds": static_duration, "duration": static_duration, "purpose": stage["label"], "overlay_template_id": "broadcast"})
        elif section == "heat":
            anchor = session_anchors.get(str(session_num))
            if not anchor or "race_start_session_time" not in anchor or "race_finish_session_time" not in anchor:
                raise ValueError(f"Missing measured start/finish anchors for Heat session {session_num}")
            green = float(anchor["race_start_session_time"])
            finish = float(anchor["race_finish_session_time"])
            start = max(green, finish - static_duration)
            out.append({"id": f"heat_{session_num}_finish", "type": "broll", "section": "heat", "session_num": session_num, "start_time_seconds": start, "end_time_seconds": finish, "duration": finish - start, "purpose": stage["label"], "overlay_template_id": "broadcast"})
        elif section == "heat_results":
            anchor = session_anchors.get(str(session_num))
            if not anchor or "race_finish_session_time" not in anchor:
                raise ValueError(f"Missing measured finish anchor for Heat session {session_num}")
            start = float(anchor["race_finish_session_time"])
            out.append({"id": f"heat_{session_num}_results", "type": "broll", "section": section, "session_num": session_num, "result_session_num": session_num, "start_time_seconds": start, "end_time_seconds": start + static_duration, "duration": static_duration, "purpose": stage["label"], "overlay_template_id": "broadcast"})
        elif section == "race":
            for segment in feature_segments:
                if segment.get("section") == "race":
                    copied = deepcopy(segment)
                    copied["session_num"] = feature_session
                    out.append(copied)
        elif section == "race_results":
            result_segments = [segment for segment in feature_segments if segment.get("section") == "race_results"]
            if result_segments:
                for segment in result_segments:
                    copied = deepcopy(segment)
                    copied["session_num"] = feature_session
                    copied["result_session_num"] = feature_session
                    out.append(copied)
            else:
                anchor = session_anchors.get(str(feature_session), {})
                start = float(anchor.get("race_start_session_time", 0.0))
                out.append({"id": "feature_results", "type": "broll", "section": "race_results", "session_num": feature_session, "result_session_num": feature_session, "start_time_seconds": start, "end_time_seconds": start + static_duration, "duration": static_duration, "purpose": stage["label"], "overlay_template_id": "broadcast"})
    return out
