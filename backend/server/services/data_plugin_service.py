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

import hashlib
import json
import logging
import time
from typing import Any, Optional

import httpx

from server.config import DATA_DIR

logger = logging.getLogger(__name__)

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

# ── Expected response formats ──────────────────────────────────────────────

EXPECTED_FORMATS: dict[str, dict[str, Any]] = {
    PLUGIN_DRIVER_DETAILS: {
        "description": (
            "Accepts a JSON body with { \"cust_ids\": [int, ...] }. "
            "Returns a map of iRacing customer IDs to driver info objects. "
            "Each object should have \"nickname\" (string) and \"avatar\" "
            "(URL string or Discord avatar hash, e.g. 'a_abc123def456')."
        ),
        "request_example": {"cust_ids": [12345, 67890]},
        "response_example": {
            "12345": {"nickname": "MaxV", "avatar": "a_abc123def456"},
            "67890": {"nickname": "LewisH", "avatar": "https://cdn.example.com/avatar.png"},
        },
    },
    PLUGIN_RACE_DETAILS: {
        "description": (
            "Accepts a JSON body with { \"subsession_id\": int }. "
            "Returns race metadata: season, series, week_number, "
            "race_date (ISO 8601), and venue_display_name."
        ),
        "request_example": {"subsession_id": 12345678},
        "response_example": {
            "season": "2025 Season 2",
            "series": "IMSA SportsCar Championship",
            "week_number": 5,
            "race_date": "2025-03-15",
            "venue_display_name": "Daytona International Speedway — Road Course",
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
    PLUGIN_RACE_DETAILS: {"season", "series", "week_number", "race_date", "venue_display_name"},
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
                self._plugins = data if isinstance(data, list) else []
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
        plugin = {
            "id": str(uuid.uuid4())[:8],
            "name": data.get("name", "Unnamed Plugin"),
            "plugin_type": data.get("plugin_type", PLUGIN_DRIVER_DETAILS),
            "enabled": data.get("enabled", True),
            "endpoint_url": data.get("endpoint_url", ""),
            "auth_method": data.get("auth_method", AUTH_NONE),
            "auth_config": data.get("auth_config", {}),
            "last_test": None,
            "last_test_ok": False,
        }
        if plugin["plugin_type"] not in VALID_PLUGIN_TYPES:
            raise ValueError(f"Invalid plugin type: {plugin['plugin_type']}")
        if plugin["auth_method"] not in VALID_AUTH_METHODS:
            raise ValueError(f"Invalid auth method: {plugin['auth_method']}")

        self._plugins.append(plugin)
        self._save_plugins()
        return self._mask_secrets(plugin)

    def update_plugin(self, plugin_id: str, updates: dict[str, Any]) -> Optional[dict[str, Any]]:
        """Update an existing plugin configuration."""
        plugin = self._find_plugin(plugin_id)
        if not plugin:
            return None

        for key in ("name", "plugin_type", "enabled", "endpoint_url", "auth_method", "auth_config"):
            if key in updates:
                plugin[key] = updates[key]

        if plugin.get("plugin_type") and plugin["plugin_type"] not in VALID_PLUGIN_TYPES:
            raise ValueError(f"Invalid plugin type: {plugin['plugin_type']}")
        if plugin.get("auth_method") and plugin["auth_method"] not in VALID_AUTH_METHODS:
            raise ValueError(f"Invalid auth method: {plugin['auth_method']}")

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
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    plugin["endpoint_url"],
                    json=sample_body,
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
        except Exception as exc:
            plugin["last_test"] = time.time()
            plugin["last_test_ok"] = False
            self._save_plugins()
            return {"success": False, "error": str(exc)}

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

        cache_key = self._cache_key(plugin["id"], {"cust_ids": sorted(cust_ids)})
        cached = self._get_cached(cache_key)
        if cached is not None:
            return cached

        try:
            headers = self._build_auth_headers(plugin)
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    plugin["endpoint_url"],
                    json={"cust_ids": cust_ids},
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
        venue_display_name.
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
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    plugin["endpoint_url"],
                    json={"subsession_id": subsession_id},
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
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    plugin["endpoint_url"],
                    json={"subsession_id": subsession_id},
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
        # Gather all cust_ids from standings
        cust_ids = [
            e["iracing_cust_id"]
            for e in frame_data.get("standings", [])
            if e.get("iracing_cust_id")
        ]
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

        # Enrich focused driver
        if focused_cust_id and focused_cust_id in driver_details:
            dd = driver_details[focused_cust_id]
            frame_data["driver_nickname"] = dd.get("nickname")
            frame_data["driver_avatar"] = dd.get("avatar")

        # Race details
        if race_details:
            frame_data["race_season"] = race_details.get("season")
            frame_data["race_week"] = race_details.get("week_number")
            frame_data["race_date"] = race_details.get("race_date")
            frame_data["venue_display_name"] = race_details.get("venue_display_name")

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
            result[ptype] = sorted(wl)
        return result

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _find_plugin(self, plugin_id: str) -> Optional[dict[str, Any]]:
        return next((p for p in self._plugins if p["id"] == plugin_id), None)

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
            expected = {"season", "race_date", "venue_display_name"}
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

    def _get_cached(self, key: str) -> Optional[Any]:
        entry = self._cache.get(key)
        if entry and (time.time() - entry["ts"]) < self._cache_ttl:
            return entry["data"]
        return None

    def _set_cached(self, key: str, data: Any) -> None:
        self._cache[key] = {"data": data, "ts": time.time()}


# ── Singleton ───────────────────────────────────────────────────────────────

data_plugin_service = DataPluginService()
