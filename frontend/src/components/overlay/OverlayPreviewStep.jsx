import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { usePreset } from '../../context/PresetContext'
import { useProject } from '../../context/ProjectContext'
import { useScriptState } from '../../context/ScriptStateContext'
import { useOverlaySettings } from '../../context/OverlaySettingsContext'
import { useToast } from '../../context/ToastContext'
import { useIRacing } from '../../context/IRacingContext'
import { EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { useAuthoritativeReplayPlayhead } from '../../hooks/useAuthoritativeReplayPlayhead'
import { useLivePreview } from '../../context/LivePreviewContext'
import { formatTime } from '../../utils/time'
import { apiGet, apiPost } from '../../services/api'
import { wsClient } from '../../services/websocket'
import ResizableRowPane from '../ui/ResizableRowPane'
import IsolatedHtmlPreview from '../ui/IsolatedHtmlPreview'
import {
  Play, Pause, SkipBack, SkipForward, Layers, Eye, EyeOff,
  Monitor, Film, Award, Flag, ZoomIn, ZoomOut, Maximize2,
  RefreshCw, Loader2, Bug, Copy, Terminal, AlertTriangle,
} from 'lucide-react'
import PlaybackControls from '../ui/PlaybackControls'
import CollapsiblePanelHeader from '../ui/CollapsiblePanelHeader'
import ConfigurableTimelineTracks from '../ui/ConfigurableTimelineTracks'
import RangeSlider from '../ui/RangeSlider'
import PreviewPlayer from '../analysis/PreviewPlayer'
import IracingCommandLog from '../highlights/IracingCommandLog'
import OverlayWorkspaceTopbar from './OverlayWorkspaceTopbar'

/**
 * Section metadata for the overlay preview.
 */
const SECTIONS = [
  { id: 'intro', label: 'Intro', icon: Film, color: 'text-blue-400' },
  { id: 'qualifying_results', label: 'Qualifying', icon: Award, color: 'text-amber-400' },
  { id: 'race', label: 'Race', icon: Flag, color: 'text-emerald-400' },
  { id: 'race_results', label: 'Results', icon: Monitor, color: 'text-purple-400' },
]

const OVERLAY_TIMELINE_SECTION_H = 18
const OVERLAY_TIMELINE_EVENT_H = 46
const OVERLAY_TIMELINE_TEMPLATE_H = 34
const OVERLAY_TIMELINE_ACTIONS_H = 18
const OVERLAY_TIMELINE_TICK_H = 24
const OVERLAY_TIMELINE_TOTAL_H = OVERLAY_TIMELINE_SECTION_H + OVERLAY_TIMELINE_TEMPLATE_H + OVERLAY_TIMELINE_ACTIONS_H + OVERLAY_TIMELINE_EVENT_H + OVERLAY_TIMELINE_TICK_H

const SECTION_TRACK_STYLE = {
  intro:              { bg: 'rgba(59,130,246,0.24)', border: 'rgba(59,130,246,0.5)', text: 'rgba(147,197,253,0.95)', label: 'Intro' },
  qualifying_results: { bg: 'rgba(245,158,11,0.22)', border: 'rgba(245,158,11,0.45)', text: 'rgba(252,211,77,0.95)', label: 'Qualifying' },
  race:               { bg: 'rgba(16,185,129,0.20)', border: 'rgba(16,185,129,0.4)', text: 'rgba(110,231,183,0.95)', label: 'Race' },
  race_results:       { bg: 'rgba(168,85,247,0.22)', border: 'rgba(168,85,247,0.45)', text: 'rgba(216,180,254,0.95)', label: 'Results' },
}

const DEFAULT_CAM = {
  battle: 'TV1', overtake: 'TV1',
  crash: 'Cockpit', incident: 'Cockpit', spinout: 'Cockpit',
  contact: 'Bumper', close_call: 'Bumper',
  race_start: 'TV Scenic', race_finish: 'TV Scenic',
  fastest_lap: 'TV1', pit_stop: 'Pit Lane',
  leader_change: 'TV1', first_lap: 'TV Scenic', last_lap: 'TV1',
}

function getCameraLabel(seg) {
  const prefs = seg?.camera_preferences
  if (prefs?.length) return prefs[0]
  if (seg?.camera_hints?.establishing_angle) return seg.camera_hints.establishing_angle
  return DEFAULT_CAM[seg?.event_type] || 'TV1'
}

function getActiveDrivers(seg, sessionTime) {
  const windows = seg?.metadata?.driver_windows
  const allDrivers = seg?.involved_drivers || []
  if (!windows || windows.length === 0 || sessionTime == null) return allDrivers
  const active = new Set()
  for (const window of windows) {
    if (sessionTime >= window.start_time && sessionTime <= window.end_time) {
      for (const driver of window.drivers) active.add(driver)
    }
  }
  return active.size > 0 ? allDrivers.filter((driver) => active.has(driver)) : allDrivers
}

function getSegmentOverlayDesignId(seg, defaultDesignId) {
  return seg?.overlay_preset_id
    || seg?.overlay_preset
    || seg?.overlayPresetId
    || defaultDesignId
    || null
}

function getOverlayEventLabel(seg) {
  if (seg?.event_type) return EVENT_TYPE_LABELS[seg.event_type] || seg.event_type
  if (seg?.type === 'bridge') return 'Bridge'
  if (seg?.type === 'broll') return 'B-roll'
  if (seg?.type === 'context') return 'Context'
  return 'Clip'
}

function buildStandingsFromSessionDrivers(drivers = [], focusedCarIdx = null) {
  if (!Array.isArray(drivers) || drivers.length === 0) return []

  const sorted = [...drivers]
    .filter(Boolean)
    .sort((a, b) => {
      const aPos = Number(a.position ?? a.pos ?? 9999)
      const bPos = Number(b.position ?? b.pos ?? 9999)
      return aPos - bPos
    })

  return sorted.slice(0, 20).map((driver, idx) => {
    const pos = Number(driver.position ?? driver.pos ?? (idx + 1))
    const carIdx = Number(driver.car_idx ?? driver.carIdx ?? -1)
    const name = driver.driver_name
      || driver.user_name
      || driver.name
      || `Driver ${idx + 1}`
    const carNumber = String(driver.car_number ?? driver.number ?? '')
    const rawGap = driver.gap ?? driver.gap_to_leader ?? null
    const gapText = pos === 1
      ? 'Leader'
      : (rawGap === null || rawGap === undefined || rawGap === '' ? '---' : String(rawGap))

    return {
      position: pos,
      driver_name: name,
      car_number: carNumber,
      is_player: (focusedCarIdx !== null && focusedCarIdx !== undefined) ? carIdx === focusedCarIdx : Boolean(driver.is_player),
      gap: gapText,
      gap_to_leader: gapText,
      relative: driver.relative ?? null,
      iracing_cust_id: Number(driver.iracing_cust_id ?? driver.cust_id ?? 0),
    }
  })
}

function sanitizePreviewHtmlForInlineRender(html, renderWidth = 1920, renderHeight = 1080) {
  if (!html || typeof html !== 'string') return ''

  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')

    // Strip dangerous embedding/navigation tags.
    doc.querySelectorAll('iframe,object,embed,frame,frameset,base,meta[http-equiv="refresh"]').forEach((n) => n.remove())

    // Keep the local Tailwind runtime and CDN fallback; strip everything else.
    const allowedScriptSources = new Set([
      'https://cdn.tailwindcss.com',
      'http://cdn.tailwindcss.com',
      '//cdn.tailwindcss.com',
    ])
    doc.querySelectorAll('script').forEach((scriptEl) => {
      const src = (scriptEl.getAttribute('src') || '').trim()
      const id = (scriptEl.getAttribute('id') || '').trim()
      const isAllowedInlineRuntime = !src && id === 'lrs-tailwind-runtime'
      if (!isAllowedInlineRuntime && (!src || !allowedScriptSources.has(src))) {
        scriptEl.remove()
      }
    })

    // Strip event handlers and javascript: URLs.
    doc.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase()
        if (name.startsWith('on')) { el.removeAttribute(attr.name); return }
        if ((name === 'src' || name === 'href' || name === 'xlink:href') && /^\s*javascript:/i.test(attr.value)) {
          el.removeAttribute(attr.name)
        }
      })
    })

    // Inject base sizing so html/body fill the iframe at the render resolution.
    const safeW = Math.max(1, Number(renderWidth) || 1920)
    const safeH = Math.max(1, Number(renderHeight) || 1080)
    const baseStyle = doc.createElement('style')
    baseStyle.id = 'lrs-iframe-base'
    baseStyle.textContent = `:root,html,body{margin:0;padding:0;width:${safeW}px;height:${safeH}px;background:transparent!important;background-color:transparent!important;overflow:hidden;}`
    doc.head.prepend(baseStyle)

    // Return a complete document — the iframe has a real html/body context so
    // Tailwind's runtime can inject styles into its own <head> as intended.
    return '<!DOCTYPE html>' + doc.documentElement.outerHTML
  } catch {
    return ''
  }
}

/**
 * OverlayPreviewStep — Read-only timeline with overlay preview.
 *
 * Displays a read-only timeline derived from the script, with section tabs
 * (intro / qualifying / race / results).  The preview region shows the
 * overlay rendered over the iRacing replay stream for each segment.
 *
 * All overlays are telemetry-driven, so the preview updates correctly
 * as the user scrubs / plays through the timeline.
 *
 * @param {Object} props
 * @param {Array} props.script - The video composition script segments
 * @param {number} [props.projectId] - Active project ID
 * @param {string} [props.selectedPresetId] - Active visual preset
 */
export default function OverlayPreviewStep({
  script = [],
  projectId,
  selectedPresetId,
  scriptGeneratedAt = null,
  onScriptChange = null,
}) {
  const { presets, selectedPreset, renderPreview, activeSection, setActiveSection } = usePreset()
  const { activeProject } = useProject()
  const { overlayUiConfig, fetchOverlayUiConfig, updateOverlayUiConfig } = useScriptState()
  const { showSuccess, showError } = useToast()
  const { isConnected, sessionData } = useIRacing()
  const { streamAspectRatio, streamUrl } = useLivePreview()
  const {
    previewRenderMode,
    setPreviewRenderMode,
    overlayVisible,
    setOverlayVisible,
    showLiveStreamUnderlay,
    setShowLiveStreamUnderlay,
    previewZoom,
    setPreviewZoom,
    showEventOverlay,
    setShowEventOverlay,
    debugEnabled,
    setDebugEnabled,
  } = useOverlaySettings()

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewFrame, setPreviewFrame] = useState(null)
  const [previewDiagnostics, setPreviewDiagnostics] = useState(null)
  const [previewRenderSize, setPreviewRenderSize] = useState({ width: 1920, height: 1080 })
  const [visualPreviewImage, setVisualPreviewImage] = useState(null)
  const [visualPreviewHtml, setVisualPreviewHtml] = useState(null)
  const [visualPreviewError, setVisualPreviewError] = useState(null)
  const [previewFullscreen, setPreviewFullscreen] = useState(false)
  const [overlayUiZoomDraft, setOverlayUiZoomDraft] = useState(1)
  const [commandFeedCount, setCommandFeedCount] = useState(0)
  const [lastCommandLabel, setLastCommandLabel] = useState(null)
  const [debugInfo, setDebugInfo] = useState({
    renderSeq: 0,
    lastRunAt: null,
    sessionTime: null,
    frameSource: 'fallback',
    telemetryStatus: 'idle',
    telemetryError: null,
    renderStatus: 'idle',
    renderMs: null,
    renderError: null,
    requestedPresetId: null,
    requestedPreferHtml: true,
    renderSource: null,
    renderHtmlLength: null,
    backendHasHtmlContent: null,
    backendSectionElementCount: null,
    backendUsedElementFilter: null,
    backendPreferHtmlContent: null,
    animationMode: 'idle',
    animationSummary: null,
    focusedCarIdx: null,
    cameraTargetKey: null,
    cameraStatus: 'idle',
    cameraError: null,
    standingsSource: null,
    standingsCount: 0,
    standingsPreview: null,
    previewSection: null,
    pageIndex: null,
    pageStart: null,
    pageEnd: null,
    totalPages: null,
  })
  const [timelineCollapsed, setTimelineCollapsed] = useLocalStorage('lrs:overlay:timeline:collapsed', false)
  const [raceSessionNum, setRaceSessionNum] = useState(null)
  const timelineRef = useRef(null)
  const previewViewportRef = useRef(null)
  const didInitSectionSeekRef = useRef(false)
  const lastAppliedCameraTargetRef = useRef(null)
  const renderSeqRef = useRef(0)
  const [previewBoxSize, setPreviewBoxSize] = useState({ width: 0, height: 0 })
  
  // Range slider zoom/pan state
  const [rangeStart, setRangeStart] = useState(0)
  const [rangeEnd, setRangeEnd] = useState(1)
  const scrollRef = useRef(null)
  const syncingRef = useRef(false)
  const [containerW, setContainerW] = useState(0)

  const [containerH, setContainerH] = useState(0)

  const overlayUiZoom = useMemo(() => {
    const raw = Number(overlayUiConfig?.ui_zoom)
    if (!Number.isFinite(raw)) return 1
    return Math.max(0.5, Math.min(2, raw))
  }, [overlayUiConfig?.ui_zoom])

  const updateDebug = useCallback((patch) => {
    if (!debugEnabled) return
    setDebugInfo((prev) => ({ ...prev, ...patch }))
  }, [debugEnabled])

  // Measure the scrollable container so zoom fills actual width and height is responsive
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => { setContainerW(el.clientWidth); setContainerH(el.clientHeight) }
    measure()
    const obs = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerW(entry.contentRect.width)
        setContainerH(entry.contentRect.height)
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [timelineCollapsed])

  useEffect(() => {
    const unsub = wsClient.subscribe('iracing:command', (data) => {
      setCommandFeedCount((prev) => prev + 1)
      setLastCommandLabel(data?.command || null)
    })
    return unsub
  }, [])

  useEffect(() => {
    setOverlayUiZoomDraft(overlayUiZoom)
  }, [overlayUiZoom])

  useEffect(() => {
    if (!projectId) return
    fetchOverlayUiConfig(projectId)
  }, [fetchOverlayUiConfig, projectId])

  const commitOverlayUiZoom = useCallback(async (value) => {
    if (!projectId) return
    const normalized = Math.max(0.5, Math.min(2, Number(value) || 1))
    try {
      await updateOverlayUiConfig(projectId, { ui_zoom: normalized })
    } catch {
      showError('Failed to save overlay UI zoom')
      setOverlayUiZoomDraft(overlayUiZoom)
    }
  }, [overlayUiZoom, projectId, showError, updateOverlayUiConfig])

  useEffect(() => {
    if (!projectId) return
    apiGet(`/projects/${projectId}/analysis/race-duration`)
      .then((data) => {
        setRaceSessionNum(data?.race_session_num ?? null)
      })
      .catch(() => {
        setRaceSessionNum(null)
      })
  }, [projectId])

  // ── Script analysis ─────────────────────────────────────────────────────
  const segments = useMemo(() => {
    if (!script || !Array.isArray(script)) return []
    return script.filter(s => s.type !== 'transition' && s.type !== 'bridge' && (s.end_time_seconds - s.start_time_seconds) > 0)
  }, [script])

  const sectionSegments = useMemo(() => {
    return segments.filter(s => {
      const sec = s.section || 'race'
      if (activeSection === 'qualifying_results') return sec === 'qualifying' || sec === 'qualifying_results'
      if (activeSection === 'race_results') return sec === 'results' || sec === 'race_results'
      return sec === activeSection
    })
  }, [segments, activeSection])

  const totalDuration = useMemo(() => {
    if (sectionSegments.length === 0) return 0
    return sectionSegments.reduce((sum, seg) => {
      const start = Number(seg.start_time_seconds || 0)
      const end = Number(seg.end_time_seconds || start)
      return sum + Math.max(0, end - start)
    }, 0)
  }, [sectionSegments])

  const sectionStart = useMemo(() => {
    if (sectionSegments.length === 0) return 0
    return Math.min(...sectionSegments.map(s => s.start_time_seconds || 0))
  }, [sectionSegments])

  const timelineSegments = useMemo(() => {
    let cursor = 0
    return sectionSegments.map((seg) => {
      const start = Number(seg.start_time_seconds || 0)
      const end = Number(seg.end_time_seconds || start)
      const duration = Math.max(0, end - start)
      const timelineStart = cursor
      const timelineEnd = timelineStart + duration
      cursor = timelineEnd
      return {
        seg,
        timelineStart,
        timelineEnd,
        duration,
        absoluteStart: start,
        absoluteEnd: end,
      }
    })
  }, [sectionSegments])

  const mapLocalTimeToAbsoluteTime = useCallback((localTime) => {
    if (!timelineSegments.length) return sectionStart
    const clamped = Math.max(0, Math.min(totalDuration, Number(localTime) || 0))
    const entry = timelineSegments.find((item) => clamped >= item.timelineStart && clamped <= item.timelineEnd)
      || timelineSegments[timelineSegments.length - 1]
    if (!entry) return sectionStart
    const offset = Math.max(0, Math.min(entry.duration, clamped - entry.timelineStart))
    return entry.absoluteStart + offset
  }, [sectionStart, timelineSegments, totalDuration])

  const mapAbsoluteToLocalTime = useCallback((absoluteTime) => {
    if (!timelineSegments.length) return 0
    const abs = Number(absoluteTime) || 0
    let cumulative = 0
    for (const entry of timelineSegments) {
      if (abs < entry.absoluteStart) return cumulative
      if (abs <= entry.absoluteEnd) {
        return cumulative + (abs - entry.absoluteStart)
      }
      cumulative += entry.duration
    }
    return totalDuration
  }, [timelineSegments, totalDuration])

  const getSessionNumForLocalTime = useCallback((localTime) => {
    const absoluteTime = mapLocalTimeToAbsoluteTime(localTime)
    const seg = sectionSegments.find((s) => (
      absoluteTime >= (s.start_time_seconds || 0)
      && absoluteTime <= (s.end_time_seconds || 0)
    ))
    const segSession = Number(seg?.session_num)
    if (Number.isFinite(segSession) && segSession >= 0) return Math.trunc(segSession)
    return raceSessionNum
  }, [mapLocalTimeToAbsoluteTime, raceSessionNum, sectionSegments])

  const {
    replaySpeed: playbackSpeed,
    setReplaySpeed,
    driftSeconds,
    replayState,
    optimisticLocalTime,
    displayLocalTime: playheadTime,
    setOptimisticLocalTime,
    clockRef,
    seekToSessionTime,
    playReplay,
    pauseReplay,
    syncReplaySpeed,
    startClock,
    stopClock,
    pauseClock,
    reanchorClock,
    setClockUserScrubbing,
    isDraggingPlayhead,
    setIsDraggingPlayhead,
  } = useAuthoritativeReplayPlayhead({
    isConnected,
    raceSessionNum,
    getSessionNumForLocalTime,
    localDuration: totalDuration,
    storageKey: 'lrs:overlay:timeline:speed',
    defaultSpeed: 1,
    getSessionTimeForLocalTime: mapLocalTimeToAbsoluteTime,
    getLocalTimeForSessionTime: mapAbsoluteToLocalTime,
    fallbackLocalTime: currentTime,
  })

  const currentSegment = useMemo(() => {
    const absTime = mapLocalTimeToAbsoluteTime(playheadTime)
    return sectionSegments.find(s =>
      absTime >= s.start_time_seconds && absTime <= s.end_time_seconds
    ) || null
  }, [mapLocalTimeToAbsoluteTime, playheadTime, sectionSegments])

  const effectiveSelectedPresetId = useMemo(() => {
    // In studio preview, explicit design selection should win over per-segment overrides
    // so switching designs immediately updates the rendered overlay.
    return selectedPresetId || getSegmentOverlayDesignId(currentSegment, null)
  }, [currentSegment, selectedPresetId])

  const hasSelectedDesign = Boolean(effectiveSelectedPresetId)

  const assignSegmentDesign = useCallback(async (segmentId, designId) => {
    if (!Array.isArray(script) || script.length === 0 || !segmentId || typeof onScriptChange !== 'function') return

    const clearOverride = !designId || designId === '__default__'
    let changed = false

    const nextScript = script.map((seg) => {
      if (seg?.id !== segmentId) return seg
      changed = true
      if (clearOverride) {
        const { overlay_preset_id, overlay_preset, overlayPresetId, ...rest } = seg
        return rest
      }
      return {
        ...seg,
        overlay_preset_id: designId,
      }
    })

    if (!changed) return

    try {
      await onScriptChange(nextScript)
      showSuccess(clearOverride ? 'Segment design reset to default' : 'Segment design updated')
    } catch (err) {
      showError(err?.message || 'Failed to save segment design assignment')
    }
  }, [script, onScriptChange, showSuccess, showError])

  const currentSegIndex = useMemo(() => {
    if (!currentSegment) return -1
    return sectionSegments.findIndex(s => s.id === currentSegment.id)
  }, [sectionSegments, currentSegment])

  const getFocusCarIdx = useCallback((seg, sessionTime = null) => {
    const candidates = getActiveDrivers(seg, sessionTime)
    const hint = seg?.camera_hints?.preferred_car_idx
    if (hint != null && candidates.includes(hint)) return hint
    return candidates[0] ?? null
  }, [])

  const resolveCameraTarget = useCallback((seg, sessionTime) => {
    if (!seg) return null

    const cameras = sessionData?.cameras || []
    const scheduledWindow = Array.isArray(seg.camera_schedule)
      ? seg.camera_schedule.find((window) => sessionTime >= window.start && sessionTime <= window.end)
      : null
    const cameraLabel = scheduledWindow?.camera || getCameraLabel(seg)
    const camera = cameras.find((entry) => entry.group_name === cameraLabel)
    if (!camera) return null

    const focusedCarIdx = scheduledWindow?.driver_idx ?? getFocusCarIdx(seg, sessionTime)

    return {
      key: `${seg.id}:${camera.group_num}:${focusedCarIdx ?? 'leader'}:${cameraLabel}`,
      groupNum: camera.group_num,
      cameraLabel,
      focusedCarIdx,
    }
  }, [getFocusCarIdx, sessionData])

  const applyScriptCameraTarget = useCallback(async (seg, sessionTime) => {
    const target = resolveCameraTarget(seg, sessionTime)
    if (!target) {
      updateDebug({
        cameraStatus: 'no-target',
        cameraError: 'No camera target resolved for current segment/time',
      })
      return false
    }
    if (lastAppliedCameraTargetRef.current === target.key) return true

    try {
      await apiPost('/iracing/replay/camera', {
        group_num: target.groupNum,
        ...(target.focusedCarIdx != null ? { car_idx: target.focusedCarIdx } : { position: 1 }),
      })
      lastAppliedCameraTargetRef.current = target.key
      updateDebug({
        cameraStatus: 'applied',
        cameraError: null,
        cameraTargetKey: target.key,
      })
      if (debugEnabled) {
        console.debug('[OverlayPreview][camera] applied', {
          section: activeSection,
          sessionTime,
          target,
        })
      }
      return true
    } catch (err) {
      const msg = err?.message || 'Camera command failed'
      updateDebug({
        cameraStatus: 'error',
        cameraError: msg,
        cameraTargetKey: target.key,
      })
      if (debugEnabled) {
        console.error('[OverlayPreview][camera] failed', {
          section: activeSection,
          sessionTime,
          target,
          error: msg,
        })
      }
      return false
    }
  }, [activeSection, debugEnabled, resolveCameraTarget, updateDebug])

  const sectionCounts = useMemo(() => {
    const counts = {}
    SECTIONS.forEach(s => {
      counts[s.id] = segments.filter(seg => {
        const sec = seg.section || 'race'
        if (s.id === 'qualifying_results') return sec === 'qualifying' || sec === 'qualifying_results'
        if (s.id === 'race_results') return sec === 'results' || sec === 'race_results'
        return sec === s.id
      }).length
    })
    return counts
  }, [segments])

  const paginationConfig = useMemo(() => {
    const elements = selectedPreset?.sections?.[activeSection]
    if (!Array.isArray(elements) || elements.length === 0) return null

    const paginationElement = elements.find((elem) => {
      const pag = elem?.pagination
      return Boolean(pag && pag.enabled)
    })
    if (!paginationElement) return null

    const pagination = paginationElement.pagination || {}
    const parsedItemsPerPage = Number.parseInt(pagination.items_per_page, 10)
    const parsedCycleSeconds = Number.parseFloat(pagination.cycle_duration_seconds)

    return {
      itemsPerPage: Number.isFinite(parsedItemsPerPage) && parsedItemsPerPage > 0 ? parsedItemsPerPage : 10,
      cycleDurationSeconds: Number.isFinite(parsedCycleSeconds) && parsedCycleSeconds > 0 ? parsedCycleSeconds : 0,
    }
  }, [activeSection, selectedPreset])

  const paginationTimelineEvents = useMemo(() => {
    if (!paginationConfig || totalDuration <= 0) return []

    const standingsCount = Array.isArray(previewFrame?.standings) && previewFrame.standings.length > 0
      ? previewFrame.standings.length
      : Array.isArray(sessionData?.drivers) && sessionData.drivers.length > 0
        ? sessionData.drivers.length
        : 0

    if (!standingsCount || standingsCount <= paginationConfig.itemsPerPage) return []

    const totalPages = Math.max(1, Math.ceil(standingsCount / paginationConfig.itemsPerPage))
    if (totalPages <= 1) return []

    const intervalSeconds = paginationConfig.cycleDurationSeconds > 0
      ? paginationConfig.cycleDurationSeconds
      : Math.max(0.001, totalDuration / totalPages)

    const events = []
    for (let nextFlip = intervalSeconds; nextFlip < totalDuration; nextFlip += intervalSeconds) {
      const newPageIndex = Math.floor(nextFlip / intervalSeconds) % totalPages
      events.push({
        atSeconds: nextFlip,
        pageIndex: newPageIndex,
        label: `Page ${newPageIndex + 1}`,
      })
    }

    return events
  }, [paginationConfig, previewFrame?.standings, sessionData?.drivers, totalDuration])

  const htmlRenderIntervalSeconds = useMemo(() => {
    if (previewRenderMode !== 'html') return 0

    const standingsCount = Array.isArray(previewFrame?.standings) && previewFrame.standings.length > 0
      ? previewFrame.standings.length
      : Array.isArray(sessionData?.drivers) && sessionData.drivers.length > 0
        ? sessionData.drivers.length
        : 0

    if (paginationConfig && standingsCount > paginationConfig.itemsPerPage) {
      const totalPages = Math.max(1, Math.ceil(standingsCount / paginationConfig.itemsPerPage))
      if (totalPages > 1) {
        if (paginationConfig.cycleDurationSeconds > 0) return paginationConfig.cycleDurationSeconds
        if (totalDuration > 0) return Math.max(0.001, totalDuration / totalPages)
      }
    }

    // Non-paginated HTML mode: refresh once per second while playing.
    return 1
  }, [paginationConfig, previewFrame?.standings, previewRenderMode, sessionData?.drivers, totalDuration])

  const renderPlayheadTime = useMemo(() => {
    if (previewRenderMode !== 'html') return playheadTime
    if (!playing) return playheadTime

    const interval = Math.max(0.001, Number(htmlRenderIntervalSeconds) || 1)
    const bucket = Math.floor(Math.max(0, playheadTime) / interval)
    return bucket * interval
  }, [htmlRenderIntervalSeconds, playheadTime, playing, previewRenderMode])

  const paginationPreviewState = useMemo(() => {
    if (!paginationConfig || totalDuration <= 0) return null

    const standingsCount = Array.isArray(previewFrame?.standings) && previewFrame.standings.length > 0
      ? previewFrame.standings.length
      : Array.isArray(sessionData?.drivers) && sessionData.drivers.length > 0
        ? sessionData.drivers.length
        : 0

    if (!standingsCount || standingsCount <= paginationConfig.itemsPerPage) return null

    const totalPages = Math.max(1, Math.ceil(standingsCount / paginationConfig.itemsPerPage))
    if (totalPages <= 1) return null

    const intervalSeconds = paginationConfig.cycleDurationSeconds > 0
      ? paginationConfig.cycleDurationSeconds
      : Math.max(0.001, totalDuration / totalPages)

    const effectiveTime = Math.max(0, previewRenderMode === 'html' ? renderPlayheadTime : playheadTime)
    const pageIndex = Math.floor(effectiveTime / intervalSeconds) % totalPages
    const nextFlipAt = Math.min(totalDuration, (Math.floor(effectiveTime / intervalSeconds) + 1) * intervalSeconds)

    return {
      totalPages,
      intervalSeconds,
      pageIndex,
      nextFlipAt,
      standingsCount,
    }
  }, [paginationConfig, playheadTime, previewFrame?.standings, previewRenderMode, renderPlayheadTime, sessionData?.drivers, totalDuration])

  const paginationPreviewBadge = useMemo(() => {
    if (!paginationPreviewState) return null
    return `Page ${paginationPreviewState.pageIndex + 1}/${paginationPreviewState.totalPages} · Next ${formatTime(paginationPreviewState.nextFlipAt)}`
  }, [paginationPreviewState])

  // ── Range slider zoom/pan ───────────────────────────────────────────────
  // Dynamic zoom: content width = containerW / rangeWidth so full range = no scroll
  const rangeWidth = rangeEnd - rangeStart
  const baseContentW = containerW > 0 ? containerW : 800
  const zoomedContentW = baseContentW / Math.max(0.02, rangeWidth)

  // Dynamic height: event row expands to fill available space (like editing tab)
  const dynamicEventH = Math.max(
    OVERLAY_TIMELINE_EVENT_H,
    containerH > 0
      ? Math.floor(containerH - OVERLAY_TIMELINE_SECTION_H - OVERLAY_TIMELINE_TEMPLATE_H - OVERLAY_TIMELINE_ACTIONS_H - OVERLAY_TIMELINE_TICK_H)
      : OVERLAY_TIMELINE_EVENT_H
  )
  const totalTrackH = OVERLAY_TIMELINE_SECTION_H + OVERLAY_TIMELINE_TEMPLATE_H + OVERLAY_TIMELINE_ACTIONS_H + dynamicEventH + OVERLAY_TIMELINE_TICK_H
  
  // Map section-time events to range slider structure
  const rangeSliderEvents = useMemo(() => timelineSegments.map(({ seg, timelineStart, timelineEnd }) => ({
    start_time_seconds: timelineStart,
    end_time_seconds: timelineEnd,
    event_type: seg.event_type || seg.type || 'event',
    inclusion: seg.section === 'race' ? 'highlight' : null,
  })), [timelineSegments])

  const previewOverlayScale = useMemo(() => {
    const sourceW = Number(previewRenderSize?.width) || 1920
    const sourceH = Number(previewRenderSize?.height) || 1080
    const boxW = Number(previewBoxSize?.width) || sourceW
    const boxH = Number(previewBoxSize?.height) || sourceH
    return Math.min(1, boxW / sourceW, boxH / sourceH)
  }, [previewBoxSize?.height, previewBoxSize?.width, previewRenderSize?.height, previewRenderSize?.width])

  const displayedPreviewSize = useMemo(() => ({
    width: Math.max(0, Number(previewBoxSize?.width) || 0),
    height: Math.max(0, Number(previewBoxSize?.height) || 0),
  }), [previewBoxSize?.height, previewBoxSize?.width])

  const debugSummary = useMemo(() => {
    if (!previewFrame) return null
    return {
      driver_name: previewFrame.driver_name ?? null,
      position: previewFrame.position ?? null,
      current_lap: previewFrame.current_lap ?? null,
      flag: previewFrame.flag ?? null,
      standings_count: Array.isArray(previewFrame.standings) ? previewFrame.standings.length : 0,
      session_time: previewFrame.session_time ?? null,
    }
  }, [previewFrame])

  const handleCopyDebugPanel = useCallback(async () => {
    const payload = {
      panel: 'overlay-debug',
      run: debugInfo.renderSeq,
      frameSource: debugInfo.frameSource,
      telemetry: {
        status: debugInfo.telemetryStatus,
        error: debugInfo.telemetryError,
      },
      render: {
        status: debugInfo.renderStatus,
        ms: debugInfo.renderMs,
        error: debugInfo.renderError,
      },
      requested: {
        presetId: debugInfo.requestedPresetId,
        preferHtml: debugInfo.requestedPreferHtml,
      },
      backend: {
        renderSource: debugInfo.renderSource,
        renderHtmlLength: debugInfo.renderHtmlLength,
        hasHtmlContent: debugInfo.backendHasHtmlContent,
        sectionElementCount: debugInfo.backendSectionElementCount,
        preferHtmlContent: debugInfo.backendPreferHtmlContent,
        usedElementFilter: debugInfo.backendUsedElementFilter,
      },
      animation: {
        mode: debugInfo.animationMode,
        summary: debugInfo.animationSummary,
      },
      camera: {
        status: debugInfo.cameraStatus,
        targetKey: debugInfo.cameraTargetKey,
        error: debugInfo.cameraError,
      },
      sessionTime: debugInfo.sessionTime,
      focusedCarIdx: debugInfo.focusedCarIdx,
      standingsUsed: {
        source: debugInfo.standingsSource,
        count: debugInfo.standingsCount,
        preview: debugInfo.standingsPreview,
      },
      pagination: {
        section: debugInfo.previewSection,
        pageIndex: debugInfo.pageIndex,
        pageStart: debugInfo.pageStart,
        pageEnd: debugInfo.pageEnd,
        totalPages: debugInfo.totalPages,
      },
      frameSummary: debugSummary,
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      showSuccess('Overlay debug copied')
    } catch {
      showError('Failed to copy overlay debug')
    }
  }, [debugInfo, debugSummary, showError, showSuccess])

  // Overlay content rendered inside SharedPreviewHost (fixed z-30) so it sits above the stream
  const streamOverlayContent = useMemo(() => {
    const overlayLayer = (() => {
      if (!overlayVisible || !hasSelectedDesign) return null
      if (previewRenderMode === 'png' && visualPreviewImage) {
        return (
          <div className="absolute inset-0 pointer-events-none">
            <img
              src={visualPreviewImage}
              alt="Visual preset preview"
              className="absolute inset-0 w-full h-full object-contain"
              style={{ zoom: previewZoom }}
            />
          </div>
        )
      }
      if (previewRenderMode === 'html' && visualPreviewHtml && !previewFullscreen) {
        return (
          <div className="pointer-events-none overflow-hidden absolute inset-0">
            <div className="w-full h-full flex items-center justify-center" style={{ background: 'transparent' }}>
              <IsolatedHtmlPreview
                html={visualPreviewHtml}
                underlaySrc={null}
                className="absolute left-1/2 top-1/2 border-0 bg-transparent pointer-events-none"
                style={{
                  width: `${previewRenderSize.width}px`,
                  height: `${previewRenderSize.height}px`,
                  marginLeft: `-${previewRenderSize.width / 2}px`,
                  marginTop: `-${previewRenderSize.height / 2}px`,
                  transformOrigin: 'center center',
                  transform: `scale(${previewOverlayScale})`,
                  background: 'transparent',
                }}
                zoom={previewZoom}
              />
            </div>
          </div>
        )
      }
      return null
    })()

    return (
      <>
        {overlayLayer}
        {overlayVisible && hasSelectedDesign && previewLoading && (
          <div className="absolute left-1/2 bottom-4 -translate-x-1/2 z-20 pointer-events-none">
            <div className="px-4 py-2 rounded-md bg-black/75 border border-white/20 text-white/90 text-xs flex items-center gap-2 shadow-lg">
              <Loader2 className="w-4 h-4 animate-spin" />
              Rendering overlay...
            </div>
          </div>
        )}
        {overlayVisible && hasSelectedDesign && visualPreviewError && !previewLoading && (
          <div className="absolute left-3 right-3 bottom-3 pointer-events-none">
            <div className="px-2 py-1 rounded bg-red-900/70 border border-red-700/40 text-red-200 text-xxs">
              {visualPreviewError}
            </div>
          </div>
        )}
        {overlayVisible && !hasSelectedDesign && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className="px-2 py-1 rounded bg-black/60 text-white/80 text-xxs">
              Select a design to render overlay preview
            </div>
          </div>
        )}
        {debugEnabled && (
          <div className="absolute left-3 bottom-3 z-20 w-80 max-w-[calc(100%-1.5rem)] rounded-lg border border-amber-500/30 bg-black/75 text-[10px] font-mono text-amber-100 shadow-xl backdrop-blur-sm pointer-events-auto">
            <div className="px-2 py-1 border-b border-amber-500/20 flex items-center justify-between">
              <span className="font-semibold">Overlay Debug</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCopyDebugPanel}
                  className="inline-flex items-center gap-1 rounded border border-amber-500/20 px-1.5 py-0.5 text-[9px] text-amber-200 transition-colors hover:bg-amber-500/10"
                  title="Copy formatted debug details"
                  aria-label="Copy formatted debug details"
                >
                  <Copy className="w-3 h-3" />
                  Copy
                </button>
                <span className="text-amber-300/80">run #{debugInfo.renderSeq}</span>
              </div>
            </div>
            <div className="px-2 py-1.5 space-y-1.5 leading-4">
              <div className="grid grid-cols-[110px_1fr] gap-1">
                <span className="text-amber-300/80">Frame source</span>
                <span>{debugInfo.frameSource}</span>
                <span className="text-amber-300/80">Telemetry</span>
                <span>{debugInfo.telemetryStatus}{debugInfo.telemetryError ? ` (${debugInfo.telemetryError})` : ''}</span>
                <span className="text-amber-300/80">Render</span>
                <span>{debugInfo.renderStatus}{debugInfo.renderMs != null ? ` (${debugInfo.renderMs}ms)` : ''}{debugInfo.renderError ? ` (${debugInfo.renderError})` : ''}</span>
                <span className="text-amber-300/80">Requested preset</span>
                <span>{debugInfo.requestedPresetId || 'n/a'}</span>
                <span className="text-amber-300/80">Requested prefer html</span>
                <span>{String(debugInfo.requestedPreferHtml)}</span>
                <span className="text-amber-300/80">Render source</span>
                <span>{debugInfo.renderSource || 'n/a'}{debugInfo.renderHtmlLength != null ? ` (len ${debugInfo.renderHtmlLength})` : ''}</span>
                <span className="text-amber-300/80">Backend has html</span>
                <span>{debugInfo.backendHasHtmlContent == null ? 'n/a' : String(debugInfo.backendHasHtmlContent)}</span>
                <span className="text-amber-300/80">Backend section elems</span>
                <span>{debugInfo.backendSectionElementCount == null ? 'n/a' : String(debugInfo.backendSectionElementCount)}</span>
                <span className="text-amber-300/80">Backend prefer html</span>
                <span>{debugInfo.backendPreferHtmlContent == null ? 'n/a' : String(debugInfo.backendPreferHtmlContent)}</span>
                <span className="text-amber-300/80">Backend element filter</span>
                <span>{debugInfo.backendUsedElementFilter == null ? 'n/a' : String(debugInfo.backendUsedElementFilter)}</span>
                <span className="text-amber-300/80">Animation</span>
                <span>
                  {debugInfo.animationMode}
                  {debugInfo.animationSummary?.maxWindowMs ? ` (${Math.round(debugInfo.animationSummary.maxWindowMs)}ms)` : ''}
                  {debugInfo.animationSummary?.animatedCount ? ` [${debugInfo.animationSummary.animatedCount} keyframe]` : ''}
                  {debugInfo.animationSummary?.transitionCount ? ` [${debugInfo.animationSummary.transitionCount} transition]` : ''}
                </span>
                <span className="text-amber-300/80">Camera</span>
                <span>{debugInfo.cameraStatus}{debugInfo.cameraTargetKey ? ` (${debugInfo.cameraTargetKey})` : ''}{debugInfo.cameraError ? ` (${debugInfo.cameraError})` : ''}</span>
                <span className="text-amber-300/80">Session time</span>
                <span>{debugInfo.sessionTime != null ? `${debugInfo.sessionTime.toFixed(2)}s` : 'n/a'}</span>
                <span className="text-amber-300/80">Focused car</span>
                <span>{debugInfo.focusedCarIdx ?? 'leader'}</span>
                <span className="text-amber-300/80">Standings source</span>
                <span>{debugInfo.standingsSource || 'n/a'}</span>
                <span className="text-amber-300/80">Standings used</span>
                <span>{Number(debugInfo.standingsCount || 0)}</span>
              </div>
              {Array.isArray(debugInfo.standingsPreview) && debugInfo.standingsPreview.length > 0 && (
                <div className="pt-1 border-t border-amber-500/20">
                  <div className="text-amber-300/80 mb-0.5">Standings preview</div>
                  <div>{JSON.stringify(debugInfo.standingsPreview)}</div>
                </div>
              )}
              {debugSummary && (
                <div className="pt-1 border-t border-amber-500/20">
                  <div className="text-amber-300/80 mb-0.5">Frame summary</div>
                  <div>{JSON.stringify(debugSummary)}</div>
                </div>
              )}
            </div>
          </div>
        )}
        {showEventOverlay && <IracingCommandLog />}
      </>
    )
  }, [debugEnabled, debugInfo, debugSummary, hasSelectedDesign, handleCopyDebugPanel, overlayVisible, previewFullscreen, previewLoading, previewOverlayScale, previewRenderMode, previewRenderSize, previewZoom, showEventOverlay, visualPreviewError, visualPreviewHtml, visualPreviewImage])

  // Sync: range slider → scroll position
  useEffect(() => {
    const el = scrollRef.current
    if (!el || zoomedContentW <= 0) return
    const target = Math.round(rangeStart * zoomedContentW)
    if (Math.abs(el.scrollLeft - target) < 1) return
    syncingRef.current = true
    el.scrollLeft = target
  }, [rangeStart, zoomedContentW])

  // Sync: scroll → range (fires from user scroll)
  const handleTimelineScroll = useCallback(() => {
    if (syncingRef.current) { syncingRef.current = false; return }
    const el = scrollRef.current
    if (!el || zoomedContentW <= 0) return
    const rw = rangeEnd - rangeStart
    const newStart = Math.max(0, Math.min(1 - rw, el.scrollLeft / zoomedContentW))
    setRangeStart(newStart)
    setRangeEnd(newStart + rw)
  }, [rangeStart, rangeEnd, zoomedContentW])

  // ── Playback ────────────────────────────────────────────────────────────
  const togglePlay = useCallback(async () => {
    if (playing) {
      pauseClock()
      await pauseReplay()
      setPlaying(false)
      return
    }

    startClock({
      startLocalTime: playheadTime,
      speed: playbackSpeed || 1,
      getExpectedSessionTime: ({ localTime }) => mapLocalTimeToAbsoluteTime(localTime),
      getExpectedState: ({ clock }) => ({ speed: clock.speed }),
    })
    if (currentSegment) {
      try {
        await applyScriptCameraTarget(currentSegment, mapLocalTimeToAbsoluteTime(playheadTime))
      } catch {
        // Non-fatal: replay play should still proceed if camera change fails.
      }
    }
    await syncReplaySpeed(playbackSpeed || 1)
    await playReplay()
    setPlaying(true)
  }, [applyScriptCameraTarget, currentSegment, mapLocalTimeToAbsoluteTime, pauseClock, pauseReplay, playReplay, playbackSpeed, playheadTime, playing, startClock, syncReplaySpeed])

  const handlePlaybackSpeedChange = useCallback(async (speed) => {
    setReplaySpeed(speed)
    if (clockRef.current) clockRef.current.speed = speed
    if (!playing) return
    await syncReplaySpeed(speed)
  }, [clockRef, playing, setReplaySpeed, syncReplaySpeed])

  const seekReplayToAbsoluteTime = useCallback((absoluteTime) => {
    return seekToSessionTime(absoluteTime, mapAbsoluteToLocalTime(absoluteTime))
  }, [mapAbsoluteToLocalTime, seekToSessionTime])

  const seekTimelineAndReplay = useCallback((relativeTime) => {
    const clampedTime = Math.max(0, Math.min(totalDuration, relativeTime))
    setCurrentTime(clampedTime)
    setOptimisticLocalTime(clampedTime)
    lastAppliedCameraTargetRef.current = null
    if (clockRef.current) {
      reanchorClock(clampedTime)
      setClockUserScrubbing(false)
    }
    pauseClock()
    setPlaying(false)
    seekReplayToAbsoluteTime(mapLocalTimeToAbsoluteTime(clampedTime))
  }, [clockRef, mapLocalTimeToAbsoluteTime, pauseClock, reanchorClock, seekReplayToAbsoluteTime, setClockUserScrubbing, setOptimisticLocalTime, totalDuration])

  // Fit preview viewport to source aspect ratio when available; fallback to 16:9.
  useEffect(() => {
    const node = previewViewportRef.current
    if (!node) return undefined

    const compute = () => {
      const rect = node.getBoundingClientRect()
      const availW = Math.max(0, rect.width)
      const availH = Math.max(0, rect.height)
      if (availW <= 0 || availH <= 0) return
      const targetAspect = Math.max(0.2, Number(streamAspectRatio) || (16 / 9))

      let width = availW
      let height = width / targetAspect
      if (height > availH) {
        height = availH
        width = height * targetAspect
      }

      setPreviewBoxSize({ width, height })
    }

    const observer = new ResizeObserver(compute)
    observer.observe(node)
    compute()

    return () => observer.disconnect()
  }, [streamAspectRatio])

  const scrubToClientX = useCallback((clientX) => {
    const node = timelineRef.current
    if (!node || totalDuration <= 0) return 0
    const rect = node.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const nextTime = x * totalDuration
    setCurrentTime(nextTime)
    setOptimisticLocalTime(nextTime)
    return nextTime
  }, [setOptimisticLocalTime, totalDuration])

  const handleTimelinePointerDown = useCallback((e) => {
    setClockUserScrubbing(true)
    setIsDraggingPlayhead(true)
    const initialTime = scrubToClientX(e.clientX)
    setPlaying(false)
    lastAppliedCameraTargetRef.current = null
    seekReplayToAbsoluteTime(mapLocalTimeToAbsoluteTime(initialTime))
    let lastSeek = Date.now()
    const onMove = (ev) => {
      const nextTime = scrubToClientX(ev.clientX)
      if (Date.now() - lastSeek < 150) return
      lastSeek = Date.now()
      seekReplayToAbsoluteTime(mapLocalTimeToAbsoluteTime(nextTime))
    }
    const onUp = (ev) => {
      const finalTime = scrubToClientX(ev.clientX)
      if (clockRef.current) reanchorClock(finalTime)
      setClockUserScrubbing(false)
      setIsDraggingPlayhead(false)
      seekReplayToAbsoluteTime(mapLocalTimeToAbsoluteTime(finalTime))
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clockRef, mapLocalTimeToAbsoluteTime, reanchorClock, scrubToClientX, seekReplayToAbsoluteTime, setClockUserScrubbing, setIsDraggingPlayhead])

  useEffect(() => {
    if (optimisticLocalTime === null || !replayState || replayState.session_time === null) return
    const replayLocalTime = mapAbsoluteToLocalTime(replayState.session_time)
    if (!Number.isFinite(replayLocalTime)) return
    if (Math.abs(replayLocalTime - optimisticLocalTime) <= 0.35) {
      setOptimisticLocalTime(null)
    }
  }, [mapAbsoluteToLocalTime, optimisticLocalTime, replayState, setOptimisticLocalTime])

  const seekToSegment = useCallback((idx) => {
    if (idx < 0 || idx >= timelineSegments.length) return
    const timelineSeg = timelineSegments[idx]
    seekTimelineAndReplay(timelineSeg.timelineStart)
  }, [timelineSegments, seekTimelineAndReplay])

  useEffect(() => {
    if (!currentSegment || isDraggingPlayhead) return

    const sessionTime = mapLocalTimeToAbsoluteTime(playheadTime)
    applyScriptCameraTarget(currentSegment, sessionTime).catch(() => {})
  }, [applyScriptCameraTarget, currentSegment, isDraggingPlayhead, mapLocalTimeToAbsoluteTime, playheadTime])

  useEffect(() => {
    if (!sectionSegments.length) {
      didInitSectionSeekRef.current = false
      return
    }
    if (!didInitSectionSeekRef.current) {
      didInitSectionSeekRef.current = true
      lastAppliedCameraTargetRef.current = null
      seekReplayToAbsoluteTime(mapLocalTimeToAbsoluteTime(0))
    }
  }, [activeSection, mapLocalTimeToAbsoluteTime, sectionSegments.length, seekReplayToAbsoluteTime])

  const buildFallbackFrameData = useCallback((absSessionTime) => {
    const segmentStandings = Array.isArray(currentSegment?.standings) ? currentSegment.standings : []
    const fallbackStandings = buildStandingsFromSessionDrivers(
      sessionData?.drivers,
      currentSegment ? getFocusCarIdx(currentSegment, absSessionTime) : null,
    )
    const standings = segmentStandings.length > 1 ? segmentStandings : fallbackStandings

    return {
    section: activeSection,
    series_name: currentSegment?.series_name || 'iRacing Series',
    track_name: currentSegment?.track_name || sessionData?.track_name || 'Track Name',
    current_lap: currentSegment?.current_lap ?? 1,
    total_laps: currentSegment?.total_laps ?? 20,
    session_time: formatTime(absSessionTime),
    driver_name: currentSegment?.driver_name || (currentSegment?.driver_names?.[0] ?? 'Driver Name'),
    position: currentSegment?.position ?? (currentSegment?.involved_positions?.[0] ?? null),
    car_name: currentSegment?.car_name || 'Car',
    irating: currentSegment?.irating ?? 0,
    team_color: currentSegment?.team_color || '#3B82F6',
    standings,
    flag: currentSegment?.flag || 'green',
    event_type: currentSegment?.event_type || currentSegment?.type || 'event',
  }
  }, [activeSection, currentSegment, getFocusCarIdx, sessionData?.drivers, sessionData?.track_name])

  // Render actual visual preset output in preview when a visual preset is active.
  useEffect(() => {
    let cancelled = false
    let timer = null

    if (!hasSelectedDesign || !effectiveSelectedPresetId || !overlayVisible) {
      setVisualPreviewImage(null)
      setVisualPreviewError(null)
      setPreviewLoading(false)
      return undefined
    }

    const absSessionTime = mapLocalTimeToAbsoluteTime(renderPlayheadTime)

    timer = setTimeout(async () => {
      const runSeq = ++renderSeqRef.current
      const startedAt = performance.now()
      let standingsSource = 'segment_fallback'
      setPreviewLoading(true)
      updateDebug({
        renderSeq: runSeq,
        lastRunAt: Date.now(),
        sessionTime: absSessionTime,
        focusedCarIdx: currentSegment ? getFocusCarIdx(currentSegment, absSessionTime) : null,
        frameSource: 'fallback',
        telemetryStatus: projectId != null ? 'pending' : 'skipped',
        telemetryError: null,
        renderStatus: 'pending',
        renderError: null,
        requestedPresetId: effectiveSelectedPresetId,
        requestedPreferHtml: true,
        standingsSource: null,
        standingsCount: 0,
        standingsPreview: null,
        previewSection: activeSection,
        pageIndex: null,
        pageStart: null,
        pageEnd: null,
        totalPages: null,
      })
      try {
        let frameData = buildFallbackFrameData(absSessionTime)
        if (debugEnabled) {
          console.debug('[OverlayPreview][render] start', {
            runSeq,
            section: activeSection,
            projectId,
            absSessionTime,
            hasSelectedDesign,
            selectedPresetId: effectiveSelectedPresetId,
            fallbackSummary: {
              driver_name: frameData.driver_name,
              current_lap: frameData.current_lap,
              flag: frameData.flag,
              standings_count: Array.isArray(frameData.standings) ? frameData.standings.length : 0,
            },
          })
        }

        if (projectId != null) {
          try {
            const focusedCarIdx = currentSegment
              ? getFocusCarIdx(currentSegment, absSessionTime)
              : null

            const telemetryResponse = await apiPost(`/overlay/frame-data/${projectId}`, {
              session_time: absSessionTime,
              section: activeSection,
              focused_car_idx: focusedCarIdx,
              series_name: currentSegment?.series_name || '',
              track_name: currentSegment?.track_name || sessionData?.track_name || '',
            })

            if (telemetryResponse?.frame_data) {
              frameData = {
                ...frameData,
                ...telemetryResponse.frame_data,
                // Keep script context fields available for template logic.
                event_type: currentSegment?.event_type || currentSegment?.type || telemetryResponse.frame_data.event_type || 'event',
              }
              standingsSource = 'telemetry_frame_data'
              updateDebug({
                frameSource: 'telemetry',
                telemetryStatus: 'ok',
                telemetryError: null,
              })
              if (debugEnabled) {
                console.debug('[OverlayPreview][telemetry] frame-data loaded', {
                  runSeq,
                  focusedCarIdx,
                  summary: {
                    driver_name: frameData.driver_name,
                    position: frameData.position,
                    current_lap: frameData.current_lap,
                    flag: frameData.flag,
                    standings_count: Array.isArray(frameData.standings) ? frameData.standings.length : 0,
                    session_time: frameData.session_time,
                  },
                })
              }
            }
          } catch (telemetryErr) {
            const msg = telemetryErr?.message || 'Telemetry frame-data lookup failed'
            updateDebug({
              frameSource: 'fallback',
              telemetryStatus: 'error',
              telemetryError: msg,
            })
            if (debugEnabled) {
              console.error('[OverlayPreview][telemetry] frame-data failed', {
                runSeq,
                projectId,
                absSessionTime,
                error: msg,
              })
            }
            // Fall back to segment-derived data when telemetry frame lookup is unavailable.
          }
        }

        frameData = {
          ...frameData,
          overlay_section_elapsed_seconds: Math.max(0, renderPlayheadTime),
          overlay_section_duration_seconds: Math.max(0, totalDuration || 0),
        }

        if ((!Array.isArray(frameData.standings) || frameData.standings.length <= 1) && Array.isArray(sessionData?.drivers) && sessionData.drivers.length > 1) {
          frameData = {
            ...frameData,
            standings: buildStandingsFromSessionDrivers(
              sessionData.drivers,
              currentSegment ? getFocusCarIdx(currentSegment, absSessionTime) : null,
            ),
          }
          standingsSource = 'session_drivers_fallback'
        }

        const standingsUsed = Array.isArray(frameData.standings) ? frameData.standings : []
        if (standingsSource === 'segment_fallback' && standingsUsed.length > 1) {
          standingsSource = 'segment_standings'
        }
        updateDebug({
          standingsSource,
          standingsCount: standingsUsed.length,
          standingsPreview: standingsUsed.slice(0, 5).map((entry) => ({
            position: entry?.position ?? null,
            driver_name: entry?.driver_name ?? null,
            car_number: entry?.car_number ?? null,
            gap: entry?.gap ?? null,
            is_player: Boolean(entry?.is_player),
          })),
          previewSection: activeSection,
          pageIndex: Number.isFinite(frameData?.overlay_page_index) ? Number(frameData.overlay_page_index) : null,
          pageStart: Number.isFinite(frameData?.page_start) ? Number(frameData.page_start) : null,
          pageEnd: Number.isFinite(frameData?.page_end) ? Number(frameData.page_end) : null,
          totalPages: Number.isFinite(frameData?.total_pages) ? Number(frameData.total_pages) : null,
        })

        if (paginationConfig && totalDuration > 0) {
          const standingsCount = Array.isArray(frameData?.standings) ? frameData.standings.length : 0
          if (standingsCount > paginationConfig.itemsPerPage) {
            const totalPages = Math.max(1, Math.ceil(standingsCount / paginationConfig.itemsPerPage))
            if (totalPages > 1) {
              const intervalSeconds = paginationConfig.cycleDurationSeconds > 0
                ? paginationConfig.cycleDurationSeconds
                : Math.max(0.001, totalDuration / totalPages)
              const effectiveTime = Math.max(0, previewRenderMode === 'html' ? renderPlayheadTime : playheadTime)
              frameData.overlay_page_index = Math.floor(effectiveTime / intervalSeconds) % totalPages
            }
          }
        }

        setPreviewFrame(frameData)

        const useHtmlMode = previewRenderMode === 'html'
        const result = await renderPreview(effectiveSelectedPresetId, activeSection, {
          projectId,
          frameData,
          includeRenderedHtml: true,
          renderScreenshot: !useHtmlMode,
          includeDebug: debugEnabled,
          preferHtmlContent: true,
        })
        if (cancelled) return

        const animationProfile = result?.animation_profile || null
        const renderDebug = result?.debug_render || null
        const renderWidth = Number(result?.width) || 1920
        const renderHeight = Number(result?.height) || 1080
        setPreviewRenderSize({ width: renderWidth, height: renderHeight })
        const animationSummary = animationProfile
          ? {
              hasAnimations: Boolean(animationProfile.has_animations),
              hasKeyframes: Boolean(animationProfile.has_keyframes),
              supportsSeek: Boolean(animationProfile.supports_timeline_seek),
              maxWindowMs: Number(animationProfile.max_window_ms || 0),
              animatedCount: Array.isArray(animationProfile.animated_elements) ? animationProfile.animated_elements.length : 0,
              transitionCount: Array.isArray(animationProfile.transition_elements) ? animationProfile.transition_elements.length : 0,
            }
          : null
        setPreviewDiagnostics(animationProfile)

        if (useHtmlMode && result?.rendered_html) {
          const safeHtml = sanitizePreviewHtmlForInlineRender(result.rendered_html, renderWidth, renderHeight)
          if (safeHtml) {
            setVisualPreviewHtml(safeHtml)
            setVisualPreviewImage(null)
            setVisualPreviewError(null)
            updateDebug({
              renderStatus: 'ok',
              renderError: null,
              renderMs: Math.round(performance.now() - startedAt),
              requestedPresetId: effectiveSelectedPresetId,
              requestedPreferHtml: true,
              renderSource: renderDebug?.render_source || null,
              renderHtmlLength: renderDebug?.html_length ?? null,
              backendHasHtmlContent: renderDebug?.has_html_content ?? null,
              backendSectionElementCount: renderDebug?.section_element_count ?? null,
              backendUsedElementFilter: renderDebug?.used_element_filter ?? null,
              backendPreferHtmlContent: renderDebug?.prefer_html_content ?? null,
              animationMode: animationSummary?.hasKeyframes && animationSummary?.supportsSeek ? 'timeline-capable' : animationSummary?.hasAnimations ? 'static-only' : 'none',
              animationSummary,
            })
          } else {
            setVisualPreviewImage(null)
            setVisualPreviewHtml(null)
            const htmlLen = result.rendered_html?.length || 0
            setVisualPreviewError(`HTML blocked by sanitization (${htmlLen} bytes returned)`)
            updateDebug({
              renderStatus: 'error',
              renderError: 'HTML preview sanitized to empty content',
              renderMs: Math.round(performance.now() - startedAt),
              requestedPresetId: effectiveSelectedPresetId,
              requestedPreferHtml: true,
              renderSource: renderDebug?.render_source || null,
              renderHtmlLength: renderDebug?.html_length ?? null,
              backendHasHtmlContent: renderDebug?.has_html_content ?? null,
              backendSectionElementCount: renderDebug?.section_element_count ?? null,
              backendUsedElementFilter: renderDebug?.used_element_filter ?? null,
              backendPreferHtmlContent: renderDebug?.prefer_html_content ?? null,
              animationMode: animationSummary?.hasKeyframes && animationSummary?.supportsSeek ? 'timeline-capable' : animationSummary?.hasAnimations ? 'static-only' : 'none',
              animationSummary,
            })
          }
        } else if (!useHtmlMode && result?.png_base64) {
          setVisualPreviewImage(`data:image/png;base64,${result.png_base64}`)
          setVisualPreviewHtml(null)
          setVisualPreviewError(null)
          updateDebug({
            renderStatus: 'ok',
            renderError: null,
            renderMs: Math.round(performance.now() - startedAt),
            requestedPresetId: effectiveSelectedPresetId,
            requestedPreferHtml: true,
            renderSource: renderDebug?.render_source || null,
            renderHtmlLength: renderDebug?.html_length ?? null,
            backendHasHtmlContent: renderDebug?.has_html_content ?? null,
            backendSectionElementCount: renderDebug?.section_element_count ?? null,
            backendUsedElementFilter: renderDebug?.used_element_filter ?? null,
            backendPreferHtmlContent: renderDebug?.prefer_html_content ?? null,
            animationMode: animationSummary?.hasKeyframes && animationSummary?.supportsSeek ? 'timeline-capable' : animationSummary?.hasAnimations ? 'static-only' : 'none',
            animationSummary,
          })
          if (debugEnabled) {
            console.debug('[OverlayPreview][render] success', {
              runSeq,
              renderMs: Math.round(performance.now() - startedAt),
              renderDebug,
            })
          }
        } else {
          setVisualPreviewImage(null)
          setVisualPreviewHtml(null)
          setVisualPreviewError(result?.error || 'Failed to render visual preset preview')
          updateDebug({
            renderStatus: 'error',
            renderError: result?.error || 'Render returned no preview payload',
            renderMs: Math.round(performance.now() - startedAt),
            requestedPresetId: effectiveSelectedPresetId,
            requestedPreferHtml: true,
            renderSource: renderDebug?.render_source || null,
            renderHtmlLength: renderDebug?.html_length ?? null,
            backendHasHtmlContent: renderDebug?.has_html_content ?? null,
            backendSectionElementCount: renderDebug?.section_element_count ?? null,
            backendUsedElementFilter: renderDebug?.used_element_filter ?? null,
            backendPreferHtmlContent: renderDebug?.prefer_html_content ?? null,
            animationMode: animationSummary?.hasKeyframes && animationSummary?.supportsSeek ? 'timeline-capable' : animationSummary?.hasAnimations ? 'static-only' : 'none',
            animationSummary,
          })
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err?.message || 'Failed to render visual preset preview'
          setVisualPreviewImage(null)
          setVisualPreviewHtml(null)
          setVisualPreviewError(msg)
          updateDebug({
            renderStatus: 'error',
            renderError: msg,
            renderMs: Math.round(performance.now() - startedAt),
            animationMode: 'error',
          })
          if (debugEnabled) {
            console.error('[OverlayPreview][render] failed', {
              runSeq,
              error: msg,
            })
          }
        }
      } finally {
        if (!cancelled) {
          setPreviewLoading(false)
        }
      }
    }, 120)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [
    hasSelectedDesign,
    effectiveSelectedPresetId,
    activeSection,
    overlayVisible,
    currentSegment,
    renderPlayheadTime,
    playheadTime,
    mapLocalTimeToAbsoluteTime,
    totalDuration,
    debugEnabled,
    buildFallbackFrameData,
    getFocusCarIdx,
    projectId,
    renderPreview,
    previewRenderMode,
    paginationConfig,
    sessionData?.drivers,
    sessionData?.track_name,
    updateDebug,
  ])

  const persistedTimeLabel = useMemo(() => {
    if (!scriptGeneratedAt) return null
    const dt = new Date(scriptGeneratedAt)
    if (Number.isNaN(dt.getTime())) return null
    return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }, [scriptGeneratedAt])

  const previewAnimationBadge = useMemo(() => {
    if (!previewDiagnostics) return null
    if (previewDiagnostics.has_keyframes && previewDiagnostics.supports_timeline_seek) {
      return {
        label: `Animations ${previewDiagnostics.max_window_ms ? `(${Math.round(previewDiagnostics.max_window_ms)}ms)` : ''}`,
        className: 'border-emerald-500/40 text-emerald-200 bg-emerald-900/20',
      }
    }
    if (previewDiagnostics.has_animations) {
      return {
        label: 'Animations detected (static only)',
        className: 'border-amber-500/40 text-amber-200 bg-amber-900/20',
      }
    }
    return {
      label: 'No animations detected',
      className: 'border-border text-text-tertiary bg-bg-primary/50',
    }
  }, [previewDiagnostics])

  const sectionTabs = useMemo(() => SECTIONS.map((sec) => ({
    id: sec.id,
    label: sec.label,
    icon: sec.icon,
    activeIconClass: sec.color,
    count: sectionCounts[sec.id] || 0,
  })), [sectionCounts])

  const topbarContextControls = (
    <>
      {previewLoading && (
        <span className="rounded-full border border-amber-500/40 bg-amber-900/25 px-2 py-1 text-xxs font-medium text-amber-200 inline-flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" />
          Recalculating preview
        </span>
      )}
      {persistedTimeLabel && (
        <span className="rounded-full border border-success/30 bg-success/10 px-2 py-1 text-xxs font-medium text-success">
          Persisted {persistedTimeLabel}
        </span>
      )}
      {previewAnimationBadge && (
        <span className={`rounded-full border px-2 py-1 text-xxs font-medium ${previewAnimationBadge.className}`}>
          {previewAnimationBadge.label}
        </span>
      )}
      {paginationPreviewBadge && (
        <span
          className="rounded-full border border-cyan-500/40 bg-cyan-900/20 px-2 py-1 text-xxs font-medium text-cyan-200"
          title="Auto-pagination preview status"
        >
          {paginationPreviewBadge}
        </span>
      )}
      <span
        className="rounded-full border border-border bg-bg-primary/50 px-2 py-1 text-xxs font-mono text-text-tertiary"
        title="Live iRacing command events received in this preview"
      >
        {commandFeedCount} cmds{lastCommandLabel ? ` (${lastCommandLabel})` : ''}
      </span>
    </>
  )

  const topbarCommonControls = (
    <>
      <div className="flex items-center gap-1 rounded-md border border-border bg-bg-primary/50 px-1 py-0.5">
        <button
          onClick={() => setPreviewRenderMode('png')}
          className={`px-2 py-0.5 rounded text-xxs font-medium transition-colors ${
            previewRenderMode === 'png'
              ? 'bg-accent/20 text-accent border border-accent/40'
              : 'text-text-tertiary hover:text-text-primary'
          }`}
          title="Render as PNG snapshot"
        >
          PNG
        </button>
        <button
          onClick={() => setPreviewRenderMode('html')}
          className={`px-2 py-0.5 rounded text-xxs font-medium transition-colors ${
            previewRenderMode === 'html'
              ? 'bg-accent/20 text-accent border border-accent/40'
              : 'text-text-tertiary hover:text-text-primary'
          }`}
          title="Render native HTML/CSS overlay"
        >
          HTML
        </button>
      </div>

      <div className="flex items-center gap-1 rounded-md border border-border bg-bg-primary/50 px-2 py-1">
        <button onClick={() => setPreviewZoom(z => Math.max(z - 0.1, 0.25))} className="p-0.5 rounded hover:bg-bg-secondary" title="Zoom out">
          <ZoomOut className="w-3 h-3 text-text-tertiary" />
        </button>
        <span className="w-8 text-center text-[10px] tabular-nums text-text-tertiary">
          {Math.round(previewZoom * 100)}%
        </span>
        <button onClick={() => setPreviewZoom(z => Math.min(z + 0.1, 3))} className="p-0.5 rounded hover:bg-bg-secondary" title="Zoom in">
          <ZoomIn className="w-3 h-3 text-text-tertiary" />
        </button>
        <button onClick={() => setPreviewFullscreen(v => !v)} className="ml-1 p-0.5 rounded hover:bg-bg-secondary" title={previewFullscreen ? 'Exit fullscreen' : 'Fullscreen preview'}>
          <Maximize2 className="w-3 h-3 text-text-tertiary" />
        </button>
      </div>

      <div className="flex items-center gap-0.5 rounded-md border border-border bg-bg-primary/50 px-1 py-0.5">
        <button
          onClick={() => setOverlayVisible(v => !v)}
          className={`rounded p-1 transition-colors ${
            overlayVisible
              ? 'bg-accent/15 text-accent hover:bg-accent/20'
              : 'text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
          }`}
          title={overlayVisible ? 'Hide overlay' : 'Show overlay'}
          aria-label={overlayVisible ? 'Hide overlay' : 'Show overlay'}
        >
          {overlayVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
        </button>

        <button
          onClick={() => setShowLiveStreamUnderlay(v => !v)}
          className={`rounded p-1 transition-colors ${
            showLiveStreamUnderlay
              ? 'bg-accent/15 text-accent hover:bg-accent/20'
              : 'text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
          }`}
          title={showLiveStreamUnderlay ? 'Hide live stream underlay' : 'Show live stream underlay'}
          aria-label={showLiveStreamUnderlay ? 'Hide live stream underlay' : 'Show live stream underlay'}
        >
          <Monitor className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => setShowEventOverlay(v => !v)}
          className={`rounded p-1 transition-colors ${
            showEventOverlay
              ? 'bg-accent/15 text-accent hover:bg-accent/20'
              : 'text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
          }`}
          title={showEventOverlay ? 'Hide iRacing command events' : 'Show iRacing command events'}
          aria-label={showEventOverlay ? 'Hide iRacing command events' : 'Show iRacing command events'}
        >
          <Terminal className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => setDebugEnabled(v => !v)}
          className={`rounded p-1 transition-colors ${
            debugEnabled
              ? 'bg-accent/15 text-accent hover:bg-accent/20'
              : 'text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
          }`}
          title="Toggle overlay preview debugging"
          aria-label={debugEnabled ? 'Disable overlay preview debugging' : 'Enable overlay preview debugging'}
        >
          <Bug className="w-3.5 h-3.5" />
        </button>
      </div>
    </>
  )

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg-primary">
      <OverlayWorkspaceTopbar
        tabs={sectionTabs}
        activeTab={activeSection}
        onTabChange={(sectionId) => {
          didInitSectionSeekRef.current = false
          setActiveSection(sectionId)
          setCurrentTime(0)
          setOptimisticLocalTime(null)
          stopClock()
          setPlaying(false)
        }}
        contextControls={topbarContextControls}
        commonControls={topbarCommonControls}
      />

      {/* Content area */}
      {sectionSegments.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-tertiary">
          <Film className="w-8 h-8 opacity-40" />
          <p className="text-sm font-medium">No segments in this section</p>
          <p className="text-xs text-text-disabled">
            Switch to a section with script segments to preview overlays.
          </p>
        </div>
      ) : (
        <ResizableRowPane
          storageKey="lrs:overlay:timelineHeight"
          defaultBottomHeight={220}
          minBottom={80}
          maxBottom={500}
          collapsed={timelineCollapsed}
          collapsedBottomHeight={68}
          containerClassName="flex flex-col flex-1 h-full min-h-0 overflow-hidden"
          bottomClassName="flex flex-col overflow-hidden"
          top={
            /* Preview viewport */
            <div ref={previewViewportRef} className="h-full w-full relative bg-black/50 flex items-center justify-center overflow-hidden">
              {activeProject && !activeProject.subsession_id && (
                <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-900/70 border border-amber-600/40 text-amber-300 text-[10px] pointer-events-none">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  No iRacing session linked — showing sample data
                </div>
              )}
              <div className="relative w-full bg-bg-primary/20 rounded-lg overflow-hidden
                border border-border/30"
                style={{
                  width: displayedPreviewSize.width > 0 ? `${displayedPreviewSize.width}px` : undefined,
                  height: displayedPreviewSize.height > 0 ? `${displayedPreviewSize.height}px` : undefined,
                }}>
                <div className="absolute inset-0 bg-black">
                  {showLiveStreamUnderlay ? (
                    <PreviewPlayer
                      isAnalyzing={false}
                      isPlaying={playing}
                      onPlayPause={togglePlay}
                      isPortrait={false}
                      aspectRatio={streamAspectRatio}
                      overlayContent={streamOverlayContent}
                    />
                  ) : (
                    <div className="absolute inset-0 bg-black/90" />
                  )}
                </div>

                {!isConnected && (
                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center bg-black/30">
                    <div className="px-3 py-2 rounded bg-black/70 text-white/80 text-xxs text-center">
                      Start iRacing and load the replay to see the synced stream here.
                    </div>
                  </div>
                )}

                {/* Overlay layer — non-stream mode (no PreviewPlayer portal) */}
                {!showLiveStreamUnderlay && overlayVisible && hasSelectedDesign && previewRenderMode === 'png' && visualPreviewImage && (
                  <div className="absolute inset-0 pointer-events-none">
                    <img
                      src={visualPreviewImage}
                      alt="Visual preset preview"
                      className="absolute inset-0 w-full h-full object-contain"
                      style={{ zoom: previewZoom }}
                    />
                  </div>
                )}
                {overlayVisible && hasSelectedDesign && previewRenderMode === 'html' && visualPreviewHtml && (
                  <div
                    className={`pointer-events-none overflow-hidden ${
                      previewFullscreen
                        ? 'fixed inset-0 z-50 bg-black'
                        : showLiveStreamUnderlay ? 'hidden' : 'absolute inset-0'
                    }`}
                  >
                    <div
                      className="w-full h-full flex items-center justify-center"
                      style={{
                        background: previewFullscreen ? '#000' : 'transparent',
                      }}
                    >
                      {previewFullscreen && (
                        <button
                          onClick={() => setPreviewFullscreen(false)}
                          className="absolute top-4 right-4 z-50 p-2 rounded bg-bg-primary/80 hover:bg-bg-secondary text-text-primary pointer-events-auto"
                          title="Exit fullscreen (Esc)"
                        >
                          ✕
                        </button>
                      )}
                      <IsolatedHtmlPreview
                        html={visualPreviewHtml}
                        underlaySrc={null}
                        className={previewFullscreen ? 'w-full h-full border-0 bg-transparent' : 'absolute left-1/2 top-1/2 border-0 bg-transparent pointer-events-none'}
                        style={previewFullscreen ? {
                          background: 'transparent',
                        } : {
                          width: `${previewRenderSize.width}px`,
                          height: `${previewRenderSize.height}px`,
                          marginLeft: `-${previewRenderSize.width / 2}px`,
                          marginTop: `-${previewRenderSize.height / 2}px`,
                          transformOrigin: 'center center',
                          transform: `scale(${previewOverlayScale})`,
                          background: 'transparent',
                        }}
                        zoom={previewZoom}
                      />
                    </div>
                  </div>
                )}
                {/* Status / debug / events — only when stream underlay is off (otherwise they're in streamOverlayContent) */}
                {!showLiveStreamUnderlay && (
                  <>
                    {overlayVisible && hasSelectedDesign && previewLoading && (
                      <div className="absolute left-1/2 bottom-4 -translate-x-1/2 z-20 pointer-events-none">
                        <div className="px-4 py-2 rounded-md bg-black/75 border border-white/20 text-white/90 text-xs flex items-center gap-2 shadow-lg">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Rendering overlay...
                        </div>
                      </div>
                    )}
                    {overlayVisible && hasSelectedDesign && visualPreviewError && !previewLoading && (
                      <div className="absolute left-3 right-3 bottom-3 pointer-events-none">
                        <div className="px-2 py-1 rounded bg-red-900/70 border border-red-700/40 text-red-200 text-xxs">
                          {visualPreviewError}
                        </div>
                      </div>
                    )}
                    {overlayVisible && !hasSelectedDesign && (
                      <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                        <div className="px-2 py-1 rounded bg-black/60 text-white/80 text-xxs">
                          Select a design to render overlay preview
                        </div>
                      </div>
                    )}
                    {debugEnabled && (
                      <div className="absolute left-3 bottom-3 z-20 w-80 max-w-[calc(100%-1.5rem)] rounded-lg border border-amber-500/30 bg-black/75 text-[10px] font-mono text-amber-100 shadow-xl backdrop-blur-sm">
                        <div className="px-2 py-1 border-b border-amber-500/20 flex items-center justify-between">
                          <span className="font-semibold">Overlay Debug</span>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={handleCopyDebugPanel}
                              className="inline-flex items-center gap-1 rounded border border-amber-500/20 px-1.5 py-0.5 text-[9px] text-amber-200 transition-colors hover:bg-amber-500/10"
                              title="Copy formatted debug details"
                              aria-label="Copy formatted debug details"
                            >
                              <Copy className="w-3 h-3" />
                              Copy
                            </button>
                            <span className="text-amber-300/80">run #{debugInfo.renderSeq}</span>
                          </div>
                        </div>
                        <div className="px-2 py-1.5 space-y-1.5 leading-4">
                          <div className="grid grid-cols-[110px_1fr] gap-1">
                            <span className="text-amber-300/80">Frame source</span>
                            <span>{debugInfo.frameSource}</span>
                            <span className="text-amber-300/80">Telemetry</span>
                            <span>{debugInfo.telemetryStatus}{debugInfo.telemetryError ? ` (${debugInfo.telemetryError})` : ''}</span>
                            <span className="text-amber-300/80">Render</span>
                            <span>{debugInfo.renderStatus}{debugInfo.renderMs != null ? ` (${debugInfo.renderMs}ms)` : ''}{debugInfo.renderError ? ` (${debugInfo.renderError})` : ''}</span>
                            <span className="text-amber-300/80">Requested preset</span>
                            <span>{debugInfo.requestedPresetId || 'n/a'}</span>
                            <span className="text-amber-300/80">Requested prefer html</span>
                            <span>{String(debugInfo.requestedPreferHtml)}</span>
                            <span className="text-amber-300/80">Render source</span>
                            <span>{debugInfo.renderSource || 'n/a'}{debugInfo.renderHtmlLength != null ? ` (len ${debugInfo.renderHtmlLength})` : ''}</span>
                            <span className="text-amber-300/80">Backend has html</span>
                            <span>{debugInfo.backendHasHtmlContent == null ? 'n/a' : String(debugInfo.backendHasHtmlContent)}</span>
                            <span className="text-amber-300/80">Backend section elems</span>
                            <span>{debugInfo.backendSectionElementCount == null ? 'n/a' : String(debugInfo.backendSectionElementCount)}</span>
                            <span className="text-amber-300/80">Backend prefer html</span>
                            <span>{debugInfo.backendPreferHtmlContent == null ? 'n/a' : String(debugInfo.backendPreferHtmlContent)}</span>
                            <span className="text-amber-300/80">Backend element filter</span>
                            <span>{debugInfo.backendUsedElementFilter == null ? 'n/a' : String(debugInfo.backendUsedElementFilter)}</span>
                            <span className="text-amber-300/80">Animation</span>
                            <span>
                              {debugInfo.animationMode}
                              {debugInfo.animationSummary?.maxWindowMs ? ` (${Math.round(debugInfo.animationSummary.maxWindowMs)}ms)` : ''}
                              {debugInfo.animationSummary?.animatedCount ? ` [${debugInfo.animationSummary.animatedCount} keyframe]` : ''}
                              {debugInfo.animationSummary?.transitionCount ? ` [${debugInfo.animationSummary.transitionCount} transition]` : ''}
                            </span>
                            <span className="text-amber-300/80">Camera</span>
                            <span>{debugInfo.cameraStatus}{debugInfo.cameraTargetKey ? ` (${debugInfo.cameraTargetKey})` : ''}{debugInfo.cameraError ? ` (${debugInfo.cameraError})` : ''}</span>
                            <span className="text-amber-300/80">Session time</span>
                            <span>{debugInfo.sessionTime != null ? `${debugInfo.sessionTime.toFixed(2)}s` : 'n/a'}</span>
                            <span className="text-amber-300/80">Focused car</span>
                            <span>{debugInfo.focusedCarIdx ?? 'leader'}</span>
                            <span className="text-amber-300/80">Standings source</span>
                            <span>{debugInfo.standingsSource || 'n/a'}</span>
                            <span className="text-amber-300/80">Standings used</span>
                            <span>{Number(debugInfo.standingsCount || 0)}</span>
                            <span className="text-amber-300/80">Section</span>
                            <span>{debugInfo.previewSection || 'n/a'}</span>
                            <span className="text-amber-300/80">Page window</span>
                            <span>{debugInfo.pageStart == null || debugInfo.pageEnd == null ? 'n/a' : `${debugInfo.pageStart}-${debugInfo.pageEnd}`} {debugInfo.pageIndex == null || debugInfo.totalPages == null ? '' : `(p${debugInfo.pageIndex + 1}/${debugInfo.totalPages})`}</span>
                            <span className="text-amber-300/80">Section</span>
                            <span>{debugInfo.previewSection || 'n/a'}</span>
                            <span className="text-amber-300/80">Page window</span>
                            <span>{debugInfo.pageStart == null || debugInfo.pageEnd == null ? 'n/a' : `${debugInfo.pageStart}-${debugInfo.pageEnd}`} {debugInfo.pageIndex == null || debugInfo.totalPages == null ? '' : `(p${debugInfo.pageIndex + 1}/${debugInfo.totalPages})`}</span>
                          </div>
                          {Array.isArray(debugInfo.standingsPreview) && debugInfo.standingsPreview.length > 0 && (
                            <div className="pt-1 border-t border-amber-500/20">
                              <div className="text-amber-300/80 mb-0.5">Standings preview</div>
                              <div>{JSON.stringify(debugInfo.standingsPreview)}</div>
                            </div>
                          )}
                          {debugSummary && (
                            <div className="pt-1 border-t border-amber-500/20">
                              <div className="text-amber-300/80 mb-0.5">Frame summary</div>
                              <div>{JSON.stringify(debugSummary)}</div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {showEventOverlay && <IracingCommandLog />}
                  </>
                )}
              </div>
            </div>
          }
          bottom={
            <>
              {/* Timeline region bar */}
              <div className="flex items-center border-b border-border bg-bg-secondary shrink-0">
                <CollapsiblePanelHeader
                  open={!timelineCollapsed}
                  onToggle={() => setTimelineCollapsed(v => !v)}
                  icon={Film}
                  title="Overlay Timeline"
                  subtitle={`${sectionSegments.length} segments`}
                  className="flex-1"
                />
              </div>

              {/* Transport controls are part of timeline region */}
              {!timelineCollapsed && (
              <PlaybackControls
                onPrev={() => seekToSegment(currentSegIndex <= 0 ? 0 : currentSegIndex - 1)}
                prevDisabled={currentSegIndex <= 0}
                prevTitle="Previous segment"
                onNext={() => seekToSegment(currentSegIndex + 1)}
                nextDisabled={currentSegIndex >= timelineSegments.length - 1}
                nextTitle="Next segment"
                isPlaying={playing}
                onPlayPause={togglePlay}
                position={currentSegIndex >= 0
                  ? `${currentSegIndex + 1} / ${timelineSegments.length}`
                  : `– / ${timelineSegments.length}`}
                progress={totalDuration > 0 ? playheadTime / totalDuration : 0}
                timeDisplay={formatTime(playheadTime)}
                driftSeconds={driftSeconds}
                speeds={[0.25, 0.5, 1, 2, 4]}
                activeSpeed={playbackSpeed}
                onSpeedChange={handlePlaybackSpeedChange}
              />
              )}

              {/* Timeline scrubber */}
              {!timelineCollapsed && (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-bg-primary">
                <ConfigurableTimelineTracks
                  gutterWidth={52}
                  rows={[
                    {
                      key: 'section',
                      label: 'Sect',
                      height: OVERLAY_TIMELINE_SECTION_H,
                      render: ({ top, height }) => (
                        <div
                          key="row-section"
                          className="absolute left-0 right-0 border-b border-border-subtle cursor-ew-resize"
                          style={{ top, height }}
                          onMouseDown={handleTimelinePointerDown}
                        >
                          {timelineSegments.map(({ seg, timelineStart, duration }, idx) => {
                            const relStart = timelineStart
                            const segDur = duration
                            const left = totalDuration > 0 ? (relStart / totalDuration) * 100 : 0
                            const width = totalDuration > 0 ? (segDur / totalDuration) * 100 : 0
                            const secKey = seg.section || activeSection
                            const style = SECTION_TRACK_STYLE[secKey] || SECTION_TRACK_STYLE.race
                            return (
                              <div
                                key={`sec-${seg.id || idx}`}
                                className="absolute top-0 h-full flex items-center overflow-hidden"
                                style={{ left: `${left}%`, width: `${Math.max(0.8, width)}%`, backgroundColor: style.bg, borderRight: `1px solid ${style.border}` }}
                                onMouseDown={(e) => { e.stopPropagation(); seekTimelineAndReplay(relStart) }}
                                title={`${style.label}: ${formatTime(relStart)} - ${formatTime(relStart + segDur)}`}
                              >
                                <span className="truncate pl-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: style.text }}>
                                  {style.label}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      ),
                    },
                    {
                      key: 'design',
                      label: 'Design',
                      height: OVERLAY_TIMELINE_TEMPLATE_H,
                      render: ({ top, height }) => (
                        <div
                          key="row-design"
                          className="absolute left-0 right-0 border-b border-border-subtle cursor-ew-resize"
                          style={{ top, height }}
                          onMouseDown={handleTimelinePointerDown}
                        >
                          {timelineSegments.map(({ seg, timelineStart, duration }, idx) => {
                            const relStart = timelineStart
                            const segDur = duration
                            const left = totalDuration > 0 ? (relStart / totalDuration) * 100 : 0
                            const width = totalDuration > 0 ? (segDur / totalDuration) * 100 : 0
                            const segDesign = getSegmentOverlayDesignId(seg, selectedPresetId)
                            const eventSpecific = Boolean(seg?.overlay_preset_id || seg?.overlay_preset || seg?.overlayPresetId)
                            return (
                              <div
                                key={`design-${seg.id || idx}`}
                                className={`absolute top-0.5 bottom-0.5 rounded-sm border overflow-hidden px-1 text-left ${
                                  eventSpecific
                                    ? 'bg-emerald-500/18 border-emerald-400/45'
                                    : 'bg-bg-secondary border-border-subtle'
                                }`}
                                style={{ left: `${left}%`, width: `${Math.max(0.8, width)}%` }}
                                title={`${eventSpecific ? 'Event design' : 'Section/default design'}: ${segDesign}`}
                                onMouseDown={(e) => { e.stopPropagation(); seekTimelineAndReplay(relStart) }}
                              >
                                <select
                                  className={`w-full h-full bg-transparent border-0 outline-none text-[10px] font-mono ${eventSpecific ? 'text-emerald-200' : 'text-text-tertiary'}`}
                                  value={eventSpecific ? segDesign : '__default__'}
                                  title={eventSpecific ? `Event design: ${segDesign}` : 'Section/default design'}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onChange={(e) => assignSegmentDesign(seg?.id, e.target.value)}
                                >
                                  <option value="__default__">default</option>
                                  {presets.map((preset) => (
                                    <option key={preset.id} value={preset.id}>{preset.name}</option>
                                  ))}
                                </select>
                              </div>
                            )
                          })}
                        </div>
                      ),
                    },
                    {
                      key: 'event',
                      label: 'Event',
                      height: dynamicEventH,
                      render: ({ top, height }) => (
                        <div
                          key="row-event"
                          className="absolute left-0 right-0 border-b border-border-subtle cursor-ew-resize"
                          style={{ top, height }}
                          onMouseDown={handleTimelinePointerDown}
                        >
                          {paginationTimelineEvents.map((event, idx) => {
                            const left = totalDuration > 0 ? (event.atSeconds / totalDuration) * 100 : 0
                            return (
                              <div
                                key={`evt-page-marker-${idx}`}
                                className="absolute top-0 bottom-0 z-20 pointer-events-none"
                                style={{ left: `${left}%` }}
                                title={`${event.label} at ${formatTime(event.atSeconds)}`}
                              >
                                <div className="absolute top-0 bottom-0 w-px bg-cyan-400/35" />
                              </div>
                            )
                          })}
                          {timelineSegments.map(({ seg, timelineStart, duration }, idx) => {
                            const relStart = timelineStart
                            const segDur = duration
                            const left = totalDuration > 0 ? (relStart / totalDuration) * 100 : 0
                            const width = totalDuration > 0 ? (segDur / totalDuration) * 100 : 0
                            const isActive = currentSegment?.id === seg.id
                            const eventLabel = getOverlayEventLabel(seg)
                            const paginationLabel = (() => {
                              if (!paginationPreviewState) return null
                              const interval = Math.max(0.001, paginationPreviewState.intervalSeconds)
                              const startPage = Math.floor(Math.max(0, relStart) / interval) % paginationPreviewState.totalPages
                              const endPage = Math.floor(Math.max(0, relStart + Math.max(0, segDur) - 0.001) / interval) % paginationPreviewState.totalPages
                              if (startPage === endPage) return `P${startPage + 1}`
                              return `P${startPage + 1}->P${endPage + 1}`
                            })()
                            return (
                              <button
                                key={`evt-${seg.id || idx}`}
                                type="button"
                                className={`absolute top-1 bottom-1 rounded-sm overflow-hidden border text-left px-1 transition-colors ${
                                  isActive
                                    ? 'bg-accent/20 border-accent/50'
                                    : 'bg-bg-hover border-border/50 hover:bg-bg-secondary'
                                }`}
                                style={{ left: `${left}%`, width: `${Math.max(0.8, width)}%` }}
                                title={`${eventLabel}: ${formatTime(relStart)} - ${formatTime(relStart + segDur)}`}
                                onMouseDown={(e) => { e.stopPropagation(); seekTimelineAndReplay(relStart) }}
                              >
                                <span className={`text-xxs truncate block ${isActive ? 'text-accent' : 'text-text-secondary'}`}>
                                  {eventLabel}{paginationLabel ? ` · ${paginationLabel}` : ''}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      ),
                    },
                    {
                      key: 'actions',
                      label: 'Action',
                      height: OVERLAY_TIMELINE_ACTIONS_H,
                      render: ({ top, height }) => (
                        <div
                          key="row-actions"
                          className="absolute left-0 right-0 border-b border-border-subtle cursor-ew-resize"
                          style={{ top, height }}
                          onMouseDown={handleTimelinePointerDown}
                        >
                          {paginationTimelineEvents.length > 0 ? (
                            paginationTimelineEvents.map((event, idx) => {
                              const left = totalDuration > 0 ? (event.atSeconds / totalDuration) * 100 : 0
                              return (
                                <button
                                  key={`action-page-${idx}`}
                                  type="button"
                                  className="absolute top-0 bottom-0"
                                  style={{ left: `${left}%` }}
                                  title={`${event.label} at ${formatTime(event.atSeconds)}`}
                                  onMouseDown={(e) => {
                                    e.stopPropagation()
                                    seekTimelineAndReplay(event.atSeconds)
                                  }}
                                >
                                  <div className="absolute top-0 bottom-0 w-px bg-cyan-400/70" />
                                  <span className="absolute top-0.5 left-1 whitespace-nowrap rounded border border-cyan-500/45 bg-cyan-900/35 px-1 text-[9px] font-semibold uppercase tracking-wide text-cyan-200">
                                    {event.label}
                                  </span>
                                </button>
                              )
                            })
                          ) : (
                            <div className="absolute inset-0 flex items-center px-2 text-[10px] text-text-disabled/80">
                              No pagination actions
                            </div>
                          )}
                        </div>
                      ),
                    },
                    {
                      key: 'ticks',
                      label: '',
                      height: OVERLAY_TIMELINE_TICK_H,
                      gutterClassName: '',
                      render: ({ top, height }) => (
                        <div
                          key="row-ticks"
                          className="absolute left-0 right-0"
                          style={{ top, height }}
                          onMouseDown={handleTimelinePointerDown}
                        >
                          <div className="absolute inset-x-0 top-0 h-px bg-border-subtle" />
                          <div className="absolute inset-x-0 bottom-1 flex justify-between px-2">
                            <span className="text-xxs font-mono text-text-disabled">{formatTime(0)}</span>
                            <span className="text-xxs font-mono text-text-disabled">{formatTime(totalDuration)}</span>
                          </div>
                        </div>
                      ),
                    },
                  ]}
                  canvasHeight={totalTrackH}
                  contentWidth={zoomedContentW}
                  canvasRef={timelineRef}
                  scrollRef={scrollRef}
                  onScroll={handleTimelineScroll}
                  containerClassName="flex-1 h-full min-h-0 flex overflow-hidden bg-bg-primary"
                  scrollClassName="flex-1 min-h-0 overflow-x-auto overflow-y-hidden [scrollbar-gutter:stable]"
                  playheadX={`${totalDuration > 0 ? (playheadTime / totalDuration) * 100 : 0}%`}
                  onPlayheadMouseDown={handleTimelinePointerDown}
                  playheadTitle="Drag to scrub section timeline"
                  playheadClassName="bg-accent"
                  playheadDraggingClassName="bg-accent"
                  isPlayheadDragging={isDraggingPlayhead}
                />
                <RangeSlider
                  rangeStart={rangeStart}
                  rangeEnd={rangeEnd}
                  onChange={(start, end) => {
                    setRangeStart(start)
                    setRangeEnd(end)
                  }}
                  totalDuration={totalDuration}
                  events={rangeSliderEvents}
                  playheadTime={totalDuration > 0 ? playheadTime : null}
                />
              </div>
              )}
            </>
          }
        />
      )}
    </div>
  )
}
