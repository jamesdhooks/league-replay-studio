import { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef, useTransition } from 'react'
import { apiGet, apiPut, apiPost, apiDelete } from '../services/api'
import { useAnalysis } from './AnalysisContext'
import { useTimeline } from './TimelineContext'
import { useUndoRedo } from './UndoRedoContext'
import { useLocalStorage } from '../hooks/useLocalStorage'
import {
  TIER_COLORS,
  tierColor,
  computeEventScore,
  computeHighlightSelection,
  buildProductionTimeline,
  autoBalanceWeights,
  normalizeOverride,
  MANDATORY_TYPES,
} from '../utils/highlight-scoring'

// Re-export for consumers that import from HighlightContext
export { TIER_COLORS, tierColor }

export const HighlightContext = createContext(null)

/** Default weights for each event type (0–100 priority) */
const DEFAULT_WEIGHTS = {
  incident: 80,
  battle: 60,
  overtake: 70,
  pit_stop: 20,
  fastest_lap: 50,
  leader_change: 90,
  first_lap: 70,
  last_lap: 70,
  // SessionLog-sourced incident types (IncidentLogDetector)
  car_contact: 85,     // "Car Contact" (car-to-car) — high priority
  contact: 60,         // "Contact" (barrier/wall hit)
  lost_control: 50,    // "Lost Control" (spin)
  off_track: 25,       // "Off Track"
  turn_cutting: 15,    // "Turn Cutting"
  close_call: 40,
  race_start: 100,
  race_finish: 100,
  pace_lap: 50,
  overcut: 50,
  undercut: 50,
  pit_battle: 50,
}

/** Default detection/camera tuning parameters (inspired by iRacingReplayDirector) */
const DEFAULT_PARAMS = {
  battleStickyPeriod: 15,       // Seconds to track one battle before switching
  cameraStickyPeriod: 20,       // Seconds to hold one camera angle
  overtakeBoost: 1.5,           // Score multiplier for events with overtakes
  incidentPositionCutoff: 0,    // Ignore incidents from cars below this position (0 = disabled)
  firstLapWeight: 1.0,          // Multiplier for events in the first-lap sticky window
  lastLapWeight: 1.0,           // Multiplier for events in the last-lap sticky window
  preferredDrivers: '',         // Comma-separated preferred driver names (boost their events)
  preferredDriverBoost: 1.3,    // Score multiplier for preferred driver events
  // iRD-inspired tuning knobs
  battleFrontBias: 1.0,         // Extra multiplier for front-of-field battles (1.0 = off)
  preferredDriversOnly: false,  // When true, exclude events with no preferred driver
  ignoreIncidentsDuringFirstLap: false, // Suppress incident events in the first-lap bucket
  firstLapStickyPeriod: 0,      // Seconds from race start for firstLapWeight boost (0 = off)
  lastLapStickyPeriod: 0,       // Seconds before race end for lastLapWeight boost (0 = off)
  lateRaceThreshold: 0.9,       // Race fraction after which late-race bonus activates
  lateRaceMultiplier: 1.2,      // Multiplier applied to events beyond lateRaceThreshold
  pipThreshold: 7.0,            // Min score for two overlapping events to use Picture-in-Picture
  maxRaceFinishes: 0,           // Max race_finish events to include in highlights (0 = all)
  paddingBefore: 2.0,           // Default seconds before event start to include in each clip
  paddingAfter: 5.0,            // Default seconds after event end to include in each clip
  paddingByType: {},            // Per event-type padding overrides: { type: { before, after } }
  cameraWeights: {},            // Per-camera weight overrides: { group_name: 0–100 } — empty = all equal (50)
  cameraRecencyPenalty: 0.5,    // 0 = no recency penalty, 1 = maximum penalty for recently-used cameras
  cameraRecencyDecay: 30.0,     // Seconds for recency penalty to decay back to zero
  driverChangeProbability: 0.3, // Probability of switching driver focus on each camera cut (0–1)
  driverRecencyPenalty: 0.5,    // 0 = no recency penalty, 1 = maximum penalty for recently-shown drivers
  driverRecencyDecay: 60.0,     // Seconds for driver recency penalty to decay back to zero
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
  // SessionLog-sourced
  car_contact: 'Car Contact',
  contact: 'Contact',
  lost_control: 'Lost Control',
  off_track: 'Off Track',
  turn_cutting: 'Turn Cutting',
  close_call: 'Close Calls',
  pace_lap: 'Pace Lap',
  race_start: 'Race Start',
  race_finish: 'Race Finish',
  overcut: 'Overcut',
  undercut: 'Undercut',
  pit_battle: 'Pit Battle',
}


/**
 * HighlightProvider — manages highlight editing state.
 *
 * Runs the selection algorithm client-side for <100ms response,
 * persists config to backend, supports A/B compare and presets.
 */
export function HighlightProvider({ children }) {
  // ── Weight configuration (auto-persisted to localStorage) ────────────────
    const WEIGHTS_KEY = 'lrs:highlights:weights'
    const TARGET_KEY = 'lrs:highlights:targetDuration'
    const MIN_SEVERITY_KEY = 'lrs:highlights:minSeverity'
    const [weights, setWeights] = useLocalStorage(WEIGHTS_KEY, { ...DEFAULT_WEIGHTS })
    const [targetDuration, setTargetDuration] = useLocalStorage(TARGET_KEY, 12 * 60)
    const [minSeverity, setMinSeverity] = useLocalStorage(MIN_SEVERITY_KEY, 0)
  const [overrides, setOverrides] = useState({})    // { eventId: 'include'|'exclude' } — per-project, loaded from backend
    const PARAMS_KEY = 'lrs:highlights:params'
    const SECTION_CONFIG_KEY = 'lrs:highlights:sectionConfig'
    const CLIP_PADDING_KEY = 'lrs:highlights:clipPadding'
    const [params, setParams] = useLocalStorage(PARAMS_KEY, { ...DEFAULT_PARAMS })
  const [replayMode, setReplayMode] = useLocalStorage('lrs:highlights:replayMode', 'highlights')

  // ── One-time version migration: merge any new default keys into stored objects ──
  // This ensures newly-added default fields (e.g. new camera/padding params) appear
  // even when an older stored value is found in localStorage.
  useEffect(() => {
    setWeights(w => ({ ...DEFAULT_WEIGHTS, ...w }))
    setParams(p => {
      const merged = { ...DEFAULT_PARAMS, ...p }
      // Migration: remove hardcoded incident padding override that was previously
      // baked into DEFAULT_PARAMS — it silently blocked the global Lead-in slider.
      const pbt = { ...(merged.paddingByType || {}) }
      if (pbt.incident?.before === 2.0 && pbt.incident?.after === 8.0) {
        delete pbt.incident
        merged.paddingByType = pbt
      }
      return merged
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── A/B compare mode ────────────────────────────────────────────────────
  const [abMode, setAbMode] = useState(false)
  const [configA, setConfigA] = useState(null)       // { weights, targetDuration, minSeverity, overrides }
  const [configB, setConfigB] = useState(null)
  const [activeConfig, setActiveConfig] = useState('A')

  // ── Presets ─────────────────────────────────────────────────────────────
  const [presets, setPresets] = useState([])
  const [currentPresetId, setCurrentPresetId] = useState(null)  // Track which preset (if any) is loaded
  const [presetSnapshot, setPresetSnapshot] = useState(null)    // Snapshot of state when preset was loaded
  const [autoSavePreset, setAutoSavePreset] = useLocalStorage('lrs:highlights:autoSavePreset', false)

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
  const { raceDuration, seekTo, setSelectedEventId } = useTimeline()
  const { pushAction } = useUndoRedo()

  // React 19: Use transition for heavy reprocessing operations
  const [isReprocessing, startReprocessTransition] = useTransition()

  // ── Computed selection (memoised, <100ms) ───────────────────────────────
  const selection = useMemo(
    () => {
      const result = computeHighlightSelection(events, weights, targetDuration, minSeverity, overrides, raceDuration, drivers, params)
      if (replayMode === 'full') {
        return {
          ...result,
          scoredEvents: result.scoredEvents.map(e => ({ ...e, inclusion: 'highlight' })),
        }
      }
      return result
    },
    [replayMode, events, weights, targetDuration, minSeverity, overrides, raceDuration, drivers, params],
  )

  // ── Production timeline (overlap-aware, memoised) ─────────────────────
  const productionTimeline = useMemo(
    () => buildProductionTimeline(selection, targetDuration, params, raceDuration),
    [selection, targetDuration, params, raceDuration],
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
        case 'duration': av = a.selectionDuration ?? a.duration; bv = b.selectionDuration ?? b.duration; break
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
      
      // If localStorage already has user edits, keep local values authoritative.
      // This prevents stale backend config from "resetting" controls on refresh.
      const hasLocalWeights = localStorage.getItem(WEIGHTS_KEY) !== null
      const hasLocalTarget = localStorage.getItem(TARGET_KEY) !== null
      const hasLocalMinSeverity = localStorage.getItem(MIN_SEVERITY_KEY) !== null
      const hasLocalParams = localStorage.getItem(PARAMS_KEY) !== null
      
      if (!hasLocalWeights && config.weights && Object.keys(config.weights).length > 0) {
        setWeights({ ...DEFAULT_WEIGHTS, ...config.weights })
      }
      if (!hasLocalTarget && config.target_duration !== undefined) {
        setTargetDuration(config.target_duration)
      }
      if (!hasLocalMinSeverity && config.min_severity !== undefined) {
        setMinSeverity(config.min_severity)
      }
      if (config.overrides && typeof config.overrides === 'object') {
        setOverrides(config.overrides)
      }
      if (!hasLocalParams && config.params && typeof config.params === 'object') {
        setParams({ ...DEFAULT_PARAMS, ...config.params })
      }
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
  }, [selection.selectedIds, selection.fullVideoIds, selection.excludedIds, saveConfig])

  // ── Server-side reprocessing (v2 pipeline) ────────────────────────────────
  const [serverScoring, setServerScoring] = useState(false)
  const [serverScoredEvents, setServerScoredEvents] = useState(null)
  const [serverMetrics, setServerMetrics] = useState(null)

  // ── Video Script state ─────────────────────────────────────────────────
  const SCRIPT_CACHE_KEY = 'lrs:highlights:videoScript'
  const [videoScript, _setVideoScript]   = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(SCRIPT_CACHE_KEY) || 'null')
      return cached?.script ?? null
    } catch { return null }
  })
  const [videoSections, _setVideoSections] = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(SCRIPT_CACHE_KEY) || 'null')
      return cached?.sections ?? []
    } catch { return [] }
  })
  const [scriptProjectId, _setScriptProjectId] = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(SCRIPT_CACHE_KEY) || 'null')
      return cached?.projectId ?? null
    } catch { return null }
  })

  const setVideoScript = useCallback((script) => {
    _setVideoScript(script)
  }, [])
  const setVideoSections = useCallback((sections) => {
    _setVideoSections(sections)
  }, [])
  const [sectionConfig, setSectionConfig] = useLocalStorage(SECTION_CONFIG_KEY, {})  // Per-section overrides
  const [clipPadding, setClipPadding] = useLocalStorage(CLIP_PADDING_KEY, 0.5)       // Seconds of pre-roll
  // ── Script execution action log ────────────────────────────────────────
  // Each entry: { id, ts, eventType, section, cameraLabel, driverName, raceTime }
  // Uses both React state and a ref-based queue for reliable updates.
  // Periodic flush (50ms) ensures actions surface even if React batches updates.
  const [scriptActionLog, setScriptActionLog] = useState([])
  const actionQueueRef = useRef([])           // Queue of pending actions
  const flushTimerRef = useRef(null)          // Debounce timer for flushing
  const lastFlushTimeRef = useRef(0)

  // Immediately queue an action, then schedule a flush
  const pushScriptAction = useCallback((action) => {
    // Add to queue
    actionQueueRef.current.push(action)
    
    // Schedule flush if not already pending
    if (!flushTimerRef.current) {
      // Flush immediately if it's been >50ms since last flush
      const timeSinceLastFlush = Date.now() - lastFlushTimeRef.current
      if (timeSinceLastFlush > 50) {
        // Flush immediately
        const queued = actionQueueRef.current
        if (queued.length > 0) {
          actionQueueRef.current = []
          lastFlushTimeRef.current = Date.now()
          setScriptActionLog(prev => [...prev.slice(-(20 - queued.length)), ...queued])
        }
      } else {
        // Schedule flush after remaining time
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null
          const queued = actionQueueRef.current
          if (queued.length > 0) {
            actionQueueRef.current = []
            lastFlushTimeRef.current = Date.now()
            setScriptActionLog(prev => [...prev.slice(-(20 - queued.length)), ...queued])
          }
        }, 50 - timeSinceLastFlush)
      }
    }
  }, [])

  const clearScriptActionLog = useCallback(() => {
    // Clear both state and queue
    actionQueueRef.current = []
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
    flushTimerRef.current = null
    setScriptActionLog([])
  }, [])

  const reprocessHighlights = useCallback(async (projectId, opts = {}) => {
    try {
      setServerScoring(true)
      const result = await apiPost(`/projects/${projectId}/highlights/reprocess`, {
        weights,
        constraints: {
          target_duration: targetDuration || 300,
          min_severity: minSeverity,
          pip_threshold: params.pipThreshold ?? opts.pipThreshold ?? 7.0,
          max_driver_exposure: opts.maxDriverExposure || 0.25,
        },
        tuning: {
          battleFrontBias: params.battleFrontBias,
          preferredDriversOnly: params.preferredDriversOnly,
          preferredDrivers: params.preferredDrivers,
          preferredDriverBoost: params.preferredDriverBoost,
          ignoreIncidentsDuringFirstLap: params.ignoreIncidentsDuringFirstLap,
          firstLapStickyPeriod: params.firstLapStickyPeriod,
          lastLapStickyPeriod: params.lastLapStickyPeriod,
          firstLapWeight: params.firstLapWeight,
          lastLapWeight: params.lastLapWeight,
          lateRaceThreshold: params.lateRaceThreshold,
          lateRaceMultiplier: params.lateRaceMultiplier,
          overtakeBoost: params.overtakeBoost,
          incidentPositionCutoff: params.incidentPositionCutoff,
          maxRaceFinishes: params.maxRaceFinishes,
          battleStickyPeriod: params.battleStickyPeriod,
          cameraStickyPeriod: params.cameraStickyPeriod,
          driverChangeProbability: params.driverChangeProbability ?? 0.3,
          driverRecencyPenalty: params.driverRecencyPenalty ?? 0.5,
          driverRecencyDecay: params.driverRecencyDecay ?? 60.0,
        },
      })
      if (result.scored_events) {
        // Use transition to keep UI responsive during heavy state updates
        startReprocessTransition(() => {
          setServerScoredEvents(result.scored_events)
          setServerMetrics(result.metrics || null)
        })
      }
      return result
    } catch (err) {
      console.error('[Highlights] Server reprocess error:', err)
      throw err
    } finally {
      setServerScoring(false)
    }
  }, [weights, targetDuration, minSeverity, startReprocessTransition])

  const generateVideoScript = useCallback(async (projectId, opts = {}) => {
    try {
      setServerScoring(true)
      // Build full camera_weights: default 50 for any camera not explicitly set
      const userWeights = params.cameraWeights || {}
      const fullCameraWeights = {}
      if (opts.cameras?.length) {
        for (const cam of opts.cameras) {
          fullCameraWeights[cam.group_name] = userWeights[cam.group_name] ?? 50
        }
      } else {
        // No camera list available — send user overrides as-is
        Object.assign(fullCameraWeights, userWeights)
      }
      const result = await apiPost(`/projects/${projectId}/highlights/video-script`, {
        weights,
        constraints: {
          target_duration: targetDuration || 300,
          min_severity: minSeverity,
          pip_threshold: params.pipThreshold ?? opts.pipThreshold ?? 7.0,
          max_driver_exposure: opts.maxDriverExposure || 0.25,
        },
        tuning: {
          battleFrontBias: params.battleFrontBias,
          preferredDriversOnly: params.preferredDriversOnly,
          preferredDrivers: params.preferredDrivers,
          preferredDriverBoost: params.preferredDriverBoost,
          ignoreIncidentsDuringFirstLap: params.ignoreIncidentsDuringFirstLap,
          firstLapStickyPeriod: params.firstLapStickyPeriod,
          lastLapStickyPeriod: params.lastLapStickyPeriod,
          firstLapWeight: params.firstLapWeight,
          lastLapWeight: params.lastLapWeight,
          lateRaceThreshold: params.lateRaceThreshold,
          lateRaceMultiplier: params.lateRaceMultiplier,
          overtakeBoost: params.overtakeBoost,
          incidentPositionCutoff: params.incidentPositionCutoff,
          maxRaceFinishes: params.maxRaceFinishes,
          battleStickyPeriod: params.battleStickyPeriod,
          cameraStickyPeriod: params.cameraStickyPeriod,
          driverChangeProbability: params.driverChangeProbability ?? 0.3,
          driverRecencyPenalty: params.driverRecencyPenalty ?? 0.5,
          driverRecencyDecay: params.driverRecencyDecay ?? 60.0,
        },
        section_config: sectionConfig,
        clip_padding: params.paddingBefore,
        clip_padding_after: params.paddingAfter,
        padding_by_type: params.paddingByType || {},
        camera_weights: fullCameraWeights,
        camera_recency_penalty: params.cameraRecencyPenalty ?? 0.5,
        camera_recency_decay: params.cameraRecencyDecay ?? 30.0,
        production_timeline: productionTimeline?.timeline || [],
      })
      if (result.script) {
        const pid = projectId
        _setScriptProjectId(pid)
        setVideoScript(result.script)
        setVideoSections(result.sections || [])
        try {
          localStorage.setItem(SCRIPT_CACHE_KEY, JSON.stringify({
            projectId: pid,
            script: result.script,
            sections: result.sections || [],
          }))
        } catch { /* storage full — non-fatal */ }
      }
      if (result.scored_events) {
        setServerScoredEvents(result.scored_events)
        setServerMetrics(result.metrics || null)
      }
      return result
    } catch (err) {
      console.error('[Highlights] Video script generation error:', err)
      throw err
    } finally {
      setServerScoring(false)
    }
  }, [weights, targetDuration, minSeverity, sectionConfig, params, productionTimeline])

  const updateSectionConfig = useCallback((sectionName, updates) => {
    setSectionConfig(prev => ({
      ...prev,
      [sectionName]: { ...(prev[sectionName] || {}), ...updates },
    }))
  }, [])

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
        params,
        section_config: sectionConfig,
        replay_mode: replayMode,
      })
      // After saving, update the current preset and snapshot
      setCurrentPresetId(name)
      setPresetSnapshot({
        weights,
        target_duration: targetDuration,
        min_severity: minSeverity,
        params,
        section_config: sectionConfig,
        replay_mode: replayMode,
      })
      await loadPresets()
    } catch (err) {
      console.error('[Highlights] Preset save error:', err)
      throw err
    }
  }, [weights, targetDuration, minSeverity, params, sectionConfig, replayMode, loadPresets])

  const loadPreset = useCallback((preset) => {
    if (preset.weights) setWeights({ ...DEFAULT_WEIGHTS, ...preset.weights })
    if (preset.target_duration !== undefined) setTargetDuration(preset.target_duration)
    if (preset.min_severity !== undefined) setMinSeverity(preset.min_severity)
    const nextParams = (preset.params && typeof preset.params === 'object')
      ? { ...DEFAULT_PARAMS, ...preset.params }
      : params
    const nextSectionConfig = (preset.section_config && typeof preset.section_config === 'object')
      ? preset.section_config
      : sectionConfig
    const nextReplayMode = (preset.replay_mode === 'highlights' || preset.replay_mode === 'full')
      ? preset.replay_mode
      : replayMode

    if (preset.params && typeof preset.params === 'object') setParams(nextParams)
    if (preset.section_config && typeof preset.section_config === 'object') setSectionConfig(nextSectionConfig)
    if (preset.replay_mode === 'highlights' || preset.replay_mode === 'full') setReplayMode(nextReplayMode)
    
    // Save snapshot of preset state for unsaved changes detection
    setCurrentPresetId(preset.name || preset.id)
    setPresetSnapshot({
      weights: { ...DEFAULT_WEIGHTS, ...(preset.weights || {}) },
      target_duration: preset.target_duration,
      min_severity: preset.min_severity,
      params: nextParams,
      section_config: nextSectionConfig,
      replay_mode: nextReplayMode,
    })
  }, [params, sectionConfig, replayMode, setParams, setSectionConfig, setReplayMode])

  const deletePreset = useCallback(async (name) => {
    try {
      await apiDelete(`/highlights/presets/${encodeURIComponent(name)}`)
      // If the deleted preset was the currently selected one, clear it
      if (currentPresetId === name) {
        setCurrentPresetId(null)
        setPresetSnapshot(null)
        setAutoSavePreset(false)
      }
      await loadPresets()
    } catch (err) {
      console.error('[Highlights] Preset delete error:', err)
      throw err
    }
  }, [loadPresets, currentPresetId])

  // ── Navigate to event ─────────────────────────────────────────────────
  const jumpToEvent = useCallback((event) => {
    seekTo(event.start_time_seconds)
    setSelectedEventId(event.id)
  }, [seekTo, setSelectedEventId])

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

  // ── Unsaved changes detection ──────────────────────────────────────────
  const hasUnsavedChanges = useMemo(() => {
    // If a preset is loaded, check if current state differs from snapshot
    if (presetSnapshot) {
      return (
        JSON.stringify(weights) !== JSON.stringify(presetSnapshot.weights) ||
        targetDuration !== presetSnapshot.target_duration ||
        minSeverity !== presetSnapshot.min_severity ||
        JSON.stringify(params) !== JSON.stringify(presetSnapshot.params || DEFAULT_PARAMS) ||
        JSON.stringify(sectionConfig) !== JSON.stringify(presetSnapshot.section_config || {}) ||
        replayMode !== (presetSnapshot.replay_mode || 'highlights')
      )
    }
    
    // If no preset is loaded, check if any values differ from defaults
    return (
      JSON.stringify(weights) !== JSON.stringify(DEFAULT_WEIGHTS) ||
      targetDuration !== (12 * 60) ||
      minSeverity !== 0 ||
      JSON.stringify(params) !== JSON.stringify(DEFAULT_PARAMS) ||
      JSON.stringify(sectionConfig) !== JSON.stringify({}) ||
      replayMode !== 'highlights'
    )
  }, [weights, targetDuration, minSeverity, params, sectionConfig, replayMode, presetSnapshot])

  // ── Auto-save: persist preset whenever changes are detected ───────────
  const _autoSaveTimer = useRef(null)
  useEffect(() => {
    if (!autoSavePreset || !currentPresetId || !hasUnsavedChanges) return
    // Debounce 800 ms so rapid slider drags don't flood the API
    clearTimeout(_autoSaveTimer.current)
    _autoSaveTimer.current = setTimeout(() => {
      savePreset(currentPresetId).catch(() => {})
    }, 800)
    return () => clearTimeout(_autoSaveTimer.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSavePreset, currentPresetId, hasUnsavedChanges, weights, targetDuration, minSeverity, params, sectionConfig, replayMode])

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

    // Replay mode
    replayMode,
    setReplayMode,

    // Overrides
    overrides,
    toggleOverride,
    setOverrideValue,

    // Selection results
    selection,
    productionTimeline,
    productionMetrics: productionTimeline?.metrics || {},
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
    isReprocessing,

    // Video Script
    videoScript,
    videoSections,
    scriptProjectId,
    sectionConfig,
    clipPadding,
    setClipPadding,
    generateVideoScript,
    updateSectionConfig,
    // Script execution log
    scriptActionLog,
    pushScriptAction,
    clearScriptActionLog,

    // A/B compare
    abMode,
    activeConfig,
    startABCompare,
    stopABCompare,
    switchABConfig,

    // Presets
    presets,
    currentPresetId,
    hasUnsavedChanges,
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
    selection, productionTimeline, filteredEvents,
    loadConfig, saveConfig, applyHighlights, loadDrivers, autoBalance, jumpToEvent,
    reprocessHighlights, generateVideoScript, updateSectionConfig,
    serverScoring, serverScoredEvents, serverMetrics,
    videoScript, videoSections, scriptProjectId, sectionConfig, clipPadding,
    abMode, activeConfig, startABCompare, stopABCompare, switchABConfig,
    presets, currentPresetId, hasUnsavedChanges, loadPresets, savePreset, loadPreset, deletePreset,
    autoSavePreset, setAutoSavePreset,
    sortColumn, sortDirection, handleSort,
    filterType, filterInclusion, filterSeverityRange,
    drivers,
    replayMode, setReplayMode,
  ])

  // ── Cleanup: ensure flush timer and queues are cleared ───────────────
  useEffect(() => {
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
      actionQueueRef.current = []
    }
  }, [])

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
