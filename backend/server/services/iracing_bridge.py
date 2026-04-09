"""
iracing_bridge.py
-----------------
IRacingBridge — wraps the pyirsdk shared-memory interface and Broadcasting API.

Install: pip install pyirsdk   (imports as `import irsdk`)
Repo:    https://github.com/kutu/pyirsdk

Runs a background polling thread at 60 Hz that:
  - Detects when iRacing starts / stops
  - Parses session-info data on change (drivers, track, camera groups)
  - Emits telemetry snapshots via an asyncio queue

Replay control methods (set_replay_speed, seek_to_frame, cam_switch_pos,
cam_switch_car) delegate directly to the pyirsdk Broadcasting API.

All interaction with the asyncio event loop goes through
`asyncio.run_coroutine_threadsafe`, so the bridge is thread-safe.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

# ── Optional irsdk import (graceful fallback when not installed) ─────────────

try:
    import irsdk  # type: ignore[import]
    _IRSDK_AVAILABLE = True
except ImportError:  # pragma: no cover
    irsdk = None  # type: ignore[assignment]
    _IRSDK_AVAILABLE = False
    logger.warning("[IRacingBridge] irsdk not installed — SDK bridge disabled")


# ── Constants ─────────────────────────────────────────────────────────────────

POLL_HZ = 60
RECONNECT_INTERVAL = 2.0          # seconds between connection attempts
TELEMETRY_INTERVAL = 1.0 / POLL_HZ  # ~16.7 ms


class IRacingBridge:
    """
    Singleton-style service that wraps pyirsdk shared memory + Broadcasting API.

    Usage:
        bridge = IRacingBridge()
        bridge.start(loop)         # pass the running asyncio event loop
        bridge.on_update = my_fn   # optional synchronous callback
        ...
        bridge.stop()
    """

    def __init__(self) -> None:
        self._ir: Any = None                      # irsdk.IRSDK instance
        self._connected: bool = False
        self._session_info_version: int = -1
        self._session_data: dict = {}             # parsed session info cache
        # Per-car cumulative incident counts from the last SessionInfo update.
        # Used to compute deltas between updates (ResultsPositions approach).
        self._prev_result_incidents: dict[int, int] = {}
        # Incident deltas detected by _handle_session_info; drained by the
        # scan loop via drain_incidents().
        self._pending_incidents: list[dict] = []
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._update_queue: Optional[asyncio.Queue] = None
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        # Callback invoked (in the poll thread) for each queued update.
        # Set by the FastAPI app to broadcast via WebSocket.
        self.on_update: Optional[Callable[[dict], None]] = None

    # ── Public API ────────────────────────────────────────────────────────────

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        """Start the background polling thread attached to *loop*."""
        if self._thread and self._thread.is_alive():
            return
        self._loop = loop
        self._update_queue = asyncio.Queue()
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._poll_loop, daemon=True, name="iracing-poll"
        )
        self._thread.start()
        logger.info("[IRacingBridge] Polling thread started")

    def stop(self) -> None:
        """Signal the polling thread to exit."""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
        logger.info("[IRacingBridge] Polling thread stopped")

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def session_data(self) -> dict:
        return dict(self._session_data)

    def drain_incidents(self) -> list[dict]:
        """Return and clear all incident deltas detected since the last call.

        Called by the scan loop each tick so incidents are written to the DB
        in real time as iRacing updates SessionInfo during replay playback.
        """
        if not self._pending_incidents:
            return []
        incidents, self._pending_incidents = self._pending_incidents, []
        return incidents

    # ── Replay Control (Broadcasting API) ─────────────────────────────────────

    def set_replay_speed(self, speed: int) -> bool:
        """
        Set replay playback speed.
        speed: 0=pause, 1=normal, 2=2×, 4=4×, 8=8×, 16=16×
        Returns False if iRacing is not connected.
        """
        if not self._connected or self._ir is None:
            return False
        try:
            self._ir.replay_set_play_speed(speed, False)
            logger.debug("[IRacingBridge] Replay speed → %d×", speed)
            return True
        except Exception as exc:
            logger.error("[IRacingBridge] set_replay_speed error: %s", exc)
            return False

    def seek_to_frame(self, frame: int) -> bool:
        """
        Seek the replay to a specific frame number.
        Uses replay_set_play_position(RpyPosMode.begin, frame) per pyirsdk API.
        Returns False if iRacing is not connected.
        """
        if not self._connected or self._ir is None:
            return False
        try:
            self._ir.replay_set_play_position(irsdk.RpyPosMode.begin, frame)
            logger.debug("[IRacingBridge] Seek → frame %d", frame)
            return True
        except Exception as exc:
            logger.error("[IRacingBridge] seek_to_frame error: %s", exc)
            return False

    def cam_switch_position(self, position: int, group_num: int) -> bool:
        """Point camera at race position *position* (1=leader)."""
        if not self._connected or self._ir is None:
            return False
        try:
            self._ir.cam_switch_pos(position, group_num, 0)
            return True
        except Exception as exc:
            logger.error("[IRacingBridge] cam_switch_position error: %s", exc)
            return False

    def cam_switch_car(self, car_idx: int, group_num: int) -> bool:
        """Point camera at a specific car by CarIdx.

        Resolves car_idx to the car's racing number before calling
        cam_switch_num (which expects the painted car number, not the
        internal CarIdx).
        """
        if not self._connected or self._ir is None:
            return False
        # Resolve car_idx → car_number (racing number)
        car_num = car_idx  # fallback
        for d in self._session_data.get("drivers", []):
            if d.get("car_idx") == car_idx:
                try:
                    car_num = int(d["car_number"])
                except (ValueError, TypeError):
                    car_num = car_idx
                break
        try:
            self._ir.cam_switch_num(car_num, group_num, 0)
            logger.debug("[IRacingBridge] cam_switch_num car_num=%d group=%d (from car_idx=%d)", car_num, group_num, car_idx)
            return True
        except Exception as exc:
            logger.error("[IRacingBridge] cam_switch_car error: %s", exc)
            return False

    def replay_search(self, mode: int) -> bool:
        """Execute a replay search command (next_session, prev_session, etc.).

        Uses ``irsdk.RpySrchMode`` constants:
          to_start=0, to_end=1, prev_session=2, next_session=3,
          prev_lap=4, next_lap=5, prev_incident=8, next_incident=9
        """
        if not self._connected or self._ir is None:
            return False
        try:
            self._ir.replay_search(mode)
            return True
        except Exception as exc:
            logger.error("[IRacingBridge] replay_search error: %s", exc)
            return False

    def replay_search_session_time(self, session_num: int, session_time_ms: int) -> bool:
        """Jump the replay to a specific session number and time.

        session_num:     0-based session index from SessionInfo.Sessions
        session_time_ms: Milliseconds from session start
        """
        if not self._connected or self._ir is None:
            return False
        try:
            self._ir.replay_search_session_time(session_num, session_time_ms)
            return True
        except Exception as exc:
            logger.error("[IRacingBridge] replay_search_session_time error: %s", exc)
            return False

    def get_replay_session_num(self) -> int:
        """Read the current ReplaySessionNum telemetry variable."""
        if not self._connected or self._ir is None:
            return -1
        try:
            self._ir.freeze_var_buffer_latest()
            val = self._ir["ReplaySessionNum"]
            return val if val is not None else -1
        except Exception:
            return -1

    def get_replay_frame(self) -> int:
        """Read the current ReplayFrameNum telemetry variable."""
        if not self._connected or self._ir is None:
            return -1
        try:
            self._ir.freeze_var_buffer_latest()
            val = self._ir["ReplayFrameNum"]
            return int(val) if val is not None else -1
        except Exception:
            return -1

    def get_replay_speed(self) -> int:
        """Read the current ReplayPlaySpeed telemetry variable."""
        if not self._connected or self._ir is None:
            return -1
        try:
            self._ir.freeze_var_buffer_latest()
            val = self._ir["ReplayPlaySpeed"]
            return int(val) if val is not None else -1
        except Exception:
            return -1

    def get_sessions_info(self) -> list[dict]:
        """Return the list of sessions from SessionInfo with type and index."""
        try:
            session_info = self._ir["SessionInfo"] or {}
            sessions = session_info.get("Sessions", [])
            return [
                {
                    "index": i,
                    "type": s.get("SessionType", ""),
                    "name": s.get("SessionName", ""),
                    "laps": s.get("SessionLaps", ""),
                }
                for i, s in enumerate(sessions)
            ]
        except Exception:
            return []

    def capture_all_vars(self) -> tuple[dict, dict] | None:
        """Capture ALL available iRacing telemetry variables in one atomic read.

        Returns (catalog, snapshot) where:
          catalog  — {var_name: {type, unit, description, count}} from var_headers
          snapshot — {var_name: value} for every variable, with list values for
                     array types and scalar values for single vars.

        Returns None if not connected.  Array values are returned as plain Python
        lists so they are JSON-serialisable.
        """
        if not self._connected or self._ir is None:
            return None
        try:
            self._ir.freeze_var_buffer_latest()

            # _var_headers_dict is an @property on IRSDK that returns
            # {name: VarHeader}.  VarHeader fields (name, desc, unit) are
            # decoded Python strings via property_value_str; type/count are ints.
            # NOTE: do NOT use self._ir.var_headers — that attribute does not
            # exist; accessing it falls through __getitem__ → session YAML lookup
            # → returns None, causing (None).items() to raise and the method to
            # return None every call.
            var_headers_dict: dict = self._ir._var_headers_dict or {}

            catalog: dict = {}
            snapshot: dict = {}

            for name, header in var_headers_dict.items():
                catalog[name] = {
                    "type":  header.type,
                    "unit":  header.unit,
                    "desc":  header.desc,
                    "count": header.count,
                }
                try:
                    val = self._ir[name]
                    if val is None:
                        snapshot[name] = None
                    elif hasattr(val, "__iter__") and not isinstance(val, (str, bytes)):
                        snapshot[name] = list(val)
                    else:
                        snapshot[name] = val
                except Exception:
                    snapshot[name] = None

            return catalog, snapshot
        except Exception as exc:
            logger.debug("[IRacingBridge] capture_all_vars error: %s", exc)
            return None

    def capture_snapshot(self) -> dict | None:
        """
        Capture a telemetry snapshot directly from shared memory.
        Returns a flat dict with car state data, or None if not connected.

        Used by the analysis pipeline when it needs an on-demand read
        outside the normal 60 Hz push cycle.
        """
        if not self._connected or self._ir is None:
            return None
        try:
            self._ir.freeze_var_buffer_latest()

            positions      = list(self._ir["CarIdxPosition"]       or [])
            lap_pcts       = list(self._ir["CarIdxLapDistPct"]     or [])
            surfaces       = list(self._ir["CarIdxTrackSurface"]   or [])
            est_times      = list(self._ir["CarIdxEstTime"]         or [])
            laps           = list(self._ir["CarIdxLap"]             or [])
            class_pos      = list(self._ir["CarIdxClassPosition"]   or [])
            best_laps      = list(self._ir["CarIdxBestLapTime"]     or [])
            speeds         = list(self._ir["CarIdxSpeed"]           or [])
            incident_counts = list(self._ir["CarIdxIncidentCount"] or [])

            NOT_IN_WORLD = -1
            car_states: list[dict] = []
            for i in range(len(positions)):
                if positions[i] > 0 and (i >= len(surfaces) or surfaces[i] != NOT_IN_WORLD):
                    car_states.append({
                        "car_idx":        i,
                        "position":       positions[i],
                        "class_position": class_pos[i] if i < len(class_pos) else 0,
                        "lap":            laps[i]      if i < len(laps)      else 0,
                        "lap_pct":        lap_pcts[i]  if i < len(lap_pcts)  else 0.0,
                        "surface":        surfaces[i]  if i < len(surfaces)  else 0,
                        "est_time":       est_times[i] if i < len(est_times) else 0.0,
                        "best_lap_time":  best_laps[i] if i < len(best_laps) else -1.0,
                        "speed_ms":       speeds[i]    if i < len(speeds)    else None,
                    })

            # Include track_length from session data for speed derivation fallback
            track_length = self._session_data.get("track_length", 0.0)

            replay_speed_raw = self._ir["ReplayPlaySpeed"]
            replay_speed = int(replay_speed_raw) if replay_speed_raw is not None else 1

            # ReplaySessionNum tracks which session the replay is currently positioned
            # in, and updates when replay_search_session_time() is used.
            # SessionNum reflects the live/original session and does NOT change
            # during replay seeking — so we must use ReplaySessionNum for all
            # replay-position checks.
            replay_session_num_raw = self._ir["ReplaySessionNum"]
            replay_session_num = int(replay_session_num_raw) if replay_session_num_raw is not None else 0

            return {
                "session_time":       self._ir["SessionTime"]    or 0.0,
                "session_state":      self._ir["SessionState"]   or 0,
                "session_num":        self._ir["SessionNum"]     if self._ir["SessionNum"] is not None else 0,
                "replay_session_num": replay_session_num,
                "replay_frame":       self._ir["ReplayFrameNum"] or 0,
                "race_laps":     self._ir["RaceLaps"]       or 0,
                "cam_car_idx":   self._ir["CamCarIdx"]      or 0,
                "cam_group_num": self._ir["CamGroupNumber"] or 0,
                "flags":         self._ir["SessionFlags"]   or 0,
                "replay_speed":    replay_speed,
                "track_length":    track_length,
                "car_states":      car_states,
                "incident_counts": incident_counts,
            }
        except Exception as exc:
            logger.debug("[IRacingBridge] capture_snapshot error: %s", exc)
            return None

    # ── Background Poll Loop ──────────────────────────────────────────────────

    def _poll_loop(self) -> None:
        """Main polling loop — runs in its own thread."""
        if not _IRSDK_AVAILABLE:
            logger.warning("[IRacingBridge] irsdk unavailable; poll loop idle")
            # Still run so callers can check is_connected safely.
            while not self._stop_event.is_set():
                time.sleep(RECONNECT_INTERVAL)
            return

        self._ir = irsdk.IRSDK()

        while not self._stop_event.is_set():
            if not self._connected:
                self._attempt_connect()
                if not self._connected:
                    time.sleep(RECONNECT_INTERVAL)
                    continue

            # Take an atomic snapshot of the latest telemetry frame.
            self._ir.freeze_var_buffer_latest()

            if not (self._ir.is_initialized and self._ir.is_connected):
                self._handle_disconnect()
                continue

            # Check for session info update (drivers, cameras, track changed).
            try:
                current_version = self._ir.last_session_info_update
                if current_version != self._session_info_version:
                    self._session_info_version = current_version
                    self._handle_session_info()
            except Exception as exc:
                logger.warning("[IRacingBridge] Session info read error: %s", exc)

            # Emit telemetry snapshot.
            try:
                self._emit_telemetry()
            except Exception as exc:
                logger.warning("[IRacingBridge] Telemetry emit error: %s", exc)

            time.sleep(TELEMETRY_INTERVAL)

    def _attempt_connect(self) -> None:
        """Try to connect to iRacing shared memory."""
        try:
            if self._ir is not None and self._ir.startup() and self._ir.is_initialized and self._ir.is_connected:
                self._connected = True
                logger.info("[IRacingBridge] iRacing connected")
                self._push_update({"event": "iracing:connected", "data": {}})
        except Exception as exc:
            logger.debug("[IRacingBridge] Connect attempt failed: %s", exc)

    def _handle_disconnect(self) -> None:
        """Handle iRacing going offline."""
        self._connected = False
        self._session_info_version = -1
        self._session_data = {}
        self._prev_result_incidents = {}
        self._pending_incidents = []
        logger.info("[IRacingBridge] iRacing disconnected")
        try:
            self._ir.shutdown()
        except Exception:
                logger.debug("Suppressed exception in cleanup", exc_info=True)
        try:
            self._ir = irsdk.IRSDK()
        except Exception:
                logger.debug("Suppressed exception in cleanup", exc_info=True)
        self._push_update({"event": "iracing:disconnected", "data": {}})

    def _handle_session_info(self) -> None:
        """Parse and cache session info YAML; push update to frontend.

        Session data is accessed via ir['SectionName'] subscript per pyirsdk API.
        Each top-level key (WeekendInfo, DriverInfo, CameraInfo, SessionInfo)
        is fetched and parsed separately.
        """
        try:
            weekend_info  = self._ir["WeekendInfo"]  or {}
            driver_info   = self._ir["DriverInfo"]   or {}
            camera_info   = self._ir["CameraInfo"]   or {}
            session_info  = self._ir["SessionInfo"]  or {}
            session_log   = self._ir["SessionLog"]   or {}

            if not weekend_info and not driver_info:
                return

            drivers = self._parse_drivers(driver_info)
            cameras = self._parse_cameras(camera_info)
            track_name = (
                weekend_info.get("TrackDisplayName", "") or
                weekend_info.get("TrackName", "")
            )
            # Extract track length (iRacing provides e.g. "3.61 km")
            track_length_str = weekend_info.get("TrackLength", "")
            track_length_m = 0.0
            if track_length_str:
                try:
                    # Parse "X.XX km" or "X.XX mi" format
                    parts = str(track_length_str).strip().split()
                    val = float(parts[0])
                    unit = parts[1].lower() if len(parts) > 1 else "km"
                    track_length_m = val * 1609.34 if "mi" in unit else val * 1000.0
                except (ValueError, IndexError):
                    track_length_m = 0.0
            session_type = ""
            sessions = session_info.get("Sessions", [])
            race_session_num = None
            if sessions:
                session_type = sessions[0].get("SessionType", "")
                # Find the race session index
                for i, s in enumerate(sessions):
                    stype = (s.get("SessionType", "") or "").lower()
                    if stype in ("race", "race1", "race2"):
                        race_session_num = i
                        break
            avg_lap_time = 0.0
            if sessions:
                try:
                    avg_lap_time = float(sessions[0].get("ResultsAverageLapTime", 0) or 0)
                except (ValueError, TypeError):
                    avg_lap_time = 0.0

            # Parse per-driver incident counts from ResultsPositions in the
            # SessionInfo YAML.  Unlike SessionLog.Messages (which is empty
            # during replay), ResultsPositions.Incidents IS updated by iRacing
            # as the replay plays forward, so diffing between session-info
            # updates gives us the exact incident point delta per driver.
            # Build a name lookup while we're here.
            _driver_name_map: dict[int, str] = {
                d["car_idx"]: d.get("user_name") or d.get("name") or ""
                for d in drivers
                if "car_idx" in d
            }
            current_session_time = float(self._ir["SessionTime"] or 0.0)

            incident_log: list[dict] = []
            race_session = None
            if race_session_num is not None and sessions:
                race_session = sessions[race_session_num] if race_session_num < len(sessions) else None
            if race_session is not None:
                results_positions = race_session.get("ResultsPositions") or []
                for rp in results_positions:
                    if not isinstance(rp, dict):
                        continue
                    try:
                        car_idx = int(rp.get("CarIdx", -1))
                    except (ValueError, TypeError):
                        continue
                    if car_idx < 0:
                        continue
                    try:
                        inc_total = int(rp.get("Incidents", 0) or 0)
                    except (ValueError, TypeError):
                        inc_total = 0
                    prev_total = self._prev_result_incidents.get(car_idx, 0)
                    delta = inc_total - prev_total
                    if delta > 0 and car_idx in self._prev_result_incidents:
                        try:
                            lap = int(rp.get("Lap", 0) or 0)
                        except (ValueError, TypeError):
                            lap = 0
                        entry = {
                            "CarIdx":      car_idx,
                            "SessionTime": current_session_time,
                            "Lap":         lap,
                            "Description": f"+{delta}x",
                            "Incident":    delta,
                            "SessionNum":  race_session_num,
                            "UserName":    _driver_name_map.get(car_idx, ""),
                        }
                        incident_log.append(entry)
                        self._pending_incidents.append(entry)
                    self._prev_result_incidents[car_idx] = inc_total

            self._session_data = {
                "track_name": track_name,
                "track_length": track_length_m,
                "track_id": int(weekend_info.get("TrackID", 0) or 0),
                "subsession_id": int(weekend_info.get("SubSessionID", 0) or 0),
                "session_type": session_type,
                "avg_lap_time": avg_lap_time,
                "drivers": drivers,
                "cameras": cameras,
                "race_session_num": race_session_num,
                "driver_cust_ids": sorted([
                    d["iracing_cust_id"] for d in drivers
                    if not d.get("is_spectator") and d.get("iracing_cust_id", 0) > 0
                ]),
                "sessions": [
                    {"index": i, "type": s.get("SessionType", ""), "name": s.get("SessionName", "")}
                    for i, s in enumerate(sessions)
                ],
                "incident_log": incident_log,
            }

            self._push_update(
                {"event": "iracing:session_info", "data": self._session_data}
            )
            logger.info(
                "[IRacingBridge] Session info updated: %s, %d drivers, %d cameras, %d incident deltas",
                track_name,
                len(drivers),
                len(cameras),
                len(incident_log),
            )
        except Exception as exc:
            logger.warning("[IRacingBridge] Session info parse error: %s", exc)

    @staticmethod
    def _parse_drivers(driver_info: dict) -> list[dict]:
        """Extract driver list from DriverInfo section (ir['DriverInfo'])."""
        drivers_raw = driver_info.get("Drivers", []) or []
        drivers = []
        for d in drivers_raw:
            try:
                car_idx = int(d.get("CarIdx", -1))
                if car_idx < 0:
                    continue
                drivers.append(
                    {
                        "car_idx": car_idx,
                        "car_number": str(d.get("CarNumber", "")),
                        "user_name": str(d.get("UserName", "")),
                        "car_class_id": int(d.get("CarClassID", 0) or 0),
                        "car_class_name": str(d.get("CarClassShortName", "")),
                        "is_spectator": bool(int(d.get("IsSpectator", 0) or 0)),
                        "iracing_cust_id": int(d.get("UserID", 0) or 0),
                    }
                )
            except (ValueError, TypeError, AttributeError):
                continue
        return drivers

    @staticmethod
    def _parse_cameras(camera_info: dict) -> list[dict]:
        """Extract camera group list from CameraInfo section (ir['CameraInfo'])."""
        groups_raw = camera_info.get("Groups", []) or []
        cameras = []
        for g in groups_raw:
            try:
                cameras.append(
                    {
                        "group_num": int(g.get("GroupNum", 0) or 0),
                        "group_name": str(g.get("GroupName", "")),
                    }
                )
            except (ValueError, TypeError, AttributeError):
                continue
        return cameras

    def _emit_telemetry(self) -> None:
        """Build and push a telemetry snapshot to connected clients."""
        ir = self._ir

        positions   = list(ir["CarIdxPosition"] or [])
        lap_pcts    = list(ir["CarIdxLapDistPct"] or [])
        surfaces    = list(ir["CarIdxTrackSurface"] or [])
        est_times   = list(ir["CarIdxEstTime"] or [])
        laps        = list(ir["CarIdxLap"] or [])
        class_pos   = list(ir["CarIdxClassPosition"] or [])
        best_laps   = list(ir["CarIdxBestLapTime"] or [])
        speeds      = list(ir["CarIdxSpeed"] or [])

        # Build per-car state list — only active cars (position > 0 and in world)
        NOT_IN_WORLD = -1
        car_states: list[dict] = []
        for i in range(len(positions)):
            if positions[i] > 0 and (i >= len(surfaces) or surfaces[i] != NOT_IN_WORLD):
                car_states.append(
                    {
                        "car_idx":        i,
                        "position":       positions[i],
                        "class_position": class_pos[i] if i < len(class_pos) else 0,
                        "lap":            laps[i] if i < len(laps) else 0,
                        "lap_pct":        lap_pcts[i] if i < len(lap_pcts) else 0.0,
                        "surface":        surfaces[i] if i < len(surfaces) else 0,
                        "est_time":       est_times[i] if i < len(est_times) else 0.0,
                        "best_lap_time":  best_laps[i] if i < len(best_laps) else -1.0,
                        "speed_ms":       speeds[i]    if i < len(speeds)    else None,
                    }
                )

        snapshot = {
            "event": "iracing:telemetry",
            "data": {
                "session_time":  ir["SessionTime"] or 0.0,
                "session_state": ir["SessionState"] or 0,
                "replay_frame":  ir["ReplayFrameNum"] or 0,
                "race_laps":     ir["RaceLaps"] or 0,
                "cam_car_idx":   ir["CamCarIdx"] or 0,
                "flags":         ir["SessionFlags"] or 0,
                "track_length":  self._session_data.get("track_length", 0.0),
                "car_states":    car_states,
            },
        }
        self._push_update(snapshot)

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _push_update(self, message: dict) -> None:
        """
        Thread-safe: schedule *message* to be broadcast from the asyncio loop.
        Delegates to self.on_update if set, otherwise queues it.
        """
        if self.on_update is not None:
            try:
                self.on_update(message)
            except Exception as exc:
                logger.debug("[IRacingBridge] on_update error: %s", exc)
        elif self._loop is not None and self._update_queue is not None:
            try:
                asyncio.run_coroutine_threadsafe(
                    self._update_queue.put(message), self._loop
                )
            except Exception as exc:
                logger.debug("[IRacingBridge] Queue put error: %s", exc)


# ── Module-level singleton ─────────────────────────────────────────────────────

bridge = IRacingBridge()
