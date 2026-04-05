import { useState, useEffect, useRef, useCallback, memo } from 'react'
import Hls from 'hls.js'
import { useAnalysis } from '../../context/AnalysisContext'
import { useProject } from '../../context/ProjectContext'
import { useIRacing } from '../../context/IRacingContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { apiPost, apiGet, apiDelete } from '../../services/api'
import {
  Play, Pause, Square, BarChart3, AlertTriangle, Swords, ArrowUpDown,
  Fuel, Zap, Crown, Flag, FlagTriangleRight, Loader2, CheckCircle2,
  XCircle, Terminal, ChevronRight, ChevronDown, ChevronUp, Camera, Video, Monitor,
  SkipBack, SkipForward, Rewind, FastForward, List, Trash2, Settings,
  Eye, EyeOff, Users, RefreshCw, Flame, RotateCcw, CircleDot, ShieldAlert, WifiOff, AlertCircle, Minus, Plus,
  Folder, SlidersHorizontal, Info, CarFront, BookOpen,
} from 'lucide-react'
import ProjectFileBrowser from '../projects/ProjectFileBrowser'
import ResizableSidebar from '../layout/ResizableSidebar'
import Tooltip from '../ui/Tooltip'
import RaceStory from '../race-story/RaceStory'

/**
 * Event type display configuration — icons, labels, and colors.
 */
const EVENT_CONFIG = {
  incident:      { icon: AlertTriangle,     label: 'Incident',       color: 'text-event-incident',  bg: 'bg-event-incident/10' },
  battle:        { icon: Swords,            label: 'Battle',         color: 'text-event-battle',    bg: 'bg-event-battle/10' },
  overtake:      { icon: ArrowUpDown,       label: 'Overtake',       color: 'text-event-overtake',  bg: 'bg-event-overtake/10' },
  pit_stop:      { icon: Fuel,              label: 'Pit Stop',       color: 'text-event-pit',       bg: 'bg-event-pit/10' },
  fastest_lap:   { icon: Zap,              label: 'Fastest Lap',    color: 'text-event-fastest',   bg: 'bg-event-fastest/10' },
  leader_change: { icon: Crown,            label: 'Leader Change',  color: 'text-event-leader',    bg: 'bg-event-leader/10' },
  pace_lap:      { icon: CarFront,         label: 'Pace Lap',       color: 'text-event-firstlap',  bg: 'bg-event-firstlap/10' },
  first_lap:     { icon: FlagTriangleRight, label: 'First Lap',     color: 'text-event-firstlap',  bg: 'bg-event-firstlap/10' },
  last_lap:      { icon: Flag,             label: 'Last Lap',       color: 'text-event-lastlap',   bg: 'bg-event-lastlap/10' },
  crash:         { icon: Flame,            label: 'Crash',          color: 'text-event-incident',  bg: 'bg-event-incident/10' },
  spinout:       { icon: RotateCcw,        label: 'Spinout',        color: 'text-event-battle',    bg: 'bg-event-battle/10' },
  contact:       { icon: CircleDot,        label: 'Contact',        color: 'text-event-overtake',  bg: 'bg-event-overtake/10' },
  close_call:    { icon: ShieldAlert,      label: 'Close Call',     color: 'text-event-fastest',   bg: 'bg-event-fastest/10' },
}

/**
 * H264StreamPlayer — MSE-based H.264 fMP4 live stream player.
 * Uses MediaSource Extensions to consume a chunked fragmented-MP4 stream
 * from /api/iracing/stream/h264 without buffer stalls or file-seek issues.
 */
function H264StreamPlayer({ src, className, onLoad, onError }) {
  const videoRef = useRef(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return
    if (!window.MediaSource) {
      onError?.(new Error('MediaSource not supported in this browser'))
      return
    }

    const controller = new AbortController()
    const queue = []
    let sb = null
    let ms = null

    // Pick best supported H.264 codec string (high > main > baseline)
    const CODEC = [
      'video/mp4; codecs="avc1.640028"',
      'video/mp4; codecs="avc1.4D4028"',
      'video/mp4; codecs="avc1.42E028"',
    ].find(c => MediaSource.isTypeSupported(c)) ?? 'video/mp4; codecs="avc1.42E028"'

    ms = new MediaSource()
    const blobUrl = URL.createObjectURL(ms)
    video.src = blobUrl

    const flush = () => {
      if (!sb || sb.updating || !queue.length) return
      try { sb.appendBuffer(queue.shift()) } catch {}
    }

    ms.addEventListener('sourceopen', async () => {
      try {
        sb = ms.addSourceBuffer(CODEC)
        sb.mode = 'sequence'
        let played = false
        sb.addEventListener('updateend', () => {
          // Start playback and notify parent on first successful append
          if (!played && sb && sb.buffered.length > 0) {
            played = true
            video.play().catch(() => {})
            onLoad?.()
          }
          // Trim stale buffered data to prevent memory growth
          if (sb && sb.buffered.length > 0 && !sb.updating) {
            const t = video.currentTime
            const s = sb.buffered.start(0)
            if (t - s > 8) {
              try { sb.remove(s, Math.max(s + 0.1, t - 4)) } catch {}
              return
            }
          }
          flush()
        })

        const resp = await fetch(src, { signal: controller.signal })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const reader = resp.body.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            queue.push(value)
            flush()
          }
        } catch (e) {
          // AbortError is expected on cleanup — not a real error
          if (e?.name !== 'AbortError') throw e
        } finally {
          reader.cancel()
        }
      } catch (e) {
        if (e?.name !== 'AbortError' && !controller.signal.aborted) onError?.(e)
      }
    })

    return () => {
      controller.abort()
      // Detach video source first, then clean up MSE objects
      try { video.pause() } catch {}
      video.removeAttribute('src')
      video.load()
      try { URL.revokeObjectURL(blobUrl) } catch {}
      // Dereference so flush() no-ops if updateend fires after cleanup
      sb = null
      ms = null
    }
  }, [src])

  return (
    <video
      ref={videoRef}
      className={className}
      style={{ pointerEvents: 'none' }}
      autoPlay
      muted
      playsInline
    />
  )
}

/**
 * HlsStreamPlayer — HLS live stream player.
 * Uses hls.js on browsers that lack native HLS support (Chrome, Edge, Firefox).
 * Falls back to the native <video> HLS player on Safari.
 *
 * Connects to /api/iracing/stream/hls/playlist.m3u8 which the backend serves
 * via FFmpeg's HLS segmenter (~1–3 s latency, smooth H.264 quality).
 */
function HlsStreamPlayer({ src, className, onLoad, onError }) {
  const videoRef = useRef(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return

    // Guard against post-unmount callbacks (stale closure safe-guard)
    let alive = true

    // Safari has native HLS — no hls.js needed
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src
      const handleLoadedMetadata = () => { if (alive) { video.play().catch(() => {}); onLoad?.() } }
      const handleError = () => { if (alive) onError?.(new Error('HLS stream error')) }
      video.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true })
      video.addEventListener('error', handleError, { once: true })
      return () => {
        alive = false
        video.removeEventListener('loadedmetadata', handleLoadedMetadata)
        video.removeEventListener('error', handleError)
        video.removeAttribute('src')
        video.load()
      }
    }

    if (!Hls.isSupported()) {
      onError?.(new Error('HLS is not supported in this browser'))
      return
    }

    // Do NOT use lowLatencyMode — we serve standard HLS (complete 1-second
    // segments), not LL-HLS. lowLatencyMode makes hls.js attempt partial-
    // segment range requests our server doesn't support, generating
    // AbortErrors on every segment load.
    const hls = new Hls({
      lowLatencyMode: false,
      maxBufferLength: 4,       // keep ~4 s of buffer for this near-live use case
      maxMaxBufferLength: 8,
    })
    hls.loadSource(src)
    hls.attachMedia(video)
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (!alive) return
      video.play().catch(() => {})
      onLoad?.()
    })
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal && alive) onError?.(new Error(data.details || 'HLS playback error'))
    })

    return () => {
      alive = false
      hls.destroy()
      video.removeAttribute('src')
      video.load()
      // Tell the backend to tear down the HLS segmenter immediately so the
      // feeder thread stops draining _h264_queue.
      fetch('/api/iracing/stream/hls/stop', { method: 'POST' }).catch(() => {})
    }
  // Only re-create hls.js when the source URL changes — not on every parent
  // render that creates new onLoad/onError function instances.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  return (
    <video
      ref={videoRef}
      className={className}
      style={{ pointerEvents: 'none' }}
      autoPlay
      muted
      playsInline
    />
  )
}

/**
 * AnalysisPanel — Full layout with:
 *  - Fixed top bar: controls + progress + clear analysis
 *  - Full-height middle: resizable/collapsible tabbed sidebar (Log/Events/Files) + 16:9 MJPEG TV + playback controls
 *  - Particle event cards overlaid on the TV
 *  - Clicking events seeks the replay; separate expand button for details
 */
export default memo(function AnalysisPanel() {
  const {
    isAnalyzing, progress, events, eventSummary, error,
    analysisLog, discoveredEvents,
    startAnalysis, cancelAnalysis, clearAnalysis,
    fetchEvents, fetchEventSummary, fetchAnalysisStatus,
    loadAnalysisLog, clearDiscoveredEvents,
  } = useAnalysis()
  const { activeProject, advanceStep } = useProject()
  const { isConnected } = useIRacing()
  const [activeFilter, setActiveFilter] = useState('')
  const logEndRef = useRef(null)
  const eventsEndRef = useRef(null)
  const [expandedEvent, setExpandedEvent] = useState(null)

  // Sidebar tab: 'log' | 'events' | 'files' — synced with ResizableSidebar via shared storage key
  const [sidebarTab, setSidebarTab] = useLocalStorage('lrs:analysis:sidebar:tab', 'log')
  const wasAnalyzingRef = useRef(false)

  // Event feed overlay — auto-dismiss after a few seconds
  const [feedEvents, setFeedEvents] = useState([])
  const feedTimersRef = useRef(new Map())
  const FEED_LIFETIME_MS = 5000

  // When new discovered events come in, add them to feed with auto-dismiss
  useEffect(() => {
    if (discoveredEvents.length === 0) {
      setFeedEvents([])
      feedTimersRef.current.forEach(t => clearTimeout(t))
      feedTimersRef.current.clear()
      return
    }
    const latest = discoveredEvents[discoveredEvents.length - 1]
    if (feedTimersRef.current.has(latest.id)) return
    setFeedEvents(prev => [...prev.slice(-4), latest])
    const timer = setTimeout(() => {
      setFeedEvents(prev => prev.filter(e => e.id !== latest.id))
      feedTimersRef.current.delete(latest.id)
    }, FEED_LIFETIME_MS)
    feedTimersRef.current.set(latest.id, timer)
  }, [discoveredEvents])

  // Cleanup timers on unmount
  useEffect(() => {
    return () => feedTimersRef.current.forEach(t => clearTimeout(t))
  }, [])

  // Camera follow toggle
  const [cameraFollow, setCameraFollow] = useLocalStorage('lrs:analysis:cameraFollow', false)
  const lastCameraEventRef = useRef(null)

  // Event table sort state
  const [eventSort, setEventSort] = useState({ col: 'time', dir: 'asc' })

  // Window picker state
  const [showWindowPicker, setShowWindowPicker] = useState(false)
  const [windowList, setWindowList] = useState([])
  const [captureTarget, setCaptureTarget] = useState({ mode: 'auto', hwnd: null })
  const [loadingWindows, setLoadingWindows] = useState(false)

  // Replay control state
  const [replaySpeed, setReplaySpeed] = useState(1)
  const [isPlaying, setIsPlaying] = useState(true)
  const [replayState, setReplayState] = useState(null)

  // Stream quality settings — each format has its own independent settings.
  // FPS is shared (it's a display preference, not format-specific).
  const [streamFps, setStreamFps] = useLocalStorage('lrs:analysis:streamFps', 15)
  const [streamFormat, setStreamFormat] = useLocalStorage('lrs:analysis:streamFormat', 'mjpeg')
  // MJPEG-specific
  const [mjpegQuality, setMjpegQuality] = useLocalStorage('lrs:analysis:mjpegQuality', 85)
  const [mjpegMaxWidth, setMjpegMaxWidth] = useLocalStorage('lrs:analysis:mjpegMaxWidth', 1280)
  // H.264-specific
  const [h264Crf, setH264Crf] = useLocalStorage('lrs:analysis:h264Crf', 23)
  const [h264MaxWidth, setH264MaxWidth] = useLocalStorage('lrs:analysis:h264MaxWidth', 1280)
  const [streamHlsCrf, setStreamHlsCrf] = useLocalStorage('lrs:analysis:streamHlsCrf', 23)
  const [showQualitySettings, setShowQualitySettings] = useState(false)

  // Detection tuning parameters
  const [tuningParams, setTuningParams] = useLocalStorage('lrs:analysis:tuningParams', {
    battle_gap_threshold: 0.5,
    crash_min_time_loss: 10.0,
    crash_min_off_track_duration: 3.0,
    spinout_min_time_loss: 2.0,
    spinout_max_time_loss: 10.0,
    contact_time_window: 2.0,
    contact_proximity: 0.05,
    close_call_proximity: 0.02,
    close_call_max_off_track: 3.0,
  })
  const [showTuning, setShowTuning] = useState(false)
  const [isRedetecting, setIsRedetecting] = useState(false)
  // Stream key — changes to force <img> reload when quality settings change
  const [streamKey, setStreamKey] = useState(0)
  const [streamLoaded, setStreamLoaded] = useState(false)
  const [streamError, setStreamError] = useState(null)
  const [streamVisible, setStreamVisible] = useState(true)
  const [isDataLoading, setIsDataLoading] = useState(true)

  // Timeline scrubber state
  const [raceDuration, setRaceDuration] = useState(0)
  const scrubberRef = useRef(null)

  // Reset loaded state whenever the stream is recycled
  useEffect(() => { setStreamLoaded(false); setStreamError(null) }, [streamKey])

  // Drivers list for camera switching
  const [drivers, setDrivers] = useState([])

  // Camera groups
  const [cameraGroups, setCameraGroups] = useState([])

  const fetchWindows = useCallback(async () => {
    setLoadingWindows(true)
    try {
      const [windows, target] = await Promise.all([
        apiGet('/iracing/windows'),
        apiGet('/iracing/capture-target'),
      ])
      setWindowList(windows)
      setCaptureTarget(target)
    } catch {} finally {
      setLoadingWindows(false)
    }
  }, [])

  const selectWindow = async (hwnd) => {
    try {
      await apiPost('/iracing/capture-target', { hwnd })
      setCaptureTarget({ mode: 'manual', hwnd })
      setShowWindowPicker(false)
    } catch {}
  }

  const resetToAuto = async () => {
    try {
      await apiDelete('/iracing/capture-target')
      setCaptureTarget({ mode: 'auto', hwnd: null })
      setShowWindowPicker(false)
    } catch {}
  }

  // Load drivers and cameras when connected
  useEffect(() => {
    if (!isConnected) return
    apiGet('/iracing/session').then(data => {
      setDrivers(data.drivers || [])
      setCameraGroups(data.cameras || [])
    }).catch(() => {})
  }, [isConnected])

  // Poll replay state periodically (for timeline display)
  useEffect(() => {
    if (!isConnected) return
    const interval = setInterval(() => {
      apiGet('/iracing/replay/state').then(setReplayState).catch(() => {})
    }, 1000)
    return () => clearInterval(interval)
  }, [isConnected])

  // Load analysis data when project changes
  useEffect(() => {
    if (!activeProject?.id) return
    setIsDataLoading(true)
    const logFetch = apiGet(`/projects/${activeProject.id}/analysis/log`)
      .then(data => { if (data?.entries?.length > 0) loadAnalysisLog(data.entries) })
      .catch(() => {})
    Promise.all([
      fetchAnalysisStatus(activeProject.id),
      fetchEvents(activeProject.id),
      fetchEventSummary(activeProject.id),
      logFetch,
    ]).finally(() => setIsDataLoading(false))
  }, [activeProject?.id, fetchAnalysisStatus, fetchEvents, fetchEventSummary, loadAnalysisLog])

  // Fetch race duration for timeline scrubber
  useEffect(() => {
    if (!activeProject?.id) return
    apiGet(`/projects/${activeProject.id}/analysis/race-duration`)
      .then(data => setRaceDuration(data?.duration_seconds || 0))
      .catch(() => {})
  }, [activeProject?.id, events])

  // Auto-scroll events sidebar (scroll newest to view during live analysis)
  useEffect(() => {
    if (sidebarTab === 'events' && eventsEndRef.current) {
      eventsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [discoveredEvents, sidebarTab])

  // Auto-switch to events tab when analysis finishes
  useEffect(() => {
    if (wasAnalyzingRef.current && !isAnalyzing) {
      setSidebarTab('events')
    }
    wasAnalyzingRef.current = isAnalyzing
  }, [isAnalyzing, setSidebarTab])

  // Camera follow
  useEffect(() => {
    if (!cameraFollow || !isAnalyzing || discoveredEvents.length === 0) return
    const latest = discoveredEvents[discoveredEvents.length - 1]
    if (lastCameraEventRef.current === latest.id) return
    lastCameraEventRef.current = latest.id
    const carIdx = latest.carIdx ?? latest.car_idx
    if (carIdx != null) {
      apiPost('/iracing/replay/camera', { car_idx: carIdx, group_num: 0 }).catch(() => {})
    }
  }, [cameraFollow, isAnalyzing, discoveredEvents])

  const hasEvents = events.length > 0

  if (!activeProject) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary">
        <p>Select a project to view analysis</p>
      </div>
    )
  }

  const handleStart = async () => {
    setSidebarTab('log')
    try { await startAnalysis(activeProject.id, tuningParams) } catch {}
  }

  const handleCancel = async () => {
    try { await cancelAnalysis(activeProject.id) } catch {}
  }

  const handleClear = async () => {
    try { await clearAnalysis(activeProject.id) } catch {}
  }

  const handleFilterChange = async (type) => {
    const newFilter = activeFilter === type ? '' : type
    setActiveFilter(newFilter)
    await fetchEvents(activeProject.id, { eventType: newFilter })
  }

  const handleRedetect = async () => {
    if (!activeProject?.id || isRedetecting) return
    setIsRedetecting(true)
    clearDiscoveredEvents()
    try {
      await apiPost(`/projects/${activeProject.id}/analyze/redetect`, tuningParams)
      await fetchEvents(activeProject.id)
      await fetchEventSummary(activeProject.id)
    } catch {} finally {
      setIsRedetecting(false)
    }
  }

  const updateTuning = (key, value) => {
    setTuningParams(prev => ({ ...prev, [key]: value }))
  }

  // Seek iRacing replay to an event's start time + focus the involved driver
  const seekToEvent = async (event) => {
    if (!isConnected) return
    const sessionNum = event.session_num ?? 0
    const timeMs = Math.round((event.startTime ?? event.start_time_seconds ?? 0) * 1000)
    try {
      await apiPost('/iracing/replay/seek-time', { session_num: sessionNum, session_time_ms: timeMs })
      // Focus the primary involved driver
      const carIdx = event.carIdx ?? event.car_idx
        ?? (event.involved_drivers && event.involved_drivers[0])
      if (carIdx != null) {
        await apiPost('/iracing/replay/camera', { car_idx: carIdx, group_num: 0 })
      }
    } catch {}
  }

  // ── Playback controls ─────────────────────────────────────────────────
  const handlePlayPause = async () => {
    if (!isConnected) return   // guard: iRacing must be connected
    try {
      if (isPlaying) {
        await apiPost('/iracing/replay/speed', { speed: 0 })
        setIsPlaying(false)
        setReplaySpeed(0)
      } else {
        await apiPost('/iracing/replay/speed', { speed: 1 })
        setIsPlaying(true)
        setReplaySpeed(1)
      }
    } catch {}
  }

  const handleSetSpeed = async (speed) => {
    if (!isConnected) return
    try {
      await apiPost('/iracing/replay/speed', { speed })
      setReplaySpeed(speed)
      setIsPlaying(speed !== 0)
    } catch {}
  }

  const handleReplaySearch = async (mode) => {
    try { await apiPost('/iracing/replay/search', { mode }) } catch {}
  }

  const handleSwitchDriver = async (carIdx) => {
    // Use the currently active camera group so switching drivers doesn't
    // force a camera change.  0 = "no change" in iRacing's API.
    const camGroup = replayState?.cam_group_num ?? 0
    try {
      await apiPost('/iracing/replay/camera', { car_idx: carIdx, group_num: camGroup })
    } catch {}
  }

  const handleSwitchCamera = async (groupNum) => {
    const carIdx = replayState?.cam_car_idx ?? 0
    try {
      await apiPost('/iracing/replay/camera', { car_idx: carIdx, group_num: groupNum })
    } catch {}
  }

  const cycleSort = (col) => {
    setEventSort(prev => prev.col === col
      ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { col, dir: 'asc' }
    )
  }

  const streamUrl = `/api/iracing/stream?fps=${streamFps}&quality=${mjpegQuality}&max_width=${mjpegMaxWidth}&_k=${streamKey}`
  const h264Url   = `/api/iracing/stream/h264?fps=${streamFps}&crf=${h264Crf}&max_width=${h264MaxWidth}&_k=${streamKey}`
  const hlsUrl    = `/api/iracing/stream/hls/playlist.m3u8?fps=${streamFps}&crf=${streamHlsCrf}&max_width=${h264MaxWidth}&_k=${streamKey}`
  const activeStreamUrl = streamFormat === 'h264' ? h264Url : streamFormat === 'hls' ? hlsUrl : streamUrl

  // ── Loading state: initial data fetch in progress ────────────────────
  if (isDataLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <Loader2 size={22} className="animate-spin text-text-disabled" />
        <p className="text-xs text-text-tertiary">Loading analysis data…</p>
      </div>
    )
  }

  // ── Idle state: no analysis running, no events ────────────────────────
  if (!isAnalyzing && !hasEvents && discoveredEvents.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="flex flex-col items-center gap-3 text-center max-w-sm">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-gradient-from via-gradient-via to-gradient-to
                          flex items-center justify-center shadow-glow-sm">
            <BarChart3 size={28} className="text-white" />
          </div>
          <h2 className="text-lg font-bold text-text-primary">Replay Analysis</h2>
          <p className="text-sm text-text-tertiary leading-relaxed">
            Scan the replay at 16× speed to detect battles, incidents, overtakes, and key moments.
          </p>
          <button
            onClick={handleStart}
            className="flex items-center gap-2 px-6 py-3 text-sm font-semibold
                       text-white bg-gradient-to-r from-gradient-from to-gradient-to
                       rounded-xl hover:from-gradient-via hover:to-gradient-from
                       transition-all duration-200 shadow-glow-sm hover:shadow-glow mt-2"
          >
            <Play size={16} />
            Analyze Replay
          </button>
          {error && (
            <div className="flex items-start gap-1.5 text-danger mt-2">
              <XCircle size={14} className="shrink-0 mt-0.5" />
              <span className="text-xs leading-relaxed">{error}</span>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Active / post-analysis layout ─────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col overflow-hidden">

      {/* ── Top control bar — only visible during analysis or on error/complete ── */}
      {(isAnalyzing || error || progress?.percent === 100) && (
        <div className="shrink-0 border-b border-border bg-bg-secondary">
          <div className="flex items-center gap-4 px-4 py-2.5">
            {/* Stop / Complete indicator */}
            <div className="flex items-center gap-2">
              {isAnalyzing ? (
                <button
                  onClick={handleCancel}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium
                             text-danger bg-danger/10 rounded-lg hover:bg-danger/20 transition-colors"
                >
                  <Square size={13} />
                  Stop
                </button>
              ) : (
                progress?.percent === 100 && (
                  <div className="flex items-center gap-1 text-success">
                    <CheckCircle2 size={13} />
                    <span className="text-xxs font-medium">Complete</span>
                  </div>
                )
              )}
            </div>

            {/* Progress bar */}
            {isAnalyzing && progress && (
              <div className="flex-1 flex items-center gap-3 min-w-0">
                <div className="flex-1 h-1.5 bg-surface rounded-full overflow-hidden max-w-xs">
                  <div
                    className="h-full bg-gradient-to-r from-gradient-from via-gradient-via to-gradient-to
                               rounded-full transition-all duration-300"
                    style={{ width: `${progress.percent || 0}%` }}
                  />
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Loader2 size={11} className="text-accent animate-spin" />
                  <span className="text-xxs text-text-secondary truncate max-w-[200px]">
                    {progress.message || 'Analyzing...'}
                  </span>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="flex items-center gap-1.5 px-4 py-1.5 bg-danger/10 border-t border-danger/20">
              <XCircle size={12} className="text-danger shrink-0" />
              <span className="text-xxs text-danger">{error}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Main area: sidebar + TV + controls (fills remaining height) ── */}
      <div className="flex-1 flex overflow-hidden min-h-0 relative">

        {/* ── Tabbed sidebar (Log / Events / Files) — resizable & collapsible ── */}
        <ResizableSidebar
          storageKey="lrs:analysis:sidebar"
          defaultTab="log"
          tabs={[
            {
              id: 'log',
              label: 'Log',
              icon: Terminal,
              count: analysisLog.length,
              content: (
                <div className="font-mono">
                  {analysisLog.length === 0 && !isAnalyzing && (
                    <div className="flex items-center justify-center py-8 text-text-disabled text-xs">
                      No log entries yet
                    </div>
                  )}
                  {[...analysisLog].reverse().map(entry => (
                    <div
                      key={entry.id}
                      className="flex gap-2 px-3 py-1.5 text-xxs border-b border-border-subtle/30 animate-fade-in"
                    >
                      <span className="shrink-0 select-none mt-0.5">
                        {entry.level === 'success' ? (
                          <CheckCircle2 size={11} className="text-success" />
                        ) : entry.level === 'error' ? (
                          <XCircle size={11} className="text-danger" />
                        ) : entry.level === 'detect' ? (
                          <Zap size={11} className="text-warning" />
                        ) : (
                          <span className="text-text-disabled">›</span>
                        )}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-text-secondary">{entry.message}</span>
                        {entry.detail && (
                          <span className="text-text-disabled ml-1">— {entry.detail}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ),
            },
            {
              id: 'events',
              label: 'Events',
              icon: List,
              count: discoveredEvents.length || eventSummary?.total_events || 0,
              content: (
                <div className="flex flex-col h-full">
                  {/* Sub-navigation: Events list ↔ Tuning params */}
                  <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-border-subtle bg-bg-secondary/50">
                    <button
                      onClick={() => setShowTuning(false)}
                      className={`px-2 py-0.5 text-xxs rounded transition-colors
                        ${!showTuning ? 'bg-accent/15 text-accent' : 'text-text-disabled hover:text-text-secondary'}`}
                    >
                      Events
                    </button>
                    <button
                      onClick={() => setShowTuning(true)}
                      className={`flex items-center gap-1 px-2 py-0.5 text-xxs rounded transition-colors
                        ${showTuning ? 'bg-accent/15 text-accent' : 'text-text-disabled hover:text-text-secondary'}`}
                    >
                      <SlidersHorizontal size={9} />
                      Tune
                    </button>
                    {showTuning && (
                      <button
                        onClick={handleRedetect}
                        disabled={isRedetecting}
                        className="ml-auto flex items-center gap-1 px-2 py-0.5 text-xxs font-medium
                                   text-white bg-gradient-to-r from-gradient-from to-gradient-to
                                   rounded transition-all duration-150 shadow-glow-sm disabled:opacity-50"
                      >
                        {isRedetecting
                          ? <Loader2 size={9} className="animate-spin" />
                          : <SlidersHorizontal size={9} />}
                        {isRedetecting ? 'Running…' : 'Re-detect'}
                      </button>
                    )}
                  </div>

                  {showTuning ? (
                    /* ── Tuning form ── */
                    <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
                      {/* Battle */}
                      <div>
                        <span className="text-xxs font-semibold text-text-primary flex items-center gap-1 mb-1.5">
                          <Swords size={11} className="text-event-battle" /> Battle Detection
                        </span>
                        <TuneField
                          label="Gap threshold (s)"
                          tooltip="Maximum time gap (seconds) between two adjacent-position cars for a battle to be detected. Lower values require tighter racing. Battles must be sustained for 10+ seconds."
                          value={tuningParams.battle_gap_threshold}
                          onChange={v => updateTuning('battle_gap_threshold', v || 0.5)}
                          step={0.1} min={0.1} max={5}
                        />
                      </div>
                      {/* Crash */}
                      <div>
                        <span className="text-xxs font-semibold text-text-primary flex items-center gap-1 mb-1.5">
                          <Flame size={11} className="text-event-incident" /> Crash Detection
                        </span>
                        <div className="space-y-1.5">
                          <TuneField
                            label="Min time loss (s)"
                            tooltip="Minimum estimated time lost for an off-track excursion to qualify as a crash."
                            value={tuningParams.crash_min_time_loss}
                            onChange={v => updateTuning('crash_min_time_loss', v || 10)}
                            step={1} min={1} max={60}
                          />
                          <TuneField
                            label="Min off-track duration (s)"
                            tooltip="Minimum duration a car must remain off-track to count as a crash."
                            value={tuningParams.crash_min_off_track_duration}
                            onChange={v => updateTuning('crash_min_off_track_duration', v || 3)}
                            step={0.5} min={0.5} max={30}
                          />
                        </div>
                      </div>
                      {/* Spinout */}
                      <div>
                        <span className="text-xxs font-semibold text-text-primary flex items-center gap-1 mb-1.5">
                          <RotateCcw size={11} className="text-event-battle" /> Spinout Detection
                        </span>
                        <div className="space-y-1.5">
                          <TuneField
                            label="Min time loss (s)"
                            tooltip="Minimum time loss for an off-track moment to classify as a spinout."
                            value={tuningParams.spinout_min_time_loss}
                            onChange={v => updateTuning('spinout_min_time_loss', v || 2)}
                            step={0.5} min={0.5} max={30}
                          />
                          <TuneField
                            label="Max time loss (s)"
                            tooltip="Maximum time loss for a spinout. Events above this threshold are classified as crashes."
                            value={tuningParams.spinout_max_time_loss}
                            onChange={v => updateTuning('spinout_max_time_loss', v || 10)}
                            step={1} min={1} max={60}
                          />
                        </div>
                      </div>
                      {/* Contact */}
                      <div>
                        <span className="text-xxs font-semibold text-text-primary flex items-center gap-1 mb-1.5">
                          <CircleDot size={11} className="text-event-overtake" /> Contact Detection
                        </span>
                        <div className="space-y-1.5">
                          <TuneField
                            label="Time window (s)"
                            tooltip="Maximum time window for grouping multiple off-track cars as a single contact event."
                            value={tuningParams.contact_time_window}
                            onChange={v => updateTuning('contact_time_window', v || 2)}
                            step={0.5} min={0.5} max={10}
                          />
                          <TuneField
                            label="Proximity"
                            tooltip="Maximum track-position difference (fraction of lap) for two cars to be considered in contact."
                            value={tuningParams.contact_proximity}
                            onChange={v => updateTuning('contact_proximity', v || 0.05)}
                            step={0.01} min={0.01} max={1}
                          />
                        </div>
                      </div>
                      {/* Close Call */}
                      <div>
                        <span className="text-xxs font-semibold text-text-primary flex items-center gap-1 mb-1.5">
                          <ShieldAlert size={11} className="text-event-fastest" /> Close Call Detection
                        </span>
                        <div className="space-y-1.5">
                          <TuneField
                            label="Proximity"
                            tooltip="Maximum track-position difference between an off-track car and a nearby on-track car."
                            value={tuningParams.close_call_proximity}
                            onChange={v => updateTuning('close_call_proximity', v || 0.02)}
                            step={0.005} min={0.005} max={0.5}
                          />
                          <TuneField
                            label="Max off-track (s)"
                            tooltip="Maximum time loss for a close call — recovery must be quick or it becomes a spinout/crash."
                            value={tuningParams.close_call_max_off_track}
                            onChange={v => updateTuning('close_call_max_off_track', v || 3)}
                            step={0.5} min={0.5} max={15}
                          />
                        </div>
                      </div>
                    </div>
                  ) : (
                    /* ── Events list ── */
                    <div className="flex-1 overflow-y-auto">
                      {/* Filter chips */}
                      {eventSummary && eventSummary.total_events > 0 && (
                        <div className="px-3 py-2 border-b border-border-subtle flex flex-wrap gap-1">
                          {eventSummary.by_type.map(({ event_type, count }) => {
                            const cfg = EVENT_CONFIG[event_type] || {}
                            const Icon = cfg.icon || BarChart3
                            const isActive = activeFilter === event_type
                            return (
                              <Tooltip
                                key={event_type}
                                content={`${cfg.label || event_type}: ${count} event${count !== 1 ? 's' : ''} — click to ${isActive ? 'show all' : 'filter'}`}
                                position="bottom"
                                delay={200}
                              >
                                <button
                                  onClick={() => handleFilterChange(event_type)}
                                  className={`flex items-center gap-1 px-1.5 py-0.5 text-xxs rounded
                                             transition-colors border
                                             ${isActive
                                               ? 'border-accent bg-accent/10 text-accent'
                                               : 'border-border text-text-tertiary hover:text-text-secondary'
                                             }`}
                                >
                                  <Icon size={9} className={cfg.color} />
                                  <span>{count}</span>
                                </button>
                              </Tooltip>
                            )
                          })}
                        </div>
                      )}

                      {/* Sortable table header */}
                      <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,auto)_1fr_auto_auto] border-b border-border bg-bg-secondary">
                        {[
                          { key: 'type',     label: 'Type' },
                          { key: 'driver',   label: 'Driver(s)' },
                          { key: 'time',     label: 'Time' },
                          { key: 'severity', label: 'Sev' },
                        ].map(({ key, label }) => (
                          <button key={key} onClick={() => cycleSort(key)}
                            className="flex items-center gap-0.5 px-2 py-1.5 text-xxs font-semibold
                                       text-text-secondary hover:text-text-primary hover:bg-bg-hover
                                       transition-colors text-left whitespace-nowrap">
                            {label}
                            {eventSort.col === key
                              ? eventSort.dir === 'asc'
                                ? <ChevronUp size={9} className="text-accent shrink-0 ml-0.5" />
                                : <ChevronDown size={9} className="text-accent shrink-0 ml-0.5" />
                              : null}
                          </button>
                        ))}
                      </div>

                      {/* Sorted event rows */}
                      {(() => {
                        const rawList = isAnalyzing ? discoveredEvents : events
                        const sorted = [...rawList].sort((a, b) => {
                          const dir = eventSort.dir === 'asc' ? 1 : -1
                          switch (eventSort.col) {
                            case 'type': {
                              const ta = (isAnalyzing ? a.type : a.event_type) || ''
                              const tb = (isAnalyzing ? b.type : b.event_type) || ''
                              return dir * ta.localeCompare(tb)
                            }
                            case 'driver': {
                              const da = (isAnalyzing ? a.driverNames?.[0] : a.driver_names?.[0]) || ''
                              const db = (isAnalyzing ? b.driverNames?.[0] : b.driver_names?.[0]) || ''
                              return dir * da.localeCompare(db)
                            }
                            case 'time': {
                              const ta = (isAnalyzing ? a.startTime : a.start_time_seconds) || 0
                              const tb = (isAnalyzing ? b.startTime : b.start_time_seconds) || 0
                              return dir * (ta - tb)
                            }
                            case 'severity':
                              return dir * ((a.severity || 0) - (b.severity || 0))
                            default: return 0
                          }
                        })
                        return sorted.map((ev) => {
                          const isDiscovered = isAnalyzing
                          const type = isDiscovered ? ev.type : ev.event_type
                          const cfg = EVENT_CONFIG[type] || {}
                          const Icon = cfg.icon || BarChart3
                          const startSec = isDiscovered ? ev.startTime : ev.start_time_seconds
                          const sev = ev.severity
                          const eventId = ev.id
                          const isExpanded = expandedEvent === `sidebar-${eventId}`
                          const driverNames = isDiscovered ? (ev.driverNames || []) : (ev.driver_names || [])
                          return (
                            <div key={`${isDiscovered ? 'd' : 'e'}-${eventId}`}
                                 className="border-b border-border-subtle/30 animate-slide-right">
                              <div
                                className="grid grid-cols-[minmax(0,auto)_1fr_auto_auto]
                                           hover:bg-bg-hover transition-colors cursor-pointer"
                                onClick={() => seekToEvent(ev)}
                              >
                                {/* Type */}
                                <div className="flex items-center gap-1.5 px-2 py-1.5 min-w-0">
                                  <Icon size={11} className={`${cfg.color || 'text-text-tertiary'} shrink-0`} />
                                  <span className="text-xxs text-text-primary truncate">{cfg.label || type}</span>
                                </div>
                                {/* Driver(s) */}
                                <div className="flex items-center px-2 py-1.5 min-w-0">
                                  <span className="text-xxs text-text-secondary truncate">
                                    {driverNames.length > 0 ? driverNames.join(', ') : '—'}
                                  </span>
                                </div>
                                {/* Time */}
                                <div className="flex items-center px-2 py-1.5">
                                  <span className="text-xxs text-text-disabled font-mono whitespace-nowrap">{formatTime(startSec)}</span>
                                </div>
                                {/* Severity + expand */}
                                <div className="flex items-center gap-0.5 px-2 py-1.5">
                                  <span className={`w-4 h-4 rounded-full flex items-center justify-center text-xxs font-bold ${severityColor(sev)}`}>
                                    {sev}
                                  </span>
                                  {!isDiscovered && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setExpandedEvent(prev => prev === `sidebar-${eventId}` ? null : `sidebar-${eventId}`)
                                      }}
                                      className="w-4 h-4 flex items-center justify-center rounded hover:bg-surface-active
                                                 text-text-disabled hover:text-text-secondary transition-colors shrink-0"
                                    >
                                      <ChevronDown size={10}
                                        className={`transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`} />
                                    </button>
                                  )}
                                </div>
                              </div>
                              {isExpanded && !isDiscovered && (
                                <div className="px-3 pt-2 pb-2 bg-bg-secondary/50 border-t border-border-subtle animate-fade-in">
                                  <EventDetail event={ev} />
                                </div>
                              )}
                            </div>
                          )
                        })
                      })()}

                      {(isAnalyzing ? discoveredEvents : events).length === 0 && (
                        <div className="flex items-center justify-center py-8 text-text-disabled text-xs">
                          {isAnalyzing ? 'Waiting for events...' : 'No events detected'}
                        </div>
                      )}
                      <div ref={eventsEndRef} />
                    </div>
                  )}
                </div>
              ),
            },
            {
              id: 'files',
              label: 'Files',
              icon: Folder,
              content: <ProjectFileBrowser projectId={activeProject.id} />,
            },
            {
              id: 'story',
              label: 'Race Story',
              icon: BookOpen,
              content: (
                <div className="p-3 overflow-y-auto h-full">
                  <RaceStory projectId={activeProject.id} />
                </div>
              ),
            },
          ]}
        />

        {/* ── Center + right column ────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 bg-bg-primary overflow-hidden">
          {/* Row: TV card + cameras/drivers cards (same height) */}
          <div className="flex-1 min-h-0 flex gap-3 p-3">
            {/* TV card */}
            <div className="flex-1 flex items-center justify-center min-h-0 min-w-0">
              <div className="relative rounded-xl overflow-hidden border-2 border-border bg-black shadow-lg"
                   style={{ aspectRatio: '16/9', width: '100%', maxHeight: '100%', cursor: isConnected && !isAnalyzing ? 'pointer' : 'default' }}
                 onClick={isConnected && !isAnalyzing ? handlePlayPause : undefined}
                 title={isAnalyzing ? 'Playback disabled during analysis' : isConnected ? (isPlaying ? 'Click to pause' : 'Click to play') : undefined}>
              {isConnected ? (
                <>
                  {/* Stream: HLS, H.264 (MSE), or MJPEG depending on format setting */}
                  {streamFormat === 'hls' ? (
                    <HlsStreamPlayer
                      key={streamKey}
                      src={activeStreamUrl}
                      className="w-full h-full object-cover"
                      onLoad={() => setStreamLoaded(true)}
                      onError={(err) => setStreamError(err?.message || 'HLS stream error')}
                    />
                  ) : streamFormat === 'h264' ? (
                    <H264StreamPlayer
                      key={streamKey}
                      src={activeStreamUrl}
                      className="w-full h-full object-cover"
                      onLoad={() => setStreamLoaded(true)}
                      onError={(err) => setStreamError(err?.message || 'H.264 stream error')}
                    />
                  ) : (
                    <img
                      key={streamKey}
                      src={streamUrl}
                      alt="iRacing replay"
                      className="w-full h-full object-cover"
                      onError={() => setStreamError('MJPEG stream failed to load')}
                      onLoad={(e) => { e.target.style.opacity = '1'; setStreamLoaded(true) }}
                    />
                  )}
                  {/* Error overlay */}
                  {streamError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center
                                    bg-black/60 backdrop-blur-sm gap-3">
                      <AlertCircle size={32} className="text-danger" />
                      <span className="text-xs text-white/80 font-medium">Stream Disconnected</span>
                      <span className="text-xxs text-white/50 max-w-[200px] text-center">{streamError}</span>
                      <button
                        onClick={() => setStreamKey(k => k + 1)}
                        className="mt-1 px-3 py-1 rounded-md text-xxs bg-accent/20 text-accent
                                   hover:bg-accent/30 border border-accent/30 transition-colors"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  {/* Loading spinner — shown until the first frame arrives */}
                  {!streamLoaded && !streamError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center
                                    bg-black/60 backdrop-blur-sm gap-3">
                      <Loader2 size={32} className="text-accent animate-spin" />
                      <span className="text-xs text-white/60">Connecting to stream…</span>
                    </div>
                  )}
                  {/* Live badge */}
                  {isAnalyzing && (
                    <div className="absolute top-3 left-3 flex items-center gap-1.5 px-2 py-1
                                    bg-black/70 backdrop-blur-sm rounded-md text-xxs text-white/90">
                      <span className="w-1.5 h-1.5 rounded-full bg-danger animate-pulse" />
                      LIVE
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-2">
                  <WifiOff size={32} className="text-text-disabled" />
                  <span className="text-xs text-text-disabled font-medium">iRacing Not Running</span>
                  <span className="text-xxs text-text-disabled text-center max-w-[220px]">
                    Launch iRacing and load a replay to see the preview stream
                  </span>
                </div>
              )}

              {/* Stream hidden overlay */}
              {!streamVisible && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-bg-secondary z-30 gap-3 pointer-events-none">
                  <EyeOff size={28} className="text-text-disabled" />
                  <span className="text-xs text-text-disabled font-medium">Preview hidden</span>
                </div>
              )}

              {/* Top-right controls: stream visibility + restart + window picker + quality settings */}
              <div className="absolute top-3 right-3 flex items-center gap-1.5 z-40" onClick={e => e.stopPropagation()}>
                <button
                  onClick={() => setStreamVisible(v => !v)}
                  title={streamVisible ? 'Hide preview' : 'Show preview'}
                  className="flex items-center justify-center h-7 px-2 rounded-md text-xxs
                             bg-black/70 backdrop-blur-sm text-white/70 hover:text-white border border-white/10
                             transition-colors"
                >
                  {streamVisible ? <Eye size={11} /> : <EyeOff size={11} />}
                </button>
                <button
                  onClick={() => setStreamKey(k => k + 1)}
                  title="Restart preview stream"
                  className="flex items-center justify-center h-7 px-2 rounded-md text-xxs
                             bg-black/70 backdrop-blur-sm text-white/70 hover:text-white border border-white/10
                             transition-colors"
                >
                  <RefreshCw size={11} />
                </button>
                <button
                  onClick={() => { setShowQualitySettings(prev => !prev) }}
                  title="Stream quality settings"
                  className="flex items-center justify-center h-7 px-2 rounded-md text-xxs
                             bg-black/70 backdrop-blur-sm text-white/70 hover:text-white border border-white/10
                             transition-colors"
                >
                  <Settings size={11} />
                </button>
                <button
                  onClick={() => { setShowWindowPicker(prev => !prev); if (!showWindowPicker) fetchWindows() }}
                  title={captureTarget.mode === 'manual' ? 'Manual capture target' : 'Auto-detecting iRacing'}
                  className={`flex items-center gap-1 h-7 px-2 rounded-md text-xxs transition-colors
                    ${captureTarget.mode === 'manual'
                      ? 'bg-accent/20 text-accent border border-accent/30'
                      : 'bg-black/70 backdrop-blur-sm text-white/70 hover:text-white border border-white/10'
                    }`}
                >
                  <Monitor size={11} />
                  <span>{captureTarget.mode === 'manual' ? 'Manual' : 'Auto'}</span>
                </button>
              </div>

              {/* Quality settings dropdown */}
              {showQualitySettings && (
                <div className="absolute top-10 right-3 w-56 bg-bg-secondary border border-border
                                rounded-lg shadow-xl z-20 animate-fade-in p-3" onClick={e => e.stopPropagation()}>
                  <span className="text-xxs font-medium text-text-primary block mb-2">Stream Quality</span>

                  {/* Format selector */}
                  <div className="flex items-center justify-between text-xxs text-text-secondary mb-2">
                    <span className="font-medium">Format</span>
                    <div className="flex rounded overflow-hidden border border-border">
                      {['mjpeg', 'h264', 'hls'].map(fmt => (
                        <button
                          key={fmt}
                          onClick={() => {
                            if (fmt === streamFormat) return  // no-op if same format
                            // Always stop HLS segmenter when switching formats.
                            // The backend coordinator handles the rest, but this
                            // ensures prompt cleanup even if the new endpoint
                            // request is delayed.
                            fetch('/api/iracing/stream/hls/stop', { method: 'POST' }).catch(() => {})
                            setStreamFormat(fmt)
                            setStreamKey(k => k + 1)
                            setShowQualitySettings(false)
                          }}
                          className={`px-2 py-0.5 text-xxs transition-colors ${
                            streamFormat === fmt
                              ? 'bg-accent text-white'
                              : 'bg-surface text-text-secondary hover:bg-bg-hover'
                          }`}
                        >
                          {fmt === 'mjpeg' ? 'MJPEG' : fmt === 'h264' ? 'H.264' : 'HLS'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="border-t border-border mb-2" />

                  {/* FPS — shared across formats */}
                  <div className="space-y-2">
                    <label className="flex items-center justify-between text-xxs text-text-secondary">
                      <span>FPS</span>
                      <select value={streamFps} onChange={e => { setStreamFps(+e.target.value); setStreamKey(k => k + 1) }}
                        className="bg-surface border border-border rounded px-1.5 py-0.5 text-xxs text-text-primary">
                        <option value={5}>5</option>
                        <option value={10}>10</option>
                        <option value={15}>15</option>
                        <option value={20}>20</option>
                        <option value={30}>30</option>
                      </select>
                    </label>

                    {/* Format-specific settings — no overlap */}
                    {streamFormat === 'h264' ? (
                      <label className="flex items-center justify-between text-xxs text-text-secondary">
                        <span>Quality (CRF)</span>
                        <select value={h264Crf} onChange={e => { setH264Crf(+e.target.value); setStreamKey(k => k + 1) }}
                          className="bg-surface border border-border rounded px-1.5 py-0.5 text-xxs text-text-primary">
                          <option value={18}>Visually lossless (18)</option>
                          <option value={23}>High (23)</option>
                          <option value={28}>Medium (28)</option>
                          <option value={33}>Low (33)</option>
                        </select>
                      </label>
                    ) : streamFormat === 'hls' ? (
                      <label className="flex items-center justify-between text-xxs text-text-secondary">
                        <span>Quality (CRF)</span>
                        <select value={streamHlsCrf} onChange={e => { setStreamHlsCrf(+e.target.value); setStreamKey(k => k + 1) }}
                          className="bg-surface border border-border rounded px-1.5 py-0.5 text-xxs text-text-primary">
                          <option value={18}>Visually lossless (18)</option>
                          <option value={23}>High (23)</option>
                          <option value={28}>Medium (28)</option>
                          <option value={33}>Low (33)</option>
                        </select>
                      </label>
                    ) : (
                      <>
                        <label className="flex items-center justify-between text-xxs text-text-secondary">
                          <span>JPEG quality</span>
                          <select value={mjpegQuality} onChange={e => { setMjpegQuality(+e.target.value); setStreamKey(k => k + 1) }}
                            className="bg-surface border border-border rounded px-1.5 py-0.5 text-xxs text-text-primary">
                            <option value={40}>Low (40)</option>
                            <option value={55}>Medium (55)</option>
                            <option value={70}>High (70)</option>
                            <option value={85}>Ultra (85)</option>
                            <option value={95}>Max (95)</option>
                            <option value={100}>Lossless (100)</option>
                          </select>
                        </label>
                        <label className="flex items-center justify-between text-xxs text-text-secondary">
                          <span>Max width</span>
                          <select value={mjpegMaxWidth} onChange={e => { setMjpegMaxWidth(+e.target.value); setStreamKey(k => k + 1) }}
                            className="bg-surface border border-border rounded px-1.5 py-0.5 text-xxs text-text-primary">
                            <option value={640}>640px</option>
                            <option value={960}>960px</option>
                            <option value={1280}>1280px</option>
                            <option value={1920}>1920px</option>
                            <option value={2560}>2560px</option>
                            <option value={3840}>3840px (4K)</option>
                          </select>
                        </label>
                      </>
                    )}
                    {streamFormat === 'hls' && (
                      <p className="text-xxs text-text-disabled leading-relaxed pt-0.5">
                        HLS buffers ~1–3 s for smooth H.264 quality.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Window picker dropdown */}
              {showWindowPicker && (
                <div className="absolute top-10 right-3 w-72 max-h-52 overflow-y-auto
                                bg-bg-secondary border border-border rounded-lg shadow-xl z-20
                                animate-fade-in" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                    <span className="text-xxs font-medium text-text-primary">Capture Target</span>
                    <button
                      onClick={resetToAuto}
                      className={`text-xxs px-2 py-0.5 rounded transition-colors
                                  ${captureTarget.mode === 'auto'
                                    ? 'text-accent bg-accent/10'
                                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                                  }`}
                    >
                      Auto-detect
                    </button>
                  </div>
                  {loadingWindows ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 size={14} className="animate-spin text-text-disabled" />
                    </div>
                  ) : windowList.length === 0 ? (
                    <div className="px-3 py-3 text-xxs text-text-disabled text-center">
                      No visible windows found
                    </div>
                  ) : (
                    [...windowList].sort((a, b) => (b.is_iracing ? 1 : 0) - (a.is_iracing ? 1 : 0)).map((win, idx, sorted) => (
                      <div key={win.hwnd}>
                        {/* Separator between iRacing and other windows */}
                        {idx > 0 && !win.is_iracing && sorted[idx - 1]?.is_iracing && (
                          <div className="px-3 py-1 text-xxs text-text-disabled border-b border-border bg-bg-secondary/50">
                            Other Windows
                          </div>
                        )}
                        <button
                          onClick={() => selectWindow(win.hwnd)}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xxs
                                      hover:bg-bg-hover transition-colors border-b border-border-subtle/30 last:border-0
                                      ${captureTarget.hwnd === win.hwnd ? 'bg-accent/10 text-accent' : 'text-text-secondary'}`}
                        >
                          <Monitor size={11} className={win.is_iracing ? 'text-accent' : 'text-text-disabled'} />
                          <span className="truncate flex-1">{win.title}</span>
                          {win.is_iracing && (
                            <span className="shrink-0 text-accent text-xxs font-medium">iRacing</span>
                          )}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* ── Particle event cards overlay ──────────────────────── */}
              {feedEvents.length > 0 && (
                <div className="absolute bottom-14 right-3 flex flex-col-reverse gap-1.5 pointer-events-none"
                     style={{ maxHeight: 'calc(100% - 80px)' }}>
                  {feedEvents.slice(-5).reverse().map((ev, i) => {
                    const cfg = EVENT_CONFIG[ev.type] || {}
                    const Icon = cfg.icon || BarChart3
                    const names = ev.driverNames || []
                    const ageOpacity = [1, 0.9, 0.7, 0.5, 0.3][i] ?? 0.3
                    return (
                      <div
                        key={ev.id}
                        onClick={e => e.stopPropagation()}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg
                                   bg-black/80 backdrop-blur-md border border-white/15
                                   text-xs animate-slide-up pointer-events-auto shadow-elevated"
                        style={{ opacity: ageOpacity }}
                      >
                        <div className={`w-6 h-6 rounded-md flex items-center justify-center ${cfg.bg || 'bg-white/10'}`}>
                          <Icon size={13} className={cfg.color || 'text-white'} />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="text-white font-semibold text-xs leading-tight">
                            {cfg.label || ev.type}
                          </span>
                          {names.length > 0 && (
                            <span className="text-white/60 truncate text-xxs max-w-[120px]">
                              {names.join(' vs ')}
                            </span>
                          )}
                        </div>
                        <span className={`w-5 h-5 rounded-full flex items-center justify-center font-bold text-xxs
                                        ${severityColorCard(ev.severity)}`}>
                          {ev.severity}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

            {/* ── Options + Cameras + Drivers column ── */}
            {!isAnalyzing && (hasEvents || isConnected) && (
              <div className="flex flex-col gap-2 w-52 shrink-0">

                {/* Options card */}
                {hasEvents && (
                  <div className="rounded-xl border border-border bg-bg-secondary shadow-sm p-3 shrink-0">
                    <span className="text-xxs font-semibold text-text-primary block mb-2">Options</span>
                    <div className="flex flex-col gap-1.5">
                      <button
                        onClick={handleStart}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xxs font-semibold
                                   text-white bg-gradient-to-r from-gradient-from to-gradient-to
                                   rounded-lg hover:from-gradient-via hover:to-gradient-from
                                   transition-all duration-200 shadow-glow-sm justify-center"
                      >
                        <Play size={11} />
                        Re-analyze
                      </button>
                      <button
                        onClick={() => advanceStep(activeProject.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xxs font-semibold
                                   text-white bg-gradient-to-r from-gradient-from to-gradient-to
                                   rounded-lg hover:from-gradient-via hover:to-gradient-from
                                   transition-all duration-200 shadow-glow-sm justify-center"
                      >
                        Open Editor
                        <ChevronRight size={11} />
                      </button>
                      <button
                        onClick={handleClear}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xxs font-medium
                                   text-text-secondary bg-transparent border border-border
                                   rounded-lg hover:bg-danger/10 hover:text-danger hover:border-danger/30
                                   transition-colors justify-center"
                      >
                        <Trash2 size={11} />
                        Clear
                      </button>
                    </div>
                  </div>
                )}

                {/* Cameras card */}
                {isConnected && (
                  <div className="rounded-xl border border-border bg-bg-secondary shadow-sm overflow-hidden flex flex-col"
                       style={{ maxHeight: '45%' }}>
                    <div className="shrink-0 px-3 py-2 border-b border-border flex items-center gap-1.5 min-w-0">
                      <Eye size={11} className="text-text-secondary shrink-0" />
                      <span className="text-xxs font-medium text-text-primary shrink-0">Cameras</span>
                      {replayState?.cam_group_num != null && cameraGroups.find(c => c.group_num === replayState.cam_group_num) && (
                        <span className="text-xxs text-accent truncate ml-auto">
                          {cameraGroups.find(c => c.group_num === replayState.cam_group_num)?.group_name}
                        </span>
                      )}
                    </div>
                    <div className="flex-1 overflow-y-auto">
                      {cameraGroups.map(cam => (
                        <button key={cam.group_num}
                          onClick={() => handleSwitchCamera(cam.group_num)}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xxs
                                     hover:bg-bg-hover transition-colors border-b border-border-subtle/30
                                     ${replayState?.cam_group_num === cam.group_num
                                       ? 'bg-accent/10 text-accent font-medium'
                                       : 'text-text-secondary'}`}>
                          <Eye size={10} className={replayState?.cam_group_num === cam.group_num ? 'text-accent' : 'text-text-disabled'} />
                          <span className="truncate">{cam.group_name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Drivers card */}
                {isConnected && (
                  <div className="flex-1 rounded-xl border border-border bg-bg-secondary shadow-sm overflow-hidden flex flex-col min-h-0">
                    <div className="shrink-0 px-3 py-2 border-b border-border flex items-center gap-1.5 min-w-0">
                      <Users size={11} className="text-text-secondary shrink-0" />
                      <span className="text-xxs font-medium text-text-primary shrink-0">Drivers</span>
                      {replayState?.cam_car_idx != null && drivers.find(d => d.car_idx === replayState.cam_car_idx) && (
                        <span className="text-xxs text-accent truncate ml-auto">
                          {drivers.find(d => d.car_idx === replayState.cam_car_idx)?.user_name}
                        </span>
                      )}
                    </div>
                    <div className="flex-1 overflow-y-auto">
                      {drivers.filter(d => !d.is_spectator).map(d => (
                        <button key={d.car_idx}
                          onClick={() => handleSwitchDriver(d.car_idx)}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xxs
                                     hover:bg-bg-hover transition-colors border-b border-border-subtle/30
                                     ${replayState?.cam_car_idx === d.car_idx
                                       ? 'bg-accent/10 text-accent font-medium'
                                       : 'text-text-secondary'}`}>
                          <span className="font-mono shrink-0 w-5 text-right">#{d.car_number}</span>
                          <span className="truncate">{d.user_name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Playback controls card ────────────────────────────────── */}
          {isConnected && !isAnalyzing && (
            <div className="shrink-0 px-3 pb-3">
              <div className="rounded-xl border border-border bg-bg-secondary shadow-sm px-4 py-3">
                {/* Timeline scrubber — shown when race duration is known */}
                {raceDuration > 0 && replayState && (
                  <div className="mb-3">
                    <div
                      ref={scrubberRef}
                      className="relative h-5 group cursor-pointer select-none"
                      onMouseDown={(e) => {
                        const bar = e.currentTarget
                        const rect = bar.getBoundingClientRect()
                        const seekTo = (clientX) => {
                          const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
                          const timeMs = Math.round(pct * raceDuration * 1000)
                          apiPost('/iracing/replay/seek-time', { session_num: 0, session_time_ms: timeMs })
                        }
                        seekTo(e.clientX)
                        let lastSeek = Date.now()
                        const onMove = (mv) => {
                          if (Date.now() - lastSeek < 200) return
                          lastSeek = Date.now()
                          seekTo(mv.clientX)
                        }
                        const onUp = (up) => {
                          seekTo(up.clientX)
                          document.removeEventListener('mousemove', onMove)
                          document.removeEventListener('mouseup', onUp)
                        }
                        document.addEventListener('mousemove', onMove)
                        document.addEventListener('mouseup', onUp)
                      }}
                    >
                      {/* Track */}
                      <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-1.5 bg-surface rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-gradient-from via-gradient-via to-gradient-to rounded-full transition-all duration-200"
                          style={{ width: `${Math.min(100, (replayState.session_time / raceDuration) * 100)}%` }}
                        />
                      </div>
                      {/* Event markers */}
                      {(isAnalyzing ? discoveredEvents : events).map((ev, i) => {
                        const time = ev.startTime ?? ev.start_time_seconds ?? 0
                        if (time <= 0) return null
                        const pct = Math.min(100, (time / raceDuration) * 100)
                        return (
                          <div key={`marker-${i}`}
                               className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 rounded-full bg-white/30 pointer-events-none"
                               style={{ left: `${pct}%` }} />
                        )
                      })}
                      {/* Thumb */}
                      <div
                        className="absolute top-1/2 w-3 h-3 rounded-full bg-accent border-2 border-white shadow-md
                                   opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                        style={{ left: `${Math.min(100, (replayState.session_time / raceDuration) * 100)}%`,
                                 transform: 'translate(-50%, -50%)' }}
                      />
                    </div>
                    <div className="flex justify-between -mt-0.5">
                      <span className="text-xxs text-text-disabled font-mono">{formatTime(replayState.session_time)}</span>
                      <span className="text-xxs text-text-disabled font-mono">{formatTime(raceDuration)}</span>
                    </div>
                  </div>
                )}
                {/* Replay time + lap counter */}
                {replayState && (
                  <div className="flex items-center justify-center gap-2 mb-1.5">
                    <span className="text-xxs text-text-disabled font-mono">
                      {formatTime(replayState.session_time)}
                    </span>
                    {replayState.race_laps > 0 && (
                      <span className="text-xxs text-text-disabled flex items-center gap-1">
                        ·
                        <button onClick={() => handleReplaySearch('prev_lap')} title="Previous lap"
                          className="w-4 h-4 rounded flex items-center justify-center hover:bg-bg-hover
                                     text-text-disabled hover:text-text-primary transition-colors">
                          <Minus size={10} />
                        </button>
                        <span>Lap {replayState.race_laps}</span>
                        <button onClick={() => handleReplaySearch('next_lap')} title="Next lap"
                          className="w-4 h-4 rounded flex items-center justify-center hover:bg-bg-hover
                                     text-text-disabled hover:text-text-primary transition-colors">
                          <Plus size={10} />
                        </button>
                      </span>
                    )}
                  </div>
                )}
                {/* Transport controls */}
                <div className="flex items-center justify-center gap-1">
                  <button onClick={() => handleReplaySearch('prev_incident')} title="Previous incident"
                    className="p-1.5 rounded-md hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors">
                    <SkipBack size={14} />
                  </button>
                  <button onClick={() => handleReplaySearch('prev_lap')} title="Previous lap"
                    className="p-1.5 rounded-md hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors">
                    <Rewind size={14} />
                  </button>
                  <button onClick={() => handleSetSpeed(-4)} title="Rewind 4×"
                    className={`px-2 py-1 rounded-md text-xxs font-mono transition-colors
                      ${replaySpeed === -4 ? 'bg-accent/15 text-accent' : 'hover:bg-bg-hover text-text-secondary hover:text-text-primary'}`}>
                    ◀◀
                  </button>
                  <button onClick={handlePlayPause} title={isPlaying ? 'Pause' : 'Play'}
                    className="p-2 rounded-lg bg-gradient-to-r from-gradient-from to-gradient-to
                               text-white hover:from-gradient-via hover:to-gradient-from
                               transition-all duration-200 shadow-glow-sm mx-1">
                    {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                  {[1, 2, 4, 8, 16].map(spd => (
                    <button key={spd} onClick={() => handleSetSpeed(spd)} title={`${spd}× speed`}
                      className={`px-2 py-1 rounded-md text-xxs font-mono transition-colors
                        ${replaySpeed === spd ? 'bg-accent/15 text-accent font-bold' : 'hover:bg-bg-hover text-text-secondary hover:text-text-primary'}`}>
                      {spd}×
                    </button>
                  ))}
                  <button onClick={() => handleReplaySearch('next_lap')} title="Next lap"
                    className="p-1.5 rounded-md hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors">
                    <FastForward size={14} />
                  </button>
                  <button onClick={() => handleReplaySearch('next_incident')} title="Next incident"
                    className="p-1.5 rounded-md hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors">
                    <SkipForward size={14} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  )
})


/**
 * EventDetail — expanded view showing all captured data for an event.
 */
function EventDetail({ event }) {
  const driverNames = event.driver_names || []
  const involvedDrivers = event.involved_drivers || []
  const metadata = event.metadata || {}

  return (
    <div className="space-y-2 text-xxs">
      {/* Core fields */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-2">
        <div className="space-y-1.5">
          <DetailRow label="Type" value={EVENT_CONFIG[event.event_type]?.label || event.event_type} />
          <DetailRow label="Severity" value={`${event.severity} / 10`} />
          <DetailRow label="Time" value={`${formatTime(event.start_time_seconds)} — ${formatTime(event.end_time_seconds)}`} />
          <DetailRow label="Duration" value={`${((event.end_time_seconds - event.start_time_seconds) || 0).toFixed(1)}s`} />
          {event.lap_number > 0 && (
            <DetailRow label="Lap" value={event.lap_number} />
          )}
        </div>
        <div className="space-y-1.5">
          {event.detector && (
            <DetailRow label="Detected by" value={event.detector} />
          )}
          {involvedDrivers.length > 0 && (
            <DetailRow label="Car Indices" value={involvedDrivers.join(', ')} />
          )}
        </div>
      </div>

      {/* Drivers — full width, no truncation */}
      {driverNames.length > 0 && (
        <div className="pt-1.5 border-t border-border-subtle">
          <span className="text-text-disabled font-medium block mb-1">Drivers</span>
          <div className="flex flex-wrap gap-1">
            {driverNames.map((name, i) => (
              <span key={i} className="px-1.5 py-0.5 bg-surface rounded text-text-secondary">
                {name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Metadata — full width, no truncation */}
      {Object.keys(metadata).length > 0 && (
        <div className="pt-1.5 border-t border-border-subtle">
          <span className="text-text-disabled font-medium block mb-1">Metadata</span>
          <div className="space-y-1">
            {Object.entries(metadata).map(([key, value]) => (
              <div key={key} className="flex flex-col gap-0.5">
                <span className="text-text-disabled capitalize">{key.replace(/_/g, ' ')}</span>
                <span className="text-text-secondary break-all">
                  {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * TuneField — labelled numeric input with info-icon tooltip.
 */
function TuneField({ label, tooltip, value, onChange, step, min, max }) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-text-secondary font-medium flex items-center gap-1 shrink-0 text-xxs">
        {label}
        {tooltip && (
          <Tooltip content={tooltip} position="top">
            <Info size={10} className="text-text-disabled hover:text-accent cursor-help transition-colors" />
          </Tooltip>
        )}
      </span>
      <input type="number" step={step} min={min} max={max}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-20 px-2 py-0.5 rounded bg-surface border border-border text-text-primary text-xxs text-right"
      />
    </label>
  )
}

function DetailRow({ label, value }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="text-text-disabled capitalize shrink-0">{label}</span>
      <span className="text-text-secondary break-words">{value}</span>
    </div>
  )
}

/** Format seconds as M:SS */
function formatTime(seconds) {
  if (seconds === null || seconds === undefined || seconds < 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Severity badge color */
function severityColor(severity) {
  if (severity >= 8) return 'bg-danger/20 text-danger'
  if (severity >= 6) return 'bg-warning/20 text-warning'
  if (severity >= 4) return 'bg-accent/20 text-accent'
  return 'bg-surface-active text-text-tertiary'
}

/** Severity colors for overlay cards (on dark backgrounds) */
function severityColorCard(severity) {
  if (severity >= 8) return 'bg-danger text-white'
  if (severity >= 6) return 'bg-warning text-black'
  if (severity >= 4) return 'bg-accent text-white'
  return 'bg-white/20 text-white'
}
