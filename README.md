# League Replay Studio

A modern, professional-grade iRacing replay editor and video production tool. Analyse your replays, detect key moments, shape highlight reels with an interactive editing suite, and export GPU-accelerated video — all from one app.

![Python](https://img.shields.io/badge/Python-3.11+-blue) ![React](https://img.shields.io/badge/React-19-61dafb) ![Platform](https://img.shields.io/badge/Platform-Windows-lightgrey) [![License: GPL v3](https://img.shields.io/badge/License-GPL%20v3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

Created by the iRacing community [Blue Flags & Dads](https://blueflagsanddads.com) — [join our Discord](https://discord.gg/fFqBerZ9rR)!

*Fan-made tool, not affiliated with iRacing.com. All trademarks belong to their respective owners.*

---

## How It Works

```
iRacing replay file (.rpy)
        ↓
Automated analysis (incidents, battles, overtakes, pit stops, fastest laps)
        ↓
Interactive highlight editing suite (tune weights, override events, live preview)
        ↓
GPU-accelerated encoding (NVENC / AMF / QSV)
        ↓
Finished video → YouTube upload (optional)
```

The app runs as a native desktop window (FastAPI + pywebview). Open a replay, let the analysis engine find the action, fine-tune your highlight reel, and export.

---

## Features

- **Step-Based Workflow** — Guided project flow: Setup → Capture → Analysis → Editing → Export → Upload. Always know what's next.
- **Highlight Editing Suite** ⭐ — Visualise the event selection algorithm, tune rule weights on the fly, make manual overrides, and watch the highlight reel update in real-time with live metrics
- **One-Click Pipeline** — Automated processing from capture to YouTube upload with pause/resume/intervene and saveable configuration presets
- **Real-Time Preview** — Scrub through recorded footage with overlays composited on top, exactly as they'll appear in the final export
- **GPU-Accelerated Encoding** — NVENC / AMF / QSV hardware encoding. A 45-minute race encodes in minutes, not hours. Multi-GPU support
- **NLE-Style Timeline** — Multi-track timeline with events, camera assignments, and cut marks. Drag, resize, right-click — works like a proper editor
- **Intelligent Auto-Direction** — Weighted camera direction engine automatically assigns cameras based on configurable per-track rules
- **HTML/Tailwind Overlays** — Leaderboard, driver tags, lap counter — all editable HTML templates with in-app Monaco editor and live preview
- **YouTube Integration** — Connect your channel, upload with templated metadata, browse past uploads
- **Non-Destructive Projects** — Everything in a SQLite project file. Full undo/redo. Resume any time
- **CLI / Headless Mode** — `lrs.bat --project ... --highlights` for scripted exports with no UI

---

## Requirements

| Requirement | Details |
|-------------|---------|
| **OS** | Windows 10/11 |
| **Python** | 3.11 or newer |
| **Node.js** | 20 or newer (for frontend build) |
| **iRacing** | Installed with replays available |
| **Capture** | OBS Studio or Nvidia ShadowPlay |
| **GPU** | NVIDIA / AMD / Intel for hardware encoding (CPU fallback available) |
| **FFmpeg** | Bundled or installed separately |

> **Note on capture:** iRacing does not expose raw frames, and in-game audio requires real-time recording. Screen capture via OBS or ShadowPlay is unavoidable — League Replay Studio makes this integration reliable with configurable hotkeys, process detection, and capture validation.

---

## Quick Start

### 1. Clone and launch

```bash
git clone https://github.com/jamesdhooks/league-replay-studio.git
cd league-replay-studio
```

Double-click one of these to start:

| Script | Description |
|--------|-------------|
| `start.bat` | First-time setup + launch (creates venv, installs deps) |
| `start-quick.bat` | Skip install checks, launch immediately |

### 2. Create a project

Open the app → **New Project** → pick a replay file → the wizard handles the rest.

### 3. Analyse

The analysis engine scans the replay at 16× speed, detecting incidents, battles, overtakes, and key moments automatically.

### 4. Edit

Use the **Highlight Editing Suite** to shape your video — tune event weights, include/exclude moments, preview the result in real-time.

### 5. Export

Pick an encoding preset (YouTube 1080p, 4K, Discord, etc.) and let the GPU handle the rest. Upload to YouTube directly from the app.

---

## CLI / Headless Mode

Once you've configured a project in the UI, export without any interface:

```bash
# Export highlights from an existing project
lrs.bat --project "C:\Projects\Daytona 500" --highlights

# Export full race video
lrs.bat --project "C:\Projects\Daytona 500" --full-race

# Run the full pipeline (capture → analyse → edit → export → upload)
lrs.bat --project "C:\Projects\Daytona 500" --full-pipeline --upload

# Use a specific export preset
lrs.bat --project "C:\Projects\Daytona 500" --highlights --preset "YouTube 1080p"
```

See the [master plan](documentation/master-plan.md#710-cli--headless-mode) for full CLI reference.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.11 + FastAPI (async, WebSocket, Pydantic) |
| Frontend | React 19 + Vite + Tailwind CSS |
| Desktop Window | pywebview (Edge WebView2) |
| iRacing SDK | pyirsdk (shared memory + Broadcasting API) |
| Video Encoding | FFmpeg (NVENC / AMF / QSV, multi-GPU) |
| Video Preview | Tiered pipeline: sprite sheets, proxy video, extracted audio |
| Overlays | HTML/Tailwind templates via Playwright headless Chromium + Jinja2 |
| Project Storage | SQLite (Python stdlib `sqlite3` — zero dependency) |
| YouTube | google-api-python-client + google-auth-oauthlib |
| Capture | OBS / Nvidia ShadowPlay (configurable hotkeys) |

---

## Project Structure

```
league-replay-studio/
├── backend/                  # Python FastAPI backend
│   ├── app.py                # Entry point (FastAPI + pywebview)
│   ├── cli.py                # CLI entry point (headless mode)
│   ├── version.py            # Single source of truth for version
│   └── server/
│       ├── services/         # Core business logic
│       └── routes/           # FastAPI route handlers
├── frontend/                 # React + Vite frontend
│   └── src/
│       ├── components/       # UI components
│       ├── context/          # React Context providers
│       ├── hooks/            # Custom hooks
│       └── services/         # API client layer
├── documentation/
│   ├── master-plan.md        # Full architecture & feature spec
│   └── agent_docs/           # Agent conventions & guidelines
├── lrs.bat                   # CLI entry point
├── start.bat                 # Windows GUI launcher
├── start-quick.bat           # Quick launch (skip install)
├── CHANGELOG.md              # Release notes
└── README.md
```

---

## Documentation

See [`documentation/master-plan.md`](documentation/master-plan.md) for the complete architecture plan including:
- Legacy analysis and modernisation strategy
- Database schema and API design
- Feature specifications with UI mockups
- 9-phase development roadmap
- Performance targets and risk assessment

---

## Heritage

League Replay Studio is the spiritual successor to [iRacingReplayDirector](https://github.com/vipoo/iRacingReplayOverlay.net), an open-source .NET WinForms application that pioneered automated iRacing replay capture and editing. The original project (and its [community fork](https://github.com/MerlinCooper/iRacingReplayDirector)) established the core concepts — automated incident/battle detection, rule-based camera direction, OBS capture orchestration — that League Replay Studio rebuilds from the ground up in a modern stack.

**Attribution**: This project is inspired by and builds upon the work of [Vipoo](https://github.com/vipoo) (original author) and [Merlin Cooper](https://github.com/MerlinCooper) (active maintainer). Both original projects are licensed under GPL-3.0.

---

## Versioning

This project uses [Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/). See [`CHANGELOG.md`](CHANGELOG.md) for release history and [`backend/version.py`](backend/version.py) for the current version.

---

## Built with AI

Built with help from [Claude AI](https://claude.ai).

---

## Support the Project

If League Replay Studio saves you time producing race videos, consider buying me a coffee:

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?style=flat&logo=buy-me-a-coffee)](https://buymeacoffee.com/jamesdhooks)

---

## Contributing

Issues and pull requests welcome. See [`documentation/master-plan.md`](documentation/master-plan.md) for the development roadmap.

---

## License

Licensed under the **GNU General Public License v3 (GPL-3.0)**. See [LICENSE](LICENSE) for full text.
