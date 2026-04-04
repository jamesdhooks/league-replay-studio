# League Replay Studio — Telemetry, Event Detection & Highlight Algorithm Analysis

> **Critical Context:** The repository is in an **early-stage design/planning state**. The only actual Python source code in `backend/` is `career_stats_service.py` and its route. All telemetry collection, event detection, and highlight generation logic exists exclusively as **detailed design specifications and code examples** embedded in `documentation/master-plan.md` (3,935 lines). All citations below refer to `documentation/master-plan.md` (abbreviated **MPD**).

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

**`_emit_telemetry()` method** (`MPD:903–947`)

#### Tick-level variables (one row per 60 Hz sample)

| iRacing Variable | Type | Description | Stored As |
|---|---|---|---|
| `ir['SessionTime']` | `float` | Seconds since session start | `race_ticks.session_time` |
| `ir['ReplayFrameNum']` | `int` | **The critical video-frame link** | `race_ticks.replay_frame` |
| `ir['SessionState']` | `int enum` | 0=Invalid…4=Racing, 5=Checkered, 6=CoolDown | `race_ticks.session_state` |
| `ir['RaceLaps']` | `int` | Leader's current lap | `race_ticks.race_laps` |
| `ir['CamCarIdx']` | `int` | Car iRacing's auto-director is watching | `race_ticks.cam_car_idx` |
| `ir['SessionFlags']` | `int` | Bitfield: yellow/green/checkered/pace car flags | `race_ticks.flags` |

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

**Also read but NOT stored in the database** (`MPD:656–657`):
- `ir['Speed']` — float, m/s — read in the design example but not persisted to any table
- `ir['RPM']` — float — read in the design example but not persisted to any table
- `ir['Lap']` — int — single-car lap (superseded by the per-car `CarIdxLap` array)

**Active car filtering** (`MPD:920–921`): Only cars where `position > 0 AND surface != -1` are stored, keeping the payload compact (typically 20–40 of the 64 possible slots).

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

**`MPD:560–624`** — Two-table normalized design in `project.db`:

#### `race_ticks` — One row per 60 Hz sample

```sql
CREATE TABLE race_ticks (
    id              INTEGER PRIMARY KEY,
    session_time    REAL    NOT NULL,
    replay_frame    INTEGER NOT NULL,   -- THE link to video timestamps
    session_state   INTEGER NOT NULL,
    race_laps       INTEGER,
    cam_car_idx     INTEGER,
    flags           INTEGER DEFAULT 0
);
CREATE INDEX idx_tick_time  ON race_ticks(session_time);
CREATE INDEX idx_tick_frame ON race_ticks(replay_frame);
```

#### `car_states` — N rows per tick (one per active car)

```sql
CREATE TABLE car_states (
    id             INTEGER PRIMARY KEY,
    tick_id        INTEGER NOT NULL REFERENCES race_ticks(id),
    car_idx        INTEGER NOT NULL,
    position       INTEGER NOT NULL,
    class_position INTEGER DEFAULT 0,
    lap            INTEGER NOT NULL,
    lap_pct        REAL    NOT NULL,
    surface        INTEGER NOT NULL,
    est_time       REAL,
    best_lap_time  REAL DEFAULT -1
);
CREATE INDEX idx_cs_tick       ON car_states(tick_id);
CREATE INDEX idx_cs_car_time   ON car_states(car_idx, tick_id);
CREATE INDEX idx_cs_surface    ON car_states(surface) WHERE surface != 3;
CREATE INDEX idx_cs_position   ON car_states(position) WHERE position > 0;
```

#### `lap_completions` — One row each time a car crosses start/finish (`MPD:604–614`)

```sql
CREATE TABLE lap_completions (
    id           INTEGER PRIMARY KEY,
    tick_id      INTEGER NOT NULL REFERENCES race_ticks(id),
    car_idx      INTEGER NOT NULL,
    lap_number   INTEGER NOT NULL,
    lap_time     REAL,
    position     INTEGER,
    UNIQUE(car_idx, lap_number)
);
CREATE INDEX idx_lc_car ON lap_completions(car_idx);
```

#### `race_events` — Output of the event detectors (`MPD:371–389`)

```sql
CREATE TABLE race_events (
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
    description           TEXT,
    auto_detected         BOOLEAN DEFAULT TRUE,
    user_modified         BOOLEAN DEFAULT FALSE,
    included_in_highlight BOOLEAN DEFAULT TRUE,
    metadata              TEXT                 -- JSON blob
);
```

**Two-pass approach** (`MPD:978–983`):
1. **Analysis Scan (1–3 min):** Replay runs at 16×; every `freeze_var_buffer_latest()` call writes one `race_ticks` row + N `car_states` rows.
2. **Event Detection (seconds):** SQL queries on the normalized tables with no iRacing connection needed; results populate `race_events`.

---

## 2. Underutilized Telemetry Data

### 2.1 Fields Being Read But Not Stored or Used

The following iRacing variables appear in the design's code examples but are **not persisted to any database table** and thus are **not available to any detector**:

| Variable | Value | Why Underutilized | Potential Use |
|---|---|---|---|
| `ir['Speed']` | `float` m/s | Mentioned in `MPD:656`; not in `_emit_telemetry()` output dict, not in any table | Crash severity scoring (high-speed → high severity), spin/lock detection, speed differential for overtake quality |
| `ir['RPM']` | `float` | Mentioned in `MPD:657`; same — not stored anywhere | Engine failure detection, standing-start analysis |
| `ir['Lap']` | `int` | Single-car lap; superseded by `CarIdxLap` array | Redundant |
| `ir['CarIdxEstTime']` | `[float]` | **Stored** in `car_states.est_time` but the `BattleDetector` recalculates gap from `lap_pct` instead of using this field | Could replace the `lap_pct × avg_lap_time` approximation with iRacing's native estimate |

### 2.2 iRacing Variables Available But Not Read At All

The following iRacing telemetry variables are available via the `irsdk` SDK but are not mentioned anywhere in the design (`MPD:640–750`):

| Variable | Description | Potential Use Cases |
|---|---|---|
| `CarIdxF2Time` | Delta time to race leader (broadcast timing) | More accurate battle/gap detection than `lap_pct × avg` |
| `CarIdxLastLapTime` | Last completed lap time per car | Lap-by-lap progression, penalty detection (unusually slow lap) |
| `CarIdxGear` | Gear per car | Contextual data |
| `CarIdxSteer` | Steering angle per car | Spin detection (combined with `surface`) |
| `CarIdxThrottle` / `CarIdxBrake` | Per-car throttle/brake inputs | Crash approach detection, braking zone incidents |
| `SessionFlags` (full bitfield) | Individual flag bits (yellow, double-yellow, pace, checkered, red) | Only the aggregate integer is stored; individual flag parsing for caution segments is not designed |
| `WeatherDeclaredWet` / `TrackTemp` | Track/weather state | Context metadata for events |
| `PitsOpen` | Whether pit lane is open | Pit strategy context |
| `RadioTransmitCarIdx` | Who is transmitting on radio | Flag moments of team communication at key events |

### 2.3 Fields Stored But Under-Exploited in Event Detection

| Field | Stored | Used By | Missing Uses |
|---|---|---|---|
| `car_states.est_time` | ✅ | None | Battle gap calculation (more accurate than `lap_pct × avg_lap_time`) |
| `car_states.class_position` | ✅ | None | Multi-class battle/overtake detection (e.g., GTD vs. GTP in IMSA events) |
| `car_states.best_lap_time` | ✅ | `FastestLapDetector` (design only) | Fastest-of-session detection, purple sector moments |
| `race_ticks.flags` | ✅ | `PaceCarDetector` (design only) | Yellow flag period detection, double-file restart detection, red flag incidents |
| `lap_completions` table | ✅ | `LapCompletionDetector` (design only) | Lap time regression (driver losing pace), consistent front-runner analysis |

### 2.4 Multi-Car Event Gaps in the Design

The `BattleDetector` only detects **two-car adjacent-position battles** (leader vs. `position + 1`, `MPD:1175–1176`). It cannot detect:
- **3-car or N-car battles** (e.g., a train of 4 cars all within 1.5s)
- **Non-adjacent position battles** (e.g., P3 chasing P1 after P2 spins)
- **Cross-class proximity incidents** (a LMP2 car catching prototype traffic)

The `IncidentDetector` uses `CamCarIdx` as a proxy, which means:
- It can only detect incidents iRacing's own auto-director notices
- Multi-car contact where the camera stays on one car misses the other participants
- `involved_drivers` in the event model supports a JSON array, but the detector only ever populates one `car_idx`

---

## 3. Event Detection — All Detectors

### 3.1 Full Detector List (`MPD:1226–1240`)

| Detector | Event Type | DB Query Pattern | Legacy Equivalent |
|---|---|---|---|
| `IncidentDetector` | `incident` | `race_ticks.cam_car_idx` change + `car_states.surface = 0` JOIN | `Incident.cs` + `RaceIncidents2()` |
| `BattleDetector` | `battle` | Self-JOIN `car_states` on adjacent positions, gap calc | `Battle.cs`, `RuleBattle.cs` |
| `OvertakeDetector` | `overtake` | `LAG(position) OVER` window on `car_states` per car_idx | (inferred from position change) |
| `PitStopDetector` | `pit_stop` | `car_states.surface IN (1, 2)` duration grouping | `RecordPitStops.cs` |
| `FastestLapDetector` | `fastest_lap` | `car_states.best_lap_time` delta between ticks | `RecordFastestLaps.cs` |
| `LeaderChangeDetector` | `leader_change` | `car_states.position = 1` car_idx change over time | (new in V2) |
| `FirstLapDetector` | `first_lap` | `race_ticks.session_state = 4 AND race_laps = 1` | `RuleFirstLapPeriod.cs` |
| `LastLapDetector` | `last_lap` | `race_ticks.race_laps >= results_laps_complete` | `RuleLastLapPeriod.cs` |
| `RestartDetector` | `restart` | `race_ticks.session_state` transition `3 → 4` | `RulePaceLaps.cs` |
| `PaceCarDetector` | `pace_car` | `race_ticks.flags` bitfield check for pace car | `RulePaceLaps.cs` |
| `LapCompletionDetector` | `lap_completion` | `lap_completions` table direct query | (new in V2) |

### 3.2 `IncidentDetector` — Full Design (`MPD:1109–1151`)

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
- Consecutive ticks with gap < threshold are merged into a single battle event
- **Minimum duration: 3 seconds** — shorter battles are discarded
- `involved_drivers` includes both `leader_idx` and `follower_idx`

**Telemetry fields used:** `position`, `lap_pct`, `surface`, `session_time`, `session_state`, `replay_frame`

### 3.4 `TelemetryWriter.write_tick()` — Database Ingestion (`MPD:1050–1102`)

```python
def write_tick(self, snapshot: dict):
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

    # Detect lap completions (lap number increases)
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

## 5. Summary: What Is Built vs. Designed

| Component | Status | Reference |
|---|---|---|
| `IRacingBridge` (telemetry connection) | ❌ Design only | `MPD:840–965` |
| SQLite schema (`race_ticks`, `car_states`, etc.) | ❌ Design only | `MPD:560–624` |
| `TelemetryWriter.write_tick()` | ❌ Design only | `MPD:1050–1102` |
| `IncidentDetector` | ❌ Design only (full code example) | `MPD:1109–1151` |
| `BattleDetector` | ❌ Design only (full code example) | `MPD:1154–1223` |
| 9 other detectors | ❌ Design only (SQL patterns listed) | `MPD:1232–1240` |
| `HighlightEditor.reprocess()` | ❌ Design only (full code example) | `MPD:2659–2714` |
| FFmpeg encoding with EDL | ❌ Design only | `MPD:1375–1388` |
| Frontend Highlight Suite components | ❌ Design only | `MPD:1823–1868` |
| `career_stats_service.py` (iRacing career stats) | ✅ Implemented | `backend/server/services/career_stats_service.py` |
| iRacing career stats API route | ✅ Implemented | `backend/server/routes/api_career_stats.py` |

> **Note on stored memories:** Previous agent memories referencing `backend/server/services/replay_analysis.py` and `backend/server/services/detectors.py` with specific line numbers are **inaccurate** — those file paths do not exist on disk. The code shown in those memories is design-specification code embedded in `documentation/master-plan.md`.
