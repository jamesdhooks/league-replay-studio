# League Replay Studio — Interface Screenshots

Generated from the live application running against the **Demo – Silverstone GP** dummy
dataset (20 drivers, 15 laps, 16 detected events). All screenshots were captured at
1920 × 1080.  Run `python backend/seed_demo_data.py` to recreate the demo project.

---

## Pipeline stage walkthrough

### 1. Project Library
`01_project_library.png`  
The home screen showing the Demo – Silverstone GP project card with the 5-step
workflow indicator (Analysis → Editing → Capture → Export → Upload).

### 2. Analysis — Preview pane
`02_project_view_analysis.png`  
Analysis stage with the live-preview area and the Re-analyze / Open Editor / Clear
options panel on the right.

### 3. Analysis — Event log (16 events)
`03_analysis_events.png`  
The Events sidebar listing all 16 seeded race events: First Lap, Leader Changes,
Overtakes, Battles, Crash, Incident, Spinout, Contact, Close Call, Pit Stops,
Fastest Lap, and Last Lap — each with driver names, timestamp and severity badge.

### 4. Editing — Histogram-based event organizer
`04_editing_highlights.png`  
Full highlight-editing suite: event-priority sliders (Incidents 80, Battles 60,
Overtakes 85 …), minimum-severity control, 420 s target duration — alongside the
**Score Histogram** (10 score-bucket columns, time flows top→bottom, events as
coloured tiles) and the **Result Timeline** (selected events in sequence with
tier badges, duration, and score). NLE timeline and preview panel at the bottom.

### 5. Capture
`05_capture_panel.png`  
Capture-software detection (OBS Studio / NVIDIA ShadowPlay / AMD ReLive), hotkey
configuration (F9 start/stop), output directory, and hotkey-validation test button.

### 6. Export & Encode
`06_export_panel.png`  
GPU-encoder detection, export-preset selector (YouTube 1080p60 / Discord 720p30 /
Archive 4K), output-type toggle (Full Race vs Highlight Reel), source-video path,
and the completed-exports history panel.

### 7. Upload
`07_upload_panel.png`  
YouTube / platform upload stage placeholder.

### 8. Settings
`08_settings_panel.png`  
Application settings with tabs for General, Camera Defaults, Encoding, AI / LLM,
YouTube, Hotkeys, Pipeline, and Setup Wizard.

### 9. Editing — Event Inspector with Histogram
`09_editing_inspector.png`  
Editing view with the Inspector sidebar active showing per-event detail for the
selected **First Lap** event: type, severity (8), timestamps (00:00 → 01:35),
Highlight toggle, camera, involved drivers (all 20), and metadata. The Score
Histogram and Result Timeline remain visible to the right.

### 10. Highlight Presets
`10_highlight_presets.png`  
Presets dropdown for saving / loading named highlight configurations.

---

## Overlay templates

All templates rendered at 1920 × 1080 with the Silverstone GP sample frame data
(Lewis Hamilton P1, Lap 8/15, green flag, 8-car standings tower).

### 11. Overlay — Template library
`11_overlay_broadcast_template.png`  
Overlay step showing the Preset Design Suite with the 5 built-in templates
(Broadcast, Minimal, Classic, Cinematic, Blank) as selectable cards with
resolution badges and edit/duplicate/export actions.

### 12. Overlay — Broadcast template editor
`12_overlay_minimal_template.png`  
Monaco Editor split-pane for the Broadcast template (HTML/Tailwind source on the
left, live preview canvas on the right with zoom controls).

### 13. Overlay — Cinematic template editor
`13_overlay_cinematic_intro.png`  
Template editor open on the **Cinematic** lower-third overlay: Monaco editor
pane with Variables / Animations toolbar, and the preview canvas at 16 % zoom.

### 14. Overlay — Classic template editor
`14_overlay_classic_template.png`  
Template editor open on the **Classic** timing-board overlay showing the Monaco
source panel and the 1920 × 1080 preview area.

### 15. Full editing view (full page)
`15_pipeline_overview.png`  
Full-page capture of the Editing panel showing the complete highlight-tuning
column (sliders + metrics), the Score Histogram with all 16 events distributed
across 10 score-bucket columns, the Result Timeline with 11 selected clips, and
the NLE timeline with Camera and Events tracks at the bottom.

---

## Dummy data files

| File | Location | Contents |
|------|----------|----------|
| `seed_demo_data.py` | `backend/` | Idempotent seeder — creates all data below |
| `project.db` | `data/projects/demo_silverstone_gp_*/` | SQLite: 2 700 telemetry ticks, 20 drivers, 16 race events, highlight config |
| `highlight_script.json` | project dir | 14-segment highlight script with scores, tiers, transitions |
| `pipeline_preset.json` | project dir | Full pipeline preset (analysis → upload) |
| `overlays/sample_frame_data.json` | project dir | Sample overlay frame-data for all templates |
