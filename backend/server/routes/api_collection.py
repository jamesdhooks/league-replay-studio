"""
api_collection.py
-----------------
REST endpoints for the live telemetry collection feature.

Routes
------
  POST   /api/collection/start              — start collecting
  POST   /api/collection/stop               — stop collecting
  GET    /api/collection/status             — current run status
  GET    /api/collection/files              — list all collection files
  GET    /api/collection/files/{filename}   — single file metadata
  GET    /api/collection/files/{filename}/catalog   — variable catalog
  GET    /api/collection/files/{filename}/ticks     — paginated tick data
  DELETE /api/collection/files/{filename}   — delete a collection file
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from server.services.collection_service import collection_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/collection", tags=["collection"])


# ── Request models ────────────────────────────────────────────────────────────

class StartRequest(BaseModel):
    name: Optional[str] = None
    hz:   int = 4


# ── Control endpoints ─────────────────────────────────────────────────────────

@router.post("/start")
def start_collection(body: StartRequest):
    """Start a new live telemetry collection session."""
    result = collection_service.start(name=body.name, hz=body.hz)
    if "error" in result:
        raise HTTPException(status_code=409, detail=result["error"])
    return result


@router.post("/stop")
def stop_collection():
    """Stop the active collection session and finalise the file."""
    result = collection_service.stop()
    if "error" in result:
        raise HTTPException(status_code=409, detail=result["error"])
    return result


@router.get("/status")
def get_status():
    """Return current collection status."""
    return collection_service.status()


# ── File browser endpoints ────────────────────────────────────────────────────

@router.get("/files")
def list_files():
    """Return a list of all saved collection files, newest first."""
    return {"files": collection_service.list_collections()}


@router.get("/files/{filename}")
def get_file_info(filename: str):
    """Return metadata for a specific collection file."""
    info = collection_service.get_collection_info(filename)
    if info is None:
        raise HTTPException(status_code=404, detail="Collection file not found")
    return info


@router.get("/files/{filename}/catalog")
def get_catalog(filename: str):
    """Return the variable catalog (all available telemetry variables) for a file."""
    catalog = collection_service.get_catalog(filename)
    if catalog is None:
        raise HTTPException(status_code=404, detail="Collection file not found")
    return {"catalog": catalog}


@router.get("/files/{filename}/ticks")
def get_ticks(
    filename: str,
    offset: int = Query(0, ge=0),
    limit:  int = Query(200, ge=1, le=1000),
    vars:   Optional[str] = Query(None, description="Comma-separated list of variable names to include"),
):
    """Return paginated tick data.

    Use ``vars`` to request a subset of variables (comma-separated names).
    If omitted, the full data blob for each tick is returned.
    """
    var_list: list[str] | None = None
    if vars:
        var_list = [v.strip() for v in vars.split(",") if v.strip()]

    result = collection_service.get_ticks(filename, offset=offset, limit=limit, vars=var_list)
    if result is None:
        raise HTTPException(status_code=404, detail="Collection file not found")
    return result


@router.delete("/files/{filename}")
def delete_file(filename: str):
    """Permanently delete a collection file."""
    ok = collection_service.delete_collection(filename)
    if not ok:
        raise HTTPException(status_code=404, detail="Collection file not found")
    return {"deleted": filename}
