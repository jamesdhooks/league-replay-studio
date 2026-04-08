# Deep Comparative Analysis: iRacingReplayDirector vs. League Replay Studio

> Generated: April 7, 2026  
> Scope: Replay construction algorithms (battle/incident detection, camera selection, event scoring, timeline allocation) with full tunable parameter inventory.

---

## 1. Fundamental Architectural Philosophy

The two systems solve different problems with fundamentally different execution models.

### 1.1 iRacingReplayDirector (iRD) — Real-Time Direction Engine

iRD runs **concurrently with replay playback**. While iRacing plays back the race, iRD polls telemetry at real-time frequency and issues live camera-switch API calls (`iRacing.Replay.CameraOnDriver(...)`) frame-by-frame. It is a **reactive director**: it does not plan ahead, it only knows the current moment and acts accordingly.

```
[iRacing Replay Playing] → [iRD polls telemetry in real-time]
    → [per-frame: evaluate priority rule stack]
        → [issue CameraOnDriver API call]
            → [OBS/capture records whatever iRacing displays]
```

### 1.2 League Replay Studio (LRS) — Post-Race Batch Analysis + Declarative Scripting

LRS runs in **two entirely separate passes**, neither of which is concurrent with live replay playback. The replay is rewound to the start, driven at 16× speed with the camera locked, and telemetry is written to SQLite. Then analysis runs entirely offline on the database. The result is a **Video Composition Script** — a declarative JSON document describing exactly what to capture. A separate capture engine then executes the script.

```
[Replay Scrubbed at 16×, locked camera] → [SQLite populated]
    → [Detectors run SQL queries offline]
        → [8-stage scoring pipeline]
            → [Timeline allocation + conflict resolution]
                → [Video Composition Script generated]
                    → [Capture engine executes script clip-by-clip]
```

**Primary consequence**: iRD's algorithm must work within the computational budget of one replay frame (~16ms); LRS can spend unlimited time on analysis because it's pure offline computation.

---

## 2. Event Detection Algorithms

### 2.1 Incident/Crash Detection

Both systems use the same core heuristic: **iRacing's own auto-director camera switch landing on an off-track car** is the incident signal. This is the elegant insight — iRacing has its own incident detection, and the replays already tell you which frame iRacing considered worth watching.

**iRD approach** (`Phases/Analysis/Incident.cs`):
- Runs a **pre-scan phase** before playback begins: drives the replay at speed through the entire race, checking `CamCar.TrackSurface`; when the camera car goes off-track, notes `StartSessionTime - 1s` to `StartSessionTime + 8s`
- Deduplication window: **15 seconds** per car — subsequent incidents within 15s extend `EndSessionTime` rather than creating new events
- Filters: pits/approaching-pits/not-in-world surface values are excluded
- If `FocusOnPreferedDriver` is on, only logs incidents of preferred drivers
- Severity: **not computed** — iRD has no severity concept; incidents are binary present/absent

**LRS approach** (`backend/server/services/detectors.py` — `IncidentDetector`):
- SQL query using `LAG(cam_car_idx)` window function to find ticks where the camera switched AND the new target car has `surface = SURFACE_OFF_TRACK`
- Identical deduplication: **15-second** dedup window per car, extends existing event
- Lead-in: **2 seconds** before camera switch; follow-out: **8 seconds** after
- Speed-based severity: `severity = round(min(speed_ms / 70.0, 1.0) * 10)` — uses telemetry-derived speed captured during the scan pass; falls back to severity=6 if no speed data

**Key difference on crashes**: LRS goes further and adds `CrashDetector` and `SpinoutDetector` as separate classes that measure **time loss during the off-track excursion** (`est_time_after - est_time_before`). iRD has no equivalent — an incident is an incident regardless of whether it was a light brush with the grass or a total writeoff.

**iRD tunable parameters for incidents:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `DisableIncidentsSearch` | bool | false | Disable all incident tracking |
| `IgnoreIncidentsBelowPosition` | int | (UI-set) | Position floor for `ruleLimitedIncident` |
| `IgnoreIncidentsDuringRaceStart` | bool | false | Keep camera on leader during first-lap incidents |
| `IncidentScanWait` | int | (UI-set) | Samples to wait when repositioning replay during pre-scan |
| `FocusOnPreferedDriver` | bool | false | Only log incidents for preferred drivers |

**LRS tunable parameters for incidents:**

| Parameter | Location | Default | Description |
|---|---|---|---|
| `DEDUP_SECONDS` | `IncidentDetector` class const | `15.0` | Deduplication window (seconds) |
| `LEAD_IN` | `IncidentDetector` class const | `2.0` | Pre-incident context (seconds) |
| `FOLLOW_OUT` | `IncidentDetector` class const | `8.0` | Post-incident duration (seconds) |
| `REFERENCE_SPEED_MS` | module constant | `70.0` | Speed at which severity=10 (~250 km/h) |
| `crash_min_time_loss` | `session_info` / `RedetectRequest` | `10.0` | Minimum time loss (seconds) to classify as crash |
| `crash_min_off_track_duration` | `session_info` / `RedetectRequest` | `3.0` | Minimum off-track duration (seconds) for crash |
| `GAP_TOLERANCE` | `CrashDetector` class const | `3.0` | Max on-track blip gap (s) before splitting crash windows |
| `DEDUP_SECONDS` | `CrashDetector` class const | `20.0` | Crash-specific dedup window |
| `LEAD_IN` | `CrashDetector` class const | `3.0` | Pre-crash context (seconds) |
| `FOLLOW_OUT` | `CrashDetector` class const | `10.0` | Post-crash follow duration (seconds) |

---

### 2.2 Battle Detection

This is the greatest algorithmic divergence between the two systems.

**iRD approach** (`Phases/Direction/Support/Battle.cs`):

Uses `CarIdxDistance[]` — iRacing's total accumulated track distance per car. The algorithm:
1. Filter to on-track cars (`surface == OnTrack`), skip index 0, must have `Distance > 0`
2. Sort descending by distance — positions them in track order
3. Compute adjacent gaps: `distances[i-1].Distance - distances[i].Distance`
4. Convert to time: `gap_laps × ResultsAverageLapTime`
5. Filter to gaps `< battleGap` (default ~1.0 second)
6. If `FocusOnPreferedDriver`: filter to battles involving preferred drivers only; else sort preferred first then by position
7. **Probabilistic selection using geometric decay**: for N battles, compute weights `factor^1, factor^2, ...factor^N`, normalize to 100, then pick by random float. Battles at P1/P2 are exponentially more likely to be selected than battles at P10/P11 when `factor > 1.0`
8. Returns ONE battle to follow

The critical limitation: iRD tracks **exactly one battle at a time**. When it's already in a battle, it calls `IsInBattle()` to check whether that specific pair is still within `battleGap`.

```csharp
// Geometric factor bias toward front-of-field battles:
var factors = Enumerable.Range(1, r.Count()).Select(index => Math.Pow(factor, index)).ToArray();
```

**LRS approach** (`backend/server/services/detectors.py` — `BattleDetector`):

Uses `cont_dist = lap + lap_pct` — a continuous monotonic track position. The algorithm:
1. Load every racing tick, group by timestamp
2. Sort each tick's cars by `cont_dist` descending
3. For each adjacent pair, compute gap in `cont_dist` units → convert to time via `gap_laps = gap_threshold / avg_lap_time`
4. Maintain `active[pair]` dictionary — **one independent window per (ahead_idx, behind_idx) pair simultaneously**
5. Close a pair's window if it hasn't been close for `MERGE_GAP` seconds
6. Track lead changes per pair and minimum gap per pair within each window
7. For battles longer than `MAX_SEGMENT` (45s): extract sub-segments around lead changes (padded by `SEGMENT_PAD` = 8s), or around the tightest gap point
8. All battles above `MIN_DURATION` (10s) become scored events

**Key differences:**

| Aspect | iRD | LRS |
|---|---|---|
| Simultaneous battles | 1 (exclusive) | N independent pairs |
| Selection method | Probabilistic dice roll per frame | Deterministic offline scoring pipeline |
| Position metric | `CarIdxDistance` (always current) | `cont_dist = lap + lap_pct` (always current in scan) |
| Lead change handling | Swaps focus immediately to new leader | Tracked as metadata, boosts segment score |
| Chain detection | NOT supported (only adjacent pairs) | Via `_find_chains()` union-find on qualifying pairs |
| Long battle handling | Follows indefinitely (sticky period) | Split into segments capped at 45s |

**iRD tunable parameters for battles:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `BattleGap` | TimeSpan | ~1.0s | Time gap threshold to detect a battle |
| `BattleStickyPeriod` | TimeSpan | (UI-set) | How long to stay on a battle after it technically ends |
| `BattleFactor2` | double | ~1.5 | Geometric bias toward front-of-field (1.0=uniform, 2.0=strong front bias) |
| `CameraStickyPeriod` | TimeSpan | (UI-set) | Minimum time between battle camera angle switches |
| `FocusOnPreferedDriver` | bool | false | Restrict to battles involving preferred drivers only |
| `PreferredDriverNames` | string | "" | Comma-separated preferred driver names |

**LRS tunable parameters for battles:**

| Parameter | Location | Default | Description |
|---|---|---|---|
| `battle_gap_threshold` | `session_info` / `RedetectRequest` | `0.5` | Gap in seconds — adjacent cars closer than this are in battle |
| `avg_lap_time` | `session_info` | `90.0` | Used to convert lap fraction gap to time gap |
| `battle_sticky_period` | `session_info` | `120` | Passed into `_extract_segments` context |
| `MIN_DURATION` | `BattleDetector` class const | `10.0` | Minimum battle duration (s) to emit as event |
| `MERGE_GAP` | `BattleDetector` class const | `5.0` | Seconds out-of-proximity before pair's window closes |
| `MAX_SEGMENT` | `BattleDetector` class const | `45.0` | Max seconds for a single battle segment |
| `SEGMENT_PAD` | `BattleDetector` class const | `8.0` | Context seconds before/after a lead change in extracted segments |

---

### 2.3 Overtake Detection

**iRD**: Does **not have an explicit overtake detector**. Overtakes are inferred implicitly inside `RuleBattle.UpdateCameraIfOvertake()` when `BattlersHaveSwappedPositions()` returns true — measured by iRacing's `Position` field (S/F-line-updated only). Not stored; just extends `battleEndTime` and swaps leader/follower roles.

**LRS** (`OvertakeDetector`):
- Detects `cont_dist` rank inversions between adjacent cars within `PROXIMITY_LAPS` (0.06 laps ≈ 5.4s on a 90s lap)
- Binary-searches off-track timestamp arrays to classify each overtake as clean vs crash-caused (within `CRASH_WINDOW` = 5s of the overtaken car going off)
- Crash-caused overtakes: severity reduced by 3 points
- Deduplication per pair: 10 seconds

**LRS tunable parameters for overtakes:**

| Parameter | Location | Default | Description |
|---|---|---|---|
| `PROXIMITY_LAPS` | class const | `0.06` | Max gap (lap fraction) to count as genuine on-track pass |
| `LEAD_IN` | class const | `2.0` | Context before crossing moment (seconds) |
| `DEDUP_SECONDS` | class const | `10.0` | Deduplication per pair (seconds) |
| `CRASH_WINDOW` | class const | `5.0` | Window to check if overtaken car was off-track (seconds) |

---

### 2.4 Race Phase Rules (First Lap, Last Lap, Pace Car)

**iRD `RuleFirstLapPeriod`:**
- Activates from `SessionState == Racing` until `raceStartTime + FollowLeaderAtRaceStartPeriod`
- Re-selects the track leader every **1.5 seconds** (hardcoded)
- Skips pitted cars while in `InterestState.FirstLap`
- Can be vetoed by `ruleUnlimitedIncident` (configurable via `IgnoreIncidentsDuringRaceStart`)
- Tunable: `FollowLeaderAtRaceStartPeriod`

**LRS `FirstLapDetector`:**
- Marks the entire first racing lap's time window as a `first_lap` event with `severity=6`
- Not a camera-direction rule; scoring engine treats first-lap events with base score `1.3`
- No specific leader-follow camera logic

**iRD `RuleLastLapPeriod`:**
- Activates from `trackLeaderFrom = ResultsAverageLapTime - FollowLeaderBeforeRaceEndPeriod` seconds into the final lap
- `SwitchToFinishingDrivers()`: tracks each car as it crosses the finish; waits **2 seconds** (scaled by `AppliedTimingFactor`) before moving to the next unfinished car
- Before leader finishes: follows by position rank; after: follows by `DistancePercentage` descending (car closest to finish)
- Highest priority rule — nothing overrides it
- Tunable: `FollowLeaderBeforeRaceEndPeriod`

**LRS `LastLapDetector`:**
- Marks the final lap as a `last_lap` event with `severity=6`
- No per-finisher tracking logic
- `race_results` section of the Video Composition Script covers podium/results

**iRD `RulePaceLaps`:**
- Activates when `UnderPaceCar` flag is true; cameras to P1 using `RaceStartCameraNumber`
- On yellow-to-green: stays active for hardcoded **20 seconds** (`RestartStickyTime`)
- During yellow: immediately stops any ongoing battle (`battleMarker.Stop()`)
- Tunable: None (20s is hardcoded)

**LRS**: No dedicated pace lap rule — handled implicitly via `pace_lap` event type with base score `0.4` (lowest). `restart` is mandatory (always included).

---

## 3. Camera Selection Algorithms

### 3.1 iRD — Per-Track Weighted Random

iRD has an explicit per-track camera library (`TrackCameras.cs`). Each track has a list of `TrackCamera` entries:

| Field | Purpose |
|---|---|
| `TrackName` | Track this config applies to |
| `CameraName` | iRacing camera group name (must match exactly) |
| `Ratio` | Weighted random probability |
| `IsRaceStart` | Use for race start / leader tracking |
| `IsIncident` | Use for incidents |
| `IsLastLap` | Use for final lap / finishers |
| `CameraAngle` | `LookingInfrontOfCar / LookingBehindCar / LookingAtCar / LookingAtTrack` |

`FindACamera(angles[], adjustedCamera, adjustRatioBy)` does weighted random selection:
1. Filter cameras matching any of the requested `CameraAngle` values
2. Sum `Ratio` values (if `adjustedCamera` != null, divide its ratio by `adjustRatioBy` to reduce repeat probability)
3. Pick random integer `[0, total)`; linear scan selects winner

**Battle camera choreography:**
- On battle start (establishing shot) → only `LookingAtCar`
- During battle → `[LookingInfrontOfCar, LookingBehindCar, LookingAtCar]`
- If `LookingBehindCar` is selected → switches camera target from follower to **leader** (creates "being chased" appearance from the ahead car)
- Camera changes only when `cameraChangeTime` elapses (= `cameraStickyPeriod`)

Hardcoded camera → angle mappings:
```
"Nose", "Roll Bar", "LF/RF Susp", "Gyro", "Cockpit", "Chase" → LookingInfrontOfCar
"Gearbox", "LR/RR Susp", "Rear Chase"                        → LookingBehindCar
"Blimp", "Chopper", "TV1/2/3", "Far Chase", "Blimp"          → LookingAtCar
"Pit Lane", "Pit Lane 2"                                      → LookingAtTrack
```

**Tunable camera parameters:**

| Parameter | Description |
|---|---|
| Per-camera `Ratio` | Relative probability weight (0 = never selected) |
| Per-camera `IsRaceStart/IsIncident/IsLastLap` | Designate camera for specific phases |
| Per-camera `CameraAngle` (override) | Override the hardcoded angle mapping |
| `adjustRatioBy` | Anti-repeat divisor (hardcoded to 2 in `FindACamera` calls) |

### 3.2 LRS — Declarative Preference Lists

LRS does not make real-time camera decisions. Each script segment carries `camera_preferences` — an ordered list of iRacing camera group names tried in order until one is found.

```python
TV_CAM_PREFERENCES = {
    "intro":              ["Scenic", "TV Static", "TV1", "Blimp", "Pit Lane"],
    "qualifying_results": ["Pit Lane", "TV Static", "TV1", "Scenic"],
    "race_results":       ["TV Static", "TV1", "Pit Lane", "Scenic", "Blimp"],
    "gap_filler":         ["TV Static", "TV1", "Scenic"],
}
```

For race event segments (battles, incidents, etc.), camera selection is the capture engine's responsibility. No battle-specific camera choreography exists in the scoring engine.

---

## 4. Rule Priority / Conflict Resolution

### 4.1 iRD — Priority Stack with Veto Chains

```
Priority Order (highest → lowest):
1. RuleLastLapPeriod                       — ALWAYS overrides everything
2. RuleFirstLapPeriod (+/- incident veto)
3. RulePaceLaps.WithVeto(UnlimitedIncident.WithVeto(LastSectors))
4. RuleBattle.WithVeto(LimitedIncident.WithVeto(LastSectors))
5. RuleUnlimitedIncident.WithVeto(LastSectors)
6. RuleRandom.WithVeto(LastSectors)
```

The veto mechanism: when `vetoRule.IsActive()` returns true, the outer rule is bypassed. When the veto releases, `mainRule.Redirect()` re-establishes context (e.g., re-locks camera to the battle car that was interrupted).

Two incident rule instances:
- `ruleUnlimitedIncident` — all positions, higher priority
- `ruleLimitedIncident` — position ≥ `IgnoreIncidentsBelowPosition`, lower priority (used as battle veto)

### 4.2 LRS — Scoring-Based Conflict Resolution

```
resolve_conflicts() rules:
1. Overlapping events sharing drivers → merge into single extended clip
2. Both events score ≥ pip_threshold (default 7.0) → Picture-in-Picture
3. Otherwise → keep the higher-scored event
```

No equivalent of iRD's "battle interrupted by incident, then returned to battle" (`Redirect()`) mechanic.

**Smoothing pass** (Pass 3): removes back-to-back same-type events where score differential ≤ `max(score_range * 0.15, 0.5)`, unless removing would drop below target duration.

---

## 5. The Scoring System: iRD vs LRS

iRD has **no scoring system**. Selection is binary: rule active/inactive, priority stack order, and within battles a probabilistic dice roll biased by `BattleFactor2`.

LRS has an **8-stage continuous scoring pipeline**:

| Stage | Formula | Tunable? |
|---|---|---|
| 1 | `score = BASE_SCORES[event_type]` | Yes — per-type base scores |
| 2 | `score *= pos_mult` (2.0/1.5/1.0 for P1-3/P4-10/P11+) | Yes — thresholds and multipliers |
| 3 | `score *= (1 + abs(position_delta) * 0.3)` | Yes — coefficient 0.3 |
| 4 | `score *= (1 + consequence)` where consequence = `positions_lost×0.3 + damage_severity×0.4 + race_impact×0.3` | Yes — three component weights |
| 5 | `score += log(chain_length+1)×0.5` + `score *= 1.2` if race_pct > 0.9 | Yes — coefficient and threshold |
| 6 | `score *= clamp(1 + (target_exposure - actual_exposure)×0.5, 0.5, 2.0)` | Yes — sensitivity and clamps |
| 7 | `score *= user_weight / 100` | Yes — per-type UI sliders |
| 8 | Normalize to 0.5–10, classify S/A/B/C | Yes — tier thresholds |

**All tunable scoring constants:**

| Constant | Default | File | Description |
|---|---|---|---|
| `BASE_SCORES["crash"]` | 1.5 | `scoring_engine.py` | Base score for crash events |
| `BASE_SCORES["incident"]` | 1.5 | `scoring_engine.py` | Base score for incident events |
| `BASE_SCORES["battle"]` | 1.3 | `scoring_engine.py` | Base score for battle events |
| `BASE_SCORES["spinout"]` | 1.2 | `scoring_engine.py` | Base score for spinout events |
| `BASE_SCORES["contact"]` | 1.2 | `scoring_engine.py` | Base score for contact events |
| `BASE_SCORES["first_lap"]` | 1.3 | `scoring_engine.py` | Base score for first lap |
| `BASE_SCORES["last_lap"]` | 1.3 | `scoring_engine.py` | Base score for last lap |
| `BASE_SCORES["overtake"]` | 1.0 | `scoring_engine.py` | Base score for overtake |
| `BASE_SCORES["leader_change"]` | 0.9 | `scoring_engine.py` | Base score for leader change |
| `BASE_SCORES["close_call"]` | 0.8 | `scoring_engine.py` | Base score for near-miss |
| `BASE_SCORES["fastest_lap"]` | 0.7 | `scoring_engine.py` | Base score for fastest lap |
| `BASE_SCORES["pit_stop"]` | 0.5 | `scoring_engine.py` | Base score for pit stop |
| `BASE_SCORES["pace_lap"]` | 0.4 | `scoring_engine.py` | Base score for pace lap |
| `TIER_S_THRESHOLD` | 9.0 | `scoring_engine.py` | Normalized score ≥ this → Tier S |
| `TIER_A_THRESHOLD` | 7.0 | `scoring_engine.py` | Normalized score ≥ this → Tier A |
| `TIER_B_THRESHOLD` | 5.0 | `scoring_engine.py` | Normalized score ≥ this → Tier B |
| `REFERENCE_SPEED_MS` | 70.0 | `scoring_engine.py` | Speed for severity=10 (~250 km/h) |
| `MANDATORY_TYPES` | race_start, race_finish, restart | `scoring_engine.py` | Always force-included |
| Stage 2: P1-3 multiplier | 2.0 | `scoring_engine.py` | Position importance for podium |
| Stage 2: P4-10 multiplier | 1.5 | `scoring_engine.py` | Position importance for top-10 |
| Stage 2: P11+ multiplier | 1.0 | `scoring_engine.py` | No bonus outside top 10 |
| Stage 3: delta coefficient | 0.3 | `scoring_engine.py` | Per-position-changed multiplier |
| Stage 4: positions_lost weight | 0.3 | `scoring_engine.py` | Consequence weight |
| Stage 4: damage_severity weight | 0.4 | `scoring_engine.py` | Consequence weight |
| Stage 4: race_impact weight | 0.3 | `scoring_engine.py` | Consequence weight |
| Stage 5: battle chain coefficient | 0.5 | `scoring_engine.py` | `log(chain_length+1) × 0.5` |
| Stage 5: late-race threshold | 0.9 | `scoring_engine.py` | Race fraction above which 20% boost applies |
| Stage 5: late-race multiplier | 1.2 | `scoring_engine.py` | Score boost for last-10% events |
| Stage 6: exposure clamp min | 0.5 | `scoring_engine.py` | Minimum exposure adjustment |
| Stage 6: exposure clamp max | 2.0 | `scoring_engine.py` | Maximum exposure adjustment |
| Stage 6: exposure sensitivity | 0.5 | `scoring_engine.py` | Coefficient for exposure adjustment |
| `DEFAULT_PIP_THRESHOLD` | 7.0 | `scoring_engine.py` | Score above which PIP is enabled |

---

## 6. Timeline Allocation and B-Roll

iRD has no timeline allocation — it captures everything in real time.

LRS has an explicit multi-pass timeline budget system.

**Bucket boundaries (fraction of total race):**

| Bucket | Range | Budget |
|---|---|---|
| `intro` | 0%–15% | 15% of target duration |
| `early` | 15%–40% | 25% of target duration |
| `mid` | 40%–70% | 30% of target duration |
| `late` | 70%–100% | 30% of target duration |

**B-roll and transitions:**

| Constant | Default | Description |
|---|---|---|
| `BROLL_GAP_THRESHOLD` | 8.0s | Timeline gap ≥ this gets a B-roll filler |
| Transition: gap < 3s | `"cut"` | Hard cut |
| Transition: gap ≥ 3s | `"crossfade"` | Crossfade |
| `DEFAULT_CLIP_PADDING` | 0.5s | Pre-roll before each clip (trimmed after capture) |

**Video Composition sections:**

| Section | Default Duration | Camera Preference Order |
|---|---|---|
| `intro` | 10s | Scenic → TV Static → TV1 → Blimp → Pit Lane |
| `qualifying_results` | 15s | Pit Lane → TV Static → TV1 → Scenic |
| `race_results` | 20s | TV Static → TV1 → Pit Lane → Scenic → Blimp |
| `gap_filler` | (gap duration) | TV Static → TV1 → Scenic |

---

## 7. The LLM Editorial Layer (LRS-Only)

iRD has no editorial intelligence layer. LRS has an optional post-scoring `EditorialSkill`:

| Action | Effect |
|---|---|
| `add_note` | Attaches editorial commentary to a segment |
| `set_transition` | Sets `transition_type` (`cut/fade/crossfade/whip/zoom`) |
| `flag_anchor` | Marks segment as a narrative turning point |
| `swap_with` | Swaps two same-tier segments for better storytelling |

---

## 8. Summary Comparison Table

| Aspect | iRacingReplayDirector | League Replay Studio |
|---|---|---|
| **Execution model** | Real-time, concurrent with replay | Two-pass: batch scan + offline analysis |
| **Decision timing** | Per replay frame (~16ms budget) | Unlimited (offline computation) |
| **Battle tracking** | 1 active battle at a time | All pairs simultaneously |
| **Battle selection** | Probabilistic dice roll | Deterministic scoring pipeline |
| **Front-of-field bias** | Geometric `BattleFactor` | Stage 2 position multiplier |
| **Incident detection** | Pre-scan + real-time filter | Offline SQL via cam-switch heuristic |
| **Severity system** | None (binary present/absent) | 8-stage numeric pipeline → 0.5–10 score |
| **Overtake detection** | Implicit in battle state machine | Dedicated detector, crash-filtered |
| **Position accuracy** | `CarIdxPosition` (S/F-line only) | `cont_dist = lap + lap_pct` (continuous) |
| **Camera selection** | Weighted random per track config | Declarative preference lists per section |
| **Battle camera choreography** | Establishing shot → angle cycling → reverse tricks | Not specified in scoring engine |
| **Priority resolution** | Ordered rule stack + veto chains | Numeric score comparison + PIP |
| **Timeline budget** | No concept | 4-bucket proportional fill |
| **B-roll / gaps** | N/A | Auto-inserted at gaps ≥ 8s |
| **Driver exposure balance** | None | Stage 6 exposure adjustment |
| **Preferred drivers** | Hard preference + exclusive mode | Score bias only via user weights |
| **Pace car / yellow** | Dedicated `RulePaceLaps` rule (20s sticky) | `pace_lap` event type (base score 0.4) |
| **LLM editorial** | None | `EditorialSkill` post-processing |
| **Track-specific tuning** | Yes (per-track camera ratios) | No (section-level camera prefs only) |
| **Crash vs incident** | No distinction | Separate `CrashDetector` / `SpinoutDetector` |
| **Multi-car chain detection** | Not supported | Union-find chain detection |

---

## 9. What iRD Does Better — Adaptation Recommendations

### 9.1 Battle Camera Choreography
**iRD's approach**: When a battle starts, always use `LookingAtCar` (establishing shot). During the battle, cycle through `[LookingInfrontOfCar, LookingBehindCar, LookingAtCar]` randomly. When `LookingBehindCar` is selected, switch the camera target to the **leader** instead of the follower — the rear-view of the ahead car creates the impression of being chased.

**Recommendation**: Add `camera_choreography` hints to battle event segments in the Video Composition Script. At minimum: `establishing_angle: "LookingAtCar"`, `battle_angles: ["LookingInfrontOfCar", "LookingBehindCar", "LookingAtCar"]`, `reverse_view_on_behind: true`.

### 9.2 Redirect Mechanic (Return-to-Battle After Interruption)
**iRD's approach**: When a veto (incident) releases, `Redirect()` smoothly returns camera focus to the battle driver that was being followed, rather than cold-starting from scratch.

**Recommendation**: In the conflict resolution and PIP pipeline, when a higher-priority event ends and the battle is still ongoing, prefer appending a continuation segment for the battle pair rather than leaving a gap.

### 9.3 Per-Finisher Last-Lap Tracking
**iRD's approach**: `SwitchToFinishingDrivers()` tracks each car as it crosses the line. It waits 2 seconds per finisher, cycles to the next un-finished car. After the leader finishes, it follows by `DistancePercentage` (closest to the line next).

**Recommendation**: The `LastLapDetector` currently marks the whole lap as one blob. A `FinisherSequenceDetector` or enhanced `LastLapDetector` that emits discrete per-finisher clip events would improve race-end production value significantly.

### 9.4 Pace Car / Yellow Flag Handling
**iRD's approach**: Dedicated `RulePaceLaps` rule detects the `UnderPaceCar` flag, locks camera to P1, and after returning to green holds for **20 seconds** before releasing to normal direction rules.

**Recommendation**: Add a `PaceCarDetector` that detects yellow/SC periods from session flags, marks them explicitly in the timeline, and either a) excludes them from the highlight (they're usually boring), or b) captures a short insert of the field under yellow for context. The 20-second post-restart "follow leader" window is also worth implementing as a camera hint on restart events.

### 9.5 Front-of-Field Battle Factor (Probabilistic Tuning)
**iRD's approach**: `BattleFactor2` (default ~1.5) applies geometric decay so P1/P2 battles are `1.5×` more likely than P2/P3, which are `1.5×` more likely than P3/P4, etc. This is user-tunable. At `1.0`, all battles are equally likely; at `2.0`, field battles almost never appear.

**Recommendation**: LRS already has Stage 2 position multiplier (2.0/1.5/1.0). But it's not user-tunable for the *battle selection* weighting specifically. A `battleFrontBias` parameter (analogous to `BattleFactor2`) that modulates the Stage 2 multiplier specifically for battle events would give operators the same control.

### 9.6 Exclusive Preferred-Driver Mode
**iRD's approach**: `FocusOnPreferedDriver = true` excludes all events not involving preferred drivers. This is an **exclusive** mode, not just a boost.

**Recommendation**: LRS currently has `preferredDriverBoost` (score multiplier). Add a `preferredDriversOnly` boolean that, when enabled, excludes all events where no preferred driver is in `involved_drivers`. This is a significant production use case (covering a specific driver's race).

### 9.7 Ignore Incidents During Race Start
**iRD**: `IgnoreIncidentsDuringRaceStart` bool keeps the camera locked on the leader during the `FollowLeaderAtRaceStartPeriod`, ignoring any incidents in the field.

**Recommendation**: Add to the tuning panel as a toggle. Implement in scoring by suppressing incidents that occur during the first-lap bucket if enabled.

---

## 10. Configuration Gaps — Parameters to Expose in Replay Tuning

### 10.1 Currently in `DEFAULT_PARAMS` but NOT Rendered in UI

| Parameter | Default | Where Used | Recommended UI |
|---|---|---|---|
| `battleGap` | `1.0` | Sent to backend but not a slider | Slider: 0.3–3.0s, step 0.1, "Battle Gap" |
| `firstLapWeight` | `1.0` | Exists in DEFAULT_PARAMS, no slider | Slider: 0.5–3.0×, step 0.1, "First Lap Boost" |
| `lastLapWeight` | `1.0` | Exists in DEFAULT_PARAMS, no slider | Slider: 0.5–3.0×, step 0.1, "Last Lap Boost" |

### 10.2 Detector-Level Parameters — In Backend API but NOT in UI

These are submitted to `/analyze/redetect` via the Analysis panel's tuning section, but are **not accessible from the Replay Tuning pane in the Highlight editor**. They need detection re-run to take effect so they belong in the Analysis tab — but are they clearly labelled there?

| Parameter | API Default | Recommended Label |
|---|---|---|
| `battle_gap_threshold` | `0.5s` | "Battle Proximity Gap" |
| `crash_min_time_loss` | `10.0s` | "Crash Min Time Loss" |
| `crash_min_off_track_duration` | `3.0s` | "Crash Min Off-Track Duration" |
| `spinout_min_time_loss` | `2.0s` | "Spinout Min Time Loss" |
| `spinout_max_time_loss` | `10.0s` | "Spinout Max Time Loss" |
| `contact_time_window` | `2.0s` | "Contact Time Window" |
| `contact_proximity` | `0.05 laps` | "Contact Proximity" |
| `close_call_proximity` | `0.02 laps` | "Close Call Proximity" |
| `close_call_max_off_track` | `3.0s` | "Close Call Max Off-Track" |

_(Check: are these labeled and grouped sensibly in the Analysis panel tuning section?)_

### 10.3 Hardcoded Scoring Constants That Should Be Exposed

These are in `scoring_engine.py` as module-level constants. They're never surfaced to the user.

| Constant | Current Value | Recommended Exposure |
|---|---|---|
| Stage 5 late-race threshold | `0.9` (90% of race) | Replay Tuning: "Late Race Bonus Start" (slider 0.5–0.95) |
| Stage 5 late-race multiplier | `1.2` | Replay Tuning: "Late Race Boost" (slider 1.0–2.0×) |
| Stage 2: P1-3 position multiplier | `2.0` | Advanced: "Front-of-Field Bias" |
| `DEFAULT_PIP_THRESHOLD` | `7.0` | Replay Tuning: "PIP Threshold" (slider 5–10) |

### 10.4 Missing from System Entirely — New Parameters to Implement

| Parameter | From iRD | Priority | Description |
|---|---|---|---|
| `battleFrontBias` | `BattleFactor2` | **High** | Geometric decay factor biasing battle selection toward front-of-field. Replaces or supplements Stage 2 for battles. Range 1.0–2.5. |
| `preferredDriversOnly` | `FocusOnPreferedDriver` | **High** | Exclusive mode — exclude all events with no preferred driver in `involved_drivers`. |
| `ignoreIncidentsDuringFirstLap` | `IgnoreIncidentsDuringRaceStart` | **Medium** | Suppress incidents that occur in the first-lap bucket. |
| `firstLapStickyPeriod` | `FollowLeaderAtRaceStartPeriod` | **Medium** | Seconds to weight/prefer leader-camera events from race start (scoring bonus window). |
| `lastLapStickyPeriod` | `FollowLeaderBeforeRaceEndPeriod` | **Medium** | Seconds before race end to start boosting leader/finisher events. |
| `paceCarRestartWindow` | `RestartStickyTime` (20s) | **Medium** | Seconds after restart to boost leader-follow events. |
| `perTrackCameraConfig` | Per-track `Ratio` + `IsRaceStart/Incident/LastLap` | **Low** | Per-track camera group probability weights and role assignments (establishing shot, incident cam, etc.). |
| `cameraBattleChoreography` | Establishing shot → angle cycling → reverse trick | **Low** | Battle camera hints in composition script: `establishing_angle`, `cycle_angles`, `reverse_on_behind`. |

---

## 11. Quick Audit: Replay Tuning UI (`HighlightWeightSliders.jsx`) Parameter Coverage

### Currently Exposed (✅) vs Missing (❌)

| Parameter | Exposed | Section |
|---|---|---|
| Per-type weights (all event types) | ✅ | Event Priorities |
| Minimum score threshold | ✅ | Minimum Score |
| Target duration | ✅ | Target Duration |
| `battleStickyPeriod` | ✅ | Direction Tuning → Battle Hold |
| `cameraStickyPeriod` | ✅ | Direction Tuning → Camera Hold |
| `overtakeBoost` | ✅ | Direction Tuning → Overtake Boost |
| `incidentPositionCutoff` | ✅ | Direction Tuning → Incident Pos Cutoff |
| `preferredDriverBoost` | ✅ | Direction Tuning → Driver Boost |
| `preferredDrivers` | ✅ | Direction Tuning → Preferred Drivers |
| `battleGap` | ❌ | In `DEFAULT_PARAMS`, no UI slider |
| `firstLapWeight` | ❌ | In `DEFAULT_PARAMS`, no UI slider |
| `lastLapWeight` | ❌ | In `DEFAULT_PARAMS`, no UI slider |
| `preferredDriversOnly` | ❌ | Not implemented |
| `battleFrontBias` | ❌ | Not implemented |
| `ignoreIncidentsDuringFirstLap` | ❌ | Not implemented |
| `firstLapStickyPeriod` | ❌ | Not implemented |
| `lastLapStickyPeriod` | ❌ | Not implemented |
| Late-race bonus threshold | ❌ | Hardcoded in `scoring_engine.py` |
| Late-race bonus multiplier | ❌ | Hardcoded in `scoring_engine.py` |
| PIP threshold | ❌ | Hardcoded in `scoring_engine.py` |

### Detection-Level Parameters (Require Redetect — belong in Analysis panel)

| Parameter | Exposed in Analysis Panel |
|---|---|
| `battle_gap_threshold` | ✅ (tuningParams in AnalysisPanel.jsx) |
| `crash_min_time_loss` | ✅ |
| `crash_min_off_track_duration` | ✅ |
| `spinout_min_time_loss` | ✅ |
| `spinout_max_time_loss` | ✅ |
| `contact_time_window` | ✅ |
| `contact_proximity` | ✅ |
| `close_call_proximity` | ✅ |
| `close_call_max_off_track` | ✅ |

> All detection-level parameters are correctly wired to the backend `RedetectRequest` and saved to the project database via `save_tuning_params`. ✅
