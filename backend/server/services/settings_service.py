"""
settings_service.py
--------------------
Global application settings management.

Loads from config.json, caches in memory, saves on change.
Includes validation to prevent invalid values.
"""

import logging
from typing import Any, Optional

from server.config import load_config, save_config, DEFAULT_CONFIG

logger = logging.getLogger(__name__)

# ── Validation rules ────────────────────────────────────────────────────────
# Each key maps to a validator function that returns (is_valid, error_message).
# Missing keys are allowed (they keep their current value).

VALID_THEMES = {"dark", "light", "system"}
VALID_CAPTURE_SOFTWARE = {"obs", "shadowplay", "relive", "manual"}
VALID_PRIVACY = {"public", "unlisted", "private"}
VALID_ENCODING_PRESETS = {
    "youtube_1080p", "youtube_1440p", "youtube_4k",
    "twitter_1080p", "archive_high", "archive_low", "custom",
}
VALID_GPU = {"auto", "nvidia", "amd", "intel", "cpu"}


def _validate_theme(value: Any) -> tuple[bool, str]:
    if value not in VALID_THEMES:
        return False, f"theme must be one of {sorted(VALID_THEMES)}"
    return True, ""


def _validate_capture_software(value: Any) -> tuple[bool, str]:
    if value not in VALID_CAPTURE_SOFTWARE:
        return False, f"capture_software must be one of {sorted(VALID_CAPTURE_SOFTWARE)}"
    return True, ""


def _validate_hotkey(value: Any) -> tuple[bool, str]:
    if not isinstance(value, str):
        return False, "hotkey must be a string"
    return True, ""


def _validate_encoding_preset(value: Any) -> tuple[bool, str]:
    if value not in VALID_ENCODING_PRESETS:
        return False, f"encoding_preset must be one of {sorted(VALID_ENCODING_PRESETS)}"
    return True, ""


def _validate_gpu(value: Any) -> tuple[bool, str]:
    if value not in VALID_GPU:
        return False, f"preferred_gpu must be one of {sorted(VALID_GPU)}"
    return True, ""


def _validate_privacy(value: Any) -> tuple[bool, str]:
    if value not in VALID_PRIVACY:
        return False, f"youtube_default_privacy must be one of {sorted(VALID_PRIVACY)}"
    return True, ""


def _validate_bool(value: Any) -> tuple[bool, str]:
    if not isinstance(value, bool):
        return False, "value must be a boolean"
    return True, ""


def _validate_string_or_empty(value: Any) -> tuple[bool, str]:
    if not isinstance(value, str):
        return False, "value must be a string"
    return True, ""


def _validate_pipeline_config(value: Any) -> tuple[bool, str]:
    if value is not None and not isinstance(value, str):
        return False, "pipeline_default_config must be a string or null"
    return True, ""


VALIDATORS: dict[str, Any] = {
    "theme": _validate_theme,
    "capture_software": _validate_capture_software,
    "capture_hotkey_start": _validate_hotkey,
    "capture_hotkey_stop": _validate_hotkey,
    "encoding_preset": _validate_encoding_preset,
    "preferred_gpu": _validate_gpu,
    "youtube_default_privacy": _validate_privacy,
    "youtube_auto_upload": _validate_bool,
    "sidebar_collapsed": _validate_bool,
    "iracing_replay_dir": _validate_string_or_empty,
    "default_project_dir": _validate_string_or_empty,
    "pipeline_default_config": _validate_pipeline_config,
    "wizard_completed": _validate_bool,
}


class SettingsValidationError(Exception):
    """Raised when one or more settings values are invalid."""

    def __init__(self, errors: dict[str, str]) -> None:
        self.errors = errors
        details = "; ".join(f"{k}: {v}" for k, v in errors.items())
        super().__init__(f"Invalid settings: {details}")


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
        """Set a single setting and persist. Validates the value first."""
        errors = self._validate({key: value})
        if errors:
            raise SettingsValidationError(errors)
        self._settings[key] = value
        save_config(self._settings)
        logger.info("[Settings] Updated '%s'", key)

    def update(self, updates: dict) -> dict:
        """Bulk-update settings and persist. Validates all values first.

        Returns the full settings dict on success.
        Raises SettingsValidationError if any values are invalid.
        """
        errors = self._validate(updates)
        if errors:
            raise SettingsValidationError(errors)
        self._settings.update(updates)
        save_config(self._settings)
        logger.info("[Settings] Bulk-updated %d keys", len(updates))
        return dict(self._settings)

    def reset_to_defaults(self) -> dict:
        """Reset all settings to defaults and persist."""
        self._settings = dict(DEFAULT_CONFIG)
        save_config(self._settings)
        logger.info("[Settings] Reset to defaults")
        return dict(self._settings)

    @staticmethod
    def _validate(updates: dict) -> dict[str, str]:
        """Validate settings values. Returns dict of {key: error_message} for failures."""
        errors: dict[str, str] = {}
        for key, value in updates.items():
            validator = VALIDATORS.get(key)
            if validator:
                is_valid, msg = validator(value)
                if not is_valid:
                    errors[key] = msg
        return errors


# Singleton instance — created at import time
settings_service = SettingsService()
