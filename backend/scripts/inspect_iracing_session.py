"""Inspect the live iRacing SDK session directly.

This bypasses League Replay Studio's cached bridge and prints the current
shared-memory view from pyirsdk. It is intended for debugging session identity,
track drift, replay session selection, and raw WeekendInfo/SessionInfo values.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    try:
        return list(value)
    except TypeError:
        return str(value)


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _read_snapshot(ir: Any, include_raw: bool) -> dict[str, Any]:
    ir.freeze_var_buffer_latest()

    weekend_info = ir["WeekendInfo"] or {}
    session_info = ir["SessionInfo"] or {}
    driver_info = ir["DriverInfo"] or {}
    camera_info = ir["CameraInfo"] or {}

    sessions = session_info.get("Sessions", []) or []
    drivers = driver_info.get("Drivers", []) or []
    cameras = camera_info.get("Groups", []) or []

    summary: dict[str, Any] = {
        "connected": bool(ir.is_initialized and ir.is_connected),
        "last_session_info_update": getattr(ir, "last_session_info_update", None),
        "telemetry": {
            "SessionNum": _int_or_none(ir["SessionNum"]),
            "ReplaySessionNum": _int_or_none(ir["ReplaySessionNum"]),
            "SessionTime": ir["SessionTime"],
            "ReplayFrameNum": _int_or_none(ir["ReplayFrameNum"]),
            "ReplayPlaySpeed": _int_or_none(ir["ReplayPlaySpeed"]),
            "SessionState": _int_or_none(ir["SessionState"]),
        },
        "weekend": {
            "TrackDisplayName": weekend_info.get("TrackDisplayName"),
            "TrackName": weekend_info.get("TrackName"),
            "TrackID": _int_or_none(weekend_info.get("TrackID")),
            "TrackConfigName": weekend_info.get("TrackConfigName"),
            "TrackLength": weekend_info.get("TrackLength"),
            "SubSessionID": _int_or_none(weekend_info.get("SubSessionID")),
            "SessionID": _int_or_none(weekend_info.get("SessionID")),
            "SeriesID": _int_or_none(weekend_info.get("SeriesID")),
            "SeasonID": _int_or_none(weekend_info.get("SeasonID")),
            "RaceWeek": _int_or_none(weekend_info.get("RaceWeek")),
        },
        "session_count": len(sessions),
        "sessions": [
            {
                "index": idx,
                "SessionName": session.get("SessionName"),
                "SessionType": session.get("SessionType"),
                "SessionLaps": session.get("SessionLaps"),
                "SessionTime": session.get("SessionTime"),
                "ResultsPositions": len(session.get("ResultsPositions") or []),
            }
            for idx, session in enumerate(sessions)
        ],
        "driver_count": len(drivers),
        "sample_drivers": [
            {
                "CarIdx": driver.get("CarIdx"),
                "CarNumber": driver.get("CarNumber"),
                "UserName": driver.get("UserName"),
                "UserID": driver.get("UserID"),
                "IsSpectator": driver.get("IsSpectator"),
            }
            for driver in drivers[:8]
        ],
        "camera_count": len(cameras),
    }

    if include_raw:
        summary["raw"] = {
            "WeekendInfo": _json_safe(weekend_info),
            "SessionInfo": _json_safe(session_info),
            "DriverInfo": _json_safe(driver_info),
            "CameraInfo": _json_safe(camera_info),
        }

    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", action="store_true", help="Include full raw SDK sections")
    parser.add_argument("--watch", type=float, default=0.0, help="Repeat every N seconds")
    args = parser.parse_args()

    try:
        import irsdk  # type: ignore[import]
    except ImportError:
        print("pyirsdk is not installed in this Python environment.", file=sys.stderr)
        return 2

    ir = irsdk.IRSDK()
    if not ir.startup() or not ir.is_initialized or not ir.is_connected:
        print("iRacing SDK is not connected.", file=sys.stderr)
        return 1

    try:
        while True:
            print(json.dumps(_read_snapshot(ir, include_raw=args.raw), indent=2))
            if args.watch <= 0:
                break
            sys.stdout.flush()
            time.sleep(args.watch)
    finally:
        try:
            ir.shutdown()
        except Exception:
            pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
