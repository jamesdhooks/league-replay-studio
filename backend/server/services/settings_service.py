"""
settings_service.py
--------------------
Global application settings management.

Loads from config.json, caches in memory, saves on change.
"""

import logging
from typing import Any, Optional

from server.config import load_config, save_config

logger = logging.getLogger(__name__)


class SettingsService:
    """Manages global application settings."""

    def __init__(self) -> None:
        self._settings: dict = load_config()
        logger.info("[Settings] Loaded %d settings", len(self._settings))

    def get_all(self) -> dict:
        """Return a copy of all settings."""
        return dict(self._settings)

    def get(self, key: str, default: Any = None) -> Any:
        """Get a single setting value."""
        return self._settings.get(key, default)

    def set(self, key: str, value: Any) -> None:
        """Set a single setting and persist."""
        self._settings[key] = value
        save_config(self._settings)
        logger.info("[Settings] Updated '%s'", key)

    def update(self, updates: dict) -> dict:
        """Bulk-update settings and persist. Returns the full settings dict."""
        self._settings.update(updates)
        save_config(self._settings)
        logger.info("[Settings] Bulk-updated %d keys", len(updates))
        return dict(self._settings)

    def reset_to_defaults(self) -> dict:
        """Reset all settings to defaults and persist."""
        from server.config import DEFAULT_CONFIG
        self._settings = dict(DEFAULT_CONFIG)
        save_config(self._settings)
        logger.info("[Settings] Reset to defaults")
        return dict(self._settings)


# Singleton instance — created at import time
settings_service = SettingsService()
