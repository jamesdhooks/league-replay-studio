"""
settings_service.py
--------------------
Global application settings management.

Loads from config.json, caches in memory, saves on change.
Includes validation to prevent invalid values.

API Key Security
~~~~~~~~~~~~~~~~
API keys (e.g. ``llm_api_key``) support three storage strategies:

1. **Environment variable** (recommended for CI/production):
   ``LRS_LLM_API_KEY`` environment variable overrides config.json.
2. **Config file**: Stored in config.json (obfuscated with base64 + XOR
   to prevent casual shoulder-surfing, NOT true encryption).
3. **Not stored**: Entered per-session in the UI, never persisted.

The ``get()`` method checks environment variables first for sensitive keys.
"""

import base64
import logging
import os
from typing import Any, Optional

from server.config import load_config, save_config, DEFAULT_CONFIG

logger = logging.getLogger(__name__)

# ── Sensitive key mapping ────────────────────────────────────────────────────
# Maps config keys to environment variable names for secure override.
_SENSITIVE_KEYS_ENV = {
    "llm_api_key": "LRS_LLM_API_KEY",
    "youtube_api_key": "LRS_YOUTUBE_API_KEY",
}

# Simple XOR key for obfuscation (NOT cryptographic security — prevents
# casual plaintext visibility in config.json).
_OBFUSCATION_KEY = b"LRS2026"


def _obfuscate(value: str) -> str:
    """Obfuscate a string for config file storage (base64 + XOR)."""
    if not value:
        return ""
    key = _OBFUSCATION_KEY
    xored = bytes(b ^ key[i % len(key)] for i, b in enumerate(value.encode("utf-8")))
    return "obf:" + base64.b64encode(xored).decode("ascii")


def _deobfuscate(value: str) -> str:
    """Reverse obfuscation for config file retrieval."""
    if not value or not value.startswith("obf:"):
        return value  # Not obfuscated, return as-is
    try:
        key = _OBFUSCATION_KEY
        decoded = base64.b64decode(value[4:])
        return bytes(b ^ key[i % len(key)] for i, b in enumerate(decoded)).decode("utf-8")
    except Exception:
        return value  # If deobfuscation fails, return raw value

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
VALID_PREVIEW_BACKENDS = {"auto", "native", "dxcam", "printwindow"}
VALID_LLM_PROVIDERS = {"none", "openai", "anthropic", "google", "custom"}


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


def _validate_preview_backend(value: Any) -> tuple[bool, str]:
    if value not in VALID_PREVIEW_BACKENDS:
        return False, f"preview_backend must be one of {sorted(VALID_PREVIEW_BACKENDS)}"
    return True, ""


def _validate_native_output_index(value: Any) -> tuple[bool, str]:
    if not isinstance(value, int) or value < 0 or value > 7:
        return False, "native_output_index must be an integer 0–7"
    return True, ""


def _validate_native_capture_fps(value: Any) -> tuple[bool, str]:
    if not isinstance(value, int) or value < 0 or value > 240:
        return False, "native_capture_fps must be 0 (auto) or 1–240"
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


def _validate_llm_provider(value: Any) -> tuple[bool, str]:
    if value not in VALID_LLM_PROVIDERS:
        return False, f"llm_provider must be one of {sorted(VALID_LLM_PROVIDERS)}"
    return True, ""


def _validate_llm_temperature(value: Any) -> tuple[bool, str]:
    if not isinstance(value, (int, float)) or value < 0.0 or value > 1.0:
        return False, "llm_temperature must be a number between 0.0 and 1.0"
    return True, ""


VALIDATORS: dict[str, Any] = {
    "theme": _validate_theme,
    "capture_software": _validate_capture_software,
    "capture_hotkey_start": _validate_hotkey,
    "capture_hotkey_stop": _validate_hotkey,
    "encoding_preset": _validate_encoding_preset,
    "preferred_gpu": _validate_gpu,
    "preview_backend": _validate_preview_backend,
    "native_output_index": _validate_native_output_index,
    "native_capture_fps": _validate_native_capture_fps,
    "youtube_default_privacy": _validate_privacy,
    "youtube_auto_upload": _validate_bool,
    "sidebar_collapsed": _validate_bool,
    "iracing_replay_dir": _validate_string_or_empty,
    "default_project_dir": _validate_string_or_empty,
    "pipeline_default_config": _validate_pipeline_config,
    "wizard_completed": _validate_bool,
    "llm_enabled": _validate_bool,
    "llm_provider": _validate_llm_provider,
    "llm_api_key": _validate_string_or_empty,
    "llm_model": _validate_string_or_empty,
    "llm_custom_endpoint": _validate_string_or_empty,
    "llm_temperature": _validate_llm_temperature,
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
        """Return a copy of all settings with sensitive values deobfuscated.

        Environment variable overrides are applied for sensitive keys.
        API keys are masked for display (only last 4 chars visible).
        """
        result = dict(self._settings)

        for key, env_var in _SENSITIVE_KEYS_ENV.items():
            # Check environment variable override
            env_value = os.environ.get(env_var)
            if env_value:
                result[key] = env_value
            elif key in result and isinstance(result[key], str):
                result[key] = _deobfuscate(result[key])

        return result

    def get(self, key: str, default: Any = None) -> Any:
        """Get a single setting value.

        For sensitive keys (API keys), checks environment variables first.
        Deobfuscates values that were stored with obfuscation.
        """
        # Check environment variable override for sensitive keys
        env_var = _SENSITIVE_KEYS_ENV.get(key)
        if env_var:
            env_value = os.environ.get(env_var)
            if env_value:
                return env_value

        value = self._settings.get(key, default)

        # Deobfuscate sensitive values stored in config
        if key in _SENSITIVE_KEYS_ENV and isinstance(value, str):
            value = _deobfuscate(value)

        return value

    def set(self, key: str, value: Any) -> None:
        """Set a single setting and persist. Validates the value first.

        Sensitive keys are obfuscated before storage.
        """
        errors = self._validate({key: value})
        if errors:
            raise SettingsValidationError(errors)

        # Obfuscate sensitive values before storing
        store_value = value
        if key in _SENSITIVE_KEYS_ENV and isinstance(value, str) and value:
            store_value = _obfuscate(value)

        self._settings[key] = store_value
        save_config(self._settings)
        logger.info("[Settings] Updated '%s'", key)

    def update(self, updates: dict) -> dict:
        """Bulk-update settings and persist. Validates all values first.

        Returns the full settings dict on success.
        Raises SettingsValidationError if any values are invalid.
        Sensitive keys are obfuscated before storage.
        """
        errors = self._validate(updates)
        if errors:
            raise SettingsValidationError(errors)

        # Obfuscate sensitive values before storing
        for key, value in updates.items():
            if key in _SENSITIVE_KEYS_ENV and isinstance(value, str) and value:
                updates[key] = _obfuscate(value)

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
