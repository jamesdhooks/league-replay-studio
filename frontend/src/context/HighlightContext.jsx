import { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { apiGet, apiPut, apiPost, apiDelete } from '../services/api'
import { useAnalysis } from './AnalysisContext'
import { useTimeline } from './TimelineContext'
import { useUndoRedo } from './UndoRedoContext'

const HighlightContext = createContext(null)

/** Default weights for each event type (0–100 priority) */
const DEFAULT_WEIGHTS = {
  incident: 80,
  battle: 60,
  overtake: 70,
  pit_stop: 20,
  fastest_lap: 50,
  leader_change: 90,
  first_lap: 100,
  last_lap: 100,
  crash: 80,
  spinout: 60,
  contact: 65,
  close_call: 40,
}

/** Default detection/camera tuning parameters (inspired by iRacingReplayDirector) */
const DEFAULT_PARAMS = {
  battleGap: 1.0,               // Max gap (seconds) between cars to be "in battle"
  battleStickyPeriod: 120,      // Seconds to track one battle before switching
  cameraStickyPeriod: 20,       // Seconds to hold one camera angle
  overtakeBoost: 1.5,           // Score multiplier for events with overtakes
  incidentPositionCutoff: 0,    // Ignore incidents from cars below this position (0 = disabled)
  firstLapWeight: 1.0,          // Multiplier for first-lap events (1.0 = normal)
  lastLapWeight: 1.0,           // Multiplier for last-lap events (1.0 = normal)
  preferredDrivers: '',         // Comma-separated preferred driver names (boost their events)
  preferredDriverBoost: 1.3,    // Score multiplier for preferred driver events
}

/** Event type labels for UI display */
export const EVENT_TYPE_LABELS = {
  incident: 'Incidents',
  battle: 'Battles',
  overtake: 'Overtakes',
  pit_stop: 'Pit Stops',
  fastest_lap: 'Fastest Laps',
  leader_change: 'Leader Changes',
  first_lap: 'First Lap',
  last_lap: 'Last Lap',
  crash: 'Crashes',
  spinout: 'Spinouts',
  contact: 'Contacts',
  close_call: 'Close Calls',
  pace_lap: 'Pace Lap',
  restart: 'Restart',
}

/** Base scores by event type for the multi-pass scoring pipeline */
const BASE_SCORES = {
  crash: 1.5,
  incident: 1.5,
  battle: 1.3,
  spinout: 1.2,
  overtake: 1.0,
  leader_change: 0.9,
  fastest_lap: 0.7,
  pit_stop: 0.5,
  contact: 1.2,
  close_call: 0.8,
}

/** Event types that are always included (mandatory) */
const MANDATORY_TYPES = new Set(['first_lap', 'last_lap', 'restart', 'pace_lap'])

/** Tier classification thresholds */
const TIER_S_THRESHOLD = 9.0
const TIER_A_THRESHOLD = 7.0
const TIER_B_THRESHOLD = 5.0

/** Timeline bucket boundaries (fraction of total race) */
const BUCKET_BOUNDARIES = {
  intro: [0.0, 0.15],
  early: [0.15, 0.40],
  mid: [0.40, 0.70],
  late: [0.70, 1.0],
}

/** Reference speed for normalisation (70 m/s ≈ 250 km/h) */
const REFERENCE_SPEED_MS = 70.0

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
function computeEventScore(event, weights, params = {}, raceDuration = 0) {
  const eventType = event.event_type || ''
  const components = {}

  // Stage 1 — Base Score
  let score
  if (MANDATORY_TYPES.has(eventType)) {
    score = 10.0
    components.base = 10.0
  } else {
    const base = BASE_SCORES[eventType] ?? 0.5
    score = base
    components.base = base
  }

  // Stage 2 — Position Importance Multiplier
  const position = event.position || 99
  let posMult = 1.0
  if (position <= 3) posMult = 2.0
  else if (position <= 10) posMult = 1.5
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
  if (raceDuration > 0) {
    const racePct = (event.start_time_seconds || 0) / raceDuration
    if (racePct > 0.9) {
      score *= 1.2
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

  // Stage 6 — User Weight Override
  const userWeight = (weights[eventType] ?? 50) / 100.0
  if (!MANDATORY_TYPES.has(eventType)) {
    score *= userWeight
  }
  components.user_weight = userWeight

  // Round score
  score = Math.round(score * 100) / 100

  // Tier classification
  let tier
  if (MANDATORY_TYPES.has(eventType) || score > TIER_S_THRESHOLD) {
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

/**
 * Build selection reason string for an event (v2 — includes tier).
 */
function buildReason(event, score, overrides, minSeverity, inclusion, tier) {
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

/** Normalize legacy override values: 'include' → 'highlight' */
function normalizeOverride(value) {
  if (value === 'include') return 'highlight'
  return value || null
}

/** Allow 10% overshoot on target duration before excluding events */
const TARGET_DURATION_TOLERANCE = 1.1

/**
 * Run the highlight selection algorithm entirely on the client.
 *
 * Uses the multi-pass scoring pipeline (v2) with tier classification
 * and bucket-based timeline allocation.
 *
 * Returns { scoredEvents, selectedIds, metrics }
 */
function computeHighlightSelection(events, weights, targetDuration, minSeverity, overrides, raceDuration, drivers, params = {}) {
  // 1. Score all events using multi-pass pipeline
  const scored = events.map(evt => {
    const { score, tier, bucket, components } = computeEventScore(evt, weights, params, raceDuration)
    return {
      ...evt,
      score,
      tier,
      bucket,
      score_components: components,
      override: normalizeOverride(overrides[String(evt.id)]),
      duration: Math.max(0, evt.end_time_seconds - evt.start_time_seconds),
    }
  })

  // 2. Multi-pass selection:
  //    Pass 1 — Must-have events (mandatory types + Tier S) + manual overrides
  //    Pass 2 — Bucket fill by local score
  //    Pass 3 — Remainder → full-video tier
  const sortedByScore = [...scored].sort((a, b) => {
    // Sort by tier priority first, then by score
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

  // Pass 1b: Must-have events (Tier S + mandatory types)
  for (const evt of sortedByScore) {
    if (highlightIds.has(evt.id) || fullVideoIds.has(evt.id) || excludedIds.has(evt.id)) continue
    if (evt.tier === 'S' || MANDATORY_TYPES.has(evt.event_type)) {
      highlightIds.add(evt.id)
      highlightDuration += evt.duration
      bucketUsed[evt.bucket] = (bucketUsed[evt.bucket] || 0) + evt.duration
    }
  }

  // Pass 2: Bucket fill — select by score within bucket budgets
  for (const evt of sortedByScore) {
    if (highlightIds.has(evt.id) || fullVideoIds.has(evt.id) || excludedIds.has(evt.id)) continue

    // Apply min severity filter
    if (evt.severity < minSeverity) {
      excludedIds.add(evt.id)
      continue
    }

    // Apply incident position cutoff
    if (params.incidentPositionCutoff > 0 && evt.event_type === 'incident') {
      if (evt.position && evt.position > params.incidentPositionCutoff) {
        excludedIds.add(evt.id)
        continue
      }
    }

    // Apply zero-weight filter
    if (evt.score <= 0) {
      excludedIds.add(evt.id)
      continue
    }

    // Check overall budget
    if (targetDuration && targetDuration > 0) {
      if (highlightDuration + evt.duration > targetDuration * TARGET_DURATION_TOLERANCE) {
        fullVideoIds.add(evt.id)
        continue
      }
    }

    // Check bucket budget
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
      included: inclusion === 'highlight', // backward compat
      inclusion,
      reason: buildReason(evt, evt.score, overrides, minSeverity, inclusion, evt.tier),
    }
  })

  // 4. Compute metrics
  const includedEvents = scoredEvents.filter(e => e.inclusion === 'highlight')
  const fullVideoEvents = scoredEvents.filter(e => e.inclusion === 'full-video')
  const totalHighlightDuration = includedEvents.reduce((sum, e) => sum + e.duration, 0)
  const totalFullVideoDuration = fullVideoEvents.reduce((sum, e) => sum + e.duration, 0)

  // Coverage %
  const coveragePct = raceDuration > 0 ? (totalHighlightDuration / raceDuration) * 100 : 0

  // Balance — distribution of event types in selected events
  const typeCounts = {}
  for (const evt of includedEvents) {
    typeCounts[evt.event_type] = (typeCounts[evt.event_type] || 0) + 1
  }
  const typeValues = Object.values(typeCounts)
  const mean = typeValues.length > 0 ? typeValues.reduce((a, b) => a + b, 0) / typeValues.length : 0
  const variance = typeValues.length > 0
    ? typeValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) / typeValues.length
    : 0
  // Normalize: 100 = perfectly balanced, 0 = totally unbalanced
  const balanceScore = typeValues.length > 1
    ? Math.max(0, Math.round(100 - Math.sqrt(variance) * 20))
    : (typeValues.length === 1 ? 50 : 0)

  // Pacing — how evenly events are spread across the race
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

  // Tier distribution
  const tierCounts = { S: 0, A: 0, B: 0, C: 0 }
  for (const evt of scored) {
    tierCounts[evt.tier] = (tierCounts[evt.tier] || 0) + 1
  }

  const metrics = {
    duration: Math.round(totalHighlightDuration * 10) / 10,
    fullVideoDuration: Math.round(totalFullVideoDuration * 10) / 10,
    eventCount: includedEvents.length,
    fullVideoCount: fullVideoEvents.length,
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
function autoBalanceWeights(events) {
  const counts = {}
  for (const evt of events) {
    counts[evt.event_type] = (counts[evt.event_type] || 0) + 1
  }

  const maxCount = Math.max(...Object.values(counts), 1)
  const balanced = {}
  for (const [type, count] of Object.entries(counts)) {
    balanced[type] = Math.round((maxCount / count) * 50)
  }
  // Fill in missing types with defaults
  for (const type of Object.keys(DEFAULT_WEIGHTS)) {
    if (!(type in balanced)) balanced[type] = DEFAULT_WEIGHTS[type]
  }
  return balanced
}


/**
 * HighlightProvider — manages highlight editing state.
 *
 * Runs the selection algorithm client-side for <100ms response,
 * persists config to backend, supports A/B compare and presets.
 */
export function HighlightProvider({ children }) {
  // ── Weight configuration ────────────────────────────────────────────────
  const [weights, setWeights] = useState({ ...DEFAULT_WEIGHTS })
  const [targetDuration, setTargetDuration] = useState(null)
  const [minSeverity, setMinSeverity] = useState(0)
  const [overrides, setOverrides] = useState({})    // { eventId: 'include'|'exclude' }
  const [params, setParams] = useState({ ...DEFAULT_PARAMS })

  // ── A/B compare mode ────────────────────────────────────────────────────
  const [abMode, setAbMode] = useState(false)
  const [configA, setConfigA] = useState(null)       // { weights, targetDuration, minSeverity, overrides }
  const [configB, setConfigB] = useState(null)
  const [activeConfig, setActiveConfig] = useState('A')

  // ── Presets ─────────────────────────────────────────────────────────────
  const [presets, setPresets] = useState([])

  // ── Drivers ─────────────────────────────────────────────────────────────
  const [drivers, setDrivers] = useState([])

  // ── Sorting & filtering ─────────────────────────────────────────────────
  const [sortColumn, setSortColumn] = useState('score')
  const [sortDirection, setSortDirection] = useState('desc')
  const [filterType, setFilterType] = useState('')
  const [filterInclusion, setFilterInclusion] = useState('') // '' | 'included' | 'excluded'
  const [filterSeverityRange, setFilterSeverityRange] = useState([0, 10])

  // ── Get data from sibling contexts ──────────────────────────────────────
  const { events } = useAnalysis()
  const { raceDuration, seekTo } = useTimeline()
  const { pushAction } = useUndoRedo()

  // ── Computed selection (memoised, <100ms) ───────────────────────────────
  const selection = useMemo(
    () => computeHighlightSelection(events, weights, targetDuration, minSeverity, overrides, raceDuration, drivers, params),
    [events, weights, targetDuration, minSeverity, overrides, raceDuration, drivers, params],
  )

  // ── Sorted & filtered event list ───────────────────────────────────────
  const filteredEvents = useMemo(() => {
    let list = [...selection.scoredEvents]

    // Filter by type
    if (filterType) {
      list = list.filter(e => e.event_type === filterType)
    }

    // Filter by inclusion tier
    if (filterInclusion === 'highlight') {
      list = list.filter(e => e.inclusion === 'highlight')
    } else if (filterInclusion === 'full-video') {
      list = list.filter(e => e.inclusion === 'full-video')
    } else if (filterInclusion === 'excluded') {
      list = list.filter(e => e.inclusion === 'excluded')
    }

    // Filter by severity range
    if (filterSeverityRange[0] > 0 || filterSeverityRange[1] < 10) {
      list = list.filter(e => e.severity >= filterSeverityRange[0] && e.severity <= filterSeverityRange[1])
    }

    // Sort
    list.sort((a, b) => {
      let av, bv
      switch (sortColumn) {
        case 'score':    av = a.score;    bv = b.score;    break
        case 'severity': av = a.severity; bv = b.severity; break
        case 'duration': av = a.duration; bv = b.duration; break
        case 'type':     av = a.event_type; bv = b.event_type; break
        case 'time':     av = a.start_time_seconds; bv = b.start_time_seconds; break
        default:         av = a.score;    bv = b.score;
      }
      if (av < bv) return sortDirection === 'asc' ? -1 : 1
      if (av > bv) return sortDirection === 'asc' ? 1 : -1
      return 0
    })

    return list
  }, [selection.scoredEvents, filterType, filterInclusion, filterSeverityRange, sortColumn, sortDirection])

  // ── Load configuration ─────────────────────────────────────────────────
  const loadConfig = useCallback(async (projectId) => {
    try {
      const config = await apiGet(`/projects/${projectId}/highlights/config`)
      if (config.weights && Object.keys(config.weights).length > 0) {
        setWeights({ ...DEFAULT_WEIGHTS, ...config.weights })
      }
      if (config.target_duration !== undefined) setTargetDuration(config.target_duration)
      if (config.min_severity !== undefined) setMinSeverity(config.min_severity)
      if (config.overrides && typeof config.overrides === 'object') setOverrides(config.overrides)
      if (config.params && typeof config.params === 'object') setParams({ ...DEFAULT_PARAMS, ...config.params })
    } catch (err) {
      console.error('[Highlights] Config load error:', err)
    }
  }, [])

  // ── Save configuration ─────────────────────────────────────────────────
  const saveConfig = useCallback(async (projectId) => {
    try {
      await apiPut(`/projects/${projectId}/highlights/config`, {
        weights,
        target_duration: targetDuration,
        min_severity: minSeverity,
        overrides,
        params,
      })
    } catch (err) {
      console.error('[Highlights] Config save error:', err)
    }
  }, [weights, targetDuration, minSeverity, overrides, params])

  // ── Apply selections to DB ─────────────────────────────────────────────
  const applyHighlights = useCallback(async (projectId) => {
    try {
      await apiPost(`/projects/${projectId}/highlights/apply`, {
        included_ids: selection.selectedIds,
        full_video_ids: selection.fullVideoIds,
        excluded_ids: selection.excludedIds,
      })
      // Also save the config
      await saveConfig(projectId)
    } catch (err) {
      console.error('[Highlights] Apply error:', err)
      throw err
    }
  }, [selection.selectedIds, selection.excludedIds, saveConfig])

  // ── Server-side reprocessing (v2 pipeline) ────────────────────────────────
  const [serverScoring, setServerScoring] = useState(false)
  const [serverScoredEvents, setServerScoredEvents] = useState(null)
  const [serverMetrics, setServerMetrics] = useState(null)

  const reprocessHighlights = useCallback(async (projectId, opts = {}) => {
    try {
      setServerScoring(true)
      const result = await apiPost(`/projects/${projectId}/highlights/reprocess`, {
        weights,
        constraints: {
          target_duration: targetDuration || 300,
          min_severity: minSeverity,
          pip_threshold: opts.pipThreshold || 7.0,
          max_driver_exposure: opts.maxDriverExposure || 0.25,
        },
      })
      if (result.scored_events) {
        setServerScoredEvents(result.scored_events)
        setServerMetrics(result.metrics || null)
      }
      return result
    } catch (err) {
      console.error('[Highlights] Server reprocess error:', err)
      throw err
    } finally {
      setServerScoring(false)
    }
  }, [weights, targetDuration, minSeverity])

  // ── Load drivers ───────────────────────────────────────────────────────
  const loadDrivers = useCallback(async (projectId) => {
    try {
      const result = await apiGet(`/projects/${projectId}/analysis/drivers`)
      setDrivers(result.drivers || [])
    } catch (err) {
      console.error('[Highlights] Drivers load error:', err)
    }
  }, [])

  // ── Weight mutation (with undo tracking) ────────────────────────────────
  const setWeight = useCallback((eventType, value) => {
    const clampedValue = Math.max(0, Math.min(100, value))
    setWeights(prev => {
      const oldValue = prev[eventType]
      // Only track if actually changed (avoid tracking slider drags that didn't move)
      if (oldValue !== clampedValue) {
        pushAction({
          type: 'weight_change',
          description: `${eventType} weight ${oldValue} → ${clampedValue}`,
          undo: () => { setWeights(w => ({ ...w, [eventType]: oldValue })) },
          redo: () => { setWeights(w => ({ ...w, [eventType]: clampedValue })) },
        })
      }
      return { ...prev, [eventType]: clampedValue }
    })
  }, [pushAction])

  // Raw setter without undo tracking (for undo/redo callbacks to avoid infinite loop)
  const _rawSetWeight = useCallback((eventType, value) => {
    setWeights(prev => ({ ...prev, [eventType]: Math.max(0, Math.min(100, value)) }))
  }, [])

  // ── Override mutation (with undo tracking) ──────────────────────────────
  const toggleOverride = useCallback((eventId) => {
    setOverrides(prev => {
      const eid = String(eventId)
      const current = normalizeOverride(prev[eid])
      const next = { ...prev }
      let newValue
      // Cycle: auto → highlight → full-video → exclude → auto
      if (current === 'highlight') {
        next[eid] = 'full-video'
        newValue = 'full-video'
      } else if (current === 'full-video') {
        next[eid] = 'exclude'
        newValue = 'exclude'
      } else if (current === 'exclude') {
        delete next[eid]
        newValue = null
      } else {
        next[eid] = 'highlight'
        newValue = 'highlight'
      }

      pushAction({
        type: 'override_toggle',
        description: `Override event #${eid}: ${current || 'auto'} → ${newValue || 'auto'}`,
        undo: () => {
          setOverrides(o => {
            const r = { ...o }
            if (current) { r[eid] = current } else { delete r[eid] }
            return r
          })
        },
        redo: () => {
          setOverrides(o => {
            const r = { ...o }
            if (newValue) { r[eid] = newValue } else { delete r[eid] }
            return r
          })
        },
      })

      return next
    })
  }, [pushAction])

  const setOverrideValue = useCallback((eventId, value) => {
    setOverrides(prev => {
      const eid = String(eventId)
      const oldValue = prev[eid] || null
      const next = { ...prev }
      if (value === null || value === undefined) {
        delete next[eid]
      } else {
        next[eid] = value
      }

      if (oldValue !== value) {
        pushAction({
          type: 'override_change',
          description: `Override event #${eid}: ${oldValue || 'auto'} → ${value || 'auto'}`,
          undo: () => {
            setOverrides(o => {
              const r = { ...o }
              if (oldValue) { r[eid] = oldValue } else { delete r[eid] }
              return r
            })
          },
          redo: () => {
            setOverrides(o => {
              const r = { ...o }
              if (value) { r[eid] = value } else { delete r[eid] }
              return r
            })
          },
        })
      }

      return next
    })
  }, [pushAction])

  // ── Auto-balance (with undo tracking) ──────────────────────────────────
  const autoBalance = useCallback(() => {
    const oldWeights = { ...weights }
    const newWeights = autoBalanceWeights(events)
    setWeights(newWeights)
    pushAction({
      type: 'auto_balance',
      description: 'Auto-balanced weights',
      undo: () => { setWeights(oldWeights) },
      redo: () => { setWeights(newWeights) },
    })
  }, [events, weights, pushAction])

  // ── A/B compare ───────────────────────────────────────────────────────
  const startABCompare = useCallback(() => {
    setConfigA({ weights: { ...weights }, targetDuration, minSeverity, overrides: { ...overrides } })
    setConfigB({ weights: { ...weights }, targetDuration, minSeverity, overrides: { ...overrides } })
    setActiveConfig('A')
    setAbMode(true)
  }, [weights, targetDuration, minSeverity, overrides])

  const stopABCompare = useCallback(() => {
    setAbMode(false)
    setConfigA(null)
    setConfigB(null)
  }, [])

  const switchABConfig = useCallback((which) => {
    // Save current state to current config slot
    const currentState = { weights: { ...weights }, targetDuration, minSeverity, overrides: { ...overrides } }
    if (activeConfig === 'A') {
      setConfigA(currentState)
    } else {
      setConfigB(currentState)
    }

    // Load the target config
    const target = which === 'A' ? configA : configB
    if (target) {
      setWeights(target.weights)
      setTargetDuration(target.targetDuration)
      setMinSeverity(target.minSeverity)
      setOverrides(target.overrides)
    }
    setActiveConfig(which)
  }, [activeConfig, configA, configB, weights, targetDuration, minSeverity, overrides])

  // ── Presets ────────────────────────────────────────────────────────────
  const loadPresets = useCallback(async () => {
    try {
      const result = await apiGet('/highlights/presets')
      setPresets(result.presets || [])
    } catch (err) {
      console.error('[Highlights] Presets load error:', err)
    }
  }, [])

  const savePreset = useCallback(async (name) => {
    try {
      await apiPost('/highlights/presets', {
        name,
        weights,
        target_duration: targetDuration,
        min_severity: minSeverity,
      })
      await loadPresets()
    } catch (err) {
      console.error('[Highlights] Preset save error:', err)
      throw err
    }
  }, [weights, targetDuration, minSeverity, loadPresets])

  const loadPreset = useCallback((preset) => {
    if (preset.weights) setWeights({ ...DEFAULT_WEIGHTS, ...preset.weights })
    if (preset.target_duration !== undefined) setTargetDuration(preset.target_duration)
    if (preset.min_severity !== undefined) setMinSeverity(preset.min_severity)
  }, [])

  const deletePreset = useCallback(async (name) => {
    try {
      await apiDelete(`/highlights/presets/${encodeURIComponent(name)}`)
      await loadPresets()
    } catch (err) {
      console.error('[Highlights] Preset delete error:', err)
      throw err
    }
  }, [loadPresets])

  // ── Navigate to event ─────────────────────────────────────────────────
  const jumpToEvent = useCallback((event) => {
    seekTo(event.start_time_seconds)
  }, [seekTo])

  // ── Table sorting ─────────────────────────────────────────────────────
  const handleSort = useCallback((column) => {
    setSortColumn(prev => {
      if (prev === column) {
        setSortDirection(d => d === 'asc' ? 'desc' : 'asc')
        return prev
      }
      setSortDirection('desc')
      return column
    })
  }, [])

  // ── Context value ─────────────────────────────────────────────────────
  const value = useMemo(() => ({
    // Weights
    weights,
    setWeight,
    setWeights,
    targetDuration,
    setTargetDuration,
    minSeverity,
    setMinSeverity,

    // Detection/camera params
    params,
    setParams,

    // Overrides
    overrides,
    toggleOverride,
    setOverrideValue,

    // Selection results
    selection,
    filteredEvents,
    metrics: selection.metrics,

    // Actions
    loadConfig,
    saveConfig,
    applyHighlights,
    loadDrivers,
    autoBalance,
    jumpToEvent,
    reprocessHighlights,

    // v2 scoring state
    serverScoring,
    serverScoredEvents,
    serverMetrics,

    // A/B compare
    abMode,
    activeConfig,
    startABCompare,
    stopABCompare,
    switchABConfig,

    // Presets
    presets,
    loadPresets,
    savePreset,
    loadPreset,
    deletePreset,

    // Sorting & filtering
    sortColumn,
    sortDirection,
    handleSort,
    filterType,
    setFilterType,
    filterInclusion,
    setFilterInclusion,
    filterSeverityRange,
    setFilterSeverityRange,

    // Drivers
    drivers,
  }), [
    weights, setWeight, targetDuration, minSeverity,
    params,
    overrides, toggleOverride, setOverrideValue,
    selection, filteredEvents,
    loadConfig, saveConfig, applyHighlights, loadDrivers, autoBalance, jumpToEvent,
    reprocessHighlights,
    serverScoring, serverScoredEvents, serverMetrics,
    abMode, activeConfig, startABCompare, stopABCompare, switchABConfig,
    presets, loadPresets, savePreset, loadPreset, deletePreset,
    sortColumn, sortDirection, handleSort,
    filterType, filterInclusion, filterSeverityRange,
    drivers,
  ])

  return (
    <HighlightContext.Provider value={value}>
      {children}
    </HighlightContext.Provider>
  )
}

/**
 * Hook to access highlight editing state and methods.
 */
export function useHighlight() {
  const context = useContext(HighlightContext)
  if (!context) {
    throw new Error('useHighlight must be used within a HighlightProvider')
  }
  return context
}
