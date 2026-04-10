/**
 * highlight-scoring.js
 * --------------------
 * Pure scoring logic for the highlight selection pipeline (v2).
 *
 * Extracted from HighlightContext.jsx to improve maintainability.
 * This module is dependency-free and can be tested independently.
 *
 * ⚠️  SYNC NOTE: The constants and algorithm here mirror
 * backend/server/services/scoring_engine.py (Stages 1–6).
 * Backend adds Stage 6 (exposure adjustment) which requires cross-event
 * state.  Keep both files in sync when changing scoring logic.
 * See scoring_engine.py for the authoritative 8-stage pipeline.
 */

// ── Shared constants (mirrored from scoring_engine.py) ───────────────────

/** Base scores by event type for the multi-pass scoring pipeline */
export const BASE_SCORES = {
  // SessionLog-sourced incident types (IncidentLogDetector)
  car_contact:  1.6,   // "Car Contact" (car-to-car)
  contact:      1.2,   // "Contact" (wall / barrier)
  lost_control: 1.1,   // "Lost Control" (spin)
  off_track:    0.5,   // "Off Track" (track limits)
  turn_cutting: 0.3,   // "Turn Cutting" (lowest priority)
  // Legacy inferred types (backward-compat with older project DBs)
  crash: 1.5,
  spinout: 1.2,
  // Other event types
  incident: 1.5,
  battle: 1.3,
  overtake: 1.0,
  leader_change: 0.9,
  pit_stop: 0.5,
  close_call: 0.8,
  undercut: 1.1,
  overcut: 1.1,
  pit_battle: 1.0,
  first_lap: 1.3,
  last_lap: 1.3,
  pace_lap: 0.4,
}

/** Event types that are always included (mandatory) */
export const MANDATORY_TYPES = new Set(['race_start', 'race_finish', 'restart'])

/** Tier classification thresholds */
export const TIER_S_THRESHOLD = 9.0
export const TIER_A_THRESHOLD = 7.0
export const TIER_B_THRESHOLD = 5.0

/** Timeline bucket boundaries (fraction of total race) */
export const BUCKET_BOUNDARIES = {
  intro: [0.0, 0.15],
  early: [0.15, 0.40],
  mid: [0.40, 0.70],
  late: [0.70, 1.0],
}

/** Reference speed for normalisation (70 m/s ≈ 250 km/h) */
export const REFERENCE_SPEED_MS = 70.0

/** Allow 10% overshoot on target duration before excluding events */
export const TARGET_DURATION_TOLERANCE = 1.1

/** Tier color map (S/A/B/C) */
export const TIER_COLORS = {
  S: '#ef4444',  // Red — must-have
  A: '#f97316',  // Orange — high priority
  B: '#3b82f6',  // Blue — medium priority
  C: '#6b7280',  // Gray — low priority
}

/** Get color for a tier value */
export function tierColor(tier) {
  return TIER_COLORS[tier] || '#6b7280'
}


// ── Scoring functions ────────────────────────────────────────────────────

/**
 * Compute highlight score using the multi-pass scoring pipeline (v2).
 *
 * Stage 1: Base score by event type
 * Stage 2: Position importance multiplier
 * Stage 3: Position change multiplier
 * Stage 4: Consequence weighting
 * Stage 5: Narrative bonus
 * Stage 6: User weight override
 *
 * Note: Exposure adjustment (backend Stage 6) is omitted client-side because
 * it requires cross-event state (driver screen-time accumulator).  Use the
 * server-side reprocess endpoint for authoritative scoring with exposure balance.
 *
 * Returns { score, tier, bucket, components }
 */
export function computeEventScore(event, weights, params = {}, raceDuration = 0) {
  const eventType = event.event_type || ''
  const components = {}

  // Stage 1 — Base Score
  // Mandatory events use their natural base score (not inflated to 10)
  // so they don't distort the score range. They're force-included in selection instead.
  const base = BASE_SCORES[eventType] ?? 0.5
  let score = base
  components.base = base
  components.mandatory = MANDATORY_TYPES.has(eventType)

  // Stage 2 — Position Importance Multiplier
  const position = event.position || 99
  let posMult = 1.0
  if (position <= 3) posMult = 2.0
  else if (position <= 10) posMult = 1.5
  // Battle front bias: extra weight for front-of-field battle events.
  // Mirrors scoring_engine.py Stage 2 battleFrontBias logic.
  if (eventType === 'battle' && params.battleFrontBias && params.battleFrontBias !== 1.0) {
    if (position <= 3) posMult *= params.battleFrontBias
    else if (position <= 10) posMult *= Math.sqrt(params.battleFrontBias)
  }
  score *= posMult
  components.position = posMult

  // Stage 3 — Position Change Multiplier
  const metadata = (typeof event.metadata === 'string')
    ? (() => { try { return JSON.parse(event.metadata) } catch { return {} } })()
    : (event.metadata || {})
  const positionDelta = Math.abs(metadata.position_delta || 0)
  const posChangeMult = 1 + positionDelta * 0.3
  score *= posChangeMult
  components.position_change = posChangeMult

  // Stage 4 — Consequence Weighting
  const positionsLost = Math.abs(metadata.positions_lost || 0)
  const speedMs = metadata.speed_ms || event.speed_ms || 0
  const damageSeverity = speedMs > 0 ? Math.min(speedMs / REFERENCE_SPEED_MS, 1.0) : 0
  const raceImpact = metadata.race_impact || 0
  const consequence = (positionsLost * 0.3) + (damageSeverity * 0.4) + (raceImpact * 0.3)
  score *= (1 + consequence)
  components.consequence = Math.round(consequence * 1000) / 1000

  // Stage 5 — Narrative Bonus
  let narrativeBonus = 0
  if (eventType === 'battle') {
    const chainLength = metadata.chain_length || 2
    narrativeBonus += Math.log(chainLength + 1) * 0.5
  }
  // Overtakes during a sustained battle are more exciting
  if (eventType === 'overtake' && metadata.in_battle) {
    narrativeBonus += 0.4
  }
  const evtTime = event.start_time_seconds || 0
  if (raceDuration > 0) {
    const racePct = evtTime / raceDuration
    const lateThreshold = params.lateRaceThreshold ?? 0.9
    const lateMult = params.lateRaceMultiplier ?? 1.2
    if (racePct > lateThreshold) {
      const lateRaceBonus = score * (lateMult - 1)
      score *= lateMult
      narrativeBonus += lateRaceBonus
    }
  }
  // First-lap sticky window bonus
  const firstLapSticky = params.firstLapStickyPeriod ?? 0
  if (firstLapSticky > 0 && evtTime <= firstLapSticky) {
    score *= params.firstLapWeight ?? 1.0
  }
  // Last-lap sticky window bonus
  const lastLapSticky = params.lastLapStickyPeriod ?? 0
  if (lastLapSticky > 0 && raceDuration > 0) {
    if (raceDuration - evtTime <= lastLapSticky) {
      score *= params.lastLapWeight ?? 1.0
    }
  }
  score += narrativeBonus
  components.narrative_bonus = Math.round(narrativeBonus * 1000) / 1000

  // Overtake boost (legacy param support)
  if (metadata.with_overtake && params.overtakeBoost) {
    score *= params.overtakeBoost
  }

  // Preferred driver boost (legacy param support)
  if (params.preferredDrivers && params.preferredDriverBoost) {
    const preferred = params.preferredDrivers.split(',').map(n => n.trim().toLowerCase()).filter(Boolean)
    if (preferred.length > 0 && event.driver_names) {
      const hasPreferred = event.driver_names.some(name =>
        preferred.some(p => name.toLowerCase().includes(p))
      )
      if (hasPreferred) {
        score *= params.preferredDriverBoost
      }
    }
  }

  // Preferred-drivers-only exclusive filter
  // When enabled, zero out events that don't involve a preferred driver
  // (mandatory events are always kept).
  if (params.preferredDriversOnly && params.preferredDrivers && !MANDATORY_TYPES.has(eventType)) {
    const preferred = params.preferredDrivers.split(',').map(n => n.trim().toLowerCase()).filter(Boolean)
    if (preferred.length > 0) {
      const driverNames = event.driver_names || []
      const hasPreferred = driverNames.some(name =>
        preferred.some(p => name.toLowerCase().includes(p))
      )
      if (!hasPreferred) score = 0
    }
  }

  // Ignore incidents during first-lap bucket
  // Suppresses crash/incident/spinout/contact/close_call events in the first 15% of the race.
  const _incidentTypes = new Set(['incident', 'crash', 'spinout', 'contact', 'close_call'])
  if (params.ignoreIncidentsDuringFirstLap && _incidentTypes.has(eventType)) {
    if (raceDuration > 0 && evtTime / raceDuration <= 0.15) {
      score = 0
    }
  }

  // Stage 6 — User Weight Override
  const userWeight = (weights[eventType] ?? 50) / 100.0
  score *= userWeight
  components.user_weight = userWeight

  // Round score
  score = Math.round(score * 100) / 100

  // Tier classification
  let tier
  if (score > TIER_S_THRESHOLD) {
    tier = 'S'
  } else if (score >= TIER_A_THRESHOLD) {
    tier = 'A'
  } else if (score >= TIER_B_THRESHOLD) {
    tier = 'B'
  } else {
    tier = 'C'
  }

  // Bucket classification
  let bucket = 'mid'
  if (raceDuration > 0) {
    const pct = (event.start_time_seconds || 0) / raceDuration
    for (const [bname, [lo, hi]] of Object.entries(BUCKET_BOUNDARIES)) {
      if (pct >= lo && pct < hi) {
        bucket = bname
        break
      }
    }
  }

  return { score, tier, bucket, components }
}


/** Normalize legacy override values: 'include' → 'highlight' */
export function normalizeOverride(value) {
  if (value === 'include') return 'highlight'
  return value || null
}


/**
 * Build selection reason string for an event (v2 — includes tier).
 */
export function buildReason(event, score, overrides, minSeverity, inclusion, tier) {
  const eid = String(event.id)
  const override = normalizeOverride(overrides[eid])
  if (override === 'highlight') return 'Manual highlight'
  if (override === 'full-video') return 'Manual full-video'
  if (override === 'exclude') return 'Manual exclude'
  if (MANDATORY_TYPES.has(event.event_type)) return 'Mandatory'
  if (event.severity < minSeverity) return `Below min severity (${minSeverity})`
  if (score <= 0) return 'Zero weight'
  if (inclusion === 'full-video') return `Tier ${tier} — over budget`
  return `Tier ${tier} — score ${score}`
}


/**
 * Run the highlight selection algorithm entirely on the client.
 *
 * Uses the multi-pass scoring pipeline (v2) with tier classification
 * and bucket-based timeline allocation.
 *
 * Returns { scoredEvents, selectedIds, fullVideoIds, excludedIds, metrics }
 */
export function computeHighlightSelection(events, weights, targetDuration, minSeverity, overrides, raceDuration, drivers, params = {}) {
  // 1. Score all events using multi-pass pipeline (raw scores)
  const scored = events.map(evt => {
    const { score, tier, bucket, components } = computeEventScore(evt, weights, params, raceDuration)
    return {
      ...evt,
      score,
      raw_score: score,
      tier,
      bucket,
      score_components: components,
      override: normalizeOverride(overrides[String(evt.id)]),
      duration: Math.max(0, evt.end_time_seconds - evt.start_time_seconds),
    }
  })

  // 1b. Normalize scores to 0–10 range so histogram buckets and tiers work
  const rawScores = scored.filter(e => e.score > 0).map(e => e.score)
  if (rawScores.length >= 2) {
    const minScore = Math.min(...rawScores)
    const maxScore = Math.max(...rawScores)
    const range = maxScore - minScore
    if (range > 0) {
      for (const evt of scored) {
        if (evt.score <= 0) continue
        // Normalize to 0.5–10 (floor at 0.5 so nothing maps to exactly 0)
        evt.score = Math.round((0.5 + ((evt.score - minScore) / range) * 9.5) * 100) / 100
        evt.score_components.normalization = { raw: evt.raw_score, min: minScore, max: maxScore }
      }
    } else {
      // All scores identical — set to midpoint
      for (const evt of scored) {
        if (evt.score <= 0) continue
        evt.score = 5.0
        evt.score_components.normalization = { raw: evt.raw_score, min: minScore, max: maxScore }
      }
    }
    // Re-classify tiers with normalized scores
    for (const evt of scored) {
      if (evt.score > TIER_S_THRESHOLD) evt.tier = 'S'
      else if (evt.score >= TIER_A_THRESHOLD) evt.tier = 'A'
      else if (evt.score >= TIER_B_THRESHOLD) evt.tier = 'B'
      else evt.tier = 'C'
    }
  }

  // 2. Multi-pass selection:
  //    Pass 1 — Must-have events (mandatory types + Tier S) + manual overrides
  //    Pass 2 — Bucket fill by local score
  //    Pass 3 — Remainder → full-video tier
  const sortedByScore = [...scored].sort((a, b) => {
    const tierPri = { S: 4, A: 3, B: 2, C: 1 }
    const tp = (tierPri[b.tier] || 0) - (tierPri[a.tier] || 0)
    if (tp !== 0) return tp
    return b.score - a.score
  })

  let highlightDuration = 0
  const highlightIds = new Set()
  const fullVideoIds = new Set()
  const excludedIds = new Set()

  // Initialize bucket budgets
  const bucketBudgets = {}
  const bucketUsed = {}
  for (const [name, [lo, hi]] of Object.entries(BUCKET_BOUNDARIES)) {
    bucketBudgets[name] = (targetDuration || 300) * (hi - lo)
    bucketUsed[name] = 0
  }

  // Pass 1: Manual overrides
  for (const evt of sortedByScore) {
    if (evt.override === 'highlight') {
      highlightIds.add(evt.id)
      highlightDuration += evt.duration
      bucketUsed[evt.bucket] = (bucketUsed[evt.bucket] || 0) + evt.duration
    } else if (evt.override === 'full-video') {
      fullVideoIds.add(evt.id)
    } else if (evt.override === 'exclude') {
      excludedIds.add(evt.id)
    }
  }

  // Pass 1b: Must-have events (mandatory types — always included regardless of score)
  for (const evt of sortedByScore) {
    if (highlightIds.has(evt.id) || fullVideoIds.has(evt.id) || excludedIds.has(evt.id)) continue
    if (MANDATORY_TYPES.has(evt.event_type)) {
      highlightIds.add(evt.id)
      highlightDuration += evt.duration
      bucketUsed[evt.bucket] = (bucketUsed[evt.bucket] || 0) + evt.duration
    }
  }

  // Find the race finish cutoff: events of non-mandatory types after this time
  // are cooldown-lap content (battles/incidents during the cool-down lap) and
  // should be excluded. last_lap (P2-P10 finish crossings) is exempt.
  const _POST_RACE_EXCLUDED = new Set([
    'battle', 'overtake', 'incident', 'crash', 'spinout', 'contact', 'close_call',
    'leader_change', 'pit_stop', 'undercut', 'overcut', 'pit_battle',
    'first_lap',
  ])
  let raceFinishCutoff = null
  for (const evt of scored) {
    if (evt.event_type === 'race_finish') {
      const t = evt.end_time_seconds || 0
      if (raceFinishCutoff === null || t < raceFinishCutoff) raceFinishCutoff = t
    }
  }

  // Pass 1c: Enforce maxRaceFinishes cap (0 = all)
  if (params.maxRaceFinishes > 0) {
    const raceFinishEvts = [...scored]
      .filter(e => e.event_type === 'race_finish' && highlightIds.has(e.id))
      .sort((a, b) => b.score - a.score)
    if (raceFinishEvts.length > params.maxRaceFinishes) {
      for (const evt of raceFinishEvts.slice(params.maxRaceFinishes)) {
        highlightIds.delete(evt.id)
        highlightDuration -= evt.duration
        bucketUsed[evt.bucket] = (bucketUsed[evt.bucket] || 0) - evt.duration
        fullVideoIds.add(evt.id)
      }
    }
  }

  // Pass 2: Bucket fill — select by score within bucket budgets
  for (const evt of sortedByScore) {
    if (highlightIds.has(evt.id) || fullVideoIds.has(evt.id) || excludedIds.has(evt.id)) continue

    // Exclude cooldown-lap events
    if (raceFinishCutoff !== null
        && _POST_RACE_EXCLUDED.has(evt.event_type)
        && (evt.start_time_seconds || 0) > raceFinishCutoff) {
      excludedIds.add(evt.id)
      continue
    }

    if (evt.severity < minSeverity) {
      excludedIds.add(evt.id)
      continue
    }

    if (params.incidentPositionCutoff > 0 && evt.event_type === 'incident') {
      if (evt.position && evt.position > params.incidentPositionCutoff) {
        excludedIds.add(evt.id)
        continue
      }
    }

    if (evt.score <= 0) {
      excludedIds.add(evt.id)
      continue
    }

    if (targetDuration && targetDuration > 0) {
      if (highlightDuration + evt.duration > targetDuration * TARGET_DURATION_TOLERANCE) {
        fullVideoIds.add(evt.id)
        continue
      }
    }

    const budget = bucketBudgets[evt.bucket] || (targetDuration || 300) * 0.3
    if ((bucketUsed[evt.bucket] || 0) >= budget) {
      fullVideoIds.add(evt.id)
      continue
    }

    highlightIds.add(evt.id)
    highlightDuration += evt.duration
    bucketUsed[evt.bucket] = (bucketUsed[evt.bucket] || 0) + evt.duration
  }

  // 3. Build scored events with inclusion tier, bucket, and reasons
  const scoredEvents = scored.map(evt => {
    const inclusion = highlightIds.has(evt.id) ? 'highlight'
      : fullVideoIds.has(evt.id) ? 'full-video'
      : 'excluded'
    return {
      ...evt,
      included: inclusion === 'highlight',
      inclusion,
      reason: buildReason(evt, evt.score, overrides, minSeverity, inclusion, evt.tier),
    }
  })

  // 4. Compute metrics
  const includedEvents = scoredEvents.filter(e => e.inclusion === 'highlight')
  const fullVideoEvts = scoredEvents.filter(e => e.inclusion === 'full-video')
  const totalHighlightDuration = includedEvents.reduce((sum, e) => sum + e.duration, 0)
  const totalFullVideoDuration = fullVideoEvts.reduce((sum, e) => sum + e.duration, 0)

  const coveragePct = raceDuration > 0 ? (totalHighlightDuration / raceDuration) * 100 : 0

  // Balance (timeline allocation): how evenly selected highlight duration is
  // distributed across intro/early/mid/late race buckets.
  const bucketDurations = Object.values(bucketUsed)
  const bucketMean = bucketDurations.length > 0
    ? bucketDurations.reduce((a, b) => a + b, 0) / bucketDurations.length
    : 0
  const bucketVariance = bucketDurations.length > 0
    ? bucketDurations.reduce((sum, v) => sum + (v - bucketMean) ** 2, 0) / bucketDurations.length
    : 0
  const bucketStdDev = Math.sqrt(bucketVariance)
  const bucketCv = bucketMean > 0 ? (bucketStdDev / bucketMean) : 0
  const balanceScore = includedEvents.length > 0
    ? Math.max(0, Math.round(100 - bucketCv * 100))
    : 0

  // Pacing
  let pacingScore = 0
  if (includedEvents.length >= 2 && raceDuration > 0) {
    const sortedByTime = [...includedEvents].sort((a, b) => a.start_time_seconds - b.start_time_seconds)
    const gaps = []
    for (let i = 1; i < sortedByTime.length; i++) {
      gaps.push(sortedByTime[i].start_time_seconds - sortedByTime[i - 1].start_time_seconds)
    }
    const idealGap = raceDuration / includedEvents.length
    const gapVariance = gaps.reduce((sum, g) => sum + (g - idealGap) ** 2, 0) / gaps.length
    const normalizedVariance = Math.sqrt(gapVariance) / raceDuration
    pacingScore = Math.max(0, Math.round(100 - normalizedVariance * 500))
  } else if (includedEvents.length === 1) {
    pacingScore = 50
  }

  // Driver coverage
  const allDriverIds = new Set()
  for (const evt of includedEvents) {
    if (Array.isArray(evt.involved_drivers)) {
      evt.involved_drivers.forEach(d => allDriverIds.add(d))
    }
  }
  const totalDrivers = drivers.length || 1
  const driverCoveragePct = Math.round((allDriverIds.size / totalDrivers) * 100)

  // Event type distribution (selected highlights)
  const typeCounts = {}
  for (const evt of includedEvents) {
    typeCounts[evt.event_type] = (typeCounts[evt.event_type] || 0) + 1
  }

  // Tier distribution
  const tierCounts = { S: 0, A: 0, B: 0, C: 0 }
  for (const evt of scored) {
    tierCounts[evt.tier] = (tierCounts[evt.tier] || 0) + 1
  }

  const metrics = {
    duration: Math.round(totalHighlightDuration * 10) / 10,
    fullVideoDuration: Math.round(totalFullVideoDuration * 10) / 10,
    eventCount: includedEvents.length,
    fullVideoCount: fullVideoEvts.length,
    totalEvents: events.length,
    coveragePct: Math.round(coveragePct * 10) / 10,
    balance: balanceScore,
    pacing: pacingScore,
    driverCoverage: driverCoveragePct,
    driverCount: allDriverIds.size,
    totalDrivers,
    typeCounts,
    tierCounts,
  }

  return {
    scoredEvents,
    selectedIds: [...highlightIds],
    fullVideoIds: [...fullVideoIds],
    excludedIds: [...excludedIds],
    metrics,
  }
}


/**
 * Auto-balance weights to achieve even event type distribution.
 * Sets weights inversely proportional to event count per type.
 */
export function autoBalanceWeights(events, defaultWeights) {
  const counts = {}
  for (const evt of events) {
    counts[evt.event_type] = (counts[evt.event_type] || 0) + 1
  }

  const maxCount = Math.max(...Object.values(counts), 1)
  const balanced = {}
  for (const [type, count] of Object.entries(counts)) {
    balanced[type] = Math.round((maxCount / count) * 50)
  }
  for (const type of Object.keys(defaultWeights)) {
    if (!(type in balanced)) balanced[type] = defaultWeights[type]
  }
  return balanced
}
