"""
data_plugin_service.py
----------------------
3rd-party data plugin system for overlay variable enrichment.

Manages external API endpoint configurations that provide additional data
for overlay templates — driver details (nicknames, avatars), race metadata
(season, week, venue), and championship standings.

Three plugin types are supported:

1. **Driver Details** — accepts iRacing customer IDs, returns nicknames
   and avatar hashes/URLs keyed by customer ID.
2. **Race Details** — accepts a subsession ID, returns season, series,
   week number, race date, and venue display name.
3. **Championship Standings** — accepts a subsession ID, returns the
   championship standings array for the associated season.

Each plugin stores an endpoint URL and authentication configuration
(API key, Bearer token, or custom header).

Data is fetched once per project and cached in memory for the session.
At encoding time the cached data is merged into each frame_data dict
before rendering.
"""

from __future__ import annotations

from datetime import datetime
import hashlib
import json
import logging
import time
from typing import Any, Optional

import httpx

from server.config import DATA_DIR

logger = logging.getLogger(__name__)


def _day_ordinal(day: int) -> str:
    """Return an ordinal suffix for day-of-month values."""
    if 10 <= day % 100 <= 20:
        return "th"
    return {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")


def _format_race_date_friendly(value: Any) -> Optional[str]:
    """Convert ISO race date strings into a human-friendly label.

    Example: "2025-07-13" -> "July 13th, 2025"
    """
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw:
        return None

    parsed = None

    # First, try full ISO parsing (handles timezone/timestamp variants).
    try:
        normalized = raw.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        parsed = None

    # Fallback: parse date token from common API formats.
    if parsed is None:
        date_token = raw.split("T", 1)[0].split(" ", 1)[0]
        for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
            try:
                parsed = datetime.strptime(date_token, fmt)
                break
            except ValueError:
                continue

    if parsed is None:
        return None

    day = parsed.day
    return f"{parsed.strftime('%B')} {day}{_day_ordinal(day)}, {parsed.year}"

# ── Plugin storage ──────────────────────────────────────────────────────────

PLUGINS_FILE = DATA_DIR / "data_plugins.json"

# ── Auth method constants ───────────────────────────────────────────────────

AUTH_NONE = "none"
AUTH_API_KEY = "api_key"          # sent as query param or header
AUTH_BEARER = "bearer"            # Authorization: Bearer <token>
AUTH_CUSTOM_HEADER = "custom_header"  # arbitrary header name + value

# ── Plugin type constants ───────────────────────────────────────────────────

PLUGIN_DRIVER_DETAILS = "driver_details"
PLUGIN_RACE_DETAILS = "race_details"
PLUGIN_CHAMPIONSHIP_STANDINGS = "championship_standings"

VALID_PLUGIN_TYPES = {PLUGIN_DRIVER_DETAILS, PLUGIN_RACE_DETAILS, PLUGIN_CHAMPIONSHIP_STANDINGS}
VALID_AUTH_METHODS = {AUTH_NONE, AUTH_API_KEY, AUTH_BEARER, AUTH_CUSTOM_HEADER}

# ── Request style constants ─────────────────────────────────────────────────

REQUEST_STYLE_POST_BODY = "post_body"    # POST with JSON body  (default)
REQUEST_STYLE_PATH_PARAM = "path_param"  # GET with single param appended as path segment

VALID_REQUEST_STYLES = {REQUEST_STYLE_POST_BODY, REQUEST_STYLE_PATH_PARAM}

# ── Expected response formats ──────────────────────────────────────────────

EXPECTED_FORMATS: dict[str, dict[str, Any]] = {
    PLUGIN_DRIVER_DETAILS: {
        "description": (
            "Accepts a JSON body with { \"customer_ids\": [int, ...] }. "
            "Returns a map of iRacing customer IDs to driver info objects. "
            "Each object should have \"nickname\" (string) and \"avatar\" "
            "(URL string or Discord avatar hash, e.g. 'a_abc123def456')."
        ),
        "request_schema": [
            {
                "field": "customer_ids",
                "type": "int[]",
                "required": True,
                "description": "One or more iRacing customer IDs to enrich.",
            },
        ],
        "response_schema": [
            {
                "field": "<customer_id>",
                "type": "object",
                "required": True,
                "description": "Object key is the customer ID string.",
                "children": [
                    {"field": "nickname", "type": "string", "required": False},
                    {"field": "avatar", "type": "string", "required": False},
                ],
            },
        ],
        "request_example": {"customer_ids": [12345, 67890]},
        "response_example": {
            "12345": {"nickname": "MaxV", "avatar": "a_abc123def456"},
            "67890": {"nickname": "LewisH", "avatar": "https://cdn.example.com/avatar.png"},
        },
    },
    PLUGIN_RACE_DETAILS: {
        "description": (
            "Accepts a JSON body with { \"subsession_id\": int }. "
            "Returns race metadata: season, series, week_number, "
            "race_date (ISO 8601), and track_name."
        ),
        "request_schema": [
            {
                "field": "subsession_id",
                "type": "int",
                "required": True,
                "description": "The iRacing subsession ID for the race.",
            },
        ],
        "response_schema": [
            {"field": "season", "type": "string", "required": False},
            {"field": "series", "type": "string", "required": False},
            {"field": "week_number", "type": "int", "required": False},
            {"field": "race_date", "type": "string", "required": False, "description": "ISO date string."},
            {"field": "race_date_friendly", "type": "string", "required": False, "description": "Friendly date string (e.g., 'July 13th, 2025')."},
            {"field": "track_name", "type": "string", "required": False},
        ],
        "request_example": {"subsession_id": 12345678},
        "response_example": {
            "season": "2025 Season 2",
            "series": "IMSA SportsCar Championship",
            "week_number": 5,
            "race_date": "2025-03-15",
            "race_date_friendly": "March 15th, 2025",
            "track_name": "Daytona International Speedway — Road Course",
        },
    },
    PLUGIN_CHAMPIONSHIP_STANDINGS: {
        "description": (
            "Accepts a JSON body with { \"subsession_id\": int }. "
            "Returns a \"standings\" array ordered by championship position. "
            "Each entry has: iracing_cust_id, driver_name, total_points, "
            "points_delta, position_delta, championship_position, and "
            "participated (boolean indicating presence in the subsession)."
        ),
        "request_schema": [
            {
                "field": "subsession_id",
                "type": "int",
                "required": True,
                "description": "The iRacing subsession ID for standings lookup.",
            },
        ],
        "response_schema": [
            {
                "field": "standings",
                "type": "array<object>",
                "required": True,
                "children": [
                    {"field": "championship_position", "type": "int", "required": False},
                    {"field": "driver_name", "type": "string", "required": False},
                    {"field": "iracing_cust_id", "type": "int", "required": False},
                    {"field": "total_points", "type": "int", "required": False},
                    {"field": "points_delta", "type": "int", "required": False},
                    {"field": "position_delta", "type": "int", "required": False},
                    {"field": "participated", "type": "bool", "required": False},
                ],
            },
        ],
        "request_example": {"subsession_id": 12345678},
        "response_example": {
            "standings": [
                {
                    "championship_position": 1,
                    "driver_name": "Lewis Hamilton",
                    "iracing_cust_id": 11111,
                    "total_points": 285,
                    "points_delta": 25,
                    "position_delta": 0,
                    "participated": True,
                },
            ],
        },
    },
}

# ── Whitelisted response keys (per plugin type) ────────────────────────────
# Only these keys are extracted from the remote response and made available
# as overlay variables.  This prevents arbitrary data injection.

WHITELIST: dict[str, set[str]] = {
    PLUGIN_DRIVER_DETAILS: {"nickname", "avatar"},
    PLUGIN_RACE_DETAILS: {"season", "series", "week_number", "race_date", "race_date_friendly", "track_name"},
    PLUGIN_CHAMPIONSHIP_STANDINGS: {
        "championship_position", "driver_name", "iracing_cust_id",
        "total_points", "points_delta", "position_delta", "participated",
    },
}


# ── Data Plugin Service ─────────────────────────────────────────────────────

class DataPluginService:
    """Manages 3rd-party data plugin configurations and data fetching."""

    def __init__(self) -> None:
        self._plugins: list[dict[str, Any]] = []
        self._cache: dict[str, Any] = {}      # keyed by plugin_id + request hash
        self._cache_ttl: float = 300.0         # 5 min cache
        self._load_plugins()

    # ── Persistence ──────────────────────────────────────────────────────────

    def _load_plugins(self) -> None:
        """Load plugin configurations from disk."""
        if PLUGINS_FILE.exists():
            try:
                data = json.loads(PLUGINS_FILE.read_text(encoding="utf-8"))
                self._plugins = self._dedupe_plugins(data if isinstance(data, list) else [])
            except (json.JSONDecodeError, OSError) as exc:
                logger.warning("[DataPlugin] Failed to load plugins: %s", exc)
                self._plugins = []
        else:
            self._plugins = []

    def _save_plugins(self) -> None:
        """Persist plugin configurations to disk."""
        PLUGINS_FILE.parent.mkdir(parents=True, exist_ok=True)
        try:
            PLUGINS_FILE.write_text(
                json.dumps(self._plugins, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        except OSError as exc:
            logger.error("[DataPlugin] Failed to save plugins: %s", exc)

    # ── CRUD ─────────────────────────────────────────────────────────────────

    def list_plugins(self) -> list[dict[str, Any]]:
        """List all configured data plugins (auth secrets masked)."""
        return [self._mask_secrets(p) for p in self._plugins]

    def get_plugin(self, plugin_id: str) -> Optional[dict[str, Any]]:
        """Get a single plugin config by ID (auth secrets masked)."""
        p = self._find_plugin(plugin_id)
        return self._mask_secrets(p) if p else None

    def create_plugin(self, data: dict[str, Any]) -> dict[str, Any]:
        """Create a new data plugin configuration."""
        import uuid

        existing = next((p for p in self._plugins if p.get("plugin_type") == data.get("plugin_type")), None)
        if existing:
            return self._mask_secrets(existing)

        plugin = {
            "id": str(uuid.uuid4())[:8],
            "name": data.get("name", "Unnamed Plugin"),
            "plugin_type": data.get("plugin_type", PLUGIN_DRIVER_DETAILS),
            "enabled": data.get("enabled", True),
            "endpoint_url": data.get("endpoint_url", ""),
            "request_style": data.get("request_style", REQUEST_STYLE_POST_BODY),
            "auth_method": data.get("auth_method", AUTH_NONE),
            "auth_config": data.get("auth_config", {}),
            "last_test": None,
            "last_test_ok": False,
        }
        if plugin["plugin_type"] not in VALID_PLUGIN_TYPES:
            raise ValueError(f"Invalid plugin type: {plugin['plugin_type']}")
        if plugin["auth_method"] not in VALID_AUTH_METHODS:
            raise ValueError(f"Invalid auth method: {plugin['auth_method']}")
        if plugin["request_style"] not in VALID_REQUEST_STYLES:
            raise ValueError(f"Invalid request style: {plugin['request_style']}")

        self._plugins.append(plugin)
        self._plugins = self._dedupe_plugins(self._plugins)
        self._save_plugins()
        return self._mask_secrets(plugin)

    def update_plugin(self, plugin_id: str, updates: dict[str, Any]) -> Optional[dict[str, Any]]:
        """Update an existing plugin configuration."""
        plugin = self._find_plugin(plugin_id)
        if not plugin:
            return None

        for key in ("name", "plugin_type", "enabled", "endpoint_url", "auth_method", "request_style"):
            if key in updates:
                plugin[key] = updates[key]

        if "auth_config" in updates:
            plugin["auth_config"] = self._merge_auth_config(
                plugin.get("auth_config", {}),
                updates.get("auth_config") or {},
                incoming_method=updates.get("auth_method", plugin.get("auth_method", AUTH_NONE)),
                current_method=plugin.get("auth_method", AUTH_NONE),
            )

        if plugin.get("plugin_type") and plugin["plugin_type"] not in VALID_PLUGIN_TYPES:
            raise ValueError(f"Invalid plugin type: {plugin['plugin_type']}")
        if plugin.get("auth_method") and plugin["auth_method"] not in VALID_AUTH_METHODS:
            raise ValueError(f"Invalid auth method: {plugin['auth_method']}")
        if plugin.get("request_style") and plugin["request_style"] not in VALID_REQUEST_STYLES:
            raise ValueError(f"Invalid request style: {plugin['request_style']}")

        self._plugins = self._dedupe_plugins(self._plugins)
        self._save_plugins()
        return self._mask_secrets(plugin)

    def delete_plugin(self, plugin_id: str) -> bool:
        """Delete a plugin configuration."""
        before = len(self._plugins)
        self._plugins = [p for p in self._plugins if p["id"] != plugin_id]
        if len(self._plugins) < before:
            self._save_plugins()
            return True
        return False

    # ── Test connectivity ────────────────────────────────────────────────────

    async def test_plugin(self, plugin_id: str) -> dict[str, Any]:
        """Test connectivity and response format for a plugin.

        Sends a sample request to the configured endpoint and validates
        that the response matches the expected format.
        """
        plugin = self._find_plugin(plugin_id)
        if not plugin:
            return {"success": False, "error": "Plugin not found"}

        ptype = plugin["plugin_type"]
        sample_body = EXPECTED_FORMATS.get(ptype, {}).get("request_example", {})

        try:
            headers = self._build_auth_headers(plugin)
            method, url, json_body = self._build_request_args(plugin, sample_body)
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.request(
                    method,
                    url,
                    json=json_body,
                    headers=headers,
                )
                resp.raise_for_status()
                data = resp.json()

            # Validate response structure
            validation = self._validate_response(ptype, data)

            plugin["last_test"] = time.time()
            plugin["last_test_ok"] = validation["valid"]
            self._save_plugins()

            return {
                "success": validation["valid"],
                "status_code": resp.status_code,
                "validation": validation,
                "sample_response": data,
            }
        except httpx.HTTPStatusError as exc:
            plugin["last_test"] = time.time()
            plugin["last_test_ok"] = False
            self._save_plugins()
            return {
                "success": False,
                "error": f"HTTP {exc.response.status_code}: {exc.response.text[:200]}",
            }
        except httpx.ConnectError:
            plugin["last_test"] = time.time()
            plugin["last_test_ok"] = False
            self._save_plugins()
            return {"success": False, "error": "Connection failed — check the endpoint URL"}
        except httpx.TimeoutException:
            plugin["last_test"] = time.time()
            plugin["last_test_ok"] = False
            self._save_plugins()
            return {"success": False, "error": "Connection timed out (10s limit)"}
        except Exception as exc:
            logger.warning("[DataPlugin] Test failed for %s: %s", plugin_id, exc)
            plugin["last_test"] = time.time()
            plugin["last_test_ok"] = False
            self._save_plugins()
            # Return only the exception class name to avoid leaking stack traces
            return {"success": False, "error": f"Connection failed: {type(exc).__name__}"}

    async def preview_plugin(self, plugin_id: str, request_body: dict[str, Any]) -> dict[str, Any]:
        """Execute a configured plugin with a caller-provided request body.

        Returns both the raw API response and a normalized/whitelisted version
        so the UI can inspect what the overlay pipeline would actually consume.
        """
        plugin = self._find_plugin(plugin_id)
        if not plugin:
            return {"success": False, "error": "Plugin not found"}

        try:
            headers = self._build_auth_headers(plugin)
            method, url, json_body = self._build_request_args(plugin, request_body or {})
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.request(
                    method,
                    url,
                    json=json_body,
                    headers=headers,
                )
                resp.raise_for_status()
                raw = resp.json()

            validation = self._validate_response(plugin["plugin_type"], raw)
            normalized = self._normalize_preview_data(plugin["plugin_type"], raw)

            return {
                "success": True,
                "plugin": self._mask_secrets(plugin),
                "request_method": method,
                "request_url": url,
                "request_body": json_body,
                "status_code": resp.status_code,
                "validation": validation,
                "normalized_data": normalized,
                "raw_response": raw,
            }
        except httpx.HTTPStatusError as exc:
            return {
                "success": False,
                "request_body": request_body or {},
                "error": f"HTTP {exc.response.status_code}: {exc.response.text[:400]}",
            }
        except httpx.ConnectError:
            return {
                "success": False,
                "request_body": request_body or {},
                "error": "Connection failed — check the endpoint URL",
            }
        except httpx.TimeoutException:
            return {
                "success": False,
                "request_body": request_body or {},
                "error": "Connection timed out (15s limit)",
            }
        except Exception as exc:
            logger.warning("[DataPlugin] Preview failed for %s: %s", plugin_id, exc)
            return {
                "success": False,
                "request_body": request_body or {},
                "error": f"Connection failed: {type(exc).__name__}",
            }

    # ── Data fetching ────────────────────────────────────────────────────────

    async def fetch_driver_details(
        self, cust_ids: list[int]
    ) -> dict[int, dict[str, Any]]:
        """Fetch driver details from the configured driver_details plugin.

        Returns a mapping of iRacing customer ID → {nickname, avatar}.
        """
        plugin = self._get_enabled_plugin(PLUGIN_DRIVER_DETAILS)
        if not plugin or not cust_ids:
            return {}

        cache_key = self._cache_key(plugin["id"], {"customer_ids": sorted(cust_ids)})
        cached = self._get_cached(cache_key)
        if cached is not None:
            return cached

        try:
            headers = self._build_auth_headers(plugin)
            method, url, json_body = self._build_request_args(plugin, {"customer_ids": cust_ids})
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.request(
                    method,
                    url,
                    json=json_body,
                    headers=headers,
                )
                resp.raise_for_status()
                raw = resp.json()

            # Whitelist filter: only keep allowed keys
            result: dict[int, dict[str, Any]] = {}
            if isinstance(raw, dict):
                for cid_str, info in raw.items():
                    try:
                        cid = int(cid_str)
                    except (ValueError, TypeError):
                        continue
                    if isinstance(info, dict):
                        result[cid] = {
                            k: v for k, v in info.items()
                            if k in WHITELIST[PLUGIN_DRIVER_DETAILS]
                        }

            self._set_cached(cache_key, result)
            return result
        except Exception as exc:
            logger.warning("[DataPlugin] Driver details fetch failed: %s", exc)
            return {}

    async def fetch_race_details(self, subsession_id: int) -> dict[str, Any]:
        """Fetch race details from the configured race_details plugin.

        Returns a dict with season, series, week_number, race_date,
        race_date_friendly, and track_name.
        """
        plugin = self._get_enabled_plugin(PLUGIN_RACE_DETAILS)
        if not plugin or not subsession_id:
            return {}

        cache_key = self._cache_key(plugin["id"], {"subsession_id": subsession_id})
        cached = self._get_cached(cache_key)
        if cached is not None:
            return cached

        try:
            headers = self._build_auth_headers(plugin)
            method, url, json_body = self._build_request_args(plugin, {"subsession_id": subsession_id})
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.request(
                    method,
                    url,
                    json=json_body,
                    headers=headers,
                )
                resp.raise_for_status()
                raw = resp.json()

            result = {
                k: v for k, v in raw.items()
                if k in WHITELIST[PLUGIN_RACE_DETAILS]
            } if isinstance(raw, dict) else {}

            self._set_cached(cache_key, result)
            return result
        except Exception as exc:
            logger.warning("[DataPlugin] Race details fetch failed: %s", exc)
            return {}

    async def fetch_championship_standings(
        self, subsession_id: int
    ) -> list[dict[str, Any]]:
        """Fetch championship standings from the configured plugin.

        Returns a list of standing entries ordered by championship position.
        """
        plugin = self._get_enabled_plugin(PLUGIN_CHAMPIONSHIP_STANDINGS)
        if not plugin or not subsession_id:
            return []

        cache_key = self._cache_key(plugin["id"], {"subsession_id": subsession_id})
        cached = self._get_cached(cache_key)
        if cached is not None:
            return cached

        try:
            headers = self._build_auth_headers(plugin)
            method, url, json_body = self._build_request_args(plugin, {"subsession_id": subsession_id})
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.request(
                    method,
                    url,
                    json=json_body,
                    headers=headers,
                )
                resp.raise_for_status()
                raw = resp.json()

            standings_raw = raw.get("standings", []) if isinstance(raw, dict) else []
            result = []
            for entry in standings_raw:
                if isinstance(entry, dict):
                    result.append({
                        k: v for k, v in entry.items()
                        if k in WHITELIST[PLUGIN_CHAMPIONSHIP_STANDINGS]
                    })

            self._set_cached(cache_key, result)
            return result
        except Exception as exc:
            logger.warning("[DataPlugin] Championship standings fetch failed: %s", exc)
            return []

    # ── Enrich frame_data ────────────────────────────────────────────────────

    async def enrich_frame_data(
        self,
        frame_data: dict[str, Any],
        subsession_id: int = 0,
    ) -> dict[str, Any]:
        """Merge 3rd-party plugin data into a frame_data dict.

        This is the primary integration point — called by the overlay
        rendering pipeline to augment telemetry data with external info.

        Modifies ``frame_data`` in-place and returns it.
        """
        # Gather all cust_ids from standings (main + section-specific arrays)
        cust_ids = [
            e["iracing_cust_id"]
            for e in frame_data.get("standings", [])
            if e.get("iracing_cust_id")
        ]
        for extra_key in ("qualifying_standings", "final_standings"):
            for e in frame_data.get(extra_key, []):
                cid = e.get("iracing_cust_id", 0)
                if cid and cid not in cust_ids:
                    cust_ids.append(cid)
        focused_cust_id = frame_data.get("iracing_cust_id", 0)
        if focused_cust_id and focused_cust_id not in cust_ids:
            cust_ids.append(focused_cust_id)

        # Fetch all plugin data in parallel
        driver_details = await self.fetch_driver_details(cust_ids) if cust_ids else {}
        race_details = await self.fetch_race_details(subsession_id) if subsession_id else {}
        championship = await self.fetch_championship_standings(subsession_id) if subsession_id else []

        # Enrich standings with nicknames and avatars
        for entry in frame_data.get("standings", []):
            cid = entry.get("iracing_cust_id", 0)
            if cid and cid in driver_details:
                dd = driver_details[cid]
                entry["nickname"] = dd.get("nickname")
                entry["avatar"] = dd.get("avatar")

        # Enrich section-specific standings arrays for template compatibility
        for extra_key in ("qualifying_standings", "final_standings"):
            for entry in frame_data.get(extra_key, []):
                cid = entry.get("iracing_cust_id", 0)
                if cid and cid in driver_details:
                    dd = driver_details[cid]
                    entry["nickname"] = dd.get("nickname")
                    entry["avatar"] = dd.get("avatar")

        # Enrich focused driver
        if focused_cust_id and focused_cust_id in driver_details:
            dd = driver_details[focused_cust_id]
            frame_data["driver_nickname"] = dd.get("nickname")
            frame_data["driver_avatar"] = dd.get("avatar")

        # Race details
        if race_details:
            frame_data["race_season"] = race_details.get("season")
            frame_data["series_name"] = race_details.get("series")
            frame_data["race_week"] = race_details.get("week_number")
            race_date = race_details.get("race_date")
            frame_data["race_date"] = race_date
            plugin_friendly = race_details.get("race_date_friendly")
            frame_data["race_date_friendly"] = plugin_friendly or _format_race_date_friendly(race_date)
            frame_data["track_name"] = race_details.get("track_name")

        # Championship standings — also enrich with driver details
        if championship:
            for entry in championship:
                cid = entry.get("iracing_cust_id", 0)
                if cid and cid in driver_details:
                    dd = driver_details[cid]
                    entry["nickname"] = dd.get("nickname")
                    entry["avatar"] = dd.get("avatar")
                else:
                    entry.setdefault("nickname", None)
                    entry.setdefault("avatar", None)
            frame_data["championship_standings"] = championship

        return frame_data

    # ── API format metadata ──────────────────────────────────────────────────

    def get_expected_formats(self) -> dict[str, Any]:
        """Return the expected API format documentation for all plugin types."""
        return EXPECTED_FORMATS

    def get_available_variables(self) -> dict[str, list[str]]:
        """Return variables contributed by each enabled plugin type."""
        result: dict[str, list[str]] = {}
        for plugin in self._plugins:
            if not plugin.get("enabled"):
                continue
            ptype = plugin["plugin_type"]
            wl = WHITELIST.get(ptype, set())
            values = set(wl)
            if ptype == PLUGIN_RACE_DETAILS:
                # Always exposed in frame_data; derived from race_date when absent upstream.
                values.add("race_date_friendly")
            result[ptype] = sorted(values)
        return result

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _find_plugin(self, plugin_id: str) -> Optional[dict[str, Any]]:
        return next((p for p in self._plugins if p["id"] == plugin_id), None)

    @staticmethod
    def _is_masked_secret(value: Any) -> bool:
        return isinstance(value, str) and "****" in value

    def _merge_auth_config(
        self,
        current_config: dict[str, Any],
        incoming_config: dict[str, Any],
        incoming_method: str,
        current_method: str,
    ) -> dict[str, Any]:
        """Merge auth config while preserving stored secrets behind masked UI values."""
        if incoming_method != current_method:
            return dict(incoming_config or {})

        merged = dict(current_config or {})
        for key, value in (incoming_config or {}).items():
            if key in {"api_key", "token", "header_value"} and self._is_masked_secret(value):
                continue
            merged[key] = value
        return merged

    def _dedupe_plugins(self, plugins: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Keep at most one plugin per type, preferring the most complete record."""
        by_type: dict[str, dict[str, Any]] = {}
        order: list[str] = []

        for raw_plugin in plugins:
            if not isinstance(raw_plugin, dict):
                continue
            plugin = dict(raw_plugin)
            plugin_type = plugin.get("plugin_type")
            if plugin_type not in VALID_PLUGIN_TYPES:
                continue

            if plugin_type not in by_type:
                by_type[plugin_type] = plugin
                order.append(plugin_type)
                continue

            existing = by_type[plugin_type]
            winner, loser = self._pick_preferred_plugin(existing, plugin)
            by_type[plugin_type] = self._merge_plugin_records(winner, loser)

        return [by_type[plugin_type] for plugin_type in order if plugin_type in by_type]

    @staticmethod
    def _plugin_score(plugin: dict[str, Any]) -> tuple[int, int, int]:
        auth_config = plugin.get("auth_config") or {}
        has_secret = any(bool(auth_config.get(key)) for key in ("api_key", "token", "header_value"))
        has_endpoint = bool((plugin.get("endpoint_url") or "").strip())
        last_test_ok = bool(plugin.get("last_test_ok"))
        last_test = int(plugin.get("last_test") or 0)
        return (
            int(has_endpoint) * 4 + int(has_secret) * 3 + int(last_test_ok) * 2 + int(bool(plugin.get("enabled"))),
            last_test,
            len(json.dumps(plugin, sort_keys=True)),
        )

    def _pick_preferred_plugin(self, a: dict[str, Any], b: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        return (a, b) if self._plugin_score(a) >= self._plugin_score(b) else (b, a)

    def _merge_plugin_records(self, preferred: dict[str, Any], duplicate: dict[str, Any]) -> dict[str, Any]:
        merged = dict(preferred)
        if not merged.get("endpoint_url") and duplicate.get("endpoint_url"):
            merged["endpoint_url"] = duplicate.get("endpoint_url")
        if not merged.get("name") and duplicate.get("name"):
            merged["name"] = duplicate.get("name")
        if not merged.get("auth_method") and duplicate.get("auth_method"):
            merged["auth_method"] = duplicate.get("auth_method")
        merged["auth_config"] = self._merge_auth_config(
            merged.get("auth_config", {}),
            duplicate.get("auth_config", {}),
            incoming_method=merged.get("auth_method", AUTH_NONE),
            current_method=merged.get("auth_method", AUTH_NONE),
        )
        if not merged.get("last_test") and duplicate.get("last_test"):
            merged["last_test"] = duplicate.get("last_test")
        if not merged.get("last_test_ok") and duplicate.get("last_test_ok"):
            merged["last_test_ok"] = duplicate.get("last_test_ok")
        merged["enabled"] = bool(merged.get("enabled") or duplicate.get("enabled"))
        return merged

    def _get_enabled_plugin(self, plugin_type: str) -> Optional[dict[str, Any]]:
        """Find the first enabled plugin of the given type."""
        return next(
            (p for p in self._plugins if p["plugin_type"] == plugin_type and p.get("enabled")),
            None,
        )

    @staticmethod
    def _mask_secrets(plugin: dict[str, Any]) -> dict[str, Any]:
        """Return a copy with auth secrets masked for API responses."""
        p = dict(plugin)
        ac = dict(p.get("auth_config", {}))
        for key in ("api_key", "token", "header_value"):
            if key in ac and ac[key]:
                ac[key] = ac[key][:4] + "****" if len(ac[key]) > 4 else "****"
        p["auth_config"] = ac
        return p

    @staticmethod
    def _build_request_args(plugin: dict[str, Any], body: dict[str, Any]) -> tuple[str, str, dict | None]:
        """Return (method, url, json_body) for a plugin call.

        post_body  → POST <endpoint_url>  with body as JSON
        path_param → GET  <endpoint_url>/<single_value>  with no body
                     Falls back to POST+body for driver_details (multiple customer_ids)
                     or when body has more than one key.
        """
        style = plugin.get("request_style", REQUEST_STYLE_POST_BODY)
        url = plugin["endpoint_url"].rstrip("/")

        if style == REQUEST_STYLE_PATH_PARAM and len(body) == 1:
            value = next(iter(body.values()))
            if isinstance(value, list):
                # Multiple values (e.g. cust_ids) — fall back to POST body
                pass
            else:
                return "GET", f"{url}/{value}", None

        # Default: POST with JSON body
        return "POST", url, body

    @staticmethod
    def _build_auth_headers(plugin: dict[str, Any]) -> dict[str, str]:
        """Build HTTP headers for the plugin's auth configuration."""
        method = plugin.get("auth_method", AUTH_NONE)
        config = plugin.get("auth_config", {})
        headers: dict[str, str] = {"Content-Type": "application/json"}

        if method == AUTH_BEARER:
            token = config.get("token", "")
            if token:
                headers["Authorization"] = f"Bearer {token}"
        elif method == AUTH_API_KEY:
            key_name = config.get("header_name", "X-API-Key")
            key_value = config.get("api_key", "")
            if key_value:
                headers[key_name] = key_value
        elif method == AUTH_CUSTOM_HEADER:
            header_name = config.get("header_name", "")
            header_value = config.get("header_value", "")
            if header_name and header_value:
                headers[header_name] = header_value

        return headers

    @staticmethod
    def _validate_response(plugin_type: str, data: Any) -> dict[str, Any]:
        """Validate that a response matches the expected structure."""
        if plugin_type == PLUGIN_DRIVER_DETAILS:
            if not isinstance(data, dict):
                return {"valid": False, "error": "Expected a JSON object keyed by customer ID"}
            # Check at least one entry has the right shape
            for _cid, info in data.items():
                if isinstance(info, dict) and ("nickname" in info or "avatar" in info):
                    return {"valid": True, "fields_found": list(info.keys())}
            return {"valid": True, "warning": "Response is valid but no nickname/avatar fields found"}

        elif plugin_type == PLUGIN_RACE_DETAILS:
            if not isinstance(data, dict):
                return {"valid": False, "error": "Expected a JSON object with race details"}
            expected = {"season", "race_date", "race_date_friendly", "track_name"}
            found = set(data.keys()) & expected
            return {"valid": len(found) > 0, "fields_found": list(data.keys())}

        elif plugin_type == PLUGIN_CHAMPIONSHIP_STANDINGS:
            if not isinstance(data, dict) or "standings" not in data:
                return {"valid": False, "error": "Expected a JSON object with a 'standings' array"}
            standings = data.get("standings", [])
            if not isinstance(standings, list):
                return {"valid": False, "error": "'standings' must be an array"}
            if standings and isinstance(standings[0], dict):
                return {"valid": True, "entry_count": len(standings), "fields_found": list(standings[0].keys())}
            return {"valid": True, "entry_count": len(standings)}

        return {"valid": False, "error": f"Unknown plugin type: {plugin_type}"}

    def _cache_key(self, plugin_id: str, params: dict) -> str:
        raw = json.dumps({"id": plugin_id, **params}, sort_keys=True)
        return hashlib.md5(raw.encode()).hexdigest()  # noqa: S324

    @staticmethod
    def _normalize_preview_data(plugin_type: str, data: Any) -> Any:
        """Reduce raw plugin response to the subset consumed by overlays."""
        if plugin_type == PLUGIN_DRIVER_DETAILS:
            result: dict[str, dict[str, Any]] = {}
            if isinstance(data, dict):
                for cid_str, info in data.items():
                    if isinstance(info, dict):
                        result[str(cid_str)] = {
                            k: v for k, v in info.items()
                            if k in WHITELIST[PLUGIN_DRIVER_DETAILS]
                        }
            return result

        if plugin_type == PLUGIN_RACE_DETAILS:
            normalized = {
                k: v for k, v in data.items()
                if isinstance(data, dict) and k in WHITELIST[PLUGIN_RACE_DETAILS]
            } if isinstance(data, dict) else {}
            if isinstance(normalized, dict):
                normalized["race_date_friendly"] = (
                    normalized.get("race_date_friendly")
                    or _format_race_date_friendly(normalized.get("race_date"))
                )
            return normalized

        if plugin_type == PLUGIN_CHAMPIONSHIP_STANDINGS:
            standings_raw = data.get("standings", []) if isinstance(data, dict) else []
            result = []
            for entry in standings_raw:
                if isinstance(entry, dict):
                    result.append({
                        k: v for k, v in entry.items()
                        if k in WHITELIST[PLUGIN_CHAMPIONSHIP_STANDINGS]
                    })
            return result

        return data

    def _get_cached(self, key: str) -> Optional[Any]:
        entry = self._cache.get(key)
        if entry and (time.time() - entry["ts"]) < self._cache_ttl:
            return entry["data"]
        return None

    def _set_cached(self, key: str, data: Any) -> None:
        self._cache[key] = {"data": data, "ts": time.time()}


# ── Singleton ───────────────────────────────────────────────────────────────

data_plugin_service = DataPluginService()
