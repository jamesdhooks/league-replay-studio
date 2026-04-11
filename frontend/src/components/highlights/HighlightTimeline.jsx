import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { useHighlight, EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { useTimeline, EVENT_COLORS } from '../../context/TimelineContext'
import { useIRacing } from '../../context/IRacingContext'
import { useProject } from '../../context/ProjectContext'
import { apiGet, apiPost } from '../../services/api'
import { formatTime } from '../../utils/time'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { useToast } from '../../context/ToastContext'
import TimelineToolbar from '../timeline/TimelineToolbar'
import RangeSlider from '../ui/RangeSlider'
import { ChevronDown, ChevronRight, Film, Play, Pause, SkipBack, SkipForward, FileText, Copy, X, Loader2 } from 'lucide-react'


/**
 * HighlightTimeline — Final Script Timeline (NLS / edit-order view).
 *
 * IMPORTANT: Segments are displayed in EDIT ORDER with sequential positioning —
 * not at race-time. This eliminates gaps between clips and shows the final video
 * as it will actually be cut: Intro → Qualifying Results → Race Clips → Results.
 *
 * Tracks (top → bottom):
 *   Section row  — coloured band per section (Intro / Qualifying / Race / Results)
 *   Camera track — iRacing camera group assigned to each clip
 *   Events track — clip blocks coloured by type / section
 *   Tick ruler   — edit time (final video minutes:seconds)
 *
 * Execute Script drives iRacing replay through every segment in script order.
 */

// ── Edit-timeline layout constants ──────────────────────────────────────────
const SECTION_H    = 18   // section label row
const CAM_H        = 34   // camera track
const DRIVER_H     = 44   // driver focus track (extra height for sub-window bands)
const EVT_H        = 46   // events track
const TICK_H       = 24   // tick ruler
const TOTAL_TRACK_H = SECTION_H + CAM_H + EVT_H + TICK_H
const GUTTER_W     = 52
const EDIT_PX_PER_SEC = 20  // pixels per second in edit time (fixed scale)

const isFillerSegment = (seg) => seg?.type === 'broll' || seg?.type === 'bridge' || seg?.type === 'context'

// ── Section metadata ─────────────────────────────────────────────────────────
const SECTION_ORDER = ['intro', 'qualifying_results', 'race', 'race_results']

const SECTION_META = {
  intro:              { label: 'Intro',      color: 'rgba(139,92,246,0.28)',  border: 'rgba(139,92,246,0.55)', text: 'rgba(192,165,255,0.95)' },
  qualifying_results: { label: 'Qualifying', color: 'rgba(6,182,212,0.20)',   border: 'rgba(6,182,212,0.48)',  text: 'rgba(103,232,249,0.95)' },
  race:               { label: 'Race',       color: 'rgba(249,115,22,0.15)',  border: 'rgba(249,115,22,0.40)', text: 'rgba(253,186,116,0.95)' },
  race_results:       { label: 'Results',    color: 'rgba(34,197,94,0.20)',   border: 'rgba(34,197,94,0.45)',  text: 'rgba(134,239,172,0.95)' },
}

// ── Camera assignment helpers ─────────────────────────────────────────────────
const DEFAULT_CAM = {
  battle: 'TV1', overtake: 'TV1',
  crash: 'Cockpit', incident: 'Cockpit', spinout: 'Cockpit',
  contact: 'Bumper', close_call: 'Bumper',
  race_start: 'TV Scenic', race_finish: 'TV Scenic',
  fastest_lap: 'TV1', pit_stop: 'Pit Lane',
  leader_change: 'TV1', first_lap: 'TV Scenic', last_lap: 'TV1',
}

function getCameraLabel(seg, cameraOverrides) {
  const prefs = seg?.camera_preferences
  if (prefs?.length) {
    const overrideIdx = cameraOverrides?.[seg.id]
    if (overrideIdx != null && overrideIdx < prefs.length) return prefs[overrideIdx]
    return prefs[0]
  }
  if (seg?.camera_hints?.establishing_angle) return seg.camera_hints.establishing_angle
  return DEFAULT_CAM[seg?.event_type] || 'TV1'
}

/**
 * Returns the ordered list of car_idx values that are actually fighting at
 * `sessionTime` within this segment, using the stored `driver_windows` when
 * present (merged multi-driver battles).  Falls back to `involved_drivers`.
 */
function getActiveDrivers(seg, sessionTime) {
  const windows = seg?.metadata?.driver_windows
  const allDrivers = seg?.involved_drivers || []
  if (!windows || windows.length === 0 || sessionTime == null) return allDrivers
  const active = new Set()
  for (const w of windows) {
    if (sessionTime >= w.start_time && sessionTime <= w.end_time) {
      for (const d of w.drivers) active.add(d)
    }
  }
  // If the playhead is outside every window (e.g. tail padding), show all
  return active.size > 0 ? allDrivers.filter(d => active.has(d)) : allDrivers
}

function fmtDur(sec) {
  if (!sec || sec <= 0) return '0s'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

// Formats a raw race session time (seconds) as a compact H:MM:SS clock, e.g. "1:23:45".
function fmtRaceTime(sec) {
  if (sec == null || sec < 0) return '--:--'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

function buildScriptReportText(scriptReport, editSegments) {
  if (!scriptReport) return 'No script data.'
  const lines = []
  const hr = '─'.repeat(80)
  const pad = (s, n) => String(s).padEnd(n)
  lines.push('RACE SCRIPT — FULL SEGMENT LIST')
  lines.push(hr)
  lines.push(pad('#', 4) + pad('Section', 14) + pad('Type', 14) + pad('Event', 18) + pad('Start', 9) + pad('Dur', 8) + pad('Camera', 14) + 'Drivers')
  lines.push('─'.repeat(80))
  editSegments.forEach((seg, i) => {
    const num   = pad(i + 1, 4)
    const sec   = pad(seg.section || 'race', 14)
    const tp    = pad(seg.type || '—', 14)
    const evt   = pad(EVENT_TYPE_LABELS[seg.event_type] || seg.event_type || '—', 18)
    const t     = pad(formatTime(seg.start_time_seconds || 0), 9)
    const dur   = pad(fmtDur(seg.editDur || 0), 8)
    const cam   = pad(getCameraLabel(seg), 14)
    const drv   = (seg.driver_names || []).join(', ') || '—'
    lines.push(num + sec + tp + evt + t + dur + cam + drv)
  })
  lines.push('')
  lines.push(hr)
  lines.push('SUMMARY')
  lines.push(hr)
  lines.push(`Total segments:  ${editSegments.length}`)
  lines.push(`Event clips:     ${scriptReport.eventClips.length - scriptReport.cameraCuts}`)
  lines.push(`Camera cuts:     ${scriptReport.cameraCuts}`)
  lines.push(`Context fills:   ${scriptReport.contextClips.length}`)
  lines.push(`Bridge cuts:     ${scriptReport.bridgeClips.length}`)
  lines.push(`Sections:        ${scriptReport.sectionClips.length}`)
  lines.push('')
  lines.push(`Total video:     ${fmtDur(scriptReport.totalVideo)}`)
  lines.push(`  Events:        ${fmtDur(scriptReport.totalEvent)}`)
  lines.push(`  Context:       ${fmtDur(scriptReport.totalContext)}`)
  lines.push(`  Sections:      ${fmtDur(scriptReport.totalSection)}`)
  lines.push('')
  lines.push('BY TYPE')
  const entries = Object.entries(scriptReport.byType || {}).sort((a, b) => b[1] - a[1])
  for (const [type, count] of entries) {
    lines.push(`  ${pad(EVENT_TYPE_LABELS[type] || type, 22)} ${count}`)
  }
  return lines.join('\n')
}

// ── Main component ────────────────────────────────────────────────────────────
export default function HighlightTimeline({ onInspect }) {
  const { videoScript, metrics, pushScriptAction, clearScriptActionLog, serverScoring, productionTimeline } = useHighlight()
  const { isConnected, sessionData } = useIRacing()
  const { activeProject } = useProject()
  const { showError } = useToast()
  const { setSelectedEventId, seekTo, events } = useTimeline()

  const [collapsed, setCollapsed] = useLocalStorage('lrs:editing:timeline:collapsed', false)
  const [executing, setExecuting] = useState(false)
  const [paused, setPaused]         = useState(false)
  const [activeSegId, setActiveSegId] = useState(null)
  const abortRef   = useRef({ cancelled: false })
  const pausedRef  = useRef(false)
  const [replaySpeed, setReplaySpeed] = useLocalStorage('lrs:editing:timeline:speed', 1)
  const [replayState, setReplayState] = useState(null)
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false)
  const [scrubSegId, setScrubSegId] = useState(null)
  const [optimisticEditTime, setOptimisticEditTime] = useState(null)
  const scriptClockRef   = useRef(null)   // browser-authoritative playback clock during execution
  const scriptTickRef    = useRef(null)   // interval handle for the 50 ms UI-refresh tick
  const scrubResyncRef   = useRef(null)   // { editTime } set by scrub during execution to skip loop forward
  const [scriptEditTime, setScriptEditTime] = useState(null) // edit-time broadcast during execution
  const replayStateRef   = useRef(null)   // latest polled iRacing state (for drift check)
  const raceSessionNumRef = useRef(0)     // stable ref so ticker can seek without stale closure
  const [driftS, setDriftS] = useState(null) // null = not executing; number = drift in seconds
  const [showScriptReport, setShowScriptReport] = useState(false)
  const [seekError, setSeekError] = useState(null)
  const scrollRef = useRef(null)
  // segId → car_idx override for driver focus; reset whenever script is regenerated
  const [driverFocusOverrides, setDriverFocusOverrides] = useState({})
  useEffect(() => { setDriverFocusOverrides({}) }, [videoScript])
  // segId → camera_preferences index override
  const [cameraOverrides, setCameraOverrides] = useState({})
  useEffect(() => { setCameraOverrides({}) }, [videoScript])

  // Resolve the original production segment that this script segment came from.
  // This mirrors histogram behavior which operates on productionTimeline segments.
  const resolveProductionSegment = useCallback((seg) => {
    const prod = productionTimeline?.timeline || []
    if (!seg || prod.length === 0) return null
    const direct = prod.find(p => String(p.id) === String(seg.id))
    if (direct) return direct
    const segStart = seg.start_time_seconds ?? seg.clipStartTime ?? 0
    const segEnd = seg.end_time_seconds ?? seg.clipEndTime ?? segStart
    const segType = seg.event_type || null
    return prod.find(p => {
      const pStart = p.start_time_seconds ?? p.coreStart ?? p.clipStart ?? 0
      const pEnd = p.end_time_seconds ?? p.coreEnd ?? p.clipEnd ?? pStart
      const overlap = Math.max(0, Math.min(segEnd, pEnd) - Math.max(segStart, pStart))
      return overlap > 0 && (!segType || p.event_type === segType)
    }) || null
  }, [productionTimeline])

  // Map a script segment back to a concrete event ID used by EventInspector.
  const resolveInspectorEventId = useCallback((seg) => {
    if (!seg) return null
    const prodSeg = resolveProductionSegment(seg)
    const firstSource = (s) => {
      if (!Array.isArray(s?.sourceEvents) || s.sourceEvents.length === 0) return null
      const src0 = s.sourceEvents[0]
      return (src0 && typeof src0 === 'object') ? src0.id : src0
    }
    const candidates = [
      prodSeg?.primaryEventId,
      firstSource(prodSeg),
      seg.primaryEventId,
      firstSource(seg),
      seg.id,
    ]

    for (const raw of candidates) {
      if (raw == null) continue
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw
      const s = String(raw).trim()
      if (/^\d+$/.test(s)) return Number(s)
      const m = s.match(/(?:^event[_-]?|^evt[_-]?|[_-])(\d+)$/i)
      if (m) return Number(m[1])
      // Preserve non-numeric IDs (UUIDs / prefixed IDs) for inspector lookup.
      if (s.length > 0) return s
    }
    return null
  }, [resolveProductionSegment])

  // Resolve to the actual event object used by the inspector/event table.
  const resolveInspectorEvent = useCallback((seg) => {
    const targetId = resolveInspectorEventId(seg)
    if (targetId == null || !Array.isArray(events) || events.length === 0) return null
    const direct = events.find(e => String(e.id) === String(targetId))
    if (direct) return direct

    // Last-resort fallback: closest overlapping event by time and type
    const segStart = seg?.start_time_seconds ?? seg?.clipStartTime ?? 0
    const segEnd = seg?.end_time_seconds ?? seg?.clipEndTime ?? segStart
    const segType = seg?.event_type
    const candidates = events.filter(e => {
      if (segType && e.event_type !== segType) return false
      const eStart = e.start_time_seconds ?? 0
      const eEnd = e.end_time_seconds ?? eStart
      return Math.max(0, Math.min(segEnd, eEnd) - Math.max(segStart, eStart)) > 0
    })
    if (candidates.length === 0) return null
    candidates.sort((a, b) => {
      const ad = Math.abs((a.start_time_seconds ?? 0) - segStart)
      const bd = Math.abs((b.start_time_seconds ?? 0) - segStart)
      return ad - bd
    })
    return candidates[0] || null
  }, [events, resolveInspectorEventId])

  const inspectFromSegment = useCallback((seg, source = 'timeline') => {
    const targetId = resolveInspectorEventId(seg)
    const matchedEvent = resolveInspectorEvent(seg)
    console.debug('[Timeline->Inspector] click', {
      source,
      segId: seg?.id,
      segType: seg?.type,
      segEventType: seg?.event_type,
      primaryEventId: seg?.primaryEventId,
      sourceEvents: seg?.sourceEvents,
      resolvedTargetId: targetId,
      matchedEventId: matchedEvent?.id ?? null,
      eventsCount: Array.isArray(events) ? events.length : 0,
      sampleEventIds: Array.isArray(events) ? events.slice(0, 5).map(e => e.id) : [],
    })

    if (!matchedEvent) {
      console.warn('[Timeline->Inspector] no matching event for clicked segment', {
        source,
        segId: seg?.id,
        resolvedTargetId: targetId,
      })
      return
    }

    setSelectedEventId(matchedEvent.id)
    seekTo(matchedEvent.start_time_seconds ?? 0)
    onInspect?.()
  }, [events, onInspect, resolveInspectorEvent, resolveInspectorEventId, seekTo, setSelectedEventId])

  // Range slider state (0–1 fractions of total edit duration)
  const [rangeStart, setRangeStart] = useState(0)
  const [rangeEnd, setRangeEnd] = useState(1)
  const syncingRef = useRef(false)

  // Measure track container so zoom/height are responsive
  const [containerW, setContainerW] = useState(0)
  const [containerH, setContainerH] = useState(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => {
      setContainerW(el.clientWidth)
      setContainerH(el.clientHeight)
    }
    measure()
    const obs = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerW(entry.contentRect.width)
        setContainerH(entry.contentRect.height)
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [collapsed, videoScript?.length])

  const setRange = useCallback((s, e) => {
    setRangeStart(s)
    setRangeEnd(e)
  }, [])

  const [raceSessionNum, setRaceSessionNum] = useState(0)
  useEffect(() => {
    if (!activeProject?.id) return
    apiGet(`/projects/${activeProject.id}/analysis/race-duration`)
      .then(d => setRaceSessionNum(d?.race_session_num ?? 0))
      .catch(() => {})
  }, [activeProject?.id])
  // Keep refs in sync so ticker closures can read current values.
  useEffect(() => { raceSessionNumRef.current = raceSessionNum }, [raceSessionNum])

  // Poll replay state so playhead can track true iRacing position.
  useEffect(() => {
    if (!isConnected) {
      setReplayState(null)
      return
    }
    const tick = () => {
      apiGet('/iracing/replay/state')
        .then(data => { setReplayState(data || null); replayStateRef.current = data || null })
        .catch(() => {})
    }
    tick()
    const interval = setInterval(tick, 350)
    return () => clearInterval(interval)
  }, [isConnected])

  // ── Build sequential edit segments ─────────────────────────────────────────
  // Converts videoScript (race-time positions) into edit-time (sequential).
  // Sections are ordered: intro → qualifying_results → race clips → race_results
  // Within the race section, clips are sorted by their race start_time_seconds.
  const editSegments = useMemo(() => {
    if (!videoScript?.length) return []

    const filtered = videoScript.filter(s => s.type !== 'transition')

    // Sort by section, then by race start time within each section
    const sorted = [...filtered].sort((a, b) => {
      const ai = SECTION_ORDER.indexOf(a.section || 'race')
      const bi = SECTION_ORDER.indexOf(b.section || 'race')
      if (ai !== bi) return ai - bi
      return (a.start_time_seconds || 0) - (b.start_time_seconds || 0)
    })

    // Assign sequential edit positions — no gaps.
    // Use padded clip window so final script duration reflects lead-in/follow-out.
    let cursor = 0
    return sorted.map(seg => {
      const rawStart = seg.start_time_seconds || 0
      const rawEnd = seg.end_time_seconds || rawStart
      const padBefore = Math.max(0, Number(seg.clip_padding || 0))
      const padAfter = Math.max(0, Number(seg.clip_padding_after || 0))
      const clipStartTime = Math.max(0, rawStart - padBefore)
      const clipEndTime = Math.max(clipStartTime + 1, rawEnd + padAfter)
      const dur = Math.max(1, clipEndTime - clipStartTime)
      const editStart = cursor
      // Bridges are instant cuts — zero edit-time contribution
      const isBridge = seg.type === 'bridge'
      if (!isBridge) cursor += dur
      return { ...seg, editStart, editEnd: cursor, editDur: isBridge ? 0 : dur, clipStartTime, clipEndTime }
    })
  }, [videoScript])

  const hasData = editSegments.length > 0

  // Section spans for the section row
  const sectionSpans = useMemo(() => {
    const spans = {}
    for (const seg of editSegments) {
      const s = seg.section || 'race'
      if (!spans[s]) spans[s] = { editStart: seg.editStart, editEnd: seg.editEnd }
      else {
        spans[s].editStart = Math.min(spans[s].editStart, seg.editStart)
        spans[s].editEnd   = Math.max(spans[s].editEnd,   seg.editEnd)
      }
    }
    return spans
  }, [editSegments])

  const totalEditDuration = editSegments.length > 0
    ? editSegments[editSegments.length - 1].editEnd : 0

  // Dynamic zoom: the scrollable content width = containerW / rangeWidth so that
  // the range slider zoom level stretches/shrinks the timeline instead of panning.
  const rangeWidth = rangeEnd - rangeStart
  const baseContentW = containerW > 0
    ? containerW
    : Math.max(totalEditDuration * EDIT_PX_PER_SEC, 600)
  const activeContentW = baseContentW / Math.max(0.02, rangeWidth)
  const activePxPerSec = totalEditDuration > 0 ? activeContentW / totalEditDuration : EDIT_PX_PER_SEC
  // Dynamic height: clips track stretches to fill available height
  const dynamicEvtH = Math.max(EVT_H, containerH > 0 ? containerH - SECTION_H - CAM_H - DRIVER_H - TICK_H : EVT_H)
  const totalTrackH = SECTION_H + CAM_H + DRIVER_H + dynamicEvtH + TICK_H

  const toX = useCallback((t) => t * activePxPerSec, [activePxPerSec])

  const effectiveActiveSegId = scrubSegId || activeSegId

  // Session-time (race timeline) -> edit-time (final-script timeline) mapping.
  const mapSessionTimeToEditTime = useCallback((sessionTime, preferredSegId = null) => {
    if (!editSegments.length || sessionTime == null) return null

    const containing = editSegments.filter(seg => {
      const s = seg.clipStartTime ?? seg.start_time_seconds ?? 0
      const e = seg.clipEndTime ?? seg.end_time_seconds ?? s
      return sessionTime >= s && sessionTime <= e
    })

    let seg = containing[0]
    if (preferredSegId) {
      const preferred = containing.find(s => s.id === preferredSegId)
      if (preferred) seg = preferred
    }

    if (!seg) {
      seg = editSegments.reduce((best, cur) => {
        const bestDist = Math.abs((best.clipStartTime ?? best.start_time_seconds ?? 0) - sessionTime)
        const curDist = Math.abs((cur.clipStartTime ?? cur.start_time_seconds ?? 0) - sessionTime)
        return curDist < bestDist ? cur : best
      }, editSegments[0])
    }

    const segStart = seg.clipStartTime ?? seg.start_time_seconds ?? 0
    const segEnd = seg.clipEndTime ?? seg.end_time_seconds ?? segStart
    const offset = Math.max(0, Math.min(seg.editDur, sessionTime - segStart))
    const maxOffset = Math.max(0, segEnd - segStart)
    return seg.editStart + Math.max(0, Math.min(offset, maxOffset))
  }, [editSegments])

  // Edit-time -> race session-time (used to sync histogram playhead during scrub).
  const mapEditTimeToRaceTime = useCallback((editTime) => {
    if (!editSegments.length || editTime == null) return null
    const clamped = Math.max(0, Math.min(totalEditDuration, editTime))
    const seg = editSegments.find(s => clamped >= s.editStart && clamped <= s.editEnd)
      || editSegments[editSegments.length - 1]
    if (!seg) return null
    const offset = Math.max(0, Math.min(seg.editDur, clamped - seg.editStart))
    const clipStart = seg.clipStartTime ?? seg.start_time_seconds ?? 0
    const clipEnd   = seg.clipEndTime   ?? seg.end_time_seconds   ?? clipStart
    const ratio     = seg.editDur > 0 ? offset / seg.editDur : 0
    return clipStart + ratio * Math.max(0, clipEnd - clipStart)
  }, [editSegments, totalEditDuration])

  // Edit-time -> segment + offset mapping used by drag release.
  const resolveSegmentAtEditTime = useCallback((editTime) => {
    if (!editSegments.length || editTime == null) return null
    const clamped = Math.max(0, Math.min(totalEditDuration, editTime))
    const seg = editSegments.find(s => clamped >= s.editStart && clamped <= s.editEnd)
      || editSegments[editSegments.length - 1]
    if (!seg) return null
    return {
      seg,
      segmentEditOffset: Math.max(0, Math.min(seg.editDur, clamped - seg.editStart)),
    }
  }, [editSegments, totalEditDuration])

  const getEditTimeFromClientX = useCallback((clientX) => {
    const el = scrollRef.current
    if (!el || activeContentW <= 0 || totalEditDuration <= 0) return 0
    const rect = el.getBoundingClientRect()
    const x = clientX - rect.left + el.scrollLeft
    const pct = Math.max(0, Math.min(1, x / activeContentW))
    return pct * totalEditDuration
  }, [activeContentW, totalEditDuration])

  // ── Driver focus helpers ────────────────────────────────────────────────────
  // Returns the car_idx the camera should follow for this segment at sessionTime.
  // Filters candidates to only drivers active in their battle window at that time.
  const getFocusCarIdx = useCallback((seg, sessionTime = null) => {
    const candidates = getActiveDrivers(seg, sessionTime)
    const override   = driverFocusOverrides[seg.id]
    // If there's a stored override and it's still a valid candidate, use it
    if (override != null && candidates.includes(override)) return override
    // Otherwise default: hint → first active candidate
    const hint = seg.camera_hints?.preferred_car_idx
    if (hint != null && candidates.includes(hint)) return hint
    return candidates[0] ?? null
  }, [driverFocusOverrides])

  // Advance focus to the next driver that is active at sessionTime.
  const cycleFocusDriver = useCallback((seg, sessionTime = null) => {
    const candidates = getActiveDrivers(seg, sessionTime)
    if (candidates.length <= 1) return
    const current    = driverFocusOverrides[seg.id]
      ?? seg.camera_hints?.preferred_car_idx
      ?? candidates[0]
    const currentIdx = candidates.indexOf(current)
    const next       = candidates[(currentIdx >= 0 ? currentIdx + 1 : 1) % candidates.length]
    setDriverFocusOverrides(prev => ({ ...prev, [seg.id]: next }))
  }, [driverFocusOverrides])

  // Cycle through camera_preferences for a segment (camera override)
  const cycleCameraOverride = useCallback((seg, e) => {
    e?.stopPropagation()
    const prefs = seg.camera_preferences || []
    if (prefs.length <= 1) return
    setCameraOverrides(prev => {
      const cur = prev[seg.id] ?? 0
      return { ...prev, [seg.id]: (cur + 1) % prefs.length }
    })
  }, [])

  const seekScriptPosition = useCallback(async (editTime) => {
    const resolved = resolveSegmentAtEditTime(editTime)
    if (!resolved) return
    const { seg, segmentEditOffset } = resolved
    const sessionTime = (seg.clipStartTime ?? seg.start_time_seconds ?? 0) + segmentEditOffset
    const cameras = sessionData?.cameras || []

    setActiveSegId(seg.id)
    setSeekError(null)

    // Seek with one retry on failure
    let seekOk = false
    for (let attempt = 0; attempt < 2 && !seekOk; attempt++) {
      try {
        await apiPost('/iracing/replay/seek-time', {
          session_num: raceSessionNum,
          session_time_ms: Math.round(sessionTime * 1000),
        })
        seekOk = true
      } catch (err) {
        if (attempt === 1) setSeekError('Seek failed — iRacing may not be ready')
      }
    }

    try {
      const camLabel = getCameraLabel(seg, cameraOverrides)
      const cam = cameras.find(c => c.group_name === camLabel)
      if (cam) {
        const carIdx = getFocusCarIdx(seg, sessionTime)
        await apiPost('/iracing/replay/camera', {
          group_num: cam.group_num,
          ...(carIdx != null ? { car_idx: carIdx } : { position: 1 }),
        })
      }
    } catch { /* non-fatal */ }

    try { await apiPost('/iracing/replay/pause') } catch { /* non-fatal */ }

    // Log the seek event so the event feed captures manual scrubs
    pushScriptAction({
      id:          `seek_${Date.now()}`,
      ts:          Date.now(),
      eventType:   'seek',
      section:     seg.section || 'race',
      cameraLabel: null,
      driverName:  null,
      raceTime:    sessionTime,
      involvedDrivers: [],
    })
  }, [resolveSegmentAtEditTime, sessionData, raceSessionNum, getFocusCarIdx, cameraOverrides, pushScriptAction])

  const handlePlayheadPointerDown = useCallback((e) => {
    if (!hasData || e.button !== 0) return
    // Only act when directly clicking the scrub zones (section row or tick ruler).
    // Other rows (camera, driver, events) need their own click handlers.
    e.preventDefault()
    e.stopPropagation()

    // Mark clock as user-scrubbing so the 50ms ticker won't fight our UI updates
    const clk = scriptClockRef.current
    if (clk) clk.userScrubbing = true

    const applyDrag = (clientX) => {
      const editTime = getEditTimeFromClientX(clientX)
      setOptimisticEditTime(editTime)
      const resolved = resolveSegmentAtEditTime(editTime)
      setScrubSegId(resolved?.seg?.id ?? null)
      // Sync histogram playhead to the corresponding race-time position
      const raceTime = mapEditTimeToRaceTime(editTime)
      if (raceTime != null) seekTo(raceTime)
    }

    setIsDraggingPlayhead(true)
    applyDrag(e.clientX)

    const onMove = (mv) => applyDrag(mv.clientX)

    const onUp = async (up) => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setIsDraggingPlayhead(false)

      const finalEditTime = getEditTimeFromClientX(up.clientX)
      setScrubSegId(null)
      setOptimisticEditTime(finalEditTime)
      
      // Re-anchor the clock to the new scrub position so it resumes from here
      const clk = scriptClockRef.current
      if (clk) {
        clk.startWallMs = performance.now()
        clk.startEditTime = finalEditTime
        clk.accPausedMs = 0
        clk.userScrubbing = false
        // Update segStartSec if we're in the middle of a segment for drift detection
        const resolved = resolveSegmentAtEditTime(finalEditTime)
        if (resolved?.seg) {
          clk.segStartSec = resolved.seg.start_time_seconds
          clk.segStartWallMs = performance.now()
          clk.segAccPausedMsAtSegStart = 0
        }
      }
      
      // If executing, tell the loop to jump forward without cycling through intermediate segments
      if (scriptClockRef.current) {
        scrubResyncRef.current = { editTime: finalEditTime }
      }

      await seekScriptPosition(finalEditTime)

      // Keep optimistic line briefly so UI feels immediate while replay-state poll catches up.
      setTimeout(() => setOptimisticEditTime(null), 1200)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [hasData, getEditTimeFromClientX, resolveSegmentAtEditTime, seekScriptPosition])

  const virtualPlayheadTime = useMemo(() => {
    if (!hasData) return null
    if (optimisticEditTime != null) return optimisticEditTime
    // During execution the browser clock is authoritative — do not let iRacing state move the playhead.
    if (scriptEditTime != null) return Math.max(0, Math.min(totalEditDuration, scriptEditTime))
    if (replayState?.session_time == null) {
      if (!effectiveActiveSegId) return 0
      const seg = editSegments.find(s => s.id === effectiveActiveSegId)
      return seg ? seg.editStart : 0
    }
    return mapSessionTimeToEditTime(replayState.session_time, effectiveActiveSegId)
  }, [
    hasData,
    optimisticEditTime,
    scriptEditTime,
    totalEditDuration,
    replayState,
    effectiveActiveSegId,
    editSegments,
    mapSessionTimeToEditTime,
  ])

  const virtualPlayheadX = useMemo(() => {
    if (virtualPlayheadTime == null) return null
    return Math.max(0, Math.min(activeContentW, toX(virtualPlayheadTime)))
  }, [virtualPlayheadTime, activeContentW, toX])

  // Sync: range slider → scroll position
  useEffect(() => {
    const el = scrollRef.current
    if (!el || activeContentW <= 0) return
    const target = Math.round(rangeStart * activeContentW)
    if (Math.abs(el.scrollLeft - target) < 1) return
    syncingRef.current = true
    el.scrollLeft = target
  }, [rangeStart, activeContentW])

  // Sync: scroll → range (fires from programmatic changes only when overflow:hidden)
  const handleTimelineScroll = useCallback(() => {
    if (syncingRef.current) { syncingRef.current = false; return }
    const el = scrollRef.current
    if (!el || activeContentW <= 0) return
    const rw = rangeEnd - rangeStart
    const newStart = Math.max(0, Math.min(1 - rw, el.scrollLeft / activeContentW))
    setRangeStart(newStart)
    setRangeEnd(newStart + rw)
  }, [rangeStart, rangeEnd, activeContentW])

  // Map editSegments to RangeSlider's expected event structure (edit-time axis)
  const rangeSliderEvents = useMemo(() => editSegments.map(s => ({
    start_time_seconds: s.editStart,
    end_time_seconds: s.editEnd,
    event_type: s.event_type || (isFillerSegment(s) ? null : 'race_start'),
    inclusion: s.section === 'race' && !isFillerSegment(s) ? 'highlight' : null,
  })), [editSegments])

  // ── Active segment index (derived) ────────────────────────────────────────
  const activeSegIndex = useMemo(
    () => (activeSegId ? editSegments.findIndex(s => s.id === activeSegId) : -1),
    [activeSegId, editSegments]
  )

  // ── Seek to a single segment (no looping) ──────────────────────────────────
  const seekToSegment = useCallback(async (idx) => {
    if (idx < 0 || idx >= editSegments.length) return
    const seg = editSegments[idx]
    setActiveSegId(seg.id)
    const cameras = sessionData?.cameras || []
    try {
      await apiPost('/iracing/replay/seek-time', {
        session_num: raceSessionNum,
        session_time_ms: Math.round((seg.clipStartTime ?? seg.start_time_seconds ?? 0) * 1000),
      })
    } catch (err) {
      showError(`Seek failed: ${err?.message || 'iRacing not responding'}`)
      return
    }
    try {
      const camLabel = getCameraLabel(seg, cameraOverrides)
      const cam = cameras.find(c => c.group_name === camLabel)
      if (cam) {
        const carIdx = getFocusCarIdx(seg, seg.clipStartTime ?? seg.start_time_seconds ?? 0)
        await apiPost('/iracing/replay/camera', {
          group_num: cam.group_num,
          ...(carIdx != null ? { car_idx: carIdx } : { position: 1 }),
        })
      }
    } catch { /* non-fatal */ }
    try { await apiPost('/iracing/replay/pause') } catch { /* non-fatal */ }
  }, [editSegments, raceSessionNum, sessionData, getFocusCarIdx, cameraOverrides])

  // ── Execute Script ──────────────────────────────────────────────────────────
  const executeScript = useCallback(async (fromIndex = 0) => {
    const segs = editSegments.slice(fromIndex)
    if (!segs.length) return
    const abort = { cancelled: false }
    abortRef.current = abort
    pausedRef.current = false
    setExecuting(true)
    setPaused(false)
    clearScriptActionLog()

    const cameras = sessionData?.cameras || []
    const speed   = replaySpeed

    // ── Browser-authoritative clock ───────────────────────────────────────
    // The browser is the source of truth for timing. iRacing receives
    // seek/camera/play commands at boundaries; its session_time cannot
    // push the playhead while the script is running.
    const startEditTime = editSegments[fromIndex]?.editStart ?? 0
    scriptClockRef.current = {
      startWallMs:         performance.now(),
      startEditTime,
      speed,
      accPausedMs:         0,
      paused:              false,
      pauseWallMs:         0,
      pauseEditTime:       startEditTime,
      userScrubbing:       false,  // set true while user drags the playhead
      expectedCamGroupNum: null,   // last commanded camera group; validated by ticker
      expectedCarIdx:      null,   // last commanded car idx; validated by ticker
    }

    // Thresholds for drift correction.
    const DRIFT_THRESHOLD_S  = 2.0   // seconds of drift before a seek correction is issued
    const DRIFT_COOLDOWN_MS  = 3000  // minimum ms between correction seeks

    // 50 ms ticker: updates playhead UI and detects/corrects iRacing drift.
    clearInterval(scriptTickRef.current)
    scriptTickRef.current = setInterval(() => {
      const clk = scriptClockRef.current
      if (!clk) return
      const wallNow = performance.now()
      // Skip UI update if user is manually scrubbing — let optimisticEditTime handle it
      if (clk.userScrubbing) return
      const t = clk.paused
        ? clk.pauseEditTime
        : clk.startEditTime + ((wallNow - clk.startWallMs - clk.accPausedMs) / 1000) * clk.speed
      setScriptEditTime(t)

      // ── Drift detection & correction ────────────────────────────────────
      if (!clk.paused && clk.segStartSec != null) {
        const segElapsed = (wallNow - clk.segStartWallMs -
          (clk.accPausedMs - clk.segAccPausedMsAtSegStart)) / 1000
        const expectedRaceTime = clk.segStartSec + segElapsed * clk.speed
        const actual = replayStateRef.current?.session_time
        if (actual != null) {
          const drift = actual - expectedRaceTime
          setDriftS(drift)
          if (Math.abs(drift) > DRIFT_THRESHOLD_S &&
              wallNow - (clk.lastSeekMs || 0) > DRIFT_COOLDOWN_MS) {
            clk.lastSeekMs = wallNow
            apiPost('/iracing/replay/seek-time', {
              session_num: raceSessionNumRef.current,
              session_time_ms: Math.round(expectedRaceTime * 1000),
            }).catch(() => {})
          }
        }
      }

      // ── Play / speed validation ─────────────────────────────────────────
      if (!clk.paused && !clk.userScrubbing) {
        const rs = replayStateRef.current
        const expectedSpeed = Math.max(1, Math.round(clk.speed))

        if (rs != null) {
          // iRacing is paused but should be playing — re-issue play
          if (rs.replay_speed === 0 && wallNow - (clk.lastPlayMs || 0) > 2000) {
            clk.lastPlayMs = wallNow
            apiPost('/iracing/replay/play').catch(() => {})
          }

          // iRacing is running but at the wrong speed — re-issue speed + play
          if (rs.replay_speed !== 0 && rs.replay_speed !== expectedSpeed
              && wallNow - (clk.lastSpeedMs || 0) > 2000) {
            clk.lastSpeedMs = wallNow
            apiPost('/iracing/replay/speed', { speed: expectedSpeed })
              .then(() => apiPost('/iracing/replay/play'))
              .catch(() => {})
          }

          // ── Camera/driver validation ────────────────────────────────────
          if (clk.expectedCamGroupNum != null) {
            const camMismatch = rs.cam_group_num !== clk.expectedCamGroupNum
              || (clk.expectedCarIdx != null && rs.cam_car_idx !== clk.expectedCarIdx)
            if (camMismatch && wallNow - (clk.lastCamMs || 0) > 1500) {
              clk.lastCamMs = wallNow
              apiPost('/iracing/replay/camera', {
                group_num: clk.expectedCamGroupNum,
                ...(clk.expectedCarIdx != null ? { car_idx: clk.expectedCarIdx } : { position: 1 }),
              }).catch(() => {})
            }
          }
        }
      }
    }, 50)

    // Resolves once the browser clock reaches targetEditTime.
    // While paused the promise waits without resolving.
    // Bails out immediately if a scrub resync is pending so the loop can jump forward.
    const waitForEditTime = (targetEditTime) => new Promise(resolve => {
      const check = setInterval(() => {
        if (abort.cancelled) { clearInterval(check); resolve(); return }
        // Scrub resync pending — bail so the for-loop can skip to the correct segment
        if (scrubResyncRef.current != null) { clearInterval(check); resolve(); return }
        const clk = scriptClockRef.current
        if (!clk) { resolve(); return }
        if (clk.paused) return
        const now = clk.startEditTime +
          ((performance.now() - clk.startWallMs - clk.accPausedMs) / 1000) * clk.speed
        if (now >= targetEditTime) { clearInterval(check); resolve() }
      }, 50)
    })

    for (const seg of segs) {
      if (abort.cancelled) break

      // Scrub resync: skip segments that fall entirely before the target position
      // without firing any API commands. When we reach the segment that contains
      // the target time, clear the resync flag and execute that segment normally.
      if (scrubResyncRef.current != null) {
        if (seg.editEnd <= scrubResyncRef.current.editTime) continue
        scrubResyncRef.current = null  // this segment contains the target; proceed normally
      }

      // Bridges are zero-duration cut markers — skip all API calls.
      // The next real segment handles its own seek + camera; firing bridge
      // commands just produces redundant iRacing camera changes immediately
      // overridden by the segment that follows.
      if (seg.type === 'bridge') continue

      const startSec = seg.clipStartTime ?? seg.start_time_seconds ?? 0
      const hasSchedule = Array.isArray(seg.camera_schedule) && seg.camera_schedule.length > 1

      setActiveSegId(seg.id)

      // Update per-segment anchor so the ticker can compute expected race time.
      {
        const clk = scriptClockRef.current
        if (clk) {
          clk.segStartSec              = startSec
          clk.segStartWallMs           = performance.now()
          clk.segAccPausedMsAtSegStart = clk.accPausedMs
        }
      }

      try {
        await apiPost('/iracing/replay/seek-time', {
          session_num: raceSessionNum,
          session_time_ms: Math.round(startSec * 1000),
        })
      } catch (err) {
        showError(`Seek failed: ${err?.message || 'iRacing not responding'}`)
        break
      }

      // Set speed and start playing (done once per segment regardless of schedule)
      try {
        const validSpeed = Math.max(1, Math.round(speed))
        await apiPost('/iracing/replay/speed', { speed: validSpeed })
        await apiPost('/iracing/replay/play')
      } catch { /* non-fatal */ }

      if (hasSchedule) {
        // ── Multi-window camera schedule: iterate each window ──────────────
        // Only send a camera command when group_num or car_idx actually changes
        // — avoids flooding iRacing with redundant commands when the algorithm
        // switches driver but keeps the same camera group.
        let prevGroupNum = null
        let prevCarIdx   = undefined  // undefined ≠ null (null means "no specific car")
        for (const win of seg.camera_schedule) {
          if (abort.cancelled) break
          const cam = cameras.find(c => c.group_name === win.camera)
          if (cam) {
            const carIdx = win.driver_idx ?? null
            const camChanged = cam.group_num !== prevGroupNum || carIdx !== prevCarIdx
            if (camChanged) {
              const drvIdx   = carIdx != null ? (seg.involved_drivers || []).indexOf(carIdx) : -1
              const drvName  = drvIdx >= 0 ? (seg.driver_names || [])[drvIdx] : ((seg.driver_names || [])[0] || null)
              try {
                await apiPost('/iracing/replay/camera', {
                  group_num: cam.group_num,
                  ...(carIdx != null ? { car_idx: carIdx } : { position: 1 }),
                })
                const clk2 = scriptClockRef.current
                if (clk2) { clk2.expectedCamGroupNum = cam.group_num; clk2.expectedCarIdx = carIdx }
              } catch { /* non-fatal */ }
              pushScriptAction({
                id: `${seg.id}_w${win.start}`,
                ts: Date.now(),
                eventType: seg.event_type || seg.type || null,
                section: seg.section || 'race',
                cameraLabel: win.camera,
                driverName: drvName,
                raceTime: win.start,
                involvedDrivers: seg.driver_names || [],
              })
              prevGroupNum = cam.group_num
              prevCarIdx   = carIdx
            }
          }
          // Wait until the browser clock reaches the end of this window.
          const winEditEnd = seg.editStart + (win.end - startSec)
          await waitForEditTime(winEditEnd)
        }
      } else {
        // ── Standard single camera+driver for entire segment ───────────────
        let appliedCamLabel = null
        let appliedDriverName = null
        try {
          const camLabel = getCameraLabel(seg, cameraOverrides)
          const cam = cameras.find(c => c.group_name === camLabel)
          if (cam) {
            const carIdx = getFocusCarIdx(seg, startSec)
            const drvNames = seg.driver_names || []
            const drvIdx   = (seg.involved_drivers || []).indexOf(carIdx)
            appliedCamLabel = camLabel
            appliedDriverName = drvIdx >= 0 ? drvNames[drvIdx] : (drvNames[0] || null)
            await apiPost('/iracing/replay/camera', {
              group_num: cam.group_num,
              ...(carIdx != null ? { car_idx: carIdx } : { position: 1 }),
            })
            const clk2 = scriptClockRef.current
            if (clk2) { clk2.expectedCamGroupNum = cam.group_num; clk2.expectedCarIdx = carIdx }
          }
        } catch { /* non-fatal */ }

        pushScriptAction({
          id: seg.id,
          ts: Date.now(),
          eventType: seg.event_type || seg.type || null,
          section: seg.section || 'race',
          cameraLabel: appliedCamLabel,
          driverName: appliedDriverName,
          raceTime: startSec,
          involvedDrivers: seg.driver_names || [],
        })

        // Wait until the browser clock reaches the end of this segment.
        await waitForEditTime(seg.editEnd)
      }
    }

    if (!abort.cancelled) {
      try { await apiPost('/iracing/replay/pause') } catch { /* non-fatal */ }
    }
    pausedRef.current = false
    setPaused(false)
    setExecuting(false)
    setActiveSegId(null)
    scrubResyncRef.current = null
    // Clean up browser clock, UI ticker, and drift display.
    clearInterval(scriptTickRef.current)
    scriptTickRef.current = null
    scriptClockRef.current = null
    setScriptEditTime(null)
    setDriftS(null)
  }, [editSegments, raceSessionNum, sessionData, replaySpeed, getFocusCarIdx, pushScriptAction, clearScriptActionLog, cameraOverrides])

  const pauseExecution = useCallback(() => {
    pausedRef.current = true
    setPaused(true)
    // Freeze the browser clock so the playhead stops advancing.
    const clk = scriptClockRef.current
    if (clk && !clk.paused) {
      clk.pauseWallMs = performance.now()
      clk.pauseEditTime = clk.startEditTime +
        ((clk.pauseWallMs - clk.startWallMs - clk.accPausedMs) / 1000) * clk.speed
      clk.paused = true
    }
    apiPost('/iracing/replay/pause').catch(() => {})
  }, [])

  const resumeExecution = useCallback(() => {
    pausedRef.current = false
    setPaused(false)
    // Resume the browser clock, accounting for the time spent paused.
    const clk = scriptClockRef.current
    if (clk && clk.paused) {
      clk.accPausedMs += performance.now() - clk.pauseWallMs
      clk.paused = false
    }
    apiPost('/iracing/replay/play').catch(() => {})
  }, [])

  const stopExecution = useCallback(() => {
    abortRef.current.cancelled = true
    pausedRef.current = false
    setPaused(false)
    setExecuting(false)
    setActiveSegId(null)
    scrubResyncRef.current = null
    // Clean up browser clock, UI ticker, and drift display.
    clearInterval(scriptTickRef.current)
    scriptTickRef.current = null
    scriptClockRef.current = null
    setScriptEditTime(null)
    setDriftS(null)
    apiPost('/iracing/replay/pause').catch(() => {})
  }, [])

  // ── Clip count summary ──────────────────────────────────────────────────────
  // Camera sub-segments (_camera_sub > 0) are continuations of the same event; count only the first
  const clipCount = editSegments.filter(s => s.section === 'race' && !isFillerSegment(s) && !(s._camera_sub > 0)).length
  const contextCount = editSegments.filter(s => s.type === 'context').length
  const totalVideoDuration = editSegments.reduce((acc, s) => acc + (s.editDur || 0), 0)
  const contentDuration = editSegments
    .filter(s => !isFillerSegment(s))
    .reduce((acc, s) => acc + (s.editDur || 0), 0)
  // Script report data (computed from editSegments for the modal)
  const scriptReport = useMemo(() => {
    if (!editSegments.length) return null
    const eventClips    = editSegments.filter(s => s.section === 'race' && !isFillerSegment(s))
    const contextClips  = editSegments.filter(s => s.type === 'context')
    const bridgeClips   = editSegments.filter(s => s.type === 'bridge')
    const sectionClips  = editSegments.filter(s => s.section && s.section !== 'race')
    const totalEvent    = eventClips.reduce((a, s) => a + (s.editDur || 0), 0)
    const totalContext  = contextClips.reduce((a, s) => a + (s.editDur || 0), 0)
    const totalSection  = sectionClips.reduce((a, s) => a + (s.editDur || 0), 0)
    const totalVideo    = editSegments.reduce((a, s) => a + (s.editDur || 0), 0)
    const byType = {}
    for (const s of eventClips) {
      if (s._camera_sub > 0) continue  // Don't double-count camera sub-segments
      const t = s.event_type || s.type || 'unknown'
      byType[t] = (byType[t] || 0) + 1
    }
    const cameraCuts = eventClips.filter(s => s._camera_sub > 0).length
    return { eventClips, contextClips, bridgeClips, sectionClips, totalEvent, totalContext, totalSection, totalVideo, byType, cameraCuts }
  }, [editSegments])

  const scriptReportText = useMemo(
    () => buildScriptReportText(scriptReport, editSegments),
    [scriptReport, editSegments],
  )

  const handleCopyScriptReport = useCallback(() => {
    navigator.clipboard.writeText(scriptReportText)
  }, [scriptReportText])

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* Script Report Modal */}
      {showScriptReport && scriptReport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
             onClick={() => setShowScriptReport(false)}>
          <div className="bg-bg-tertiary border border-border rounded-2xl shadow-float w-full max-w-6xl mx-4 flex flex-col max-h-[90vh]"
               onClick={e => e.stopPropagation()}>

            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
              <div className="flex items-center gap-3">
                <h3 className="text-lg font-semibold text-text-primary">Full Script</h3>
                <span className="text-xs text-text-tertiary font-mono">
                  {editSegments.length} segments &middot; {fmtDur(scriptReport.totalVideo)} total
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCopyScriptReport}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border-subtle
                             text-text-secondary hover:text-text-primary hover:border-border rounded transition-colors"
                >
                  <Copy size={12} />
                  Copy
                </button>
                <button onClick={() => setShowScriptReport(false)} className="p-2 rounded-xl hover:bg-surface-hover transition-colors">
                  <X className="w-5 h-5 text-text-tertiary" />
                </button>
              </div>
            </div>

            {/* Summary pills */}
            <div className="flex items-center gap-3 px-6 py-2.5 border-b border-border-subtle bg-bg-secondary shrink-0 flex-wrap">
              {[
                { label: 'Events',  value: scriptReport.eventClips.length - scriptReport.cameraCuts, color: 'text-orange-400' },
                { label: 'Cam cuts', value: scriptReport.cameraCuts,  color: 'text-indigo-400' },
                { label: 'Context', value: scriptReport.contextClips.length, color: 'text-sky-400' },
                { label: 'Bridges', value: scriptReport.bridgeClips.length, color: 'text-text-tertiary' },
                { label: 'Sections', value: scriptReport.sectionClips.length, color: 'text-purple-400' },
              ].map(({ label, value, color }) => (
                <span key={label} className="flex items-center gap-1 text-xs">
                  <span className={`font-semibold ${color}`}>{value}</span>
                  <span className="text-text-tertiary">{label}</span>
                </span>
              ))}
              <div className="ml-auto flex items-center gap-4 text-xs text-text-tertiary">
                <span><span className="text-text-secondary font-medium">{fmtDur(scriptReport.totalEvent)}</span> events</span>
                <span><span className="text-text-secondary font-medium">{fmtDur(scriptReport.totalContext)}</span> context</span>
                <span><span className="text-text-secondary font-medium">{fmtDur(scriptReport.totalSection)}</span> sections</span>
              </div>
            </div>

            {/* Full segment table */}
            <div className="flex-1 overflow-auto">
              <table className="w-full text-xs font-mono border-collapse">
                <thead className="sticky top-0 bg-bg-secondary z-10">
                  <tr className="text-text-tertiary text-left uppercase tracking-wider text-xxs">
                    <th className="px-3 py-2 w-8 font-medium border-b border-border-subtle">#</th>
                    <th className="px-3 py-2 font-medium border-b border-border-subtle">Section</th>
                    <th className="px-3 py-2 font-medium border-b border-border-subtle">Type</th>
                    <th className="px-3 py-2 font-medium border-b border-border-subtle">Event</th>
                    <th className="px-3 py-2 font-medium border-b border-border-subtle">Race Time</th>
                    <th className="px-3 py-2 font-medium border-b border-border-subtle">Duration</th>
                    <th className="px-3 py-2 font-medium border-b border-border-subtle">Camera</th>
                    <th className="px-3 py-2 font-medium border-b border-border-subtle">Score</th>
                    <th className="px-3 py-2 font-medium border-b border-border-subtle">Drivers</th>
                  </tr>
                </thead>
                <tbody>
                  {editSegments.map((seg, i) => {
                    const isBridge  = seg.type === 'bridge'
                    const isContext = seg.type === 'context'
                    const isBroll   = seg.type === 'broll'
                    const isSubCam  = seg._camera_sub > 0
                    const sectionMeta = SECTION_META[seg.section] || SECTION_META.race
                    const camera      = getCameraLabel(seg, cameraOverrides)
                    const altCams     = (seg.camera_preferences || []).slice(1, 3)
                    const drivers     = seg.driver_names || []
                    const rowBg = i % 2 === 0 ? 'bg-bg-primary/20' : ''
                    const rowOpacity = isBridge ? 'opacity-40' : isBroll ? 'opacity-50' : ''
                    const inspectorEvent = resolveInspectorEvent(seg)
                    const isEventRow = !isBridge && !isBroll && inspectorEvent != null
                    return (
                      <tr
                        key={`${seg.id}-${i}`}
                        className={`border-b border-border-subtle/50 ${rowBg} ${rowOpacity}
                          ${isEventRow ? 'cursor-pointer hover:bg-accent/8' : 'hover:bg-accent/5'} transition-colors`}
                        onClick={isEventRow ? () => {
                          inspectFromSegment(seg, 'script-table-row')
                          setShowScriptReport(false)
                        } : undefined}
                        title={isEventRow ? 'Click to inspect event' : undefined}
                      >
                        {/* # */}
                        <td className="px-3 py-1.5 text-text-disabled">{i + 1}</td>
                        {/* Section */}
                        <td className="px-3 py-1.5">
                          <span className="text-xxs font-medium" style={{ color: sectionMeta.text }}>
                            {sectionMeta.label}
                          </span>
                        </td>
                        {/* Type */}
                        <td className="px-3 py-1.5">
                          {isBridge  && <span className="text-text-disabled italic">cut</span>}
                          {isContext && <span className="text-sky-400/70">context</span>}
                          {isBroll   && <span className="text-text-disabled">broll</span>}
                          {isSubCam  && !isBridge && <span className="text-indigo-400/80">cam {seg._camera_sub + 1}</span>}
                          {!isBridge && !isContext && !isBroll && !isSubCam && (
                            <span className="text-text-secondary">event</span>
                          )}
                        </td>
                        {/* Event type */}
                        <td className="px-3 py-1.5 text-text-primary font-medium">
                          {EVENT_TYPE_LABELS[seg.event_type] || seg.event_type || <span className="text-text-disabled">\u2014</span>}
                        </td>
                        {/* Race time */}
                        <td className="px-3 py-1.5 text-text-secondary tabular-nums">
                          {formatTime(seg.start_time_seconds || 0)}
                        </td>
                        {/* Duration */}
                        <td className="px-3 py-1.5 text-text-secondary tabular-nums">
                          {fmtDur(seg.editDur || 0)}
                        </td>
                        {/* Camera */}
                        <td className="px-3 py-1.5">
                          {isBridge ? <span className="text-text-disabled">\u2014</span> : (
                            <span className="flex items-center gap-1">
                              <span className="text-text-primary">{camera}</span>
                              {altCams.length > 0 && (
                                <span className="text-text-disabled text-xxs">[{altCams.join(', ')}]</span>
                              )}
                            </span>
                          )}
                        </td>
                        {/* Score */}
                        <td className="px-3 py-1.5 tabular-nums">
                          {seg.score != null
                            ? <span className="text-text-secondary">{Number(seg.score).toFixed(2)}</span>
                            : <span className="text-text-disabled">\u2014</span>
                          }
                        </td>
                        {/* Drivers */}
                        <td className="px-3 py-1.5 text-text-secondary max-w-[220px] truncate">
                          {drivers.length > 0
                            ? drivers.join(', ')
                            : <span className="text-text-disabled">\u2014</span>
                          }
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Header / collapse toggle */}
      <div className="flex items-center border-b border-border bg-bg-secondary shrink-0">
        <button
          onClick={() => setCollapsed(v => !v)}
          className="flex items-center gap-2 px-3 py-2 flex-1 text-left hover:bg-bg-primary/40 transition-colors min-w-0"
        >
          {collapsed
            ? <ChevronRight className="w-3 h-3 text-text-tertiary shrink-0" />
            : <ChevronDown  className="w-3 h-3 text-text-tertiary shrink-0" />}
          <Film className="w-3.5 h-3.5 text-accent shrink-0" />
          <span className="text-xs font-semibold text-text-primary uppercase tracking-wider whitespace-nowrap">
            Race Script
          </span>
          {!collapsed && hasData && (
            <span className="text-xs text-text-disabled truncate">
              {clipCount} highlights
              {contextCount > 0 && <> &middot; {contextCount} context</>}
              {' '}&middot; {fmtDur(totalVideoDuration)} total
            </span>
          )}
          {seekError && !collapsed && (
            <span className="text-xxs text-danger truncate ml-2 shrink-0" title={seekError}>
              ⚠ {seekError}
            </span>
          )}
        </button>
        {!collapsed && hasData && (
          <button
            onClick={() => setShowScriptReport(true)}
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border transition-colors
              text-text-tertiary border-border-subtle hover:text-text-secondary hover:border-border mr-2"
            title="View script breakdown report"
          >
            <FileText size={11} />
            View Report
          </button>
        )}
      </div>

      {/* Transport control bar */}
      {!collapsed && hasData && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-bg-primary shrink-0">
          {/* Prev segment */}
          <button
            onClick={() => seekToSegment(activeSegIndex <= 0 ? 0 : activeSegIndex - 1)}
            disabled={executing || activeSegIndex <= 0}
            title="Previous segment"
            className="p-1 rounded hover:bg-bg-secondary disabled:opacity-30 text-text-secondary hover:text-text-primary transition-colors"
          >
            <SkipBack size={12} />
          </button>

          {/* Play / Pause / Resume */}
          <button
            onClick={() => {
              if (!executing) return executeScript(Math.max(0, activeSegIndex))
              if (paused)     return resumeExecution()
              return pauseExecution()
            }}
            disabled={!isConnected}
            title={!executing
              ? (isConnected ? 'Execute script from here' : 'iRacing not connected')
              : paused ? 'Resume' : 'Pause'}
            className="p-1 rounded transition-colors disabled:opacity-30 text-accent hover:text-accent-light hover:bg-accent/10"
          >
            {executing && !paused ? <Pause size={13} /> : <Play size={13} />}
          </button>

          {/* Next segment */}
          <button
            onClick={() => seekToSegment(activeSegIndex + 1)}
            disabled={executing || activeSegIndex >= editSegments.length - 1}
            title="Next segment"
            className="p-1 rounded hover:bg-bg-secondary disabled:opacity-30 text-text-secondary hover:text-text-primary transition-colors"
          >
            <SkipForward size={12} />
          </button>

          {/* Position indicator */}
          <span className="text-xxs font-mono text-text-disabled w-12 text-center shrink-0 whitespace-nowrap">
            {activeSegIndex >= 0
              ? `${activeSegIndex + 1} / ${editSegments.length}`
              : `– / ${editSegments.length}`}
          </span>

          {/* Progress bar */}
          <div className="flex-1 h-1 bg-bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-300"
              style={{ width: activeSegIndex >= 0
                ? `${((activeSegIndex + 1) / editSegments.length) * 100}%`
                : '0%' }}
            />
          </div>

          {/* Live race clock — shown while executing */}
          {scriptEditTime != null && (
            <span
              title="Current race session time (browser clock)"
              className="shrink-0 font-mono tabular-nums text-xs font-semibold text-text-primary min-w-[4.5rem] text-right"
            >
              {fmtRaceTime(mapEditTimeToRaceTime(scriptEditTime))}
            </span>
          )}

          {/* Live drift badge — shown while executing */}
          {driftS != null && (
            <span
              title={`iRacing session_time drift vs browser clock: ${driftS > 0 ? '+' : ''}${driftS.toFixed(2)}s${Math.abs(driftS) > 2 ? ' — correcting' : ''}`}
              className={`shrink-0 text-xxs font-mono px-1.5 py-0.5 rounded tabular-nums transition-colors ${
                Math.abs(driftS) > 2
                  ? 'bg-red-500/20 text-red-400'
                  : Math.abs(driftS) > 0.5
                    ? 'bg-yellow-500/20 text-yellow-400'
                    : 'bg-green-500/15 text-green-400'
              }`}
            >
              Δ{driftS > 0 ? '+' : ''}{driftS.toFixed(1)}s
            </span>
          )}

          {/* Speed selector */}
          <div className="flex items-center gap-px">
            {[1, 2, 4, 8].map(spd => (
              <button
                key={spd}
                onClick={() => setReplaySpeed(spd)}
                className={`px-1.5 py-0.5 text-xxs font-mono rounded transition-colors ${
                  replaySpeed === spd
                    ? 'bg-accent text-white'
                    : 'text-text-disabled hover:text-text-primary hover:bg-bg-secondary'
                }`}
                title={`${spd}× playback speed`}
              >
                {spd}×
              </button>
            ))}
          </div>
        </div>
      )}

      {!collapsed && (
        <>
          {!hasData ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-1 text-center px-4 bg-bg-secondary">
              {serverScoring ? (
                <>
                  <Loader2 className="w-5 h-5 text-text-disabled opacity-70 animate-spin" />
                  <span className="text-xs text-text-disabled">Generating race script...</span>
                </>
              ) : (
                <>
                  <Film className="w-5 h-5 text-text-disabled opacity-35" />
                  <span className="text-xs text-text-disabled">No race script generated yet.</span>
                  <span className="text-xs text-text-disabled/60">
                    Click &ldquo;Generate Script&rdquo; in the Score Histogram header.
                  </span>
                </>
              )}
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {serverScoring && (
              <div className="shrink-0 px-3 py-1.5 border-b border-border bg-bg-primary/70 flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin text-text-disabled" />
                <span className="text-xxs text-text-disabled">Regenerating race script...</span>
              </div>
            )}
            <div className="flex-1 flex min-h-0 overflow-hidden bg-bg-secondary">

              {/* Gutter labels */}
              <div
                className="shrink-0 flex flex-col border-r border-border bg-bg-primary select-none z-10"
                style={{ width: GUTTER_W }}
              >
                <div className="border-b border-border-subtle flex items-center justify-end pr-2"
                     style={{ height: SECTION_H }}>
                  <span className="text-[10px] text-text-disabled uppercase tracking-wider">Sect</span>
                </div>
                <div className="border-b border-border-subtle flex items-center justify-end pr-2"
                     style={{ height: CAM_H }}>
                  <span className="text-[10px] text-text-disabled uppercase tracking-wider">Cam</span>
                </div>
                <div className="border-b border-border-subtle flex items-center justify-end pr-2"
                     style={{ height: DRIVER_H }}>
                  <span className="text-[10px] text-text-disabled uppercase tracking-wider">Focus</span>
                </div>
                <div className="border-b border-border-subtle flex items-center justify-end pr-2"
                     style={{ height: dynamicEvtH }}>
                  <span className="text-[10px] text-text-disabled uppercase tracking-wider">Clips</span>
                </div>
                <div style={{ height: TICK_H }} />
              </div>

              {/* Scrollable tracks — no native scrollbar; range slider controls zoom+pan */}
              <div
                ref={scrollRef}
                className="flex-1 overflow-x-hidden overflow-y-hidden"
                onScroll={handleTimelineScroll}
              >
                <div className="relative" style={{ width: activeContentW, height: totalTrackH }}>

                  {/* ── Section band row — scrub zone ─────────────────── */}
                  <div className="absolute left-0 right-0 border-b border-border-subtle cursor-ew-resize"
                       style={{ top: 0, height: SECTION_H }}
                       onMouseDown={handlePlayheadPointerDown}>
                    {SECTION_ORDER.map(sectionName => {
                      const span   = sectionSpans[sectionName]
                      if (!span) return null
                      const meta   = SECTION_META[sectionName] || SECTION_META.race
                      const left   = toX(span.editStart)
                      const width  = Math.max(4, toX(span.editEnd - span.editStart))
                      return (
                        <div key={sectionName}
                             className="absolute top-0 h-full flex items-center overflow-hidden"
                             style={{
                               left, width,
                               backgroundColor: meta.color,
                               borderRight: `1px solid ${meta.border}`,
                             }}>
                          <span className="truncate select-none"
                                style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em',
                                         textTransform: 'uppercase', paddingLeft: 4,
                                         color: meta.text }}>
                            {meta.label}
                          </span>
                        </div>
                      )
                    })}
                  </div>

                  {/* ── Camera track ──────────────────────────────────── */}
                  <div className="absolute left-0 right-0 border-b border-border-subtle"
                       style={{ top: SECTION_H, height: CAM_H }}>
                    {editSegments.map(seg => {
                      const left  = toX(seg.editStart)
                      const width = Math.max(3, toX(seg.editDur))
                      const camLabel = getCameraLabel(seg, cameraOverrides)
                      const isActive = effectiveActiveSegId === seg.id
                      const sectionMeta = SECTION_META[seg.section] || SECTION_META.race
                      const isRace = seg.section === 'race'
                      const bgColor = isActive ? 'rgba(99,102,241,0.65)' : 'rgba(99,102,241,0.36)'
                      const hasPrefs = (seg.camera_preferences?.length ?? 0) > 1
                      const schedule = seg.camera_schedule

                      if (schedule?.length >= 2 && isRace) {
                        // Render individual camera windows within the segment's edit range
                        const clipStart = seg.clipStartTime ?? seg.start_time_seconds ?? 0
                        const clipEnd   = seg.clipEndTime   ?? seg.end_time_seconds   ?? clipStart
                        const clipDur   = Math.max(0.001, clipEnd - clipStart)
                        const WIN_COLORS_CAM = [
                          'rgba(99,102,241,', 'rgba(16,185,129,', 'rgba(245,158,11,',
                          'rgba(239,68,68,',  'rgba(14,165,233,', 'rgba(168,85,247,',
                        ]
                        return (
                          <div key={`cam-${seg.id}`} className="absolute" style={{ left, width, top: 2, height: CAM_H - 4 }}>
                            {schedule.map((win, wi) => {
                              const relS = Math.max(0, (win.start - clipStart) / clipDur)
                              const relE = Math.min(1, (win.end   - clipStart) / clipDur)
                              const wLeft  = relS * width
                              const wWidth = Math.max(2, (relE - relS) * width)
                              const col    = WIN_COLORS_CAM[wi % WIN_COLORS_CAM.length]
                              return (
                                <div key={wi}
                                     className="absolute overflow-hidden cursor-pointer hover:brightness-125 transition-all"
                                     style={{
                                       left: wLeft, width: wWidth - 1, top: 0, height: CAM_H - 4,
                                       backgroundColor: col + (isActive ? '0.70)' : '0.42)'),
                                       borderLeft: `2px solid ${col}0.75)`,
                                     }}
                                     title={`Camera: ${win.camera || '?'} (window ${wi + 1}/${schedule.length}) — click to cycle`}
                                     onClick={(e) => cycleCameraOverride(seg, e)}>
                                  {wWidth > 18 && (
                                    <span className="px-0.5 truncate font-mono leading-none"
                                      style={{ fontSize: 11, color: 'rgba(220,210,255,0.90)', lineHeight: `${CAM_H - 4}px` }}>
                                      {win.camera || camLabel}
                                    </span>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )
                      }

                      return (
                        <div key={`cam-${seg.id}`}
                             className={`absolute flex items-center overflow-hidden ${isActive ? 'ring-1 ring-white/60' : ''} ${hasPrefs && isRace ? 'cursor-pointer hover:brightness-125' : ''}`}
                             style={{
                               left, width, top: 2, height: CAM_H - 4,
                               backgroundColor: !isRace ? sectionMeta.color.replace('0.20', '0.50').replace('0.15', '0.45').replace('0.28', '0.55') : bgColor,
                               borderLeft: `2px solid ${isActive ? 'rgba(255,255,255,0.6)' : (!isRace ? sectionMeta.border : 'rgba(99,102,241,0.55)')}`,
                             }}
                             title={`${!isRace ? (SECTION_META[seg.section]?.label || seg.section) + ' ' : ''}Camera: ${camLabel}${hasPrefs && isRace ? ' — click to cycle' : ''}`}
                             onClick={hasPrefs && isRace ? (e) => cycleCameraOverride(seg, e) : undefined}>
                          {width > 18 && (
                                    <span className="px-0.5 truncate font-mono leading-none"
                                      style={{ fontSize: 11, color: !isRace ? sectionMeta.text : 'rgba(220,210,255,0.85)' }}>
                              {camLabel}
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* ── Driver focus track ───────────────────────────────── */}
                  <div className="absolute left-0 right-0 border-b border-border-subtle"
                       style={{ top: SECTION_H + CAM_H, height: DRIVER_H }}>
                    {editSegments.map(seg => {
                      const left     = toX(seg.editStart)
                      const width    = Math.max(3, toX(seg.editDur))
                      const drivers  = seg.involved_drivers || []
                      const drvNames = seg.driver_names || []
                      if (drivers.length === 0 || seg?.type === 'broll' || seg?.type === 'bridge') return null

                      const currentTime = replayState?.session_time ?? null
                      const focusCarIdx = getFocusCarIdx(seg, currentTime)
                      const focusPos    = drivers.indexOf(focusCarIdx)
                      const focusName   = drvNames[focusPos >= 0 ? focusPos : 0] || `#${focusCarIdx}`
                      const isActive    = effectiveActiveSegId === seg.id

                      const clipStart  = seg.clipStartTime ?? seg.start_time_seconds ?? 0
                      const clipEnd    = seg.clipEndTime   ?? seg.end_time_seconds   ?? clipStart
                      const clipDur    = Math.max(0.001, clipEnd - clipStart)
                      const nameForCar = (carIdx) => {
                        const p = drivers.indexOf(carIdx)
                        return p >= 0 && drvNames[p] ? drvNames[p] : `#${carIdx}`
                      }

                      const WIN_COLORS_DRV = [
                        ['rgba(16,185,129,',  'rgba(167,243,208,'],  // emerald
                        ['rgba(6,182,212,',   'rgba(103,232,249,'],  // cyan
                        ['rgba(139,92,246,',  'rgba(196,181,253,'],  // violet
                        ['rgba(245,158,11,',  'rgba(253,211,77,'],   // amber
                        ['rgba(239,68,68,',   'rgba(252,165,165,'],  // red
                        ['rgba(14,165,233,',  'rgba(125,211,252,'],  // sky
                      ]

                      // ── Camera-schedule driver windows ─────────────────
                      const schedule = seg.camera_schedule
                      const hasScheduleDrivers = schedule?.length >= 2
                        && schedule.some(w => w.driver_idx != null && w.driver_idx !== schedule[0]?.driver_idx)

                      if (hasScheduleDrivers) {
                        // Group consecutive windows with the same driver_idx into bands
                        const bands = []
                        for (const win of schedule) {
                          const last = bands[bands.length - 1]
                          if (last && last.driver_idx === win.driver_idx) {
                            last.end = win.end
                          } else {
                            bands.push({ driver_idx: win.driver_idx, start: win.start, end: win.end })
                          }
                        }
                        // Assign a stable colour per unique driver_idx
                        const drvColorMap = {}
                        let colorCursor = 0
                        for (const b of bands) {
                          if (b.driver_idx != null && !(b.driver_idx in drvColorMap)) {
                            drvColorMap[b.driver_idx] = WIN_COLORS_DRV[colorCursor++ % WIN_COLORS_DRV.length]
                          }
                        }
                        return (
                          <div key={`drv-${seg.id}`} className="absolute" style={{ left, width, top: 0, height: DRIVER_H }}>
                            {bands.map((band, bi) => {
                              const relS  = Math.max(0, (band.start - clipStart) / clipDur)
                              const relE  = Math.min(1, (band.end   - clipStart) / clipDur)
                              const bLeft = relS * width
                              const bW    = Math.max(2, (relE - relS) * width)
                              const [bg, fg] = drvColorMap[band.driver_idx] || WIN_COLORS_DRV[0]
                              const drvName = band.driver_idx != null ? nameForCar(band.driver_idx) : '—'
                              const isWinActive = currentTime != null && currentTime >= band.start && currentTime <= band.end
                              return (
                                <div key={bi}
                                     className="absolute overflow-hidden"
                                     style={{
                                       left: bLeft, width: bW - 1, top: 2, height: DRIVER_H - 4,
                                       backgroundColor: bg + (isWinActive ? '0.60)' : isActive ? '0.38)' : '0.22)'),
                                       borderLeft: `2px solid ${bg}${isActive ? '0.80)' : '0.45)'}`,
                                     }}
                                     title={`Focus: ${drvName} (window ${bi + 1}/${bands.length})`}>
                                  {bW > 14 && (
                                    <span className="px-0.5 truncate leading-none block"
                                          style={{ fontSize: 11, fontWeight: 600, color: fg + '0.93)', lineHeight: `${DRIVER_H - 4}px` }}>
                                      {drvName}
                                    </span>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )
                      }

                      // Sub-window bands (merged multi-driver battles)
                      const driverWindows = seg.metadata?.driver_windows
                      const canCycle = getActiveDrivers(seg, currentTime).length > 1

                      const hasWindows = driverWindows && driverWindows.length > 1
                      // Height split: top band = focused driver name, bottom band = window chips
                      const topH   = hasWindows ? Math.floor(DRIVER_H * 0.52) : DRIVER_H - 4
                      const chipH  = hasWindows ? DRIVER_H - topH - 2 : 0

                      return (
                        <div
                          key={`drv-${seg.id}`}
                          className="absolute overflow-hidden"
                          style={{
                            left, width, top: 0, height: DRIVER_H,
                            cursor: canCycle ? 'pointer' : 'default',
                            backgroundColor: isActive ? 'rgba(16,185,129,0.28)' : 'rgba(16,185,129,0.12)',
                            borderLeft: `2px solid ${isActive ? 'rgba(52,211,153,0.8)' : 'rgba(52,211,153,0.35)'}`,
                          }}
                          title={
                            hasWindows
                              ? `Merged battle — ${drivers.length} drivers: ${drvNames.join(', ')}\n` +
                                driverWindows.map((w, i) => {
                                  const wNames = (w.drivers || []).map(nameForCar).join(' vs ')
                                  return `Window ${i + 1}: ${wNames} (${formatTime(w.start_time)} – ${formatTime(w.end_time)})`
                                }).join('\n') +
                                (canCycle ? '\n⟳ Click to cycle focus' : '')
                              : canCycle
                                ? `Focus: ${focusName} • click to cycle (${drvNames.join(', ')})`
                                : `Focus: ${focusName}`
                          }
                          onClick={canCycle ? e => { e.stopPropagation(); cycleFocusDriver(seg, currentTime) } : undefined}
                        >
                          {/* Focused driver name row */}
                          {width > 14 && (
                            <div className="flex items-center overflow-hidden px-0.5"
                                 style={{ height: topH, marginTop: hasWindows ? 1 : 2 }}>
                              <span className="truncate leading-none"
                                    style={{ fontSize: 11, fontWeight: 600, color: 'rgba(167,243,208,0.95)' }}>
                                {focusName}
                                {canCycle && <span style={{ color: 'rgba(167,243,208,0.50)', fontSize: 9 }}> ⟳</span>}
                              </span>
                            </div>
                          )}

                          {/* Sub-window chips — one per original pairwise battle */}
                          {hasWindows && chipH > 0 && (
                            <div className="absolute left-0 right-0 overflow-hidden"
                                 style={{ top: topH + 1, height: chipH }}>
                              {driverWindows.map((w, wi) => {
                                const relS = Math.max(0, (w.start_time - clipStart) / clipDur)
                                const relE = Math.min(1, (w.end_time   - clipStart) / clipDur)
                                const chipW = Math.max(2, (relE - relS) * width)
                                const chipL = relS * width
                                const [bg, fg] = WIN_COLORS[wi % WIN_COLORS.length]
                                const isWinActive = currentTime != null
                                  && currentTime >= w.start_time && currentTime <= w.end_time
                                const wNames = (w.drivers || []).map(nameForCar).join('/')
                                return (
                                  <div key={wi}
                                       className="absolute overflow-hidden"
                                       style={{
                                         left: chipL, width: chipW,
                                         top: 0, height: chipH,
                                         backgroundColor: bg + (isWinActive ? '0.70)' : '0.35)'),
                                         borderLeft: `1px solid ${bg + '0.7)'}`,
                                       }}>
                                    {chipW > 16 && (
                                          <span className="px-0.5 leading-none truncate block"
                                            style={{ fontSize: 9, fontWeight: 700, color: fg + '0.9)', lineHeight: `${chipH}px` }}>
                                        {wNames}
                                      </span>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* ── Events / clips track ────────────────────────────── */}
                  <div className="absolute left-0 right-0 border-b border-border-subtle"
                       style={{ top: SECTION_H + CAM_H + DRIVER_H, height: dynamicEvtH }}>
                    {editSegments.map(seg => {
                      const left   = toX(seg.editStart)
                      const width  = Math.max(3, toX(seg.editDur))
                      const isActive = effectiveActiveSegId === seg.id
                      const section = seg.section || 'race'
                      const sectionMeta = SECTION_META[section] || SECTION_META.race

                      // Colour: always prefer true event-type color when available,
                      // including context/filler clips. This keeps context windows
                      // visually tied to the event they belong to.
                      const color = seg.event_type && EVENT_COLORS[seg.event_type]
                        ? EVENT_COLORS[seg.event_type]
                        : sectionMeta.border.replace('0.40', '0.80').replace('0.45', '0.80')
                                             .replace('0.48', '0.80').replace('0.55', '0.80')

                      const isTrueBridge = seg.type === 'bridge'
                      const isFiller     = isFillerSegment(seg) && !isTrueBridge  // broll, context
                      const isPip        = seg.segment_type === 'pip'
                      const label        = section !== 'race'
                        ? sectionMeta.label
                        : (EVENT_TYPE_LABELS[seg.event_type] || seg.event_type || 'Clip')

                      const raceTimeLabel = seg.start_time_seconds != null
                        ? formatTime(seg.start_time_seconds)
                        : null

                      // Bridges are zero-duration cut markers — render as thin vertical lines
                      if (isTrueBridge) {
                        return (
                          <div
                            key={`evt-${seg.id}`}
                            className="absolute pointer-events-none"
                            style={{
                              left,
                              top: 2,
                              width: 2,
                              height: dynamicEvtH - 4,
                              backgroundColor: 'rgba(255,255,255,0.12)',
                              borderLeft: '1px dashed rgba(255,255,255,0.18)',
                            }}
                          />
                        )
                      }

                      return (
                        <div
                          key={`evt-${seg.id}`}
                          className={`absolute overflow-hidden cursor-pointer transition-all ${
                            isActive ? 'ring-2 ring-white/80 z-20' : 'hover:z-10'
                          }`}
                          style={{
                            left, width,
                            top: isPip ? Math.floor(dynamicEvtH * 0.50) : 2,
                            height: isPip ? Math.floor(dynamicEvtH * 0.46) : dynamicEvtH - 4,
                            backgroundColor: color,
                            opacity: isActive ? 1 : isFiller ? 0.50 : 0.88,
                            borderLeft: `2px solid ${isActive ? 'rgba(255,255,255,0.8)' : isFiller ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'}`,
                          }}
                          title={[
                            label,
                            seg.driver_names?.length > 0 ? `Drivers: ${seg.driver_names.join(', ')}` : null,
                            raceTimeLabel ? `Race time: ${raceTimeLabel}` : null,
                            `Edit: ${formatTime(seg.editStart)} – ${formatTime(seg.editEnd)}`,
                            `Duration: ${fmtDur(seg.editDur)}`,
                            isFiller ? 'Context / filler clip' : null,
                          ].filter(Boolean).join('\n')}
                          onClick={(e) => {
                            e.stopPropagation()
                            setActiveSegId(seg.id)
                            inspectFromSegment(seg, 'timeline-event-card')
                          }}
                        >
                          {/* PIP stripe */}
                          {isPip && width > 8 && (
                            <div className="absolute right-0 top-0 bottom-0 w-1/4 opacity-35"
                                 style={{ backgroundImage: 'repeating-linear-gradient(45deg,transparent,transparent 2px,rgba(255,255,255,0.4) 2px,rgba(255,255,255,0.4) 4px)' }} />
                          )}
                          {/* Active pulse */}
                          {isActive && <div className="absolute inset-0 bg-white/12 animate-pulse pointer-events-none" />}
                          {/* Label */}
                          {width > 18 && (
                            <div className="px-0.5 pt-0.5 truncate" style={{ fontSize: 11, lineHeight: '13px' }}>
                              <span className={`font-semibold ${isFiller ? 'text-white/55' : 'text-white/92'}`}>
                                {label.slice(0, 12)}
                              </span>
                            </div>
                          )}
                          {/* Driver names */}
                          {width > 38 && seg.driver_names?.length > 0 && (
                            <div className="px-0.5 truncate" style={{ fontSize: 10, lineHeight: '12px' }}>
                              <span className="text-white/70">{seg.driver_names.slice(0, 2).join(' / ')}</span>
                            </div>
                          )}
                          {/* Race time stamp */}
                          {width > 38 && raceTimeLabel && (
                            <div className="px-0.5 truncate" style={{ fontSize: 10, lineHeight: '12px' }}>
                              <span className="text-white/55 font-mono">{raceTimeLabel}</span>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* ── Edit-time tick ruler — also a scrub zone ─────── */}
                  <div className="absolute left-0 cursor-ew-resize"
                       style={{ top: SECTION_H + CAM_H + DRIVER_H + dynamicEvtH, height: TICK_H, width: activeContentW }}
                       onMouseDown={handlePlayheadPointerDown}>
                    <EditTickRuler
                      totalW={activeContentW}
                      totalEditDuration={totalEditDuration}
                      pxPerSec={activePxPerSec}
                      top={0}
                      height={TICK_H}
                    />
                  </div>

                  {/* Draggable virtual playhead (algorithmically mapped to replay session time) */}
                  {virtualPlayheadX != null && (
                    <div
                      className="absolute top-0 bottom-0 z-40 cursor-ew-resize"
                      style={{ left: virtualPlayheadX }}
                      onMouseDown={handlePlayheadPointerDown}
                      title="Drag to scrub script position"
                    >
                      <div className={`w-px h-full ${isDraggingPlayhead ? 'bg-red-400' : 'bg-red-500'}`} />
                      <div className={`absolute -top-1 -left-1 w-2 h-2 rounded-full ${isDraggingPlayhead ? 'bg-red-400' : 'bg-red-500'}`} />
                    </div>
                  )}
                </div>
              </div>
            </div>
            <RangeSlider
              rangeStart={rangeStart}
              rangeEnd={rangeEnd}
              onChange={setRange}
              totalDuration={totalEditDuration}
              events={rangeSliderEvents}
              playheadTime={virtualPlayheadTime}
            />
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Edit-time tick ruler ──────────────────────────────────────────────────────
function EditTickRuler({ totalW, totalEditDuration, pxPerSec, top, height }) {
  const ticks = useMemo(() => {
    if (totalEditDuration <= 0 || pxPerSec <= 0) return []
    const rawInterval = 80 / pxPerSec
    const nice = [1, 5, 10, 15, 30, 60, 120, 300, 600]
    const interv = nice.find(v => v >= rawInterval) || 600
    const major  = interv * 5
    const result = []
    for (let t = 0; t <= totalEditDuration + interv; t += interv) {
      result.push({ t, major: t % major === 0 })
    }
    return result
  }, [totalEditDuration, pxPerSec])

  return (
    <div className="absolute left-0 bg-bg-secondary border-t border-border-subtle select-none overflow-hidden"
         style={{ top, height, width: totalW }}>
      {ticks.map(({ t, major }) => (
        <div key={t} className="absolute" style={{ left: t * pxPerSec }}>
          <div className={`absolute top-0 w-px ${major ? 'h-full bg-border' : 'h-1/2 bg-border-subtle'}`} />
          {major && (
            <span className="absolute left-1 top-1 font-mono text-text-disabled whitespace-nowrap" style={{ fontSize: 11 }}>
              {formatTime(t)}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
