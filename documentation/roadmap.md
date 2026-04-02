# League Replay Studio — Roadmap

> **Vision:** A professional-grade iRacing replay editor that automatically detects key moments, lets you shape highlight reels with an interactive editing suite, and exports GPU-accelerated video — all from one app.
>
> **Framework:** MoSCoW prioritisation · **Generated:** 2026-03-31 · **Version:** 1.0

---

## 🤖 Agent Instructions

This document is the **single source of truth** for the build order and completion state of League Replay Studio. Every agent working on this project must read it before starting work and keep it up to date as work progresses.

### How to find the next task

1. Scan the phases in order (Phase 1 → Phase 6).
2. Within the current phase, find the **first feature** whose status is not `✅ completed`.
3. Verify all features listed under **Dependencies** are `✅ completed`. If any are not, complete them first.
4. That is your task.

### While working

- Change the feature status from `📋 planned` / `🔍 under_review` → `🔄 in progress` **before** you start writing code.
- Tick off each acceptance criterion checkbox (`- [x]`) as you implement it.
- If you discover the acceptance criteria are incomplete or incorrect, update them here before proceeding.

### When you finish

- Mark all acceptance criteria `[x]`.
- Update the feature status to `✅ completed`.
- Check whether completing this feature satisfies all features in a milestone — if so, mark that milestone `[x]` too.
- If this was the last feature in a phase, update the phase status badge to `✅ completed`.
- Commit the updated `documentation/roadmap.md` alongside your code changes.

### How to commit a feature

Each completed feature should be committed as **one clean, atomic commit** alongside the updated roadmap. Follow the project's conventional commit guidelines (see `.copilot-instructions.md`):

1. **Stage all files** related to the feature — new code, configs, scripts, and `documentation/roadmap.md`.
2. **Do not stage** runtime/user-generated files (`config.json`, `.db`, `*.log`, build outputs in `backend/static/`, `node_modules/`, `.venv/`, etc.). These are already in `.gitignore`.
3. **Commit message format:**
   ```
   feat: <short imperative summary> (Feature N)
   
   - <bullet summary of what was added/changed>
   - <another bullet>
   ```
   Example:
   ```
   feat: scaffold application shell and desktop window (Feature 1)
   
   - FastAPI backend with pywebview native window launcher
   - React 19 + Vite + Tailwind frontend shell
   - Layout: toolbar, collapsible sidebar, main area, status bar
   - Toast notification and modal dialog systems
   - WebSocket endpoint with auto-reconnect client
   - start.bat and start-quick.bat launch scripts
   ```
4. **One logical change per commit** — do not bundle unrelated work.
5. **Prefix types:** `feat:` for features, `fix:` for bug fixes, `docs:` for documentation-only, `refactor:` for restructuring, `test:` for test-only, `chore:` for tooling/config.

### ⚠️ Do not skip this document

If you close a task without updating this file, the next agent will duplicate your work or build on an incomplete foundation. **Always update before you consider a task done.**

---

### Example agent prompt

Copy and adapt the following prompt to point any agent at the next roadmap task:

```
You are an expert full-stack developer working on League Replay Studio — a professional iRacing replay editor.

Read `documentation/roadmap.md` in full. Find the next incomplete feature by:
1. Starting at Phase 1 and scanning forward.
2. Identifying the first feature that is NOT marked ✅ completed.
3. Confirming all its listed dependencies are ✅ completed (if not, work on the blocking dependency first).

Then implement that feature completely, following its description and satisfying every acceptance criterion listed.

Reference documents you MUST read before coding:
- `documentation/master-plan.md` — architecture decisions, tech stack, and design principles
- `documentation/agent_docs/` — coding conventions, API patterns, component usage, hooks, settings system, etc.
- The feature's `linked_spec_id` file under `documentation/` if one exists

As you work:
- Update the feature status in `documentation/roadmap.md` to 🔄 in progress immediately.
- Tick off each acceptance criterion [x] as you complete it.
- When fully done, mark the feature ✅ completed and update any milestone/phase that is now complete.
- Commit `documentation/roadmap.md` together with your code.

Do not consider the task finished until the roadmap reflects the completed state.
```

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Completed |
| 🔄 | In Progress |
| 🔍 | Under Review |
| 📋 | Planned |
| ⏸ | Won't do (post-v1.0) |

**Feature priority badges:** `MUST` `SHOULD` `COULD` `WONT`

---

## Phase 1 — Foundation `✅ completed`

> Establish the application skeleton — desktop window, FastAPI backend, React frontend shell, iRacing SDK connection, project system, settings, and real-time communication.

### Milestones
- [x] **M1.1** App launches in native desktop window *(features 1, 6)*
- [x] **M1.2** iRacing connection is live *(features 2, 5)*
- [x] **M1.3** Users can create and manage projects *(features 3, 4)*

---

### Feature 1 — Application Shell & Desktop Window `MUST` `✅ completed`
**Spec:** `001-application-shell-desktop-window`
**Dependencies:** none

Scaffold the full application stack: Python/FastAPI backend, React 19 + Vite + Tailwind frontend, pywebview native desktop window. Includes `start.bat`, `start-quick.bat`, responsive layout shell (toolbar, sidebar, main area, status bar), toast notifications, and modal dialogs.

**Acceptance Criteria**
- [x] Running `start.bat` launches a native desktop window displaying the React frontend
- [x] FastAPI serves the React SPA with CORS configured for local development
- [x] Layout shell renders with toolbar, collapsible sidebar, main area, and status bar
- [x] Toast notifications and modal dialogs function from the frontend
- [x] Hot module replacement works during development (Vite HMR)
- [x] pywebview window has proper title, icon, and minimum size constraints

---

### Feature 2 — iRacing SDK Bridge `MUST` `✅ completed`
**Spec:** `002-iracing-sdk-bridge`
**Dependencies:** feature-1

Integrate pyirsdk shared memory for real-time telemetry and replay control. 60 Hz background polling thread, session info parsing (drivers, track, cameras from YAML), replay control (speed, seek, camera/car switching via Broadcasting API).

**Acceptance Criteria**
- [x] App detects when iRacing is running and displays connection status in the UI
- [x] Session data (drivers, track name, camera groups, session type) is parsed and available via API
- [x] Replay speed can be set programmatically (1×, 2×, 4×, 8×, 16×)
- [x] Replay can seek to specific frame numbers
- [x] Camera can be switched to target a specific car from a specific camera group
- [x] Background polling thread reads telemetry at 60 Hz without blocking the UI
- [x] Graceful handling when iRacing disconnects mid-session

---

### Feature 3 — Project System with SQLite Storage `MUST` `✅ completed`
**Spec:** `003-project-system-with-sqlite-storage`
**Dependencies:** feature-1

Full project management backed by SQLite. New Project Wizard, project library (grid/list, search/filter), CRUD operations, and step-based workflow navigation: Setup → Analysis → Editing → Capture → Export → Upload.

**Acceptance Criteria**
- [x] New Project Wizard creates a project with name, replay file, and working directory
- [x] Replay file picker auto-discovers `.rpy` files from the iRacing replays directory
- [x] Project metadata (track, date, drivers, step) is stored in SQLite and displayed in the library
- [x] Project library supports grid and list view with search and filter by track/date/status
- [x] Step indicator bar shows workflow progress (✅✅✅🔄⏳⏳) and allows navigation
- [x] Projects can be duplicated, deleted, and reopened across app sessions
- [x] Project file browser shows the project directory tree with all intermediary files

---

### Feature 4 — Settings System `MUST` `✅ completed`
**Spec:** `004-settings-system`
**Dependencies:** feature-1

JSON config persistence and settings panel UI. Categories: General, Camera Defaults, Encoding Defaults, Hotkeys, Pipeline Defaults. Accessible via REST API and reactive in the UI.

**Acceptance Criteria**
- [x] Settings panel renders with organized categories (General, Camera, Encoding, Hotkeys, Pipeline)
- [x] Changes are persisted to a JSON config file and survive app restarts
- [x] Settings are accessible via GET/PUT REST API endpoints
- [x] Default values are sensible for new users (no mandatory initial configuration)
- [x] Theme selector (dark/light/system) applies immediately across the UI
- [x] Settings validation prevents invalid values (e.g., negative bitrates)

---

### Feature 5 — Real-Time WebSocket Communication `MUST` `✅ completed`
**Spec:** `005-real-time-websocket-communication`
**Dependencies:** feature-1

Bidirectional WebSocket infrastructure: typed event system for progress updates (analysis, encoding, capture), live data streaming (telemetry, metrics), auto-reconnect with exponential backoff.

**Acceptance Criteria**
- [x] WebSocket connection establishes automatically when the frontend loads
- [x] iRacing connection status updates appear in the UI within 1 second of state change
- [x] Typed event system supports subscribing to specific event categories
- [x] Automatic reconnection with exponential backoff on connection loss
- [x] Backend can broadcast to all connected clients (multi-tab support)
- [x] WebSocket messages are JSON-serialised with consistent schema

---

### Feature 6 — Dark Theme Design System `MUST` `✅ completed`
**Spec:** `006-dark-theme-design-system`
**Dependencies:** feature-1

Tailwind CSS dark-first design system — color tokens, typography scale, spacing system, component variants, smooth theme transitions.

**Acceptance Criteria**
- [x] Tailwind config defines color tokens for backgrounds, surfaces, borders, text, and accent colors
- [x] Dark mode is the default theme with light mode available as an option
- [x] Theme can be set to dark, light, or system (follows OS preference)
- [x] Theme transitions are smooth (no flash of unstyled content)
- [x] Typography scale and spacing system are defined and documented
- [x] All existing UI components use design tokens consistently
- [x] Gradient accent palette (indigo→violet→blue) with Tailwind `gradient` color tokens and utility classes
- [x] Gradient CTA buttons, progress bars, step indicators, logo icon, and empty-state heroes
- [x] Richer card shadows (card/card-hover), glow shadows (glow/glow-sm/glow-lg), shimmer animation
- [x] `.text-gradient`, `.border-gradient`, `.bg-noise` CSS utility classes
- [x] Inter font loaded from Google Fonts CDN with full weight range (300–900)

---

## Phase 2 — Core Analysis & Editing `✅ completed`

> Build the intelligence layer — the replay analysis engine, NLE-style timeline editor, highlight editing suite, event inspector, and undo/redo system.

### Milestones
- [x] **M2.1** Replay analysis detects all race events *(feature 7)*
- [x] **M2.2** Events visualised on an interactive timeline *(features 8, 10)*
- [x] **M2.3** Highlight reel is fully tuneable with live metrics *(features 9, 11)*

---

### Feature 7 — Replay Analysis Engine `MUST` `✅ completed`
**Spec:** `007-replay-analysis-engine`
**Dependencies:** feature-2, feature-3

Core race event detection: incidents, battles, overtakes, pit stops, fastest laps, leader changes, first/last laps. Auto-generated severity scores (0–10), frame-accurate timestamps. Scans replay at 16× speed. Streams results to frontend via WebSocket and persists to SQLite.

**Acceptance Criteria**
- [x] Analysis connects to iRacing and scans the replay at 16× speed
- [x] Incidents are detected with 15-second deduplication per car
- [x] Battles are detected using configurable gap threshold (default < 0.5 s)
- [x] Overtakes are detected with position change + proximity check
- [x] Pit stops, fastest laps, leader changes, first lap, and last lap are all detected
- [x] Each event has a severity score (0–10), frame-accurate start/end timestamps, and involved drivers
- [x] Analysis progress (events found, scan progress) streams to the frontend via WebSocket
- [x] Scan stops automatically when `SessionState == Checkered` and all cars finished
- [x] Events are persisted to SQLite and available immediately on project reopen
- [x] User can start editing before analysis completes (progressive availability)
- [x] Race session jumping via `replay_search_session_time()` skips practice/qualifying (falls back to legacy scan)
- [x] Enriched progress events stream detail text, current lap, car count, and per-detector labels
- [x] Individual `event_discovered` events stream to frontend as each event is found
- [x] Live analysis log panel in UI with level-specific icons (info, detect, success, error)
- [x] Live event particle feed shows animated chips for discovered events during analysis
- [x] iRacing window screenshot embed visible in analysis panel during scan (polling /api/iracing/screenshot)

---

### Feature 8 — NLE-Style Timeline Editor `MUST` `✅ completed`
**Spec:** `008-nle-style-timeline-editor`
**Dependencies:** feature-7

Canvas-based multi-track timeline: Camera, Events, Overlays, Cuts, Audio tracks. Zoom/pan, draggable event edges, playhead cursor, snap-to-grid, right-click context menus, J/K/L shuttle controls, I/O in/out points.

**Acceptance Criteria**
- [x] Canvas-based timeline renders multiple tracks (Camera, Events, Overlays, Cuts, Audio)
- [x] Events are color-coded by type (incidents red, battles orange, overtakes blue, etc.)
- [x] Mouse scroll zooms the timeline (1 px = 5 s overview → 1 px = 1 frame detail)
- [x] Middle-drag pans the timeline horizontally
- [x] Playhead cursor can be dragged to scrub through the race
- [x] Event edges are draggable to adjust start/end times (frame-accurate)
- [x] Right-click context menu offers split, delete, change camera, add marker
- [x] J/K/L keyboard shuttle controls work for playback speed
- [x] I/O keys set in/out points at the playhead position
- [x] Timeline updates in real-time as new events are detected during analysis

---

### Feature 9 — Highlight Editing Suite `MUST` `✅ completed`
**Spec:** `009-highlight-editing-suite`
**Dependencies:** feature-7, feature-8

**The crown-jewel differentiator.** Interactive rule weight tuning, event selection table with Reason column, manual override system, live metrics dashboard (duration, coverage %, balance, pacing, driver coverage), A/B compare mode, named config save/load.

**Acceptance Criteria**
- [x] Interactive sliders for each event type priority (0–100) with real-time reprocessing on change
- [x] Event selection table shows all events with Score, Severity, Duration, Type, Reason columns
- [x] Table is sortable by any column and filterable by event type, inclusion status, severity range
- [x] Manual override checkboxes force-include or force-exclude events from highlights
- [x] Overridden events are visually distinct from algorithm-selected events
- [x] Live metrics update within 100 ms of any parameter change: duration, coverage %, balance, pacing, driver coverage
- [x] Target duration control shows warning when highlight is over/under target
- [x] Minimum severity threshold slider instantly filters low-severity events
- [x] Auto-balance button optimises weights for even event distribution across the race
- [x] Named weight configurations can be saved and loaded for reuse across projects
- [x] A/B compare mode saves two configurations and toggles between them
- [x] Highlight timeline preview shows the condensed highlight reel with event segments
- [x] Clicking an event in the table jumps the timeline playhead to that moment

---

### Feature 10 — Event Inspector Panel `SHOULD` `✅ completed`
**Dependencies:** feature-7, feature-8

Detail panel for selected timeline events: type, severity slider, frame-accurate timestamps, involved drivers, camera/car assignment, transition type, include-in-highlight toggle, slow motion flag. Actions: Apply, Revert, Split, Delete.

**Acceptance Criteria**
- [x] Clicking an event on the timeline opens the inspector panel with all event properties
- [x] Event type can be changed via dropdown
- [x] Severity can be adjusted via slider (0–10)
- [x] Start/end timestamps can be edited with frame-accurate precision
- [x] Involved drivers are shown with checkboxes to include/exclude
- [x] Camera assignment and target car can be changed via dropdowns
- [x] Apply Changes saves edits; Revert restores original values
- [x] Split Event divides one event into two at the playhead position
- [x] Delete removes the event from the timeline and database
- [x] Changes trigger immediate timeline re-render and highlight metrics update

---

### Feature 11 — Undo/Redo System `SHOULD` `✅ completed`
**Dependencies:** feature-8, feature-9

Unlimited undo/redo across timeline, event inspector, and highlight suite. Visible edit history panel. Ctrl+Z / Ctrl+Y. Session-scoped history that resets on project close.

**Acceptance Criteria**
- [x] Ctrl+Z undoes the last editing operation across timeline, inspector, and highlight suite
- [x] Ctrl+Y / Ctrl+Shift+Z redoes an undone operation
- [x] Undo/redo works for: event property changes, event drag/resize, manual overrides, weight changes
- [x] Edit history panel shows a list of recent operations with descriptions
- [x] Undo depth is unlimited within the current session
- [x] Undo/redo state is consistent across timeline, inspector, and highlight suite views
- [x] Toolbar buttons for undo/redo show enabled/disabled state based on history

---

## Phase 3 — Video Pipeline `📋 planned`

> Build the end-to-end video production pipeline — OBS/ShadowPlay capture, GPU-accelerated FFmpeg encoding, tiered preview system, and export presets.

### Milestones
- [x] **M3.1** Automated video capture from iRacing replay *(feature 12)*
- [x] **M3.2** Users can preview recorded video with scrubbing *(feature 14)*
- [x] **M3.3** GPU-accelerated export produces final video *(features 13, 15)*

---

### Feature 12 — Video Capture & OBS Integration `MUST` `✅ completed`
**Spec:** `010-video-capture-obs-integration`
**Dependencies:** feature-2, feature-3

Auto-detect OBS Studio, NVIDIA ShadowPlay, AMD ReLive. Configurable hotkey mapping per software with validation. Automated capture orchestration synced with replay playback. Post-capture validation (integrity, resolution, duration). Internal capture engine with dxcam (DXGI) + PrintWindow backends for self-contained capture without external software.

**Acceptance Criteria**
- [x] App auto-detects running OBS, ShadowPlay, and ReLive processes
- [x] User can configure start/stop hotkeys per capture software in settings
- [x] Validation step sends test hotkey and verifies recording started via file watcher
- [x] Capture orchestration automates start/stop synced with replay playback at 1× speed
- [x] Intro capture drives scenic cameras during qualifying for title sequences
- [x] Capture file path is auto-discovered from OBS/ShadowPlay configuration
- [x] Progress UI shows real-time capture status, elapsed time, and file size
- [x] Post-capture validation checks file integrity, resolution, and duration vs expected
- [x] Clear error messages when capture software is not detected or hotkey fails
- [x] Internal CaptureEngine with multi-backend support (dxcam DXGI -> PrintWindow GDI fallback)
- [x] Zero-copy FFmpeg MJPEG pipeline (no PIL in hot path, libjpeg-turbo SIMD encoding)
- [x] Buffer protocol writes via memoryview() -- eliminates .tobytes() frame copy
- [x] dxcam target_fps native pacing (no Python sleep jitter)
- [x] Pre-allocated numpy buffers for PrintWindow (zero per-frame allocation)
- [x] Dedicated capture + reader threads with FFmpeg subprocess stdin/stdout
- [x] Dual-output: MJPEG preview + GPU H.264 NVENC recording simultaneously
- [x] start_recording() / stop_recording() with auto-detected GPU encoder (NVENC > AMF > QSV > CPU)
- [x] MJPEG streaming endpoint serves live preview from CaptureEngine singleton
- [x] Stream metrics endpoint exposes FPS, backend, uptime, resolution, recording state
- [x] Stream start/stop + record start/stop REST endpoints
- [x] Writer threads decouple capture from pipe I/O (no backpressure coupling)
- [x] Frame dropping via deque(maxlen=2) -- prefer dropping frames over latency
- [x] GPU-native recording mode via FFmpeg gdigrab (zero Python in recording hot path)
- [x] CPU pipe recording mode as fallback (capture -> queue -> writer -> FFmpeg stdin)
- [x] Auto-detect recording mode: tries GPU first, falls back to CPU
- [x] Graceful recorder shutdown (CTRL_BREAK on Windows for GPU mode, stdin close for CPU)
- [x] frames_dropped + recording_mode exposed in stream metrics
- [x] OBS/ShadowPlay hotkey-based capture still fully supported alongside internal capture

---

### Feature 13 — GPU-Accelerated Encoding Engine `MUST` `✅ done`
**Spec:** `011-gpu-accelerated-encoding-engine`
**Dependencies:** feature-7, feature-9

FFmpeg pipeline with NVENC/AMF/QSV hardware acceleration (CPU fallback). EDL → FFmpeg complex filtergraph. Multi-GPU simultaneous encode. Export presets: YouTube 1080p60, Discord 720p30, Archive 4K, Custom. Real-time progress via WebSocket.

**Acceptance Criteria**
- [x] GPU capabilities are auto-detected on startup (NVENC, AMF, QSV, or CPU fallback)
- [x] FFmpeg encodes video using hardware acceleration when available
- [x] EDL from the highlight editing suite converts to FFmpeg complex filtergraph
- [x] Both highlight reel and full race video can be encoded
- [x] Multi-GPU systems can encode two outputs simultaneously on separate GPUs
- [x] Real-time progress (FPS, percentage, ETA) streams to the frontend via WebSocket
- [x] Export presets available: YouTube 1080p60, Discord 720p30, Archive 4K, Custom
- [x] Custom presets allow user-defined codec, bitrate, resolution, and quality settings
- [x] CPU fallback encoding works when no GPU encoder is available
- [x] Batch export queue processes multiple projects sequentially
- [x] Encoding produces valid, playable MP4 files verified by post-encode check

---

### Feature 14 — Video Preview System `MUST` `✅ done`
**Spec:** `012-video-preview-system`
**Dependencies:** feature-8, feature-12

Tiered preview: (1) keyframe index ~5 s; (2) sprite sheet thumbnails ~30–60 s; (3) proxy 540p30 video ~1–3 min; (4) audio track extraction ~5 s. WebSocket 30 fps playback, full-res frame on pause, EDL-mapped highlight preview.

**Acceptance Criteria**
- [x] Keyframe index builds in ~5 seconds after file import
- [x] Sprite sheet thumbnails are generated within 30–60 seconds for a 45-min race
- [x] Timeline scrubbing uses client-side sprite sheets with 0 ms latency (no server request)
- [x] Proxy video generates in background in 1–3 minutes with progress reporting
- [x] Playback at 30 fps via WebSocket stream from proxy video with synced audio
- [x] Pausing for >1 second upgrades to full-resolution source frame
- [x] Highlight preview mode shows the condensed highlight reel mapped through EDL
- [x] Preview modes available: Full Race, Highlight Preview, Source, Split (side-by-side)
- [x] Playback speed controls: 0.25×, 0.5×, 1×, 2×
- [x] Fallback to direct source decode when proxy is not yet ready (with clear progress indicator)
- [x] Status bar shows proxy generation progress with ETA

---

### Feature 15 — Export Presets & Encoding Dashboard `SHOULD` `✅ done`
**Dependencies:** feature-13

Export preset CRUD UI and encoding dashboard: real-time FPS/percentage/ETA/file-size/GPU-utilisation metrics, auto-shutdown option, completed-exports file browser with play/reveal/copy/upload actions.

**Acceptance Criteria**
- [x] Export presets are manageable: create, edit, duplicate, delete with sensible defaults
- [x] Encoding dashboard shows real-time FPS, percentage, ETA, output file size
- [x] GPU utilisation gauge shows current encoder load
- [x] Auto-shutdown toggle is available for overnight encoding
- [x] Completed exports appear in a file browser with play, reveal, copy path actions
- [x] Preset selection is available in the export step of the project workflow

---

## Phase 4 — Overlays & Integration `📋 planned`

> HTML/Tailwind overlay templates via headless Chromium, in-app overlay editor, YouTube channel integration, and one-click automated pipeline.

### Milestones
- [x] **M4.1** Broadcast-quality overlays render on video *(feature 16)*
- [x] **M4.2** Overlays are editable in-app with live preview *(feature 17)*
- [x] **M4.3** One-click pipeline from replay to YouTube *(features 18, 19)*

---

### Feature 16 — HTML/Tailwind Overlay Template Engine `SHOULD` `✅ done`
**Dependencies:** feature-13, feature-14

Playwright headless Chromium + Jinja2 rendering. `render_frame()` ~5–15 ms/frame, `batch_render_for_export()`. Built-in template library: Broadcast, Minimal, Classic, Cinematic, Blank. Resolution-aware (1080p / 1440p / 4K). Per-project overrides.

**Acceptance Criteria**
- [x] Playwright headless Chromium initialises with persistent browser context
- [x] Jinja2 templates render with per-frame data context (positions, driver, lap, etc.)
- [x] `render_frame()` produces transparent PNG overlay in ~5–15 ms per frame
- [x] `batch_render_for_export()` pre-renders full overlay sequence to PNG files
- [x] Built-in template library includes at least 4 styles: Broadcast, Minimal, Classic, Cinematic
- [x] Templates adapt to output resolution (1080p, 1440p, 4K)
- [x] Overlay compositing works in both preview and export pipelines
- [x] Per-project template overrides don't modify the original template files
- [x] Templates can be imported, exported, duplicated with version tracking

---

### Feature 17 — In-App Overlay Editor `SHOULD` `✅ done`
**Dependencies:** feature-16

Split-pane Monaco editor (HTML/CSS, Tailwind IntelliSense) + live preview. Data context inspector, visual no-code controls (element picker, drag-reposition, resize handles), animation picker generating CSS keyframe animations.

**Acceptance Criteria**
- [x] Split-pane layout: Monaco editor on left, live preview on right
- [x] Monaco provides HTML syntax highlighting and Tailwind CSS class completion
- [x] Data context inspector shows all available Jinja2 template variables with sample values
- [x] Visual element picker allows selecting and repositioning overlay elements
- [x] Resize handles work on selected elements for visual sizing
- [x] Animation picker generates CSS keyframe animations for overlay transitions
- [x] Preview updates within 200 ms of code change (debounced live reload)
- [x] Save button persists changes; revert restores to last saved state

---

### Feature 18 — YouTube Channel Integration `SHOULD` `✅ done`
**Dependencies:** feature-13, feature-3

YouTube Data API v3. OAuth2 flow, channel status, Jinja2 description templates (`{{track_name}}`, `{{drivers}}`), resumable upload with retry, video browser with project association, quota monitoring.

**Acceptance Criteria**
- [x] OAuth2 flow connects the user's YouTube channel with token storage in OS keyring
- [x] Connection status shows in settings (connected/disconnected/expired) with refresh capability
- [x] Default upload settings configurable: privacy, playlist, title template, description template, tags
- [x] Jinja2 variables in title/description templates auto-fill from project data
- [x] Video upload is resumable — survives brief network interruptions
- [x] Upload progress (speed, percentage, ETA) displays in real-time
- [x] YouTube video browser lists uploaded videos with views, likes, and project link
- [x] Upload step in workflow pre-fills metadata from project and templates
- [x] Quota usage displayed in settings with warning when approaching daily limit
- [x] Retry with exponential backoff on upload failure

---

### Feature 19 — One-Click Automated Pipeline `SHOULD` `✅ done`
**Dependencies:** feature-7, feature-9, feature-12, feature-13, feature-18

`PipelineEngine` sequencing: Analysis → Editing → Capture → Export → Upload. Pause/resume/cancel/retry per step. Pipeline presets CRUD. Failure recovery from failed step (not from scratch). Persistent state in SQLite. CLI support.

**Acceptance Criteria**
- [x] Pipeline executes all steps sequentially: Analysis → Editing → Capture → Export → Upload
- [x] Each step can be paused, resumed, cancelled, or retried independently
- [x] Pipeline configuration presets allow saving different automation settings
- [x] Real-time pipeline progress UI shows current step, log output, and overall progress
- [x] Pipeline pauses on step failure by default (configurable: pause/skip/abort)
- [x] User can intervene mid-pipeline (e.g., tweak highlight weights between Analysis and Capture)
- [x] Pipeline state persists in SQLite — survives app crash/restart and resumes from last step
- [x] Notification on pipeline completion (toast, system notification, or none — configurable)
- [x] Pipeline integrates with YouTube upload as optional final step

---

## Phase 5 — Polish & Distribution `📋 planned`

> CLI/headless mode, PyInstaller `.exe` bundle, first-run wizard, auto-update, comprehensive error handling, configurable keyboard shortcuts.

### Milestones
- [x] **M5.1** App is scriptable from the command line *(feature 20)*
- [ ] **M5.2** Distributable installer is available *(features 21, 22, 23)* — Feature 21 ✅
- [ ] **M5.3** Application is production-quality *(features 24, 25)*

---

### Feature 20 — CLI / Headless Mode `COULD` `✅ done`
**Dependencies:** feature-7, feature-9, feature-13

`lrs.bat` CLI: `--project`, `--highlights`, `--full-race`, `--preset`, `--output`, `--analyse-only`, `--full-pipeline`, `--upload`, `--gpu`, `--verbose/-v`, `--quiet/-q`. Bypasses FastAPI/pywebview entirely. Exit codes: 0=success, 1=project error, 2=iRacing not running, 3=encoding failed.

**Acceptance Criteria**
- [x] `lrs.bat` with no arguments launches the GUI; with arguments launches CLI mode
- [x] CLI loads project from SQLite without starting FastAPI or pywebview
- [x] `--highlights` exports a highlight reel using saved project configuration
- [x] `--full-race` exports the full race video
- [x] `--preset` selects a specific export preset by name
- [x] `--full-pipeline` runs the complete automated pipeline
- [x] Progress reports to stdout: `Encoding... 45% (ETA: 2:31)`
- [x] Exit codes: 0=success, 1=project error, 2=iRacing not running, 3=encoding failed
- [x] `--quiet` suppresses all output except errors; `--verbose` enables debug logging

---

### Feature 21 — First-Run Setup Wizard `COULD` `✅ done`
**Dependencies:** feature-4, feature-12

Guided first-run: detect iRacing dir, discover OBS/ShadowPlay, configure + validate hotkeys, select GPU, set working directory, optionally connect YouTube. Re-launchable from Settings → Setup Wizard.

**Acceptance Criteria**
- [x] Wizard appears automatically on first launch (not on subsequent launches)
- [x] Step 1: Detect iRacing installation and replay directory
- [x] Step 2: Detect capture software and configure hotkeys with validation test
- [x] Step 3: Detect GPU capabilities and recommend encoding settings
- [x] Step 4: Set default project working directory
- [x] Step 5: Optional YouTube channel connection
- [x] Wizard can be skipped at any step with sensible defaults
- [x] Wizard can be re-launched from Settings → Setup Wizard

---

### Feature 22 — PyInstaller Distribution & Bundling `COULD` `🔍 under_review`
**Dependencies:** feature-1

Single-directory `.exe` bundle: Python backend, React build, FFmpeg binary, Playwright/Chromium (or first-launch download), all Python dependencies. Application icon, splash screen, Windows file associations. GitHub Releases CI builds on version tag push.

**Acceptance Criteria**
- [ ] PyInstaller produces a working single-directory `.exe` bundle
- [ ] Bundle includes FFmpeg binary for encoding
- [ ] Playwright/Chromium is either bundled or downloaded on first launch with progress indicator
- [ ] Application icon and splash screen display correctly
- [ ] Bundle size is documented and reasonable (target: under 500 MB without Chromium)
- [ ] The bundled app launches and functions identically to the dev environment
- [ ] GitHub Releases CI workflow builds the bundle on version tag push

---

### Feature 23 — Auto-Update System `COULD` `🔍 under_review`
**Dependencies:** feature-22

Checks GitHub Releases API on startup. Update notification with changelog summary. One-click download and install. Disable option in settings. Version surfaces in window title, About dialog, CLI `--version`, `/system/info` API.

**Acceptance Criteria**
- [ ] App checks GitHub Releases API for newer versions on startup
- [ ] Update notification shows version number and changelog summary
- [ ] User can download and install the update with one click
- [ ] Update check can be disabled in Settings
- [ ] Version is displayed in window title, About dialog, CLI `--version`, and API `/system/info`
- [ ] `CHANGELOG.md` follows Keep-a-Changelog format and is surfaced in the update UI

---

### Feature 24 — Error Handling & Logging System `COULD` `🔍 under_review`
**Dependencies:** feature-1

Structured Python logging with file rotation, in-app log viewer, React error boundaries, user-friendly actionable error messages (no raw stack traces). Retry buttons and fallback modes where applicable.

**Acceptance Criteria**
- [ ] All backend operations have try/except with appropriate error types and user-facing messages
- [ ] React error boundaries catch component crashes and show recovery UI
- [ ] Python logging writes to rotating log files with configurable level
- [ ] In-app log viewer shows recent logs with search and filter by level
- [ ] Error messages suggest actionable fixes (not raw stack traces)
- [ ] Failed operations are recoverable where possible (retry buttons, fallback modes)
- [ ] Log file location is documented and accessible for bug reports

---

### Feature 25 — Configurable Keyboard Shortcuts `COULD` `🔍 under_review`
**Dependencies:** feature-4, feature-8

Default bindings: Space (play/pause), J/K/L (shuttle), I/O (in/out), Ctrl+Z/Y (undo/redo), Delete (remove event), S (split). Searchable rebind UI in Settings → Hotkeys with conflict detection. Context-sensitive (timeline focus).

**Acceptance Criteria**
- [ ] Default keyboard shortcuts work out of the box (Space, J/K/L, I/O, etc.)
- [ ] All shortcuts are rebindable through the Settings → Hotkeys panel
- [ ] Shortcut list is searchable by action name or current key binding
- [ ] Conflict detection warns when a key is already assigned to another action
- [ ] In-app shortcut reference sheet is accessible via `?` key or Help menu
- [ ] Shortcuts are context-sensitive (timeline shortcuts only active when timeline has focus)

---

## Phase 6 — Future Vision `⏸ post-v1.0`

> Post-v1.0 platform extensions. These features are documented for completeness but will not be scheduled until v1.0 ships.

### Milestones
- [ ] **M6.1** Team radio enhances race videos *(feature 26)*
- [ ] **M6.2** Advanced broadcast features *(features 27, 28, 29, 31)*
- [ ] **M6.3** Community ecosystem *(feature 30)*

---

### Feature 26 — Discord Voice Chat Overlay `WONT` `⏸`
**Dependencies:** feature-16, feature-13

Craig bot per-speaker `.flac` import, Discord-to-iRacing driver mapping, manual sync point, per-speaker volume controls, visual microphone indicator, game audio ducking, FFmpeg multi-stream audio export.

---

### Feature 27 — Telemetry Data Overlays `WONT` `⏸`
**Dependencies:** feature-7, feature-16

F1 TV-style speed/throttle/brake/steering/gear/tire-temp overlays sourced from analysis-phase telemetry snapshots. Configurable channels, position/size via overlay editor.

---

### Feature 28 — Multi-Class Race Support `WONT` `⏸`
**Dependencies:** feature-7, feature-9, feature-16

Separate class leaderboards, per-class highlight generation, class-specific camera priorities, multi-class overlay templates for IMSA/Le Mans formats.

---

### Feature 29 — AI-Generated Race Commentary `WONT` `⏸`
**Dependencies:** feature-7, feature-16

LLM-generated broadcast-style commentary from event data. Configurable style (professional/casual/technical). Lower-third overlay display or TTS audio narration. Editable before render. Offline/configurable API endpoint.

---

### Feature 30 — Community Template Marketplace `WONT` `⏸`
**Dependencies:** feature-16, feature-17

Community hub for sharing/downloading overlay HTML templates. Ratings, download counts, preview screenshots, template versioning, one-click install, content moderation.

---

### Feature 31 — YouTube Chapter Markers `WONT` `⏸`
**Dependencies:** feature-18, feature-7

Auto-generate YouTube chapter markers from race events (race start, incidents, battles, pit windows, final laps, finish). User-editable titles. Auto-included when uploading via YouTube integration.

---

## Dependency Graph

```
feature-1 (App Shell)
├── feature-2 (SDK Bridge)
│   ├── feature-7 (Analysis Engine)
│   │   ├── feature-8 (Timeline Editor)
│   │   │   ├── feature-9 (Highlight Suite) ← crown jewel
│   │   │   │   ├── feature-11 (Undo/Redo)
│   │   │   │   ├── feature-13 (Encoding Engine)
│   │   │   │   │   ├── feature-15 (Export Dashboard)
│   │   │   │   │   ├── feature-16 (Overlay Engine)
│   │   │   │   │   │   ├── feature-17 (Overlay Editor)
│   │   │   │   │   │   ├── feature-26 (Discord Overlay) [future]
│   │   │   │   │   │   ├── feature-27 (Telemetry Overlays) [future]
│   │   │   │   │   │   ├── feature-28 (Multi-Class) [future]
│   │   │   │   │   │   └── feature-29 (AI Commentary) [future]
│   │   │   │   │   └── feature-18 (YouTube Integration)
│   │   │   │   │       └── feature-19 (One-Click Pipeline)
│   │   │   │   └── feature-20 (CLI Mode)
│   │   │   ├── feature-10 (Event Inspector)
│   │   │   └── feature-14 (Video Preview)
│   │   └── feature-31 (Chapter Markers) [future]
│   └── feature-12 (Video Capture)
│       └── feature-14 (Video Preview)
├── feature-3 (Project System)
│   └── feature-7, feature-12, feature-18
├── feature-4 (Settings)
│   └── feature-21 (Setup Wizard)
│   └── feature-25 (Keyboard Shortcuts)
├── feature-5 (WebSocket)
└── feature-6 (Design System)
        └── feature-22 (PyInstaller)
                └── feature-23 (Auto-Update)
feature-1 └── feature-24 (Error Handling)
```

---

## Agent Instructions

When implementing a feature, follow this checklist:

1. **Read the feature block** — understand description, rationale, and acceptance criteria
2. **Check dependencies** — all listed dependency features must be complete first
3. **Consult the spec** — if a `linked_spec_id` is listed, look for the corresponding spec file in `documentation/`
4. **Mark criteria complete** — tick off each acceptance criterion as you implement it
5. **Update the feature status** — change from `📋 planned` / `🔍 under_review` to `🔄 in progress` then `✅ completed`
6. **Update milestone status** — mark the milestone complete when all its features are done

**Current next task:** Start at the top of Phase 1 with **Feature 1 — Application Shell & Desktop Window**.
