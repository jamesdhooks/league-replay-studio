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

### 4. Editing — Highlight tuning + timeline
`04_editing_highlights.png`  
Full highlight-editing suite: event-priority sliders (Incidents 80, Battles 60,
Overtakes 85 …), minimum-severity control, 420 s target duration, scored-events
table with Tier S/A/B/C badges, and the NLE-style timeline at the bottom.

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

### 9. Editing — Event Inspector
`09_editing_inspector.png`  
Editing view with the Inspector sidebar active showing per-event detail.

### 10. Highlight Presets
`10_highlight_presets.png`  
Presets dropdown for saving / loading named highlight configurations.

---

## Overlay templates

All templates rendered at 1920 × 1080 with the Silverstone GP sample frame data
(Lewis Hamilton P1, Lap 8/15, green flag, 8-car standings tower).

### 11. Broadcast overlay
`11_overlay_broadcast_template.png`  
Full broadcast overlay: top header (series + track + lap counter), right-side
standings tower (P1–P8 with gaps), bottom-left driver nameplate with best-lap time.

### 12. Minimal overlay
`12_overlay_minimal_template.png`  
Clean minimal overlay: large position badge, driver name, current/total laps, and
a single last-lap time strip.

### 13. Cinematic intro overlay
`13_overlay_cinematic_intro.png`  
Full-screen title card for the intro section: series name and track name in
high-contrast typography over a transparent background.

### 14. Classic overlay
`14_overlay_classic_template.png`  
Traditional timing-board layout: header bar with series + lap + session time,
classic leaderboard table (P · Driver · Gap), and driver nameplate strip.

### 15. Full editing view (scrolled)
`15_pipeline_overview.png`  
Full-page capture of the Editing panel showing the complete highlight-tuning
column, scored-events table, and the NLE timeline with Camera and Events tracks.

---

## Dummy data files

| File | Location | Contents |
|------|----------|----------|
| `seed_demo_data.py` | `backend/` | Idempotent seeder — creates all data below |
| `project.db` | `data/projects/demo_silverstone_gp_*/` | SQLite: 2 700 telemetry ticks, 20 drivers, 16 race events, highlight config |
| `highlight_script.json` | project dir | 14-segment highlight script with scores, tiers, transitions |
| `pipeline_preset.json` | project dir | Full pipeline preset (analysis → upload) |
| `overlays/sample_frame_data.json` | project dir | Sample overlay frame-data for all templates |
