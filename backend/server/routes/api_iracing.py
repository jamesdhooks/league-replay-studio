"""
api_iracing.py
--------------
REST endpoints for iRacing connection and replay control.

GET  /api/iracing/status              — connection status + session summary
GET  /api/iracing/session             — full session data (drivers, track, etc.)
GET  /api/iracing/cameras             — available camera groups
POST /api/iracing/replay/play         — play replay at 1× speed
POST /api/iracing/replay/pause        — pause replay
POST /api/iracing/replay/seek         — seek to specific frame
POST /api/iracing/replay/speed        — set replay speed (1/2/4/8/16)
POST /api/iracing/replay/camera       — switch camera to car / position
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
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


class SpeedRequest(BaseModel):
    speed: int = Field(..., description="Replay speed: 0=pause, 1=normal, 2/4/8/16")


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


@router.post("/replay/speed")
async def replay_speed(body: SpeedRequest) -> dict:
    """
    Set replay playback speed.
    Allowed values: 0 (pause), 1, 2, 4, 8, 16.
    """
    allowed = {0, 1, 2, 4, 8, 16}
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
