# Changelog

All notable changes to League Replay Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed
- **Scan progress bars**: Backend now emits `progress_percent` during the telemetry scan loop, mapping 8%→49% based on elapsed race time. Previously the bar jumped from 12% to 80% with no updates during the entire scan.
- **Post-checkered events**: Events like leader_change no longer fire after the checkered flag. A post-processing filter in `_detect_events` removes any events starting after the first CHECKERED tick (race_finish, last_lap, etc. are exempt).
- **Event truncation**: All frontend `fetchEvents` calls now use `limit: 50000` instead of `limit: 1000`, which was overwriting the full event list with only the first 1000 events sorted by time — causing events to appear truncated to ~10 minutes in dense races.

### Improved
- **Step indicator progress bar**: The pipeline step selector in the toolbar now shows a thin progress bar under the active "Analysis" step during scan/detection.
- **Progress bar normalization**: Telemetry and Events phase cards now show 0→100% local progress instead of the raw global percentage.
- **Playback transport controls**: Bigger icons (14→18px), larger play/pause button (16→20px icon, rounded-xl), more padding throughout. Speed buttons upgraded from text-xxs to text-xs.
- **Time/lap display**: Session time and lap counter moved to the left of transport controls, rendered at text-sm with font-semibold for much better readability.
- **Lap +/- buttons**: Now use proper Plus/Minus icons inside bordered button-style containers (w-6 h-6, bg-white/8, border). Fixed bug where "next lap" used a rotated Minus icon instead of Plus.
- **Event focus header**: Close button moved to right side with "Close" label + X icon, styled as a proper button. Driver names no longer truncated (`max-w-[60px] truncate` and `max-w-[120px]` removed). Event timespan details (start–end times, duration) now shown with a Clock icon.
- **Timeline marker hover**: Markers grow larger on hover (w-1.5→w-4, h-4→h-9) with stronger white glow effect (3-layer shadow).

---

## [0.1.0-alpha] — 2026-03-31

### Added
- **Master plan** (`documentation/master-plan.md`) — comprehensive architecture and feature specification covering:
  - Legacy iRacingReplayDirector analysis and modernisation strategy
  - Full technology stack: Python 3.11 / FastAPI + React 19 / Vite / Tailwind + pywebview
  - Normalised telemetry schema (`race_ticks`, `car_states`, `lap_completions`)
  - iRacing shared memory bridge via `pyirsdk` with 60Hz polling
  - 8 event detectors: incident, battle, overtake, pit stop, fastest lap, leader change, first/last lap, restart
  - Intelligent camera direction engine with per-track weighted rules
  - GPU-accelerated encoding (NVENC / AMF / QSV) with multi-GPU parallel export
  - Tiered video preview system: keyframe index, sprite sheets, proxy video, extracted audio
  - Highlight editing suite — interactive rule weight tuning, manual overrides, live metrics, A/B compare
  - HTML/Tailwind overlay template engine via Playwright headless Chromium
  - In-app Monaco Editor for overlay editing with live preview
  - Step-based project workflow (Setup → Capture → Analysis → Editing → Export → Upload)
  - One-click automated pipeline with pause/resume/cancel, per-step failure recovery, configuration presets
  - YouTube channel integration: OAuth, resumable upload, templated metadata, video browser
  - CLI / headless mode (`lrs.bat --project ... --highlights`)
  - Discord voice chat overlay design (future feature)
  - NLE-style timeline editor specification
  - REST API + WebSocket design (complete endpoint listing)
  - 9-phase development roadmap
  - Performance targets and risk assessment
  - Versioning and release process
- **Agent documentation** (`documentation/agent_docs/`) — 10 curated guides:
  - Agent documentation best practices
  - RIPER-5 operational protocol
  - API conventions (snake_case, Pydantic, route patterns)
  - UI conventions (toast/modal system, dark theme, keyboard shortcuts, animation)
  - Testing guidelines (pytest, FastAPI TestClient, Vitest, mocking strategies)
  - Logging conventions (prefixed, essential-only)
  - React Context system (no prop drilling)
  - Component usage patterns
  - Custom hooks guide
  - Settings system guide
- **Copilot instructions** (`.copilot-instructions.md`) — project-specific rules for AI agents
- **Project scaffolding**: repository structure, `.gitignore`, `README.md`, `CHANGELOG.md`
- **Version system**: `backend/version.py` as single source of truth
