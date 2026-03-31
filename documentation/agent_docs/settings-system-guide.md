# Settings System Guide

## Overview

League Replay Studio uses a two-tier settings system:
1. **Global settings** — stored in `config.json` at the application root (not in any project)
2. **Per-project settings** — stored in the project's SQLite database

## Global Settings (`config.json`)

Managed by `SettingsService`. Loaded at startup, cached in memory, saved on change.

### Categories

| Category | Examples |
|----------|---------|
| **Paths** | iRacing install dir, replay dir, default project dir, FFmpeg path |
| **Capture** | Default capture software, hotkeys, output path |
| **Encoding** | Default preset, GPU preference |
| **YouTube** | OAuth tokens (encrypted), default privacy, default description template |
| **Pipeline** | Default config preset, auto-start preference, notification settings |
| **UI** | Theme, sidebar width, panel sizes, keyboard shortcuts |

### Settings API

```python
# GET /api/settings — returns all settings
# PUT /api/settings — update settings (partial update)
# GET /api/settings/youtube — YouTube-specific settings
# PUT /api/settings/youtube — update YouTube settings
```

### Backend Pattern

```python
import json
from pathlib import Path

class SettingsService:
    def __init__(self, config_path: Path = Path("config.json")):
        self.config_path = config_path
        self._settings = self._load()

    def _load(self) -> dict:
        if self.config_path.exists():
            return json.loads(self.config_path.read_text())
        return self._defaults()

    def _defaults(self) -> dict:
        return {
            "iracing_replay_dir": "",
            "default_project_dir": "",
            "capture_software": "obs",
            "capture_hotkey_start": "F9",
            "capture_hotkey_stop": "F9",
            "encoding_preset": "youtube_1080p",
            "preferred_gpu": "auto",
            "youtube_auto_upload": False,
            "youtube_default_privacy": "unlisted",
            "pipeline_default_config": None,
            "theme": "dark",
        }

    def get(self, key: str, default=None):
        return self._settings.get(key, default)

    def set(self, key: str, value):
        self._settings[key] = value
        self._save()

    def update(self, updates: dict):
        self._settings.update(updates)
        self._save()

    def _save(self):
        self.config_path.write_text(json.dumps(self._settings, indent=2))
```

## Per-Project Settings

Stored in `project_meta` table within each project's SQLite database:

```sql
SELECT value FROM project_meta WHERE key = 'overlay_template';
SELECT value FROM project_meta WHERE key = 'encoding_preset';
```

Per-project settings override global defaults.

## Frontend Settings Context

```jsx
const { settings, updateSetting } = useSettings();

// Read
const captureHotkey = settings.capture_hotkey_start;

// Update
updateSetting('capture_hotkey_start', 'F10');
```

## Sensitive Data

- **YouTube OAuth tokens**: stored in `config.json` but should be encrypted at rest
- **API keys**: stored in `config.json`, never committed to git
- `config.json` is listed in `.gitignore`

## Best Practices

1. Always provide sensible defaults — the app should work with zero configuration
2. Validate settings on load — corrupt `config.json` should fall back to defaults
3. Settings changes are applied immediately — no "save and restart"
4. Show a confirmation toast when settings are saved
5. YouTube disconnect should clear tokens from config
