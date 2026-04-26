"""Best-effort auto-refresh for vendored Tailwind runtime assets."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import time
import urllib.request
from pathlib import Path

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[3]
RUNTIME_PATH = ROOT / "backend" / "server" / "templates" / "_shared" / "tailwind.runtime.js"
META_PATH = ROOT / "backend" / "server" / "templates" / "_shared" / "tailwind.version.json"

REGISTRY_URL = "https://registry.npmjs.org/tailwindcss/latest"
RUNTIME_URL = "https://cdn.tailwindcss.com"
MAX_AGE_SECONDS = 60 * 60 * 24 * 7  # 7 days


def _http_get_text(url: str, timeout: int = 10) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "lrs-tailwind-autoupdate/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as response:  # noqa: S310
        return response.read().decode("utf-8")


def _write_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=path.parent) as tmp:
        tmp.write(content)
        tmp_path = Path(tmp.name)
    tmp_path.replace(path)


def _current_version() -> str | None:
    if not META_PATH.exists():
        return None
    try:
        meta = json.loads(META_PATH.read_text(encoding="utf-8"))
        version = str(meta.get("version", "")).strip()
        return version or None
    except Exception:  # noqa: BLE001
        return None


def _needs_refresh(now: float | None = None) -> bool:
    now = now or time.time()
    if not RUNTIME_PATH.exists() or not META_PATH.exists():
        return True
    age = now - RUNTIME_PATH.stat().st_mtime
    return age > MAX_AGE_SECONDS


def _refresh_sync() -> None:
    latest = json.loads(_http_get_text(REGISTRY_URL)).get("version", "")
    latest = str(latest).strip() or "unknown"
    runtime = _http_get_text(RUNTIME_URL)
    if "tailwind" not in runtime.lower():
        raise RuntimeError("Downloaded Tailwind runtime looked invalid")

    _write_atomic(RUNTIME_PATH, runtime)
    _write_atomic(
        META_PATH,
        json.dumps(
            {
                "package": "tailwindcss",
                "version": latest,
                "source": RUNTIME_URL,
                "updated_at": int(time.time()),
            },
            indent=2,
        )
        + "\n",
    )


async def startup_refresh() -> None:
    """Refresh vendored Tailwind runtime in the background when stale.

    Controlled with env var:
      LRS_TAILWIND_AUTO_UPDATE=0  -> disabled
    """
    if os.getenv("LRS_TAILWIND_AUTO_UPDATE", "1") in {"0", "false", "False"}:
        logger.info("[Tailwind] Auto-update disabled")
        return

    if not _needs_refresh():
        logger.debug("[Tailwind] Runtime is fresh (%s)", _current_version() or "unknown")
        return

    try:
        await asyncio.to_thread(_refresh_sync)
        logger.info("[Tailwind] Runtime updated to %s", _current_version() or "unknown")
    except Exception as exc:  # noqa: BLE001
        logger.warning("[Tailwind] Auto-update failed (continuing with existing assets): %s", exc)
