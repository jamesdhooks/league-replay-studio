"""
api_career_stats.py
-------------------
REST endpoints for the career-stats hydration system.

Prefix: /api/career-stats
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from server.services.career_stats_service import CareerStatsService

router = APIRouter(prefix="/api/career-stats", tags=["career-stats"])

# ---------------------------------------------------------------------------
# Dependency — callers must wire this before mounting the router.
# e.g.  router.dependency_overrides[get_service] = lambda: my_service_instance
# ---------------------------------------------------------------------------

_service_instance: Optional[CareerStatsService] = None


def set_service(service: CareerStatsService) -> None:
    """Wire the shared service singleton (called from app.py lifespan)."""
    global _service_instance
    _service_instance = service


def get_service() -> CareerStatsService:
    if _service_instance is None:
        raise RuntimeError("CareerStatsService not initialised — call set_service() first")
    return _service_instance


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class EnqueueRequest(BaseModel):
    cust_ids: list[int]


class EnqueueResponse(BaseModel):
    enqueued: int


class QueueDepthResponse(BaseModel):
    total: int
    pending_hydration: int
    stale: int


class CareerStatsResponse(BaseModel):
    cust_id: int
    display_name: Optional[str] = None
    oval_irating: Optional[int] = None
    road_irating: Optional[int] = None
    dirt_oval_irating: Optional[int] = None
    dirt_road_irating: Optional[int] = None
    oval_sr: Optional[int] = None
    road_sr: Optional[int] = None
    dirt_oval_sr: Optional[int] = None
    dirt_road_sr: Optional[int] = None
    license_class: Optional[str] = None
    license_level: Optional[int] = None
    total_starts: Optional[int] = None
    total_wins: Optional[int] = None
    total_top5: Optional[int] = None
    total_poles: Optional[int] = None
    total_laps_led: Optional[int] = None
    hydration_count: int = 0
    last_updated: Optional[str] = None
    created_at: Optional[str] = None

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/queue", response_model=QueueDepthResponse)
async def get_queue_depth(service: CareerStatsService = Depends(get_service)) -> QueueDepthResponse:
    """Return the current hydration queue depth."""
    return QueueDepthResponse(**service.queue_depth())


@router.post("/enqueue", response_model=EnqueueResponse, status_code=201)
async def enqueue_drivers(
    body: EnqueueRequest,
    service: CareerStatsService = Depends(get_service),
) -> EnqueueResponse:
    """
    Register iRacing customer IDs for career-stats hydration.

    Drivers already in the database are silently skipped; their existing
    hydration state (hydration_count / last_updated) is preserved.
    """
    if not body.cust_ids:
        return EnqueueResponse(enqueued=0)
    inserted = service.enqueue(body.cust_ids)
    return EnqueueResponse(enqueued=inserted)


@router.get("/stats", response_model=list[CareerStatsResponse])
async def list_career_stats(
    limit: int = 100,
    offset: int = 0,
    service: CareerStatsService = Depends(get_service),
) -> list[CareerStatsResponse]:
    """
    List all tracked drivers ordered by hydration priority
    (never-hydrated → least-hydrated → oldest snapshot).
    """
    rows = service.list_stats(limit=limit, offset=offset)
    return [CareerStatsResponse(**r) for r in rows]


@router.get("/stats/{cust_id}", response_model=CareerStatsResponse)
async def get_career_stats(
    cust_id: int,
    service: CareerStatsService = Depends(get_service),
) -> CareerStatsResponse:
    """Return the stored career stats for a single driver."""
    row = service.get_stats(cust_id)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail={"error": "driver_not_found", "message": f"No career stats found for cust_id {cust_id}"},
        )
    return CareerStatsResponse(**row)


@router.post("/stats/{cust_id}/hydrate", response_model=CareerStatsResponse)
async def force_hydrate(
    cust_id: int,
    service: CareerStatsService = Depends(get_service),
) -> CareerStatsResponse:
    """
    Force an immediate hydration for a single driver, bypassing the normal
    queue order.  Useful for on-demand stat refresh from the UI.
    """
    # Ensure the driver is tracked before hydrating
    service.enqueue([cust_id])
    success = await service.hydrate(cust_id)
    if not success:
        raise HTTPException(
            status_code=502,
            detail={"error": "hydration_failed", "message": f"Failed to fetch career stats for cust_id {cust_id}"},
        )
    row = service.get_stats(cust_id)
    if row is None:
        raise HTTPException(
            status_code=500,
            detail={"error": "internal_error", "message": "Database inconsistency: stats missing after successful hydration"},
        )
    return CareerStatsResponse(**row)
