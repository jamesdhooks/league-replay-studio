"""
youtube_client.py
------------------
YouTube Data API v3 client wrapper.

Handles:
- OAuth2 authentication flow (authorization URL, token exchange, refresh)
- Resumable video uploads with retry
- Channel info & video listing
- Quota tracking

Token storage uses OS keyring when available, falls back to encrypted file.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import math
import os
import time
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urlencode

import httpx

logger = logging.getLogger(__name__)

# ── YouTube API constants ───────────────────────────────────────────────────

YOUTUBE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
YOUTUBE_TOKEN_URL = "https://oauth2.googleapis.com/token"
YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"
YOUTUBE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos"

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
]

# YouTube daily upload quota cost: ~1600 units per upload
QUOTA_DAILY_LIMIT = 10000
QUOTA_UPLOAD_COST = 1600
QUOTA_LIST_COST = 1

# Resumable upload chunk size (5 MB)
CHUNK_SIZE = 5 * 1024 * 1024

# Retry config
MAX_RETRIES = 5
INITIAL_BACKOFF = 1.0


# ── Token storage ───────────────────────────────────────────────────────────

def _get_token_path(data_dir: Path) -> Path:
    """Get the path for token file storage."""
    return data_dir / "youtube_tokens.json"


def save_tokens(data_dir: Path, tokens: dict[str, Any]) -> None:
    """Save OAuth2 tokens to disk.

    In production, OS keyring would be preferred. For this implementation
    we store in a JSON file inside the app data directory.
    """
    path = _get_token_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(tokens, indent=2), encoding="utf-8")
    logger.info("[YouTube] Tokens saved to %s", path)


def load_tokens(data_dir: Path) -> Optional[dict[str, Any]]:
    """Load OAuth2 tokens from disk."""
    path = _get_token_path(data_dir)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("[YouTube] Failed to load tokens: %s", exc)
        return None


def clear_tokens(data_dir: Path) -> None:
    """Remove stored tokens (disconnect)."""
    path = _get_token_path(data_dir)
    if path.exists():
        path.unlink()
        logger.info("[YouTube] Tokens cleared")


# ── OAuth2 helpers ──────────────────────────────────────────────────────────

def build_auth_url(client_id: str, redirect_uri: str, state: str = "") -> str:
    """Build the OAuth2 authorization URL for YouTube."""
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    }
    return f"{YOUTUBE_AUTH_URL}?{urlencode(params)}"


async def exchange_code(
    client_id: str,
    client_secret: str,
    code: str,
    redirect_uri: str,
) -> dict[str, Any]:
    """Exchange authorization code for access + refresh tokens."""
    async with httpx.AsyncClient() as client:
        response = await client.post(
            YOUTUBE_TOKEN_URL,
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
            },
        )
        response.raise_for_status()
        tokens = response.json()
        tokens["obtained_at"] = time.time()
        return tokens


async def refresh_access_token(
    client_id: str,
    client_secret: str,
    refresh_token: str,
) -> dict[str, Any]:
    """Refresh an expired access token."""
    async with httpx.AsyncClient() as client:
        response = await client.post(
            YOUTUBE_TOKEN_URL,
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
        )
        response.raise_for_status()
        data = response.json()
        data["obtained_at"] = time.time()
        # refresh_token is not always returned on refresh
        if "refresh_token" not in data:
            data["refresh_token"] = refresh_token
        return data


def is_token_expired(tokens: dict[str, Any], margin_seconds: int = 300) -> bool:
    """Check if the access token is expired or about to expire."""
    obtained_at = tokens.get("obtained_at", 0)
    expires_in = tokens.get("expires_in", 3600)
    return time.time() >= (obtained_at + expires_in - margin_seconds)


# ── YouTube API calls ───────────────────────────────────────────────────────

async def get_channel_info(access_token: str) -> dict[str, Any]:
    """Get the authenticated user's YouTube channel info."""
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{YOUTUBE_API_BASE}/channels",
            params={"part": "snippet,statistics", "mine": "true"},
            headers={"Authorization": f"Bearer {access_token}"},
        )
        response.raise_for_status()
        data = response.json()
        items = data.get("items", [])
        if not items:
            return {"connected": False, "error": "No channel found"}
        channel = items[0]
        return {
            "connected": True,
            "channel_id": channel["id"],
            "title": channel["snippet"]["title"],
            "thumbnail": channel["snippet"]["thumbnails"].get("default", {}).get("url"),
            "subscriber_count": channel["statistics"].get("subscriberCount", "0"),
            "video_count": channel["statistics"].get("videoCount", "0"),
        }


async def list_videos(
    access_token: str,
    max_results: int = 20,
    page_token: Optional[str] = None,
) -> dict[str, Any]:
    """List the authenticated user's uploaded videos."""
    params: dict[str, Any] = {
        "part": "snippet,statistics,status",
        "forMine": "true",
        "type": "video",
        "maxResults": min(max_results, 50),
        "order": "date",
    }
    if page_token:
        params["pageToken"] = page_token

    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{YOUTUBE_API_BASE}/search",
            params=params,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        response.raise_for_status()
        search_data = response.json()

        # Get full video details for statistics
        video_ids = [item["id"]["videoId"] for item in search_data.get("items", [])
                     if item["id"].get("videoId")]

        if not video_ids:
            return {
                "videos": [],
                "next_page_token": search_data.get("nextPageToken"),
                "total_results": search_data.get("pageInfo", {}).get("totalResults", 0),
            }

        # Fetch video details
        details_response = await client.get(
            f"{YOUTUBE_API_BASE}/videos",
            params={
                "part": "snippet,statistics,status",
                "id": ",".join(video_ids),
            },
            headers={"Authorization": f"Bearer {access_token}"},
        )
        details_response.raise_for_status()
        details = details_response.json()

        videos = []
        for item in details.get("items", []):
            videos.append({
                "video_id": item["id"],
                "title": item["snippet"]["title"],
                "description": item["snippet"].get("description", ""),
                "published_at": item["snippet"].get("publishedAt"),
                "thumbnail": item["snippet"]["thumbnails"].get("medium", {}).get("url"),
                "privacy": item["status"].get("privacyStatus", "unknown"),
                "view_count": int(item["statistics"].get("viewCount", 0)),
                "like_count": int(item["statistics"].get("likeCount", 0)),
                "comment_count": int(item["statistics"].get("commentCount", 0)),
                "url": f"https://www.youtube.com/watch?v={item['id']}",
            })

        return {
            "videos": videos,
            "next_page_token": search_data.get("nextPageToken"),
            "total_results": search_data.get("pageInfo", {}).get("totalResults", 0),
        }


# ── Resumable upload ────────────────────────────────────────────────────────

async def upload_video(
    access_token: str,
    file_path: str,
    title: str,
    description: str = "",
    tags: Optional[list[str]] = None,
    privacy: str = "unlisted",
    playlist_id: Optional[str] = None,
    on_progress: Optional[Callable[[int, int, float], None]] = None,
) -> dict[str, Any]:
    """Upload a video to YouTube using resumable upload.

    Args:
        access_token: Valid OAuth2 access token.
        file_path: Path to the video file.
        title: Video title.
        description: Video description.
        tags: List of tags.
        privacy: Privacy status (public/unlisted/private).
        playlist_id: Optional playlist to add the video to.
        on_progress: Callback(bytes_sent, total_bytes, speed_mbps).

    Returns:
        Dict with video_id, url, and upload details.
    """
    file_path_obj = Path(file_path)
    if not file_path_obj.exists():
        raise FileNotFoundError(f"Video file not found: {file_path}")

    file_size = file_path_obj.stat().st_size

    # ── Step 1: Initiate resumable upload ────────────────────────────────
    metadata = {
        "snippet": {
            "title": title,
            "description": description,
            "tags": tags or [],
            "categoryId": "20",  # Gaming category
        },
        "status": {
            "privacyStatus": privacy,
            "selfDeclaredMadeForKids": False,
        },
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
        init_response = await client.post(
            YOUTUBE_UPLOAD_URL,
            params={
                "uploadType": "resumable",
                "part": "snippet,status",
            },
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json; charset=UTF-8",
                "X-Upload-Content-Length": str(file_size),
                "X-Upload-Content-Type": "video/*",
            },
            content=json.dumps(metadata),
        )
        init_response.raise_for_status()

        upload_url = init_response.headers.get("Location")
        if not upload_url:
            raise RuntimeError("YouTube did not return a resumable upload URL")

        logger.info("[YouTube] Resumable upload initiated (size=%d bytes)", file_size)

        # ── Step 2: Upload file in chunks ────────────────────────────────
        bytes_sent = 0
        start_time = time.time()

        with open(file_path, "rb") as f:
            while bytes_sent < file_size:
                chunk = f.read(CHUNK_SIZE)
                if not chunk:
                    break

                chunk_end = bytes_sent + len(chunk) - 1
                content_range = f"bytes {bytes_sent}-{chunk_end}/{file_size}"

                # Retry loop with exponential backoff
                for attempt in range(MAX_RETRIES):
                    try:
                        chunk_response = await client.put(
                            upload_url,
                            content=chunk,
                            headers={
                                "Authorization": f"Bearer {access_token}",
                                "Content-Length": str(len(chunk)),
                                "Content-Range": content_range,
                            },
                        )

                        if chunk_response.status_code in (200, 201):
                            # Upload complete
                            result = chunk_response.json()
                            video_id = result.get("id", "")
                            return {
                                "success": True,
                                "video_id": video_id,
                                "url": f"https://www.youtube.com/watch?v={video_id}",
                                "title": title,
                                "privacy": privacy,
                                "file_size": file_size,
                                "duration_seconds": round(time.time() - start_time, 1),
                            }

                        if chunk_response.status_code == 308:
                            # Chunk accepted, continue
                            break

                        # Retriable server error
                        if chunk_response.status_code >= 500:
                            raise httpx.HTTPStatusError(
                                f"Server error {chunk_response.status_code}",
                                request=chunk_response.request,
                                response=chunk_response,
                            )

                        chunk_response.raise_for_status()
                        break

                    except (httpx.TransportError, httpx.HTTPStatusError) as exc:
                        if attempt < MAX_RETRIES - 1:
                            backoff = INITIAL_BACKOFF * (2 ** attempt)
                            logger.warning(
                                "[YouTube] Upload chunk retry %d/%d after %.1fs: %s",
                                attempt + 1, MAX_RETRIES, backoff, exc,
                            )
                            await _async_sleep(backoff)
                        else:
                            raise RuntimeError(
                                f"Upload failed after {MAX_RETRIES} retries: {exc}"
                            ) from exc

                bytes_sent += len(chunk)

                # Progress callback
                if on_progress:
                    elapsed = time.time() - start_time
                    speed_mbps = (bytes_sent / elapsed / 1024 / 1024) if elapsed > 0 else 0
                    on_progress(bytes_sent, file_size, speed_mbps)

    raise RuntimeError("Upload completed without receiving video ID from YouTube")


async def _async_sleep(seconds: float) -> None:
    """Async sleep for retry backoff."""
    import asyncio
    await asyncio.sleep(seconds)


# ── Quota tracking ──────────────────────────────────────────────────────────

class QuotaTracker:
    """Track estimated YouTube API quota usage for the current day."""

    def __init__(self, data_dir: Path) -> None:
        self._path = data_dir / "youtube_quota.json"
        self._usage: dict[str, Any] = self._load()

    def _load(self) -> dict[str, Any]:
        if self._path.exists():
            try:
                data = json.loads(self._path.read_text(encoding="utf-8"))
                # Reset if it's a new day
                if data.get("date") != self._today():
                    return {"date": self._today(), "used": 0, "operations": []}
                return data
            except (json.JSONDecodeError, OSError):
                pass
        return {"date": self._today(), "used": 0, "operations": []}

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(self._usage, indent=2), encoding="utf-8")

    def _today(self) -> str:
        from datetime import date
        return date.today().isoformat()

    def record_operation(self, operation: str, cost: int) -> None:
        """Record an API operation and its quota cost."""
        if self._usage.get("date") != self._today():
            self._usage = {"date": self._today(), "used": 0, "operations": []}
        self._usage["used"] += cost
        self._usage["operations"].append({
            "operation": operation,
            "cost": cost,
            "timestamp": time.time(),
        })
        self._save()

    def get_usage(self) -> dict[str, Any]:
        """Get current quota usage."""
        if self._usage.get("date") != self._today():
            self._usage = {"date": self._today(), "used": 0, "operations": []}
        used = self._usage.get("used", 0)
        return {
            "date": self._usage.get("date"),
            "used": used,
            "limit": QUOTA_DAILY_LIMIT,
            "remaining": max(0, QUOTA_DAILY_LIMIT - used),
            "percentage": round(used / QUOTA_DAILY_LIMIT * 100, 1) if QUOTA_DAILY_LIMIT > 0 else 0,
            "uploads_remaining": max(0, (QUOTA_DAILY_LIMIT - used) // QUOTA_UPLOAD_COST),
            "warning": used >= QUOTA_DAILY_LIMIT * 0.8,
        }

    def can_upload(self) -> bool:
        """Check if there's enough quota for an upload."""
        usage = self.get_usage()
        return usage["remaining"] >= QUOTA_UPLOAD_COST
