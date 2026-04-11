# Unified Selection → Script Pipeline

## Problem Statement

The current pipeline has a critical disconnect:

1. **Histogram stage** selects ~10 minutes of events based on score/budget with **no overlap awareness**
2. **Script stage** discovers overlaps → drops/merges/PIPs events → creates gaps → fills with B-roll
3. **Result**: User selected 28 clips expecting 10 minutes of action, but gets 22 clips + 6 B-roll fills because overlapping events were merged or dropped

The user sees a clean selection in the histogram, clicks "Generate Script", and the final timeline has materially different content than what was chosen.

## Root Cause

```
Current Flow:
┌──────────────────────────────┐     ┌──────────────────────────────┐
│  FRONTEND (no overlap check) │     │  BACKEND (overlap resolution) │
│                              │     │                               │
│  Score events                │     │  Re-score events              │
│  Fill buckets by duration    │ ──► │  allocate_timeline()          │
│  Show "Chosen Events" column │     │  resolve_conflicts() ← HERE  │
│  Report: "28 clips, 10min"   │     │  insert_broll() for gaps      │
│                              │     │  Result: 22 clips + 6 broll   │
└──────────────────────────────┘     └──────────────────────────────┘
                                            ↑
                                    Events dropped/merged here
                                    User never sees this coming
```

The two stages make independent decisions. The frontend doesn't know about overlaps and the backend doesn't know the user's intent about _how_ to resolve them.

## Design: Overlap-Aware Production Timeline

### Core Idea

Move overlap detection, resolution (merge/PIP/trim), and gap analysis **into the frontend selection stage**. The "Chosen Events" column becomes a **Production Timeline** — an ordered, non-overlapping sequence of clips with explicit PIP regions and identified gaps. When "Generate Script" is clicked, the backend only needs to assign cameras and drivers — the temporal structure is already locked.

### New Pipeline

```
┌─────────────────────────────────────────────────────────────────────────┐
│  FRONTEND: Unified Selection + Production Timeline                      │
│                                                                         │
│  1. Score events (existing 6-stage pipeline)                            │
│  2. Rank by score (existing)                                            │
│  3. ★ NEW: Overlap-aware greedy insertion into Production Timeline      │
│     For each candidate (descending score):                              │
│       a. Compute clip window [start - padding, end + padding]           │
│       b. Check for overlaps against already-placed clips                │
│       c. If no overlap → place directly                                 │
│       d. If overlap with same drivers → MERGE (extend window)           │
│       e. If overlap, both high-score → PIP (mark primary/secondary)     │
│       f. If overlap, can TRIM without losing core → trim edges          │
│       g. If none work → demote to full-video tier                       │
│     After each placement, update remaining budget                       │
│  4. ★ NEW: Gap analysis on placed timeline                              │
│     Identify gaps ≥ threshold between placed clips                      │
│     Pull best unselected events that fit each gap (context fills)       │
│     Mark remaining uncovered gaps as "bridge needed"                    │
│  5. Output: Production Timeline with clip types:                        │
│     - EVENT: core highlight clip                                        │
│     - MERGE: extended window covering multiple same-driver events        │
│     - PIP: dual-feed with primary/secondary regions                     │
│     - CONTEXT: lower-scored events pulled in to fill gaps               │
│     - BRIDGE: marked gap where B-roll is needed (with exact duration)   │
│                                                                         │
│  The "Chosen Events" column renders this Production Timeline directly.  │
│  User sees exactly what the final script will contain.                  │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  BACKEND: Camera & Driver Assignment Only                               │
│                                                                         │
│  Receives: Production Timeline (ordered, non-overlapping, timed clips)  │
│  Does:                                                                  │
│    - Assigns camera_preferences per segment                             │
│    - Picks driver focus (preferred_car_idx using camera heuristics)     │
│    - Adds overlay_template_id                                           │
│    - Wraps in 4-section structure (intro/qual/race/results)             │
│  Does NOT: Drop events, resolve overlaps, or insert B-roll              │
│                                                                         │
│  Result: Final script ≈ exact same clips user saw in histogram          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Algorithm: `buildProductionTimeline()`

```
function buildProductionTimeline(scoredEvents, targetDuration, params):
  // Sort all events by score descending (highest-priority events placed first)
  candidates = scoredEvents.filter(not excluded).sort(by score DESC)
  
  timeline = []          // Placed clips (sorted by start time)
  budget = targetDuration
  
  for each candidate in candidates:
    if budget <= 0: break
    
    clipWindow = computeClipWindow(candidate, params)
    //  { start: event.start - padding_before, end: event.end + padding_after }
    
    overlaps = findOverlaps(clipWindow, timeline)
    
    if overlaps.length === 0:
      // ── Clean placement ──────────────────────────────────────
      place(timeline, { type: 'event', ...candidate, clipWindow })
      budget -= clipWindow.duration
      
    else if overlaps.length === 1:
      existing = overlaps[0]
      
      if shareDrivers(candidate, existing):
        // ── MERGE: Same drivers, extend the window ─────────────
        merged = mergeClipWindows(existing, candidate)
        replace(timeline, existing, { type: 'merge', merged, events: [existing, candidate] })
        budget -= (merged.duration - existing.clipWindow.duration)  // Only new duration
        
      else if candidate.score >= PIP_THRESHOLD && existing.score >= PIP_THRESHOLD:
        // ── PIP: Both high-value, show simultaneously ──────────
        pipWindow = unionClipWindows(existing, candidate)
        replace(timeline, existing, {
          type: 'pip',
          primary: existing.score >= candidate.score ? existing : candidate,
          secondary: existing.score >= candidate.score ? candidate : existing,
          clipWindow: pipWindow,
        })
        budget -= (pipWindow.duration - existing.clipWindow.duration)
        
      else if canTrim(candidate, existing):
        // ── TRIM: Shorten the new clip to avoid overlap ────────
        trimmed = trimToFit(candidate, existing)
        if trimmed.duration >= MIN_CLIP_DURATION:
          place(timeline, { type: 'event', ...candidate, clipWindow: trimmed })
          budget -= trimmed.duration
        else:
          demoteToFullVideo(candidate)
          
      else:
        // ── Cannot resolve: demote lower-scored ────────────────
        demoteToFullVideo(candidate)
        
    else:
      // Multiple overlaps — complex case (candidate spans 2+ existing clips)
      // Try to merge all if same drivers, otherwise demote
      ...
  
  // ── Gap Analysis ─────────────────────────────────────────────
  // Sort timeline by clip start time
  timeline.sort(by clipWindow.start)
  
  // Find gaps between adjacent clips
  gaps = []
  for i = 0 to timeline.length - 2:
    gapStart = timeline[i].clipWindow.end
    gapEnd   = timeline[i + 1].clipWindow.start
    gapDuration = gapEnd - gapStart
    if gapDuration >= GAP_THRESHOLD:
      gaps.push({ start: gapStart, end: gapEnd, duration: gapDuration })
  
  // Try to fill gaps with unselected events (context fills)
  unselected = scoredEvents.filter(not in timeline, not excluded)
    .sort(by score DESC)
  
  for each gap in gaps:
    for each candidate in unselected:
      candidateWindow = computeClipWindow(candidate, params)
      if fitsInGap(candidateWindow, gap):
        place(timeline, { type: 'context', ...candidate, clipWindow: candidateWindow })
        shrinkGap(gap, candidateWindow)
        budget -= candidateWindow.duration
        if budget <= 0: break
    
    // Whatever gap remains is marked as bridge-needed
    if gap.remainingDuration >= MIN_BRIDGE_DURATION:
      place(timeline, { type: 'bridge', clipWindow: gap.remaining })
  
  return {
    timeline,            // Ordered, non-overlapping, with clip types
    placedEventIds,      // IDs that made it into the timeline
    fullVideoIds,        // Demoted events
    metrics: { ... },
  }
```

### Data Structures

#### Production Timeline Segment

```typescript
type ProductionSegment = {
  id: string                    // Unique segment ID
  type: 'event' | 'merge' | 'pip' | 'context' | 'bridge'
  
  // Temporal (in race-session time, includes padding)
  clipStart: number             // Start of capture window (race seconds)
  clipEnd: number               // End of capture window
  clipDuration: number          // clipEnd - clipStart
  
  // Core event time (without padding, for overlay timing)
  coreStart: number             // Original event start
  coreEnd: number               // Original event end
  
  // Source events
  sourceEvents: SourceEvent[]   // 1 for event/context, 2+ for merge/pip
  primaryEventId: number        // Main event driving this segment
  
  // PIP-specific (only for type === 'pip')
  pip?: {
    primaryRegion: 'full'
    secondaryRegion: 'bottom_right' | 'bottom_left' | 'top_right'
    secondaryScale: 0.35
    secondaryEventId: number
  }
  
  // Merge-specific (for type === 'merge')
  mergedEventIds?: number[]     // All events absorbed into this merge
  
  // Scoring
  score: number                 // Primary event score (for display)
  tier: string                  // S/A/B/C
  bucket: string                // intro/early/mid/late
  
  // Resolution metadata
  resolution: 'placed' | 'merged' | 'pip' | 'trimmed' | 'context-fill' | 'bridge'
  resolutionNote?: string       // "Merged with battle #42 (shared driver P. Leclerc)"
}
```

### UI: The Production Timeline Column

The current "Chosen Events" + "PIP" columns become a single **Production Timeline** column with richer rendering:

```
┌──────────────────────────────────────────────────┐
│  Production Timeline                              │
│  28 clips · 2 PIPs · 3 fills · 10m 12s           │
├──────────────────────────────────────────────────┤
│                                                   │
│  ┌─ EVENT ──────────────────────────┐ 0:42        │
│  │ ♦ Race Start  Score 9.2  [S]    │              │
│  │   Hamilton, Verstappen           │              │
│  └──────────────────────────────────┘              │
│                                                    │
│  ┌─ MERGE ──────────────────────────┐ 1:15        │
│  │ ⟁ Battle + Overtake             │              │
│  │   Score 8.7 [A] · 2 events      │              │
│  │   Norris vs Leclerc (shared)     │              │
│  │   12.5s → 18.2s (extended)       │              │
│  └──────────────────────────────────┘              │
│                                                    │
│  ┌─ PIP ────────────────────────────┐ 2:03        │
│  │ ◫ Battle ∥ Overtake              │              │
│  │   Primary: Verstappen (8.1)      │              │
│  │   Secondary: Alonso (7.4)        │              │
│  │   Different drivers · 14.3s      │              │
│  └──────────────────────────────────┘              │
│                                                    │
│  ┌─ CONTEXT ────────────────────────┐ 2:48        │
│  │ ◇ Pit Stop (gap fill)           │              │
│  │   Perez · Score 4.2 · 6.1s      │              │
│  └──────────────────────────────────┘              │
│                                                    │
│  ┌─ BRIDGE ─────────────────────────┐ 3:15        │
│  │ ≋ B-Roll needed · 4.2s          │              │
│  │   (scenic/field cam)             │              │
│  └──────────────────────────────────┘              │
│                                                    │
│  ...                                               │
└──────────────────────────────────────────────────┘
```

### What Changes Where

#### Frontend (`highlight-scoring.js`)

**Current**: `computeHighlightSelection()` — score + bucket fill, no overlap check
**New**: `buildProductionTimeline()` — score + overlap-aware placement + gap analysis

The existing `computeHighlightSelection` splits into two phases:
1. Scoring (unchanged) — produces scored events with tiers/buckets
2. **NEW** Timeline construction — replaces the simple bucket-fill with overlap-aware greedy insertion

**Key change**: The function now returns a `productionTimeline[]` alongside the existing IDs/metrics. The timeline is the source of truth for what will be in the final script.

#### Frontend (`HighlightContext.jsx`)

**Current**: Exposes `selection.scoredEvents`, `selectedIds`, `metrics`
**New**: Also exposes `selection.productionTimeline` — the resolved, ordered segments

The `generateVideoScript` API call now sends the `productionTimeline` to the backend instead of just IDs.

#### Frontend (`HighlightHistogram.jsx`)

**Current**: Chosen Events column shows raw selected events; PIP column shows PIP markers
**New**: Single "Production Timeline" column renders `productionTimeline` segments with type-specific visuals (merge badges, PIP split indicators, gap markers, context fills)

#### Backend (`pipeline.py` / `timeline.py`)

**Current**: `generate_highlights()` runs 7 stages including `allocate_timeline()`, `resolve_conflicts()`, `insert_broll()`
**New**: `generate_video_script()` receives the pre-built production timeline and only:
1. Validates segment times against actual event data
2. Assigns cameras (using existing `_assign_cameras()` logic)
3. Picks driver focus per segment
4. Wraps in section structure (intro/qual/race/results)
5. Returns script that is structurally identical to the input timeline

**Stages eliminated from backend**: `allocate_timeline()`, `resolve_conflicts()`, `_smooth_timeline()`, and the creative parts of `insert_broll()` — these decisions are all made in the frontend now.

### Edge Cases

| Scenario | Resolution |
|----------|-----------|
| 3-way overlap (A overlaps B overlaps C) | Process highest-scored first. Each subsequent candidate checks against the already-placed result. |
| Merge + PIP on same segment | A is placed. B merges with A (same driver). C overlaps merged(A+B) with different driver → PIP of merged(A+B) as primary and C as secondary. |
| Trimming leaves < 2s clip | Discard (demote to full-video). Don't create micro-clips. |
| Gap too small for any event | If < 3s, leave as implicit cut. If 3–8s, mark as bridge. |
| User manually overrides a merged event to 'exclude' | Re-run timeline construction. The merge dissolves, may reveal a gap. |
| PIP with 3+ events | Only 2 feeds max. Third event is trimmed or demoted. |
| Budget exhausted mid-gap-fill | Stop filling. Remaining gaps stay as bridges. |

### Metrics (Updated)

```javascript
metrics: {
  // Existing
  duration: 612,              // Total production timeline duration
  eventCount: 28,             // Events placed (including merges/PIPs)
  coveragePct: 8.2,           // Duration / race duration
  balance: 87.3,              // Bucket distribution evenness

  // New
  mergeCount: 3,              // Events that were merged into adjacent
  pipCount: 2,                // PIP segments created
  trimCount: 1,               // Events trimmed to avoid overlap
  contextFillCount: 4,        // Unselected events pulled into gaps
  bridgeDuration: 18.5,       // Total B-roll needed (seconds)
  bridgePct: 3.0,             // Bridge / total duration
  overlapResolutions: 6,      // Total overlap decisions made
  demotedCount: 4,            // Events that couldn't fit → full-video
}
```

### Migration Path

This is a significant refactor but the changes are well-contained:

1. **Phase 1**: Add `buildProductionTimeline()` to `highlight-scoring.js` alongside existing `computeHighlightSelection()`. Wire it into HighlightContext as a new computed value. No backend changes yet.

2. **Phase 2**: Replace the "Chosen Events" + "PIP" columns with a unified Production Timeline column that renders the new data structure.

3. **Phase 3**: Update `generateVideoScript()` API to accept the production timeline. Backend validates and adds camera/driver assignments without re-doing overlap resolution.

4. **Phase 4**: Remove now-dead backend code (`resolve_conflicts()`, parts of `allocate_timeline()`, creative `insert_broll()` logic).

### Benefits

- **What you see is what you get**: The histogram's production timeline IS the final script structure
- **No surprise content loss**: Overlaps resolved visually before the user commits
- **Explicit gap awareness**: User can see exactly where B-roll will go and how much
- **Faster script generation**: Backend does ~80% less work (no scoring, no allocation, no conflict resolution)
- **User agency**: Merge/PIP/trim decisions are visible and potentially overridable in future
