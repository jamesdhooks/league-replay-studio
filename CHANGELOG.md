# Changelog

All notable changes to League Replay Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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
