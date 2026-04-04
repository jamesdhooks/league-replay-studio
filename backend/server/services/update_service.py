"""
update_service.py
-----------------
Auto-update check service for League Replay Studio.

Checks for new releases via the GitHub Releases API (or a custom
update endpoint) and exposes the result to the frontend via the
``/api/system/update-check`` endpoint.

Architecture
~~~~~~~~~~~~
- Runs an async check on app startup (after 10s delay)
- Caches the result for 1 hour
- Frontend polls or checks on-demand via the API endpoint
- No automatic download/install — shows notification with release link

Configuration
~~~~~~~~~~~~~
- ``update_check_enabled``: Enable/disable auto-update checks (default: True)
- ``update_check_url``: Custom URL for update checks (default: GitHub API)
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Optional

import httpx

from version import __version__

logger = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────────

# Default: check GitHub Releases for this repository
_DEFAULT_UPDATE_URL = (
    "https://api.github.com/repos/jamesdhooks/league-replay-studio/releases/latest"
)
_CHECK_INTERVAL = 3600  # 1 hour cache
_HTTP_TIMEOUT = 10.0  # seconds


# ── Update check result ─────────────────────────────────────────────────────

class UpdateInfo:
    """Result of an update check."""

    def __init__(
        self,
        *,
        current_version: str,
        latest_version: str | None = None,
        update_available: bool = False,
        release_url: str | None = None,
        release_notes: str | None = None,
        error: str | None = None,
        checked_at: float = 0,
    ):
        self.current_version = current_version
        self.latest_version = latest_version
        self.update_available = update_available
        self.release_url = release_url
        self.release_notes = release_notes
        self.error = error
        self.checked_at = checked_at

    def to_dict(self) -> dict[str, Any]:
        return {
            "current_version": self.current_version,
            "latest_version": self.latest_version,
            "update_available": self.update_available,
            "release_url": self.release_url,
            "release_notes": self.release_notes,
            "error": self.error,
            "checked_at": self.checked_at,
        }


# ── Version comparison ──────────────────────────────────────────────────────

def _parse_version(version_str: str) -> tuple[int, ...]:
    """Parse a version string like '0.1.0' or 'v0.2.1' into a comparable tuple."""
    cleaned = version_str.lstrip("vV").strip()
    parts = []
    for part in cleaned.split("."):
        # Handle pre-release suffixes like '1.0.0-beta.1'
        numeric = ""
        for ch in part:
            if ch.isdigit():
                numeric += ch
            else:
                break
        parts.append(int(numeric) if numeric else 0)
    return tuple(parts)


def _is_newer(latest: str, current: str) -> bool:
    """Check if latest version is newer than current."""
    try:
        return _parse_version(latest) > _parse_version(current)
    except (ValueError, TypeError):
        return False


# ── Service ──────────────────────────────────────────────────────────────────

class UpdateService:
    """Manages update checks with caching."""

    def __init__(self) -> None:
        self._cached: Optional[UpdateInfo] = None
        self._checking = False

    @property
    def cached_info(self) -> Optional[UpdateInfo]:
        """Return cached update info if still fresh."""
        if self._cached and (time.time() - self._cached.checked_at) < _CHECK_INTERVAL:
            return self._cached
        return None

    async def check_for_updates(
        self, *, force: bool = False, update_url: str | None = None
    ) -> UpdateInfo:
        """Check for updates via the GitHub Releases API.

        Args:
            force: Bypass cache and check immediately.
            update_url: Override the default update check URL.

        Returns:
            UpdateInfo with the check result.
        """
        # Return cached if fresh
        if not force and self.cached_info:
            return self.cached_info

        if self._checking:
            # Already checking — return whatever we have
            return self._cached or UpdateInfo(current_version=__version__)

        self._checking = True
        url = update_url or _DEFAULT_UPDATE_URL

        try:
            logger.info("[UpdateService] Checking for updates at %s", url)
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
                response = await client.get(
                    url,
                    headers={
                        "Accept": "application/vnd.github.v3+json",
                        "User-Agent": f"LeagueReplayStudio/{__version__}",
                    },
                )

            if response.status_code == 404:
                # No releases yet
                self._cached = UpdateInfo(
                    current_version=__version__,
                    checked_at=time.time(),
                )
                return self._cached

            response.raise_for_status()
            data = response.json()

            latest_tag = data.get("tag_name", "")
            html_url = data.get("html_url", "")
            body = data.get("body", "")

            is_newer = _is_newer(latest_tag, __version__)

            self._cached = UpdateInfo(
                current_version=__version__,
                latest_version=latest_tag,
                update_available=is_newer,
                release_url=html_url if is_newer else None,
                release_notes=body[:500] if is_newer and body else None,
                checked_at=time.time(),
            )

            if is_newer:
                logger.info(
                    "[UpdateService] Update available: %s → %s",
                    __version__,
                    latest_tag,
                )
            else:
                logger.info("[UpdateService] Running latest version: %s", __version__)

            return self._cached

        except httpx.HTTPStatusError as exc:
            logger.warning(
                "[UpdateService] HTTP error checking updates: %s",
                exc.response.status_code,
            )
            self._cached = UpdateInfo(
                current_version=__version__,
                error=f"HTTP {exc.response.status_code}",
                checked_at=time.time(),
            )
            return self._cached

        except Exception as exc:
            logger.warning(
                "[UpdateService] Failed to check for updates: %s", exc
            )
            self._cached = UpdateInfo(
                current_version=__version__,
                error=str(exc),
                checked_at=time.time(),
            )
            return self._cached

        finally:
            self._checking = False

    async def startup_check(self, delay: float = 10.0) -> None:
        """Run a delayed update check on startup (non-blocking)."""
        await asyncio.sleep(delay)
        await self.check_for_updates()


# Singleton
update_service = UpdateService()
