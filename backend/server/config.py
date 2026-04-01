"""
config.py
---------
Application configuration: paths, defaults, load/save.

Global settings stored in config.json at the application root.
"""

import json
import logging
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

# ── Path resolution ──────────────────────────────────────────────────────────
# APP_DIR  = next to .exe (user-writable: config, logs, data)
# BUNDLE_DIR = _internal/ when frozen (read-only bundled assets), else same as APP_DIR
if getattr(sys, "frozen", False):
    APP_DIR = Path(sys.executable).parent
    BUNDLE_DIR = Path(sys._MEIPASS)  # type: ignore[attr-defined]
else:
    APP_DIR = Path(__file__).parent.parent  # backend/
    BUNDLE_DIR = APP_DIR

STATIC_DIR = APP_DIR / "static"
CONFIG_PATH = APP_DIR / "config.json"
DATA_DIR = APP_DIR / "data"
PROJECTS_DIR = DATA_DIR / "projects"
LOG_DIR = APP_DIR / "logs"


# ── Default configuration ────────────────────────────────────────────────────
DEFAULT_CONFIG: dict = {
    "iracing_replay_dir": "",
    "default_project_dir": "",
    "capture_software": "obs",
    "capture_hotkey_start": "F9",
    "capture_hotkey_stop": "F9",
    "encoding_preset": "youtube_1080p",
    "preferred_gpu": "auto",
    "youtube_auto_upload": False,
    "youtube_default_privacy": "unlisted",
    "youtube_default_playlist": "",
    "youtube_title_template": "{{ track_name }} - {{ series_name }} Race Highlights",
    "youtube_description_template": "Race highlights from {{ track_name }} in the {{ series_name }} series.\n\nDrivers: {{ drivers }}\nDate: {{ date }}",
    "youtube_default_tags": "iracing,sim racing,highlights",
    "pipeline_default_config": None,
    "theme": "dark",
    "sidebar_collapsed": False,
}


def load_config() -> dict:
    """Load configuration from config.json, falling back to defaults."""
    if CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            # Merge with defaults so new keys are always present
            merged = {**DEFAULT_CONFIG, **data}
            return merged
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("[Settings] Corrupt config.json, using defaults: %s", exc)
    return dict(DEFAULT_CONFIG)


def save_config(config: dict) -> None:
    """Persist configuration to config.json."""
    try:
        CONFIG_PATH.write_text(
            json.dumps(config, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError as exc:
        logger.error("[Settings] Failed to save config.json: %s", exc)


def ensure_directories() -> None:
    """Create required data directories on startup."""
    for d in (DATA_DIR, PROJECTS_DIR, LOG_DIR):
        d.mkdir(parents=True, exist_ok=True)
