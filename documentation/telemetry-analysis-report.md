# League Replay Studio — Telemetry, Event Detection & Highlight Algorithm Analysis

> **Status (updated):** All core telemetry, event detection, and highlight pipeline components are **fully implemented** in `backend/server/services/`. The original report described design-only status; this updated version reflects the production code. File references below cite actual implementation paths (abbreviated **IMP**) in addition to the original master-plan design specification (`documentation/master-plan.md`, abbreviated **MPD**).

---

## 1. Telemetry Gathering from iRacing

### 1.1 Connection Mechanism

**`MPD:630–670`**

iRacing exposes telemetry through a **Windows memory-mapped file** (shared memory interface) that it writes to continuously while the simulator runs — including during replay playback. The Python package `irsdk` (PyPI: `irsdk`, aka `pyirsdk`, source at `github.com/kutu/pyirsdk`) wraps this interface.

There are two data streams from the shared memory:

| Stream | Rate | Content |
|--------|------|---------|
| **Telemetry variables** | ~60 Hz | Car states, speeds, positions, flags |
| **Session info string** | On-change | YAML blob: drivers, track, camera groups |

The key gotcha: `ir.freeze_var_buffer_latest()` **must** be called before every read to atomically snapshot the latest frame and prevent partial reads mid-update (`MPD:653–654`, `MPD:968`).

### 1.2 The `IRacingBridge` Class (`MPD:845–965`)

The designed `IRacingBridge` class runs a **background polling thread** at 60 Hz:

```python
POLL_HZ = 60                          # MPD:851
time.sleep(1.0 / self.POLL_HZ)       # MPD:890
```

**Poll loop logic** (`MPD:866–890`):
1. If not connected, attempt `ir.startup()` every 2 seconds
2. Call `ir.freeze_var_buffer_latest()` — atomic snapshot
3. Check for session info changes (YAML re-parse)
4. Call `_emit_telemetry()` — build and enqueue a snapshot dict
5. Sleep 16.67 ms

**During 16× replay playback** (`MPD:972`): iRacing still emits at 60 Hz, but `ReplayFrameNum` increments at ~960 frames per real second. This means a full race is scanned in 1–3 minutes of wall time, producing a complete telemetry record.

### 1.3 Specific Telemetry Variables Read

**`_emit_telemetry()` method** (`IMP:iracing_bridge.py:481–540`, `MPD:903–947`)

#### Tick-level variables (one row per 60 Hz sample)

| iRacing Variable | Type | Description | Stored As |
|---|---|---|---|
| `ir['SessionTime']` | `float` | Seconds since session start | `race_ticks.session_time` |
| `ir['ReplayFrameNum']` | `int` | **The critical video-frame link** | `race_ticks.replay_frame` |
| `ir['SessionState']` | `int enum` | 0=Invalid…4=Racing, 5=Checkered, 6=CoolDown | `race_ticks.session_state` |
| `ir['RaceLaps']` | `int` | Leader's current lap | `race_ticks.race_laps` |
| `ir['CamCarIdx']` | `int` | Car iRacing's auto-director is watching | `race_ticks.cam_car_idx` |
| `ir['SessionFlags']` | `int` | Raw bitfield: all flag states | `race_ticks.flags` |
| `ir['SessionFlags'] & 0xC108` | derived | Yellow / caution flag active | `race_ticks.flag_yellow` (1 or 0) |
| `ir['SessionFlags'] & 0x0010` | derived | Red flag active | `race_ticks.flag_red` (1 or 0) |
| `ir['SessionFlags'] & 0x0001` | derived | Checkered flag active | `race_ticks.flag_checkered` (1 or 0) |

The flag booleans are parsed in `iracing_bridge.py` using named constants (`FLAG_CHECKERED`, `FLAG_RED`, `FLAG_YELLOW`, `FLAG_CAUTION`, `FLAG_CAUTION_WAVING`, `FLAG_YELLOW_WAVING`). The `FLAG_YELLOW_MASK` combines all yellow/caution variants.

#### Per-car array variables (one set per active car per tick)

| iRacing Variable | Type | Description | Stored As |
|---|---|---|---|
| `ir['CarIdxPosition']` | `[int]` | Race position (0 = not racing) | `car_states.position` |
| `ir['CarIdxClassPosition']` | `[int]` | Class-specific position | `car_states.class_position` |
| `ir['CarIdxLap']` | `[int]` | Current lap number | `car_states.lap` |
| `ir['CarIdxLapDistPct']` | `[float]` | Track position 0.0–1.0 | `car_states.lap_pct` |
| `ir['CarIdxTrackSurface']` | `[int]` | -1=NotInWorld, 0=OffTrack, 1=InPitStall, 2=ApproachingPits, 3=OnTrack | `car_states.surface` |
| `ir['CarIdxEstTime']` | `[float]` | Estimated gap time to leader | `car_states.est_time` |
| `ir['CarIdxBestLapTime']` | `[float]` | Personal best lap time (-1 = none) | `car_states.best_lap_time` |
| `ir['CarIdxSpeed']` | `[float]` | Per-car speed (m/s) | `car_states.speed_ms` |
| `ir['CarIdxF2Time']` | `[float]` | Broadcast delta-to-leader (s) from iRacing's live timing system | `car_states.f2_time` |
| `ir['CarIdxLastLapTime']` | `[float]` | Last completed lap time per car (-1 = none yet) | `car_states.last_lap_time` |

**Active car filtering** (`IMP:iracing_bridge.py:494–511`): Only cars where `position > 0 AND surface != -1` are stored, keeping the payload compact (typically 20–40 of the 64 possible slots).

**Speed derivation fallback** (`IMP:replay_analysis.py:106–127`): When `CarIdxSpeed` returns `None` (e.g. on older iRacing builds), `TelemetryWriter` derives speed from `lap_pct` rate-of-change × track length.

**`CarIdxF2Time` vs. `CarIdxEstTime`:** `F2Time` is iRacing's broadcast timing gap (sector-accurate, updated from the timing transponder loop), whereas `EstTime` is an extrapolation of position difference against average lap time. `F2Time` is strongly preferred for battle gap calculation; `EstTime` is a useful secondary signal and still stored.

### 1.4 Session Info (Static Data)

**`MPD:674–702`** — Parsed from YAML when the session info update counter increments:

| Field | Used For |
|---|---|
| `info['DriverInfo']['Drivers']` | Driver name ↔ car_idx mapping |
| `info['WeekendInfo']['TrackDisplayName']` | Track name display |
| `info['CameraInfo']['Groups']` | Camera group numbers for camera direction |
| `info['SessionInfo']['Sessions'][0]['ResultsLapsComplete']` | Total race laps (for `LastLapDetector`) |
| `info['SessionInfo']['Sessions'][0]['ResultsAverageLapTime']` | **Critical for gap→time conversion in `BattleDetector`** |

### 1.5 SQLite Storage Schema

**`MPD:560–624`, `IMP:analysis_db.py:24–128`** — Two-table normalized design in `project.db`:

#### `race_ticks` — One row per 60 Hz sample

```sql
CREATE TABLE IF NOT EXISTS race_ticks (
    id              INTEGER PRIMARY KEY,
    session_time    REAL    NOT NULL,
    replay_frame    INTEGER NOT NULL,   -- THE link to video timestamps
    session_state   INTEGER NOT NULL,
    race_laps       INTEGER,
    cam_car_idx     INTEGER,
    flags           INTEGER DEFAULT 0, -- raw SessionFlags bitfield
    flag_yellow     INTEGER DEFAULT 0, -- 1 when yellow/caution/caution-waving bits set
    flag_red        INTEGER DEFAULT 0, -- 1 when red flag bit set
    flag_checkered  INTEGER DEFAULT 0  -- 1 when checkered flag bit set
);
CREATE INDEX idx_tick_time  ON race_ticks(session_time);
CREATE INDEX idx_tick_frame ON race_ticks(replay_frame);
```

#### `car_states` — N rows per tick (one per active car)

```sql
CREATE TABLE IF NOT EXISTS car_states (
    id             INTEGER PRIMARY KEY,
    tick_id        INTEGER NOT NULL REFERENCES race_ticks(id),
    car_idx        INTEGER NOT NULL,
    position       INTEGER NOT NULL,
    class_position INTEGER DEFAULT 0,
    lap            INTEGER NOT NULL,
    lap_pct        REAL    NOT NULL,
    surface        INTEGER NOT NULL,
    est_time       REAL,
    best_lap_time  REAL DEFAULT -1,
    speed_ms       REAL,               -- m/s (CarIdxSpeed or derived from lap_pct rate)
    f2_time        REAL,               -- CarIdxF2Time: broadcast delta-to-leader (s)
    last_lap_time  REAL DEFAULT -1     -- CarIdxLastLapTime: last completed lap time (s)
);
```

#### `lap_completions` — One row each time a car crosses start/finish (`IMP:analysis_db.py:74–82`, `MPD:604–614`)

```sql
CREATE TABLE IF NOT EXISTS lap_completions (
    id           INTEGER PRIMARY KEY,
    tick_id      INTEGER NOT NULL REFERENCES race_ticks(id),
    car_idx      INTEGER NOT NULL,
    lap_number   INTEGER NOT NULL,
    position     INTEGER NOT NULL DEFAULT 0,
    lap_time     REAL    DEFAULT NULL  -- from CarIdxLastLapTime at the lap transition tick
);
CREATE INDEX idx_lc_car ON lap_completions(car_idx, lap_number);
```

#### `race_events` — Output of the event detectors (`IMP:analysis_db.py:55–70`, `MPD:371–389`)

```sql
CREATE TABLE IF NOT EXISTS race_events (
    id                    INTEGER PRIMARY KEY,
    event_type            TEXT NOT NULL,
    start_time_seconds    REAL NOT NULL,
    end_time_seconds      REAL NOT NULL,
    start_frame           INTEGER,
    end_frame             INTEGER,
    lap_number            INTEGER,
    severity              INTEGER DEFAULT 0,    -- 0-10 score
    involved_drivers      TEXT,                -- JSON array of car_idx
    position              INTEGER,
    auto_detected         INTEGER DEFAULT 1,
    user_modified         INTEGER DEFAULT 0,
    included_in_highlight INTEGER DEFAULT 1,
    metadata              TEXT                 -- JSON blob
);
```

**Two-pass approach** (`MPD:978–983`):
1. **Analysis Scan (1–3 min):** Replay runs at 16×; every `freeze_var_buffer_latest()` call writes one `race_ticks` row + N `car_states` rows.
2. **Event Detection (seconds):** SQL queries on the normalized tables with no iRacing connection needed; results populate `race_events`.

---

## 2. Telemetry Coverage — Current State

### 2.1 Variables Previously Underutilized — Now Addressed

| Variable | Previous State | Current State |
|---|---|---|
| `ir['CarIdxSpeed']` | Not persisted | ✅ Stored as `car_states.speed_ms`; used for incident/crash severity scoring |
| `ir['SessionFlags']` (bitfield) | Raw int stored, no parsing | ✅ Individual bits parsed: `flag_yellow`, `flag_red`, `flag_checkered` in `race_ticks`; powers `YellowFlagDetector` |
| `ir['CarIdxF2Time']` | Not read | ✅ Stored as `car_states.f2_time`; `BattleDetector` prefers it over `lap_pct × avg_lap_time` |
| `ir['CarIdxLastLapTime']` | Not read | ✅ Stored as `car_states.last_lap_time`; written to `lap_completions.lap_time` on lap transitions |
| `car_states.est_time` | Stored, unused by detectors | Still available; supplementary to `f2_time` |

### 2.2 iRacing Variables Still Not Read

The following variables remain available in the `irsdk` SDK but are not currently collected. They represent potential future enhancements:

| Variable | Description | Potential Use Cases |
|---|---|---|
| `CarIdxGear` | Gear per car | Contextual display data |
| `CarIdxSteer` | Steering angle per car | Spin/loss-of-control detection (combined with `surface`) |
| `CarIdxThrottle` / `CarIdxBrake` | Per-car throttle/brake inputs | Crash approach detection, braking zone incidents |
| `WeatherDeclaredWet` / `TrackTemp` | Track/weather state | Context metadata for events |
| `PitsOpen` | Whether pit lane is open | Pit strategy context |
| `RadioTransmitCarIdx` | Who is transmitting on radio | Correlate with key events |

### 2.3 Fields Stored and Actively Used

| Field | Stored | Used By |
|---|---|---|
| `car_states.speed_ms` | ✅ | `IncidentDetector`, `CrashDetector` (severity scaling) |
| `car_states.f2_time` | ✅ | `BattleDetector` (primary gap source) |
| `car_states.last_lap_time` | ✅ | `TelemetryWriter` (writes to `lap_completions.lap_time`) |
| `car_states.est_time` | ✅ | `CrashDetector`, `SpinoutDetector`, `CloseCallDetector` (time-loss calculation) |
| `car_states.class_position` | ✅ | Stored; multi-class detector is a future enhancement |
| `car_states.best_lap_time` | ✅ | `FastestLapDetector` |
| `race_ticks.flag_yellow` | ✅ | `YellowFlagDetector` |
| `race_ticks.flag_red` | ✅ | Stored; red flag detector is a future enhancement |
| `race_ticks.flag_checkered` | ✅ | `LastLapDetector` cross-check |
| `lap_completions.lap_time` | ✅ | Available for lap-regression analysis |

### 2.4 Multi-Car Event Handling

The `BattleDetector` now uses **union-find connected components** (`IMP:detectors.py:195–219`) to detect N-car trains, not just two-car battles. A group of 4 cars all within the gap threshold appears as a single battle event with all car indices in `involved_drivers`.

The `ContactDetector` (`IMP:detectors.py:943–1040`) addresses the report's note about multi-car off-track incidents: it groups cars that go off-track within `contact_time_window` seconds at similar `lap_pct` positions, capturing pileups that iRacing's auto-director might assign to a single car.

The `IncidentDetector` still relies on `CamCarIdx` as primary signal (matching the legacy `AnalyseRace.cs` pattern). Multi-car incidents the director doesn't focus on are captured separately by `CrashDetector` and `ContactDetector`.

---

## 3. Event Detection — All Detectors

### 3.1 Full Detector List (`IMP:detectors.py:1222–1252`, `MPD:1226–1240`)

| Detector | Event Type | Primary Detection Signal | Status |
|---|---|---|---|
| `IncidentDetector` | `incident` | `cam_car_idx` change + `surface = OffTrack` | ✅ Implemented |
| `BattleDetector` | `battle` | N-car adjacent-position chains; `f2_time` gap (falling back to `lap_pct × avg`) | ✅ Implemented |
| `OvertakeDetector` | `overtake` | `LAG(position)` window, proximity check | ✅ Implemented |
| `PitStopDetector` | `pit_stop` | `surface IN (1, 2)` duration grouping | ✅ Implemented |
| `FastestLapDetector` | `fastest_lap` | `best_lap_time` delta per car | ✅ Implemented |
| `LeaderChangeDetector` | `leader_change` | `position = 1` car_idx change | ✅ Implemented |
| `YellowFlagDetector` | `yellow_flag` | `flag_yellow = 1` sustained periods | ✅ **New** |
| `PaceLapDetector` | `pace_lap` | `session_state = PARADE` (3) | ✅ Implemented |
| `FirstLapDetector` | `first_lap` | `session_state = RACING AND race_laps ≤ 1` | ✅ Implemented |
| `LastLapDetector` | `last_lap` | `race_laps = max_lap` | ✅ Implemented |
| `CrashDetector` | `crash` | Off-track + large `est_time` increase + `speed_ms` blend | ✅ Implemented |
| `SpinoutDetector` | `spinout` | Off-track recovery with moderate time loss (2–10 s) | ✅ Implemented |
| `ContactDetector` | `contact` | Multiple cars off-track at same `lap_pct` within time window | ✅ Implemented |
| `CloseCallDetector` | `close_call` | Brief off-track + nearby car + small time loss | ✅ Implemented |

### 3.2 `IncidentDetector` — Implementation (`IMP:detectors.py:97–189`, `MPD:1109–1151`)

**How iRacing signals incidents** (`MPD:726–750`): iRacing does **not** provide a direct "incident occurred" flag. When its auto-director detects an incident, it **switches `CamCarIdx` to that car**. The detector watches for `CamCarIdx` changes to cars that are off-track.

**SQL Query:**
```sql
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
```

**Event grouping:**
- **15-second deduplication window** — consecutive off-track switches within 15s extend the same event
- **Lead-in:** `start_time = session_time - 1.0s`
- **Follow-out:** `end_time = session_time + 8.0s`

**Telemetry fields used:** `cam_car_idx`, `surface`, `session_state`, `session_time`, `replay_frame`

### 3.3 `BattleDetector` — Full Design (`MPD:1154–1223`)

**Gap calculation** (`MPD:694–702`): Converts `CarIdxLapDistPct` track-position difference into a time gap using the session's average lap time:
```python
time_gap = (car1_lap_pct - car2_lap_pct) * avg_lap_time
# avg_lap_time from session info YAML (ResultsAverageLapTime / 1e4)
```

**SQL Query:**
```sql
SELECT t.session_time, t.replay_frame,
       leader.car_idx AS leader_idx,
       follower.car_idx AS follower_idx,
       ABS(leader.lap_pct - follower.lap_pct) * ? AS gap
FROM car_states leader
JOIN car_states follower ON follower.tick_id = leader.tick_id
  AND follower.position = leader.position + 1  -- adjacent positions only
JOIN race_ticks t ON leader.tick_id = t.id
WHERE t.session_state IN (4, 5)
  AND leader.surface = 3 AND follower.surface = 3  -- both on-track
  AND leader.position > 0
  AND ABS(leader.lap_pct - follower.lap_pct) * ? < ?  -- gap < threshold
ORDER BY t.session_time
```
Default `battle_gap_seconds = 1.5`.

**Event grouping:**
- Consecutive ticks with gap < threshold are merged using N-car union-find connected components
- **Minimum duration: 10 seconds** — shorter battles are discarded
- All cars in the chain are listed in `involved_drivers`
- Severity scales with lead position and duration (4–10)

**Telemetry fields used:** `position`, `lap_pct`, `f2_time`, `surface`, `session_time`, `session_state`, `replay_frame`

**Gap calculation priority:**
1. `f2_time` (CarIdxF2Time) — iRacing's broadcast delta-to-leader; most accurate
2. `lap_pct × avg_lap_time` — approximation used as fallback when `f2_time` is NULL

### 3.4 `TelemetryWriter.write_tick()` — Database Ingestion (`IMP:replay_analysis.py:85–220`, `MPD:1050–1102`)

The writer batches ticks in groups of 100 for performance. Key fields per tick:
- `race_ticks`: `session_time`, `replay_frame`, `session_state`, `race_laps`, `cam_car_idx`, `flags`, `flag_yellow`, `flag_red`, `flag_checkered`
- `car_states`: all tick-level fields plus `speed_ms`, `f2_time`, `last_lap_time`
- `lap_completions`: written when `car.lap > prev_lap`; includes `lap_time` from `CarIdxLastLapTime`

---

## 4. Highlight Video Algorithm

### 4.1 Architecture Overview (`MPD:2564–2715`)

The "Highlight Editing Suite" is the primary differentiator of the product. Rather than a fixed algorithm, it exposes the full event selection pipeline as an **interactive, tuneable, real-time editing environment** with live metrics.

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
│  │  Last Lap    ██████████  │  │  Balance Score:   ★★★★☆            │ │
│  │  Pit Stops   ██░░░░░░░░  │  │  Pacing Score:    ★★★★★            │ │
│  │  Leader      ████░░░░░░  │  │  Driver Coverage:  78%             │ │
│  │  Fastest Lap ███░░░░░░░  │  │                                    │ │
│  │  Preferred   ██████░░░░  │  └────────────────────────────────────┘ │
│  │                          │                                          │
│  │  Min Severity: ████░░ 4  │                                          │
│  │  Target Duration: 5:00   │                                          │
│  │  [Reprocess Now]         │                                          │
│  │  [Auto-Balance]          │                                          │
│  └──────────────────────────┘                                          │
│                                                                        │
│  HIGHLIGHT TIMELINE PREVIEW                                            │
│  ║▓START▓║░░░║▓CRASH▓║░░░║▓▓BATTLE▓▓║░░║▓▓BATTLE▓▓║░░║▓FIN▓║         │
│  0:00   0:28        1:15     1:57        3:34       4:52  5:23        │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Scoring Algorithm (`MPD:2659–2714`)

**`HighlightEditor.reprocess()` — five steps:**

**Step 1 — Score all detected events** (`MPD:2673–2678`):
```python
score = event.severity * (weight / 100)
```
- `event.severity` — integer 0–10 stored in `race_events.severity`
- `weight` — per-event-type float 0–100 configured by the user
- Default weight when unconfigured: `50`

**Step 2 — Apply manual overrides** (`MPD:2680–2686`):
- `force_include = True` → event always included regardless of score
- `force_exclude = True` → event always excluded regardless of score

**Step 3 — Select events to fit target duration** (`MPD:2688–2693`):
1. Mandatory events first (`first_lap`, `last_lap`, `restart`)
2. Sort remaining events by score descending
3. Add events in order until total duration ≥ `target_duration_seconds`

**Step 4 — Compute live metrics** (`MPD:2695–2704`):

| Metric | Calculation |
|---|---|
| `total_duration` | `sum(e.duration for e in selected)` |
| `target_duration` | User-set target in seconds |
| `event_counts` | `Counter(e.event_type for e in selected)` |
| `coverage_percent` | `_compute_coverage(selected, project)` |
| `balance_score` | `_compute_balance(selected, project)` — penalizes front-loading |
| `pacing_score` | `_compute_pacing(selected)` — penalizes consecutive same-type events |
| `driver_coverage` | `_compute_driver_coverage(selected, project)` |

**Step 5 — Generate EDL** (`MPD:2706–2707`): `_generate_edl(selected)` produces an Edit Decision List ordered **chronologically in race time** (not by score).

### 4.3 Rule Weights Configuration (`MPD:2619–2624`)

| Event Type | Default Weight (from UI mockup) |
|---|---|
| `incident` | ~80 |
| `battle` | ~60 |
| `overtake` | ~50 |
| `first_lap` | 100 (mandatory) |
| `last_lap` | 100 (mandatory) |
| `pit_stop` | ~20 |
| `leader_change` | ~40 |
| `fastest_lap` | ~30 |
| Preferred cars | ~60 |

**Storage** (`MPD:493`): `project_meta.highlight_weights` — JSON blob in the SQLite project database.

**Additional controls:**
- **Min Severity Threshold** (0–10): Events below this score are auto-excluded before scoring
- **Target Duration** (seconds): Algorithm trims/extends selection to match
- **Auto-Balance**: Optimizes weights for even distribution across event types
- **Reprocess Now**: Reruns algorithm on cached SQLite data — no iRacing connection needed (milliseconds)

### 4.4 Clip Sequencing

**Sequencing logic** (`MPD:2707`, `MPD:2612`):
- Events are placed in the highlight reel in **chronological race order** — score is used purely for inclusion/exclusion, not for reordering
- Each event contributes its `[start_frame, end_frame]` range as an EDL segment
- Gaps between events are simply omitted
- The timeline preview: `║▓START▓║░░░║▓CRASH▓║░░░║▓▓BATTLE▓▓║░░║▓FIN▓║`

**FFmpeg integration** (`MPD:1375–1388`): An encoding service translates the EDL into an FFmpeg complex filtergraph. For highlights, `_build_highlight_filter(project)` assembles the concatenated segments.

### 4.5 Event Clip Window Durations

How long each event clip runs (`MPD:1139–1149` for incidents; similar patterns implied for others):

| Detector | Lead-in | Follow-out | Dedup/Min Duration |
|---|---|---|---|
| `IncidentDetector` | −1.0 s | +8.0 s | 15 s dedup window |
| `BattleDetector` | None (spans entire close-racing period) | None | Min 3 s |
| Others | Not yet specified in design | — | — |

### 4.6 API Endpoints for Highlight Suite (`MPD:2011–2018`)

```
GET  /api/projects/{id}/highlights/config        # Get current rule weights + settings
PUT  /api/projects/{id}/highlights/config        # Update rule weights + settings
POST /api/projects/{id}/highlights/reprocess     # Reprocess → returns updated selection + metrics
POST /api/projects/{id}/highlights/configs/save  # Save a named weight configuration
```

**WebSocket events** (`MPD:1906–1907`):
```
highlight:reprocessed     # Complete reprocessing done (new selection + metrics)
highlight:metrics_update  # Live metrics update during editing
```

---

## 5. Summary: Implementation Status

| Component | Status | Reference |
|---|---|---|
| `IRacingBridge` (telemetry connection, 60 Hz poll loop) | ✅ Implemented | `backend/server/services/iracing_bridge.py` |
| `SessionFlags` bitfield parsing → `flag_yellow/red/checkered` | ✅ Implemented | `iracing_bridge.py:43–57` |
| `CarIdxF2Time` (broadcast gap) collection | ✅ Implemented | `iracing_bridge.py:_emit_telemetry` |
| `CarIdxLastLapTime` collection | ✅ Implemented | `iracing_bridge.py:_emit_telemetry` |
| `CarIdxSpeed` collection | ✅ Implemented | `iracing_bridge.py:_emit_telemetry` |
| SQLite schema (`race_ticks`, `car_states`, `lap_completions`, `race_events`) | ✅ Implemented | `backend/server/services/analysis_db.py` |
| `car_states.f2_time` column | ✅ Implemented | `analysis_db.py:51` |
| `car_states.last_lap_time` column | ✅ Implemented | `analysis_db.py:52` |
| `lap_completions.lap_time` column | ✅ Implemented | `analysis_db.py:80` |
| `TelemetryWriter.write_tick()` (batch SQLite ingest) | ✅ Implemented | `backend/server/services/replay_analysis.py` |
| `ReplayAnalyzer` (two-pass scan+detect) | ✅ Implemented | `replay_analysis.py` |
| `IncidentDetector` | ✅ Implemented | `backend/server/services/detectors.py:97` |
| `BattleDetector` (N-car chains, f2_time gap) | ✅ Implemented | `detectors.py:222` |
| `OvertakeDetector` | ✅ Implemented | `detectors.py:347` |
| `PitStopDetector` | ✅ Implemented | `detectors.py:452` |
| `FastestLapDetector` | ✅ Implemented | `detectors.py:529` |
| `LeaderChangeDetector` | ✅ Implemented | `detectors.py:596` |
| `YellowFlagDetector` | ✅ Implemented | `detectors.py:1222` |
| `PaceLapDetector` | ✅ Implemented | `detectors.py:1161` |
| `FirstLapDetector` | ✅ Implemented | `detectors.py:651` |
| `LastLapDetector` | ✅ Implemented | `detectors.py:690` |
| `CrashDetector` | ✅ Implemented | `detectors.py:742` |
| `SpinoutDetector` | ✅ Implemented | `detectors.py:858` |
| `ContactDetector` | ✅ Implemented | `detectors.py:943` |
| `CloseCallDetector` | ✅ Implemented | `detectors.py:1045` |
| `scoring_engine.py` (highlight scoring) | ✅ Implemented | `backend/server/services/scoring_engine.py` |
| `encoding_service.py` (FFmpeg EDL) | ✅ Implemented | `backend/server/services/encoding_service.py` |
| Frontend Highlight Suite (`HighlightPanel`, `HighlightHistogram`) | ✅ Implemented | `frontend/src/components/highlights/` |
| `career_stats_service.py` (iRacing career stats) | ✅ Implemented | `backend/server/services/career_stats_service.py` |
