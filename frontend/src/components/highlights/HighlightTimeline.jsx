import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { useHighlight, EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { useTimeline, EVENT_COLORS } from '../../context/TimelineContext'
import { useIRacing } from '../../context/IRacingContext'
import { useProject } from '../../context/ProjectContext'
import { apiGet, apiPost } from '../../services/api'
import { formatTime } from '../../utils/time'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import TimelineToolbar from '../timeline/TimelineToolbar'
import RangeSlider from '../ui/RangeSlider'
import { ChevronDown, ChevronRight, Film, Play, Square, SkipBack, SkipForward, FileText, Copy, X, Loader2 } from 'lucide-react'


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
const CAM_H        = 18   // camera track
const DRIVER_H     = 24   // driver focus track (extra height for sub-window bands)
const EVT_H        = 46   // events track
const TICK_H       = 20   // tick ruler
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

function getCameraLabel(seg) {
  if (seg?.camera_hints?.establishing_angle) return seg.camera_hints.establishing_angle
  if (seg?.camera_preferences?.length)       return seg.camera_preferences[0]
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

function buildScriptReportText(scriptReport, totalSegments) {
  if (!scriptReport) return 'No script data.'
  const lines = []
  const hr = '─'.repeat(60)
  lines.push('RACE SCRIPT REPORT')
  lines.push(hr)
  lines.push('')
  lines.push('## Clip Breakdown')
  lines.push(`Event clips (race highlights): ${scriptReport.eventClips.length}`)
  lines.push(`Contextual fills (unselected events): ${scriptReport.contextClips.length}`)
  lines.push(`Bridge fillers (B-roll): ${scriptReport.bridgeClips.length}`)
  lines.push(`Static sections (intro/qualifying/results): ${scriptReport.sectionClips.length}`)
  lines.push(`Total segments: ${totalSegments}`)
  lines.push('')
  lines.push('## Duration')
  lines.push(`Content duration: ${fmtDur(scriptReport.totalContent)}`)
  lines.push(`Filler/context duration: ${fmtDur(scriptReport.totalFiller)}`)
  lines.push('')
  lines.push('## Event Clips by Type')
  const entries = Object.entries(scriptReport.byType || {}).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) {
    lines.push('  (none)')
  } else {
    for (const [type, count] of entries) {
      lines.push(`  ${EVENT_TYPE_LABELS[type] || type}: ${count}`)
    }
  }
  return lines.join('\n')
}

// ── Main component ────────────────────────────────────────────────────────────
export default function HighlightTimeline() {
  const { videoScript, metrics, pushScriptAction, clearScriptActionLog, serverScoring } = useHighlight()
  const { isConnected, sessionData } = useIRacing()
  const { activeProject } = useProject()
  const { setSelectedEventId } = useTimeline()

  const [collapsed, setCollapsed] = useLocalStorage('lrs:editing:timeline:collapsed', false)
  const [executing, setExecuting] = useState(false)
  const [activeSegId, setActiveSegId] = useState(null)
  const abortRef = useRef({ cancelled: false })
  const [replaySpeed, setReplaySpeed] = useLocalStorage('lrs:editing:timeline:speed', 1)
  const [replayState, setReplayState] = useState(null)
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false)
  const [scrubSegId, setScrubSegId] = useState(null)
  const [optimisticEditTime, setOptimisticEditTime] = useState(null)
  const [showScriptReport, setShowScriptReport] = useState(false)
  const scrollRef = useRef(null)
  // segId → car_idx override for driver focus; reset whenever script is regenerated
  const [driverFocusOverrides, setDriverFocusOverrides] = useState({})
  useEffect(() => { setDriverFocusOverrides({}) }, [videoScript])

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

  // Poll replay state so playhead can track true iRacing position.
  useEffect(() => {
    if (!isConnected) {
      setReplayState(null)
      return
    }
    const tick = () => {
      apiGet('/iracing/replay/state')
        .then(data => setReplayState(data || null))
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
      cursor += dur
      return { ...seg, editStart, editEnd: cursor, editDur: dur, clipStartTime, clipEndTime }
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

  const seekScriptPosition = useCallback(async (editTime) => {
    const resolved = resolveSegmentAtEditTime(editTime)
    if (!resolved) return
    const { seg, segmentEditOffset } = resolved
    const sessionTime = (seg.clipStartTime ?? seg.start_time_seconds ?? 0) + segmentEditOffset
    const cameras = sessionData?.cameras || []

    setActiveSegId(seg.id)

    try {
      await apiPost('/iracing/replay/seek-time', {
        session_num: raceSessionNum,
        session_time_ms: Math.round(sessionTime * 1000),
      })
    } catch { /* non-fatal */ }

    try {
      const camLabel = getCameraLabel(seg)
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
  }, [resolveSegmentAtEditTime, sessionData, raceSessionNum, getFocusCarIdx])

  const handlePlayheadPointerDown = useCallback((e) => {
    if (!hasData || e.button !== 0) return
    e.preventDefault()

    const applyDrag = (clientX) => {
      const editTime = getEditTimeFromClientX(clientX)
      setOptimisticEditTime(editTime)
      const resolved = resolveSegmentAtEditTime(editTime)
      setScrubSegId(resolved?.seg?.id ?? null)
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
    if (replayState?.session_time == null) {
      if (!effectiveActiveSegId) return 0
      const seg = editSegments.find(s => s.id === effectiveActiveSegId)
      return seg ? seg.editStart : 0
    }
    return mapSessionTimeToEditTime(replayState.session_time, effectiveActiveSegId)
  }, [
    hasData,
    optimisticEditTime,
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
    } catch { /* non-fatal */ }
    try {
      const camLabel = getCameraLabel(seg)
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
  }, [editSegments, raceSessionNum, sessionData, getFocusCarIdx])

  // ── Execute Script ──────────────────────────────────────────────────────────
  const executeScript = useCallback(async (fromIndex = 0) => {
    const segs = editSegments.slice(fromIndex)
    if (!segs.length) return
    const abort = { cancelled: false }
    abortRef.current = abort
    setExecuting(true)
    clearScriptActionLog()

    const cameras = sessionData?.cameras || []
    const speed   = replaySpeed

    for (const seg of segs) {
      if (abort.cancelled) break
      const startSec = seg.clipStartTime ?? seg.start_time_seconds ?? 0
      const durMs    = Math.max(500, (seg.editDur * 1000) / Math.max(0.25, speed))

      setActiveSegId(seg.id)

      try {
        await apiPost('/iracing/replay/seek-time', {
          session_num: raceSessionNum,
          session_time_ms: Math.round(startSec * 1000),
        })
      } catch { /* iRacing disconnected */ }

      let appliedCamLabel = null
      let appliedDriverName = null
      try {
        const camLabel = getCameraLabel(seg)
        appliedCamLabel = camLabel
        const cam = cameras.find(c => c.group_name === camLabel)
        if (cam) {
          const carIdx = getFocusCarIdx(seg, startSec)
          const drvNames = seg.driver_names || []
          const drvIdx   = (seg.involved_drivers || []).indexOf(carIdx)
          appliedDriverName = drvIdx >= 0 ? drvNames[drvIdx] : (drvNames[0] || null)
          await apiPost('/iracing/replay/camera', {
            group_num: cam.group_num,
            ...(carIdx != null ? { car_idx: carIdx } : { position: 1 }),
          })
        }
      } catch { /* non-fatal */ }

      // Push action to preview feed
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

      try {
        await apiPost('/iracing/replay/speed', { speed })
        await apiPost('/iracing/replay/play')
      } catch { /* non-fatal */ }

      await new Promise(resolve => {
        const timer = setTimeout(resolve, durMs)
        const poll  = setInterval(() => {
          if (abort.cancelled) { clearTimeout(timer); clearInterval(poll); resolve() }
        }, 100)
        setTimeout(() => clearInterval(poll), durMs + 200)
      })
    }

    if (!abort.cancelled) {
      try { await apiPost('/iracing/replay/pause') } catch { /* non-fatal */ }
    }
    setExecuting(false)
    setActiveSegId(null)
  }, [editSegments, raceSessionNum, sessionData, replaySpeed, getFocusCarIdx, pushScriptAction, clearScriptActionLog])

  const stopExecution = useCallback(() => {
    abortRef.current.cancelled = true
    setExecuting(false)
    setActiveSegId(null)
    apiPost('/iracing/replay/pause').catch(() => {})
  }, [])

  // ── Clip count summary ──────────────────────────────────────────────────────
  // Count only race section event clips (not intro/qualifying/results static sections, not filler)
  const clipCount = editSegments.filter(s => s.section === 'race' && !isFillerSegment(s)).length
  const fillCount = editSegments.filter(s => isFillerSegment(s)).length
  const contentDuration = editSegments
    .filter(s => !isFillerSegment(s))
    .reduce((acc, s) => acc + (s.editDur || 0), 0)
  // Script report data (computed from editSegments for the modal)
  const scriptReport = useMemo(() => {
    if (!editSegments.length) return null
    const eventClips    = editSegments.filter(s => s.section === 'race' && !isFillerSegment(s))
    const contextClips  = editSegments.filter(s => s.type === 'context')
    const bridgeClips   = editSegments.filter(s => s.type === 'bridge' || s.type === 'broll')
    const sectionClips  = editSegments.filter(s => s.section && s.section !== 'race')
    const totalContent  = editSegments.filter(s => !isFillerSegment(s)).reduce((a, s) => a + (s.editDur || 0), 0)
    const totalFiller   = [...contextClips, ...bridgeClips].reduce((a, s) => a + (s.editDur || 0), 0)
    const byType = {}
    for (const s of eventClips) {
      const t = s.event_type || s.type || 'unknown'
      byType[t] = (byType[t] || 0) + 1
    }
    return { eventClips, contextClips, bridgeClips, sectionClips, totalContent, totalFiller, byType }
  }, [editSegments])

  const scriptReportText = useMemo(
    () => buildScriptReportText(scriptReport, editSegments.length),
    [scriptReport, editSegments.length],
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
          <div className="bg-bg-tertiary border border-border rounded-2xl shadow-float w-full max-w-3xl mx-4 flex flex-col max-h-[85vh]"
               onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
              <h3 className="text-lg font-semibold text-text-primary">Race Script Report</h3>
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
            <div className="flex-1 overflow-auto p-6">
              <pre className="text-xs text-text-secondary font-mono whitespace-pre-wrap leading-relaxed">
                {scriptReportText}
              </pre>
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
              {clipCount} clips &middot; {fillCount} fills &middot; {fmtDur(contentDuration)}
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

          {/* Play from here / Stop */}
          <button
            onClick={() => executing
              ? stopExecution()
              : executeScript(Math.max(0, activeSegIndex))}
            disabled={!isConnected}
            title={executing ? 'Stop' : isConnected ? 'Execute script from here' : 'iRacing not connected'}
            className={`p-1 rounded transition-colors disabled:opacity-30 ${
              executing
                ? 'text-red-400 hover:text-red-300 hover:bg-red-500/10'
                : 'text-accent hover:text-accent-light hover:bg-accent/10'
            }`}
          >
            {executing ? <Square size={13} /> : <Play size={13} />}
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
          <span className="text-xxs font-mono text-text-disabled w-12 text-center shrink-0">
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

          {/* Speed selector */}
          <div className="flex items-center gap-px">
            {[0.5, 1, 2, 4].map(spd => (
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

                  {/* ── Section band row ──────────────────────────────── */}
                  <div className="absolute left-0 right-0 border-b border-border-subtle"
                       style={{ top: 0, height: SECTION_H }}>
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
                      const camLabel = getCameraLabel(seg)
                      const isActive = effectiveActiveSegId === seg.id
                      const sectionMeta = SECTION_META[seg.section] || SECTION_META.race
                      const bgColor = isActive ? 'rgba(99,102,241,0.65)' : 'rgba(99,102,241,0.36)'
                      return (
                        <div key={`cam-${seg.id}`}
                             className={`absolute flex items-center overflow-hidden ${isActive ? 'ring-1 ring-white/60' : ''}`}
                             style={{
                               left, width, top: 2, height: CAM_H - 4,
                               backgroundColor: seg.section !== 'race' ? sectionMeta.color.replace('0.20', '0.50').replace('0.15', '0.45').replace('0.28', '0.55') : bgColor,
                               borderLeft: `2px solid ${isActive ? 'rgba(255,255,255,0.6)' : (seg.section !== 'race' ? sectionMeta.border : 'rgba(99,102,241,0.55)')}`,
                             }}
                             title={`${seg.section !== 'race' ? (SECTION_META[seg.section]?.label || seg.section) : ''} Camera: ${camLabel}`}>
                          {width > 18 && (
                            <span className="px-0.5 truncate font-mono leading-none"
                                  style={{ fontSize: 9, color: seg.section !== 'race' ? sectionMeta.text : 'rgba(220,210,255,0.85)' }}>
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
                      if (drivers.length === 0 || isFillerSegment(seg)) return null

                      const currentTime = replayState?.session_time ?? null
                      const focusCarIdx = getFocusCarIdx(seg, currentTime)
                      const focusPos    = drivers.indexOf(focusCarIdx)
                      const focusName   = drvNames[focusPos >= 0 ? focusPos : 0] || `#${focusCarIdx}`
                      const isActive    = effectiveActiveSegId === seg.id

                      // Sub-window bands (merged multi-driver battles)
                      const driverWindows = seg.metadata?.driver_windows
                      const clipStart  = seg.clipStartTime ?? seg.start_time_seconds ?? 0
                      const clipEnd    = seg.clipEndTime   ?? seg.end_time_seconds   ?? clipStart
                      const clipDur    = Math.max(0.001, clipEnd - clipStart)
                      const nameForCar = (carIdx) => {
                        const p = drivers.indexOf(carIdx)
                        return p >= 0 && drvNames[p] ? drvNames[p] : `#${carIdx}`
                      }

                      const WIN_COLORS = [
                        ['rgba(16,185,129,', 'rgba(167,243,208,'],  // emerald
                        ['rgba(6,182,212,',  'rgba(103,232,249,'],  // cyan
                        ['rgba(139,92,246,', 'rgba(196,181,253,'],  // violet
                        ['rgba(245,158,11,', 'rgba(253,211,77,'],   // amber
                      ]

                      const hasWindows = driverWindows && driverWindows.length > 1
                      // Height split: top band = focused driver name, bottom band = window chips
                      const topH   = hasWindows ? Math.floor(DRIVER_H * 0.52) : DRIVER_H - 4
                      const chipH  = hasWindows ? DRIVER_H - topH - 2 : 0

                      const canCycle = getActiveDrivers(seg, currentTime).length > 1

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
                                    style={{ fontSize: 9, fontWeight: 600, color: 'rgba(167,243,208,0.95)' }}>
                                {focusName}
                                {canCycle && <span style={{ color: 'rgba(167,243,208,0.50)', fontSize: 8 }}> ⟳</span>}
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
                                            style={{ fontSize: 7, fontWeight: 700, color: fg + '0.9)', lineHeight: `${chipH}px` }}>
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

                      // Colour: event type for race clips, section colour for non-race
                      const color = section === 'race' && !isFillerSegment(seg)
                        ? (EVENT_COLORS[seg.event_type] || '#f97316')
                        : sectionMeta.border.replace('0.40', '0.80').replace('0.45', '0.80')
                                             .replace('0.48', '0.80').replace('0.55', '0.80')

                      const isBridge = isFillerSegment(seg)
                      const isPip    = seg.segment_type === 'pip'
                      const label    = section !== 'race'
                        ? sectionMeta.label
                        : (EVENT_TYPE_LABELS[seg.event_type] || seg.event_type || 'Clip')

                      const raceTimeLabel = seg.start_time_seconds != null
                        ? formatTime(seg.start_time_seconds)
                        : null

                      return (
                        <div
                          key={`evt-${seg.id}`}
                          className={`absolute overflow-hidden cursor-pointer transition-all ${
                            isActive ? 'ring-2 ring-white/80 z-20' : 'hover:z-10'
                          }`}
                          style={{
                            left, width,
                            top: isBridge ? Math.floor(dynamicEvtH * 0.62) : (isPip ? Math.floor(dynamicEvtH * 0.50) : 2),
                            height: isBridge ? Math.floor(dynamicEvtH * 0.34) : (isPip ? Math.floor(dynamicEvtH * 0.46) : dynamicEvtH - 4),
                            backgroundColor: color,
                            opacity: isActive ? 1 : isBridge ? 0.55 : 0.88,
                            borderLeft: `2px solid ${isActive ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.2)'}`,
                          }}
                          title={[
                            label,
                            seg.driver_names?.length > 0 ? `Drivers: ${seg.driver_names.join(', ')}` : null,
                            raceTimeLabel ? `Race time: ${raceTimeLabel}` : null,
                            `Edit: ${formatTime(seg.editStart)} – ${formatTime(seg.editEnd)}`,
                            `Duration: ${fmtDur(seg.editDur)}`,
                            isBridge ? 'Bridge / gap filler' : null,
                          ].filter(Boolean).join('\n')}
                          onClick={() => { setActiveSegId(seg.id); setSelectedEventId(seg.id) }}
                        >
                          {/* Hatching for bridge filler */}
                          {isBridge && (
                            <div className="absolute inset-0 opacity-30"
                                 style={{ backgroundImage: 'repeating-linear-gradient(45deg,transparent,transparent 3px,rgba(255,255,255,0.25) 3px,rgba(255,255,255,0.25) 6px)' }} />
                          )}
                          {/* PIP stripe */}
                          {isPip && width > 8 && (
                            <div className="absolute right-0 top-0 bottom-0 w-1/4 opacity-35"
                                 style={{ backgroundImage: 'repeating-linear-gradient(45deg,transparent,transparent 2px,rgba(255,255,255,0.4) 2px,rgba(255,255,255,0.4) 4px)' }} />
                          )}
                          {/* Active pulse */}
                          {isActive && <div className="absolute inset-0 bg-white/12 animate-pulse pointer-events-none" />}
                          {/* Label */}
                          {width > 18 && !isBridge && (
                            <div className="px-0.5 pt-0.5 truncate" style={{ fontSize: 10, lineHeight: '12px' }}>
                              <span className="text-white/92 font-semibold">{label.slice(0, 12)}</span>
                            </div>
                          )}
                          {/* Driver names for race event clips */}
                          {width > 38 && !isBridge && seg.driver_names?.length > 0 && (
                            <div className="px-0.5 truncate" style={{ fontSize: 9, lineHeight: '11px' }}>
                              <span className="text-white/70">{seg.driver_names.slice(0, 2).join(' / ')}</span>
                            </div>
                          )}
                          {/* Race time stamp for race clips */}
                          {width > 38 && !isBridge && raceTimeLabel && (
                            <div className="px-0.5 truncate" style={{ fontSize: 9, lineHeight: '11px' }}>
                              <span className="text-white/55 font-mono">{raceTimeLabel}</span>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* ── Edit-time tick ruler ───────────────────────────── */}
                  <EditTickRuler
                    totalW={activeContentW}
                    totalEditDuration={totalEditDuration}
                    pxPerSec={activePxPerSec}
                    top={SECTION_H + CAM_H + DRIVER_H + dynamicEvtH}
                    height={TICK_H}
                  />

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
            <span className="absolute left-1 top-1 font-mono text-text-disabled whitespace-nowrap" style={{ fontSize: 7 }}>
              {formatTime(t)}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
