# Overlay Studio Full Refactor Blueprint (Visual-First)

## Goal
Rebuild the overlay UX so users only select and edit **Overlay Designs** (visual presets) at top level.
Template/HTML tooling is internal to the Design Suite as an advanced Build workspace.

## Product Principles
1. One top-level object: `Overlay Design`.
2. One primary workspace: `Overlay Studio`.
3. Live preview is always timeline-aware and section-aware.
4. AI tooling and visual editing are first-class and adjacent.
5. HTML/template editing is advanced, internal, and discoverable.

## Information Architecture
### Top-level Overlay Step
- Overlay Studio shell
  - Left: Design Library (design-only list)
  - Right: Workspace tabs
    - Preview
    - Design Suite
    - Build
    - Data
    - PiP

### Removed from top-level
- Template-vs-Visual mode filters
- Dual active selections (`selectedTemplateId` + `selectedPresetId`) as user-facing concept

## Domain Model
### Primary user-facing model
- `Overlay Design`
  - name / description
  - section element definitions
  - variables
  - optional advanced build assets

### Internal/advanced model
- `Template` (HTML build artifact)
  - managed under Build tab
  - opened through internal editor

## Core User Flows
### 1) Create and select design
1. Click New Design in library.
2. Design is auto-selected.
3. User moves to Preview or Design Suite tab.

### 2) Visual design editing
1. Select design in library.
2. Open Design Suite tab.
3. Use element tools, section tabs, AI generation/augmentation.

### 3) Advanced HTML customization
1. Open Build tab.
2. Create/select template.
3. Open template editor inline in Studio.

### 4) Timeline validation
1. Open Preview tab.
2. Scrub/play section timeline.
3. Confirm design render overlay output by section/event.

## Component Architecture
### New/Updated Components
- `OverlayStudio.jsx` (new shell and orchestration)
- `OverlayPreviewStep.jsx` (visual-only preview mode)
- `ProjectView.jsx` (uses OverlayStudio directly)

### Existing reused components
- `PresetDesigner.jsx` (Design Suite workspace)
- `OverlayEditor.jsx` (Build workspace)
- `DataPluginsPanel.jsx`
- `PipConfigurator.jsx`

## State Architecture
### Studio-level state
- `selectedPresetId` = single active top-level design
- `activeWorkspaceTab` in Overlay Studio

### Removed user-facing state coupling
- No top-level template selection in overlay step

### Render source of truth
- Visual preview rendering uses `PresetContext.renderPreview()` with section/time/frame data.

## Technical Scope of Refactor
1. Replace old overlay split layout in project step with Overlay Studio shell.
2. Remove top-level HTML mode behavior from preview.
3. Move template management to Build workspace within Studio.
4. Keep backend APIs as-is for now; simplify UI contracts first.

## Acceptance Criteria
1. User can complete overlay work without ever picking "HTML vs Visual" at top level.
2. User can always see selected design context in Studio.
3. Visual preview renders selected design over timeline.
4. Template editor is reachable inside Studio via Build tab.
5. AI design access is one click from selected design.

## Delivered in this refactor
- Overlay step now opens `OverlayStudio` directly.
- Left pane is **design-only** (preset list + create/duplicate/delete).
- Right pane has Studio tabs (Preview/Design Suite/Build/Data/PiP).
- Preview is visual-design-first and no longer has top-level HTML mode fallback.
- Build workspace includes internal template listing + create + open editor.

## Follow-up Hardening
1. Add explicit design assignment controls for per-segment overrides (`overlay_preset_id`).
2. Add searchable design library and tags.
3. Add "Design health" diagnostics (missing assets/variables).
4. Add UX telemetry for create→preview and design-edit completion times.
5. Legacy overlay panel removed (Overlay Studio is now the sole overlay entrypoint).
