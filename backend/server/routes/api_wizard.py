"""
Wizard API — first-run setup wizard endpoints.
"""

import shutil
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from server.services.settings_service import settings_service
from server.utils.gpu_detection import detect_gpus

router = APIRouter(prefix="/api/wizard", tags=["wizard"])


class CompleteBody(BaseModel):
    settings: dict[str, Any] = {}


@router.get("/status")
async def wizard_status():
    """Return whether the setup wizard has been completed."""
    cfg = settings_service.get_all()
    return {"completed": bool(cfg.get("wizard_completed", False))}


@router.post("/complete")
async def wizard_complete(body: CompleteBody):
    """Save wizard settings and mark the wizard as completed."""
    updates = {**body.settings, "wizard_completed": True}
    updated = settings_service.update(updates)
    return {"success": True, "settings": updated}


@router.get("/detect")
async def wizard_detect():
    """Auto-detect iRacing directories, capture software, and GPU."""
    # ── iRacing directory detection ──────────────────────────────────────
    home = Path.home()
    candidate_dirs = [
        home / "Documents" / "iRacing" / "replays",
        home / "Documents" / "iRacing" / "clips",
        Path("C:/Users/Public/Documents/iRacing/replays"),
    ]
    iracing_dirs = [str(d) for d in candidate_dirs if d.exists()]

    # ── Capture software detection ───────────────────────────────────────
    capture_software_found: list[str] = []

    obs_executables = ["obs64.exe", "obs.exe", "obs-studio"]
    if any(shutil.which(exe) for exe in obs_executables):
        capture_software_found.append("obs")

    shadowplay_path = Path(
        "C:/Program Files/NVIDIA Corporation/ShadowPlay/nvsphelper64.exe"
    )
    if shadowplay_path.exists():
        capture_software_found.append("shadowplay")

    capture_software = capture_software_found[0] if capture_software_found else "obs"

    # ── GPU detection ────────────────────────────────────────────────────
    gpu_info = detect_gpus()

    return {
        "iracing_dirs": iracing_dirs,
        "capture_software": capture_software,
        "capture_software_found": capture_software_found,
        "gpu": gpu_info,
        "recommended_preset": "youtube_1080p60",
    }
