"""
api_analysis.py
---------------
REST endpoints for the replay analysis engine.

  POST /api/projects/{id}/analyze      — Start analysis
  POST /api/projects/{id}/analyze/cancel — Cancel running analysis
  GET  /api/projects/{id}/analysis/status — Get analysis status
  GET  /api/projects/{id}/events       — List detected events
  GET  /api/projects/{id}/events/summary — Event count summary by type
  PUT  /api/projects/{id}/events/{eid} — Update an event
  DELETE /api/projects/{id}/events/{eid} — Delete an event
  POST /api/projects/{id}/events/{eid}/split — Split an event at a timestamp
  GET  /api/projects/{id}/analysis/race-duration — Get total race duration
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from server.services.project_service import project_service
from server.services.replay_analysis import analysis_manager
from server.services.analysis_db import (
    get_project_db,
    init_analysis_db,
    get_events,
    count_events,
    get_analysis_status as db_get_analysis_status,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["analysis"])

# ── WebSocket broadcaster (set by app.py at startup) ─────────────────────────
_broadcast_fn: Any = None


def set_broadcast_fn(fn: Any) -> None:
    """Set the WebSocket broadcast function (called from app.py)."""
    global _broadcast_fn
    _broadcast_fn = fn


def _on_progress(event_type: str, data: dict) -> None:
    """Broadcast analysis progress to WebSocket clients."""
    if _broadcast_fn is not None:
        message = {"event": f"pipeline:{event_type}", "data": data}
        try:
            _broadcast_fn(message)
        except Exception as exc:
            logger.debug("[Analysis API] Broadcast error: %s", exc)


# ── Request/Response models ──────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    """Optional parameters for starting analysis."""
    battle_gap_threshold: Optional[float] = None
    force_rescan: bool = False


class EventsResponse(BaseModel):
    """Response for event listing."""
    events: list[dict]
    total: int
    skip: int
    limit: int


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/analyze")
async def start_analysis(project_id: int, body: AnalyzeRequest | None = None):
    """Start replay analysis for a project.

    If analysis is already running, returns 409 Conflict.
    If iRacing is not connected, falls back to mock analysis.
    """
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if analysis_manager.is_running(project_id):
        raise HTTPException(
            status_code=409,
            detail="Analysis is already running for this project",
        )

    project_dir = project["project_dir"]

    # Build session info from project + bridge
    from server.services.iracing_bridge import bridge as iracing_bridge
    session_info = dict(iracing_bridge.session_data) if iracing_bridge.is_connected else {}
    if body and body.battle_gap_threshold is not None:
        session_info["battle_gap_threshold"] = body.battle_gap_threshold

    # Start background analysis
    started = analysis_manager.start(
        project_id=project_id,
        project_dir=project_dir,
        session_info=session_info,
        on_progress=_on_progress,
    )

    if not started:
        raise HTTPException(status_code=500, detail="Failed to start analysis")

    # Advance project to analysis step
    try:
        project_service.update_project(project_id, {"current_step": "analysis"})
    except Exception:
        pass  # Non-critical — don't fail the analysis

    logger.info("[Analysis API] Started analysis for project #%d", project_id)
    return {"status": "started", "project_id": project_id}


@router.post("/projects/{project_id}/analyze/cancel")
async def cancel_analysis(project_id: int):
    """Cancel a running analysis."""
    if not analysis_manager.is_running(project_id):
        raise HTTPException(status_code=404, detail="No running analysis for this project")

    analysis_manager.cancel(project_id)
    logger.info("[Analysis API] Cancelled analysis for project #%d", project_id)
    return {"status": "cancelled", "project_id": project_id}


@router.get("/projects/{project_id}/analysis/status")
async def get_analysis_status(project_id: int):
    """Get the current analysis status for a project."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Check if actively running
    if analysis_manager.is_running(project_id):
        return {"status": "running", "project_id": project_id}

    # Check database for most recent run
    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            db_status = db_get_analysis_status(conn)
            db_status["project_id"] = project_id
            return db_status
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("[Analysis API] Status check error: %s", exc)
        return {"status": "none", "project_id": project_id}


@router.get("/projects/{project_id}/events")
async def list_events(
    project_id: int,
    event_type: str = Query("", description="Filter by event type"),
    min_severity: int = Query(0, ge=0, le=10, description="Minimum severity"),
    skip: int = Query(0, ge=0, description="Offset for pagination"),
    limit: int = Query(200, ge=1, le=1000, description="Max events to return"),
):
    """List detected race events for a project."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            events = get_events(
                conn,
                event_type=event_type,
                min_severity=min_severity,
                skip=skip,
                limit=limit,
            )
            total = count_events(conn, event_type=event_type)
            return {
                "events": events,
                "total": total,
                "skip": skip,
                "limit": limit,
            }
        finally:
            conn.close()
    except Exception as exc:
        logger.error("[Analysis API] Event list error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/projects/{project_id}/events/summary")
async def event_summary(project_id: int):
    """Get a summary of detected events grouped by type."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            rows = conn.execute("""
                SELECT event_type, COUNT(*) AS count,
                       AVG(severity) AS avg_severity,
                       SUM(end_time_seconds - start_time_seconds) AS total_duration
                FROM race_events
                GROUP BY event_type
                ORDER BY count DESC
            """).fetchall()
            summary = [
                {
                    "event_type": r["event_type"],
                    "count": r["count"],
                    "avg_severity": round(r["avg_severity"], 1) if r["avg_severity"] else 0,
                    "total_duration": round(r["total_duration"], 1) if r["total_duration"] else 0,
                }
                for r in rows
            ]
            total = sum(s["count"] for s in summary)
            return {
                "project_id": project_id,
                "total_events": total,
                "by_type": summary,
            }
        finally:
            conn.close()
    except Exception as exc:
        logger.error("[Analysis API] Event summary error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ── Event editing endpoints (Feature 8: Timeline Editor) ─────────────────────

class EventUpdateRequest(BaseModel):
    """Fields that can be updated on an event."""
    start_time_seconds: Optional[float] = None
    end_time_seconds: Optional[float] = None
    start_frame: Optional[int] = None
    end_frame: Optional[int] = None
    severity: Optional[int] = None
    event_type: Optional[str] = None
    included_in_highlight: Optional[bool] = None


class EventSplitRequest(BaseModel):
    """Split point for dividing an event into two."""
    split_time: float


@router.put("/projects/{project_id}/events/{event_id}")
async def update_event(project_id: int, event_id: int, body: EventUpdateRequest):
    """Update a race event (e.g., drag-resize on timeline)."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        conn = get_project_db(project_dir)
        try:
            # Verify event exists
            row = conn.execute(
                "SELECT id FROM race_events WHERE id = ?", (event_id,)
            ).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Event not found")

            # Build dynamic SET clause from provided fields
            updates: list[str] = []
            params: list[Any] = []
            if body.start_time_seconds is not None:
                updates.append("start_time_seconds = ?")
                params.append(body.start_time_seconds)
            if body.end_time_seconds is not None:
                updates.append("end_time_seconds = ?")
                params.append(body.end_time_seconds)
            if body.start_frame is not None:
                updates.append("start_frame = ?")
                params.append(body.start_frame)
            if body.end_frame is not None:
                updates.append("end_frame = ?")
                params.append(body.end_frame)
            if body.severity is not None:
                updates.append("severity = ?")
                params.append(max(0, min(10, body.severity)))
            if body.event_type is not None:
                updates.append("event_type = ?")
                params.append(body.event_type)
            if body.included_in_highlight is not None:
                updates.append("included_in_highlight = ?")
                params.append(1 if body.included_in_highlight else 0)

            if not updates:
                raise HTTPException(status_code=400, detail="No fields to update")

            # Always mark as user-modified
            updates.append("user_modified = 1")
            params.append(event_id)

            conn.execute(
                f"UPDATE race_events SET {', '.join(updates)} WHERE id = ?",
                params,
            )
            conn.commit()

            # Return updated event
            updated = conn.execute(
                "SELECT * FROM race_events WHERE id = ?", (event_id,)
            ).fetchone()
            d = dict(updated)
            try:
                d["involved_drivers"] = json.loads(d.get("involved_drivers", "[]"))
            except (json.JSONDecodeError, TypeError):
                d["involved_drivers"] = []
            try:
                d["metadata"] = json.loads(d.get("metadata", "{}"))
            except (json.JSONDecodeError, TypeError):
                d["metadata"] = {}

            logger.info("[Analysis API] Updated event #%d", event_id)
            return d
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[Analysis API] Event update error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/projects/{project_id}/events/{event_id}")
async def delete_event(project_id: int, event_id: int):
    """Delete a race event."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        conn = get_project_db(project_dir)
        try:
            row = conn.execute(
                "SELECT id FROM race_events WHERE id = ?", (event_id,)
            ).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Event not found")

            conn.execute("DELETE FROM race_events WHERE id = ?", (event_id,))
            conn.commit()
            logger.info("[Analysis API] Deleted event #%d", event_id)
            return {"status": "deleted", "event_id": event_id}
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[Analysis API] Event delete error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/projects/{project_id}/events/{event_id}/split")
async def split_event(project_id: int, event_id: int, body: EventSplitRequest):
    """Split a race event into two at the given timestamp.

    The original event keeps times [start, split_time] and a new event
    is created for [split_time, end].
    """
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        conn = get_project_db(project_dir)
        try:
            row = conn.execute(
                "SELECT * FROM race_events WHERE id = ?", (event_id,)
            ).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Event not found")

            original = dict(row)
            split_t = body.split_time

            if split_t <= original["start_time_seconds"] or split_t >= original["end_time_seconds"]:
                raise HTTPException(
                    status_code=400,
                    detail="Split time must be between event start and end",
                )

            # Estimate split frame (linear interpolation)
            total_time = original["end_time_seconds"] - original["start_time_seconds"]
            frac = (split_t - original["start_time_seconds"]) / total_time if total_time > 0 else 0.5
            split_frame = int(
                original["start_frame"] + frac * (original["end_frame"] - original["start_frame"])
            )

            # Update original: shrink to [start, split_time]
            conn.execute(
                """UPDATE race_events
                   SET end_time_seconds = ?, end_frame = ?, user_modified = 1
                   WHERE id = ?""",
                (split_t, split_frame, event_id),
            )

            # Insert new event: [split_time, end]
            cursor = conn.execute(
                """INSERT INTO race_events
                   (event_type, start_time_seconds, end_time_seconds, start_frame, end_frame,
                    lap_number, severity, involved_drivers, position,
                    auto_detected, user_modified, included_in_highlight, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)""",
                (
                    original["event_type"],
                    split_t,
                    original["end_time_seconds"],
                    split_frame,
                    original["end_frame"],
                    original["lap_number"],
                    original["severity"],
                    original["involved_drivers"],
                    original["position"],
                    original["included_in_highlight"],
                    original["metadata"],
                ),
            )
            new_id = cursor.lastrowid
            conn.commit()

            logger.info("[Analysis API] Split event #%d at %.1fs → new event #%d", event_id, split_t, new_id)
            return {
                "status": "split",
                "original_id": event_id,
                "new_id": new_id,
                "split_time": split_t,
            }
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[Analysis API] Event split error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/projects/{project_id}/analysis/race-duration")
async def get_race_duration(project_id: int):
    """Get the total race duration from the analysis data."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project["project_dir"]
    try:
        init_analysis_db(project_dir)
        conn = get_project_db(project_dir)
        try:
            row = conn.execute(
                "SELECT MAX(session_time) AS max_time, MAX(replay_frame) AS max_frame FROM race_ticks"
            ).fetchone()
            max_time = row["max_time"] if row and row["max_time"] else 0
            max_frame = row["max_frame"] if row and row["max_frame"] else 0
            return {
                "project_id": project_id,
                "duration_seconds": max_time,
                "total_frames": max_frame,
            }
        finally:
            conn.close()
    except Exception as exc:
        logger.error("[Analysis API] Race duration error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
