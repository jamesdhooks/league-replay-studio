# League Replay Studio — Master Plan

> **Purpose**: This is the comprehensive architecture, feature specification, and development roadmap for League Replay Studio. It serves as the single source of truth for an AI agent building this project from scratch. Every section is self-contained and implementation-ready.

---

## Executive Summary

A ground-up rewrite of the legacy iRacingReplayDirector (.NET WinForms) into a modern, hybrid desktop application with a React web frontend and Python backend. **League Replay Studio** delivers a professional-grade NLE-style timeline editor for iRacing replays centred around a **powerful highlight editing suite** — where users can visualize, tune, and manually override the event selection algorithm with live preview and real-time metrics. Combined with GPU-accelerated encoding (multi-GPU), full-length video preview with overlay compositing, intelligent auto-direction, fine-grained editing controls, a step-based project workflow with one-click automated processing, and direct YouTube channel integration — all wrapped in a slick, responsive UI.

---

## 1. Legacy Analysis — What Exists Today

### 1.1 Architecture

| Layer | Technology | Issues |
|-------|-----------|--------|
| UI | .NET WinForms (C#) | Clunky tab-based layout, no preview, modal dialogs, no drag-and-drop |
| iRacing SDK | iRacingSDK (C# wrapper) | Tightly coupled to UI thread, blocking calls |
| Video Capture | External software (OBS/Nvidia via Alt+F9 hotkey) | Fragile keystroke automation, no configurability/validation, hard-coded hotkey |
| Race Analysis | In-process at 16× replay speed | Must play entire replay in real-time to analyse — extremely slow |
| Transcoding | MediaFoundation (.NET) | CPU-only, H.264 only, single-threaded encoding, slow |
| Overlays | Plugin DLLs (GDI+ System.Drawing) | DLL security blocking issues, GDI+ limited, no GPU acceleration |
| Data Format | XML `.replayscript` + JSON sidecar | Custom serialization, no versioning, fragile |

### 1.2 Workflow (Current)

```
1. Open iRacing replay + OBS
2. Configure track cameras (% ratios per camera)
3. Click "Begin Capture"
   → App plays replay at 16× to analyse incidents/battles
   → App replays at 1× while OBS records (full length!)
4. Wait for entire replay to finish recording
5. Click "Encode"
   → MediaFoundation transcodes with GDI+ overlay (CPU only)
   → Creates full video + highlight video
6. Upload to YouTube manually
```

**Total time for a 45-minute race: 2–4 hours**

In League Replay Studio, this becomes a **step-based workflow** (Setup → Analysis → Editing → Capture → Export → Upload) that can be run interactively step-by-step, or fully automated via a **one-click pipeline** (see Sections 4.1, 7.12, 7.13).

> **Critical workflow insight from the legacy app:** The original iRacingReplayDirector **always** analysed the replay first (rewinding to the race start and fast-forwarding at 16× to detect all events), and **then** captured video at 1× speed using those analysis results to direct cameras. Video capture never comes before analysis. Our enhanced workflow inserts an Editing step between Analysis and Capture so the user can tune highlights, configure cameras, and make manual overrides before the guided capture begins.

### 1.3 Features to Preserve

- Incident detection (driver off-track / spins / contact)
- Battle detection (close proximity, position changes)
- First-lap / last-lap special handling
- Automatic camera direction with weighted random selection
- Camera angle classification (LookingInfrontOfCar, LookingBehindCar, LookingAtCar, LookingAtTrack)
- Race start / incident / last lap camera presets per track
- Track camera configuration persistence
- Leaderboard overlay with driver positions
- Fastest lap tracking
- Pit stop counting
- Intro sequence with qualifying positions
- Outro sequence with final results
- Highlight video generation (automatic cut selection)
- Commentary message system
- Configurable battle gap, sticky period, camera sticky period
- Working folder / project management
- Settings persistence

### 1.4 Pain Points to Eliminate

| Problem | Impact |
|---------|--------|
| MediaFoundation CPU encoding | Encoding takes longer than the race itself |
| No preview of any kind | Cannot see results until encoding completes |
| No highlight editing suite | Cannot tweak event selection algorithm, make manual overrides, or preview result |
| WinForms UI | Unintuitive, dated, no responsive design |
| OBS keystroke automation is fragile | Hard-coded hotkey, no process detection, no validation, no multi-software support |
| GDI+ overlays | Low quality, no transparency, no GPU acceleration |
| Plugin DLL security blocking | Windows prevents loading, requires manual unblocking |
| No fine-grained editing | Cannot adjust individual event timing, cameras, or cuts |
| No undo/redo | Destructive workflow |
| Cannot save/resume projects | Must redo everything from scratch each session |

> **Note:** Recording the replay at 1× speed is an accepted constraint — iRacing does not expose raw frames and we need the in-game audio. Capture can be done internally via our CaptureEngine (3-tier: native C++ DXGI → dxcam → PrintWindow GDI → FFmpeg NVENC encoding) or externally through OBS/Nvidia ShadowPlay via hotkeys. The internal engine automatically selects the fastest available backend: a compiled native C++ service for zero-overhead DXGI capture, dxcam as a Python DXGI fallback, and PrintWindow as a GDI safety net. The real wins are in the **encoding pipeline**, **preview system**, and **highlight editing workflow**.

---

## 2. Vision — League Replay Studio

### 2.1 Core Concept

> A professional-grade iRacing replay editor that feels like a lightweight NLE (non-linear editor) — with an intelligent auto-director that does 90% of the work, and a **full highlight editing suite** for tuning the event selection algorithm on the fly, making manual overrides, and previewing the result with live-updating metrics. Fine-grained editing controls let you shape every cut, camera angle, and overlay to perfection.

### 2.2 Key Differentiators

1. **Full highlight editing suite** — Visualize the event selection algorithm, tune rule weights on the fly, make manual overrides, reprocess instantly, with live preview and real-time metrics (duration, event counts by type, coverage %)
2. **Real-time preview** — Scrub through the timeline and see exactly what the output looks like with overlays composited on recorded video
3. **GPU-accelerated encoding** — NVENC / AMF / QSV hardware encoding, multi-GPU support — encoding a 45-min race in minutes, not hours
4. **Non-destructive editing** — Everything is parametric, stored as a project file
5. **Full-length video preview** — Preview the complete encoded result with overlays before committing to a final export
6. **Timeline-based editing** — NLE-style timeline with events, cuts, camera changes, overlays
7. **Improved OBS integration** — Configurable capture hotkeys, process detection, multi-software support (OBS, Nvidia ShadowPlay, etc.)
8. **Modern web UI** — React + Tailwind CSS in a native desktop window (pywebview)
9. **HTML/Tailwind overlay engine** — Every overlay is an editable `.html` file with Tailwind CSS, rendered via headless Chromium. Design, tweak, and preview overlays in-app with a Monaco editor and live preview — or create entirely new templates from scratch
10. **YouTube channel integration** — Link your YouTube channel, browse uploaded videos alongside their source projects, and auto-upload highlights/full race directly from the export step
11. **Step-based project workflow** — Every race is a project with clear phases: Analysis → Editing → Capture → Export → Upload. The UI flows intuitively between steps, with a file browser for all intermediary and output files
12. **One-click automated pipeline** — Hit "Go" and the app steps through the entire workflow automatically, with the ability to pause, intervene, tweak, and resume at any point — plus full failure recovery per step

---

## 3. Technology Stack

### 3.1 Architecture Overview

```
┌───────────────────────────────────────────────────────────────┐
│                    NATIVE DESKTOP WINDOW                       │
│                   (pywebview / Chromium)                       │
├───────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │              REACT FRONTEND (Vite + Tailwind)           │  │
│  │                                                          │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │  │
│  │  │ Project  │ │ Timeline │ │ Preview  │ │ Export    │  │  │
│  │  │ Manager  │ │ Editor   │ │ Viewport │ │ Settings  │  │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │  │
│  │  │ Camera   │ │ Overlay  │ │ Event    │ │ Track     │  │  │
│  │  │ Director │ │ Designer │ │ Inspector│ │ Cameras   │  │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │  │
│  └─────────────────────────────────────────────────────────┘  │
│                            │ REST + WebSocket                  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │               PYTHON BACKEND (FastAPI)                   │  │
│  │                                                          │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │  │
│  │  │ iRacing  │ │ Replay   │ │ Encoding │ │ Project   │  │  │
│  │  │ Bridge   │ │ Analyser │ │ Engine   │ │ Manager   │  │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │  │
│  │  │ Video    │ │ Overlay  │ │ Camera   │ │ Highlight │  │  │
│  │  │ Preview  │ │ Renderer │ │ AI       │ │ Editor    │  │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │  │
│  └─────────────────────────────────────────────────────────┘  │
│                            │                                   │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                   SYSTEM LAYER                           │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐ │  │
│  │  │ iRacing  │ │ GPU      │ │ FFmpeg   │ │ Capture   │ │  │
│  │  │ SDK/Mem  │ │ (NVENC/  │ │ (libx264 │ │ Engine    │ │  │
│  │  │ Map      │ │  AMF/QSV)│ │  /libx265│ │ (dxcam/PW)│ │  │
│  │  └──────────┘ └──────────┘ │  /AV1)   │ └───────────┘ │  │
│  │                             └──────────┘               │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

### 3.2 Backend — Python

| Component | Library | Purpose |
|-----------|---------|---------|
| **Web Framework** | FastAPI | Async REST API + WebSocket for real-time updates |
| **iRacing Interface** | irsdk (`pip install irsdk`) | Python iRacing SDK — shared memory telemetry + Broadcasting API for replay/camera control |
| **Video Encoding** | FFmpeg (via ffmpeg-python) | GPU-accelerated encoding (NVENC, AMF, QSV) |
| **Frame Capture** | Native C++ DXGI service + dxcam (Python DXGI) + PrintWindow fallback; OBS / Nvidia ShadowPlay optional | Internal 3-tier capture engine with automatic backend selection; external capture via user's recording software |
| **Capture Control** | CaptureEngine (multi-threaded) + pyautogui / pynput | Internal capture engine or configurable hotkey automation with validation |
| **Image Processing** | Pillow / OpenCV | Frame manipulation, overlay compositing (alpha_composite) |
| **Overlay Rendering** | Playwright (headless Chromium) + Jinja2 | HTML/Tailwind templates → transparent PNG frames (see Section 7.6) |
| **Template Editing** | Monaco Editor (frontend) | In-app HTML/Tailwind overlay editor with live preview |
| **Project Storage** | SQLite (Python stdlib `sqlite3`) + optional `aiosqlite` | Local project database — zero external dependencies |
| **Config** | JSON config files | Settings persistence (mirrors livery-ai-studio pattern) |
| **Desktop Window** | pywebview | Native Chromium window wrapping the React frontend |
| **Task Queue** | asyncio + threading | Background encoding jobs with progress reporting |
| **GPU Detection** | GPUtil / pynvml | Multi-GPU detection and workload distribution |
| **YouTube Upload** | google-api-python-client + google-auth-oauthlib | YouTube Data API v3: channel info, video listing, resumable uploads |
| **Logging** | Python logging | Structured logging with file rotation |

**Why Python over C#/.NET?**

1. **FFmpeg integration** — Python's ffmpeg-python gives surgical control over GPU encoding pipelines
2. **pyirsdk** — Mature, maintained Python iRacing SDK with shared memory access
3. **Async-native** — FastAPI + asyncio handles concurrent operations (preview serving, encoding, iRacing monitoring) naturally
4. **Hybrid app pattern** — Proven in livery-ai-studio: Flask/FastAPI + pywebview + React = native desktop app
5. **GPU libraries** — PyTorch, CuPy, pycuda available if we need GPU-accelerated processing
6. **Cross-team knowledge** — Aligns with existing Blue Flags & Dads tech stack
7. **Rapid iteration** — No compilation step, hot-reload for backend development

### 3.3 Frontend — React + Vite + Tailwind

| Component | Library | Purpose |
|-----------|---------|---------|
| **Framework** | React 19 | Component-based UI |
| **Build Tool** | Vite | Fast HMR, dev server, production builds |
| **Styling** | Tailwind CSS | Utility-first styling, consistent design system |
| **State Management** | React Context + Zustand | Global state for project, settings, timeline |
| **Animation** | Framer Motion | Smooth transitions, drag interactions |
| **Timeline** | Custom (Canvas + React) | NLE-style timeline component |
| **Drag & Drop** | @dnd-kit/core | Draggable timeline events, camera assignments |
| **Icons** | React Icons (Lucide) | Consistent iconography |
| **Toast Notifications** | Custom (per reference patterns) | Non-blocking user feedback |
| **Modals** | Custom modal system | Confirmation dialogs, settings panels |
| **WebSocket Client** | Native WebSocket API | Real-time updates from backend |
| **HTTP Client** | fetch API | REST communication with backend |

### 3.4 Development & Distribution

| Concern | Solution |
|---------|----------|
| **Dev Mode** | `start.bat --auto-load` → Vite HMR + FastAPI with hot-reload |
| **Production Build** | Vite builds React → `static/` → PyInstaller bundles everything |
| **Distribution** | Single `.exe` installer (PyInstaller onedir) |
| **Auto-Update** | GitHub Releases + built-in update checker |
| **Logging** | File-based logging in app directory (same pattern as livery-ai-studio) |

---

## 4. Application Architecture — Deep Dive

### 4.1 Project System — Step-Based Workflow

Everything revolves around a **Race Project** — a self-contained workspace for processing one replay session. Each project follows a clear, linear workflow with defined steps. The UI flows intuitively between steps, with the ability to jump back to any completed step to review or adjust.

#### 4.1.1 Project Lifecycle Steps

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  1. SETUP │───▸│ 2. CAPTURE│───▸│3. ANALYSIS│───▸│4. EDITING │───▸│ 5. EXPORT │───▸ 6. UPLOAD
│           │    │          │    │          │    │          │    │          │    (YouTube)
│ Create    │    │ Record   │    │ Detect   │    │ Tune &   │    │ Encode   │
│ project,  │    │ replay   │    │ events,  │    │ preview, │    │ with GPU,│
│ pick      │    │ via OBS/ │    │ scan     │    │ highlight│    │ produce  │
│ replay    │    │ Shadow-  │    │ telemetry│    │ editor,  │    │ MP4      │
│ file      │    │ Play     │    │          │    │ overlays │    │ files    │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
     ▲               │               │               │               │
     └───────────────┴───────────────┴───────────────┴───────────────┘
                    Can jump back to any completed step
```

| Step | Name | Status Indicators | Entry Condition |
|------|------|-------------------|-----------------|
| 1 | **Setup** | Project created, replay file selected | Always available |
| 2 | **Capture** | OBS recording complete, capture file validated | Replay file available |
| 3 | **Analysis** | Events detected, telemetry stored | Capture file present |
| 4 | **Editing** | Events reviewed, highlights configured, overlays set | Analysis complete |
| 5 | **Export** | Encoding complete, files on disk | Edit decisions finalised |
| 6 | **Upload** | Published to YouTube (optional) | Export files exist |

The UI prominently shows which step the project is on, with a **step indicator bar** at the top of the project view. Completed steps show a green check, the active step is highlighted, and future steps are greyed out.

#### 4.1.2 Replay File Picker

The first action in a new project is selecting the replay file. The system provides a **smart replay file picker**:

- **Auto-discover**: Scan iRacing's default replay directory (`Documents/iRacing/replays/`) for `.rpy` files
- **Manual browse**: Standard file picker for replays stored elsewhere
- **Copy to project**: Option to copy the replay `.rpy` file into the project directory (recommended for portability) or reference in-place
- **Metadata extraction**: Parse replay file header for track name, session type, date, and driver count — auto-populate project fields

#### 4.1.3 Project Directory Structure

```
project/
├── project.json              # Project metadata, version, creation date, current step
├── project.db                # SQLite database (race_ticks, car_states, events, cameras, edits, overlays)
├── session_data.json         # Captured iRacing session data (drivers, qualifying, etc.)
├── replay/
│   └── race.rpy              # iRacing replay file (copied or symlinked)
├── captures/
│   ├── intro_001.mp4         # Captured intro footage
│   └── race_001.mp4          # Captured race segments (source — 5-15 GB)
├── preview/
│   ├── proxy.mp4             # 540p30 proxy video (300-800 MB, 0.5s keyframes)
│   ├── audio.m4a             # Extracted audio track (~50-100 MB, stream copy)
│   ├── keyframe_index.bin    # Keyframe timestamp → byte offset map (~100 KB)
│   └── sprites/
│       ├── sprite_0000.jpg   # Thumbnail sprite sheet (300 thumbs per sheet)
│       ├── sprite_0001.jpg   # ...additional sheets as needed
│       └── sprite_index.json # Second → (sheet, x, y) coordinate map
├── exports/
│   ├── full_race.mp4         # Exported full race video
│   └── highlights.mp4        # Exported highlight reel
├── logs/
│   └── pipeline.log          # Step-by-step pipeline execution log
└── overlays/
    ├── active_template.json  # Which template is active + per-project overrides
    ├── templates/            # Overlay HTML/Tailwind templates
    │   ├── broadcast.html    # Built-in: full broadcast look (copied from defaults)
    │   ├── minimal.html      # Built-in: clean minimal overlays
    │   ├── classic.html      # Built-in: retro iRacing style
    │   ├── cinematic.html    # Built-in: film-style lower-thirds
    │   └── custom_*.html     # User-created or modified templates
    ├── rendered/             # Pre-rendered PNG sequence (export-time cache)
    └── assets/               # User-imported graphics (logos, watermarks)
```

#### 4.1.4 Project File Browser

The frontend includes a **project file browser** panel that provides clear visibility into all files associated with the project:

```
┌─────────────────────────────────────────────────────────────┐
│ 📁 PROJECT FILES — Daytona 500 Sprint Race                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ 🏁 REPLAY                                                    │
│   └── race.rpy                          (245 MB, copied)    │
│                                                              │
│ 🎬 CAPTURES                                    Step 4       │
│   ├── intro_001.mp4                     (120 MB, 0:32)      │
│   └── race_001.mp4                      (8.4 GB, 44:21)     │
│                                                              │
│ 🔍 PREVIEW ASSETS                              Auto-generated│
│   ├── proxy.mp4                         (520 MB, 540p30)    │
│   ├── audio.m4a                         (68 MB)             │
│   ├── keyframe_index.bin                (92 KB)             │
│   └── sprites/ (9 sheets)              (12 MB total)        │
│                                                              │
│ 📤 EXPORTS                                     Step 5       │
│   ├── full_race.mp4                     (1.2 GB, 44:21)     │
│   └── highlights.mp4                    (210 MB, 5:02)  ✅ ▸│
│                                                              │
│ 🎨 OVERLAYS                                                  │
│   ├── broadcast.html                    (active template)    │
│   └── assets/ (2 files)                                      │
│                                                              │
│ 📋 LOGS                                                      │
│   └── pipeline.log                      (view)               │
│                                                              │
│ [Open in Explorer] [Clean Up Preview Assets] [Archive]       │
└─────────────────────────────────────────────────────────────┘
```

Each file shows size, type, and relevant metadata. Export files show upload status (✅ = uploaded to YouTube). Click any file to preview or open externally.

### 4.2 Project Database Schema (SQLite)

```sql
-- Core tables
CREATE TABLE project_meta (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    iracing_session_id INTEGER,
    track_name TEXT,
    track_id INTEGER,
    session_type TEXT,  -- 'race', 'qualifying', 'practice'
    num_laps INTEGER,
    num_drivers INTEGER,
    replay_file_path TEXT,
    current_step TEXT DEFAULT 'setup',  -- 'setup', 'analysis', 'editing', 'capture', 'export', 'upload'
    pipeline_config_id INTEGER REFERENCES pipeline_configs(id),  -- active config preset
    version TEXT DEFAULT '1.0.0'
);

-- Driver data captured from session
CREATE TABLE drivers (
    id INTEGER PRIMARY KEY,
    car_idx INTEGER NOT NULL,
    car_number TEXT,
    user_name TEXT,
    team_name TEXT,
    car_name TEXT,
    car_class TEXT,
    iracing_cust_id INTEGER,
    qualifying_position INTEGER,
    finish_position INTEGER,
    is_preferred BOOLEAN DEFAULT FALSE
);

-- Race events detected during analysis
CREATE TABLE race_events (
    id INTEGER PRIMARY KEY,
    event_type TEXT NOT NULL,  -- 'incident', 'battle', 'overtake', 'pit_stop',
                               -- 'first_lap', 'last_lap', 'restart', 'penalty',
                               -- 'fastest_lap', 'leader_change', 'dnf'
    start_time_seconds REAL NOT NULL,
    end_time_seconds REAL NOT NULL,
    start_frame INTEGER,
    end_frame INTEGER,
    lap_number INTEGER,
    severity INTEGER DEFAULT 0,     -- 0-10 importance score
    involved_drivers TEXT,          -- JSON array of car_idx
    position INTEGER,               -- Race position of primary driver
    description TEXT,
    auto_detected BOOLEAN DEFAULT TRUE,
    user_modified BOOLEAN DEFAULT FALSE,
    included_in_highlight BOOLEAN DEFAULT TRUE,
    metadata TEXT                    -- JSON blob for event-specific data
);

-- Camera assignments on the timeline
CREATE TABLE camera_assignments (
    id INTEGER PRIMARY KEY,
    start_time_seconds REAL NOT NULL,
    end_time_seconds REAL NOT NULL,
    camera_group TEXT NOT NULL,     -- 'TV1', 'Chase', 'Cockpit', etc.
    camera_angle TEXT,              -- 'front', 'rear', 'looking_at', 'track'
    target_car_idx INTEGER,
    target_position INTEGER,        -- Follow position N instead of specific car
    transition_type TEXT DEFAULT 'cut',  -- 'cut', 'fade', 'dissolve'
    auto_assigned BOOLEAN DEFAULT TRUE,
    user_modified BOOLEAN DEFAULT FALSE
);

-- Track camera configuration (persists across projects)
CREATE TABLE track_cameras (
    id INTEGER PRIMARY KEY,
    track_name TEXT NOT NULL,
    camera_name TEXT NOT NULL,
    camera_group_num INTEGER,
    camera_angle TEXT,              -- 'front', 'rear', 'looking_at', 'track'
    ratio INTEGER DEFAULT 0,       -- Weight for random selection (0-100)
    is_race_start BOOLEAN DEFAULT FALSE,
    is_incident BOOLEAN DEFAULT FALSE,
    is_last_lap BOOLEAN DEFAULT FALSE,
    is_scenic BOOLEAN DEFAULT FALSE
);

-- Overlay template configuration
CREATE TABLE overlay_config (
    id INTEGER PRIMARY KEY,
    active_template TEXT NOT NULL,   -- filename: 'broadcast.html', 'minimal.html', etc.
    template_source TEXT,            -- full HTML source (NULL = use file from templates/ dir)
    enabled BOOLEAN DEFAULT TRUE,
    custom_variables TEXT,           -- JSON: user-defined template variable overrides
    resolution_width INTEGER DEFAULT 1920,
    resolution_height INTEGER DEFAULT 1080,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Edit decision list — the final cut
CREATE TABLE edit_decisions (
    id INTEGER PRIMARY KEY,
    decision_type TEXT NOT NULL,    -- 'include', 'exclude', 'speed_ramp'
    start_time_seconds REAL NOT NULL,
    end_time_seconds REAL NOT NULL,
    playback_speed REAL DEFAULT 1.0,
    fade_in_duration REAL DEFAULT 0,
    fade_out_duration REAL DEFAULT 0,
    order_index INTEGER,
    source TEXT DEFAULT 'auto',     -- 'auto' or 'manual'
    race_event_id INTEGER REFERENCES race_events(id)
);

-- Export presets
CREATE TABLE export_presets (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    resolution_width INTEGER DEFAULT 1920,
    resolution_height INTEGER DEFAULT 1080,
    frame_rate INTEGER DEFAULT 60,
    video_codec TEXT DEFAULT 'h264_nvenc',
    audio_codec TEXT DEFAULT 'aac',
    video_bitrate_mbps REAL DEFAULT 15.0,
    audio_bitrate_kbps INTEGER DEFAULT 192,
    container TEXT DEFAULT 'mp4',
    hardware_accel TEXT DEFAULT 'auto',  -- 'nvenc', 'amf', 'qsv', 'cpu', 'auto'
    two_pass BOOLEAN DEFAULT FALSE,
    is_highlight BOOLEAN DEFAULT FALSE,
    highlight_target_duration_seconds INTEGER DEFAULT 300
);

-- Undo/redo history
CREATE TABLE edit_history (
    id INTEGER PRIMARY KEY,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    action_type TEXT NOT NULL,
    target_table TEXT NOT NULL,
    target_id INTEGER,
    before_state TEXT,              -- JSON snapshot before change
    after_state TEXT,               -- JSON snapshot after change
    description TEXT
);

-- ═══════════════════════════════════════════════════════════════════
-- PIPELINE & CONFIGURATION
-- ═══════════════════════════════════════════════════════════════════

-- Saved pipeline configuration presets (reusable across projects)
CREATE TABLE pipeline_configs (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,              -- 'League Race Default', 'Quick Highlights', 'Full Broadcast'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Step enablement (which steps are included in auto-pipeline)
    auto_capture BOOLEAN DEFAULT TRUE,
    auto_analyse BOOLEAN DEFAULT TRUE,
    auto_highlight BOOLEAN DEFAULT TRUE,
    auto_export BOOLEAN DEFAULT TRUE,
    auto_upload BOOLEAN DEFAULT FALSE,
    -- Analysis settings
    highlight_target_duration INTEGER DEFAULT 300,  -- seconds
    highlight_weights TEXT,          -- JSON: event type weights for highlight editor
    -- Export settings
    export_preset TEXT DEFAULT 'YouTube 1080p',
    export_highlights BOOLEAN DEFAULT TRUE,
    export_full_race BOOLEAN DEFAULT FALSE,
    -- Upload settings
    youtube_privacy TEXT DEFAULT 'unlisted',  -- 'public', 'unlisted', 'private'
    youtube_title_template TEXT DEFAULT '{{track_name}} - {{session_type}} | {{date}}',
    youtube_description_template TEXT,
    youtube_tags TEXT,               -- JSON array of tags
    youtube_playlist_id TEXT,        -- auto-add to playlist
    -- Camera defaults
    battle_gap_seconds REAL DEFAULT 1.5,
    camera_sticky_seconds REAL DEFAULT 8.0,
    incident_position_cutoff INTEGER DEFAULT 0,
    -- Full settings blob for anything not explicitly columned
    settings_json TEXT               -- JSON: complete settings snapshot
);

-- Pipeline execution runs (log of each automated run)
CREATE TABLE pipeline_runs (
    id INTEGER PRIMARY KEY,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    status TEXT DEFAULT 'running',   -- 'running', 'paused', 'completed', 'failed', 'cancelled'
    current_step TEXT,               -- which step is active
    -- Per-step status
    step_capture TEXT DEFAULT 'pending',   -- 'pending', 'running', 'completed', 'failed', 'skipped'
    step_analyse TEXT DEFAULT 'pending',
    step_highlight TEXT DEFAULT 'pending',
    step_export TEXT DEFAULT 'pending',
    step_upload TEXT DEFAULT 'pending',
    -- Error info
    error_step TEXT,                 -- which step failed
    error_message TEXT,
    error_traceback TEXT,
    -- Pipeline config used (snapshot at run time)
    config_snapshot TEXT              -- JSON: full config used for this run
);

-- ═══════════════════════════════════════════════════════════════════
-- YOUTUBE INTEGRATION
-- ═══════════════════════════════════════════════════════════════════

-- YouTube upload records (one per exported file uploaded)
CREATE TABLE youtube_uploads (
    id INTEGER PRIMARY KEY,
    export_type TEXT NOT NULL,        -- 'highlights', 'full_race'
    export_file_path TEXT NOT NULL,
    youtube_video_id TEXT,            -- YouTube video ID after upload
    youtube_url TEXT,                 -- Full YouTube URL
    upload_status TEXT DEFAULT 'pending',  -- 'pending', 'uploading', 'processing', 'live', 'failed'
    upload_progress REAL DEFAULT 0,  -- 0.0-1.0
    uploaded_at TIMESTAMP,
    -- Video metadata sent to YouTube
    title TEXT,
    description TEXT,
    tags TEXT,                        -- JSON array
    privacy TEXT DEFAULT 'unlisted',
    playlist_id TEXT,
    thumbnail_path TEXT,             -- Custom thumbnail (optional)
    -- YouTube processing info
    youtube_status TEXT,             -- YouTube's processing status
    youtube_thumbnail_url TEXT       -- YouTube-generated thumbnail
);

-- ═══════════════════════════════════════════════════════════════════
-- TELEMETRY: Normalised two-table design
-- ═══════════════════════════════════════════════════════════════════
-- The analysis scan produces one `race_tick` per freeze_var_buffer_latest()
-- call (~60 Hz effective at 16× replay speed → ~3-4 ticks per real second).
-- Each tick fans out into N `car_state` rows — one per active car.
-- This normalisation eliminates JSON parsing, enables per-car SQL queries,
-- and keeps every column natively indexed and typed.

-- Session-level state per telemetry sample
CREATE TABLE race_ticks (
    id              INTEGER PRIMARY KEY,
    session_time    REAL    NOT NULL,   -- ir['SessionTime'] seconds since session start
    replay_frame    INTEGER NOT NULL,   -- ir['ReplayFrameNum'] — THE link to video timestamps
    session_state   INTEGER NOT NULL,   -- 0=Invalid..4=Racing,5=Checkered,6=CoolDown
    race_laps       INTEGER,            -- ir['RaceLaps'] — leader's current lap
    cam_car_idx     INTEGER,            -- ir['CamCarIdx'] — which car iRacing's auto-director is watching
    flags           INTEGER DEFAULT 0   -- ir['SessionFlags'] bitfield — yellow, green, checkered, etc.
);

CREATE INDEX idx_tick_time  ON race_ticks(session_time);
CREATE INDEX idx_tick_frame ON race_ticks(replay_frame);

-- Per-car state for every tick (only active cars — NOT all 64 slots)
CREATE TABLE car_states (
    id          INTEGER PRIMARY KEY,
    tick_id     INTEGER NOT NULL REFERENCES race_ticks(id),
    car_idx     INTEGER NOT NULL,      -- iRacing CarIdx (0-63)
    position    INTEGER NOT NULL,      -- ir['CarIdxPosition'][car_idx] — 0 = not racing
    class_position INTEGER DEFAULT 0,  -- ir['CarIdxClassPosition'][car_idx]
    lap         INTEGER NOT NULL,      -- ir['CarIdxLap'][car_idx]
    lap_pct     REAL    NOT NULL,      -- ir['CarIdxLapDistPct'][car_idx] — 0.0-1.0 track %
    surface     INTEGER NOT NULL,      -- ir['CarIdxTrackSurface'][car_idx] — enum (see below)
    est_time    REAL,                  -- ir['CarIdxEstTime'][car_idx] — est. time to cross S/F
    best_lap_time REAL DEFAULT -1      -- ir['CarIdxBestLapTime'][car_idx] — personal best (-1 = none)
);

-- Composite indexes tuned for the actual query patterns:
CREATE INDEX idx_cs_tick       ON car_states(tick_id);                     -- join to race_ticks
CREATE INDEX idx_cs_car_time   ON car_states(car_idx, tick_id);           -- per-car time series
CREATE INDEX idx_cs_surface    ON car_states(surface) WHERE surface != 3; -- off-track/pit queries
CREATE INDEX idx_cs_position   ON car_states(position) WHERE position > 0;-- position change queries

-- Lap completion events (one row each time a car crosses start/finish)
-- Enables lap-time calculation without scanning every tick.
CREATE TABLE lap_completions (
    id          INTEGER PRIMARY KEY,
    tick_id     INTEGER NOT NULL REFERENCES race_ticks(id),
    car_idx     INTEGER NOT NULL,
    lap_number  INTEGER NOT NULL,
    lap_time    REAL,                  -- seconds (NULL if first lap / invalid)
    position    INTEGER,               -- position at moment of completion
    UNIQUE(car_idx, lap_number)
);

CREATE INDEX idx_lc_car ON lap_completions(car_idx);

-- ═══════════════════════════════════════════════════════════════════
-- TrackSurface enum reference (for car_states.surface):
--   -1 = NotInWorld   (car hasn't spawned or has disconnected)
--    0 = OffTrack     (in grass/gravel)
--    1 = InPitStall   (parked in pit box)
--    2 = AproachingPits (on pit road but not in stall)
--    3 = OnTrack      (normal racing surface)
-- ═══════════════════════════════════════════════════════════════════
```

### 4.3 iRacing Telemetry — How It Works

This is the most technically nuanced part of the system. Understanding it is essential before implementing anything.

#### 4.3.1 The Source: iRacing Shared Memory

iRacing exposes all telemetry through a **memory-mapped file** (Windows shared memory) that it writes to while the simulator is running — including during replay playback. This is the same mechanism used by Crew Chief, MoTeC, and every iRacing overlay tool.

There are two data streams in this interface:

| Stream | Rate | Content |
|--------|------|---------|
| **Telemetry variables** | ~60Hz | Car states, speeds, positions, flags — changes every frame |
| **Session info string** | On change | YAML blob with static session data — drivers, track, car classes, camera groups |

Critically: **telemetry is emitted during replay playback just as it is during live racing.** When you scrub a replay to frame N and set it to 16× speed, iRacing writes telemetry at 60Hz reflecting what was happening at those replay frames. This is exactly how the legacy app worked and how League Replay Studio will work.

#### Race Session Jumping

The `replay_search_session_time(session_num, session_time_ms)` Broadcasting API call lets us jump directly to the start of the race session without scanning through practice/qualifying. The bridge detects the race `session_num` from `SessionInfo.Sessions` YAML and uses it to skip ahead immediately. A fallback to scanning from frame 0 is used when session jumping is unavailable.

#### iRacing Window Screenshot Endpoint

`GET /api/iracing/screenshot` captures the iRacing window via `mss` + `Pillow` (ctypes `FindWindowW` + `GetWindowRect` for the region) and returns JPEG bytes. The AnalysisPanel polls this endpoint at 2 Hz during analysis to show a live iRacing preview embed.

#### 4.3.2 Python Library: `irsdk`

The Python package is `irsdk` (installed as `pip install irsdk`), which wraps the shared memory interface.

```python
import irsdk

ir = irsdk.IRSDK()
ir.startup()                       # Connects to the shared memory file

ir.freeze_var_buffer_latest()      # Atomically snapshot the latest telemetry frame
                                   # MUST call this before reading — avoids partial reads

speed   = ir['Speed']              # float — current speed m/s
rpm     = ir['RPM']                # float
lap     = ir['Lap']                # int — current lap number
session_time = ir['SessionTime']   # float — seconds since session start
replay_frame = ir['ReplayFrameNum']  # int — current replay frame

# Per-car arrays (indexed by CarIdx, up to 64 entries)
positions   = ir['CarIdxPosition']       # [int] — race position per car
lap_pcts    = ir['CarIdxLapDistPct']     # [float] — 0.0-1.0 track position per car
surfaces    = ir['CarIdxTrackSurface']   # [int] — 0=NotInWorld,1=OffTrack,2=Pit,3=OnTrack
distances   = ir['CarIdxEstTime']        # [float] — estimated lap time gap to leader

# Incident detection — iRacing fires a camera-cut event when it detects an incident
cam_car_idx = ir['CamCarIdx']            # int — which car the directed camera is on
```

> **Package note:** The package name on PyPI is `irsdk` (not `pyirsdk`). It is maintained at [github.com/kutu/pyirsdk](https://github.com/kutu/pyirsdk). Throughout this document we refer to the library as `irsdk`/`pyirsdk` interchangeably — the import is `import irsdk`.

#### 4.3.3 Session Info (Static Data)

The session info YAML is a separate string, parsed once when a session starts (or changes). It contains everything static:

```python
ir.freeze_var_buffer_latest()

session_info = ir.session_info_update  # int — increments when YAML changes
yaml_string  = ir['SessionInfo']       # raw YAML string (use ir.parse_to() to get dict)

# Parsed session data contains:
info = ir.session_info
drivers      = info['DriverInfo']['Drivers']           # list of driver dicts
track_name   = info['WeekendInfo']['TrackDisplayName']
camera_groups = info['CameraInfo']['Groups']           # available cameras (name + GroupNum)
session_type  = info['SessionInfo']['Sessions'][0]['SessionType']
results_laps  = info['SessionInfo']['Sessions'][0]['ResultsLapsComplete']
avg_lap_time  = info['SessionInfo']['Sessions'][0]['ResultsAverageLapTime']
```

The `avg_lap_time` from session info is critical for converting `CarIdxLapDistPct` gaps into **time gaps** — exactly how the legacy `Battle.cs` computed battle proximity:

```python
# Legacy Battle.cs equivalent in Python:
# gap in track % * average lap time = gap in seconds
time_gap = (car1_lap_pct - car2_lap_pct) * avg_lap_time
if time_gap < battle_threshold_seconds:
    # these two cars are in a battle
```

#### 4.3.4 Replay Control (Broadcasting API)

Camera control and replay playback use a **separate** mechanism from telemetry: iRacing's Broadcasting API, called via `irsdk` broadcast messages.

```python
# Replay control
ir.replay_set_play_speed(speed=16, slow_motion=False)  # Set replay speed (1, 2, 4, 8, 16)
ir.replay_set_play_speed(speed=0)                       # Pause
ir.replay_search(irsdk.RpySrchMode.toStart)            # Jump to replay start
ir.replay_set_state(irsdk.RpyStateMode.eraseTape)      # Clear replay

# Camera control — this is how we direct the camera during analysis
ir.cam_switch_num(car_number, group, camera)           # Switch to car by number
ir.cam_switch_pos(position, group, camera)             # Switch to race position N

# The camera GroupNum comes from the session info YAML:
# info['CameraInfo']['Groups'][i]['GroupNum']  → integer ID iRacing uses
# info['CameraInfo']['Groups'][i]['GroupName'] → human name like "TV1", "Chase"
```

This is the same mechanism the legacy `CameraControl.cs` used — it calls `iRacing.Replay.MoveToFrame()` and `iRacing.Camera.SwitchToCar()` which are thin wrappers over these exact broadcast messages.

#### 4.3.5 Incident Detection: How iRacing Signals Incidents

iRacing does **not** provide a direct "incident occurred" flag in the telemetry variables. Instead, when iRacing's auto-director detects an incident, it **switches the directed camera** to the incident car. The legacy app exploits this:

1. Call `iRacing.GetDataFeed().RaceIncidents2(...)` — this is a custom extension method in the C# SDK that monitors `CamCarIdx` changes
2. When `CamCarIdx` jumps to a car that is `OffTrack` or in a spin, that's an incident
3. The legacy app filters out pit-stall incidents and applies a 15-second deduplication window per car

In Python:
```python
prev_cam_car = None

ir.freeze_var_buffer_latest()
cam_car_idx     = ir['CamCarIdx']
track_surface   = ir['CarIdxTrackSurface']
session_time    = ir['SessionTime']

# iRacing switched camera to a car that's off-track = incident
if cam_car_idx != prev_cam_car:
    surface = track_surface[cam_car_idx]
    if surface not in (TrackSurface.ON_TRACK, TrackSurface.IN_PIT_STALL,
                       TrackSurface.APPROACHING_PITS, TrackSurface.NOT_IN_WORLD):
        # This is an incident — record session_time as start time
        record_incident(cam_car_idx, session_time)
    prev_cam_car = cam_car_idx
```

#### 4.3.6 The Analysis Loop Pattern

The legacy analysis loop (from `AnalyseRace.cs`) is the pattern we replicate in Python. The key insight is using `SampleFilter` — only process expensive operations at throttled intervals, not every 60Hz frame:

```python
# Legacy SampleFilter equivalent — throttle expensive processing
class SampleFilter:
    def __init__(self, interval_seconds: float, processor):
        self.interval = interval_seconds
        self.processor = processor
        self.last_time = 0.0

    def process(self, session_time: float, sample: dict):
        if session_time - self.last_time < self.interval:
            return
        self.last_time = session_time
        self.processor(sample)

# Analysis loop — mirrors AnalyseRace.cs AnalyseRaceSituations()
async def run_analysis_loop(ir: irsdk.IRSDK, on_progress):
    leaderboard_filter  = SampleFilter(0.5,  capture_leaderboard)   # every 0.5s
    cam_driver_filter   = SampleFilter(0.25, capture_cam_driver)     # every 0.25s
    pit_stop_filter     = SampleFilter(1.0,  record_pit_stops)
    
    while True:
        ir.freeze_var_buffer_latest()
        
        if not ir.is_connected:
            break
            
        session_time = ir['SessionTime']
        session_state = ir['SessionState']
        
        # Stop when leader finishes and all cars have seen checkered or retired
        if should_stop(ir):
            break
        
        sample = build_sample(ir)   # snapshot all needed variables
        
        # Core processors — run every frame
        incident_detector.process(sample)
        battle_detector.process(sample)
        
        # Throttled processors
        leaderboard_filter.process(session_time, sample)
        cam_driver_filter.process(session_time, sample)
        pit_stop_filter.process(session_time, sample)
        
        await asyncio.sleep(0)  # yield to event loop
```

#### 4.3.7 iRacing Bridge Service

This is the Python service that wraps all of the above:

```
┌──────────────────────────────────────────────────────┐
│                  iRacing Bridge Service               │
├──────────────────────────────────────────────────────┤
│                                                       │
│  Connection Manager                                   │
│  ├── Poll for iRacing process every 2s               │
│  ├── ir.startup() → connects to shared memory        │
│  ├── ir.shutdown() on disconnect                     │
│  └── WebSocket push: connected/disconnected status   │
│                                                       │
│  Session Info Reader (runs on session_info change)    │
│  ├── Parse YAML: drivers, track, camera groups       │
│  ├── Build CarIdx→Driver map                         │
│  ├── Extract available camera group numbers          │
│  └── Cache avg_lap_time for battle gap calculation   │
│                                                       │
│  Telemetry Poller (60Hz background thread)           │
│  ├── freeze_var_buffer_latest() each tick            │
│  ├── Read per-car arrays (position, dist%, surface)  │
│  ├── Read session-level vars (time, flags, state)    │
│  └── Feed to analysis loop OR live status endpoint  │
│                                                       │
│  Replay Controller (Broadcasting API)                 │
│  ├── set_speed(0 / 1 / 16)                           │
│  ├── seek_to_frame(frame_number)                     │
│  ├── cam_switch_pos(position, group_num)             │
│  └── cam_switch_car(car_idx, group_num)              │
│                                                       │
└──────────────────────────────────────────────────────┘
```

```python
import irsdk
import asyncio
import threading

class IRacingBridge:
    """
    Wraps irsdk shared memory + Broadcasting API.
    Runs a background poll thread; pushes updates via asyncio queue.
    """

    POLL_HZ = 60
    RECONNECT_INTERVAL = 2.0

    def __init__(self):
        self.ir = irsdk.IRSDK()
        self._connected = False
        self._session_info_update = -1
        self.update_queue: asyncio.Queue = asyncio.Queue()

    # ── Connection ─────────────────────────────────────────────────────────

    def start(self):
        """Start the background polling thread."""
        threading.Thread(target=self._poll_loop, daemon=True).start()

    def _poll_loop(self):
        while True:
            if not self._connected:
                if self.ir.startup():
                    self._connected = True
                    self._on_connect()
                else:
                    time.sleep(self.RECONNECT_INTERVAL)
                    continue

            self.ir.freeze_var_buffer_latest()

            if not self.ir.is_connected:
                self._connected = False
                self._on_disconnect()
                self.ir.shutdown()
                continue

            # Session info changed (new drivers, camera list, etc.)
            if self.ir.session_info_update != self._session_info_update:
                self._session_info_update = self.ir.session_info_update
                self._on_session_info_change()

            self._emit_telemetry()
            time.sleep(1.0 / self.POLL_HZ)

    def _on_connect(self):
        asyncio.run_coroutine_threadsafe(
            self.update_queue.put({'type': 'connected'}), loop
        )

    def _on_session_info_change(self):
        info = self.ir.session_info
        asyncio.run_coroutine_threadsafe(
            self.update_queue.put({'type': 'session_info', 'data': info}), loop
        )

    def _emit_telemetry(self):
        """Emit a structured telemetry snapshot matching the normalised DB schema.
        
        Produces a tick dict + a list of per-car state dicts.
        Only active cars (position > 0 AND surface != NotInWorld) are emitted,
        keeping the payload compact (typically 20-40 cars, not 64).
        """
        positions = list(self.ir['CarIdxPosition'])
        lap_pcts  = list(self.ir['CarIdxLapDistPct'])
        surfaces  = list(self.ir['CarIdxTrackSurface'])
        est_times = list(self.ir['CarIdxEstTime'])
        laps      = list(self.ir['CarIdxLap'])
        class_pos = list(self.ir['CarIdxClassPosition'])
        best_laps = list(self.ir['CarIdxBestLapTime'])

        # Build per-car state list — only active cars
        car_states = []
        for i in range(len(positions)):
            if positions[i] > 0 and surfaces[i] != -1:  # -1 = NotInWorld
                car_states.append({
                    'car_idx':        i,
                    'position':       positions[i],
                    'class_position': class_pos[i] if i < len(class_pos) else 0,
                    'lap':            laps[i],
                    'lap_pct':        lap_pcts[i],
                    'surface':        surfaces[i],
                    'est_time':       est_times[i],
                    'best_lap_time':  best_laps[i] if i < len(best_laps) else -1,
                })

        snapshot = {
            'type': 'telemetry',
            # ── Tick-level (one row in race_ticks) ──
            'session_time':    self.ir['SessionTime'],
            'session_state':   self.ir['SessionState'],
            'replay_frame':    self.ir['ReplayFrameNum'],
            'race_laps':       self.ir['RaceLaps'],
            'cam_car_idx':     self.ir['CamCarIdx'],
            'flags':           self.ir['SessionFlags'],
            # ── Per-car (N rows in car_states) ──
            'car_states':      car_states,
        }
        asyncio.run_coroutine_threadsafe(
            self.update_queue.put(snapshot), loop
        )

    # ── Replay Control (Broadcasting API) ──────────────────────────────────

    def set_replay_speed(self, speed: int):
        """speed: 0=pause, 1=normal, 2/4/8/16=fast-forward"""
        self.ir.replay_set_play_speed(speed, False)

    def seek_to_frame(self, frame: int):
        self.ir.replay_search_frame(frame, irsdk.RpyPosMode.begin)

    def cam_switch_position(self, position: int, group_num: int):
        """Point camera at race position N (1=leader)."""
        self.ir.cam_switch_pos(position, group_num, 0)

    def cam_switch_car(self, car_idx: int, group_num: int):
        """Point camera at specific car by CarIdx."""
        self.ir.cam_switch_num(car_idx, group_num, 0)
```

> **Gotchas to handle:**
> - `freeze_var_buffer_latest()` **must** be called before every read — it atomically snapshots the latest frame and prevents partial reads mid-update
> - `CarIdxLapDistPct` values are 0 for cars not in the world — filter these out before computing gaps
> - `SessionState` is an enum: `0=Invalid, 1=GetInCar, 2=Warmup, 3=ParadeLaps, 4=Racing, 5=Checkered, 6=CoolDown` — only run detectors during `Racing` and `Checkered`
> - Camera group numbers come from session info YAML and can vary per track — always look them up fresh from `CameraInfo.Groups`, don't hardcode
> - During replay, `ReplayFrameNum` increments at the replay speed multiplier — at 16× you get ~960 frame increments per second of wall time

### 4.4 Replay Analyser

The analyser runs the analysis loop against a live 16× replay and produces the normalised telemetry database (`race_ticks` + `car_states`) that all subsequent processing (event detection, highlight editor, camera director) reads from.

**Two-pass approach:**

1. **Analysis Scan** (1-3 minutes): Jump directly to the race session via `replay_search_session_time(race_session_num, 0)` to skip practice/qualifying, then set replay to 16× speed and run the full analysis loop. Each `freeze_var_buffer_latest()` call produces one `race_ticks` row and N `car_states` rows (one per active car). This produces a complete, queryable record of the entire race. Falls back to legacy frame-0 scan if session jumping is unavailable.
2. **Event Detection** (seconds, from cached data): Run all detectors against the normalised tables — no iRacing connection needed after this point. Results populate the `race_events` table. The Highlight Editing Suite reprocesses this same cached data instantly.

> **Key insight:** After the scan is complete, all event detection and highlight editing operates entirely on cached SQLite data. Reprocessing the highlight algorithm takes milliseconds because it never touches iRacing or the video file.

#### Telemetry Data Model

The telemetry is stored in **two normalised tables** (see full schema in Section 4.2):

```
race_ticks (1 row per sample)          car_states (N rows per sample)
─────────────────────────────          ──────────────────────────────────
id ← ─────────────────────────────────→ tick_id (FK)
session_time                            car_idx
replay_frame                            position, class_position
session_state                           lap, lap_pct
race_laps                               surface
cam_car_idx                             est_time
flags                                   best_lap_time
```

The `replay_frame` column is the critical link — it maps every telemetry moment to a **frame number in the captured video file**, enabling frame-accurate event boundary placement.

#### Why Normalised Tables (Not JSON Blobs)

The original design stored per-car data as JSON TEXT columns (`car_positions TEXT`, `car_surfaces TEXT`, etc.). This was problematic because:

1. **Query cost**: Every detector had to `json.loads()` every column of every row — O(n×64) parsing for n snapshots
2. **No per-car indexing**: "Show me car #42's surface state from lap 5-8" required loading ALL cars for ALL ticks
3. **No SQL aggregation**: Couldn't use `GROUP BY`, `MIN/MAX`, window functions on per-car data
4. **Storage waste**: JSON encoding of 64-element arrays with 60+ null/zero entries per tick

The normalised schema solves all of these:

```sql
-- "Was car #42 off-track between session_time 120 and 180?"
SELECT t.session_time, t.replay_frame, cs.surface
FROM car_states cs
JOIN race_ticks t ON cs.tick_id = t.id
WHERE cs.car_idx = 42
  AND cs.surface = 0          -- OffTrack
  AND t.session_time BETWEEN 120 AND 180;

-- "Find all position changes between consecutive ticks for car #7"
SELECT curr.position AS new_pos, prev.position AS old_pos,
       t.session_time, t.replay_frame
FROM car_states curr
JOIN car_states prev ON prev.car_idx = curr.car_idx
  AND prev.tick_id = curr.tick_id - 1
JOIN race_ticks t ON curr.tick_id = t.id
WHERE curr.car_idx = 7
  AND curr.position != prev.position;

-- "Find all close battles (gap < 1.5s) between adjacent positions"
SELECT t.session_time, t.replay_frame,
       leader.car_idx AS leader, follower.car_idx AS follower,
       ABS(leader.lap_pct - follower.lap_pct) * :avg_lap_time AS gap_seconds
FROM car_states leader
JOIN car_states follower ON follower.tick_id = leader.tick_id
  AND follower.position = leader.position + 1
JOIN race_ticks t ON leader.tick_id = t.id
WHERE leader.surface = 3 AND follower.surface = 3   -- both OnTrack
  AND leader.position > 0 AND follower.position > 0
  AND ABS(leader.lap_pct - follower.lap_pct) * :avg_lap_time < 1.5;
```

#### Scan-to-Database Writer

```python
class TelemetryWriter:
    """Writes normalised telemetry data during the analysis scan."""
    
    def __init__(self, db: sqlite3.Connection):
        self.db = db
        self._prev_laps: dict[int, int] = {}   # car_idx → last known lap
    
    def write_tick(self, snapshot: dict):
        """Write one IRacingBridge snapshot to the database.
        
        Args:
            snapshot: The dict emitted by IRacingBridge._emit_telemetry()
        """
        cur = self.db.execute(
            """INSERT INTO race_ticks 
               (session_time, replay_frame, session_state, race_laps, cam_car_idx, flags)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (snapshot['session_time'], snapshot['replay_frame'],
             snapshot['session_state'], snapshot['race_laps'],
             snapshot['cam_car_idx'], snapshot.get('flags', 0))
        )
        tick_id = cur.lastrowid
        
        # Batch insert all active car states
        car_rows = [
            (tick_id, cs['car_idx'], cs['position'], cs['class_position'],
             cs['lap'], cs['lap_pct'], cs['surface'], cs['est_time'],
             cs['best_lap_time'])
            for cs in snapshot['car_states']
        ]
        self.db.executemany(
            """INSERT INTO car_states 
               (tick_id, car_idx, position, class_position, lap, lap_pct,
                surface, est_time, best_lap_time)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            car_rows
        )
        
        # Detect lap completions (lap_pct wraps from ~1.0 → ~0.0)
        for cs in snapshot['car_states']:
            prev_lap = self._prev_laps.get(cs['car_idx'])
            if prev_lap is not None and cs['lap'] > prev_lap:
                self.db.execute(
                    """INSERT OR IGNORE INTO lap_completions
                       (tick_id, car_idx, lap_number, position)
                       VALUES (?, ?, ?, ?)""",
                    (tick_id, cs['car_idx'], cs['lap'], cs['position'])
                )
            self._prev_laps[cs['car_idx']] = cs['lap']
        
        # Commit in batches of 100 ticks for performance
        if tick_id % 100 == 0:
            self.db.commit()
```

#### Event Detectors

Because telemetry is now normalised, detectors can use **SQL queries** instead of Python loops with JSON parsing. This is dramatically faster and more readable.

```python
class IncidentDetector:
    """
    Detects incidents by watching for iRacing's auto-director switching
    CamCarIdx to a car that is off-track. Mirrors legacy Incident.cs.
    
    With normalised data, the core query is a single JOIN — no JSON parsing.
    """
    def scan(self, db: sqlite3.Connection, session_info: dict) -> List[RaceEvent]:
        # Find all ticks where the auto-director switched to a new car
        # AND that car's surface was OffTrack (0) at that moment
        rows = db.execute("""
            WITH cam_changes AS (
                SELECT t.id AS tick_id, t.session_time, t.replay_frame,
                       t.cam_car_idx,
                       LAG(t.cam_car_idx) OVER (ORDER BY t.id) AS prev_cam
                FROM race_ticks t
                WHERE t.session_state IN (4, 5)  -- Racing or Checkered
            )
            SELECT cc.session_time, cc.replay_frame, cc.cam_car_idx, cs.surface
            FROM cam_changes cc
            JOIN car_states cs ON cs.tick_id = cc.tick_id 
                              AND cs.car_idx = cc.cam_car_idx
            WHERE cc.cam_car_idx != cc.prev_cam   -- camera switched
              AND cs.surface = 0                   -- OffTrack
            ORDER BY cc.session_time
        """).fetchall()
        
        # Group consecutive off-track cam switches into incident windows
        events = []
        for session_time, replay_frame, car_idx, surface in rows:
            if not events or session_time - events[-1]['end_time'] > 15.0:
                events.append({
                    'car_idx':    car_idx,
                    'start_time': session_time - 1.0,   # 1s lead-in
                    'end_time':   session_time + 8.0,    # 8s follow
                    'start_frame': replay_frame,
                    'end_frame':   replay_frame,
                })
            else:
                events[-1]['end_time'] = session_time + 8.0
                events[-1]['end_frame'] = replay_frame
        
        return [RaceEvent(event_type='incident', **e) for e in events]


class BattleDetector:
    """
    Detects close battles by computing time gaps between adjacent positions.
    Mirrors legacy Battle.cs / RuleBattle.cs.
    
    With normalised data, gap calculation is a self-JOIN on car_states —
    no Python loops, no JSON parsing.
    """
    def scan(self, db: sqlite3.Connection, session_info: dict,
             battle_gap_seconds: float = 1.5) -> List[RaceEvent]:
        avg_lap_time = float(
            session_info['SessionInfo']['Sessions'][0]['ResultsAverageLapTime']
        ) / 1e4

        # Find all tick+pair combinations where gap < threshold
        rows = db.execute("""
            SELECT t.session_time, t.replay_frame,
                   leader.car_idx AS leader_idx,
                   follower.car_idx AS follower_idx,
                   ABS(leader.lap_pct - follower.lap_pct) * ? AS gap
            FROM car_states leader
            JOIN car_states follower ON follower.tick_id = leader.tick_id
              AND follower.position = leader.position + 1
            JOIN race_ticks t ON leader.tick_id = t.id
            WHERE t.session_state IN (4, 5)
              AND leader.surface = 3 AND follower.surface = 3
              AND leader.position > 0
              AND ABS(leader.lap_pct - follower.lap_pct) * ? < ?
            ORDER BY t.session_time
        """, (avg_lap_time, avg_lap_time, battle_gap_seconds)).fetchall()

        # Group consecutive close-gap ticks into battle events
        open_battles: dict[tuple, dict] = {}
        events = []
        seen_this_tick: set[tuple] = set()
        prev_time = None

        for session_time, replay_frame, leader_idx, follower_idx, gap in rows:
            pair = (leader_idx, follower_idx)
            
            if session_time != prev_time:
                # Close any battles not seen in the current tick
                for stale_pair in list(open_battles.keys()):
                    if stale_pair not in seen_this_tick:
                        b = open_battles.pop(stale_pair)
                        if session_time - b['start_time'] >= 3.0:
                            events.append(RaceEvent(
                                event_type='battle',
                                start_time_seconds=b['start_time'],
                                end_time_seconds=prev_time,
                                start_frame=b['start_frame'],
                                end_frame=b['end_frame'],
                                involved_drivers=[b['leader'], b['follower']],
                            ))
                seen_this_tick.clear()
                prev_time = session_time

            seen_this_tick.add(pair)
            if pair not in open_battles:
                open_battles[pair] = {
                    'start_time':  session_time,
                    'start_frame': replay_frame,
                    'end_frame':   replay_frame,
                    'leader':      leader_idx,
                    'follower':    follower_idx,
                }
            else:
                open_battles[pair]['end_frame'] = replay_frame

        return events
```

#### Full Detector List

| Detector | DB query pattern | Legacy equivalent |
|----------|-----------------|-------------------|
| `IncidentDetector` | `race_ticks.cam_car_idx` change + `car_states.surface = 0` JOIN | `Incident.cs` + `RaceIncidents2()` |
| `BattleDetector` | Self-JOIN `car_states` on adjacent positions, gap calc | `Battle.cs`, `RuleBattle.cs` |
| `OvertakeDetector` | `LAG(position) OVER` window on `car_states` per car_idx | (inferred from position change) |
| `PitStopDetector` | `car_states.surface IN (1, 2)` duration grouping | `RecordPitStops.cs` |
| `FastestLapDetector` | `car_states.best_lap_time` delta between ticks | `RecordFastestLaps.cs` |
| `LeaderChangeDetector` | `car_states.position = 1` car_idx change over time | (new in V2) |
| `FirstLapDetector` | `race_ticks.session_state = 4 AND race_laps = 1` | `RuleFirstLapPeriod.cs` |
| `LastLapDetector` | `race_ticks.race_laps >= results_laps_complete` | `RuleLastLapPeriod.cs` |
| `RestartDetector` | `race_ticks.session_state` transition `3 → 4` | `RulePaceLaps.cs` |
| `PaceCarDetector` | `race_ticks.flags` bitfield check for pace car | `RulePaceLaps.cs` |
| `LapCompletionDetector` | `lap_completions` table direct query | (new in V2) |

### 4.5 Camera Direction Engine

Replaces the legacy rule-based system with a more sophisticated priority engine:

```python
class CameraDirector:
    """Intelligent camera direction engine."""
    
    rules = [
        RuleLastLap(priority=100),          # Highest priority — always show final lap
        RuleFirstLap(priority=95),          # Race start is must-see
        RuleIncident(priority=90),          # Incidents override most things
        RuleRestart(priority=85),           # Restarts are important
        RuleBattleForPosition(priority=70), # Close battles for position
        RuleLeaderFocus(priority=50),       # Show the leader periodically
        RulePreferredDriver(priority=40),   # User's favourite driver
        RuleRandomVariety(priority=10),     # Scenic / variety shots
    ]
    
    def generate_camera_plan(
        self,
        events: List[RaceEvent],
        track_cameras: TrackCameraConfig,
        preferences: DirectorPreferences
    ) -> List[CameraAssignment]:
        """Generate a complete camera assignment plan for the timeline."""
        # 1. Place mandatory assignments (first lap, last lap)
        # 2. Place event-driven assignments (incidents, battles)
        # 3. Fill gaps with preference-weighted random selection
        # 4. Apply camera sticky period (min time before switching)
        # 5. Apply transition preferences (cuts, fades)
        ...
```

### 4.6 Encoding Engine

The encoding engine uses FFmpeg with hardware acceleration for blazing-fast output.

```
┌────────────────────────────────────────────────────────────────┐
│                      ENCODING PIPELINE                          │
├────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Input Stage                                                     │
│  ├── Source video file(s) from capture                           │
│  ├── FFmpeg demuxer → raw frames                                 │
│  └── Audio stream passthrough or re-encode                       │
│                                                                  │
│  Processing Stage                                                │
│  ├── Edit decision list → frame-accurate cutting                 │
│  ├── Speed ramps (slow-mo for incidents, fast-forward)          │
│  ├── Fade in/out transitions between segments                    │
│  └── Frame timestamping for overlay sync                         │
│                                                                  │
│  Overlay Compositing Stage (HTML/Tailwind → PNG)                 │
│  ├── Pre-render: Playwright renders HTML templates → PNG seq.    │
│  ├── Per-frame data injection (positions, driver, lap, etc.)     │
│  ├── Transparent PNG output at native resolution                 │
│  ├── ~5-15ms per frame via persistent browser context            │
│  └── FFmpeg overlay filter: [source][png_seq]overlay=0:0        │
│                                                                  │
│  Encoding Stage                                                  │
│  ├── GPU detection: NVENC > AMF > QSV > CPU fallback             │
│  ├── Multi-GPU: distribute highlight + full to separate GPUs     │
│  ├── H.264 (NVENC): ~300+ fps encoding at 1080p                 │
│  ├── H.265/HEVC (NVENC): ~200+ fps, 40% smaller files           │
│  ├── AV1 (NVENC RTX 40+): ~150+ fps, 50% smaller files          │
│  └── Progress reporting via WebSocket to frontend                │
│                                                                  │
│  Output Stage                                                    │
│  ├── MP4 container (H.264/H.265/AV1 + AAC)                     │
│  ├── MKV container (optional)                                    │
│  ├── Highlight video (auto-cut from EDL)                         │
│  └── Full race video                                             │
│                                                                  │
└────────────────────────────────────────────────────────────────┘
```

**Multi-GPU Strategy:**

```python
class EncodingEngine:
    """GPU-accelerated video encoding with multi-GPU support."""
    
    async def detect_gpus(self) -> List[GPUInfo]:
        """Detect available encoding hardware."""
        gpus = []
        # NVIDIA (NVENC)
        for gpu in nvidia_gpus:
            gpus.append(GPUInfo(type='nvenc', name=gpu.name, vram=gpu.vram))
        # AMD (AMF)
        for gpu in amd_gpus:
            gpus.append(GPUInfo(type='amf', name=gpu.name, vram=gpu.vram))
        # Intel (QSV)
        if has_quicksync:
            gpus.append(GPUInfo(type='qsv', name='Intel QSV'))
        return gpus
    
    async def encode(self, project: Project, preset: ExportPreset) -> EncodingJob:
        """Start an encoding job, optionally across multiple GPUs."""
        gpus = await self.detect_gpus()
        
        if len(gpus) >= 2 and preset.encode_both_versions:
            # Multi-GPU: full race on GPU 0, highlights on GPU 1
            job_full = self._start_encode(project, preset, gpu=gpus[0], highlights=False)
            job_high = self._start_encode(project, preset, gpu=gpus[1], highlights=True)
            return CompositeJob(job_full, job_high)
        else:
            # Single GPU: sequential encoding
            return self._start_encode(project, preset, gpu=gpus[0])
    
    def _build_ffmpeg_command(self, project, preset, gpu, highlights):
        """Build the FFmpeg command with GPU encoding."""
        cmd = ['ffmpeg', '-y']
        
        # Input
        cmd += ['-i', project.source_video_path]
        
        # GPU-specific encoder
        if gpu.type == 'nvenc':
            cmd += ['-c:v', f'h264_nvenc', '-gpu', str(gpu.index)]
            cmd += ['-preset', 'p4', '-tune', 'hq']
            cmd += ['-rc', 'vbr', '-cq', '23']
            cmd += ['-b:v', f'{preset.video_bitrate_mbps}M']
        elif gpu.type == 'amf':
            cmd += ['-c:v', 'h264_amf']
            cmd += ['-quality', 'quality', '-rc', 'vbr_peak']
        elif gpu.type == 'qsv':
            cmd += ['-c:v', 'h264_qsv']
            cmd += ['-preset', 'medium', '-global_quality', '23']
        else:
            cmd += ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23']
        
        # Edit decision list as complex filtergraph
        if highlights:
            cmd += self._build_highlight_filter(project)
        
        # Overlay filter: composite pre-rendered HTML→PNG sequence
        cmd += self._build_overlay_filter(project, preset)  # PNG sequence input + overlay=0:0
        
        # Audio
        cmd += ['-c:a', 'aac', '-b:a', f'{preset.audio_bitrate_kbps}k']
        
        # Output
        cmd += [project.export_path(highlights)]
        
        return cmd
```

### 4.6.1 Internal Capture Engine Architecture

The CaptureEngine (v6) provides high-performance internal screen capture with a 3-tier backend and a decoupled pipeline. Writer threads isolate capture from pipe I/O so a blocked encoder never stalls frame grabbing. Frames are dropped rather than queued to prefer latency over completeness. Dual recording modes: GPU-native (FFmpeg gdigrab, zero Python in hot path) or CPU pipe (capture → queue → writer → FFmpeg stdin). A separate H.264 live-stream path feeds raw BGR frames from the same capture loop to FFmpeg via stdin pipe, encoding to fragmented MP4 served over HTTP and consumed by the frontend MediaSource Extensions (MSE) player — no second capture path required.

```
 +-----------------------------------------------------------------+
 |                CAPTURE ENGINE ARCHITECTURE (v5)                  |
 +-----------------------------------------------------------------+
 |                                                                  |
 |  Backend Selection (auto / manual via preview_backend setting)   |
 |  +-- Tier 1: Native C++ (lrs_capture.exe)                       |
 |  |   +-- DXGI Desktop Duplication, D3D11 staging texture        |
 |  |   +-- Named pipe IPC (commands) + shared memory (frames)     |
 |  |   +-- BGRA→BGR24 in C++, zero Python in hot path            |
 |  |   +-- Configurable output_index (0–7) and fps_cap           |
 |  |   +-- 5-second no-frame timeout triggers fallback            |
 |  |                                                               |
 |  +-- Tier 2: dxcam (DXGI Desktop Duplication API)               |
 |  |   +-- GPU-backed capture, 60-240 FPS capable                 |
 |  |   +-- Uses camera.start(target_fps=N) for jitter-free pacing |
 |  |   +-- output_color="BGR" — numpy arrays, no conversion       |
 |  |   +-- 3-second no-frame timeout triggers fallback            |
 |  |                                                               |
 |  +-- Tier 3: PrintWindow (Win32 GDI)                             |
 |      +-- Captures window content regardless of Z-order          |
 |      +-- GetDIBits writes into pre-allocated numpy buffer       |
 |      +-- BGRA[:,:,:3] slice to BGR — zero extra allocation      |
 |      +-- ~10-20 FPS (GDI overhead, acceptable for preview)      |
 |                                                                  |
 |  Decoupled Pipeline (writer threads + frame dropping)            |
 |                                                                  |
 |   Capture Thread      deque(2)     Preview Writer   Reader Thrd |
 |   +--------------+  +--------+   +--------------+ +----------+  |
 |   | native/dxcam |->| frames |==>| FFmpeg stdin |>| SOI/EOI  |  |
 |   | /PW -> BGR   |  | (drop) |   | -c:v mjpeg   | | scanner  |  |
 |   +--------------+  +--------+   +--------------+ +----------+  |
 |          |                                              |        |
 |          |                                       latest_jpeg     |
 |          |                                       (atomic swap)   |
 |          |                                                       |
 |          |  H.264 live stream mode:                              |
 |          |  +-- deque(4) → Feeder Thread → FFmpeg stdin         |
 |          |      (frame drop)    (daemon)    rawvideo bgr24       |
 |          |                                  -c:v libx264         |
 |          |                                  ultrafast/zerolatency |
 |          |                                  fMP4 pipe:1 → HTTP  |
 |          |                                  → MSE player (React) |
 |          |                                                       |
 |          |  CPU recording mode:                                  |
 |          |  +-- deque(2) → Record Writer → FFmpeg stdin          |
 |          |      (frame drop)    thread       -c:v h264_nvenc     |
 |          |                                    → output.mp4       |
 |          |                                                       |
 |          |  GPU recording mode (alternative):                    |
 |          |  +-- FFmpeg subprocess (standalone)                   |
 |          |      -f gdigrab → h264_nvenc → output.mp4            |
 |          |      Zero Python in recording hot path                |
 |          |      Python = control plane only (spawn/stop)         |
 |                                                                  |
 |  Key design decisions:                                           |
 |  - Native C++ exe communicates via shared memory (zero copy)    |
 |  - WGC: DWM DPI-aware client-area crop (no titlebar bleed)      |
 |  - SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) at init  |
 |  - NO PIL/Pillow in capture or encoding loop                    |
 |  - memoryview(frame) for stdin writes (no .tobytes() copy)      |
 |  - JPEG 4:4:4 chroma (IMWRITE_JPEG_SAMPLING_FACTOR) for quality |
 |  - Writer threads decouple capture from pipe I/O                |
 |  - Frame dropping > latency (deque maxlen=2, oldest dropped)    |
 |  - H.264 stream uses separate deque(4) — larger buffer OK       |
 |    because latency tolerance is higher than MJPEG preview       |
 |  - H.264 feeder is a daemon thread; FFmpeg dims known before    |
 |    proc spawn (waits up to 5 s for first frame resolution)      |
 |  - update_params(): live quality/fps/maxwidth without restart   |
 |  - GPU recording via gdigrab = zero Python in hot path          |
 |  - CPU recording via queue + writer thread as fallback          |
 |  - dxcam drives FPS natively (no Python sleep jitter)           |
 |  - FFmpeg handles scaling via fast_bilinear filter              |
 |  - Recording auto-detects best GPU: NVENC > AMF > QSV > CPU    |
 |  - Graceful recorder shutdown (CTRL_BREAK on Windows)           |
 |  - OBS/ShadowPlay still supported via existing hotkey system    |
 |                                                                  |
 |  REST API                                                        |
 |  +-- GET  /api/iracing/stream              -- MJPEG preview     |
 |  +-- GET  /api/iracing/stream/h264         -- H.264 fMP4 stream |
 |  +-- GET  /api/iracing/stream/metrics      -- FPS, drops, etc   |
 |  +-- GET  /api/iracing/stream/capabilities -- backend avail.    |
 |  +-- POST /api/iracing/stream/start        -- start engine      |
 |  +-- POST /api/iracing/stream/stop         -- stop engine       |
 |  +-- POST /api/iracing/stream/record/start -- recording (mode)  |
 |  +-- POST /api/iracing/stream/record/stop  -- stop recording    |
 |                                                                  |
 +-----------------------------------------------------------------+
```

**Performance evolution:**

| Metric | v1 (PIL pipeline) | v2 (FFmpeg MJPEG) | v3 (dual output) | v6 (current) |
|--------|-------------------|-------------------|-------------------|--------------|
| Frame path | numpy→PIL→JPEG | numpy.tobytes()→FFmpeg | memoryview→FFmpeg | capture→deque→writer→FFmpeg |
| Encoder | Pillow (1 thread) | libjpeg-turbo SIMD | libjpeg-turbo SIMD | libjpeg-turbo SIMD (MJPEG) / libx264 (H.264) |
| Copy cost | 3 copies | 1 copy | 0 Python copies | 0 Python copies |
| Recording | N/A | N/A | CPU pipe (same thread) | GPU gdigrab OR CPU pipe (separate thread) |
| H.264 preview | N/A | N/A | N/A | deque(4) → daemon feeder → libx264 → fMP4 → MSE |
| Backpressure | blocks capture | blocks capture | blocks capture | frame drop (deque maxlen=2/4) |
| Pipe writes | N/A | capture thread | capture thread (2 pipes) | dedicated writer threads |
| FPS (dxcam) | 15-25 | 40-60 | 60+ | 60+ (isolated from encoding) |
| WGC crop | N/A | N/A | N/A | DWM client-area crop, DPI-aware — no titlebar |

**Capture Mode Comparison:**

| Mode | FPS | Window Behind Others | GPU Load | Install Requirement |
|------|-----|---------------------|----------|-------------------|
| dxcam (DXGI) | 60-240 | No (captures desktop) | Very low | `pip install dxcam` |
| PrintWindow (GDI) | 10-20 | Yes (captures window) | Low | Built-in (Win32) |
| OBS (external) | Configurable | Yes (game capture) | Medium | OBS Studio |
| ShadowPlay (external) | Configurable | Yes (game capture) | Low | GeForce Experience |

**Known Constraints:**
- dxcam captures the composited desktop, not a specific window -- if iRacing is behind another window, the capture will include the overlapping app. Ideal for fullscreen iRacing.
- dxcam requires GPU access and will not work over Remote Desktop (no DXGI).
- PrintWindow is the only option that captures specific window content behind other windows, but limited to ~10-20 FPS due to GDI overhead.
- FFmpeg must be installed and in PATH. Required for MJPEG preview, H.264 live stream, and GPU H.264 recording.
- The engine uses a singleton pattern -- MJPEG and H.264 stream consumers share the same capture loop, avoiding duplicate captures.
- H.264 live stream uses the same capture backend; the **feeder queue** (`_h264_streaming` flag + `deque(maxlen=4)`) is enabled/disabled per HTTP request. No second capture path.
- MSE H.264 player (`H264StreamPlayer`) uses `AbortController` for clean fetch cancellation. `video.play()` must be called explicitly after the first `appendBuffer` / `updateend` — the `autoPlay` attribute is ignored when `video.src` is assigned programmatically.
- GPU recording mode uses gdigrab desktop-region capture; if iRacing window is moved during recording, the capture region will be stale. CPU recording mode is unaffected.
- Writer threads use `deque(maxlen=2)` -- frames are dropped (oldest first) when encoders can't keep up. The `frames_dropped` metric tracks this.
- OBS/ShadowPlay remain fully supported via the existing hotkey-based capture orchestration system.
- Remaining bottleneck for CPU recording mode: `memoryview(frame)` still incurs one kernel-level memcpy (~6MB/frame at 1080p). GPU recording mode avoids this entirely by keeping capture inside FFmpeg's native gdigrab pipeline.
- True zero-copy (DXGI texture → NVENC directly) would require a C++/Rust bridge. GPU recording mode is the practical alternative that eliminates Python from the recording hot path.

### 4.7 Video Preview System — Engineering for Multi-GB Files

The preview system is the most technically demanding component of the application. Race captures from OBS/ShadowPlay are routinely **5-15 GB** for a 45-minute race at 1080p60. Naive "seek-and-decode" approaches will produce multi-second latency and stutter. This section describes the **tiered asset pipeline** that makes scrubbing, playback, and highlight preview feel instant regardless of source file size.

#### 4.7.1 The Problem

| Operation | Naive approach | Latency | Why it's bad |
|-----------|---------------|---------|--------------|
| Scrub to arbitrary time | FFmpeg seek + decode | 200-2000ms | Keyframe intervals of 2-5s mean seeking backwards + decoding many frames |
| Playback at 1× | Pipe FFmpeg stdout | ~stable | But CPU/GPU contention with overlay rendering; audio sync is fragile |
| Jump to highlight clip N | Close pipe, open new seek | 500-3000ms | Cold seek each time the EDL jumps to a new source segment |
| Get thumbnail at cursor | Same as scrub | 200-2000ms | User dragging the timeline fires 30+ requests/second |

#### 4.7.2 Tiered Asset Pipeline

On project import (when the user points the project at a capture file), the backend generates a set of **derived assets** in the background. Each tier serves a different preview need.

```
Source File (10 GB, 1080p60)
    │
    ├── Tier 1: Keyframe Index         (instant, ~100 KB)
    │   └── Maps timestamp → byte offset of nearest keyframe
    │
    ├── Tier 2: Thumbnail Sprite Sheet (seconds, ~5-20 MB)
    │   └── 160×90 JPEG grid, 1 frame/second — for timeline scrub
    │
    ├── Tier 3: Proxy Video            (1-3 min, ~300-800 MB)
    │   └── 540p30 re-encode with 0.5s keyframe interval — for smooth playback
    │
    └── Tier 4: Audio Track            (seconds, ~50-100 MB)
        └── Extracted PCM/AAC — for instant audio sync without video decode
```

**Generation is progressive**: Tier 1 and Tier 4 complete in seconds. Tier 2 finishes within 30-60 seconds. The UI is immediately usable while Tier 3 generates in the background — the frontend shows a progress indicator and falls back to direct source decoding until the proxy is ready.

#### 4.7.3 Tier 1 — Keyframe Index

Built by scanning the source file's packet table without decoding:

```python
class KeyframeIndex:
    """O(1) timestamp → byte offset mapping for instant seeking."""
    
    @staticmethod
    async def build(source_path: str) -> 'KeyframeIndex':
        """Scan source file and build keyframe index. Takes < 5 seconds for any file size."""
        index = []
        proc = await asyncio.create_subprocess_exec(
            'ffprobe', '-v', 'quiet',
            '-select_streams', 'v:0',
            '-show_entries', 'packet=pts_time,pos,flags',
            '-of', 'csv=p=0',
            source_path,
            stdout=asyncio.subprocess.PIPE
        )
        async for line in proc.stdout:
            pts_time, pos, flags = line.decode().strip().split(',')
            if 'K' in flags:  # Keyframe
                index.append((float(pts_time), int(pos)))
        
        return KeyframeIndex(index)  # Store as sorted list for bisect lookup
    
    def nearest_keyframe(self, time_seconds: float) -> tuple[float, int]:
        """Return (keyframe_time, byte_offset) for the keyframe at or before the target time."""
        idx = bisect.bisect_right(self._entries, (time_seconds,)) - 1
        return self._entries[max(0, idx)]
```

#### 4.7.4 Tier 2 — Thumbnail Sprite Sheets

A single wide JPEG image containing one 160×90 thumbnail per second of video. For a 45-minute race this is 2700 thumbnails packed into a ~5-20 MB sprite sheet (or multiple sheets of 300 thumbnails each).

```python
class ThumbnailGenerator:
    """Generate thumbnail sprite sheets for timeline scrubbing."""
    
    THUMB_WIDTH  = 160
    THUMB_HEIGHT = 90
    COLS_PER_SHEET = 30     # 30 columns × 10 rows = 300 thumbnails per sheet
    ROWS_PER_SHEET = 10
    
    async def generate(self, source_path: str, output_dir: str, duration: float):
        """Generate sprite sheets at 1 frame/second. ~30-60 seconds for any file."""
        sheet_count = math.ceil(duration / (self.COLS_PER_SHEET * self.ROWS_PER_SHEET))
        
        for i in range(sheet_count):
            start = i * self.COLS_PER_SHEET * self.ROWS_PER_SHEET
            cmd = [
                'ffmpeg', '-ss', str(start), '-i', source_path,
                '-vf', (
                    f'fps=1,'
                    f'scale={self.THUMB_WIDTH}:{self.THUMB_HEIGHT},'
                    f'tile={self.COLS_PER_SHEET}x{self.ROWS_PER_SHEET}'
                ),
                '-frames:v', '1',
                '-q:v', '5',
                f'{output_dir}/sprite_{i:04d}.jpg'
            ]
            await asyncio.create_subprocess_exec(*cmd)
        
        # Write index JSON: maps second → (sheet_index, row, col)
        index = {}
        for sec in range(int(duration)):
            sheet_idx = sec // (self.COLS_PER_SHEET * self.ROWS_PER_SHEET)
            offset = sec % (self.COLS_PER_SHEET * self.ROWS_PER_SHEET)
            row, col = divmod(offset, self.COLS_PER_SHEET)
            index[sec] = {'sheet': sheet_idx, 'x': col * self.THUMB_WIDTH,
                          'y': row * self.THUMB_HEIGHT}
        
        with open(f'{output_dir}/sprite_index.json', 'w') as f:
            json.dump(index, f)
```

The frontend uses CSS `background-position` on the sprite sheet image to instantly display the thumbnail at the cursor position — **zero server round-trip** for timeline scrubbing.

#### 4.7.5 Tier 3 — Proxy Video

A lightweight re-encode of the source file optimised for scrubbing and playback:

| Property | Source | Proxy |
|----------|--------|-------|
| Resolution | 1920×1080 | 960×540 |
| Frame rate | 60 fps | 30 fps |
| Keyframe interval | 2-5 seconds (OBS default) | 0.5 seconds (every 15 frames) |
| File size (45 min) | 5-15 GB | 300-800 MB |
| Seek latency | 200-2000ms | < 50ms |

```python
class ProxyGenerator:
    """Generate a lightweight proxy video for smooth preview playback."""
    
    async def generate(self, source_path: str, proxy_path: str,
                       progress_callback=None) -> str:
        """Generate proxy. Uses GPU decode + encode for speed (~1-3 min for 45-min source)."""
        cmd = [
            'ffmpeg', '-y',
            '-hwaccel', 'auto',              # GPU-accelerated decode
            '-i', source_path,
            '-vf', 'scale=960:540',
            '-r', '30',                       # 30 fps
            '-c:v', 'h264_nvenc',             # GPU encode (falls back to libx264)
            '-preset', 'p1',                  # Fastest preset — quality doesn't matter much
            '-g', '15',                       # Keyframe every 0.5s (15 frames at 30fps)
            '-bf', '0',                       # No B-frames — every frame is decodable fast
            '-c:a', 'aac', '-b:a', '128k',   # Keep audio for sync verification
            '-movflags', '+faststart',        # Moov atom at start for instant playback
            proxy_path
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stderr=asyncio.subprocess.PIPE
        )
        # Parse FFmpeg stderr for progress reporting
        async for line in proc.stderr:
            if progress_callback and b'time=' in line:
                progress_callback(self._parse_progress(line, source_duration))
        
        return proxy_path
```

> **Key design choice**: The proxy has **0.5-second keyframe intervals** and **no B-frames**. This means seeking to any timestamp requires decoding at most 14 frames (< 50ms) instead of potentially hundreds of frames with the original file's 2-5 second keyframe intervals.

#### 4.7.6 Tier 4 — Extracted Audio

```python
async def extract_audio(source_path: str, audio_path: str):
    """Extract audio track for independent playback. Takes < 10 seconds (stream copy)."""
    cmd = [
        'ffmpeg', '-y',
        '-i', source_path,
        '-vn',                      # No video
        '-c:a', 'copy',             # Stream copy — no re-encode
        '-movflags', '+faststart',
        audio_path                  # .m4a or .aac
    ]
    await asyncio.create_subprocess_exec(*cmd)
```

The frontend plays audio through the HTML5 `<audio>` element, synchronised to the video preview via `currentTime`. This decouples audio from the video decode pipeline entirely — audio never stutters even during heavy scrubbing.

#### 4.7.7 Preview Server Architecture

```python
class VideoPreviewServer:
    """Serves preview frames from tiered assets, adapting quality to interaction mode."""
    
    # ── Interaction-aware quality selection ──────────────────────────
    #
    # The preview system detects HOW the user is interacting and selects
    # the optimal tier automatically:
    #
    #   Scrubbing (dragging playhead fast)  → Tier 2 sprite thumbnails (0ms)
    #   Scrub release (playhead stops)      → Tier 3 proxy full frame (< 50ms)
    #   Playback (press play)               → Tier 3 proxy streaming (real-time)
    #   Paused (sitting on a frame)         → Source full-res frame (< 500ms)
    #   Highlight preview                   → Tier 3 proxy with EDL mapping
    
    async def get_scrub_thumbnail(self, project_id: str, time_seconds: float) -> dict:
        """Return sprite sheet coordinates for instant timeline scrub.
        Frontend renders this entirely client-side from cached sprite sheets."""
        index = self.sprite_indexes[project_id]
        sec = int(time_seconds)
        entry = index.get(sec, index.get(max(index.keys())))
        return {
            'sheet_url': f'/api/projects/{project_id}/preview/sprite/{entry["sheet"]}',
            'x': entry['x'], 'y': entry['y'],
            'width': 160, 'height': 90,
        }
    
    async def get_frame(self, project_id: str, time_seconds: float,
                        quality: str = 'proxy') -> bytes:
        """Get a single decoded frame from proxy or source."""
        video_path = (
            self.projects[project_id].proxy_video_path if quality == 'proxy'
            else self.projects[project_id].source_video_path
        )
        
        # 1. Use keyframe index for fast seeking
        kf_time, kf_offset = self.keyframe_index.nearest_keyframe(time_seconds)
        
        # 2. Seek to keyframe + decode forward to exact frame
        frame = await self.decoder.seek_and_decode(video_path, time_seconds, kf_offset)
        
        # 3. Render HTML/Tailwind overlay for this timestamp → transparent PNG
        overlay_png = await self.overlay_renderer.render_frame_fast(
            self._build_data_context(project_id, time_seconds)
        )
        composited = self.compositor.alpha_composite(frame, overlay_png)
        
        # 4. Encode as JPEG for transport (quality varies by mode)
        jpeg_quality = 90 if quality == 'source' else 75
        return encode_jpeg(composited, quality=jpeg_quality)
    
    async def stream_playback(self, project_id: str, start: float,
                              speed: float = 1.0, websocket=None):
        """Stream proxy video frames over WebSocket for real-time playback.
        
        Uses proxy video for smooth decode; overlays composited per-frame.
        Audio is synchronised independently on the frontend via <audio> element.
        """
        proxy_path = self.projects[project_id].proxy_video_path
        frame_interval = 1.0 / 30.0 / speed  # Proxy is 30fps
        
        async for frame in self.decoder.decode_range(proxy_path, start):
            t_start = time.perf_counter()
            
            overlay_png = await self.overlay_renderer.render_frame_fast(
                self._build_data_context(project_id, frame.timestamp)
            )
            composited = self.compositor.alpha_composite(frame, overlay_png)
            jpeg = encode_jpeg(composited, quality=70)
            
            await websocket.send_bytes(
                struct.pack('<f', frame.timestamp) + jpeg  # 4-byte timestamp header + JPEG
            )
            
            # Frame pacing — maintain real-time rate
            elapsed = time.perf_counter() - t_start
            if elapsed < frame_interval:
                await asyncio.sleep(frame_interval - elapsed)
    
    async def get_highlight_preview(self, project_id: str, highlight_time: float) -> bytes:
        """Map highlight-timeline position → source position via EDL, then get frame."""
        source_time = self.edl_mapper.highlight_to_source(project_id, highlight_time)
        return await self.get_frame(project_id, source_time, quality='proxy')
```

#### 4.7.8 Frontend Integration

The frontend manages preview state with a three-level approach:

```
┌─────────────────────────────────────────────────────────────────┐
│  TIMELINE                                                        │
│  ▼ Thumbnails │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│  │
│              (CSS background-position on cached sprite sheets)   │
│               ↑ Loaded once, zero latency scrubbing              │
│                                                                  │
│  PREVIEW VIEWPORT                                                │
│  ┌─────────────────────────────────────┐                         │
│  │  [During scrub] → Sprite thumbnail  │  ← 0ms, client-side    │
│  │  [On release]   → Proxy frame+OVL   │  ← <50ms from server   │
│  │  [On play]      → WS stream+audio   │  ← real-time 30fps     │
│  │  [On pause]     → Source hi-res      │  ← <500ms upgrade      │
│  └─────────────────────────────────────┘                         │
│                                                                  │
│  AUDIO                                                           │
│  <audio src="/api/projects/{id}/preview/audio">                  │
│  └── Synchronised via JS: audio.currentTime = videoTimestamp     │
└─────────────────────────────────────────────────────────────────┘
```

| Interaction | Asset used | Latency | Quality |
|-------------|-----------|---------|---------|
| Fast scrub (dragging) | Sprite sheet (client) | 0ms | 160×90 thumbnail |
| Scrub release | Proxy frame (server) | < 50ms | 540p + overlays |
| Play/pause/step | Proxy WebSocket stream | real-time | 540p30 + overlays |
| Paused > 1 second | Source frame (server) | < 500ms | Full resolution + overlays |
| Highlight preview | Proxy + EDL mapping | < 50ms | 540p + overlays |

#### 4.7.9 Fallback Strategy

If the proxy is still generating (user is impatient):
- **Timeline scrub** still works instantly via sprite sheets (Tier 2 generates first)
- **Playback** falls back to direct source decode (higher latency, may drop frames on large files)
- **Status bar** shows proxy generation progress: "Generating preview... 45% (2:31 remaining)"
- Once proxy is ready, preview seamlessly upgrades — no user action needed

If the source file is on a slow disk (HDD):
- Proxy is always read from the project directory (which should be on SSD)
- If project dir is also HDD, we pre-buffer 10 seconds of decoded frames during playback
- Thumbnail sprite sheets are tiny enough to fit in OS page cache

**Preview Modes:**
| Mode | Description |
|------|-------------|
| **Full Race** | Scrub/play through the complete recorded video with overlays |
| **Highlight Preview** | Condensed highlight reel mapped through EDL |
| **Source** | Raw recorded video without overlays |
| **Split** | Source on left, composited output on right |

---

## 5. Frontend Architecture — Deep Dive

### 5.1 Application Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ TOOLBAR: Project Name │ Save │ Undo/Redo │ Settings │ Help │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────┬──────────────────────────────────┐  │
│  │                         │                                   │  │
│  │   EVENT BROWSER         │      PREVIEW VIEWPORT             │  │
│  │                         │                                   │  │
│  │  ▸ Incidents (12)       │   ┌─────────────────────────┐    │  │
│  │    ▸ Lap 3 T4 Contact   │   │                         │    │  │
│  │    ▸ Lap 7 T1 Spin      │   │    LIVE PREVIEW         │    │  │
│  │    ...                   │   │    (with overlays)      │    │  │
│  │  ▸ Battles (8)          │   │                         │    │  │
│  │    ▸ P3/P4 Laps 5-9     │   │                         │    │  │
│  │    ...                   │   └─────────────────────────┘    │  │
│  │  ▸ Overtakes (15)       │   ◁ ▷ ⏸ ⏮ ⏭  00:23:45 / 45:00 │  │
│  │  ▸ Pit Stops (23)       │                                   │  │
│  │  ▸ Fastest Laps (6)     │   PROPERTIES INSPECTOR            │  │
│  │                         │   ├── Camera: TV3                  │  │
│  │   CAMERA CONFIG         │   ├── Driver: #42 J. Hooks        │  │
│  │   ├── TV1: 30%          │   ├── Start: 23:45.120            │  │
│  │   ├── TV3: 25%          │   ├── End:   23:52.340            │  │
│  │   ├── Chase: 20%        │   ├── Transition: Cut             │  │
│  │   ├── Cockpit: 15%      │   └── [Apply] [Reset]             │  │
│  │   └── Scenic: 10%       │                                   │  │
│  │                         │                                   │  │
│  └─────────────────────────┴──────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    TIMELINE EDITOR                          │  │
│  │ ▼ Camera    ║▓▓▓TV1▓▓▓║▓Chase▓║▓▓▓TV3▓▓▓║▓▓Cockpit▓▓║    │  │
│  │ ▼ Events    ║░░BATTLE░░║▓▓▓▓▓▓║░INCIDENT░║░░BATTLE░░║    │  │
│  │ ▼ Overlays  ║▓LEADERBOARD▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓║    │  │
│  │ ▼ Audio     ║▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒║    │  │
│  │ ▼ Cuts      ║═══╣  CUT  ╠════════╣ CUT ╠═════════════║    │  │
│  │             ◁────────────────|─────────────────────────▷   │  │
│  │             00:00    10:00   20:00   30:00   40:00  45:00  │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ STATUS: Connected to iRacing │ GPU: RTX 4080 │ Encoding: Idle│
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 5.2 Page / View Structure

```
src/
├── components/
│   ├── App.jsx                    # Root app with router
│   ├── layout/
│   │   ├── AppShell.jsx           # Main layout wrapper
│   │   ├── Toolbar.jsx            # Top toolbar
│   │   ├── StatusBar.jsx          # Bottom status bar
│   │   └── Sidebar.jsx            # Collapsible left sidebar
│   ├── project/
│   │   ├── ProjectManager.jsx     # Project list, create, open
│   │   ├── ProjectCard.jsx        # Project thumbnail card (shows step indicator badge)
│   │   ├── NewProjectWizard.jsx   # Guided project creation with replay picker
│   │   ├── ProjectWorkflow.jsx    # Step indicator bar + step navigation (Setup → Upload)
│   │   ├── ProjectFileBrowser.jsx # File browser panel (project directory tree)
│   │   └── ReplayPicker.jsx       # Auto-discover .rpy files, browse, copy-to-project
│   ├── timeline/
│   │   ├── Timeline.jsx           # Main timeline component
│   │   ├── TimelineTrack.jsx      # Single track (camera, events, etc.)
│   │   ├── TimelineEvent.jsx      # Draggable event on timeline
│   │   ├── TimelineCursor.jsx     # Playhead cursor
│   │   ├── TimelineRuler.jsx      # Time ruler with zoom
│   │   ├── TimelineZoom.jsx       # Zoom controls
│   │   └── TimelineSelection.jsx  # Range selection
│   ├── preview/
│   │   ├── PreviewViewport.jsx    # Video preview canvas
│   │   ├── PreviewControls.jsx    # Play/pause/seek controls
│   │   └── PreviewOverlay.jsx     # Overlay preview layer
│   ├── events/
│   │   ├── EventBrowser.jsx       # Categorised event list
│   │   ├── EventCard.jsx          # Individual event card
│   │   ├── EventInspector.jsx     # Detailed event editor
│   │   └── EventFilters.jsx       # Filter by type, severity, lap
│   ├── cameras/
│   │   ├── CameraConfig.jsx       # Track camera configuration
│   │   ├── CameraWeights.jsx      # Camera ratio sliders
│   │   ├── CameraPreview.jsx      # Camera angle preview
│   │   └── CameraTimeline.jsx     # Camera assignment timeline
│   ├── overlays/
│   │   ├── OverlayEditor.jsx      # Split-pane Monaco HTML editor + live preview
│   │   ├── OverlayPreview.jsx     # Live overlay preview composited on video
│   │   ├── OverlayTemplateList.jsx # Template browser (built-in + custom)
│   │   ├── OverlayPropertyPanel.jsx # No-code visual controls (position, font, colour)
│   │   ├── OverlayDataInspector.jsx # Template variable browser with live sample data
│   │   └── OverlayElement.jsx     # Draggable/resizable overlay element in preview
│   ├── export/
│   │   ├── ExportPanel.jsx        # Export settings and controls
│   │   ├── ExportPresets.jsx      # Preset manager
│   │   ├── EncodingProgress.jsx   # Real-time encoding progress
│   │   └── GPUSelector.jsx        # GPU selection for encoding
│   ├── youtube/
│   │   ├── YouTubePanel.jsx       # Channel connection, video listing, upload history
│   │   ├── UploadDialog.jsx       # Upload configuration (title, description, tags, privacy)
│   │   ├── UploadProgress.jsx     # Upload progress with resume/retry
│   │   └── VideoCard.jsx          # YouTube video listing card with link + stats
│   ├── pipeline/
│   │   ├── PipelinePanel.jsx      # One-click pipeline execution UI
│   │   ├── PipelineConfig.jsx     # Configuration preset editor (save/load/version)
│   │   ├── PipelineLog.jsx        # Step-by-step execution log viewer
│   │   └── PipelineStepCard.jsx   # Individual pipeline step status card
│   ├── highlights/
│   │   ├── HighlightSuite.jsx     # Main highlight editing suite container
│   │   ├── RuleWeightPanel.jsx    # Interactive rule weight sliders
│   │   ├── EventSelectionTable.jsx # Sortable/filterable event inclusion table
│   │   ├── HighlightMetrics.jsx   # Live metrics dashboard (duration, coverage, balance)
│   │   ├── HighlightTimeline.jsx  # Condensed highlight reel timeline preview
│   │   └── ConfigComparison.jsx   # A/B compare mode for different weight configs
│   ├── settings/
│   │   ├── SettingsPanel.jsx      # Global settings
│   │   ├── HotkeyConfig.jsx       # Hotkey configuration
│   │   └── PathConfig.jsx         # Working directory, paths
│   └── ui/
│       ├── Toast.jsx              # Toast notification system
│       ├── Modal.jsx              # Modal dialog system
│       ├── LoadingSpinner.jsx     # Loading states
│       ├── Slider.jsx             # Range slider component
│       ├── Dropdown.jsx           # Dropdown select
│       ├── Toggle.jsx             # Toggle switch
│       ├── Tooltip.jsx            # Tooltip component
│       └── ProgressBar.jsx        # Progress bar component
├── context/
│   ├── ProjectContext.jsx         # Current project state + step workflow
│   ├── TimelineContext.jsx        # Timeline state (zoom, position, selection)
│   ├── IRacingContext.jsx         # iRacing connection state
│   ├── SettingsContext.jsx        # Application settings
│   ├── PipelineContext.jsx        # Pipeline execution state (running, paused, step statuses)
│   ├── YouTubeContext.jsx         # YouTube auth state + channel info
│   └── ToastContext.jsx           # Toast notification state
├── hooks/
│   ├── useProject.js              # Project operations + step navigation
│   ├── useTimeline.js             # Timeline interaction
│   ├── usePreview.js              # Preview frame fetching
│   ├── useHighlights.js           # Highlight editing suite (rule weights, reprocess, metrics)
│   ├── useIRacing.js              # iRacing connection
│   ├── useWebSocket.js            # WebSocket connection
│   ├── useKeyboard.js             # Keyboard shortcuts
│   ├── useUndo.js                 # Undo/redo management
│   ├── usePipeline.js             # Pipeline execution (start, pause, resume, cancel, status)
│   ├── useYouTube.js              # YouTube auth, channel, upload, video listing
│   └── useLocalStorage.js         # Persistent local state
├── services/
│   ├── api.js                     # HTTP API client
│   ├── websocket.js               # WebSocket client
│   ├── projectService.js          # Project CRUD operations + step management
│   ├── eventService.js            # Event CRUD operations
│   ├── highlightService.js        # Highlight editing suite API (reprocess, metrics, overrides)
│   ├── cameraService.js           # Camera configuration
│   ├── captureService.js          # OBS/ShadowPlay capture control
│   ├── encodingService.js         # Encoding job management
│   ├── previewService.js          # Preview frame fetching
│   ├── youtubeService.js          # YouTube auth, channel, upload, video listing
│   └── pipelineService.js         # Pipeline execution, config presets CRUD
└── utils/
    ├── time.js                    # Time formatting utilities
    ├── color.js                   # Color utilities for overlays
    └── constants.js               # Application constants
```

### 5.3 UI Design Principles (From Reference Docs)

Following the established conventions:

1. **Toast Notifications** — Never use `alert()`, `confirm()`, or `prompt()`. Use toast system for feedback, modal system for confirmations.
2. **Context-Based State** — No prop drilling. Use React Context for project, timeline, iRacing connection, settings.
3. **Framer Motion Animations** — Use `m.*` wrapper for motion-preference-aware animations. Cards with buttons use shadow-only hover.
4. **Tailwind Design System** — Consistent spacing, typography, color tokens.
5. **Keyboard Shortcuts** — Professional NLE shortcuts: `Space` = play/pause, `J/K/L` = shuttle, `I/O` = set in/out points, `Ctrl+Z/Y` = undo/redo.
6. **Dark Theme** — Default dark theme suitable for video editing (reduces eye strain).
7. **Responsive Panels** — Resizable panels with drag handles (sidebar, timeline height, inspector).

### 5.4 Real-Time Communication

```
Frontend ←──WebSocket──→ Backend

Messages FROM Backend:
  iracing:connected         # iRacing connection established
  iracing:disconnected      # iRacing connection lost  
  iracing:session_data      # New session data available
  iracing:telemetry         # Telemetry update (throttled)
  analysis:progress         # Analysis progress update
  analysis:event_found      # New event detected
  analysis:complete         # Analysis finished
  highlight:reprocessed     # Highlight reprocessing complete (new selection + metrics)
  highlight:metrics_update  # Live metrics update during editing
  encoding:progress         # Encoding progress (%, fps, ETA)
  encoding:complete         # Encoding finished
  encoding:error            # Encoding failed
  capture:started           # OBS/ShadowPlay started recording
  capture:stopped           # Capture stopped, file available
  capture:error             # Capture failed (hotkey mismatch, software not running)
  preview:frame_ready       # Preview frame available
  pipeline:step_started     # Pipeline step began (step name, index)
  pipeline:step_progress    # Pipeline step progress (%, message)
  pipeline:step_completed   # Pipeline step finished (step name, duration)
  pipeline:step_failed      # Pipeline step failed (step name, error, retry count)
  pipeline:paused           # Pipeline paused by user
  pipeline:resumed          # Pipeline resumed
  pipeline:complete         # All pipeline steps finished
  youtube:upload_progress   # YouTube upload progress (%, bytes, speed)
  youtube:upload_complete   # Upload finished (video ID, URL)
  youtube:upload_error      # Upload failed (error message, retry available)

Messages FROM Frontend:
  replay:play               # Start/resume replay playback
  replay:pause              # Pause replay
  replay:seek               # Seek to time position
  replay:speed              # Set replay speed
  replay:camera             # Switch camera
  highlight:reprocess       # Trigger highlight reprocessing with current weights
  highlight:override        # Manual event include/exclude toggle
  preview:request_frame     # Request frame at timestamp
  preview:start_stream      # Start preview streaming
  preview:stop_stream       # Stop preview streaming
  encoding:start            # Start encoding job
  encoding:cancel           # Cancel encoding job
  pipeline:start            # Start automated pipeline
  pipeline:pause            # Pause pipeline at next safe point
  pipeline:resume           # Resume paused pipeline
  pipeline:cancel           # Cancel pipeline entirely
  pipeline:retry_step       # Retry a failed step
  youtube:cancel_upload     # Cancel in-progress upload
```

---

## 6. Backend API Design

### 6.1 REST Endpoints

All endpoints use snake_case (per API conventions guide).

```
# Project Management
GET     /api/projects                          # List all projects
POST    /api/projects                          # Create new project
GET     /api/projects/{id}                     # Get project details
PUT     /api/projects/{id}                     # Update project
DELETE  /api/projects/{id}                     # Delete project

# iRacing Connection
GET     /api/iracing/status                    # Connection status + session info
GET     /api/iracing/session                   # Full session data
GET     /api/iracing/cameras                   # Available cameras for current track
POST    /api/iracing/replay/play               # Play replay
POST    /api/iracing/replay/pause              # Pause replay
POST    /api/iracing/replay/seek               # Seek to frame/time
POST    /api/iracing/replay/speed              # Set replay speed
POST    /api/iracing/replay/camera             # Switch camera

# Replay Analysis
POST    /api/projects/{id}/analyse             # Start analysis
GET     /api/projects/{id}/analysis/status     # Analysis progress
GET     /api/projects/{id}/events              # Get all detected events
PUT     /api/projects/{id}/events/{eid}        # Edit event (adjust times, etc.)
DELETE  /api/projects/{id}/events/{eid}        # Remove event
POST    /api/projects/{id}/events              # Add manual event

# Camera Direction
GET     /api/projects/{id}/cameras             # Get camera assignments
POST    /api/projects/{id}/cameras/generate    # Auto-generate camera plan
PUT     /api/projects/{id}/cameras/{cid}       # Edit camera assignment
POST    /api/projects/{id}/cameras             # Add manual camera assignment
DELETE  /api/projects/{id}/cameras/{cid}       # Remove camera assignment

# Track Camera Config
GET     /api/track-cameras                     # List all track configs
GET     /api/track-cameras/{track}             # Get config for track
PUT     /api/track-cameras/{track}             # Update track camera config

# Overlay Templates
GET     /api/projects/{id}/overlays/templates       # List available templates (built-in + custom)
GET     /api/projects/{id}/overlays/templates/{tid} # Get template HTML source
PUT     /api/projects/{id}/overlays/templates/{tid} # Update template HTML/config
POST    /api/projects/{id}/overlays/templates       # Create new template (or duplicate built-in)
DELETE  /api/projects/{id}/overlays/templates/{tid} # Delete custom template
POST    /api/projects/{id}/overlays/render-frame    # Render single overlay frame → PNG (for preview)
GET     /api/projects/{id}/overlays/data-context    # Get available template variables with sample data
PUT     /api/projects/{id}/overlays/active           # Set which template is active for this project

# Edit Decision List
GET     /api/projects/{id}/edl                 # Get edit decision list
POST    /api/projects/{id}/edl/generate        # Auto-generate from events
PUT     /api/projects/{id}/edl/{did}           # Modify edit decision
POST    /api/projects/{id}/edl                 # Add manual cut/include
DELETE  /api/projects/{id}/edl/{did}           # Remove edit decision

# Highlight Editing Suite
GET     /api/projects/{id}/highlights/config   # Get current rule weights + settings
PUT     /api/projects/{id}/highlights/config   # Update rule weights + settings
POST    /api/projects/{id}/highlights/reprocess # Reprocess with current config → returns updated selection + metrics
GET     /api/projects/{id}/highlights/metrics  # Get live metrics (duration, event counts, coverage)
GET     /api/projects/{id}/highlights/events   # Get scored event list with inclusion status
PUT     /api/projects/{id}/highlights/events/{eid}/override  # Manual include/exclude override
DELETE  /api/projects/{id}/highlights/events/{eid}/override  # Remove manual override
POST    /api/projects/{id}/highlights/configs/save   # Save a named weight configuration
GET     /api/projects/{id}/highlights/configs        # List saved configurations
POST    /api/projects/{id}/highlights/compare        # A/B compare two configurations

# Capture (OBS/ShadowPlay)
GET     /api/capture/software                  # Detect available capture software
GET     /api/capture/config                    # Get capture config (hotkeys, paths)
PUT     /api/capture/config                    # Update capture config
POST    /api/capture/test                      # Test hotkey → verify recording starts
POST    /api/capture/start                     # Start capture (send hotkey)
POST    /api/capture/stop                      # Stop capture (send hotkey)
GET     /api/capture/status                    # Capture status (recording, file size, duration)

# Export / Encoding
GET     /api/encoding/gpus                     # Detect available GPUs
GET     /api/projects/{id}/export/presets      # Get export presets
POST    /api/projects/{id}/export/start        # Start encoding
GET     /api/projects/{id}/export/status       # Encoding progress
POST    /api/projects/{id}/export/cancel       # Cancel encoding
GET     /api/projects/{id}/export/files        # List exported files

# Preview (Tiered Asset Pipeline)
GET     /api/projects/{id}/preview/status      # Asset generation status (keyframe, sprites, proxy, audio)
GET     /api/projects/{id}/preview/frame       # Get decoded frame at time (?t=123.45&quality=proxy|source)
GET     /api/projects/{id}/preview/sprite/{n}  # Get sprite sheet image N
GET     /api/projects/{id}/preview/sprite-index # Get sprite sheet coordinate index (JSON)
GET     /api/projects/{id}/preview/audio       # Stream extracted audio track (.m4a)
GET     /api/projects/{id}/preview/thumbnail   # Get single thumbnail at time (?t=123.45)
WS      /api/projects/{id}/preview/stream      # WebSocket: binary frame stream for playback

# Settings
GET     /api/settings                          # Get all settings
PUT     /api/settings                          # Update settings
GET     /api/settings/youtube                  # Get YouTube settings (API key, channel, defaults)
PUT     /api/settings/youtube                  # Update YouTube settings

# YouTube Integration
GET     /api/youtube/auth/status               # Check OAuth status (connected/disconnected)
POST    /api/youtube/auth/start                # Begin OAuth flow (returns auth URL)
POST    /api/youtube/auth/callback             # Handle OAuth callback with auth code
DELETE  /api/youtube/auth                      # Disconnect YouTube account (revoke token)
GET     /api/youtube/channel                   # Get connected channel info (name, subs, avatar)
GET     /api/youtube/videos                    # List uploaded videos (paginated, with stats)
POST    /api/projects/{id}/upload              # Start YouTube upload for project
GET     /api/projects/{id}/upload/status       # Upload progress (%, speed, ETA)
POST    /api/projects/{id}/upload/cancel       # Cancel in-progress upload
POST    /api/projects/{id}/upload/retry        # Retry failed upload

# Project Steps (Step-Based Workflow)
GET     /api/projects/{id}/step                # Get current step + completion status per step
PUT     /api/projects/{id}/step                # Advance or set project step
GET     /api/projects/{id}/files               # List project directory contents (file browser)

# Automated Pipeline
GET     /api/pipeline/configs                  # List saved pipeline configuration presets
POST    /api/pipeline/configs                  # Create new pipeline config preset
GET     /api/pipeline/configs/{cid}            # Get specific config
PUT     /api/pipeline/configs/{cid}            # Update config
DELETE  /api/pipeline/configs/{cid}            # Delete config
POST    /api/projects/{id}/pipeline/start      # Start automated pipeline (with config ID)
POST    /api/projects/{id}/pipeline/pause      # Pause pipeline at next safe point
POST    /api/projects/{id}/pipeline/resume     # Resume paused pipeline
POST    /api/projects/{id}/pipeline/cancel     # Cancel pipeline
POST    /api/projects/{id}/pipeline/retry-step # Retry a specific failed step
GET     /api/projects/{id}/pipeline/status     # Pipeline status (current step, progress, log)
GET     /api/projects/{id}/pipeline/history    # Pipeline run history for this project

# System
GET     /api/system/info                       # System info (GPUs, memory, disk)
GET     /api/system/health                     # Health check
```

---

## 7. Feature Specification

### 7.1 Project Manager

**New Project Wizard:**
1. Name the project
2. **Replay file picker**: auto-discover `.rpy` files from iRacing replays directory, or browse manually
3. Option to copy replay file into project directory (recommended) or reference in-place
4. Auto-populate track name, session type, drivers from iRacing session data or replay header
5. Select working directory for project files
6. Choose pipeline configuration preset (or use default)
7. Auto-discover track cameras and populate defaults
8. Project is created at **Step 1 (Setup)** — ready to proceed

**Project Library:**
- Grid or list view of all projects
- Thumbnail preview (first frame of captured video, or track map if no capture yet)
- Project metadata: track, date, number of drivers, **current step** (setup/analysis/editing/capture/export/upload)
- **Step indicator** shows workflow progress at a glance: ✅✅✅🔄⏳⏳
- Search and filter by track, date, status, step
- Quick actions: open, duplicate, delete, export, **run pipeline**
- **YouTube link badge**: shows if project has been uploaded, with quick link to video

**Step Navigation:**
- **Step indicator bar** at the top of every project view: clickable step badges
- Clicking a completed step jumps to that step's view for review
- Clicking the active step shows the current work area
- Future (incomplete) steps are greyed out but show what's needed to unlock them
- A prominent **"Continue →"** button always shows the next action to take

### 7.2 Replay Analysis

**Phase 1 — Fast Scan (~15-30 seconds):**
- Scrub iRacing replay at maximum speed
- Capture telemetry snapshots every ~2 seconds
- Detect: incidents (iRacing incident flags), lap times, positions, pit stops
- Build initial event list with approximate timings

**Phase 2 — Detail Pass (user-triggered):**
- When user clicks an event, replay that section for precise data
- Capture exact frame numbers for event boundaries
- Detect close battles (< 0.5s gap for configurable duration)
- Detect overtakes (position change with proximity)

**Analysis Results (shown in real-time as detected):**
- Events appear on timeline as they're found
- Each event gets an auto-generated severity score (0-10)
- User can immediately start editing before analysis completes

### 7.3 Timeline Editor

**Multi-Track Timeline:**

| Track | Description |
|-------|-------------|
| **Camera** | Shows which camera is active at each time, draggable edges |
| **Events** | All detected race events, colour-coded by type |
| **Overlays** | Overlay visibility regions (leaderboard on/off) |
| **Cuts** | Edit decision marks — what's included vs. excluded |
| **Audio** | Audio waveform with volume keyframes |

**Interaction:**
- Click event → jumps preview to that moment
- Drag event edges → adjust start/end time (frame-accurate)
- Drag event → move it (with snap-to-grid option)
- `I` key → set in-point at playhead
- `O` key → set out-point at playhead
- Right-click → context menu (split, delete, change camera, add marker)
- Scroll → zoom timeline in/out
- Middle-drag → pan timeline
- Ctrl+scroll → vertical zoom (show/hide tracks)

**Zoom Levels:**
- Full race overview (1px = 5 seconds)
- Section view (1px = 1 second)
- Detail view (1px = 1 frame @ 60fps)

### 7.4 Event Inspector

When an event is selected, the inspector shows:

```
┌─────────────────────────────┐
│ INCIDENT — Lap 3, Turn 4   │
├─────────────────────────────┤
│ Type:     [Incident ▾]      │
│ Severity: ████████░░ 8/10   │
│ Start:    [03:24.560]       │
│ End:      [03:31.200]       │
│ Duration: 6.64s             │
│                             │
│ Involved Drivers:           │
│ ☑ #42 J. Hooks              │
│ ☑ #18 M. Cooper             │
│ ☐ #7  D. Netherton          │
│                             │
│ Camera:   [TV3 ▾]           │
│ Target:   [#42 J. Hooks ▾]  │
│ Transition: [Cut ▾]         │
│                             │
│ ☑ Include in Highlight      │
│ ☐ Slow Motion (0.5×)        │
│                             │
│ [Apply Changes] [Revert]    │
│ [Split Event] [Delete]      │
└─────────────────────────────┘
```

### 7.5 Preview System

The preview system operates on **recorded video files** (captured via OBS/ShadowPlay), which can be **5-15 GB** for a 45-minute race. This is the major upgrade over legacy — the user can see exactly what their final output will look like — and we've engineered it to feel instant regardless of file size. (See Section 4.7 for full technical architecture.)

**Asset Pipeline (Background Generation on Import):**
- **Keyframe index** — Instant (~5s). Maps every keyframe timestamp → byte offset for O(1) seeking
- **Thumbnail sprite sheets** — Fast (~30-60s). 160×90 JPEG grids at 1 frame/second for timeline scrub
- **Proxy video** — Background (~1-3 min). 540p30 re-encode with 0.5s keyframe intervals for smooth playback
- **Audio track** — Instant (~5s). Extracted AAC/PCM for independent, stutter-free audio sync
- **Progressive availability**: Sprite sheets are ready within a minute; proxy generates in background while the UI is already fully usable

**Scrub Preview (Zero Latency):**
- Dragging the timeline playhead → **sprite sheet thumbnails rendered client-side** (no server request)
- Sprite sheets are loaded once on project open (~5-20 MB) and cached in browser memory
- CSS `background-position` on cached sprite image = **0ms latency** during fast scrubbing
- On scrub release → server returns full proxy frame with overlays (< 50ms)
- If paused for > 1 second → seamless upgrade to **full-resolution source frame** (< 500ms)

**Playback Preview:**
- Press play → WebSocket stream of decoded frames from **proxy video** at 30fps real-time
- Audio from extracted audio track plays via HTML5 `<audio>` element, synchronised via JS `currentTime`
- Overlays (leaderboard, driver tags, etc.) composited server-side per-frame
- Playback speed controls: 0.25×, 0.5×, 1×, 2×
- Audio decoupled from video decode — never stutters even during heavy overlay rendering

**Highlight Preview Mode:**
- Preview the **condensed highlight reel** as it would appear after encoding
- Maps highlight-timeline position → source video position via the edit decision list
- Uses proxy video for smooth cross-segment jumps (0.5s keyframes = < 50ms seek)
- See the exact cuts, transitions, and included events
- Updates live as you change event inclusion/exclusion or algorithm parameters

**Fallback Strategy (Proxy Not Yet Ready):**
- Timeline scrub still works instantly via sprite sheets
- Playback falls back to direct source decode (higher latency, may drop frames)
- Status bar shows generation progress: "Generating preview... 45% (2:31 remaining)"
- Once proxy is ready, preview seamlessly upgrades — no user action needed

**Preview Modes:**
| Mode | Description |
|------|-------------|
| **Full Race** | Scrub/play through complete video with overlays |
| **Highlight Preview** | Condensed highlight reel mapped through EDL |
| **Source** | Raw recorded video without overlays |
| **Split** | Source on left, composited output on right |

### 7.6 Overlay System — HTML/Tailwind Template Engine

Replaces legacy GDI+ plugin system with a **fully dynamic, HTML-native overlay engine**. Every overlay is an HTML document styled with Tailwind CSS, rendered to transparent frames via headless Chromium, and composited onto video during preview and export. Users can edit overlay templates directly in the application with instant live preview — or create entirely new overlays from scratch using familiar web technologies.

#### 7.6.1 Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     OVERLAY TEMPLATE ENGINE                       │
│                                                                  │
│  Template Files (.html)                                          │
│  ├── Standard Tailwind CSS classes for styling                   │
│  ├── Jinja2 data bindings: {{ leaderboard }}, {{ driver.name }} │
│  ├── CSS animations for fade/slide/pop transitions               │
│  └── Responsive to output resolution (1080p, 1440p, 4K)         │
│                                                                  │
│  Template Data Context (injected per-frame)                      │
│  ├── positions[]    — live race positions with gaps              │
│  ├── driver         — focused driver (name, number, team colour) │
│  ├── lap            — current / total laps                       │
│  ├── fastest_lap    — driver, time, delta                        │
│  ├── battles[]      — active battles with gap info               │
│  ├── session        — track name, series, date                   │
│  ├── timestamp      — current video timestamp                    │
│  └── custom         — user-defined variables                     │
│                                                                  │
│  Rendering Pipeline                                              │
│  ├── Playwright headless Chromium (offscreen, --disable-gpu)     │
│  ├── Template + data context → rendered HTML page                │
│  ├── Page.screenshot(type='png', omit_background=True)           │
│  ├── Transparent PNG overlay (1920×1080 or native resolution)    │
│  └── Composited onto video frame via Pillow alpha_composite()    │
│                                                                  │
│  Performance                                                     │
│  ├── Persistent browser context (no cold-start per frame)        │
│  ├── Page.evaluate() to update data bindings (no full reload)    │
│  ├── Screenshot → PNG in ~5-15ms per frame                       │
│  ├── Batch pre-render for export (render all overlay frames      │
│  │   to a transparent PNG sequence, then FFmpeg overlay filter)  │
│  └── Preview mode: render on-demand at playback framerate        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

#### 7.6.2 Template Structure

Each overlay template is a self-contained HTML file stored in the project's `overlays/templates/` directory:

```html
<!-- overlays/templates/leaderboard.html -->
<!DOCTYPE html>
<html class="bg-transparent">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=1920, height=1080">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    // Tailwind config for iRacing-specific colours, fonts, etc.
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            'iracing-blue': '#005AFF',
            'iracing-yellow': '#FFD700',
          },
          fontFamily: {
            'broadcast': ['Barlow Condensed', 'sans-serif'],
          }
        }
      }
    }
  </script>
  <style type="text/tailwindcss">
    /* Custom animations for overlay elements */
    @keyframes slideInLeft { from { transform: translateX(-100%); } to { transform: translateX(0); } }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .animate-slide-in { animation: slideInLeft 0.3s ease-out; }
    .animate-fade-in  { animation: fadeIn 0.2s ease-out; }
  </style>
</head>
<body class="w-[1920px] h-[1080px] bg-transparent overflow-hidden relative">

  <!-- Leaderboard — top-right -->
  <div id="leaderboard" class="absolute top-4 right-4 w-72 animate-slide-in">
    {% for pos in positions %}
    <div class="flex items-center gap-2 px-3 py-1.5 mb-0.5 rounded-sm
                {{ 'bg-iracing-yellow/90 text-black' if pos.is_leader else 'bg-black/75 text-white' }}
                font-broadcast text-sm tracking-wide">
      <span class="w-6 text-center font-bold">{{ pos.position }}</span>
      <span class="w-8 text-center text-xs px-1 rounded"
            style="background-color: {{ pos.team_colour }};">{{ pos.car_number }}</span>
      <span class="flex-1 truncate">{{ pos.driver_name }}</span>
      <span class="text-xs opacity-75">{{ pos.gap }}</span>
      {% if pos.in_pit %}
      <span class="text-xs text-yellow-400 font-bold">PIT</span>
      {% endif %}
    </div>
    {% endfor %}
  </div>

</body>
</html>
```

#### 7.6.3 Built-in Template Library

| Template | Elements Included | Style |
|----------|-------------------|-------|
| **Broadcast** | Leaderboard, driver tag, lap counter, fastest lap pop-up, battle indicator, intro/outro cards | Full broadcast-TV look with team colours, animations, and graphic flourishes |
| **Minimal** | Position tracker, driver tag, lap counter | Clean, small overlays that stay out of the way |
| **Classic** | Leaderboard, lap counter | Retro iRacing-inspired styling |
| **Cinematic** | Driver tag only (lower-third) | Film-style presentation for montages |
| **Blank** | Empty template | Starting point for fully custom overlays |

Each template is a standard `.html` file. Users can **duplicate, modify, or create from scratch**.

#### 7.6.4 In-App Overlay Editor

The overlay editor is a **first-class feature** of League Replay Studio, not an afterthought:

**Live HTML/CSS Editor Panel:**
- **Split-pane view**: Code editor (left) + live preview (right)
- **Monaco Editor** (same editor engine as VS Code) for HTML/Tailwind editing with syntax highlighting, auto-complete, and error indicators
- **Instant preview**: Changes are reflected in real-time as you type — no save/reload cycle
- **Tailwind IntelliSense**: Class name auto-completion powered by Tailwind's JIT engine
- **Data context inspector**: See all available template variables (`{{ positions }}`, `{{ driver.name }}`, etc.) with live sample data from the current project

**Visual Controls (no-code mode):**
- **Element picker**: Click any overlay element in the preview to select it
- **Drag-to-reposition**: Move elements by dragging in the preview canvas
- **Resize handles**: Resize overlay regions visually
- **Property panel**: Font size, colours, opacity, padding, border radius — all Tailwind classes applied behind the scenes
- **Animation picker**: Choose from fade-in, slide-left, slide-up, pop, bounce — generates CSS keyframe animations
- **Visibility toggles**: Show/hide individual overlay elements per-project
- **Position presets**: Quick-snap to top-left, top-right, bottom-left, bottom-right, centre

**Template Management:**
- **Import**: Load `.html` template files from disk or URL
- **Export**: Save templates to share with others
- **Duplicate**: Fork a built-in template as a starting point
- **Version history**: Track changes to templates within the project
- **Per-project overrides**: Each project can customise any template without affecting the originals

**Preview Modes:**
| Mode | Description |
|------|-------------|
| **Editor Preview** | Live preview with sample data, updates as you type |
| **Race Preview** | Preview overlays composited on actual race video at current scrub position |
| **Full Playback** | Watch the video with overlays applied in real-time |
| **Export Preview** | Pixel-accurate preview of what the final export will look like |

#### 7.6.5 Rendering Pipeline (Backend)

```python
class OverlayRenderer:
    """Renders HTML/Tailwind overlay templates to transparent PNG frames
    using Playwright headless Chromium.
    """

    def __init__(self, template_dir: Path):
        self.template_dir = template_dir
        self.jinja_env = jinja2.Environment(
            loader=jinja2.FileSystemLoader(str(template_dir))
        )
        self._browser: Optional[Browser] = None
        self._page: Optional[Page] = None

    async def startup(self):
        """Launch persistent headless Chromium context (once per session)."""
        playwright = await async_playwright().start()
        self._browser = await playwright.chromium.launch(
            headless=True,
            args=['--disable-gpu', '--disable-software-rasterizer']
        )
        self._page = await self._browser.new_page(
            viewport={'width': 1920, 'height': 1080}
        )

    async def render_frame(self, template_name: str, data_context: dict) -> bytes:
        """Render a single overlay frame as transparent PNG.
        
        Fast path: update data bindings via JS evaluate, take screenshot.
        No full page navigation per frame — only initial load + JS updates.
        """
        # Render Jinja2 template with data context
        template = self.jinja_env.get_template(template_name)
        html = template.render(**data_context)

        # Load HTML into page (or update if same template)
        await self._page.set_content(html, wait_until='domcontentloaded')

        # Screenshot with transparent background
        return await self._page.screenshot(
            type='png',
            omit_background=True,
            full_page=False
        )

    async def render_frame_fast(self, data_context: dict) -> bytes:
        """Fast-path rendering: update data bindings without reloading HTML.
        
        After initial load, subsequent frames only update the data context
        via JavaScript, avoiding full DOM re-render. ~5-15ms per frame.
        """
        await self._page.evaluate(
            'window.__updateOverlayData(data)',
            {'data': data_context}
        )
        return await self._page.screenshot(
            type='png',
            omit_background=True,
            full_page=False
        )

    async def batch_render_for_export(
        self, template_name: str, frame_data: List[dict],
        output_dir: Path, resolution: Tuple[int, int] = (1920, 1080)
    ) -> Path:
        """Pre-render all overlay frames to PNG sequence for FFmpeg compositing.
        
        For export: renders every frame's overlay to a numbered PNG sequence.
        FFmpeg then overlays this sequence onto the video in a single pass.
        """
        await self._page.set_viewport_size(
            {'width': resolution[0], 'height': resolution[1]}
        )
        
        # Initial template load
        template = self.jinja_env.get_template(template_name)
        html = template.render(**frame_data[0])
        await self._page.set_content(html, wait_until='domcontentloaded')
        
        for i, data in enumerate(frame_data):
            png = await self.render_frame_fast(data)
            (output_dir / f'overlay_{i:06d}.png').write_bytes(png)
        
        return output_dir

    async def shutdown(self):
        if self._browser:
            await self._browser.close()
```

#### 7.6.6 Export Integration

During final video export, overlays are composited via FFmpeg's overlay filter using the pre-rendered PNG sequence:

```bash
ffmpeg -i source.mp4 \
       -framerate 60 -i overlays/overlay_%06d.png \
       -filter_complex "[0:v][1:v]overlay=0:0:format=auto" \
       -c:v h264_nvenc -preset p4 -tune hq \
       -c:a aac output.mp4
```

This separates the rendering concern (Playwright/HTML → PNG) from the encoding concern (FFmpeg → GPU), keeping both stages independent and parallelisable.

#### 7.6.7 Why HTML/Tailwind over Pillow/Cairo?

| Concern | Pillow/Cairo | HTML/Tailwind |
|---------|-------------|---------------|
| **Design skill floor** | Python code, coordinate maths | HTML/CSS — widely known, huge ecosystem |
| **Customizability** | Rebuild renderer for each layout | Edit HTML file, see changes instantly |
| **Typography** | Basic font rendering, manual kerning | Full CSS typography: Google Fonts, letter-spacing, line-height |
| **Animation** | Frame-by-frame manual interpolation | CSS keyframes, transitions — declarative |
| **Responsiveness** | Manual scaling calculations | CSS media queries, viewport units |
| **User-editable** | Requires Python knowledge | Any web developer (or AI) can create/modify templates |
| **Shareable** | Binary overlay packs | Single `.html` file — paste, share, fork |
| **Ecosystem** | Niche | Billions of Tailwind examples, templates, AI tools |
| **In-app editing** | Custom property panels per overlay type | Monaco editor + live preview — edit anything |
| **Maintenance** | Every new overlay = new Python code | Every new overlay = new HTML file |

### 7.7 Export System

**Export Presets:**

| Preset | Resolution | Codec | Bitrate | Use Case |
|--------|-----------|-------|---------|----------|
| YouTube 1080p | 1920×1080 | H.264 NVENC | 15 Mbps | Standard upload |
| YouTube 4K | 3840×2160 | H.265 NVENC | 30 Mbps | High quality |
| YouTube Shorts | 1080×1920 | H.264 NVENC | 8 Mbps | Vertical highlights |
| Discord | 1280×720 | H.264 NVENC | 8 Mbps | Quick sharing |
| Archive | Native | H.265 NVENC | 25 Mbps | Lossless-ish archive |
| Custom | Configurable | Any | Configurable | User-defined |

**Export Modes:**
- **Full Race** — Complete race with overlays
- **Highlights Only** — Auto-cut to target duration (configurable: 3, 5, 10, 15 min)
- **Both** — Full race + highlights in parallel (multi-GPU)
- **Custom Selection** — Export only the selected timeline range
- **Overlay Only** — Only first/last lap with overlays (legacy compatibility)

**Post-Export Actions:**
- **Open folder** — Open output directory in file explorer
- **Upload to YouTube** — If YouTube is connected, prompt to upload with pre-filled metadata from project (see Section 7.12). The export step's "Continue →" button leads directly to the Upload step.
- **Copy to clipboard** — Copy output file path for pasting
- **Queue next project** — In pipeline mode, auto-advance to next project

**Encoding Progress Dashboard:**
```
┌────────────────────────────────────────┐
│ ENCODING: Race_Daytona_2026-03-31      │
├────────────────────────────────────────┤
│                                        │
│ Full Race        ████████░░░ 78%       │
│ GPU: RTX 4080    437 fps | ETA: 1:23   │
│                                        │
│ Highlights       ██████████░ 92%       │
│ GPU: RTX 3060    312 fps | ETA: 0:18   │
│                                        │
│ Output: C:\Users\James\exports\        │
│                                        │
│ [Cancel All] [Pause] [Open Folder]     │
└────────────────────────────────────────┘
```

### 7.8 Highlight Editing Suite ⭐ (Crown Jewel Feature)

The highlight editing suite is the **primary differentiator** of League Replay Studio. Rather than a black-box algorithm that produces a fixed highlight reel, LRS exposes the entire event selection pipeline as an interactive, tuneable, real-time editing environment.

**Core Concept:** The user can see exactly why each event was selected, adjust the algorithm's weights and thresholds on the fly, make manual overrides, and watch the highlight reel update in real-time with live-updating metrics.

```
┌────────────────────────────────────────────────────────────────────────┐
│                    HIGHLIGHT EDITING SUITE                              │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  ┌──────────────────────────┐  ┌────────────────────────────────────┐ │
│  │  RULE WEIGHT TUNING      │  │  LIVE METRICS DASHBOARD            │ │
│  │                          │  │                                    │ │
│  │  Incidents   ████████░░  │  │  Total Duration:  5:23 / 5:00 ⚠️  │ │
│  │  Battles     ██████░░░░  │  │  Events Included: 14 / 38         │ │
│  │  Overtakes   █████░░░░░  │  │  Coverage:        62% of race     │ │
│  │  First Lap   ██████████  │  │                                    │ │
│  │  Last Lap    ██████████  │  │  By Type:                          │ │
│  │  Pit Stops   ██░░░░░░░░  │  │  ├── Incidents:  4  (1:12)        │ │
│  │  Leader      ████░░░░░░  │  │  ├── Battles:    5  (2:45)        │ │
│  │  Fastest Lap ███░░░░░░░  │  │  ├── Overtakes:  2  (0:34)        │ │
│  │  Preferred   ██████░░░░  │  │  ├── First Lap:  1  (0:28)        │ │
│  │                          │  │  ├── Last Lap:   1  (0:24)        │ │
│  │  Min Severity: ████░░ 4  │  │  └── Other:      1  (0:00)        │ │
│  │  Target Duration: 5:00   │  │                                    │ │
│  │                          │  │  Balance Score:   ★★★★☆            │ │
│  │  [Reprocess Now]         │  │  Pacing Score:    ★★★★★            │ │
│  │  [Auto-Balance]          │  │  Driver Coverage:  78%             │ │
│  └──────────────────────────┘  └────────────────────────────────────┘ │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  EVENT SELECTION TABLE                                     [⊞] │ │
│  │                                                                  │ │
│  │  ☑ │ Type     │ Lap │ Severity │ Duration │ Score │ Reason      │ │
│  │  ──┼──────────┼─────┼──────────┼──────────┼───────┼──────────── │ │
│  │  ☑ │ 🟢 Start  │  1  │  10/10   │  0:28    │  100  │ Mandatory   │ │
│  │  ☑ │ 🔴 Crash  │  3  │   8/10   │  0:18    │   87  │ High sev.   │ │
│  │  ☑ │ ⚔️ Battle │  5  │   7/10   │  0:42    │   76  │ P3/P4 close │ │
│  │  ☐ │ 🏁 Pit    │  8  │   3/10   │  0:15    │   32  │ Below cutoff│ │
│  │  ☑ │ ⚔️ Battle │ 11  │   9/10   │  0:55    │   91  │ Lead change │ │
│  │  ☐ │ 🟡 Spin   │ 14  │   4/10   │  0:12    │   38  │ Below cutoff│ │
│  │  ☑ │ 🏆 Finish │ 22  │  10/10   │  0:24    │  100  │ Mandatory   │ │
│  │  ...                                                             │ │
│  │                                                                  │ │
│  │  [Select All] [Deselect All] [Invert] [Sort by: Score ▾]       │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  HIGHLIGHT TIMELINE PREVIEW                                      │ │
│  │  ║▓START▓║░░░║▓CRASH▓║░░░║▓▓BATTLE▓▓║░░║▓▓BATTLE▓▓║░░║▓FIN▓║  │ │
│  │  0:00   0:28        1:15     1:57        3:34       4:52  5:23  │ │
│  │  ◁ ▷ ⏸ ⏮ ⏭                               [Preview Highlight]  │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

**Rule Weight Tuning:**
- Interactive sliders for each event type's priority weight (0–100)
- Minimum severity threshold slider (events below this are auto-excluded)
- Target duration control — algorithm adjusts inclusion to hit target
- "Auto-Balance" button — algorithm optimizes weights to distribute coverage evenly
- **All changes trigger instant reprocessing** — the event selection table and metrics update in real-time as you drag sliders

**Event Selection Table:**
- Full list of all detected race events with computed scores
- Checkbox column for manual include/exclude override
- Score column shows the algorithm's computed importance score for each event
- "Reason" column explains why the algorithm included or excluded each event
- Sort by score, type, lap, duration, severity
- Filter by event type, inclusion status, severity range
- Overridden events highlighted in a different color
- Click any event → timeline playhead jumps to that moment with live preview

**Manual Overrides:**
- ☑ Check/uncheck events to force-include or force-exclude from highlights
- Drag event edges in the timeline to adjust included duration per event
- Add custom "manual" events that don't come from the algorithm
- Reorder events in the highlight reel (drag to re-sequence)
- Override gets a visual indicator so you know what's auto vs. manual

**Live Metrics Dashboard:**
- **Total Duration** — Current highlight length vs. target (with over/under warning)
- **Event Counts by Type** — Breakdown of included events per category
- **Coverage %** — What percentage of the race is represented
- **Balance Score** — How well-distributed are the events across the race (avoid front-loading)
- **Pacing Score** — How well the highlight flows (no two incidents back-to-back, breathing room)
- **Driver Coverage** — What % of drivers appear in the highlight
- All metrics update in real-time as rule weights or manual selections change

**Reprocessing:**
- "Reprocess Now" button triggers the event selection algorithm with current weights
- Results update within milliseconds (algorithm runs on cached telemetry data, not iRacing replay)
- Full history of reprocessing runs — can compare different weight configurations
- "A/B Compare" mode — save two different configurations and switch between them

```python
class HighlightEditor:
    """The highlight editing suite backend logic."""
    
    async def reprocess(
        self,
        project: Project,
        rule_weights: Dict[str, float],  # event_type -> weight (0-100)
        min_severity: int,
        target_duration_seconds: int,
        manual_overrides: List[ManualOverride],
    ) -> HighlightResult:
        """Reprocess event selection with updated parameters.
        Returns instantly from cached telemetry data."""
        
        # 1. Score all events with current weights
        scored_events = []
        for event in project.race_events:
            weight = rule_weights.get(event.event_type, 50)
            score = event.severity * (weight / 100)
            scored_events.append(ScoredEvent(event, score))
        
        # 2. Apply manual overrides (force include/exclude)
        for override in manual_overrides:
            event = find_event(scored_events, override.event_id)
            if override.force_include:
                event.force_included = True
            elif override.force_exclude:
                event.force_excluded = True
        
        # 3. Select events to fit target duration
        # Mandatory events first (first lap, last lap)
        # Then by score descending until target duration reached
        selected = self._select_to_fit(
            scored_events, target_duration_seconds
        )
        
        # 4. Compute metrics
        metrics = HighlightMetrics(
            total_duration=sum(e.duration for e in selected),
            target_duration=target_duration_seconds,
            event_counts=Counter(e.event_type for e in selected),
            coverage_percent=self._compute_coverage(selected, project),
            balance_score=self._compute_balance(selected, project),
            pacing_score=self._compute_pacing(selected),
            driver_coverage=self._compute_driver_coverage(selected, project),
        )
        
        # 5. Generate EDL for the highlight reel
        edl = self._generate_edl(selected)
        
        return HighlightResult(
            selected_events=selected,
            all_events=scored_events,
            metrics=metrics,
            edl=edl,
        )
```

### 7.9 Settings System

**General Settings:**
- Default working directory
- Default export preset
- Preferred drivers (comma-separated iRacing names)
- Auto-analyse on project creation (yes/no)
- Auto-generate camera plan after analysis (yes/no)
- Theme: dark / light / system

**Camera Defaults:**
- Default camera sticky period (seconds)
- Default battle sticky period (seconds)
- Battle gap threshold (seconds)
- Incident position cutoff (ignore incidents below position N)
- Ignore incidents during race start (yes/no)

**Encoding Defaults:**
- Preferred GPU
- Default codec (H.264 / H.265 / AV1)
- Default bitrate
- Two-pass encoding (yes/no)
- Highlight target duration (minutes)
- Auto-shutdown after encoding (yes/no)

**Hotkeys:**
- Fully configurable keyboard shortcuts
- Defaults: `Space` = play/pause, `J/K/L` = shuttle, `I/O` = in/out, etc.

**YouTube Integration:**
- OAuth connection status (connected / disconnected / expired)
- Connect / Disconnect button (triggers OAuth flow)
- Default video privacy: public / unlisted / private
- Default description template (Jinja2 with `{{ track_name }}`, `{{ drivers }}`, etc.)
- Default tags (comma-separated, plus auto-generated from project)
- Auto-upload after export: on / off / ask
- Upload quality preference: original / re-encode for YouTube

**Pipeline Defaults:**
- Default pipeline configuration preset
- Auto-start pipeline on project creation: yes / no
- Notification on pipeline completion: toast / system notification / none
- Pause pipeline on failure: pause / skip step / abort

### 7.10 CLI / Headless Mode

League Replay Studio supports **non-interactive command-line operation** so that once a project configuration is tuned in the UI, the user can batch-process or script their workflow without any GUI appearing.

#### Entry Point

```bat
REM Export highlights from an existing project (no UI)
lrs.bat --project "C:\Projects\Daytona 500" --highlights

REM Export full race video (no UI)
lrs.bat --project "C:\Projects\Daytona 500" --full-race

REM Export both full race and highlights
lrs.bat --project "C:\Projects\Daytona 500" --full-race --highlights

REM Use a specific export preset
lrs.bat --project "C:\Projects\Daytona 500" --highlights --preset "YouTube 1080p"

REM Override output path
lrs.bat --project "C:\Projects\Daytona 500" --highlights --output "D:\Videos\daytona_highlights.mp4"

REM Run analysis only (no encode — useful for re-scanning with new settings)
lrs.bat --project "C:\Projects\Daytona 500" --analyse-only

REM Run full pipeline: connect to iRacing, analyse, capture, encode highlights
lrs.bat --project "C:\Projects\Daytona 500" --full-pipeline --highlights
```

#### CLI Architecture

```python
# backend/cli.py — CLI entry point (separate from app.py)
import argparse
import sys
from server.services.project_manager import ProjectManager
from server.services.encoding_engine import EncodingEngine
from server.services.replay_analyser import ReplayAnalyser
from server.services.highlight_editor import HighlightEditor

def main():
    parser = argparse.ArgumentParser(
        prog='lrs',
        description='League Replay Studio — CLI mode'
    )
    parser.add_argument('--project', required=True,
                        help='Path to project directory')
    parser.add_argument('--highlights', action='store_true',
                        help='Export highlight reel')
    parser.add_argument('--full-race', action='store_true',
                        help='Export full race video')
    parser.add_argument('--preset', default=None,
                        help='Export preset name (default: project default)')
    parser.add_argument('--output', default=None,
                        help='Override output file path')
    parser.add_argument('--analyse-only', action='store_true',
                        help='Run analysis scan only, do not encode')
    parser.add_argument('--full-pipeline', action='store_true',
                        help='Full pipeline: analyse → capture → encode')
    parser.add_argument('--gpu', type=int, default=None,
                        help='GPU device index for encoding (default: auto)')
    parser.add_argument('--verbose', '-v', action='store_true',
                        help='Verbose logging to stdout')
    parser.add_argument('--quiet', '-q', action='store_true',
                        help='Suppress all output except errors')

    args = parser.parse_args()

    # Load project from disk (no UI, no FastAPI server)
    project = ProjectManager.load_project(args.project)

    if args.analyse_only:
        analyser = ReplayAnalyser(project)
        analyser.run_scan()         # Requires iRacing to be running
        print(f"Analysis complete: {project.event_count()} events detected")
        sys.exit(0)

    if args.highlights:
        editor = HighlightEditor(project)
        edl = editor.generate_edl()  # Uses saved highlight config
        engine = EncodingEngine(project, gpu=args.gpu)
        engine.encode_highlights(edl, preset=args.preset, output=args.output)
        print(f"Highlights exported: {engine.output_path}")

    if args.full_race:
        engine = EncodingEngine(project, gpu=args.gpu)
        engine.encode_full_race(preset=args.preset, output=args.output)
        print(f"Full race exported: {engine.output_path}")

    sys.exit(0)

if __name__ == '__main__':
    main()
```

**Key design points:**
- **No server started** — CLI mode loads project directly from SQLite, bypasses FastAPI entirely
- **No UI** — pywebview window is never created; output goes to stdout/stderr
- **Same engine** — Uses the exact same `EncodingEngine`, `HighlightEditor`, and `ReplayAnalyser` classes as the GUI
- **Exit codes** — `0` = success, `1` = project error, `2` = iRacing not running, `3` = encoding failed
- **Progress to stdout** — In non-quiet mode, prints progress: `Encoding... 45% (ETA: 2:31)`
- **Scriptable** — Can be called from batch files, CI pipelines, or scheduled tasks

#### Batch Files

```bat
REM lrs.bat — Main entry point (auto-detects GUI vs CLI mode)
@echo off
if "%~1"=="" (
    REM No arguments → launch GUI
    python backend/app.py
) else (
    REM Arguments provided → CLI mode
    python backend/cli.py %*
)
```

### 7.11 Discord Voice Chat Overlay (Future Feature)

> **Status**: Post-v1.0 feature. Included here for architecture planning so the overlay and audio systems are designed with extensibility in mind.

#### Concept

Overlay recorded Discord voice chat onto the race video so viewers hear driver comms synchronised with the on-screen action. This transforms a race highlight from a silent/engine-only video into a broadcast-style experience with team radio.

#### Technical Challenges

| Challenge | Approach |
|-----------|----------|
| **Timestamp sync** | Discord recordings don't carry iRacing timestamps. Need a sync mechanism — see below |
| **Per-speaker isolation** | Discord bot records per-user audio streams (Craig bot does this). Each speaker → separate audio track |
| **Speaker identification** | Map Discord user → iRacing driver. Config file or UI mapping table |
| **Audio mixing** | Merge N voice tracks + game audio → final mix with configurable volume per source |
| **Visual overlay** | Show "radio" indicator when a driver is speaking — driver name + waveform on screen |

#### Timestamp Synchronisation Strategy

The fundamental problem: the Discord voice recording and the iRacing replay recording start at different times. We need to align them.

**Option A — Manual Sync Point (MVP):**
```
User plays both recordings and identifies a common moment:
  "At 3:42 in the Discord recording, someone says 'green green green' 
   which corresponds to race start at session_time 45.2s"

The app stores this offset:
  discord_offset = discord_timestamp - session_time
  e.g., 222.0 - 45.2 = 176.8 seconds
```
Simple, reliable, no external dependencies. User picks one sync point and the app handles the rest.

**Option B — Automated Sync via Discord Bot Timestamp (Better):**
```
1. A lightweight Discord bot joins the voice channel during the race
2. The bot records audio AND logs UTC timestamps for each voice segment
3. iRacing telemetry also records UTC wall-clock time alongside session_time
4. Alignment: match UTC timestamps between the two sources
```

**Option C — Audio Fingerprinting (Advanced, Future):**
```
1. Extract game audio from the OBS recording
2. Extract game audio bleed from the Discord recording (drivers have speakers on)
3. Cross-correlate the two audio signals to find the offset automatically
```

#### Data Model

```sql
-- Discord voice chat tracks (one per speaker)
CREATE TABLE discord_voice_tracks (
    id INTEGER PRIMARY KEY,
    discord_user_id TEXT,
    discord_username TEXT,
    driver_car_idx INTEGER REFERENCES drivers(car_idx),  -- mapped to iRacing driver
    audio_file_path TEXT NOT NULL,       -- path to per-speaker audio file
    sync_offset_seconds REAL NOT NULL,  -- offset to align with session_time
    volume REAL DEFAULT 1.0,
    enabled BOOLEAN DEFAULT TRUE
);

-- Voice activity segments (for visual overlay timing)
CREATE TABLE voice_activity (
    id INTEGER PRIMARY KEY,
    track_id INTEGER REFERENCES discord_voice_tracks(id),
    start_session_time REAL NOT NULL,   -- aligned to race session_time
    end_session_time REAL NOT NULL,
    peak_amplitude REAL                 -- for waveform visualisation
);
```

#### Overlay Rendering

When a driver speaks:
- **Radio indicator** — small microphone icon appears next to the driver's name in the leaderboard
- **Speaker tag** — lower-third overlay: `🎙️ #42 J. Hooks` with a subtle voice waveform
- **Audio mixing** — game audio ducks slightly (configurable) when voice is active, restoring when silent

#### Recording Workflow (Using Craig Bot)

1. **Before the race**: User starts [Craig](https://craig.chat/) recording in the Discord voice channel
2. **After the race**: Craig provides per-user `.flac` files via DM
3. **In League Replay Studio**: User imports the Craig audio files, maps Discord users to iRacing drivers, sets one sync point
4. **Preview**: Voice overlay shows in real-time during preview playback
5. **Export**: Voice tracks are mixed into the final FFmpeg encode pipeline

#### Architecture Considerations for v1.0

Even though this is a post-v1.0 feature, the v1.0 architecture should be designed to support it:

- **Audio track abstraction** — The timeline should support multiple audio tracks (not just game audio)
- **Overlay extensibility** — The overlay system should accept event-driven overlays (voice activity = events)
- **FFmpeg pipeline** — The encoding pipeline should support multiple audio input streams with independent volume/offset

### 7.12 YouTube Channel Integration

League Replay Studio integrates directly with the **YouTube Data API v3** to provide end-to-end video production: from iRacing replay to published YouTube video without leaving the application.

#### 7.12.1 Settings — YouTube Connection

A dedicated **YouTube** section in the Settings panel handles channel linking:

```
┌─────────────────────────────────────────────────────────────┐
│ ⚙️ SETTINGS  ▸  YouTube Integration                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ Channel Status:  🟢 Connected — Blue Flags & Dads Racing    │
│ Channel URL:     youtube.com/@BlueFlagsAndDads               │
│                                                              │
│ API Key:         ●●●●●●●●●●●●●●●●●●●●●  [Show] [Change]    │
│ OAuth Token:     ✅ Valid (expires: 2026-04-30)     [Refresh]│
│                                                              │
│ Default Privacy: [Unlisted  ▾]                               │
│ Default Playlist: [iRacing Races  ▾]                         │
│ Auto-upload:     [✓] Automatically upload after export       │
│ Upload type:     [✓] Highlights  [ ] Full Race  [ ] Both    │
│                                                              │
│ Title Template:                                              │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ {{track_name}} - {{session_type}} | {{date}}            │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                              │
│ Description Template:                                        │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ {{track_name}} {{session_type}}                         │ │
│ │ {{num_drivers}} drivers | {{num_laps}} laps             │ │
│ │                                                         │ │
│ │ Events: {{event_summary}}                               │ │
│ │                                                         │ │
│ │ Produced with League Replay Studio                      │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                              │
│ Tags: iRacing, sim racing, {{track_name}}, {{car_class}}    │
│                                                              │
│ [Disconnect Channel]  [Test Connection]                      │
└─────────────────────────────────────────────────────────────┘
```

**OAuth Flow:**
1. User clicks "Connect YouTube Channel" → opens browser to Google OAuth consent screen
2. User authorises access → callback URI returns OAuth tokens
3. Tokens stored encrypted in the application's settings (not in project files)
4. Automatic token refresh — user never has to re-authenticate unless they revoke access

**Template Variables:**
Title and description templates support `{{mustache}}` variables populated from project metadata:

| Variable | Source | Example |
|----------|--------|---------|
| `{{track_name}}` | `project_meta.track_name` | "Daytona International Speedway" |
| `{{session_type}}` | `project_meta.session_type` | "Sprint Race" |
| `{{date}}` | `project_meta.created_at` | "2026-03-31" |
| `{{num_drivers}}` | `project_meta.num_drivers` | "22" |
| `{{num_laps}}` | `project_meta.num_laps` | "25" |
| `{{event_summary}}` | Generated from `race_events` | "12 incidents, 8 battles, 15 overtakes" |
| `{{car_class}}` | `drivers` table | "GT3" |
| `{{highlight_duration}}` | From EDL | "5:02" |
| `{{winner}}` | `drivers` WHERE finish_position=1 | "#42 J. Hooks" |

#### 7.12.2 YouTube Video Browser

A **YouTube** tab in the application shows all videos on the connected channel, with clear association to League Replay Studio projects:

```
┌─────────────────────────────────────────────────────────────┐
│ 🎬 YOUTUBE CHANNEL — Blue Flags & Dads Racing               │
│                                                              │
│ ┌────────┐ Daytona Sprint Race Highlights        🔗 Project │
│ │ thumb  │ 5:02 | Unlisted | 342 views           ▸ Open    │
│ │        │ Uploaded: 2026-03-31 14:23              ▸ YouTube │
│ └────────┘ Tags: iRacing, Daytona, GT3                      │
│                                                              │
│ ┌────────┐ Sebring Endurance - Full Race          🔗 Project │
│ │ thumb  │ 44:21 | Public | 1,204 views           ▸ Open    │
│ │        │ Uploaded: 2026-03-28 20:15              ▸ YouTube │
│ └────────┘ Tags: iRacing, Sebring, endurance                │
│                                                              │
│ ┌────────┐ Road Atlanta Sprint Highlights         ⚠️ No link │
│ │ thumb  │ 4:48 | Public | 567 views              ▸ YouTube │
│ │        │ Uploaded: 2026-03-24 19:45                        │
│ └────────┘ (uploaded externally — not linked to a project)   │
│                                                              │
│ [Refresh] [Upload New] [Manage Playlists]                    │
└─────────────────────────────────────────────────────────────┘
```

**Features:**
- **Project association**: Each uploaded video is linked to its source project via `youtube_uploads` table. Click "Open Project" to jump directly to the project that produced it.
- **Unlinked videos**: Videos uploaded outside of LRS are shown without a project link, clearly marked.
- **Video metadata**: Title, description, tags, privacy, views, likes — all visible inline.
- **Quick actions**: Open on YouTube, copy URL, change privacy, delete.
- **Playlist management**: View and manage playlists directly from the app.

#### 7.12.3 Upload Step in Export Flow

The export step (Step 5) includes an optional **Upload** sub-step:

```
┌─────────────────────────────────────────────────────────────┐
│ 📤 EXPORT — Daytona 500 Sprint Race                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ Encoding:  ████████████████████████████████ 100%  ✅         │
│ Output:    highlights.mp4 (210 MB, 5:02)                     │
│            full_race.mp4 (1.2 GB, 44:21)                     │
│                                                              │
│ ─── YouTube Upload ──────────────────────────────────────── │
│                                                              │
│ [✓] Upload highlights.mp4                                    │
│ [ ] Upload full_race.mp4                                     │
│                                                              │
│ Title:       [Daytona Sprint Race Highlights            ]    │
│ Description: [Auto-populated from template...           ]    │
│ Privacy:     [Unlisted  ▾]                                   │
│ Playlist:    [iRacing Races  ▾]                              │
│ Thumbnail:   [Auto-generate ▾] [Upload Custom]              │
│ Tags:        [iRacing, Daytona, GT3, sim racing       ]     │
│                                                              │
│ Upload:      ████████████░░░░░░░ 65%  (137 MB / 210 MB)    │
│              ↑ 4.2 MB/s — ETA: 0:17                         │
│                                                              │
│ [Upload Now]  [Schedule for Later]  [Skip Upload]            │
└─────────────────────────────────────────────────────────────┘
```

**Upload Features:**
- **Resumable upload**: Uses YouTube API's resumable upload protocol — survives network interruptions
- **Progress tracking**: Real-time upload speed, bytes transferred, ETA
- **Auto-retry**: On network failure, automatically retries with exponential backoff (3 attempts)
- **Custom thumbnail**: Option to upload a custom thumbnail or auto-generate from a selected video frame
- **Schedule upload**: Set a future publish time for the video
- **Batch upload**: Upload both highlights and full race with different metadata
- **Post-upload**: After YouTube finishes processing, the video URL is stored in the project and shown in the project file browser

#### 7.12.4 Backend — YouTube Service

```python
class YouTubeService:
    """YouTube Data API v3 integration for video upload and channel management."""
    
    def __init__(self, settings: Settings):
        self.credentials = self._load_credentials(settings)
        self.youtube = build('youtube', 'v3', credentials=self.credentials)
    
    async def get_channel_info(self) -> dict:
        """Get connected channel info (name, subscriber count, video count)."""
        response = self.youtube.channels().list(
            part='snippet,statistics', mine=True
        ).execute()
        return response['items'][0] if response['items'] else None
    
    async def list_videos(self, max_results: int = 50) -> List[dict]:
        """List videos on the connected channel."""
        response = self.youtube.search().list(
            part='snippet', forMine=True, type='video',
            maxResults=max_results, order='date'
        ).execute()
        return response['items']
    
    async def upload_video(
        self, file_path: str, title: str, description: str,
        tags: List[str], privacy: str = 'unlisted',
        playlist_id: str = None, progress_callback=None
    ) -> str:
        """Upload video using resumable upload. Returns YouTube video ID."""
        body = {
            'snippet': {
                'title': title,
                'description': description,
                'tags': tags,
                'categoryId': '20',  # Gaming
            },
            'status': {
                'privacyStatus': privacy,
                'selfDeclaredMadeForKids': False,
            }
        }
        
        media = MediaFileUpload(
            file_path, mimetype='video/mp4',
            resumable=True, chunksize=256*1024  # 256KB chunks
        )
        
        request = self.youtube.videos().insert(
            part='snippet,status', body=body, media_body=media
        )
        
        response = None
        while response is None:
            status, response = request.next_chunk()
            if status and progress_callback:
                progress_callback(status.progress())
        
        video_id = response['id']
        
        # Add to playlist if specified
        if playlist_id:
            self.youtube.playlistItems().insert(
                part='snippet',
                body={'snippet': {
                    'playlistId': playlist_id,
                    'resourceId': {'kind': 'youtube#video', 'videoId': video_id}
                }}
            ).execute()
        
        return video_id
    
    async def get_video_status(self, video_id: str) -> dict:
        """Check YouTube processing status for an uploaded video."""
        response = self.youtube.videos().list(
            part='status,processingDetails', id=video_id
        ).execute()
        return response['items'][0] if response['items'] else None
```

### 7.13 Automated Pipeline — One-Click Processing

Once a project's configuration settings are dialled in (camera weights, highlight parameters, overlay template, export preset), the user should be able to hit a single **"Go"** button and have the entire workflow execute automatically — with the ability to pause, intervene, tweak, and resume at any point.

#### 7.13.1 Pipeline Concept

```
┌─────────────────────────────────────────────────────────────────┐
│                    AUTOMATED PIPELINE                            │
│                                                                  │
│  ┌────────┐   ┌───────┐   ┌──────┐   ┌──────┐   ┌──────────┐  │
│  │ANALYSIS│──▸│EDITING│──▸│CAPTURE│──▸│EXPORT│──▸│  UPLOAD   │  │
│  │  16× + │   │ Tune  │   │ OBS  │   │ GPU  │   │  YouTube  │  │
│  │ detect │   │ config│   │ rec  │   │ enc  │   │  (opt.)   │  │
│  └───┬────┘   └──┬────┘   └──┬───┘   └──┬───┘   └─────┬────┘  │
│      │           │           │           │             │        │
│  ┌───▼────┐   ┌──▼────┐   ┌──▼───┐   ┌──▼───┐   ┌────▼────┐  │
│  │Pause?  │   │Pause? │   │Pause?│   │Pause?│   │ Done!   │  │
│  │Review  │   │Adjust │   │Tweak │   │Cancel│   │ Video   │  │
│  │events  │   │cuts   │   │Resume│   │Retry │   │ live!   │  │
│  └────────┘   └───────┘   └──────┘   └──────┘   └─────────┘  │
│                                                                  │
│  [▶ GO]  [⏸ PAUSE]  [⏹ STOP]  [↻ RETRY STEP]                   │
└─────────────────────────────────────────────────────────────────┘
```

#### 7.13.2 Configuration Presets

Users can save and version their pipeline configurations:

```
┌─────────────────────────────────────────────────────────────┐
│ ⚙️ PIPELINE CONFIGURATIONS                                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ 📋 League Race Default             ★ Active                  │
│    Analyse + Capture + Highlights (5 min) + Upload (unlisted)│
│    Last modified: 2026-03-31                                 │
│    [Edit] [Duplicate] [Set Active]                           │
│                                                              │
│ 📋 Quick Highlights Only                                     │
│    Skip capture, Highlights only (3 min), No upload          │
│    Last modified: 2026-03-28                                 │
│    [Edit] [Duplicate] [Set Active]                           │
│                                                              │
│ 📋 Full Broadcast Package                                    │
│    Full analysis + Capture + Highlights (10 min) +           │
│    Full race + Upload both (public)                          │
│    Last modified: 2026-03-25                                 │
│    [Edit] [Duplicate] [Set Active]                           │
│                                                              │
│ [+ New Configuration]  [Import]  [Export]                     │
└─────────────────────────────────────────────────────────────┘
```

**Configuration Preset Contents:**
- Which pipeline steps to include/skip (e.g., skip capture if you already have the recording)
- Highlight parameters: target duration, event type weights, minimum severity
- Export settings: preset, codec, resolution, both/highlights-only
- Upload settings: auto-upload, privacy, title/description templates, playlist
- Camera settings: battle gap, camera sticky period, incident position cutoff
- Overlay template: which template to use

**Configuration Versioning:**
- Each save creates a new version — previous versions are retained
- Can revert to any previous configuration version
- Can compare two versions side-by-side
- Configurations are stored in the project database (`pipeline_configs` table) and can also be exported as JSON for sharing across projects

#### 7.13.3 Pipeline Execution Engine

```python
class PipelineEngine:
    """Executes the automated processing pipeline with pause/resume/retry."""
    
    STEPS = ['capture', 'analyse', 'highlight', 'export', 'upload']
    
    def __init__(self, project: Project, config: PipelineConfig):
        self.project = project
        self.config = config
        self.current_step: Optional[str] = None
        self.paused = asyncio.Event()
        self.paused.set()  # Not paused initially
        self.cancelled = False
        self.run_record: Optional[PipelineRun] = None
    
    async def execute(self, websocket=None):
        """Run the full pipeline, reporting progress via WebSocket."""
        self.run_record = self._create_run_record()
        
        for step in self.STEPS:
            if self.cancelled:
                self._update_status('cancelled')
                return
            
            if not self._step_enabled(step):
                self._update_step_status(step, 'skipped')
                continue
            
            # Check for pause
            await self.paused.wait()
            
            self.current_step = step
            self._update_step_status(step, 'running')
            self._emit_progress(websocket, step, 'started')
            
            try:
                await self._execute_step(step, websocket)
                self._update_step_status(step, 'completed')
                self._emit_progress(websocket, step, 'completed')
            except PipelineStepError as e:
                self._update_step_status(step, 'failed')
                self._record_error(step, e)
                self._emit_progress(websocket, step, 'failed', error=str(e))
                
                # Wait for user intervention (retry/skip/abort)
                action = await self._wait_for_user_action(websocket)
                if action == 'retry':
                    await self._execute_step(step, websocket)  # Retry
                elif action == 'skip':
                    self._update_step_status(step, 'skipped')
                elif action == 'abort':
                    self._update_status('failed')
                    return
        
        self._update_status('completed')
        self._emit_progress(websocket, 'pipeline', 'completed')
    
    async def _execute_step(self, step: str, websocket=None):
        """Execute a single pipeline step."""
        match step:
            case 'capture':
                await self.capture_service.run_capture(
                    self.project, progress_callback=lambda p: 
                        self._emit_progress(websocket, 'capture', 'progress', progress=p)
                )
            case 'analyse':
                await self.analyser.run_scan(self.project)
                await self.analyser.detect_events(self.project)
            case 'highlight':
                self.highlight_editor.apply_config(self.config.highlight_weights)
                self.highlight_editor.generate_edl(self.project)
                self.camera_director.assign_cameras(self.project)
            case 'export':
                await self.encoding_engine.encode(
                    self.project, preset=self.config.export_preset,
                    highlights=self.config.export_highlights,
                    full_race=self.config.export_full_race,
                    progress_callback=lambda p:
                        self._emit_progress(websocket, 'export', 'progress', progress=p)
                )
            case 'upload':
                if self.config.auto_upload:
                    await self.youtube_service.upload_from_project(
                        self.project, self.config,
                        progress_callback=lambda p:
                            self._emit_progress(websocket, 'upload', 'progress', progress=p)
                    )
    
    def pause(self):
        """Pause pipeline after current step completes."""
        self.paused.clear()
    
    def resume(self):
        """Resume paused pipeline."""
        self.paused.set()
    
    def cancel(self):
        """Cancel pipeline."""
        self.cancelled = True
        self.paused.set()  # Unblock if paused
```

#### 7.13.4 Pipeline UI

```
┌─────────────────────────────────────────────────────────────┐
│ 🚀 PIPELINE — Daytona 500 Sprint Race                       │
│ Config: League Race Default                    [Change ▾]    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ Step 1 — CAPTURE                              ✅ Complete    │
│ ├── OBS recording: race_001.mp4 (8.4 GB)                    │
│ └── Duration: 44:21                                          │
│                                                              │
│ Step 2 — ANALYSIS                             ✅ Complete    │
│ ├── 35 events detected (12 incidents, 8 battles, 15 overtake)│
│ └── 240,182 telemetry rows stored                            │
│                                                              │
│ Step 3 — EDITING                              🔄 Running     │
│ ├── Highlight config applied (5 min target)                  │
│ ├── 18/35 events selected (auto)                             │
│ ├── Camera plan: 6 unique cameras assigned                   │
│ └── ⏸ Paused — waiting for user review                      │
│                                                              │
│ Step 4 — EXPORT                               ⏳ Pending     │
│ Step 5 — UPLOAD                               ⏳ Pending     │
│                                                              │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 💡 Pipeline paused at EDITING step. Review the          │ │
│ │    highlight selection and camera plan, then click       │ │
│ │    Resume to continue to export.                        │ │
│ │                                                         │ │
│ │ [▶ Resume]  [↻ Re-run Step]  [⏹ Stop Pipeline]         │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                              │
│ 📋 Pipeline Log:                                             │
│ ├── 14:23:01 Capture started                                 │
│ ├── 15:07:22 Capture completed (race_001.mp4, 8.4 GB)       │
│ ├── 15:07:25 Analysis started (16× replay scan)              │
│ ├── 15:09:48 Analysis completed (35 events, 2:23 elapsed)   │
│ ├── 15:09:49 Editing: applying highlight config              │
│ └── 15:09:49 Editing: paused for user review                 │
└─────────────────────────────────────────────────────────────┘
```

#### 7.13.5 Failure Recovery

Each step has specific failure recovery strategies:

| Step | Common Failures | Recovery |
|------|----------------|----------|
| **Capture** | OBS not running, hotkey failed, disk full | Pause + prompt to fix, retry from last known state |
| **Analysis** | iRacing not running, replay file corrupt | Pause + show error, allow retry or manual replay load |
| **Editing** | No events detected (empty race) | Auto-skip to export with full-race-only mode, or pause for manual event creation |
| **Export** | GPU error, disk full, FFmpeg crash | Retry with fallback encoder (CPU), or retry after disk cleanup |
| **Upload** | Network error, token expired, quota exceeded | Auto-retry with exponential backoff (3 attempts), then pause for manual intervention |

**Pipeline Log:**
- Every step writes detailed log entries to `project/logs/pipeline.log`
- Includes timestamps, duration per step, file sizes, error details
- Viewable in the application via the Pipeline UI panel
- Persisted in the database (`pipeline_runs` table) for historical reference

---

## 8. Development Phases

### Phase 1 — Foundation (Weeks 1-4)

**Goal**: Skeleton app running with iRacing connection and basic UI.

| Task | Description |
|------|-------------|
| 1.1 | Project scaffolding: Python backend (FastAPI), React frontend (Vite + Tailwind), pywebview |
| 1.2 | Start scripts (`start.bat`, `start-quick.bat`, `start.bat --auto-load`) |
| 1.3 | Backend: FastAPI app with CORS, static file serving, SPA catch-all |
| 1.4 | Frontend: React app shell with layout (toolbar, sidebar, main area, status bar) |
| 1.5 | iRacing Bridge: pyirsdk integration, connection detection, session data extraction |
| 1.6 | WebSocket: Real-time connection status → frontend |
| 1.7 | Settings system: JSON config, settings API, settings panel |
| 1.8 | Project system: Create / list / open / delete projects (SQLite) |
| 1.9 | Toast + Modal system (from reference conventions) |
| 1.10 | Dark theme design system (Tailwind config, color tokens) |

### Phase 2 — Analysis Engine (Weeks 5-8)

**Goal**: Connect to iRacing via `irsdk` shared memory, run 16× replay scan, detect and store all race events.

| Task | Description |
|------|-------------|
| 2.1 | `IRacingBridge`: `irsdk.IRSDK()` startup/shutdown, 60Hz background poll thread with `freeze_var_buffer_latest()` |
| 2.2 | Session info parser: YAML → drivers dict, camera group numbers, avg lap time, track name |
| 2.3 | Replay control: `set_replay_speed()`, `seek_to_frame()`, `cam_switch_pos()`, `cam_switch_car()` via Broadcasting API |
| 2.4 | Analysis scan loop: set 16× speed, iterate telemetry, store each sample as `telemetry_snapshots` row in SQLite |
| 2.5 | `SampleFilter`: throttle expensive processors (leaderboard every 0.5s, camera every 0.25s) |
| 2.6 | `IncidentDetector`: watch `CamCarIdx` changes + `CarIdxTrackSurface`, 15s dedup per car |
| 2.7 | `BattleDetector`: `(leader_pct - follower_pct) * avg_lap_time < gap_threshold`, open/close battle windows |
| 2.8 | `OvertakeDetector`: `CarIdxPosition` delta + proximity check |
| 2.9 | `PitStopDetector`, `FastestLapDetector`, `LeaderChangeDetector`, `FirstLapDetector`, `LastLapDetector` |
| 2.10 | Stop condition: `SessionState == Checkered` and all cars finished/retired |
| 2.11 | `replay_frame` → video timestamp mapping: persist frame number on each event for frame-accurate cutting |
| 2.12 | Event browser UI: categorised list with filters, real-time updates via WebSocket as events are detected |
| 2.13 | Analysis progress UI: WebSocket progress bar, events-found counter by type |

### Phase 3 — Timeline Editor (Weeks 9-14)

**Goal**: Full NLE-style timeline with interactive editing.

| Task | Description |
|------|-------------|
| 3.1 | Timeline component: Canvas-based multi-track renderer |
| 3.2 | Time ruler with zoom (scroll) and pan (middle-drag) |
| 3.3 | Event track: render events colour-coded, draggable edges |
| 3.4 | Camera track: camera assignments, drag to reassign |
| 3.5 | Cut track: included/excluded regions |
| 3.6 | Playhead cursor: drag to scrub, keyboard seek |
| 3.7 | Event inspector: edit event properties |
| 3.8 | Right-click context menus |
| 3.9 | Keyboard shortcuts: J/K/L shuttle, I/O in/out, Space play/pause |
| 3.10 | Undo/redo system: edit history tracking |
| 3.11 | Auto camera direction engine: generate camera plan from events + config |
| 3.12 | Highlight auto-cut: generate EDL from events to target duration |

### Phase 3b — Highlight Editing Suite (Weeks 15-18)

**Goal**: Full interactive highlight editing with live preview and real-time metrics. ⭐ Crown jewel feature.

| Task | Description |
|------|-------------|
| 3b.1 | Rule weight tuning UI: interactive sliders for each event type priority (0–100) |
| 3b.2 | Event selection table: sortable/filterable table of all events with computed scores |
| 3b.3 | Manual override system: checkbox include/exclude with visual indicators |
| 3b.4 | Reprocessing engine: instant re-run of selection algorithm from cached data |
| 3b.5 | Live metrics dashboard: duration, event counts by type, coverage %, balance/pacing scores |
| 3b.6 | Minimum severity threshold slider with live update |
| 3b.7 | Target duration control with over/under warning |
| 3b.8 | Auto-balance button: algorithm optimizes weights for even distribution |
| 3b.9 | Highlight timeline preview: condensed view of the highlight reel |
| 3b.10 | Score explanation: "Reason" column showing why each event was included/excluded |
| 3b.11 | Configuration save/load: save named weight configurations for reuse |
| 3b.12 | A/B compare mode: save two configs and toggle between them to compare results |
| 3b.13 | WebSocket live updates: metrics + selection update in real-time as weights change |
| 3b.14 | Driver coverage metric: ensure highlight represents multiple drivers |

### Phase 4 — Preview System (Weeks 19-24)

**Goal**: Real-time preview of recorded video with overlays, engineered for multi-GB source files.

| Task | Description |
|------|-------------|
| 4.1 | Keyframe index builder: scan source file packets, build timestamp → byte offset map |
| 4.2 | Thumbnail sprite sheet generator: FFmpeg 1fps tile filter → sprite JPEGs + index JSON |
| 4.3 | Proxy video generator: 540p30 re-encode with 0.5s keyframes, GPU accelerated, progress reporting |
| 4.4 | Audio track extractor: stream-copy audio to standalone .m4a for independent playback |
| 4.5 | Progressive asset pipeline: background generation with frontend progress indicators |
| 4.6 | Preview viewport: display sprite thumbnails during scrub, decoded frames on release |
| 4.7 | Proxy frame decoder: keyframe-indexed FFmpeg seek + decode, < 50ms per frame |
| 4.8 | Overlay renderer: leaderboard, driver tags, lap counter composited on proxy frames |
| 4.9 | Playback streaming: WebSocket binary frame stream from proxy at 30fps real-time |
| 4.10 | Audio sync: HTML5 `<audio>` element synchronised to video via JS `currentTime` |
| 4.11 | Quality upgrade: seamless switch from proxy frame → full-res source frame on pause |
| 4.12 | Preview modes: full race / highlight / source / split |
| 4.13 | Highlight preview: EDL-mapped timeline with proxy for cross-segment jumps |
| 4.14 | Fallback mode: direct source decode when proxy not yet generated |

### Phase 5 — Video Capture & OBS Integration (Weeks 23-26)

**Goal**: Improved OBS/ShadowPlay integration with configurable hotkeys and validation.

| Task | Description |
|------|-------------|
| 5.1 | Capture software detection: auto-detect OBS, Nvidia ShadowPlay, AMD ReLive process |
| 5.2 | Configurable hotkey system: user maps start/stop record keys per capture software |
| 5.3 | Hotkey validation: send test hotkey and verify recording started (file watcher) |
| 5.4 | Capture orchestration: automated start/stop recording synced with replay playback |
| 5.5 | Intro capture: scenic cameras during qualifying with OBS recording |
| 5.6 | Race capture: automated 1× playback recording with camera direction |
| 5.7 | Capture file discovery: auto-detect output file path from OBS/ShadowPlay config |
| 5.8 | Capture progress UI: real-time status, elapsed time, file size, audio level meters |
| 5.9 | Post-capture validation: verify file integrity, resolution, duration matches expected |

### Phase 6 — GPU Encoding (Weeks 27-30)

**Goal**: Lightning-fast GPU-accelerated encoding with multi-GPU support.

| Task | Description |
|------|-------------|
| 6.1 | GPU detection: NVENC / AMF / QSV capabilities |
| 6.2 | FFmpeg command builder: codec, bitrate, filters |
| 6.3 | Edit decision list → FFmpeg complex filtergraph |
| 6.4 | Overlay compositing in FFmpeg pipeline |
| 6.5 | Multi-GPU: parallel encoding of full + highlights |
| 6.6 | Encoding progress: parse FFmpeg output → WebSocket → frontend |
| 6.7 | Export presets: YouTube, Discord, Archive, Custom |
| 6.8 | Encoding dashboard UI with real-time FPS, ETA |
| 6.9 | Batch export: queue multiple projects |

### Phase 7 — Overlay Template Engine (Weeks 31-36)

**Goal**: HTML/Tailwind overlay system with in-app editor, live preview, and template library.

| Task | Description |
|------|-------------|
| 7.1 | Playwright headless Chromium integration: persistent browser context, startup/shutdown lifecycle |
| 7.2 | Jinja2 template rendering: data context injection, per-frame variable updates |
| 7.3 | `OverlayRenderer` backend: `render_frame()`, `render_frame_fast()`, `batch_render_for_export()` |
| 7.4 | Built-in template library: Broadcast, Minimal, Classic, Cinematic, Blank — all as `.html` files |
| 7.5 | Monaco Editor integration in frontend: split-pane HTML editor + live preview |
| 7.6 | Tailwind IntelliSense and syntax highlighting in Monaco |
| 7.7 | Data context inspector panel: browse available template variables with live sample data |
| 7.8 | Visual no-code controls: element picker, drag-to-reposition, resize handles, property panel |
| 7.9 | Animation picker: fade, slide, pop, bounce — generates CSS keyframe animations |
| 7.10 | Template management: import, export, duplicate, version history |
| 7.11 | Preview integration: overlay compositing in real-time playback and scrub |
| 7.12 | Export integration: batch pre-render to PNG sequence, FFmpeg overlay filter |
| 7.13 | Resolution-aware rendering: templates adapt to 1080p, 1440p, 4K output |
| 7.14 | Per-project template overrides: customise without modifying originals |

### Phase 8 — Polish & Distribution (Weeks 35-38)

**Goal**: Production-ready application with installer.

| Task | Description |
|------|-------------|
| 8.1 | PyInstaller bundling: single-directory .exe |
| 8.2 | First-run experience: guided setup wizard |
| 8.3 | Error handling: graceful degradation, helpful error messages |
| 8.4 | Performance optimization: frame cache, lazy loading, debouncing |
| 8.5 | Keyboard shortcut reference sheet (in-app) |
| 8.6 | Application icon, splash screen, window title |
| 8.7 | Auto-update system (GitHub Releases) |
| 8.8 | Comprehensive logging with log viewer |
| 8.9 | CLI / headless mode: `lrs.bat --project ... --highlights` (Section 7.10) |
| 8.10 | Version system: `version.py` single source of truth, shown in UI + CLI |
| 8.11 | Documentation: user guide, FAQ |
| 8.12 | Beta testing and bug fixes |

### Phase 9 — YouTube Integration, Pipeline & Workflow (Weeks 39-44)

**Goal**: Step-based project workflow, one-click automated pipeline, and YouTube channel integration.

| Task | Description |
|------|-------------|
| 9.1 | **Step-based workflow**: Implement `ProjectWorkflow.jsx` step indicator bar + step navigation throughout project views |
| 9.2 | **Replay file picker**: Auto-discover `.rpy` files from iRacing replays directory, browse/copy replay into project |
| 9.3 | **Project file browser**: `ProjectFileBrowser.jsx` — tree view of project directory contents |
| 9.4 | Project step management API: `GET/PUT /api/projects/{id}/step`, auto-advance on step completion |
| 9.5 | **Pipeline engine**: `PipelineEngine` backend class — sequential step executor with pause/resume/cancel/retry |
| 9.6 | **Pipeline configuration presets**: CRUD API, save/load/version presets, default preset |
| 9.7 | **Pipeline UI**: `PipelinePanel.jsx` + `PipelineLog.jsx` — real-time step progress, log viewer, failure recovery |
| 9.8 | Pipeline WebSocket integration: real-time step progress, completion, failure events |
| 9.9 | **YouTube OAuth flow**: `google-api-python-client` + `google-auth-oauthlib` — connect/disconnect, token refresh |
| 9.10 | **YouTube settings UI**: connection status, default privacy/description/tags, auto-upload toggle |
| 9.11 | **YouTube upload**: Resumable upload via YouTube Data API v3, progress tracking, retry on failure |
| 9.12 | **YouTube video browser**: `YouTubePanel.jsx` — list uploaded videos with stats, link to YouTube, associate with projects |
| 9.13 | Upload step in project workflow: pre-filled metadata from project/template, privacy selector, description with template variables |
| 9.14 | Pipeline ↔ YouTube integration: auto-upload as final pipeline step when configured |
| 9.15 | CLI pipeline support: `lrs.bat --project ... --full-pipeline --upload` |

---

## 9. File Structure — Full Project Layout

```
league-replay-studio/
├── documentation/
│   ├── master-plan.md               # This document
│   ├── agent_docs/                  # Agent guidelines (created as needed)
│   └── architecture/                # Architecture decision records
│
├── reference/                       # Reference materials (read-only)
│   ├── iRacingReplayDirector/       # Legacy codebase
│   ├── livery-ai-studio/            # Hybrid app reference
│   └── agent_docs/                  # Reference agent docs
│
├── backend/
│   ├── app.py                       # Entry point (FastAPI + pywebview GUI)
│   ├── cli.py                       # CLI entry point (headless mode)
│   ├── version.py                   # Single source of truth for app version
│   ├── requirements.txt             # Python dependencies
│   ├── setup.py                     # GPU/optional dependency setup
│   ├── server/
│   │   ├── __init__.py
│   │   ├── config.py                # App config (paths, defaults, load/save)
│   │   ├── models/
│   │   │   ├── project.py           # Project SQLite models
│   │   │   ├── events.py            # Race event models
│   │   │   ├── cameras.py           # Camera assignment models
│   │   │   ├── overlays.py          # Overlay configuration models
│   │   │   └── edl.py               # Edit decision list models
│   │   ├── services/
│   │   │   ├── iracing_bridge.py    # pyirsdk wrapper + connection management
│   │   │   ├── replay_analyser.py   # Replay analysis orchestrator
│   │   │   ├── telemetry_writer.py  # Normalised telemetry → race_ticks + car_states
│   │   │   ├── detectors/
│   │   │   │   ├── incident.py
│   │   │   │   ├── battle.py
│   │   │   │   ├── overtake.py
│   │   │   │   ├── pit_stop.py
│   │   │   │   ├── fastest_lap.py
│   │   │   │   ├── first_last_lap.py
│   │   │   │   └── restart.py
│   │   │   ├── camera_director.py   # Intelligent camera direction
│   │   │   ├── highlight_editor.py  # Highlight editing suite (rule tuning, reprocessing, metrics)
│   │   │   ├── encoding_engine.py   # FFmpeg GPU encoding
│   │   │   ├── video_preview.py     # Tiered preview server (sprites, proxy, source)
│   │   │   ├── asset_pipeline.py    # Background generation: keyframe index, sprites, proxy, audio
│   │   │   ├── overlay_renderer.py  # HTML/Tailwind → PNG rendering via Playwright headless Chromium
│   │   │   ├── project_manager.py   # Project CRUD + SQLite + step workflow
│   │   │   ├── capture_service.py   # OBS/ShadowPlay capture orchestration
│   │   │   ├── youtube_service.py   # YouTube Data API v3: OAuth, upload, video listing
│   │   │   ├── pipeline_engine.py   # Automated pipeline: sequential step execution, pause/resume/retry
│   │   │   └── settings_service.py  # Settings management
│   │   ├── routes/
│   │   │   ├── api_projects.py      # /api/projects/* (includes step workflow)
│   │   │   ├── api_iracing.py       # /api/iracing/*
│   │   │   ├── api_analysis.py      # /api/projects/{id}/analyse
│   │   │   ├── api_events.py        # /api/projects/{id}/events/*
│   │   │   ├── api_cameras.py       # /api/projects/{id}/cameras/*
│   │   │   ├── api_overlays.py      # /api/projects/{id}/overlays/*
│   │   │   ├── api_edl.py           # /api/projects/{id}/edl/*
│   │   │   ├── api_highlights.py    # /api/projects/{id}/highlights/* (editing suite)
│   │   │   ├── api_export.py        # /api/projects/{id}/export/*
│   │   │   ├── api_preview.py       # /api/projects/{id}/preview/*
│   │   │   ├── api_capture.py       # /api/capture/* (OBS/ShadowPlay control)
│   │   │   ├── api_youtube.py       # /api/youtube/* + /api/projects/{id}/upload/*
│   │   │   ├── api_pipeline.py      # /api/pipeline/* + /api/projects/{id}/pipeline/*
│   │   │   ├── api_settings.py      # /api/settings (includes YouTube settings)
│   │   │   ├── api_system.py        # /api/system/*
│   │   │   └── api_track_cameras.py # /api/track-cameras/*
│   │   └── utils/
│   │       ├── gpu_detect.py        # GPU detection (NVENC/AMF/QSV)
│   │       ├── ffmpeg.py            # FFmpeg command builder
│   │       ├── obs_integration.py   # OBS/ShadowPlay hotkey automation & process detection
│   │       ├── capture_validator.py # Post-capture file validation
│   │       └── logging_config.py    # Structured logging setup
│   ├── data/                        # Default data directory
│   │   └── projects/                # Project storage
│   └── static/                      # Built frontend (production)
│
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── public/
│   │   ├── icon.png
│   │   └── images/
│   └── src/
│       ├── main.jsx
│       ├── index.css
│       ├── components/              # (see section 5.2)
│       ├── context/
│       ├── hooks/
│       ├── services/
│       └── utils/
│
├── lrs.bat                          # CLI entry point (auto-detects GUI vs CLI)
├── start.bat                        # Windows launcher (setup + run GUI)
├── start-quick.bat                  # Quick launch (skip install)
├── start.sh                         # Linux/Mac launcher
├── icon.ico                         # Application icon
├── icon.png                         # Application icon (PNG)
├── README.md                        # User-facing README
├── LICENSE.txt                      # GPL v3 (matching legacy)
├── CHANGELOG.md                     # Version history
└── .gitignore
```

---

## 10. Key Design Decisions

### 10.1 Why FastAPI over Flask?

- **Async-native** — iRacing monitoring, preview serving, and encoding are all async operations
- **WebSocket support** — First-class WebSocket support for real-time updates
- **Auto-generated API docs** — Swagger UI at `/docs` for development
- **Pydantic models** — Type-safe request/response validation
- **Performance** — FastAPI is significantly faster than Flask for concurrent requests

*Note: livery-ai-studio uses Flask because its workload is simpler (single request at a time). League Replay Studio has concurrent operations (preview + encoding + iRacing monitoring) that benefit from async.*

### 10.2 Why Improved OBS Integration (Not Direct Capture)?

iRacing does not expose raw frames through its SDK — the only way to capture video from iRacing is via screen recording. This is a hard constraint.

- **OBS / Nvidia ShadowPlay / AMD ReLive** are the established tools for this
- **1× speed recording is unavoidable** — we need the in-game audio, and iRacing only outputs audio at real-time speed
- **D3D11 Desktop Duplication API** was considered but rejected: it captures raw frames without audio, requires complex audio capture setup, and provides no benefit over OBS which already does GPU-accelerated capture with audio
- **League Replay Studio's improvement** is not replacing OBS, but making the integration **reliable and configurable**: auto-detect capture software, configurable hotkeys, process validation, file discovery, and integrity checks
- **Multi-software support** — users can choose their preferred capture tool rather than being locked to one

### 10.3 Why FFmpeg over MediaFoundation?

- **GPU encoding** — NVENC, AMF, QSV support out of the box
- **Multi-GPU** — Specify which GPU to use per encoding job
- **Codec variety** — H.264, H.265, AV1, VP9, and more
- **Complex filters** — Overlay compositing, fade in/out, speed changes, cuts — all in one pipeline
- **Cross-platform** — Not Windows-only like MediaFoundation
- **Actively maintained** — Massive open-source community
- **Performance** — FFmpeg with NVENC on RTX 4080 ≈ 300+ fps at 1080p vs. MediaFoundation ≈ 30-50 fps CPU

### 10.4 Why SQLite over XML/JSON?

> **Zero-dependency note**: `sqlite3` is part of Python's **standard library** — it ships with every Python installation. `import sqlite3` works out of the box with no `pip install`, no external database server, and no additional binary. The optional `aiosqlite` wrapper (a single, tiny pure-Python pip package) provides async access for FastAPI routes but is not strictly required. This makes SQLite the lightest-weight "real database" available to a standalone desktop application.

- **Queryable** — `SELECT * FROM race_events WHERE event_type = 'battle' AND severity > 7`
- **Transactional** — Undo/redo is just snapshots in a transaction log
- **Relational** — Camera assignments reference events, events reference drivers
- **Indexable** — Fast lookups by time range, event type, driver
- **Portable** — Single .db file per project, easy to share/backup
- **No fragility** — XML serialization issues plagued the legacy app
- **No server** — Unlike PostgreSQL or MySQL, there is nothing to install, configure, or keep running — it is an embedded library baked into Python itself

### 10.5 Why pywebview over Electron?

- **Lightweight** — ~50MB vs ~200MB+ for Electron
- **Python-native** — Backend is Python, so pywebview is natural
- **Proven** — livery-ai-studio uses this exact pattern successfully
- **No Node.js runtime** — One less dependency to bundle
- **Native feel** — Uses system Chromium / Edge WebView2

### 10.6 Why HTML/Tailwind Overlays over Pillow/Cairo?

The overlay rendering engine uses **Playwright headless Chromium** to render HTML/Tailwind templates to transparent PNG frames, rather than the traditional approach of drawing overlays programmatically with Pillow or Cairo. See Section 7.6.7 for the full comparison table. Key reasons:

- **User-editable** — Overlays are `.html` files. Anyone who knows basic HTML/CSS can create or modify them. No Python coding required.
- **In-app live editing** — Monaco Editor provides VS Code-quality editing inside the application, with instant preview as you type
- **Tailwind CSS** — The same utility-first CSS framework used by the application's own frontend. Consistent, powerful, widely known.
- **Design ecosystem** — Billions of Tailwind examples, templates, and AI code-generation tools available online
- **Typography & animation** — Full CSS typography (Google Fonts, variable fonts, kerning), CSS keyframe animations, transitions — all declarative
- **Shareable** — A single `.html` file is the complete overlay. Copy, paste, share, fork. No binary packs or plugin DLLs.
- **Maintenance** — Adding a new overlay type means adding a new `.html` file, not writing new Python rendering code
- **Performance** — Playwright's persistent browser context renders at ~5-15ms per frame via `page.evaluate()` + screenshot, which is adequate for real-time preview and batch export

---

## 11. Performance Targets

| Metric | Legacy | LRS Target |
|--------|--------|-----------|
| Analysis time (45-min race) | 3-5 minutes (16× replay) | 1-3 minutes (improved 16× scan with smarter detectors) |
| Capture time (45-min race) | 45+ minutes (1× replay) | 45+ minutes (1× replay — unavoidable, need audio) |
| Encoding time (45-min @ 1080p) | 60-90 minutes (CPU) | 3-8 minutes (NVENC GPU) |
| Encoding time (5-min highlights) | 10-15 minutes | < 30 seconds |
| Proxy generation (45-min source) | N/A | 1-3 minutes (GPU accelerated, background) |
| Sprite sheet generation | N/A | 30-60 seconds (background, non-blocking) |
| Keyframe index + audio extract | N/A | < 10 seconds (immediate on import) |
| Time to first preview | ∞ (no preview) | < 15 seconds (sprite sheets ready) |
| Timeline scrub latency | N/A | **0ms** (client-side sprite sheets) |
| Scrub-release frame latency | N/A | < 50ms (proxy frame + overlays) |
| Full-res pause upgrade | N/A | < 500ms (source frame on demand) |
| Playback frame delivery | N/A | 30fps sustained (proxy WebSocket stream) |
| Highlight reprocess time | N/A (black box) | < 500ms (from cached normalised SQLite) |
| Per-car SQL query (e.g., incident check) | N/A | < 10ms (indexed car_states table) |
| Application startup | 5-10 seconds | < 3 seconds |
| Project creation | N/A | < 5 seconds |
| Multi-GPU speedup | N/A | ~1.8× for dual-GPU parallel encoding |

---

## 12. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| OBS/ShadowPlay hotkey compatibility across versions | Medium | High | Configurable hotkeys, validation step, fallback to manual start/stop |
| Capture software output path discovery | Medium | Medium | Configuration UI, common path defaults, manual path override |
| pyirsdk limitations vs iRacingSDK (C#) | Low | Medium | pyirsdk covers all needed telemetry; alternative: ctypes to iRacing SDK DLL |
| FFmpeg NVENC quality tuning | Low | Low | Extensive preset testing; CRF/VBR tuning |
| pywebview rendering inconsistency | Low | Medium | Use WebView2 backend on Windows (Chromium-based) |
| iRacing replay API changes | Low | Low | Abstraction layer isolates SDK calls |
| Multi-GPU encoding coordination | Medium | Medium | Fallback to sequential encoding on single GPU |
| Highlight editing suite complexity (real-time reprocessing) | Medium | Medium | Normalised telemetry keeps reprocessing fast; progressive loading for large events |
| Large source files (5-15 GB for 45-min race) | **High** | High | Tiered preview pipeline: sprite sheets for scrub (0ms), proxy video for playback (300-800 MB), keyframe index for seeking, extracted audio for independent sync. Never decode source directly for real-time use. |
| Proxy generation time on slow hardware | Medium | Medium | GPU-accelerated encode, background generation, graceful fallback to direct source decode, clear progress indicators |
| Normalised telemetry DB size for long races | Low | Low | ~30 active cars × ~3 ticks/sec × 45 min = ~240K car_state rows — well within SQLite's comfort zone; WAL mode for concurrent reads |
| Disk I/O during sprite sheet generation | Low | Medium | Sequential FFmpeg process, low priority, SSD recommended for project directory |
| Playwright headless Chromium bundle size | Medium | Medium | Playwright downloads Chromium on first run (~150 MB). Bundled via PyInstaller or first-launch install step. Worth the trade-off vs. Pillow/Cairo — enables full HTML/CSS overlay ecosystem, user-editable templates, in-app editing, and sharable `.html` files. |
| Overlay rendering latency (Playwright) | Low | Medium | Persistent browser context avoids cold-start; `page.evaluate()` fast-path at ~5-15ms/frame; batch pre-render to PNG sequence for export (not real-time critical); fallback: skip overlays in preview if rendering bottlenecks |
| YouTube API quota exhaustion (10,000 units/day default) | Medium | Medium | Video uploads cost ~1600 units each. Typical user uploads 1-3 videos/day (~5000 units). Show remaining quota in settings. If exceeded, queue upload for next day with notification. Apply for audit to raise quota if user base grows. |
| YouTube OAuth token expiry / revocation | Medium | Low | Refresh tokens are long-lived; auto-refresh on 401. Clear UX for re-authentication if token revoked. Credential storage via OS keyring (not plaintext). |
| Network dependency for YouTube upload | Medium | Medium | Resumable uploads survive brief disconnections. Show upload speed and ETA. Pause/resume support. Retry with exponential backoff. Warn user before starting upload on metered connection. |
| Pipeline failure mid-execution | Medium | Medium | Per-step failure recovery (see Section 7.13 failure recovery table). Pause-on-failure default. Re-run from failed step, not from scratch. Persistent pipeline state in SQLite survives app restart. |

---

## 13. Future Enhancements (Post v1.0)

| Feature | Description | See |
|---------|-------------|-----|
| **Discord Voice Overlay** | Overlay recorded Discord voice chat onto race video with timestamp sync, per-speaker audio tracks, visual radio indicators, and Craig bot integration | Section 7.11 |
| **AI Commentary** | LLM-generated race commentary from event data | — |
| **Multi-class Support** | Separate overlays per class, class-specific highlights | — |
| **Telemetry Overlays** | Speed, throttle, brake, steering overlays (like F1 TV) | — |
| **Remote Access** | Web-only mode for reviewing projects remotely | — |
| **Vimeo / Twitch Upload** | Extend upload system to additional platforms beyond YouTube | Section 7.12 |
| **Template Marketplace** | Community hub for sharing/downloading overlay `.html` templates | Section 7.6 |
| **Replay Director AI** | ML-trained camera director based on broadcast patterns | — |
| **Multi-session** | Combine qualifying + race into one project | — |
| **Chapter Markers** | Auto-generate YouTube chapter markers from events | Section 7.12 |
| **Audio Fingerprint Sync** | Automated Discord-to-race sync via cross-correlated audio | Section 7.11 |
| **Pipeline Scheduling** | Schedule pipeline runs at specific times (e.g. "encode overnight") | Section 7.13 |
| **Batch Project Pipeline** | Queue multiple projects into a single pipeline run | Section 7.13 |

---

## 14. Summary

League Replay Studio transforms a dated, slow, featureless .NET WinForms application into a modern, professional-grade video production tool. By leveraging:

- **Python + FastAPI** for a powerful async backend
- **React + Tailwind + Vite** for a slick, responsive frontend
- **pywebview** for native desktop packaging
- **FFmpeg + NVENC** for lightning-fast GPU encoding
- **pyirsdk** for direct iRacing integration
- **SQLite** for robust project storage
- **WebSocket** for real-time communication

...we deliver an application centred around a **powerful highlight editing suite** where the event selection algorithm is fully transparent and tuneable, with live preview and real-time metrics. Users can tweak rule weights on the fly, make manual overrides, reprocess instantly, and see the result update in real-time.

Capture remains via OBS/ShadowPlay (an unavoidable constraint — iRacing doesn't expose raw frames, and we need in-game audio). The real wins are:
- **Encoding**: from 60-90 minutes (CPU) to 3-8 minutes (GPU)
- **Preview**: from nothing to full-length video preview with overlay compositing
- **Editing**: from a black-box algorithm to a full interactive highlight editing suite
- **Workflow**: from start-and-pray to a **step-based project workflow** (Setup → Analysis → Editing → Capture → Export → Upload) with file browser, replay picker, and intuitive navigation
- **Pipeline**: from manual multi-step process to **one-click "Go"** with pause/resume/intervene, failure recovery, and saveable configuration presets
- **YouTube**: from manual upload to **integrated YouTube channel** — auto-upload with templated metadata, video browser, project association
- **CLI**: once configured, `lrs.bat --project ... --highlights` spits out the video — no UI needed

The hybrid FastAPI/pywebview architecture from livery-ai-studio, combined with the frontend patterns and conventions from the Blue Flags & Dads reference docs, gives us a proven foundation to build on.

### 14.1 Versioning & Release Process

League Replay Studio follows [Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), mirroring the release workflow established in livery-ai-studio.

| File | Purpose |
|------|---------|
| `backend/version.py` | **Single source of truth** for app version — imported at runtime by `app.py`, referenced by PyInstaller spec and CI release workflow |
| `CHANGELOG.md` | Keep-a-Changelog formatted release notes with Added/Changed/Fixed/Removed sections per version |
| `.github/workflows/release.yml` | CI workflow: on `v*` tag push → build React frontend → PyInstaller bundle → draft GitHub Release |

**Release workflow:**
```
1. Bump __version__ in backend/version.py (e.g., "0.2.0-beta")
2. Update CHANGELOG.md with new version section
3. Commit: "release: v0.2.0-beta"
4. Tag: git tag v0.2.0-beta
5. Push: git push origin main --tags
6. CI builds exe → creates draft GitHub Release
7. Review draft → click "Publish release"
```

**Version displayed in:**
- Application window title bar
- Settings → About dialog
- CLI `lrs.bat --version` output
- API response at `GET /api/system/info`
- Log file header

---

*Document created: 2026-03-31*
*Version: 2.0 (Final planning phase)*
*Author: League Replay Studio Team*

> This document was iteratively developed through 6 revision cycles (v1.0–v1.6) covering legacy analysis, telemetry deep-dives, schema normalisation, overlay engine redesign, YouTube integration, step-based workflows, and automated pipeline design. All revisions have been consolidated into this final v2.0 for agent handoff.
