# League Replay Studio — Highlight Generation System
## Implementation Plan v2.0

> Covers: Telemetry Pipeline · Event Detection · Scoring Algorithm · LLM Editorial Layer · Video Composition Script · Render Engine Contract · Interactive UI

---

## Table of Contents

1. [System Status Overview](#1-system-status-overview)
2. [Telemetry Pipeline](#2-telemetry-pipeline)
3. [Event Scoring Algorithm](#3-event-scoring-algorithm)
4. [LLM Editorial Layer](#4-llm-editorial-layer)
5. [Video Composition Script (Master Contract)](#5-video-composition-script-master-contract)
6. [Backend API](#6-backend-api)
7. [User Interface](#7-user-interface)
8. [Data Contracts (Backend ↔ UI)](#8-data-contracts-backend--ui)
9. [Pseudocode — Full Updated Pipeline](#9-pseudocode--full-updated-pipeline)
10. [Implementation Order](#10-implementation-order)

---

## 1. System Status Overview

This section establishes a clear baseline of what has been designed, what has been implemented, and how the new enhancements integrate. The entire backend (telemetry, detection, scoring, highlight engine) currently exists only as design specifications in `documentation/master-plan.md`. The only working code is the career stats service.

### 1.1 Component Status Matrix

| Component | Current Status | Action Required |
|---|---|---|
| IRacingBridge (telemetry connection) | Design only (MPD:840–965) | Implement as designed |
| SQLite schema (race_ticks, car_states, etc.) | Design only (MPD:560–624) | Implement as designed, add speed/RPM columns |
| TelemetryWriter.write_tick() | Design only (MPD:1050–1102) | Implement; extend to capture speed per car |
| IncidentDetector | Design only (MPD:1109–1151) | Implement as designed |
| BattleDetector | Design only (MPD:1154–1223) | Implement; extend to N-car chains |
| 9 additional detectors | Design only | Implement per SQL patterns |
| HighlightEditor.reprocess() | Design only (MPD:2659–2714) | Replace with multi-pass pipeline (Section 4) |
| FFmpeg EDL encoding | Design only (MPD:1375–1388) | Replace with Video Composition Script (Section 5) |
| Frontend Highlight Suite | Design only (MPD:1823–1868) | Implement updated UI (Section 7) |
| LLM Editorial Layer | Not designed | **New** — implement (Section 4) |
| Video Composition Script (master contract) | Not designed | **New** — implement (Section 5) |
| career_stats_service.py | ✅ Implemented | No changes needed |
| iRacing career stats API route | ✅ Implemented | No changes needed |

### 1.2 What Is Kept, Replaced, Added, or Irrelevant

| Area | Status | Notes |
|---|---|---|
| SQLite telemetry schema (race_ticks, car_states) | ✅ Keep | Solid foundation; minor column additions only |
| IRacingBridge polling loop (60 Hz) | ✅ Keep | Core mechanism unchanged |
| Event detector SQL patterns | ✅ Keep | BattleDetector extended to N-car; others unchanged |
| HighlightEditor.reprocess() simple scoring | 🔄 Replace | Replaced by multi-pass scoring + LLM layer |
| EDL-only output to FFmpeg | 🔄 Replace | Replaced by Video Composition Script (master contract) |
| Segment types: event, pip | ✅ Keep | Extended with transition, broll |
| UI histogram + timeline views | ✅ Keep | Extended with debug panel, LLM annotations |
| Audio configuration | 🚫 Irrelevant | Audio pipeline (music, commentary) excluded from scope |
| LLM editorial layer | 🆕 New | Post-scoring narrative refinement |
| Video Composition Script format | 🆕 New | Declarative render contract replacing EDL |
| Camera configuration per segment | 🆕 New | mode, angle, follow_driver per event segment |
| Transition segments | 🆕 New | cut, fade, crossfade, whip, zoom between clips |
| B-roll / gap filler segments | 🆕 New | track_side_camera inserts for timeline gaps |
| Render configuration block | 🆕 New | Resolution, codec, frame_rate in output script |
| Speed telemetry (CarIdxSpeed derived) | 🆕 New | Underutilized; now captured and used in scoring |
| N-car battle chains | 🆕 New | BattleDetector extended beyond adjacent pairs |

---

## 2. Telemetry Pipeline

The telemetry pipeline is unchanged in its core architecture: a 60 Hz polling thread reads iRacing's memory-mapped shared memory, snapshots telemetry variables, and writes to SQLite. The following changes are additive.

### 2.1 IRacingBridge — No Structural Changes

The IRacingBridge class design (MPD:845–965) is retained as-is. The polling loop at 60 Hz, `freeze_var_buffer_latest()` atomic snapshot discipline, and background thread model all carry forward without modification.

### 2.2 Extended Telemetry Variables — New Captures

The following variables are available in the irsdk SDK but were not being captured. They should now be read in `_emit_telemetry()` and stored:

| iRacing Variable | Type | Store In | Rationale |
|---|---|---|---|
| CarIdxSpeed (derived) | float[] | car_states.speed_ms | Crash severity scoring; spin/lock detection |
| CarIdxF2Time | float[] | car_states.f2_time | More accurate than lap_pct × avg_lap_time for battle gap |
| CarIdxLastLapTime | float[] | car_states.last_lap_time | Lap regression detection; penalty detection |
| CarIdxSteer | float[] | car_states.steer_angle | Spin detection combined with surface = OffTrack |
| SessionFlags (parsed bits) | int → bits | race_ticks.flag_yellow, flag_checkered, flag_red | Yellow/red period detection beyond raw integer |

> **Note:** Speed is not directly exposed per-car as `CarIdxSpeed` in the standard irsdk variable set. Approximate per-car speed is derived from the rate of change of `CarIdxLapDistPct × track_length`. This derivation should be computed in `TelemetryWriter.write_tick()` and stored as `car_states.speed_ms`.

### 2.3 SQLite Schema Additions

The following columns are added to the existing schema. No tables are dropped or renamed.

#### car_states — New Columns

```sql
ALTER TABLE car_states ADD COLUMN speed_ms       REAL DEFAULT NULL;
ALTER TABLE car_states ADD COLUMN f2_time        REAL DEFAULT NULL;
ALTER TABLE car_states ADD COLUMN last_lap_time  REAL DEFAULT -1;
ALTER TABLE car_states ADD COLUMN steer_angle    REAL DEFAULT NULL;
```

#### race_ticks — New Columns

```sql
ALTER TABLE race_ticks ADD COLUMN flag_yellow     INTEGER DEFAULT 0;
ALTER TABLE race_ticks ADD COLUMN flag_red        INTEGER DEFAULT 0;
ALTER TABLE race_ticks ADD COLUMN flag_checkered  INTEGER DEFAULT 0;
```

### 2.4 BattleDetector — Extended to N-Car Chains

The existing BattleDetector SQL (MPD:1154–1223) detects only adjacent-position pairs (position vs. position+1). This is replaced with a chain-linking algorithm:

1. Run the existing adjacent-pair query to find all qualifying pairs within the gap threshold.
2. In Python, build a graph where nodes are `car_idx` and edges represent qualifying pairs at a given tick.
3. Identify connected components (chains) — a 4-car train produces a single battle event with all 4 cars in `involved_drivers`.
4. Group by time window as before (merge consecutive ticks within 3-second minimum duration).
5. Store `chain_length` in the `race_events.metadata` JSON for narrative scoring bonus.

**Impact:** The `battle_context.cars_in_pack` and `battle_context.duration` fields in the event data model are now populated from real chain detection rather than estimated. The narrative bonus formula `log(chain_length + 1) × 0.5` now has accurate input.

### 2.5 Speed-Based Crash Severity

The IncidentDetector currently assigns severity 0–10 from iRacing's camera switch heuristic only. With `speed_ms` now stored, severity is computed as:

```python
# At the moment of camera switch to off-track car:
speed_at_incident = car_states.speed_ms  # m/s
speed_severity = min(speed_at_incident / 70.0, 1.0)  # normalised to ~70 m/s ≈ 250 km/h
severity = round(speed_severity * 10)  # integer 0–10
```

---

## 3. Event Scoring Algorithm

The existing `HighlightEditor.reprocess()` uses a single-pass formula: `score = event.severity × (weight / 100)`. This is replaced with a multi-factor pipeline that maps directly to the design specification in the original plan document, with the following refinements and additions.

### 3.1 Scoring Pipeline (Full)

Each detected event passes through all stages in order. The result is a float score and a tier classification.

#### Stage 1 — Base Score

| Event Type | Base Score |
|---|---|
| crash / incident | 1.5 |
| battle | 1.3 |
| spin | 1.2 |
| overtake | 1.0 |
| leader_change | 0.9 |
| fastest_lap | 0.7 |
| pit_stop | 0.5 |
| first_lap / last_lap / restart | Mandatory (always included) |

#### Stage 2 — Position Importance Multiplier

```python
if position in (1, 2, 3):  multiplier = 2.0
elif position <= 10:        multiplier = 1.5
else:                       multiplier = 1.0
score *= multiplier
```

#### Stage 3 — Position Change Multiplier

```python
score *= (1 + abs(position_delta) * 0.3)
```

#### Stage 4 — Consequence Weighting

Consequence score aggregates: positions lost, damage severity (from `speed_ms` at incident), and race impact (subsequent position changes within 30 s window).

```python
consequence = (positions_lost * 0.3) + (damage_severity * 0.4) + (race_impact * 0.3)
score *= (1 + consequence)
```

#### Stage 5 — Narrative Bonus

```python
# Battle chain bonus — chain_length from N-car detector
if event.type == 'battle':
    score += log(chain_length + 1) * 0.5

# Recency bonus — events in last 10% of race
if event.race_pct > 0.9:
    score *= 1.2
```

#### Stage 6 — Exposure Adjustment

```python
target = total_video_time / num_drivers * driver_weight
actual = exposure_map.get(driver, 0)
score *= (1 + (target - actual) * 0.5)
```

#### Stage 7 — User Weight Override

This replaces the single `score = severity × (weight/100)` from HighlightEditor. Instead, weights act as per-type multipliers applied after the algorithmic score:

```python
user_weight = weights.get(event.type, 50) / 100.0
score *= user_weight
```

#### Stage 8 — Tier Classification

| Tier | Score Range | Selection Behaviour |
|---|---|---|
| S | > 9 | Must-have pass — always included first |
| A | 7 – 9 | Bucket fill — high priority |
| B | 5 – 7 | Bucket fill — medium priority |
| C | < 5 | Only included if duration budget permits |

### 3.2 Multi-Pass Timeline Allocation

This replaces the single greedy sort-by-score loop in HighlightEditor. The multi-pass approach preserves narrative structure across the race.

1. **Pass 1 — Must-Have Events:** All mandatory types (`first_lap`, `last_lap`, `restart`) plus all Tier S events are added first and distributed by timestamp into their natural race phase.
2. **Pass 2 — Bucket Fill:** The remaining timeline is divided into intro (0–15%), early (15–40%), mid (40–70%), and late (70–100%) buckets. Each bucket has a duration budget. Events are selected within each bucket by local score, respecting bucket budget.
3. **Pass 3 — Smoothing:** Resolve repetition (no two same-type events back-to-back unless score differential > 2), enforce minimum spacing between clips, and rebalance driver exposure.
4. **Gap Handling:** If gap between selected clips is < 8 s, extend clip padding. If gap is ≥ 8 s, insert a `broll` segment (`track_side_camera`) as a gap filler.

### 3.3 Conflict Resolution

Overlapping events are resolved in order:

1. If the two events share `involved_drivers`, attempt to merge into a single extended clip.
2. If both events score above the PIP threshold (configurable, default 7.0), assign as a PIP segment with the higher-scored event as primary.
3. Otherwise, keep the higher-scored event and discard the lower.

---

## 4. LLM Editorial Layer

The LLM editorial layer is entirely new. It operates after the deterministic scoring pipeline has produced a candidate timeline, and before the Video Composition Script is finalised. It does not replace the algorithmic selection — it refines the narrative, adds segment notes, and can swap events within a tier without changing the overall structure.

### 4.1 Position in Pipeline

| Step | System | Output |
|---|---|---|
| 1. Event Detection | SQL detectors | race_events rows |
| 2. Scoring | Multi-pass algorithm (Section 3) | Scored + tiered events |
| 3. Timeline Allocation | Bucket fill + smoothing | Candidate timeline |
| 4. LLM Refinement | LLM editorial call (this section) | Annotated, narrative-coherent timeline |
| 5. Validation | Constraint checker | Validated timeline |
| 6. Script Generation | Output builder | Video Composition Script JSON |

### 4.2 LLM Invocation

The LLM is called once per highlight generation, after the deterministic timeline is assembled. It receives a structured prompt containing the candidate timeline and race context:

```json
{
  "task": "editorial_refinement",
  "race_context": {
    "track": "Spa-Francorchamps",
    "total_laps": 44,
    "num_drivers": 20
  },
  "candidate_timeline": [ /* scored segments */ ],
  "constraints": {
    "target_duration": 300,
    "max_driver_exposure": 0.25
  },
  "instructions": "Add a narrative note to each segment. You may swap two events within the same tier if it improves story flow. Do not change mandatory events. Return JSON only."
}
```

### 4.3 LLM Permitted Actions

The LLM is constrained to the following actions only — it cannot override the deterministic tier structure:

- Add a `notes` field to any segment (shown in UI and written to segment in output script)
- Swap two events of equal tier within the same bucket if it improves narrative continuity
- Suggest a `transition_type` between two adjacent segments (`cut`, `fade`, `crossfade`, `whip`, `zoom`)
- Flag a segment as `narrative_anchor` if it is pivotal to the race story

**Not permitted:** Changing event inclusion/exclusion, overriding tier classification, modifying timestamps, or adjusting scores. These remain deterministic.

### 4.4 LLM Output Schema

```json
{
  "refined_segments": [
    {
      "id": "seg_001",
      "notes": "Dramatic overtake into Eau Rouge sets the race narrative early",
      "transition_to_next": "whip",
      "narrative_anchor": true
    }
  ],
  "prompt_hash": "abc123def456"
}
```

### 4.5 Validation After LLM

LLM output is validated before being merged into the timeline. Validation checks:

- All referenced segment IDs exist in the candidate timeline
- No swaps cross tier boundaries
- No swaps cross bucket phase boundaries
- No notes exceed 200 characters
- `transition_to_next` value is in the supported set: `cut`, `fade`, `crossfade`, `whip`, `zoom`

If validation fails, LLM output is discarded and the deterministic timeline is used as-is. The `metadata.llm_used` field is set to `false` in the output script.

### 4.6 LLM Metadata in Output

The `meta` section and `metadata` section of the Video Composition Script both record LLM participation:

```json
"generator": {
  "algorithm_version": "scoring_v3",
  "llm_used": true,
  "llm_model": "claude-sonnet-4-20250514"
},
"validation_status": "passed",
"llm_prompt_hash": "abc123def456"
```

---

## 5. Video Composition Script (Master Contract)

The Video Composition Script replaces the EDL (Edit Decision List) that was previously passed to FFmpeg. It is a declarative, fully validated JSON document that serves as the single source of truth for the render engine. It is produced after deterministic scoring, optional LLM refinement, and constraint validation.

> **Key Principle:** The script is declarative, deterministic, and independent of the UI and algorithm layers. The render engine consumes it without knowledge of how it was produced.

### 5.1 Top-Level Structure

```json
{
  "version": "1.0",
  "meta": { },
  "timeline": [ ],
  "render": { },
  "metadata": { }
}
```

> **Note:** The `audio` block from the enhancement specification is excluded from scope. Game audio (in-sim sound) is handled by the render engine natively; music and commentary are not part of this system.

### 5.2 Meta Section

```json
{
  "title": "League Race Highlights — Round 5",
  "source_race_id": "race_2026_03_01",
  "generated_at": "2026-03-01T18:00:00Z",
  "duration_seconds": 300,
  "generator": {
    "algorithm_version": "scoring_v3",
    "llm_used": true,
    "llm_model": "claude-sonnet-4-20250514"
  }
}
```

### 5.3 Timeline Segment Types

| Type | Description | Replaces |
|---|---|---|
| `event` | A single race event clip with camera config and padding | EDL clip entry |
| `pip` | Two simultaneous views composited into one frame | Existing pip model (kept, extended) |
| `transition` | Editorial cut/fade/whip between two adjacent segments | New — not in EDL |
| `broll` | Gap filler from track-side or static cameras | New — not in EDL |

### 5.4 Event Segment Schema

```json
{
  "id": "seg_001",
  "type": "event",
  "source_event_id": "evt_42",
  "start_time": 1234.0,
  "end_time": 1244.0,
  "duration": 10.0,
  "drivers": ["car_12", "car_7"],
  "priority_score": 8.7,
  "notes": "Overtake into turn 3",
  "camera": {
    "mode": "auto",
    "angle": "broadcast",
    "follow_driver": "car_12"
  },
  "capture": {
    "padding_before": 2.0,
    "padding_after": 3.0
  },
  "pip": null
}
```

`camera.mode`: `"auto"` defers to iRacing's director. `"manual"` requires `angle` and `follow_driver` to be set. Camera configuration is new — not in the previous EDL model.

### 5.5 PIP Segment Schema

```json
{
  "id": "seg_010",
  "type": "pip",
  "primary": { "source_event_id": "evt_55", "region": "full" },
  "secondary": {
    "source_event_id": "evt_60",
    "region": "pip",
    "pip_position": "bottom_right",
    "pip_scale": 0.35
  },
  "start_time": 2000.0,
  "end_time": 2012.0,
  "synchronization": { "mode": "time_aligned" }
}
```

### 5.6 Transition Segment Schema

```json
{
  "id": "trans_001",
  "type": "transition",
  "transition_type": "whip",
  "duration": 0.5,
  "from_segment": "seg_001",
  "to_segment": "seg_002"
}
```

| Transition Type | Use Case |
|---|---|
| `cut` | Default — immediate switch; high-energy moments |
| `fade` | Session phase transitions (intro to main race) |
| `crossfade` | Smooth tonal shift between calm moments |
| `whip` | LLM-suggested for fast consecutive action sequences |
| `zoom` | Dramatic reveal; leaderboard moments |

### 5.7 B-Roll Segment Schema

```json
{
  "id": "broll_001",
  "type": "broll",
  "source": "track_side_camera",
  "start_time": 500.0,
  "end_time": 510.0,
  "purpose": "gap_filler"
}
```

B-roll is inserted by the timeline smoothing pass when a gap between events is ≥ 8 seconds. The `source` field references a static or track-side camera available in the iRacing replay. `purpose` is always `"gap_filler"` in the current version.

### 5.8 Render Configuration

```json
{
  "resolution": { "width": 1920, "height": 1080 },
  "frame_rate": 60,
  "codec": "h264",
  "bitrate": "10M",
  "output_format": "mp4",
  "pip_enabled": true
}
```

### 5.9 Metadata Section

```json
{
  "total_events_considered": 152,
  "events_selected": 24,
  "events_rejected": 128,
  "driver_exposure": { "car_12": 0.18, "car_7": 0.22 },
  "llm_used": true,
  "llm_prompt_hash": "abc123",
  "validation_status": "passed"
}
```

### 5.10 Script Constraints

Before the script is written to disk, the validation stage enforces:

- Total segment duration is within ±5 seconds of `target_duration`
- No two non-PIP segments have overlapping time ranges
- All `source_event_id` values reference valid `race_events` rows in the database
- All `from_segment` and `to_segment` references in transitions point to adjacent segments
- Per-driver exposure does not exceed `max_driver_exposure` constraint
- Timeline is continuous: every gap between segments is either a transition or a broll segment
- All transition types are members of the supported set

### 5.11 Render Engine Execution Model

The render engine processes the script sequentially — it has no knowledge of the scoring algorithm or LLM:

1. Iterate through timeline segments in order.
2. For each `event` segment: load iRacing replay at `start_time − padding_before`; apply camera configuration; play until `end_time + padding_after`.
3. For each `pip` segment: load and sync both event streams; composite secondary into primary frame at `pip_position` with `pip_scale`.
4. For each `transition` segment: apply the specified transition effect between the `from` and `to` segments.
5. For each `broll` segment: load the specified track-side camera and render for the segment duration.
6. Encode the composed video using render configuration (codec, bitrate, resolution, frame_rate).

---

## 6. Backend API

The existing API design (MPD:2011–2018) is extended. The new endpoints support the LLM editorial layer, the Video Composition Script output, and the extended recompute request.

### 6.1 Retained Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/projects/{id}/highlights/config` | Fetch current rule weights and settings |
| `PUT /api/projects/{id}/highlights/config` | Update rule weights and settings |
| `POST /api/projects/{id}/highlights/reprocess` | Run full pipeline; returns updated selection + metrics |
| `POST /api/projects/{id}/highlights/configs/save` | Save a named weight configuration |

### 6.2 New Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/projects/{id}/highlights/script` | Return the current Video Composition Script JSON |
| `POST /api/projects/{id}/highlights/script/validate` | Validate a script against all constraints without writing |
| `POST /api/projects/{id}/highlights/llm-refine` | Trigger LLM editorial pass on current candidate timeline |
| `GET /api/projects/{id}/events` | Return raw race_events (replaces `GET /events` in original spec) |
| `GET /api/projects/{id}/scored-events` | Return scored + tiered events |

### 6.3 Extended Recompute Request

```json
{
  "weights": {
    "overtake": 1.0,
    "crash": 1.5,
    "battle": 1.3
  },
  "constraints": {
    "max_driver_exposure": 0.2,
    "pip_threshold": 7.0,
    "target_duration": 300,
    "min_severity": 4
  },
  "llm_enabled": true
}
```

The `llm_enabled` flag controls whether the LLM editorial pass runs after deterministic scoring. It defaults to `false` for fast recomputes during interactive weight tuning.

### 6.4 Versioning

Every recompute increments the timeline version. The Video Composition Script carries the same version number. The UI reconciles based on version and replays overrides on recompute. All overrides (`force_include`, `force_exclude`, `swap`, `adjust_padding`, `set_pip`) are stored as a list and applied before the LLM pass.

### 6.5 WebSocket Events

| Event | Trigger |
|---|---|
| `highlight:reprocessed` | Full pipeline complete — new selection, metrics, and script ready |
| `highlight:metrics_update` | Live metrics update during interactive weight tuning |
| `highlight:llm_complete` | LLM editorial pass complete — notes and transitions added |
| `highlight:validation_failed` | Script validation failed — reason included in payload |

---

## 7. User Interface

The editing step is centred on a **histogram-based event organizer** — a two-panel view that maps every detected event into a visual grid of Time (vertical, top→bottom) × Importance (horizontal, low→high score buckets 1–10).

### 7.1 Core Concept

- **Time flows top to bottom** (race start → finish).
- **Score flows left to right** (low → high, 10 columns).
- Each event is placed into a column based on its score bucket, and positioned vertically by its time in the race.

### 7.2 Layout Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  CONFIG BAR (presets, A/B compare, apply)                       │
├────────┬──────────────────────────────────────────┬──────────────┤
│        │  WEIGHT SLIDERS │    SCORE HISTOGRAM     │   RESULT     │
│ SIDE-  │  + METRICS      │ Cols 1│2│3│…│9│10      │   TIMELINE   │
│ BAR    │  (w-72 left)    │ ↓ time flows down      │  (selected   │
│        │                 │  event tiles in buckets │   events in  │
│ Events │                 │  color = type           │   sequence)  │
│ Inspec │                 │  opacity = inclusion    │              │
│ History│                 │  click = inspect        │  [E1]→[E5]→  │
│ Files  │                 │  right-click = override │  [PIP(E7)]→  │
│        │                 │                         │  [B-roll]→   │
├────────┴─────────────────┴─────────────────────────┴──────────────┤
│  PREVIEW PANEL                                                   │
├──────────────────────────────────────────────────────────────────┤
│  NLE TIMELINE (full race, zoomable)                              │
└──────────────────────────────────────────────────────────────────┘
```

| Panel | Status | Notes |
|---|---|---|
| Top Controls (weight sliders, target duration, reprocess) | ✅ Implemented | LLM Enable toggle, llm_model display |
| Left — Score Histogram (event tiles by score bucket, 10 columns) | ✅ Implemented | Tier colour coding (S/A/B/C), narrative-anchor stars, PIP stripes |
| Right — Result Timeline (vertical list of selected segments) | ✅ Implemented | Transition type badges, B-roll segments, LLM notes overlay |
| Bottom — Source Timeline (full race, zoomable) | ✅ Implemented | No changes |
| Event Detail Panel (sidebar Inspector tab) | ✅ Implemented | Score breakdown bars, LLM note, involved drivers |
| Live Metrics Dashboard | ✅ Implemented | Duration, event count, coverage %, balance/pacing scores |

### 7.3 Histogram Behaviour

- **Columns** = score buckets (1–10). Score is mapped from 0-100 range: `bucket = ceil(score / 10)`.
- **Rightmost columns** = highest scoring events.
- Each event is rendered as a **tile**:
  - Vertical position = time in race (top = race start, bottom = finish)
  - Column = score bucket
  - Height = proportional to event duration (with min-height)
- **Visual encoding:**
  - Color = event type (incident=red, battle=orange, overtake=blue, etc.)
  - Opacity: full=selected (highlight), 50%=full-video, 20%=excluded
  - Border: thick white = selected/hovered, thin = default
  - Small metadata labels (3-letter type abbreviation)
  - ★ star overlay for narrative-anchor events
  - Diagonal-stripe for PIP segments

### 7.4 Result Timeline

The result timeline is a **vertical list** (scrollable) of selected events in chronological order:

- **Event segments** — coloured strip + type label + duration + tier badge + score
- **PIP segments** — split-view icon, primary colour with Layers icon
- **Transition segments** — thin entry labelled with transition type (CUT / FADE / WHIP / etc.)
- **B-roll segments** — grey hatched strip, labelled B-ROLL

LLM-added notes appear as a tooltip on hover. Narrative-anchor segments show a ★ star.

### 7.5 Interactions

| Action | Behaviour |
|---|---|
| **Hover tile** | Highlights event in histogram AND result timeline simultaneously |
| **Click tile** | Opens Event Inspector in sidebar, seeks playhead to event start |
| **Right-click tile** | Cycles override: auto → highlight → full-video → exclude → auto |
| **Click result segment** | Same as clicking the histogram tile |

### 7.6 Manual Overrides

Users can:
- **Force include/exclude** via right-click override cycling
- **Adjust padding** via the Inspector panel
- **Move between score buckets** by editing the event's score
- **Assign/remove PIP** via the Inspector or context menu

All changes update both the histogram and result timeline immediately.

| Override Action | Applied Before or After LLM? |
|---|---|
| `force_include` | Before — forces event into candidate timeline; LLM may annotate it |
| `force_exclude` | Before — removes event before LLM sees it |
| `swap` | Before — LLM sees swapped order and may adjust transitions |
| `adjust_padding` | After — directly edits capture block in script; bypasses LLM |
| `set_pip` | After — directly edits segment type in script; bypasses LLM |

### 7.7 UI State Model — Extended

```json
{
  "selected_event_id": "evt_123",
  "hovered_event_id": null,
  "filters": { "tiers": ["S", "A"], "drivers": [] },
  "view": { "zoom": 1.0, "bucket_visibility": true },
  "llm_panel_visible": true,
  "show_transitions": true,
  "show_broll": true
}
```

### 7.8 Key Insight

This UI is a visual map of **Time (vertical) vs Importance (horizontal)**. It lets users:
- See the race structure instantly
- Understand algorithm decisions at a glance
- Edit highlights intuitively via direct manipulation

---

## 8. Data Contracts (Backend ↔ UI)

These contracts are updated from the original specification. All changes are additive — no existing fields are removed.

### 8.1 Scored Event — Extended

```json
{
  "id": "evt_123",
  "score": 8.7,
  "tier": "A",
  "bucket": "mid",
  "components": {
    "base": 1.0,
    "position": 2.0,
    "consequence": 1.5,
    "narrative_bonus": 0.35,
    "exposure_adj": 0.12,
    "user_weight": 1.0,
    "penalties": -0.8
  },
  "selected": true,
  "rejected_reason": null,
  "llm_note": "Dramatic overtake — sets the narrative arc",
  "narrative_anchor": true
}
```

### 8.2 Timeline Segment — Extended

```json
{
  "id": "seg_1",
  "type": "event",
  "event_id": "evt_123",
  "start": 1228,
  "end": 1240,
  "cars_focus": ["car_12", "car_7"],
  "score": 8.7,
  "locked": false,
  "camera": { "mode": "auto", "angle": "broadcast", "follow_driver": "car_12" },
  "capture": { "padding_before": 2.0, "padding_after": 3.0 },
  "transition_to_next": "whip",
  "notes": "Overtake into turn 3",
  "narrative_anchor": true
}
```

### 8.3 Timeline Response — Extended

```json
{
  "version": 3,
  "metadata": {
    "target_duration": 300,
    "actual_duration": 298,
    "llm_used": true,
    "validation_status": "passed"
  },
  "segments": []
}
```

### 8.4 Override Request — Unchanged

Override actions are unchanged: `force_include`, `force_exclude`, `swap`, `adjust_padding`, `set_pip`. The `event_id` or `segment_id` is the target. Overrides are stored server-side and replayed on every recompute.

---

## 9. Pseudocode — Full Updated Pipeline

### 9.1 Main Pipeline

```python
def generate_highlights(events, target_duration, weights, constraints, llm_enabled):
    # Stage 1: Score
    scored = score_events(events, weights)

    # Stage 2: Apply manual overrides (pre-LLM)
    scored = apply_overrides(scored, overrides, phase='pre')

    # Stage 3: Cluster and allocate
    clusters  = cluster_events(scored)
    buckets   = create_time_buckets(target_duration)
    must_have = select_must_have(scored)
    timeline  = allocate_must_have(must_have, buckets)
    timeline  = fill_buckets(timeline, clusters, buckets)
    timeline  = resolve_conflicts(timeline, constraints)
    timeline  = smooth_timeline(timeline, target_duration)

    # Stage 4: LLM editorial (optional)
    if llm_enabled:
        llm_result = llm_editorial_pass(timeline, race_context)
        if validate_llm_output(llm_result, timeline):
            timeline = merge_llm_annotations(timeline, llm_result)

    # Stage 5: Post-LLM overrides
    timeline = apply_overrides(timeline, overrides, phase='post')

    # Stage 6: Validate and build script
    validate_script_constraints(timeline, constraints)
    return build_composition_script(timeline)
```

### 9.2 Score Events (Extended)

```python
def score_events(events, weights):
    results = []
    for e in events:
        score = base_score(e.type)
        score *= position_multiplier(e)
        score *= position_change_multiplier(e)
        score *= (1 + consequence_score(e))  # uses speed_ms
        score += narrative_bonus(e)           # uses chain_length
        score *= exposure_adjustment(e.driver)
        score *= weights.get(e.type, 50) / 100.0
        tier = classify_tier(score)
        results.append({**e, 'score': score, 'tier': tier})
    return results
```

### 9.3 Clustering (Unchanged)

```python
def cluster_events(events, window=5.0):
    clusters = []
    current = []

    for e in sorted(events, key=lambda x: x["timestamp"]):
        if not current:
            current.append(e)
            continue
        if e["timestamp"] - current[-1]["timestamp"] < window:
            current.append(e)
        else:
            clusters.append(current)
            current = [e]

    if current:
        clusters.append(current)
    return clusters
```

### 9.4 Conflict Resolution (Extended)

```python
def resolve_conflicts(timeline, constraints):
    resolved = []
    for seg in timeline:
        conflict = find_overlap(seg, resolved)
        if not conflict:
            resolved.append(seg)
        elif share_drivers(seg, conflict):
            resolved.append(merge_clips(seg, conflict))
        elif can_use_pip(seg, conflict, constraints['pip_threshold']):
            resolved.append(make_pip(seg, conflict))
        else:
            winner = max(seg, conflict, key=lambda x: x["score"])
            replace(resolved, conflict, winner)
    return resolved
```

### 9.5 Timeline Smoothing (Extended)

```python
def smooth_timeline(timeline, target_duration):
    timeline = sort_by_time(timeline)
    timeline = enforce_spacing(timeline)
    timeline = rebalance_exposure(timeline)
    timeline = insert_broll_gaps(timeline, gap_threshold=8.0)  # NEW
    timeline = trim_to_duration(timeline, target_duration)
    return timeline
```

### 9.6 Build Composition Script (New — Replaces build_output)

```python
def build_composition_script(timeline):
    segments = []
    for i, seg in enumerate(timeline):
        # Insert transition before each segment (except first)
        if i > 0:
            segments.append(build_transition(timeline[i-1], seg))
        segments.append(build_segment(seg))

    return {
        "version": "1.0",
        "meta": build_meta(),
        "timeline": segments,
        "render": build_render_config(),
        "metadata": build_metadata(timeline)
    }
```

### 9.7 LLM Editorial Pass (New)

```python
def llm_editorial_pass(timeline, race_context):
    prompt = build_llm_prompt(timeline, race_context)
    response = anthropic_client.messages.create(
        model='claude-sonnet-4-20250514',
        max_tokens=1000,
        messages=[{'role': 'user', 'content': prompt}]
    )
    raw = response.content[0].text
    return json.loads(raw)


def validate_llm_output(llm_result, timeline):
    segment_ids = {s['id'] for s in timeline}
    for refined in llm_result.get('refined_segments', []):
        if refined['id'] not in segment_ids:
            return False
        if 'transition_to_next' in refined:
            if refined['transition_to_next'] not in VALID_TRANSITIONS:
                return False
        if 'notes' in refined and len(refined['notes']) > 200:
            return False
    return True
```

### 9.8 Exposure Tracking (Unchanged)

```python
exposure_map = {}

def update_exposure(event):
    for driver in event["cars"]:
        exposure_map[driver] = exposure_map.get(driver, 0) + event_duration(event)
```

---

## 10. Implementation Order

Given the current state (design-only, career stats service implemented), the following order is recommended:

| Phase | Work Items | Depends On |
|---|---|---|
| Phase 1: Data Layer | Implement IRacingBridge, TelemetryWriter, SQLite schema with new columns | Nothing |
| Phase 2: Event Detection | Implement all 11 detectors (IncidentDetector first, then BattleDetector with N-car extension) | Phase 1 |
| Phase 3: Scoring Engine | Implement multi-pass scoring, tier classification, bucket allocation, conflict resolution, smoothing | Phase 2 |
| Phase 4: Script Generation | Implement Video Composition Script builder and validator, transition insertion, broll gap fill | Phase 3 |
| Phase 5: LLM Layer | Implement llm_editorial_pass, validation, annotation merge | Phase 4 |
| Phase 6: API | Wire all new and updated endpoints; implement WebSocket events | Phase 3, 5 |
| Phase 7: UI | Implement all UI panels; add transition badges, broll rendering, LLM note overlays | Phase 6 |
| Phase 8: Render Engine | Implement render engine that consumes the Video Composition Script | Phase 4 |

> **Note:** Audio pipeline (music, commentary mix) is explicitly out of scope. Game audio is handled natively by the render engine. The audio block in the Video Composition Script is defined in the enhancement spec but not implemented in this system.

---

*End of Document*
