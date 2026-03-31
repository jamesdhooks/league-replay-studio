"""
iracing_bridge.py
-----------------
IRacingBridge — wraps the irsdk shared-memory interface and Broadcasting API.

Runs a background polling thread at 60 Hz that:
  - Detects when iRacing starts / stops
  - Parses session-info YAML on change (drivers, track, camera groups)
  - Emits telemetry snapshots via an asyncio queue

Replay control methods (set_replay_speed, seek_to_frame, cam_switch_pos,
cam_switch_car) delegate directly to the irsdk Broadcasting API.

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
        Returns False if iRacing is not connected or irsdk unavailable.
        """
        if not self._connected or self._ir is None:
            return False
        try:
            if irsdk is not None:
                self._ir.replay_search_frame(frame, irsdk.RpyPosMode.begin)
            else:
                self._ir.replay_search_frame(frame, 0)
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
        """Point camera at a specific car by CarIdx."""
        if not self._connected or self._ir is None:
            return False
        try:
            self._ir.cam_switch_num(car_idx, group_num, 0)
            return True
        except Exception as exc:
            logger.error("[IRacingBridge] cam_switch_car error: %s", exc)
            return False

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

            if not self._ir.is_connected:
                self._handle_disconnect()
                continue

            # Check for session info update (drivers, cameras, track changed).
            try:
                current_version = self._ir.session_info_update
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
            if self._ir is not None and self._ir.startup():
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
        logger.info("[IRacingBridge] iRacing disconnected")
        try:
            self._ir.shutdown()
        except Exception:
            pass
        try:
            self._ir = irsdk.IRSDK()
        except Exception:
            pass
        self._push_update({"event": "iracing:disconnected", "data": {}})

    def _handle_session_info(self) -> None:
        """Parse and cache session info YAML; push update to frontend."""
        try:
            raw = self._ir.session_info
            if not raw:
                return

            drivers = self._parse_drivers(raw)
            cameras = self._parse_cameras(raw)
            track_name = (
                raw.get("WeekendInfo", {}).get("TrackDisplayName", "") or
                raw.get("WeekendInfo", {}).get("TrackName", "")
            )
            session_type = ""
            sessions = raw.get("SessionInfo", {}).get("Sessions", [])
            if sessions:
                session_type = sessions[0].get("SessionType", "")
            avg_lap_time = 0.0
            if sessions:
                try:
                    avg_lap_time = float(sessions[0].get("ResultsAverageLapTime", 0) or 0)
                except (ValueError, TypeError):
                    avg_lap_time = 0.0

            self._session_data = {
                "track_name": track_name,
                "session_type": session_type,
                "avg_lap_time": avg_lap_time,
                "drivers": drivers,
                "cameras": cameras,
            }

            self._push_update(
                {"event": "iracing:session_info", "data": self._session_data}
            )
            logger.info(
                "[IRacingBridge] Session info updated: %s, %d drivers, %d cameras",
                track_name,
                len(drivers),
                len(cameras),
            )
        except Exception as exc:
            logger.warning("[IRacingBridge] Session info parse error: %s", exc)

    @staticmethod
    def _parse_drivers(raw: dict) -> list[dict]:
        """Extract driver list from session info YAML."""
        drivers_raw = raw.get("DriverInfo", {}).get("Drivers", []) or []
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
    def _parse_cameras(raw: dict) -> list[dict]:
        """Extract camera group list from session info YAML."""
        groups_raw = raw.get("CameraInfo", {}).get("Groups", []) or []
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
