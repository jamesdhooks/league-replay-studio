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
import shutil
import subprocess
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from server.services.iracing_bridge import bridge

router = APIRouter(prefix="/api/iracing", tags=["iracing"])


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
        "race_laps": snap.get("race_laps", 0),
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
    """H.264 fragmented-MP4 preview stream via FFmpeg gdigrab.

    Streams low-latency H.264 fMP4 suitable for MediaSource Extensions.
    gdigrab captures the iRacing window region directly — no Python frame
    copies in the hot path.

    Query params:
      fps       — target frames per second (1-30, default 20)
      crf       — H.264 CRF quality (0-51, lower=better, default 23)
      max_width — max output width in px (default 1280)
    """
    from server.utils.window_capture import _find_iracing_hwnd, _get_window_rect

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

    hwnd = _find_iracing_hwnd()
    if hwnd is None:
        raise HTTPException(status_code=404, detail="iRacing window not found")
    rect = _get_window_rect(hwnd)
    if not rect:
        raise HTTPException(status_code=404, detail="Cannot get window rect")

    x = rect["left"]
    y = rect["top"]
    w = rect["width"]  & ~1
    h = rect["height"] & ~1
    if w < 100 or h < 100:
        raise HTTPException(status_code=400, detail="Window too small")

    scale_w = min(max_width, w) & ~1

    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error",
        "-f", "gdigrab",
        "-framerate", str(fps),
        "-offset_x", str(x),
        "-offset_y", str(y),
        "-video_size", f"{w}x{h}",
        "-i", "desktop",
        "-vf", f"scale={scale_w}:-2",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-profile:v", "baseline",
        "-level:v", "4.0",
        "-f", "mp4",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "pipe:1",
    ]

    loop = asyncio.get_running_loop()
    try:
        proc = await loop.run_in_executor(
            None,
            lambda: subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
            ),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to start FFmpeg: {exc}")

    # Brief sanity check — if FFmpeg dies immediately it means gdigrab failed
    await asyncio.sleep(0.4)
    if proc.poll() is not None:
        err = b""
        if proc.stderr:
            try:
                err = proc.stderr.read(512)
            except Exception:
                pass
        raise HTTPException(
            status_code=500,
            detail=f"FFmpeg/gdigrab failed: {err.decode(errors='replace')}",
        )

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
            try:
                proc.kill()
                proc.wait()
            except Exception:
                pass

    return StreamingResponse(
        generate(),
        media_type="video/mp4",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
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
