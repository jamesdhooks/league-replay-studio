"""
api_iracing.py
--------------
REST endpoints for iRacing connection and replay control.

GET  /api/iracing/status              — connection status + session summary
GET  /api/iracing/session             — full session data (drivers, track, etc.)
GET  /api/iracing/cameras             — available camera groups
GET  /api/iracing/windows             — list visible windows for manual picker
GET  /api/iracing/capture-target      — current capture target
POST /api/iracing/capture-target      — set manual capture target window
DELETE /api/iracing/capture-target    — reset to auto-detect
POST /api/iracing/replay/play         — play replay at 1× speed
POST /api/iracing/replay/pause        — pause replay
POST /api/iracing/replay/seek         — seek to specific frame
POST /api/iracing/replay/speed        — set replay speed (1/2/4/8/16)
POST /api/iracing/replay/camera       — switch camera to car / position
GET  /api/iracing/stream               — MJPEG live preview stream
GET  /api/iracing/stream/h264          — H.264 fMP4 live stream (MSE player)
GET  /api/iracing/stream/hls/{filename} — HLS playlist (.m3u8) and segments (.ts)
POST /api/iracing/stream/hls/stop      — stop HLS segmenter and clean up
GET  /api/iracing/stream/capabilities  — preview + capture engine availability
GET  /api/iracing/stream/metrics       — capture engine metrics
POST /api/iracing/stream/start         — start/restart capture engine
POST /api/iracing/stream/stop          — stop capture engine
POST /api/iracing/stream/record/start  — start GPU recording to file
POST /api/iracing/stream/record/stop   — stop recording
"""

from __future__ import annotations

from typing import Optional

import asyncio
import io
import pathlib
import re
import shutil
import subprocess
import tempfile
import threading
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

import logging

from server.services.iracing_bridge import bridge
from server.services.project_service import project_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/iracing", tags=["iracing"])

# Validates HLS filenames: only 'playlist.m3u8' or 'seg#####.ts' are accepted,
# ruling out any path-separator or traversal characters.
_SAFE_HLS_FILENAME_RE = re.compile(r'^(?:playlist\.m3u8|seg\d{5}\.ts)$')


# ── Stream coordination ────────────────────────────────────────────────────────
# Only ONE H.264-feed consumer (H.264 fMP4 or HLS segmenter) may be active at
# a time.  MJPEG is independent (reads latest_jpeg, not the queue).  The
# functions below enforce mutual exclusion so switching formats never leaves
# zombie feeders that steal frames from the new consumer.

_hls_lock = threading.Lock()
_hls_session: dict = {
    "tmpdir": None,
    "proc": None,
    "feed_thread": None,
    "gen_token": None,
    "feed_state": None,
    "active": False,
    "fps": 0,
    "crf": 0,
    "max_width": 0,
}


def _stop_h264_consumers() -> None:
    """Stop ALL active H.264/HLS feed consumers.

    Call this before starting a new H.264 or HLS stream to guarantee that no
    zombie feeder thread is left draining ``_h264_queue``.
    Safe to call when nothing is running.
    """
    from server.utils.capture_engine import capture_engine

    # 1. Stop the HLS segmenter (kills FFmpeg + feeder thread)
    with _hls_lock:
        _stop_hls_session_locked()

    # 2. Disable the h264 feed entirely (kills any H.264 fMP4 feeder thread
    #    that checks the gen token).  We increment the gen so the old feeder's
    #    gen-check fails, then clear the streaming flag.
    capture_engine._h264_gen += 1
    capture_engine._h264_streaming = False
    capture_engine._h264_queue.clear()


def _stop_hls_session_locked() -> None:
    """Tear down the active HLS session. Caller must hold _hls_lock."""
    from server.utils.capture_engine import capture_engine

    if not _hls_session.get("active"):
        return

    if _hls_session.get("feed_state"):
        _hls_session["feed_state"]["active"] = False

    gen_token = _hls_session.get("gen_token")
    if gen_token is not None:
        try:
            capture_engine.stop_h264_feed(gen_token)
        except Exception:
            logger.debug("Suppressed exception in cleanup", exc_info=True)

    proc = _hls_session.get("proc")
    if proc is not None:
        try:
            proc.kill()
            proc.wait(timeout=2)
        except Exception:
            logger.debug("Suppressed exception in cleanup", exc_info=True)

    tmpdir = _hls_session.get("tmpdir")
    if tmpdir and pathlib.Path(tmpdir).exists():
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            logger.debug("Suppressed exception in cleanup", exc_info=True)

    _hls_session.update({
        "tmpdir": None, "proc": None, "feed_thread": None,
        "gen_token": None, "feed_state": None, "active": False,
        "fps": 0, "crf": 0, "max_width": 0,
    })


def _start_hls_session_locked(ffmpeg: str, fps: int, crf: int, max_width: int) -> pathlib.Path:
    """Start the FFmpeg HLS segmenter. Returns the tmpdir path. Caller must hold _hls_lock."""
    from server.utils.capture_engine import capture_engine

    _stop_hls_session_locked()

    # Also kill any lingering H.264 fMP4 feeder — we're about to take over
    # the h264_queue exclusively.
    capture_engine._h264_gen += 1
    capture_engine._h264_streaming = False
    capture_engine._h264_queue.clear()

    tmpdir = pathlib.Path(tempfile.mkdtemp(prefix="lrs_hls_"))
    playlist_path = tmpdir / "playlist.m3u8"

    # IMPORTANT: do NOT pass max_width — HLS must never mutate the engine's
    # output resolution (same reasoning as H.264 endpoint).  Instead, let
    # FFmpeg's -vf scale handle downscaling to the desired HLS output width.
    if not capture_engine.is_running:
        capture_engine.start(fps=fps, quality=85, max_width=1280)
    else:
        capture_engine.update_params(fps=fps)

    # Wait up to 10 s for the first capture frame so we get the real source
    # dimensions.  Previously this was capped at 5 s, which was too short when
    # dxcam takes a moment to start (e.g. first launch) or falls back to
    # PrintWindow.  A missed wait here means FFmpeg starts with the wrong
    # dimensions and every incoming frame gets resized, compounding latency.
    for _ in range(100):
        if capture_engine._out_w > 0:
            break
        time.sleep(0.1)

    # Lock the raw input dimensions for this FFmpeg process.
    # If we still don't have real dims after the wait (e.g. iRacing not open),
    # fall back to safe defaults so FFmpeg can at least start.
    input_w = (capture_engine._out_w or max_width) & ~1
    input_h = (capture_engine._out_h or 720) & ~1

    # Compute desired HLS output dimensions — never upscale
    desired_w = min(max_width, input_w) & ~1
    desired_h = int(input_h * desired_w / input_w) & ~1 if input_w > 0 else input_h
    scale_filter: list[str] = []
    if desired_w != input_w:
        scale_filter = ["-vf", f"scale={desired_w}:{desired_h}:flags=fast_bilinear"]

    logger.info("[Stream] HLS session starting (fps=%d crf=%d input=%dx%d output=%dx%d)",
                  fps, crf, input_w, input_h, desired_w, desired_h)

    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo",
        "-pixel_format", "bgr24",
        "-video_size", f"{input_w}x{input_h}",   # raw input — never changes
        "-framerate", str(fps),
        "-i", "pipe:0",
        *scale_filter,                              # optional FFmpeg-side downscale
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-g", str(fps),           # keyframe every second — required for HLS segments
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-profile:v", "baseline",
        "-level:v", "4.0",
        "-f", "hls",
        "-hls_time", "1",
        "-hls_list_size", "3",
        "-hls_flags", "delete_segments+append_list",
        "-hls_segment_filename", str(tmpdir / "seg%05d.ts"),
        str(playlist_path),
    ]

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,   # drained below; DEVNULL would hide startup errors
        bufsize=0,
    )

    def _drain_ffmpeg_stderr() -> None:
        """Continuously drain FFmpeg stderr so the pipe never deadlocks."""
        try:
            for raw in proc.stderr:
                line = raw.decode("utf-8", errors="replace").rstrip()
                if line:
                    logger.error("[HLS FFmpeg] %s", line)
        except Exception:
            logger.debug("Suppressed exception in cleanup", exc_info=True)

    threading.Thread(target=_drain_ffmpeg_stderr, daemon=True).start()

    gen_token = capture_engine.start_h264_feed()
    feed_state = {"active": True}

    def _feed_stdin() -> None:
        last_frame: Optional[bytes] = None
        last_frame_at: float = time.monotonic()
        # Max age before repeating last frame to keep FFmpeg's pipeline flowing.
        REPEAT_AFTER_S = 1.0 / fps  # one frame-period at the target fps
        try:
            while feed_state["active"]:
                # ── Gen-token check: exit immediately if superseded ──
                if capture_engine._h264_gen != gen_token:
                    logger.info("[HLS] feeder exiting — superseded by gen %d",
                                capture_engine._h264_gen)
                    break

                frame_bytes: Optional[bytes] = None
                try:
                    frame = capture_engine._h264_queue.popleft()
                    # Dimension guard — resize if needed so FFmpeg always sees
                    # the exact frame dimensions it was started with.
                    if frame.shape[1] != input_w or frame.shape[0] != input_h:
                        try:
                            import cv2 as _cv2_hls
                            frame = _cv2_hls.resize(
                                frame, (input_w, input_h),
                                interpolation=_cv2_hls.INTER_LINEAR,
                            )
                        except Exception:
                            continue  # cv2 unavailable → skip frame
                    frame_bytes = frame.tobytes()
                    last_frame = frame_bytes
                    last_frame_at = time.monotonic()
                except IndexError:
                    # No new frame — repeat last frame if stale to prevent FFmpeg stalling
                    if last_frame is not None and (time.monotonic() - last_frame_at) >= REPEAT_AFTER_S:
                        frame_bytes = last_frame
                        last_frame_at = time.monotonic()
                    else:
                        time.sleep(0.004)
                        continue

                if proc.stdin is None or proc.stdin.closed:
                    break
                try:
                    proc.stdin.write(frame_bytes)
                except (BrokenPipeError, OSError):
                    break
        finally:
            try:
                proc.stdin.close()
            except Exception:
                logger.debug("Suppressed exception in cleanup", exc_info=True)

    feed_thread = threading.Thread(target=_feed_stdin, daemon=True)
    feed_thread.start()

    _hls_session.update({
        "tmpdir": str(tmpdir),
        "proc": proc,
        "feed_thread": feed_thread,
        "gen_token": gen_token,
        "feed_state": feed_state,
        "active": True,
        "fps": fps,
        "crf": crf,
        "max_width": max_width,
    })

    return tmpdir


# ── Response models ───────────────────────────────────────────────────────────

class IRacingStatusResponse(BaseModel):
    connected: bool
    track_name: str = ""
    session_type: str = ""
    driver_count: int = 0
    camera_count: int = 0


class CameraGroup(BaseModel):
    group_num: int
    group_name: str


class Driver(BaseModel):
    car_idx: int
    car_number: str
    user_name: str
    car_class_id: int
    car_class_name: str
    is_spectator: bool
    iracing_cust_id: int


class IRacingSessionResponse(BaseModel):
    connected: bool
    track_name: str = ""
    session_type: str = ""
    avg_lap_time: float = 0.0
    drivers: list[Driver] = []
    cameras: list[CameraGroup] = []


# ── Request models ────────────────────────────────────────────────────────────

class SeekRequest(BaseModel):
    frame: int = Field(..., ge=0, description="Replay frame number to seek to")


class SeekTimeRequest(BaseModel):
    session_num: int = Field(..., ge=0, description="Session index (0-based)")
    session_time_ms: int = Field(..., ge=0, description="Milliseconds from session start")


class SpeedRequest(BaseModel):
    speed: int = Field(..., description="Replay speed: negative=rewind, 0=pause, 1=normal, 2/4/8/16")


class ReplaySearchRequest(BaseModel):
    mode: str = Field(..., description="Search mode: to_start, to_end, prev_session, next_session, prev_lap, next_lap, prev_incident, next_incident")


class CameraRequest(BaseModel):
    group_num: int = Field(..., ge=0, description="Camera group number from session info")
    car_idx: Optional[int] = Field(None, ge=0, description="CarIdx — switch by car index")
    position: Optional[int] = Field(None, ge=1, description="Race position — switch by position (1=leader)")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/status", response_model=IRacingStatusResponse)
async def get_iracing_status() -> IRacingStatusResponse:
    """Return current iRacing connection status and session summary."""
    session = bridge.session_data
    return IRacingStatusResponse(
        connected=bridge.is_connected,
        track_name=session.get("track_name", ""),
        session_type=session.get("session_type", ""),
        driver_count=len(session.get("drivers", [])),
        camera_count=len(session.get("cameras", [])),
    )


@router.get("/session", response_model=IRacingSessionResponse)
async def get_iracing_session() -> IRacingSessionResponse:
    """Return full session data including drivers and camera groups."""
    session = bridge.session_data
    return IRacingSessionResponse(
        connected=bridge.is_connected,
        track_name=session.get("track_name", ""),
        session_type=session.get("session_type", ""),
        avg_lap_time=session.get("avg_lap_time", 0.0),
        drivers=[Driver(**d) for d in session.get("drivers", [])],
        cameras=[CameraGroup(**c) for c in session.get("cameras", [])],
    )


@router.get("/cameras", response_model=list[CameraGroup])
async def get_cameras() -> list[CameraGroup]:
    """Return available camera groups for the current session."""
    cameras = bridge.session_data.get("cameras", [])
    return [CameraGroup(**c) for c in cameras]


@router.post("/replay/play")
async def replay_play() -> dict:
    """Play the replay at normal (1×) speed."""
    if not bridge.is_connected:
        raise HTTPException(status_code=409, detail="iRacing is not connected")
    success = bridge.set_replay_speed(1)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to play replay")
    return {"status": "ok", "speed": 1}


@router.post("/replay/pause")
async def replay_pause() -> dict:
    """Pause the replay."""
    if not bridge.is_connected:
        raise HTTPException(status_code=409, detail="iRacing is not connected")
    success = bridge.set_replay_speed(0)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to pause replay")
    return {"status": "ok", "speed": 0}


@router.post("/replay/seek")
async def replay_seek(body: SeekRequest) -> dict:
    """Seek the replay to a specific frame number."""
    if not bridge.is_connected:
        raise HTTPException(status_code=409, detail="iRacing is not connected")
    success = bridge.seek_to_frame(body.frame)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to seek replay")
    return {"status": "ok", "frame": body.frame}


@router.post("/replay/seek-time")
async def replay_seek_time(body: SeekTimeRequest) -> dict:
    """Seek the replay to a specific session number and time in milliseconds."""
    if not bridge.is_connected:
        raise HTTPException(status_code=409, detail="iRacing is not connected")
    success = bridge.replay_search_session_time(body.session_num, body.session_time_ms)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to seek replay to time")
    return {"status": "ok", "session_num": body.session_num, "session_time_ms": body.session_time_ms}


@router.post("/replay/speed")
async def replay_speed(body: SpeedRequest) -> dict:
    """
    Set replay playback speed.
    Positive values: 0=pause, 1, 2, 4, 8, 16 (forward).
    Negative values: -1, -2, -4, -8, -16 (rewind).
    """
    allowed = {-16, -8, -4, -2, -1, 0, 1, 2, 4, 8, 16}
    if body.speed not in allowed:
        raise HTTPException(
            status_code=422,
            detail=f"speed must be one of {sorted(allowed)}",
        )
    if not bridge.is_connected:
        raise HTTPException(status_code=409, detail="iRacing is not connected")
    success = bridge.set_replay_speed(body.speed)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to set replay speed")
    return {"status": "ok", "speed": body.speed}


@router.post("/replay/search")
async def replay_search(body: ReplaySearchRequest) -> dict:
    """Search the replay (next/prev incident, lap, session, or to start/end)."""
    import irsdk  # type: ignore[import]

    mode_map = {
        "to_start": irsdk.RpySrchMode.to_start,
        "to_end": irsdk.RpySrchMode.to_end,
        "prev_session": irsdk.RpySrchMode.prev_session,
        "next_session": irsdk.RpySrchMode.next_session,
        "prev_lap": irsdk.RpySrchMode.prev_lap,
        "next_lap": irsdk.RpySrchMode.next_lap,
        "prev_incident": irsdk.RpySrchMode.prev_incident,
        "next_incident": irsdk.RpySrchMode.next_incident,
    }
    mode = mode_map.get(body.mode)
    if mode is None:
        raise HTTPException(status_code=422, detail=f"Unknown mode: {body.mode}. Valid: {list(mode_map.keys())}")
    if not bridge.is_connected:
        raise HTTPException(status_code=409, detail="iRacing is not connected")
    success = bridge.replay_search(mode)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to search replay")
    return {"status": "ok", "mode": body.mode}


@router.get("/replay/state")
async def replay_state() -> dict:
    """Return the current replay state: frame, session_time, speed, car focus."""
    if not bridge.is_connected:
        raise HTTPException(status_code=409, detail="iRacing is not connected")
    snap = bridge.capture_snapshot()
    if not snap:
        return {"frame": 0, "session_time": 0.0, "session_num": 0}
    return {
        "frame": snap.get("replay_frame", 0),
        "session_time": round(snap.get("session_time", 0.0), 2),
        "session_num": snap.get("session_num", 0),
        "session_state": snap.get("session_state", 0),
        "cam_car_idx": snap.get("cam_car_idx", 0),
        "cam_group_num": snap.get("cam_group_num", 0),
        "race_laps": snap.get("race_laps", 0),
        "replay_speed": snap.get("replay_speed", 1),
    }


@router.get("/matching-projects")
async def matching_projects() -> dict:
    """Return project IDs whose stored session fingerprint matches the current iRacing session.

    Used by the project library to decorate the card for the currently-loaded replay.
    Returns:
        {
          "connected": bool,
          "subsession_id": int,
          "replay_playing": bool,
          "matching_project_ids": [int, ...],
        }
    """
    import json as _json
    import sqlite3 as _sqlite3

    if not bridge.is_connected:
        return {"connected": False, "subsession_id": 0, "replay_playing": False, "matching_project_ids": []}

    sd = bridge.session_data
    current_sub = int(sd.get("subsession_id", 0) or 0)
    current_track_id = int(sd.get("track_id", 0) or 0)
    current_track_name = (sd.get("track_name") or "").lower().strip()
    current_ids = set(sd.get("driver_cust_ids") or [])

    # Detect if replay is actively playing from the live telemetry snapshot
    snap = bridge.capture_snapshot()
    replay_speed = snap.get("replay_speed", 0) if snap else 0
    replay_playing = replay_speed != 0

    if not current_sub and not current_track_id:
        return {"connected": True, "subsession_id": 0, "replay_playing": replay_playing, "matching_project_ids": []}

    all_projects = project_service.list_projects()
    matching_ids: list[int] = []

    for proj in all_projects:
        proj_dir = proj.get("project_dir", "")
        if not proj_dir:
            continue
        try:
            db_path = f"{proj_dir}/analysis.db"
            conn = _sqlite3.connect(db_path, timeout=1)
            try:
                row = conn.execute(
                    "SELECT value FROM analysis_meta WHERE key = 'session_fingerprint'"
                ).fetchone()
            finally:
                conn.close()
        except Exception:
            continue

        if not row:
            continue

        try:
            fp = _json.loads(row[0])
        except Exception:
            continue

        stored_sub = int(fp.get("subsession_id", 0) or 0)
        # Exact: subsession ID match
        if current_sub and stored_sub and current_sub == stored_sub:
            matching_ids.append(proj["id"])
            continue

        # Fuzzy: same track + ≥75% driver overlap
        stored_track_id = int(fp.get("track_id", 0) or 0)
        stored_track_name = (fp.get("track_name") or "").lower().strip()
        track_match = (
            (current_track_id and stored_track_id and current_track_id == stored_track_id)
            or (current_track_name and stored_track_name and current_track_name == stored_track_name)
        )
        if track_match and current_ids:
            stored_ids = set(fp.get("driver_cust_ids") or [])
            if stored_ids:
                overlap = len(current_ids & stored_ids) / max(len(stored_ids), 1)
                if overlap >= 0.75:
                    matching_ids.append(proj["id"])

    return {
        "connected": True,
        "subsession_id": current_sub,
        "replay_playing": replay_playing,
        "matching_project_ids": matching_ids,
    }


@router.post("/replay/camera")
async def replay_camera(body: CameraRequest) -> dict:
    """
    Switch the replay camera.
    Supply either *car_idx* or *position* (not both).
    """
    if body.car_idx is None and body.position is None:
        raise HTTPException(
            status_code=422, detail="Provide either car_idx or position"
        )
    if body.car_idx is not None and body.position is not None:
        raise HTTPException(
            status_code=422, detail="Provide car_idx or position — not both"
        )
    if not bridge.is_connected:
        raise HTTPException(status_code=409, detail="iRacing is not connected")

    if body.car_idx is not None:
        success = bridge.cam_switch_car(body.car_idx, body.group_num)
        target = f"car_idx={body.car_idx}"
    else:
        success = bridge.cam_switch_position(body.position, body.group_num)  # type: ignore[arg-type]
        target = f"position={body.position}"

    if not success:
        raise HTTPException(status_code=500, detail="Failed to switch camera")
    return {"status": "ok", "group_num": body.group_num, "target": target}


@router.get("/windows")
async def list_windows() -> list[dict]:
    """Return visible windows for the manual capture-target picker."""
    from server.utils.window_capture import list_visible_windows

    return list_visible_windows()


@router.get("/capture-target")
async def get_capture_target() -> dict:
    """Return the current capture target (hwnd or 'auto')."""
    from server.utils.window_capture import get_capture_target as _get

    hwnd = _get()
    return {"mode": "manual" if hwnd else "auto", "hwnd": hwnd}


class CaptureTargetRequest(BaseModel):
    hwnd: int = Field(..., description="Window handle to capture")


@router.post("/capture-target")
async def set_capture_target_endpoint(body: CaptureTargetRequest) -> dict:
    """Set a manual capture target by window handle."""
    from server.utils.window_capture import set_capture_target

    set_capture_target(body.hwnd)
    return {"status": "ok", "mode": "manual", "hwnd": body.hwnd}


@router.delete("/capture-target")
async def reset_capture_target() -> dict:
    """Reset capture target to auto-detect iRacing window."""
    from server.utils.window_capture import set_capture_target

    set_capture_target(None)
    return {"status": "ok", "mode": "auto"}


@router.get("/screenshot")
async def iracing_screenshot() -> Response:
    """Capture a screenshot of the iRacing window and return as JPEG."""
    from server.utils.window_capture import capture_iracing_screenshot

    frame = capture_iracing_screenshot()
    if not frame:
        raise HTTPException(
            status_code=404,
            detail="iRacing window not found or minimised",
        )
    return Response(
        content=frame,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/stream")
async def iracing_stream(
    fps: int = 15,
    quality: int = 70,
    max_width: int = 1280,
    backend: str = "auto",
) -> StreamingResponse:
    """MJPEG video stream of the iRacing window via CaptureEngine.

    The CaptureEngine runs dedicated capture + encoder threads with
    automatic backend selection (dxcam → PrintWindow fallback).
    This endpoint serves the latest JPEG frame at the requested FPS.

    Client usage:
      <img src="/api/iracing/stream?fps=15&quality=70" />

    Query params:
      fps       — target frames per second (1–30, default 15)
      quality   — JPEG quality (10–95, default 70)
      max_width — max output width in px (320–1920, default 1280)
      backend   — "auto", "dxcam", or "printwindow" (default "auto")
    """
    from server.utils.capture_engine import capture_engine

    fps = max(1, min(fps, 30))
    quality = max(10, min(quality, 100))
    max_width = max(320, min(max_width, 3840))
    interval = 1.0 / fps

    logger.info("[Stream] MJPEG client connected (fps=%d quality=%d max_width=%d)",
                fps, quality, max_width)

    # Stop any running H.264/HLS consumers — they share _h264_queue and would
    # conflict with parameter changes.  MJPEG is independent (reads latest_jpeg).
    _stop_h264_consumers()

    # Start the engine if not already running, or live-update params if it is
    if not capture_engine.is_running:
        capture_engine.start(fps=fps, quality=quality, max_width=max_width)
    else:
        capture_engine.update_params(quality=quality, max_width=max_width, fps=fps)

    async def generate():
        boundary = b"--frame\r\n"
        try:
            while True:
                t0 = time.monotonic()
                frame = capture_engine.latest_jpeg
                if frame:
                    yield (
                        boundary
                        + b"Content-Type: image/jpeg\r\n"
                        + f"Content-Length: {len(frame)}\r\n".encode()
                        + b"\r\n"
                        + frame
                        + b"\r\n"
                    )
                elapsed = time.monotonic() - t0
                sleep_time = max(0.001, interval - elapsed)
                await asyncio.sleep(sleep_time)
        except asyncio.CancelledError:
            pass

    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.get("/stream/h264")
async def iracing_stream_h264(
    fps: int = 20,
    crf: int = 23,
    max_width: int = 1280,
) -> StreamingResponse:
    """H.264 fragmented-MP4 preview stream using the existing capture engine.

    Reuses the native WGC / dxcam capture pipeline — no second capture path.
    Frames flow: capture_engine (BGR numpy) → FFmpeg stdin (rawvideo) → libx264
    → fragmented MP4 → HTTP response → MSE player.

    The capture engine always runs at its current MJPEG resolution (max_width
    is never mutated here).  If max_width is smaller than the engine's current
    output, FFmpeg downscales via -vf scale.  This keeps both streams independent
    and prevents mid-stream dimension changes from causing bitstream corruption.

    Query params:
      fps       — target frames per second (1-30, default 20)
      crf       — H.264 CRF quality (0-51, lower=better, default 23)
      max_width — max H.264 output width (default 1280); never upscales beyond
                  the capture engine's current output resolution
    """
    from server.utils.capture_engine import capture_engine

    fps       = max(1, min(fps, 30))
    crf       = max(0, min(crf, 51))
    max_width = max(320, min(max_width, 3840))

    try:
        from server.utils.gpu_detection import find_ffmpeg
        ffmpeg = find_ffmpeg()
    except Exception:
        ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise HTTPException(status_code=503, detail="FFmpeg not found in PATH")

    logger.info("[Stream] H.264 client connected (fps=%d crf=%d max_width=%d)",
                fps, crf, max_width)

    # ── Mutual exclusion: stop any running HLS/H.264 consumer first ──
    _stop_h264_consumers()

    # Start the engine if it isn't running.
    # IMPORTANT: do NOT pass max_width here — H.264 must never mutate the
    # engine's output resolution, because that also changes the MJPEG stream
    # and invalidates the dimensions of any in-flight frames in the queue.
    # Instead we capture at whatever the engine is currently outputting and
    # let FFmpeg's -vf scale filter handle the desired output size.
    if not capture_engine.is_running:
        capture_engine.start(fps=fps, quality=85, max_width=1280)
    else:
        capture_engine.update_params(fps=fps)

    # Wait up to 5 s for the first frame so we know the engine output size
    loop = asyncio.get_running_loop()
    for _ in range(100):
        if capture_engine._out_w > 0 and capture_engine._out_h > 0:
            break
        await asyncio.sleep(0.05)
    if capture_engine._out_w == 0:
        raise HTTPException(status_code=503, detail="Capture engine has no frames yet")

    # Lock the input dimensions for this stream.  These must stay constant for
    # the lifetime of the FFmpeg process — if they ever deviate (race window
    # from a concurrent update_params call) the feeder discards mismatched frames.
    input_w = capture_engine._out_w & ~1
    input_h = capture_engine._out_h & ~1

    # Compute desired output dimensions.  Never upscale; cap to input size.
    # FFmpeg handles scaling internally so the Python pipeline stays dimension-stable.
    desired_w = min(max_width, input_w) & ~1
    desired_h = int(input_h * desired_w / input_w) & ~1

    scale_filter: list[str] = []
    if desired_w != input_w:
        scale_filter = ["-vf", f"scale={desired_w}:{desired_h}:flags=fast_bilinear"]

    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo",
        "-pixel_format", "bgr24",
        "-video_size", f"{input_w}x{input_h}",   # raw input size — never changes
        "-framerate", str(fps),
        "-i", "pipe:0",
        *scale_filter,                             # optional FFmpeg-side downscale
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-crf", str(crf),
        # Every frame is an IDR keyframe so frag_keyframe emits a new
        # fragment per frame instead of once per GOP (~12 s default).
        "-g", "1",
        "-keyint_min", "1",
        "-pix_fmt", "yuv420p",
        "-profile:v", "baseline",
        "-level:v", "4.0",
        "-f", "mp4",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "pipe:1",
    ]

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to start FFmpeg: {exc}")

    # Enable the capture engine's raw-frame feed queue; save the generation
    # token so our finally-block doesn't accidentally kill a newer stream that
    # started after us (e.g., the user quickly changes CRF/resolution).
    h264_gen = capture_engine.start_h264_feed()

    # Background thread: drain h264_queue → FFmpeg stdin
    import threading as _threading
    import time as _time
    state = {"active": True}

    def _feed_stdin():
        try:
            while state["active"]:
                # Self-exit if a newer stream has started — avoids the generation
                # token check only running in the finally path.
                if capture_engine._h264_gen != h264_gen:
                    break
                try:
                    frame = capture_engine._h264_queue.popleft()
                except IndexError:
                    _time.sleep(0.004)
                    continue
                # Dimension guard: drop any frame that doesn't match the size
                # FFmpeg was launched with.  This handles the brief race window
                # when the engine's max_width changes between two requests.
                if frame.shape[0] != input_h or frame.shape[1] != input_w:
                    # Resize to locked dims rather than dropping — the source
                    # resolution can fluctuate slightly (e.g. ±2 px on window
                    # resize) and dropping would make the stream choppy.
                    try:
                        import cv2 as _cv2_h264
                        frame = _cv2_h264.resize(
                            frame, (input_w, input_h),
                            interpolation=_cv2_h264.INTER_LINEAR,
                        )
                    except Exception:
                        continue  # cv2 unavailable or resize failed → skip
                if proc.stdin is None or proc.stdin.closed:
                    break
                try:
                    proc.stdin.write(frame.tobytes())
                except (BrokenPipeError, OSError):
                    break
        finally:
            try:
                proc.stdin.close()
            except Exception:
                logger.debug("Suppressed exception in cleanup", exc_info=True)

    feed_thread = _threading.Thread(target=_feed_stdin, daemon=True)
    feed_thread.start()

    async def generate():
        try:
            while True:
                chunk = await loop.run_in_executor(None, proc.stdout.read, 65536)
                if not chunk:
                    break
                yield chunk
        except asyncio.CancelledError:
            pass
        finally:
            state["active"] = False
            capture_engine.stop_h264_feed(h264_gen)
            try:
                proc.kill()
            except Exception:
                logger.debug("Suppressed exception in cleanup", exc_info=True)
            await loop.run_in_executor(None, proc.wait)

    return StreamingResponse(
        generate(),
        media_type="video/mp4",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.post("/stream/hls/stop")
async def hls_stop():
    """Stop the HLS segmenter and delete temporary segment files.

    Safe to call even when no HLS session is active.
    """
    def _stop() -> None:
        with _hls_lock:
            _stop_hls_session_locked()

    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _stop)
    return {"status": "stopped"}


@router.get("/stream/hls/{filename}")
async def hls_file(
    filename: str,
    fps: int = 15,
    crf: int = 23,
    max_width: int = 1280,
):
    """Serve HLS playlist and transport-stream segments.

    The browser (or hls.js) first fetches ``playlist.m3u8``.  On that request
    the backend starts (or restarts, if parameters changed) the FFmpeg HLS
    segmenter and waits up to 5 s for the first segment to be written.
    Subsequent segment requests (``seg*.ts``) are served directly from the
    temp directory.

    Query params (only used when requesting the playlist):
      fps       — target frames per second (1–30, default 15)
      crf       — H.264 CRF quality (0–51, lower=better, default 23)
      max_width — max output width in px (default 1280)

    Client usage::

        <video src="/api/iracing/stream/hls/playlist.m3u8?fps=15&crf=23" />
        // or via hls.js:
        hls.loadSource("/api/iracing/stream/hls/playlist.m3u8?fps=15&crf=23")
    """
    # Strictly validate filename: only allow 'playlist.m3u8' or 'seg#####.ts'
    # This rejects any path separators, dots, or other traversal characters.
    if not _SAFE_HLS_FILENAME_RE.match(filename):
        raise HTTPException(status_code=404, detail="Not found")

    try:
        from server.utils.gpu_detection import find_ffmpeg
        ffmpeg = find_ffmpeg()
    except Exception:
        ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise HTTPException(status_code=503, detail="FFmpeg not found in PATH")

    fps       = max(1, min(fps, 30))
    crf       = max(0, min(crf, 51))
    max_width = max(320, min(max_width, 3840))

    if filename == "playlist.m3u8":
        # Start (or restart on param change) the HLS segmenter
        def _ensure_session() -> pathlib.Path:
            with _hls_lock:
                needs_restart = (
                    not _hls_session["active"]
                    or _hls_session["fps"] != fps
                    or _hls_session["crf"] != crf
                    or _hls_session["max_width"] != max_width
                )
                if needs_restart:
                    return _start_hls_session_locked(ffmpeg, fps, crf, max_width)
                return pathlib.Path(_hls_session["tmpdir"])

        loop = asyncio.get_running_loop()
        tmpdir = await loop.run_in_executor(None, _ensure_session)
        playlist_path = tmpdir / "playlist.m3u8"

        # Wait up to 15 s for FFmpeg to write the first segment.
        # The extended timeout covers the case where the capture engine
        # starts up slowly (e.g. dxcam initialisation or backend fallback).
        for _ in range(150):
            if playlist_path.exists() and playlist_path.stat().st_size > 0:
                break
            # Bail early if FFmpeg process already died — no point waiting longer
            with _hls_lock:
                hls_proc = _hls_session.get("proc")
            if hls_proc is not None and hls_proc.poll() is not None:
                logger.error("[HLS] FFmpeg exited early (code %d) — check [HLS FFmpeg] log lines above",
                             hls_proc.returncode)
                raise HTTPException(
                    status_code=503,
                    detail=f"FFmpeg exited unexpectedly (code {hls_proc.returncode}) — see backend logs",
                )
            await asyncio.sleep(0.1)

        if not playlist_path.exists():
            raise HTTPException(status_code=503, detail="HLS playlist not ready yet")

        return FileResponse(
            str(playlist_path),
            media_type="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-cache"},
        )

    # Segment request — filename already validated as 'seg#####.ts' by the regex above
    with _hls_lock:
        tmpdir_str = _hls_session.get("tmpdir")

    if not tmpdir_str:
        raise HTTPException(status_code=404, detail="No active HLS session")

    # Build path from the validated filename (no separators possible after regex check)
    segment_path = pathlib.Path(tmpdir_str) / filename
    # Defense-in-depth: ensure the resolved path stays inside the HLS temp dir
    if not segment_path.resolve().is_relative_to(pathlib.Path(tmpdir_str).resolve()):
        raise HTTPException(status_code=400, detail="Invalid segment path")

    if not segment_path.exists():
        raise HTTPException(status_code=404, detail="Segment not found")

    return FileResponse(
        str(segment_path),
        media_type="video/mp2t",
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/stream/capabilities")
async def stream_capabilities():
    """Return availability status for all preview and capture backends.

    Used by the frontend to show which engines are installed and
    usable so the user can make an informed choice in Settings.

    Response shape::

        {
          "preview": {
            "native": {"available": bool, "exe_path": str|null, "description": str},
            "dxcam":  {"available": bool, "description": str},
            "printwindow": {"available": bool, "description": str}
          },
          "capture": {
            "native":     {"available": bool, "description": str},
            "obs":        {"available": bool, "process": str|null, "description": str},
            "shadowplay": {"available": bool, "process": str|null, "description": str},
            "relive":     {"available": bool, "process": str|null, "description": str},
            "manual":     {"available": true,  "description": str}
          }
        }
    """
    import platform as _platform

    # ── Preview engine availability ───────────────────────────────────────
    preview: dict = {}

    # Native C++ DXGI service
    try:
        from server.utils.native_capture_bridge import _find_native_exe
        native_exe = _find_native_exe()
        preview["native"] = {
            "available": native_exe is not None,
            "exe_path": str(native_exe) if native_exe else None,
            "description": (
                "C++ DXGI Desktop Duplication service — best performance, "
                "works regardless of window focus. Requires build-native.bat."
            ),
        }
    except Exception as exc:
        preview["native"] = {
            "available": False, "exe_path": None,
            "description": f"Native capture bridge error: {exc}",
        }

    # dxcam
    try:
        from server.utils.capture_engine import _dxcam_available
        preview["dxcam"] = {
            "available": _dxcam_available,
            "description": (
                "Python DXGI Desktop Duplication (dxcam library). "
                "Good performance. Requires dxcam + opencv-python-headless."
            ),
        }
    except Exception:
        preview["dxcam"] = {"available": False, "description": "dxcam not available"}

    # PrintWindow (always available on Windows, but unreliable for DX games)
    preview["printwindow"] = {
        "available": _platform.system() == "Windows",
        "description": (
            "Win32 GDI PrintWindow. Always available but returns black pixels "
            "for DirectX 11/12 games — use only as a last resort."
        ),
    }

    # ── Capture software availability ────────────────────────────────────
    capture: dict = {}

    # Native internal recording (piggybacks on the preview pipeline)
    try:
        from server.utils.native_capture_bridge import _find_native_exe as _native_exe_fn
        exe = _native_exe_fn()
        capture["native"] = {
            "available": exe is not None,
            "description": (
                "Internal capture via C++ DXGI service — zero-dependency "
                "recording with no external software required. "
                "Requires lrs_capture.exe (build-native.bat)."
            ),
        }
    except Exception:
        capture["native"] = {"available": False, "description": "Native not available"}

    # External capture software — detect by running process name.
    # subprocess.run blocks; offload to a thread so the event loop stays free.
    # Run tasklist once and check all three against the same output.
    if _platform.system() == "Windows":
        import subprocess

        def _tasklist_lower() -> str:
            try:
                result = subprocess.run(
                    ["tasklist", "/fo", "csv", "/nh"],
                    capture_output=True, text=True, timeout=3,
                )
                return result.stdout.lower()
            except Exception:
                return ""

        loop = asyncio.get_running_loop()
        tl_out = await loop.run_in_executor(None, _tasklist_lower)

        def _proc_running(names: list[str]) -> str | None:
            for name in names:
                if name.lower() in tl_out:
                    return name
            return None

        obs_proc      = _proc_running(["obs64.exe", "obs.exe", "obs32.exe"])
        capture["obs"] = {
            "available": True,  # always configurable even if not running
            "process_running": obs_proc is not None,
            "detected_process": obs_proc,
            "description": (
                "OBS Studio — full-featured capture software. "
                "Configure hotkeys in Settings → Camera Defaults."
            ),
        }

        sp_proc = _proc_running(["nvcontainer.exe", "shadowplay.exe", "nvsphelper64.exe"])
        capture["shadowplay"] = {
            "available": True,
            "process_running": sp_proc is not None,
            "detected_process": sp_proc,
            "description": (
                "NVIDIA ShadowPlay — low-overhead, hardware-accelerated capture. "
                "Requires GeForce Experience."
            ),
        }

        rl_proc = _proc_running(["relive.exe", "radeonsoftware.exe"])
        capture["relive"] = {
            "available": True,
            "process_running": rl_proc is not None,
            "detected_process": rl_proc,
            "description": "AMD ReLive — hardware capture for AMD GPUs.",
        }
    else:
        for key in ("obs", "shadowplay", "relive"):
            capture[key] = {
                "available": False, "process_running": False,
                "detected_process": None,
                "description": "Windows only",
            }

    capture["manual"] = {
        "available": True,
        "description": (
            "Manual capture — start/stop recording yourself. "
            "LRS will wait for you to provide the captured file."
        ),
    }

    return {"preview": preview, "capture": capture}


@router.get("/stream/metrics")
async def stream_metrics():
    """Return capture engine performance metrics."""
    from server.utils.capture_engine import capture_engine
    return capture_engine.metrics


@router.post("/stream/stop")
async def stream_stop():
    """Stop the capture engine (frees resources)."""
    from server.utils.capture_engine import capture_engine
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, capture_engine.stop)
    return {"status": "stopped"}


@router.post("/stream/reset")
async def stream_reset(
    fps: int = 15,
    quality: int = 70,
    max_width: int = 1280,
    backend: str = "auto",
):
    """Hard-reset the entire streaming pipeline.

    1. Kill all active H.264/HLS FFmpeg consumers and their feeder threads.
    2. Stop the capture engine completely (destroys the capture device handle
       and both capture + encoder threads).
    3. Wait briefly for OS resources to be released.
    4. Start a fresh engine with the supplied (or default) parameters.

    Returns the engine metrics dict so the client knows the new stream is live.
    All of this runs off-thread so the async event loop is never blocked.
    """
    from server.utils.capture_engine import capture_engine

    loop = asyncio.get_running_loop()

    def _do_reset():
        import time as _t
        # Step 1: kill all H.264/HLS consumers
        _stop_h264_consumers()
        # Step 2: stop and destroy the capture engine entirely
        capture_engine.stop()
        # Step 3: give the OS a moment to release the capture device handle
        _t.sleep(0.3)
        # Step 4: start a completely fresh engine
        capture_engine._backend_pref = backend
        capture_engine.start(fps=fps, quality=quality, max_width=max_width)

    await loop.run_in_executor(None, _do_reset)
    return {"status": "ok", **capture_engine.metrics}


@router.post("/stream/start")
async def stream_start(
    fps: int = 15,
    quality: int = 70,
    max_width: int = 1280,
    backend: str = "auto",
):
    """Start / restart the capture engine with given parameters."""
    from server.utils.capture_engine import capture_engine

    loop = asyncio.get_running_loop()
    if capture_engine.is_running:
        await loop.run_in_executor(None, capture_engine.stop)
    capture_engine._backend_pref = backend
    # start() spawns daemon threads and returns quickly; still offloaded to avoid
    # any incidental blocking (settings read, thread create) on the event loop.
    await loop.run_in_executor(
        None, lambda: capture_engine.start(fps=fps, quality=quality, max_width=max_width)
    )
    return capture_engine.metrics


class RecordStartRequest(BaseModel):
    """Request body for starting a recording."""
    output_path: str = Field(..., description="Path to the output video file")
    codec: str = Field("auto", description="FFmpeg codec or 'auto' for best GPU encoder")
    preset: str = Field("p4", description="Encoder preset")
    cq: int = Field(23, description="Constant quality (lower = higher quality)")
    mode: str = Field("auto", description="Recording mode: 'auto', 'gpu', or 'cpu'")


@router.post("/stream/record/start")
async def stream_record_start(req: RecordStartRequest):
    """Start recording to file with GPU-accelerated encoding.

    Supports two modes:
      - "gpu":  FFmpeg gdigrab captures directly -> NVENC (zero Python hot path).
      - "cpu":  Capture thread -> queue -> writer -> FFmpeg stdin pipe.
      - "auto": Tries GPU first, falls back to CPU.

    Requires the capture engine to be running first (via /stream or /stream/start).
    """
    from server.utils.capture_engine import capture_engine

    if not capture_engine.is_running:
        raise HTTPException(400, "Capture engine not running — start the stream first")
    try:
        return capture_engine.start_recording(
            output_path=req.output_path,
            codec=req.codec,
            preset=req.preset,
            cq=req.cq,
            mode=req.mode,
        )
    except RuntimeError as e:
        raise HTTPException(400, str(e))


@router.post("/stream/record/stop")
async def stream_record_stop():
    """Stop recording and finalise the output file."""
    from server.utils.capture_engine import capture_engine
    return capture_engine.stop_recording()
