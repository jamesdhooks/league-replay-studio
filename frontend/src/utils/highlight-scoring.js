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

import { resolveTypePadding } from './highlight-padding'

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
    // Battles with lead changes contain overtake moments — they're better stories.
    const leadChanges = metadata.lead_changes || 0
    if (leadChanges > 0) {
      narrativeBonus += 0.6 + Math.min(leadChanges - 1, 3) * 0.3
    }
    // Gap tightness bonus — rewards segments where cars were genuinely wheel-to-wheel.
    // Scaled by battleGapBonus param (0 = off, default 0.5, max 2.0).
    const gapBonus = params.battleGapBonus ?? 0.5
    if (gapBonus > 0) {
      // Prefer sub-window metrics when available so merged clusters score by
      // their strongest contained battle moments instead of one diluted average.
      const rawWindows = Array.isArray(metadata.sub_battles)
        ? metadata.sub_battles
        : (Array.isArray(metadata.driver_windows) ? metadata.driver_windows : [])

      const windowBonuses = rawWindows
        .map(w => {
          const wLeadChanges = Number(w?.lead_changes || 0)
          const wAvgGap = w?.avg_gap_seconds
          let bonus = 0
          if (wLeadChanges > 0) {
            bonus += 0.4 + Math.min(wLeadChanges - 1, 2) * 0.2
          }
          if (wAvgGap != null) {
            const gapFactor = Math.max(0, 1 - Number(wAvgGap) / 2.0)
            bonus += gapFactor * gapBonus
          }
          return bonus
        })
        .filter(b => b > 0)
        .sort((a, b) => b - a)

      if (windowBonuses.length > 0) {
        // Use the best one or two windows for narrative lift.
        narrativeBonus += windowBonuses[0]
        if (windowBonuses.length > 1) narrativeBonus += windowBonuses[1] * 0.5
      } else if (metadata.avg_gap_seconds != null) {
        // Fallback for legacy events without window-level metrics.
        const gapFactor = Math.max(0, 1 - metadata.avg_gap_seconds / 2.0)
        narrativeBonus += gapFactor * gapBonus
      }
    }
  }
  // In-battle overtakes are redundant with the parent battle clip — dampen them
  // so the fuller battle story is preferred over the isolated pass.
  // Standalone overtakes (not part of a battle) keep their full score.
  if (eventType === 'overtake' && metadata.in_battle) {
    score *= 0.6
    narrativeBonus -= 0.2
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
  // NOTE: recorded here for display, but applied after per-type normalization in computeHighlightSelection.
  const userWeight = (weights[eventType] ?? 50) / 100.0
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
  const getSelectionDuration = (evt) => {
    const coreDuration = Math.max(0, (evt.end_time_seconds || 0) - (evt.start_time_seconds || 0))
    const { before: typeBefore, after: typeAfter } = resolveTypePadding(params, evt.event_type)
    const before = Math.max(0, evt.metadata?.padding_before ?? typeBefore ?? params?.paddingBefore ?? 0)
    const after = Math.max(0, evt.metadata?.padding_after ?? typeAfter ?? params?.paddingAfter ?? 0)
    return coreDuration + before + after
  }

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
      selectionDuration: getSelectionDuration(evt),
    }
  })

  // 1b. Normalization — cross_type (default) or per_type (legacy).
  //     cross_type stretches all positive raw scores onto a single 0.5–10 scale
  //     so BASE_SCORES and inter-type score differences survive into selection.
  //     The user weight slider then acts as an honest cross-type multiplier.
  //     per_type is the legacy mode kept for back-compat.
  const normalizationMode = (params.normalizationMode === 'per_type') ? 'per_type' : 'cross_type'
  const positive = scored.filter(e => e.score > 0)

  if (normalizationMode === 'cross_type') {
    if (positive.length > 0) {
      const allScores = positive.map(e => e.score)
      const minScore = Math.min(...allScores)
      const maxScore = Math.max(...allScores)
      const range = maxScore - minScore
      for (const evt of positive) {
        const preNorm = evt.score
        if (range > 0) {
          evt.score = Math.round((0.5 + ((evt.score - minScore) / range) * 9.5) * 100) / 100
        } else {
          evt.score = 5.0
        }
        evt.score_components.normalization = { raw: preNorm, min: minScore, max: maxScore, mode: 'cross_type' }
        evt.score_raw = evt.score
        const userWeight = (weights[evt.event_type] ?? 50) / 100.0
        evt.score = Math.round(evt.score * userWeight * 100) / 100
        evt.score_components.user_weight = userWeight
      }
    }
  } else {
    // Per-type normalization (legacy)
    const typeGroups = {}
    for (const evt of positive) {
      if (!typeGroups[evt.event_type]) typeGroups[evt.event_type] = []
      typeGroups[evt.event_type].push(evt)
    }
    for (const [eventType, typeEvts] of Object.entries(typeGroups)) {
      const typeScores = typeEvts.map(e => e.score)
      const minScore = Math.min(...typeScores)
      const maxScore = Math.max(...typeScores)
      const range = maxScore - minScore
      for (const evt of typeEvts) {
        const preNorm = evt.score
        if (range > 0) {
          evt.score = Math.round((0.5 + ((evt.score - minScore) / range) * 9.5) * 100) / 100
        } else {
          evt.score = 5.0
        }
        evt.score_components.normalization = { raw: preNorm, min: minScore, max: maxScore, type: eventType, mode: 'per_type' }
        evt.score_raw = evt.score
        const userWeight = (weights[evt.event_type] ?? 50) / 100.0
        evt.score = Math.round(evt.score * userWeight * 100) / 100
        evt.score_components.user_weight = userWeight
      }
    }
  }
  // Re-classify tiers with final weighted normalized scores
  for (const evt of scored) {
    if (evt.score > TIER_S_THRESHOLD) evt.tier = 'S'
    else if (evt.score >= TIER_A_THRESHOLD) evt.tier = 'A'
    else if (evt.score >= TIER_B_THRESHOLD) evt.tier = 'B'
    else evt.tier = 'C'
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
      highlightDuration += evt.selectionDuration
      bucketUsed[evt.bucket] = (bucketUsed[evt.bucket] || 0) + evt.selectionDuration
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
      highlightDuration += evt.selectionDuration
      bucketUsed[evt.bucket] = (bucketUsed[evt.bucket] || 0) + evt.selectionDuration
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
        highlightDuration -= evt.selectionDuration
        bucketUsed[evt.bucket] = (bucketUsed[evt.bucket] || 0) - evt.selectionDuration
        fullVideoIds.add(evt.id)
      }
    }
  }

  // Pass 2: Bucket fill — Balanced Selection v3 marginal-utility loop.
  // Effective score = score × type_decay × quota_pressure × bucket_diversity × driver_coverage.
  // When diversityStrength === 0, type factors collapse to 1.0 (legacy).
  // When driverCoverageStrength === 0, driver factor also collapses to 1.0.
  const diversityStrength = Math.max(0, Number(params.diversityStrength ?? 0))
  const divScale = diversityStrength / 50
  const typeDecayBase = Math.max(0.01, Math.min(1.0, Number(params.typeDecayBase ?? 0.85)))
  const bucketRepeatPenalty = Math.max(0, Number(params.bucketRepeatPenalty ?? 0.25))
  const floorBoost = 1.5
  const mixMin = params.mixMin || {}
  const mixMax = params.mixMax || {}
  const target = Math.max(targetDuration || 1, 1)

  // Driver coverage params
  const driverCoverageStrength = Math.max(0, Math.min(100, Number(params.driverCoverageStrength ?? 35)))
  const driverScale = driverCoverageStrength / 100
  const newDriverBoost = Math.max(1.0, Number(params.newDriverBoost ?? 1.40))
  const repeatDriverPenalty = Math.max(0, Math.min(1.0, Number(params.repeatDriverPenalty ?? 0.25)))

  // Track per-type stats from Pass 1 (must-have / overrides already in highlightIds).
  const typeCount = {}
  const typeUsedDuration = {}
  const bucketTypeCount = {}  // key: `${bucket}|${type}`
  const seenDriverIds = new Set()  // driver IDs already represented in the selected timeline
  for (const evt of scored) {
    if (!highlightIds.has(evt.id)) continue
    const t = evt.event_type
    const b = evt.bucket || 'mid'
    typeCount[t] = (typeCount[t] || 0) + 1
    typeUsedDuration[t] = (typeUsedDuration[t] || 0) + evt.selectionDuration
    const k = `${b}|${t}`
    bucketTypeCount[k] = (bucketTypeCount[k] || 0) + 1
    if (Array.isArray(evt.involved_drivers)) evt.involved_drivers.forEach(d => seenDriverIds.add(d))
  }

  const typeDecayFactor = (count) =>
    (divScale <= 0 || count <= 0) ? 1.0 : Math.pow(typeDecayBase, count * divScale)
  const quotaPressure = (t) => {
    const share = (typeUsedDuration[t] || 0) / target
    const cap = mixMax[t]
    if (cap != null && share >= Number(cap)) return 0
    if (divScale > 0 && mixMin[t] != null && share < Number(mixMin[t])) {
      return 1 + (floorBoost - 1) * divScale
    }
    return 1.0
  }
  const bucketDivFactor = (b, t) => {
    const c = bucketTypeCount[`${b}|${t}`] || 0
    return (divScale <= 0 || c <= 0) ? 1.0 : 1.0 / (1.0 + bucketRepeatPenalty * c * divScale)
  }
  // Driver coverage factor: boosts events with unseen drivers, gently penalises full repeats.
  // Collapses to 1.0 when driverScale === 0.
  const driverCoverageFactor = (evt) => {
    if (driverScale <= 0) return 1.0
    const involved = Array.isArray(evt.involved_drivers) ? evt.involved_drivers : []
    if (involved.length === 0) return 1.0
    const unseenCount = involved.filter(d => !seenDriverIds.has(d)).length
    const unseenFrac = unseenCount / involved.length
    const rawBoost = unseenFrac * (newDriverBoost - 1.0)
    const rawPenalty = (1.0 - unseenFrac) * repeatDriverPenalty
    const rawFactor = 1.0 + rawBoost - rawPenalty
    return 1.0 + (rawFactor - 1.0) * driverScale
  }

  // Build the eligible pool once, then re-rank each iteration so diversity
  // factors (which depend on already-selected counts) update correctly.
  const eligible = []
  for (const evt of sortedByScore) {
    if (highlightIds.has(evt.id) || fullVideoIds.has(evt.id) || excludedIds.has(evt.id)) continue
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
    if (params.incidentPositionCutoff > 0) {
      const INCIDENT_TYPES = new Set([
        'incident', 'crash', 'spinout', 'car_contact', 'contact',
        'lost_control', 'off_track', 'turn_cutting', 'close_call',
      ])
      if (INCIDENT_TYPES.has(evt.event_type)) {
        const pos = evt.position ?? null
        if (pos !== null && pos > params.incidentPositionCutoff) {
          excludedIds.add(evt.id)
          continue
        }
      }
    }
    if (evt.score <= 0) {
      excludedIds.add(evt.id)
      continue
    }
    eligible.push(evt)
  }

  const tierPriMap = { S: 4, A: 3, B: 2, C: 1 }
  const placed = new Set()

  // Marginal-utility greedy selection. Skips events that fail bucket budget or
  // would exceed total duration tolerance; demotes those to full-video at the end.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (targetDuration && highlightDuration >= targetDuration) break
    let bestEvt = null
    let bestEff = -1
    for (const evt of eligible) {
      if (placed.has(evt.id)) continue
      const t = evt.event_type
      const b = evt.bucket || 'mid'
      const budget = bucketBudgets[b] || (targetDuration || 300) * 0.3
      if ((bucketUsed[b] || 0) >= budget) continue
      if (targetDuration > 0 && highlightDuration + evt.selectionDuration > targetDuration * TARGET_DURATION_TOLERANCE) continue
      const q = quotaPressure(t)
      if (q <= 0) continue
      const eff = evt.score * q * typeDecayFactor(typeCount[t] || 0) * bucketDivFactor(b, t)
        * driverCoverageFactor(evt)
        + (tierPriMap[evt.tier] || 0) * 0.001
      if (eff > bestEff) {
        bestEff = eff
        bestEvt = evt
      }
    }
    if (!bestEvt) break
    const t = bestEvt.event_type
    const b = bestEvt.bucket || 'mid'
    placed.add(bestEvt.id)
    highlightIds.add(bestEvt.id)
    highlightDuration += bestEvt.selectionDuration
    bucketUsed[b] = (bucketUsed[b] || 0) + bestEvt.selectionDuration
    typeCount[t] = (typeCount[t] || 0) + 1
    typeUsedDuration[t] = (typeUsedDuration[t] || 0) + bestEvt.selectionDuration
    bucketTypeCount[`${b}|${t}`] = (bucketTypeCount[`${b}|${t}`] || 0) + 1
    if (Array.isArray(bestEvt.involved_drivers)) bestEvt.involved_drivers.forEach(d => seenDriverIds.add(d))
  }

  // Demote any remaining eligible events not selected → full-video tier.
  for (const evt of eligible) {
    if (!placed.has(evt.id) && !highlightIds.has(evt.id)) {
      fullVideoIds.add(evt.id)
    }
  }

  // Pass 4 (client) — Driver coverage rebalance.
  // If unique-driver coverage is below targetUniqueDriverShare and strength > 0,
  // swap out low-tier repeated-driver clips for best new-driver candidates.
  const MANDATORY_SET = new Set(['race_start', 'race_finish', 'restart'])
  const targetUniqueDriverShare = Math.max(0.10, Math.min(1.0, Number(params.targetUniqueDriverShare ?? 0.60)))
  const driverSwapScoreFloor = 0.85
  const maxDriverSwaps = 4
  const totalDrivers = drivers.length || 0
  if (driverScale > 0 && totalDrivers > 0) {
    const coverageTarget = Math.ceil(totalDrivers * targetUniqueDriverShare)
    let swapsDone = 0
    while (seenDriverIds.size < coverageTarget && swapsDone < maxDriverSwaps) {
      // Best unselected event introducing at least one uncovered driver
      let bestCand = null, bestCandScore = -1
      for (const evt of eligible) {
        if (highlightIds.has(evt.id)) continue
        if (!Array.isArray(evt.involved_drivers)) continue
        const hasNew = evt.involved_drivers.some(d => !seenDriverIds.has(d))
        if (!hasNew) continue
        if (evt.score > bestCandScore) { bestCandScore = evt.score; bestCand = evt }
      }
      if (!bestCand) break
      // Find the weakest swappable included event: non-mandatory, tier B/C, no new drivers
      const included = scored.filter(e => highlightIds.has(e.id))
        .sort((a, b) => a.score - b.score)
      let swapTarget = null
      for (const evt of included) {
        if (MANDATORY_SET.has(evt.event_type)) continue
        if (evt.override === 'highlight') continue  // force-included by user
        if (evt.tier === 'S' || evt.tier === 'A') continue
        if (Array.isArray(evt.involved_drivers) && evt.involved_drivers.some(d => !seenDriverIds.has(d))) continue
        if (bestCandScore < evt.score * driverSwapScoreFloor) continue
        swapTarget = evt
        break
      }
      if (!swapTarget) break
      // Perform swap
      highlightIds.delete(swapTarget.id)
      fullVideoIds.add(swapTarget.id)
      placed.delete(swapTarget.id)
      highlightIds.add(bestCand.id)
      placed.add(bestCand.id)
      // Rebuild seenDriverIds
      seenDriverIds.clear()
      for (const e of scored) {
        if (!highlightIds.has(e.id)) continue
        if (Array.isArray(e.involved_drivers)) e.involved_drivers.forEach(d => seenDriverIds.add(d))
      }
      swapsDone++
    }
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
  const totalHighlightDuration = includedEvents.reduce((sum, e) => sum + e.selectionDuration, 0)
  const totalFullVideoDuration = fullVideoEvts.reduce((sum, e) => sum + e.selectionDuration, 0)

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
  const _totalDrivers = drivers.length || 1
  const driverCoveragePct = Math.round((allDriverIds.size / _totalDrivers) * 100)
  const _coverageTarget = Math.ceil(_totalDrivers * (params.targetUniqueDriverShare ?? 0.60))
  const driverTargetMet = allDriverIds.size >= _coverageTarget

  // Event type distribution (selected highlights)
  const typeCounts = {}
  for (const evt of includedEvents) {
    typeCounts[evt.event_type] = (typeCounts[evt.event_type] || 0) + 1
  }

  // Selection diagnostics — per-type share vs configured mix targets/floors/caps
  const typeDurations = {}
  for (const evt of includedEvents) {
    typeDurations[evt.event_type] = (typeDurations[evt.event_type] || 0) + evt.selectionDuration
  }
  const typeShares = {}
  const targetForShare = Math.max(targetDuration || 1, 1)
  for (const [t, d] of Object.entries(typeDurations)) {
    typeShares[t] = Math.round((d / targetForShare) * 1000) / 1000
  }
  const floorsUnmet = Object.entries(params.mixMin || {})
    .filter(([t, mn]) => (typeDurations[t] || 0) / targetForShare < Number(mn))
    .map(([t]) => t)
  const capsHit = Object.entries(params.mixMax || {})
    .filter(([t, mx]) => mx != null && (typeDurations[t] || 0) / targetForShare >= Number(mx))
    .map(([t]) => t)
  const selectionDiagnostics = {
    diversityStrength: params.diversityStrength ?? 0,
    typeShares,
    typeDurations,
    mixMin: params.mixMin || {},
    mixMax: params.mixMax || {},
    mixTargets: params.mixTargets || {},
    floorsUnmet,
    capsHit,
    // Driver coverage diagnostics
    driverCoverageStrength: params.driverCoverageStrength ?? 35,
    driverUniqueCount: allDriverIds.size,
    driverTotalCount: _totalDrivers,
    driverCoveragePct,
    driverTargetMet,
    driverTargetUniqueShare: params.targetUniqueDriverShare ?? 0.60,
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
    totalDrivers: _totalDrivers,
    driverTargetMet,
    driverTargetCount: _coverageTarget,
    typeCounts,
    tierCounts,
    selectionDiagnostics,
  }

  return {
    scoredEvents,
    selectedIds: [...highlightIds],
    fullVideoIds: [...fullVideoIds],
    excludedIds: [...excludedIds],
    metrics,
  }
}


// ── Production Timeline Builder ──────────────────────────────────────────

/** Minimum clip duration (seconds) after trimming — shorter clips are demoted */
const MIN_CLIP_DURATION = 2.0

/** Minimum gap (seconds) to mark as bridge-needed */
const MIN_BRIDGE_DURATION = 3.0

/** Gap threshold as fraction of target duration — gaps smaller than this are ignored */
const GAP_THRESHOLD_FRACTION = 0.01

/** Max context fills per gap */
const MAX_CONTEXT_PER_GAP = 3

/**
 * Compute the padded clip window for an event given padding params.
 * Returns { clipStart, clipEnd, clipDuration }.
 */
function computeClipWindow(evt, params) {
  const start = evt.start_time_seconds || 0
  const end = evt.end_time_seconds || start
  const { before: typeBefore, after: typeAfter } = resolveTypePadding(params, evt.event_type)
  const meta = (typeof evt.metadata === 'string')
    ? (() => { try { return JSON.parse(evt.metadata) } catch { return {} } })()
    : (evt.metadata || {})
  const before = Math.max(0, meta.padding_before ?? typeBefore ?? params?.paddingBefore ?? 2.0)
  const after = Math.max(0, meta.padding_after ?? typeAfter ?? params?.paddingAfter ?? 5.0)
  const clipStart = Math.max(0, start - before)
  const clipEnd = end + after
  return { clipStart, clipEnd, clipDuration: clipEnd - clipStart }
}

/** Check if two clip windows overlap. */
function windowsOverlap(a, b) {
  return a.clipStart < b.clipEnd && a.clipEnd > b.clipStart
}

/** Get set of involved driver IDs from an event */
function getDriverSet(evt) {
  const drivers = evt.involved_drivers || []
  return new Set(Array.isArray(drivers) ? drivers : [])
}

/** Check if two events share any involved drivers */
function eventsShareDrivers(a, b) {
  const da = getDriverSet(a)
  const db = getDriverSet(b)
  for (const d of da) { if (db.has(d)) return true }
  return false
}

/** Find all segments in timeline whose clip window overlaps the given window */
function findOverlaps(window, timeline) {
  return timeline.filter(seg => windowsOverlap(window, seg))
}

/** Union two clip windows into one covering both */
function unionWindows(a, b) {
  const clipStart = Math.min(a.clipStart, b.clipStart)
  const clipEnd = Math.max(a.clipEnd, b.clipEnd)
  return { clipStart, clipEnd, clipDuration: clipEnd - clipStart }
}

/** Try to trim a candidate window so it doesn't overlap existing.
 *  Returns trimmed window or null if core event would be lost. */
function trimWindow(candidateWindow, candidateEvt, existing) {
  const coreStart = candidateEvt.start_time_seconds || 0
  const coreEnd = candidateEvt.end_time_seconds || coreStart

  // Try trimming from the left (clip starts after existing ends)
  const leftTrimmed = { clipStart: existing.clipEnd, clipEnd: candidateWindow.clipEnd }
  leftTrimmed.clipDuration = leftTrimmed.clipEnd - leftTrimmed.clipStart
  if (leftTrimmed.clipStart <= coreStart && leftTrimmed.clipDuration >= MIN_CLIP_DURATION) {
    return leftTrimmed
  }

  // Try trimming from the right (clip ends before existing starts)
  const rightTrimmed = { clipStart: candidateWindow.clipStart, clipEnd: existing.clipStart }
  rightTrimmed.clipDuration = rightTrimmed.clipEnd - rightTrimmed.clipStart
  if (rightTrimmed.clipEnd >= coreEnd && rightTrimmed.clipDuration >= MIN_CLIP_DURATION) {
    return rightTrimmed
  }

  return null
}

let _nextSegId = 1

/** Create a production segment from an event */
function makeSegment(type, evt, clipWindow, resolution, extra = {}) {
  const id = `prod_${_nextSegId++}`
  return {
    id,
    type,
    clipStart: clipWindow.clipStart,
    clipEnd: clipWindow.clipEnd,
    clipDuration: clipWindow.clipDuration,
    coreStart: evt.start_time_seconds || 0,
    coreEnd: evt.end_time_seconds || (evt.start_time_seconds || 0),
    sourceEvents: [evt],
    primaryEventId: evt.id,
    event_type: evt.event_type,
    score: evt.score,
    tier: evt.tier,
    bucket: evt.bucket,
    involved_drivers: evt.involved_drivers || [],
    driver_names: evt.driver_names || [],
    severity: evt.severity,
    resolution,
    ...extra,
  }
}

/**
 * Build an overlap-aware Production Timeline from scored events.
 *
 * This replaces the old bucket-fill + backend resolve_conflicts flow.
 * Events are placed in descending score order; overlaps are resolved
 * via merge / PIP / trim / demote. Gaps are filled with context events
 * and explicit bridge markers.
 *
 * @param {Object} selection - Result from computeHighlightSelection()
 * @param {number} targetDuration - Target highlight reel duration (seconds)
 * @param {Object} params - Padding params, pipThreshold, etc.
 * @param {number} raceDuration - Total race duration for gap analysis
 * @returns {{ timeline, metrics, fullVideoIds, demotedIds }}
 */
export function buildProductionTimeline(selection, targetDuration, params, raceDuration, replayMode = 'highlights') {
  _nextSegId = 1

  const pipThreshold = params?.pipThreshold ?? 7.0
  const gapThreshold = Math.max(MIN_BRIDGE_DURATION, (targetDuration || 300) * GAP_THRESHOLD_FRACTION)

  // Full race mode or no target duration → no budget cap; otherwise honour targetDuration * tolerance
  const budgetCap = (replayMode === 'full' || !targetDuration) ? Infinity : targetDuration * TARGET_DURATION_TOLERANCE

  // Start with events already classified by computeHighlightSelection
  const highlights = selection.scoredEvents
    .filter(e => e.inclusion === 'highlight')
    .sort((a, b) => {
      // Mandatory first, then by score descending
      const am = MANDATORY_TYPES.has(a.event_type) ? 1 : 0
      const bm = MANDATORY_TYPES.has(b.event_type) ? 1 : 0
      if (am !== bm) return bm - am
      return b.score - a.score
    })

  const timeline = []
  let usedBudget = 0
  const placedIds = new Set()
  const demotedIds = new Set()

  // Tracking metrics
  let mergeCount = 0
  let pipCount = 0
  let trimCount = 0
  let absorbCount = 0

  // ── Pre-compute battle→overtake containment ──────────────────────────
  // When a battle is placed, its child overtakes (same drivers, time overlap)
  // are absorbed into it rather than consuming separate budget.
  const battleChildren = new Map()  // battleId → Set<overtakeId>
  const overtakeParent = new Map()  // overtakeId → battleId
  const allEvents = selection.scoredEvents
  const battles = allEvents.filter(e => e.event_type === 'battle')
  const inBattleOvertakes = allEvents.filter(e =>
    e.event_type === 'overtake' && e.metadata?.in_battle
  )
  for (const battle of battles) {
    const bStart = battle.start_time_seconds || 0
    const bEnd = battle.end_time_seconds || bStart
    const bDrivers = new Set(battle.involved_drivers || [])
    if (bDrivers.size === 0) continue
    for (const ot of inBattleOvertakes) {
      const otTime = ot.start_time_seconds || 0
      // Overtake falls within battle time window (with small tolerance)
      if (otTime >= bStart - 2 && otTime <= bEnd + 2) {
        const otDrivers = ot.involved_drivers || []
        if (otDrivers.length >= 2 && otDrivers.every(d => bDrivers.has(d))) {
          if (!battleChildren.has(battle.id)) battleChildren.set(battle.id, new Set())
          battleChildren.get(battle.id).add(ot.id)
          overtakeParent.set(ot.id, battle.id)
        }
      }
    }
  }
  const absorbedIds = new Set()  // overtakes absorbed into a placed battle

  /** When a battle is placed, absorb its child overtakes into the segment */
  function absorbChildOvertakes(seg) {
    const evtId = seg.primaryEventId
    const children = battleChildren.get(evtId)
    if (!children || children.size === 0) return
    for (const childId of children) {
      if (!absorbedIds.has(childId) && !placedIds.has(childId)) {
        absorbedIds.add(childId)
        absorbCount++
      }
    }
    // Also absorb children of any merged events
    for (const src of (seg.sourceEvents || [])) {
      const srcChildren = battleChildren.get(src.id)
      if (!srcChildren) continue
      for (const childId of srcChildren) {
        if (!absorbedIds.has(childId) && !placedIds.has(childId)) {
          absorbedIds.add(childId)
          absorbCount++
        }
      }
    }
  }

  // ── Phase 1: Overlap-aware greedy placement ──────────────────────────
  for (const evt of highlights) {
    // Skip overtakes already absorbed into a placed battle
    if (absorbedIds.has(evt.id)) {
      placedIds.add(evt.id)
      continue
    }

    const window = computeClipWindow(evt, params)
    const overlaps = findOverlaps(window, timeline)

    if (overlaps.length === 0) {
      // Clean placement
      if (usedBudget + window.clipDuration <= budgetCap || MANDATORY_TYPES.has(evt.event_type)) {
        const seg = makeSegment('event', evt, window, 'placed')
        timeline.push(seg)
        usedBudget += window.clipDuration
        placedIds.add(evt.id)
        // If this is a battle, absorb its child overtakes
        if (evt.event_type === 'battle') absorbChildOvertakes(seg)
      } else {
        demotedIds.add(evt.id)
      }
    } else if (overlaps.length === 1) {
      const existing = overlaps[0]

      if (eventsShareDrivers(evt, { involved_drivers: existing.involved_drivers })) {
        // MERGE: same drivers, extend window
        const merged = unionWindows(existing, window)
        const durationDelta = merged.clipDuration - existing.clipDuration
        if (usedBudget + durationDelta <= budgetCap || MANDATORY_TYPES.has(evt.event_type)) {
          const allSources = [...(existing.sourceEvents || []), evt]
          const allDrivers = [...new Set([...(existing.involved_drivers || []), ...(evt.involved_drivers || [])])]
          const allDriverNames = [...new Set([...(existing.driver_names || []), ...(evt.driver_names || [])])]
          const primary = existing.score >= evt.score ? existing : evt
          Object.assign(existing, {
            type: 'merge',
            clipStart: merged.clipStart,
            clipEnd: merged.clipEnd,
            clipDuration: merged.clipDuration,
            coreStart: Math.min(existing.coreStart, evt.start_time_seconds || 0),
            coreEnd: Math.max(existing.coreEnd, evt.end_time_seconds || (evt.start_time_seconds || 0)),
            sourceEvents: allSources,
            primaryEventId: primary.primaryEventId || primary.id,
            score: Math.max(existing.score, evt.score),
            involved_drivers: allDrivers,
            driver_names: allDriverNames,
            mergedEventIds: [...(existing.mergedEventIds || [existing.primaryEventId]), evt.id],
            resolution: 'merged',
            resolutionNote: `Merged ${allSources.length} events (shared drivers)`,
          })
          usedBudget += durationDelta
          placedIds.add(evt.id)
          mergeCount++
          // If either event is a battle, absorb child overtakes
          if (evt.event_type === 'battle' || existing.event_type === 'battle') absorbChildOvertakes(existing)
        } else {
          demotedIds.add(evt.id)
        }
      } else if (evt.score >= pipThreshold && existing.score >= pipThreshold) {
        // PIP: both high-value, different drivers
        const pipWindow = unionWindows(existing, window)
        const durationDelta = pipWindow.clipDuration - existing.clipDuration
        if (usedBudget + durationDelta <= budgetCap) {
          const primary = existing.score >= evt.score ? existing : evt
          const secondary = existing.score >= evt.score ? evt : existing
          const allSources = [...(existing.sourceEvents || []), evt]
          Object.assign(existing, {
            type: 'pip',
            clipStart: pipWindow.clipStart,
            clipEnd: pipWindow.clipEnd,
            clipDuration: pipWindow.clipDuration,
            coreStart: Math.min(existing.coreStart, evt.start_time_seconds || 0),
            coreEnd: Math.max(existing.coreEnd, evt.end_time_seconds || (evt.start_time_seconds || 0)),
            sourceEvents: allSources,
            primaryEventId: primary.primaryEventId || primary.id,
            score: Math.max(existing.score, evt.score),
            involved_drivers: [...new Set([...(existing.involved_drivers || []), ...(evt.involved_drivers || [])])],
            driver_names: [...new Set([...(existing.driver_names || []), ...(evt.driver_names || [])])],
            pip: {
              primaryRegion: 'full',
              primaryEventId: primary.primaryEventId || primary.id,
              secondaryRegion: 'bottom_right',
              secondaryScale: 0.35,
              secondaryEventId: secondary.primaryEventId || secondary.id,
            },
            resolution: 'pip',
            resolutionNote: `PIP: ${primary.event_type} (primary) + ${secondary.event_type} (secondary)`,
          })
          usedBudget += durationDelta
          placedIds.add(evt.id)
          pipCount++
        } else {
          demotedIds.add(evt.id)
        }
      } else {
        // Try trimming
        const trimmed = trimWindow(window, evt, existing)
        if (trimmed && usedBudget + trimmed.clipDuration <= budgetCap) {
          const seg = makeSegment('event', evt, trimmed, 'trimmed', {
            resolutionNote: `Trimmed to avoid overlap (${trimmed.clipDuration.toFixed(1)}s)`,
          })
          timeline.push(seg)
          usedBudget += trimmed.clipDuration
          placedIds.add(evt.id)
          trimCount++
        } else {
          demotedIds.add(evt.id)
        }
      }
    } else {
      // Multiple overlaps — complex case, try trimming or demote
      // Sort overlaps by time to find the tightest fit
      overlaps.sort((a, b) => a.clipStart - b.clipStart)
      let placed = false
      // Try trimming between each pair of overlapping segments
      for (let i = 0; i < overlaps.length - 1; i++) {
        const gapStart = overlaps[i].clipEnd
        const gapEnd = overlaps[i + 1].clipStart
        if (gapEnd - gapStart >= MIN_CLIP_DURATION) {
          const trimmedWindow = { clipStart: gapStart, clipEnd: gapEnd, clipDuration: gapEnd - gapStart }
          const coreStart = evt.start_time_seconds || 0
          const coreEnd = evt.end_time_seconds || coreStart
          if (trimmedWindow.clipStart <= coreEnd && trimmedWindow.clipEnd >= coreStart) {
            const seg = makeSegment('event', evt, trimmedWindow, 'trimmed', {
              resolutionNote: `Trimmed to fit between overlaps (${trimmedWindow.clipDuration.toFixed(1)}s)`,
            })
            timeline.push(seg)
            usedBudget += trimmedWindow.clipDuration
            placedIds.add(evt.id)
            trimCount++
            placed = true
            break
          }
        }
      }
      if (!placed) {
        demotedIds.add(evt.id)
      }
    }
  }

  // ── Phase 2: Sort timeline by clip start ─────────────────────────────
  timeline.sort((a, b) => a.clipStart - b.clipStart)

  // ── Phase 3: Gap analysis + context fills ────────────────────────────
  // Candidates: all non-excluded, non-placed events, sorted by score
  const contextCandidates = selection.scoredEvents
    .filter(e => !placedIds.has(e.id) && !demotedIds.has(e.id) && e.inclusion !== 'excluded' && e.score > 0)
    .sort((a, b) => {
      // Prefer events that bring new drivers
      const existingDrivers = new Set()
      for (const seg of timeline) {
        for (const d of (seg.involved_drivers || [])) existingDrivers.add(d)
      }
      const aNew = (a.involved_drivers || []).filter(d => !existingDrivers.has(d)).length
      const bNew = (b.involved_drivers || []).filter(d => !existingDrivers.has(d)).length
      if (aNew !== bNew) return bNew - aNew
      return b.score - a.score
    })

  let contextFillCount = 0
  const contextUsedIds = new Set()

  // Find gaps and fill
  const gaps = []
  if (timeline.length >= 2) {
    for (let i = 0; i < timeline.length - 1; i++) {
      const gapStart = timeline[i].clipEnd
      const gapEnd = timeline[i + 1].clipStart
      if (gapEnd - gapStart >= gapThreshold) {
        gaps.push({ start: gapStart, end: gapEnd, duration: gapEnd - gapStart, afterIndex: i })
      }
    }
  }

  // Process gaps in reverse so index shifts don't affect earlier gaps
  for (let gi = gaps.length - 1; gi >= 0; gi--) {
    const gap = gaps[gi]
    let insertAt = gap.afterIndex + 1
    let contextInThisGap = 0
    let gapStart = gap.start
    const gapEnd = gap.end

    for (const candidate of contextCandidates) {
      if (contextUsedIds.has(candidate.id)) continue
      if (contextInThisGap >= MAX_CONTEXT_PER_GAP) break
      if (usedBudget >= budgetCap) break

      const cw = computeClipWindow(candidate, params)
      // Candidate must fit within the gap
      if (cw.clipStart >= gapStart && cw.clipEnd <= gapEnd) {
        const seg = makeSegment('context', candidate, cw, 'context-fill', {
          resolutionNote: 'Context fill for gap',
        })
        timeline.splice(insertAt, 0, seg)
        insertAt++
        usedBudget += cw.clipDuration
        contextUsedIds.add(candidate.id)
        placedIds.add(candidate.id)
        gapStart = cw.clipEnd
        contextFillCount++
        contextInThisGap++
      }
    }
  }

  // Re-sort after inserts
  timeline.sort((a, b) => a.clipStart - b.clipStart)

  // ── Phase 4: Mark remaining gaps as bridge segments ──────────────────
  const finalTimeline = []
  for (let i = 0; i < timeline.length; i++) {
    if (i > 0) {
      const prevEnd = timeline[i - 1].clipEnd
      const curStart = timeline[i].clipStart
      const gapDur = curStart - prevEnd
      if (gapDur >= MIN_BRIDGE_DURATION) {
        finalTimeline.push({
          id: `bridge_${_nextSegId++}`,
          type: 'bridge',
          clipStart: prevEnd,
          clipEnd: curStart,
          clipDuration: gapDur,
          coreStart: prevEnd,
          coreEnd: curStart,
          sourceEvents: [],
          primaryEventId: null,
          event_type: null,
          score: 0,
          tier: null,
          bucket: null,
          involved_drivers: [],
          driver_names: [],
          severity: 0,
          resolution: 'bridge',
          resolutionNote: `Cut point (${gapDur.toFixed(1)}s race gap)`,
        })
      }
    }
    finalTimeline.push(timeline[i])
  }

  // ── Full race mode: prepend/append bridges to cover 0 → raceDuration ─
  if (replayMode === 'full' && raceDuration > 0) {
    const firstSeg = finalTimeline[0]
    const lastSeg = finalTimeline[finalTimeline.length - 1]

    if (firstSeg && firstSeg.clipStart > MIN_BRIDGE_DURATION) {
      finalTimeline.unshift({
        id: `bridge_${_nextSegId++}`,
        type: 'bridge',
        clipStart: 0,
        clipEnd: firstSeg.clipStart,
        clipDuration: firstSeg.clipStart,
        coreStart: 0,
        coreEnd: firstSeg.clipStart,
        sourceEvents: [],
        primaryEventId: null,
        event_type: null,
        score: 0,
        tier: null,
        bucket: null,
        involved_drivers: [],
        driver_names: [],
        severity: 0,
        resolution: 'bridge',
        resolutionNote: `Race start to first event (${firstSeg.clipStart.toFixed(1)}s)`,
      })
    }

    const refreshedLast = finalTimeline[finalTimeline.length - 1]
    if (refreshedLast && raceDuration - refreshedLast.clipEnd > MIN_BRIDGE_DURATION) {
      finalTimeline.push({
        id: `bridge_${_nextSegId++}`,
        type: 'bridge',
        clipStart: refreshedLast.clipEnd,
        clipEnd: raceDuration,
        clipDuration: raceDuration - refreshedLast.clipEnd,
        coreStart: refreshedLast.clipEnd,
        coreEnd: raceDuration,
        sourceEvents: [],
        primaryEventId: null,
        event_type: null,
        score: 0,
        tier: null,
        bucket: null,
        involved_drivers: [],
        driver_names: [],
        severity: 0,
        resolution: 'bridge',
        resolutionNote: `Last event to race end (${(raceDuration - refreshedLast.clipEnd).toFixed(1)}s)`,
      })
    }
  }

  // ── Compute edit-time positions (for compact mode) ───────────────────
  // Bridges are instant cuts — zero edit-time contribution, just markers.
  let editCursor = 0
  for (const seg of finalTimeline) {
    seg.editStart = editCursor
    seg.editDur = seg.type === 'bridge' ? 0 : seg.clipDuration
    seg.editEnd = editCursor + seg.editDur
    editCursor += seg.editDur
  }

  // ── Build full-video IDs (demoted + original full-video) ─────────────
  const newFullVideoIds = [
    ...selection.fullVideoIds.filter(id => !placedIds.has(id)),
    ...demotedIds,
  ]

  // ── Compute metrics ──────────────────────────────────────────────────
  const eventSegs = finalTimeline.filter(s => s.type === 'event' || s.type === 'merge' || s.type === 'pip')
  const totalContentDuration = eventSegs.reduce((sum, s) => sum + s.clipDuration, 0)
  const totalContextDuration = finalTimeline.filter(s => s.type === 'context').reduce((sum, s) => sum + s.clipDuration, 0)
  const bridgeCount = finalTimeline.filter(s => s.type === 'bridge').length
  const totalEditDuration = editCursor

  const allPlacedDrivers = new Set()
  for (const seg of finalTimeline) {
    for (const d of (seg.involved_drivers || [])) allPlacedDrivers.add(d)
  }

  const productionMetrics = {
    duration: Math.round(totalEditDuration * 10) / 10,
    contentDuration: Math.round(totalContentDuration * 10) / 10,
    contextDuration: Math.round(totalContextDuration * 10) / 10,
    bridgeCount,
    bridgeDuration: 0,  // Bridges are instant cuts
    bridgePct: 0,
    eventCount: eventSegs.length,
    mergeCount,
    pipCount,
    trimCount,
    absorbCount,
    contextFillCount,
    demotedCount: demotedIds.size,
    overlapResolutions: mergeCount + pipCount + trimCount,
    driverCount: allPlacedDrivers.size,
    segmentCount: finalTimeline.length,
  }

  return {
    timeline: finalTimeline,
    metrics: productionMetrics,
    fullVideoIds: newFullVideoIds,
    demotedIds: [...demotedIds],
    placedIds: [...placedIds],
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
