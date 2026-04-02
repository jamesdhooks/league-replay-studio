import { useState, useEffect, useRef, useCallback } from 'react'
import { useAnalysis } from '../../context/AnalysisContext'
import { useProject } from '../../context/ProjectContext'
import { useIRacing } from '../../context/IRacingContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { apiPost, apiGet, apiDelete } from '../../services/api'
import {
  Play, Pause, Square, BarChart3, AlertTriangle, Swords, ArrowUpDown,
  Fuel, Zap, Crown, Flag, FlagTriangleRight, Loader2, CheckCircle2,
  XCircle, Terminal, ChevronRight, ChevronDown, Camera, Video, Monitor,
  SkipBack, SkipForward, Rewind, FastForward, List, Trash2, Settings,
  Eye, Users, Flame, RotateCcw, CircleDot, ShieldAlert, WifiOff, AlertCircle, Minus, Plus,
  Folder, SlidersHorizontal,
} from 'lucide-react'
import ProjectFileBrowser from '../projects/ProjectFileBrowser'
import ResizableSidebar from '../layout/ResizableSidebar'

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
export default function AnalysisPanel() {
  const {
    isAnalyzing, progress, events, eventSummary, error,
    analysisLog, discoveredEvents,
    startAnalysis, cancelAnalysis, clearAnalysis,
    fetchEvents, fetchEventSummary, fetchAnalysisStatus,
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

  // Camera follow toggle
  const [cameraFollow, setCameraFollow] = useLocalStorage('lrs:analysis:cameraFollow', false)
  const lastCameraEventRef = useRef(null)

  // Window picker state
  const [showWindowPicker, setShowWindowPicker] = useState(false)
  const [windowList, setWindowList] = useState([])
  const [captureTarget, setCaptureTarget] = useState({ mode: 'auto', hwnd: null })
  const [loadingWindows, setLoadingWindows] = useState(false)

  // Replay control state
  const [replaySpeed, setReplaySpeed] = useState(1)
  const [isPlaying, setIsPlaying] = useState(true)
  const [replayState, setReplayState] = useState(null)

  // Stream quality settings
  const [streamFps, setStreamFps] = useLocalStorage('lrs:analysis:streamFps', 15)
  const [streamQuality, setStreamQuality] = useLocalStorage('lrs:analysis:streamQuality', 85)
  const [streamMaxWidth, setStreamMaxWidth] = useLocalStorage('lrs:analysis:streamMaxWidth', 1280)
  const [streamFormat, setStreamFormat] = useLocalStorage('lrs:analysis:streamFormat', 'mjpeg')
  const [streamCrf, setStreamCrf] = useLocalStorage('lrs:analysis:streamCrf', 23)
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
    if (activeProject?.id) {
      fetchAnalysisStatus(activeProject.id)
      fetchEvents(activeProject.id)
      fetchEventSummary(activeProject.id)
    }
  }, [activeProject?.id, fetchAnalysisStatus, fetchEvents, fetchEventSummary])

  // Fetch race duration for timeline scrubber
  useEffect(() => {
    if (!activeProject?.id) return
    apiGet(`/projects/${activeProject.id}/analysis/race-duration`)
      .then(data => setRaceDuration(data?.duration || 0))
      .catch(() => {})
  }, [activeProject?.id, events])

  // Auto-scroll log to bottom
  useEffect(() => {
    if (sidebarTab === 'log' && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [analysisLog, sidebarTab])

  // Auto-scroll events sidebar
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
    const camGroup = cameraGroups.length > 0 ? cameraGroups[0].group_num : 0
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

  const streamUrl = `/api/iracing/stream?fps=${streamFps}&quality=${streamQuality}&max_width=${streamMaxWidth}&_k=${streamKey}`
  const h264Url   = `/api/iracing/stream/h264?fps=${streamFps}&crf=${streamCrf}&max_width=${streamMaxWidth}&_k=${streamKey}`
  const activeStreamUrl = streamFormat === 'h264' ? h264Url : streamUrl

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

      {/* ── Top control bar ───────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-border bg-bg-secondary">
        <div className="flex items-center gap-4 px-4 py-2.5">
          {/* Action buttons */}
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
              <>
                <button
                  onClick={handleStart}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold
                             text-white bg-gradient-to-r from-gradient-from to-gradient-to
                             rounded-lg hover:from-gradient-via hover:to-gradient-from
                             transition-all duration-200 shadow-glow-sm"
                >
                  <Play size={13} />
                  {hasEvents ? 'Re-analyze' : 'Analyze'}
                </button>
                {hasEvents && (
                  <>
                    <button
                      onClick={() => advanceStep(activeProject.id)}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold
                                 text-white bg-gradient-to-r from-gradient-from to-gradient-to
                                 rounded-lg hover:from-gradient-via hover:to-gradient-from
                                 transition-all duration-200 shadow-glow-sm"
                    >
                      Open Editor
                      <ChevronRight size={13} />
                    </button>
                    <button
                      onClick={handleClear}
                      title="Clear analysis data"
                      className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium
                                 text-text-secondary bg-transparent border border-border
                                 rounded-lg hover:bg-danger/10 hover:text-danger hover:border-danger/30
                                 transition-colors"
                    >
                      <Trash2 size={12} />
                      Clear
                    </button>
                  </>
                )}
              </>
            )}
            {!isAnalyzing && progress?.percent === 100 && (
              <div className="flex items-center gap-1 text-success">
                <CheckCircle2 size={13} />
                <span className="text-xxs font-medium">Complete</span>
              </div>
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

          {/* Right controls */}
          <div className="ml-auto flex items-center gap-3 shrink-0">
            {!isAnalyzing && (
              <button
                onClick={() => setShowTuning(prev => !prev)}
                title="Detection tuning parameters"
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-xxs transition-colors border
                  ${showTuning
                    ? 'bg-accent/15 border-accent/30 text-accent'
                    : 'bg-transparent border-border text-text-disabled hover:text-text-secondary'
                  }`}
              >
                <SlidersHorizontal size={11} />
                <span>Tune</span>
              </button>
            )}
            {isConnected && (
              <button
                onClick={() => setCameraFollow(prev => !prev)}
                title={cameraFollow ? 'Camera follow ON' : 'Camera follow OFF'}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-xxs transition-colors border
                  ${cameraFollow
                    ? 'bg-accent/15 border-accent/30 text-accent'
                    : 'bg-transparent border-border text-text-disabled hover:text-text-secondary'
                  }`}
              >
                <Camera size={11} />
                <span>Follow</span>
              </button>
            )}
            {(eventSummary?.total_events > 0 || discoveredEvents.length > 0) && (
              <span className="text-xxs text-text-disabled font-mono">
                {eventSummary?.total_events || discoveredEvents.length} events
              </span>
            )}
          </div>
        </div>

        {/* ── Detection Tuning Panel ────────────────────────────────── */}
        {showTuning && (
          <div className="border-t border-border bg-bg-secondary px-4 py-3">
            <div className="grid grid-cols-3 gap-x-6 gap-y-2 text-xxs">
              {/* Battle */}
              <label className="flex flex-col gap-0.5">
                <span className="text-text-secondary font-medium">Battle gap (s)</span>
                <input type="number" step="0.1" min="0.1" max="5"
                  value={tuningParams.battle_gap_threshold}
                  onChange={e => updateTuning('battle_gap_threshold', parseFloat(e.target.value) || 0.5)}
                  className="w-full px-2 py-1 rounded bg-surface border border-border text-text-primary text-xxs"
                />
              </label>
              {/* Crash */}
              <label className="flex flex-col gap-0.5">
                <span className="text-text-secondary font-medium">Crash min time loss (s)</span>
                <input type="number" step="1" min="1" max="60"
                  value={tuningParams.crash_min_time_loss}
                  onChange={e => updateTuning('crash_min_time_loss', parseFloat(e.target.value) || 10)}
                  className="w-full px-2 py-1 rounded bg-surface border border-border text-text-primary text-xxs"
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-text-secondary font-medium">Crash min off-track (s)</span>
                <input type="number" step="0.5" min="0.5" max="30"
                  value={tuningParams.crash_min_off_track_duration}
                  onChange={e => updateTuning('crash_min_off_track_duration', parseFloat(e.target.value) || 3)}
                  className="w-full px-2 py-1 rounded bg-surface border border-border text-text-primary text-xxs"
                />
              </label>
              {/* Spinout */}
              <label className="flex flex-col gap-0.5">
                <span className="text-text-secondary font-medium">Spinout min time loss (s)</span>
                <input type="number" step="0.5" min="0.5" max="30"
                  value={tuningParams.spinout_min_time_loss}
                  onChange={e => updateTuning('spinout_min_time_loss', parseFloat(e.target.value) || 2)}
                  className="w-full px-2 py-1 rounded bg-surface border border-border text-text-primary text-xxs"
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-text-secondary font-medium">Spinout max time loss (s)</span>
                <input type="number" step="1" min="1" max="60"
                  value={tuningParams.spinout_max_time_loss}
                  onChange={e => updateTuning('spinout_max_time_loss', parseFloat(e.target.value) || 10)}
                  className="w-full px-2 py-1 rounded bg-surface border border-border text-text-primary text-xxs"
                />
              </label>
              {/* Contact */}
              <label className="flex flex-col gap-0.5">
                <span className="text-text-secondary font-medium">Contact time window (s)</span>
                <input type="number" step="0.5" min="0.5" max="10"
                  value={tuningParams.contact_time_window}
                  onChange={e => updateTuning('contact_time_window', parseFloat(e.target.value) || 2)}
                  className="w-full px-2 py-1 rounded bg-surface border border-border text-text-primary text-xxs"
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-text-secondary font-medium">Contact proximity</span>
                <input type="number" step="0.01" min="0.01" max="1"
                  value={tuningParams.contact_proximity}
                  onChange={e => updateTuning('contact_proximity', parseFloat(e.target.value) || 0.05)}
                  className="w-full px-2 py-1 rounded bg-surface border border-border text-text-primary text-xxs"
                />
              </label>
              {/* Close call */}
              <label className="flex flex-col gap-0.5">
                <span className="text-text-secondary font-medium">Close call proximity</span>
                <input type="number" step="0.005" min="0.005" max="0.5"
                  value={tuningParams.close_call_proximity}
                  onChange={e => updateTuning('close_call_proximity', parseFloat(e.target.value) || 0.02)}
                  className="w-full px-2 py-1 rounded bg-surface border border-border text-text-primary text-xxs"
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-text-secondary font-medium">Close call max off-track (s)</span>
                <input type="number" step="0.5" min="0.5" max="15"
                  value={tuningParams.close_call_max_off_track}
                  onChange={e => updateTuning('close_call_max_off_track', parseFloat(e.target.value) || 3)}
                  className="w-full px-2 py-1 rounded bg-surface border border-border text-text-primary text-xxs"
                />
              </label>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={handleRedetect}
                disabled={isRedetecting}
                className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold
                           text-white bg-gradient-to-r from-gradient-from to-gradient-to
                           rounded-lg hover:from-gradient-via hover:to-gradient-from
                           transition-all duration-200 shadow-glow-sm disabled:opacity-50"
              >
                {isRedetecting ? <Loader2 size={13} className="animate-spin" /> : <SlidersHorizontal size={13} />}
                {isRedetecting ? 'Re-detecting...' : 'Re-detect Events'}
              </button>
              <span className="text-xxs text-text-disabled">
                Re-runs detection on existing telemetry with these parameters
              </span>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-1.5 px-4 py-1.5 bg-danger/10 border-t border-danger/20">
            <XCircle size={12} className="text-danger shrink-0" />
            <span className="text-xxs text-danger">{error}</span>
          </div>
        )}
      </div>

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
                  {analysisLog.map(entry => (
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
                  <div ref={logEndRef} />
                </div>
              ),
            },
            {
              id: 'events',
              label: 'Events',
              icon: List,
              count: discoveredEvents.length || eventSummary?.total_events || 0,
              content: (
                <div>
                  {/* Filter chips */}
                  {eventSummary && eventSummary.total_events > 0 && (
                    <div className="px-3 py-2 border-b border-border-subtle flex flex-wrap gap-1">
                      {eventSummary.by_type.map(({ event_type, count }) => {
                        const cfg = EVENT_CONFIG[event_type] || {}
                        const Icon = cfg.icon || BarChart3
                        const isActive = activeFilter === event_type
                        return (
                          <button
                            key={event_type}
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
                        )
                      })}
                    </div>
                  )}

                  {/* Event list — compact rows */}
                  {(isAnalyzing ? discoveredEvents : events).map((ev) => {
                    const isDiscovered = isAnalyzing
                    const type = isDiscovered ? ev.type : ev.event_type
                    const cfg = EVENT_CONFIG[type] || {}
                    const Icon = cfg.icon || BarChart3
                    const startSec = isDiscovered ? ev.startTime : ev.start_time_seconds
                    const sev = ev.severity
                    const eventId = isDiscovered ? ev.id : ev.id
                    const isExpanded = expandedEvent === `sidebar-${eventId}`

                    return (
                      <div key={`${isDiscovered ? 'd' : 'e'}-${eventId}`}
                           className="border-b border-border-subtle/30 animate-slide-right">
                        <div className="flex items-center hover:bg-bg-hover transition-colors">
                          <button
                            onClick={() => seekToEvent(ev)}
                            title="Seek replay to this event"
                            className="flex-1 flex items-center gap-1.5 px-3 py-1.5 text-left min-w-0"
                          >
                            <Icon size={12} className={cfg.color || 'text-text-tertiary'} />
                            <span className="text-xs font-medium text-text-primary truncate">
                              {cfg.label || type}
                            </span>
                            <span className="text-xxs text-text-disabled font-mono ml-auto">
                              {formatTime(startSec)}
                            </span>
                            <span className={`shrink-0 w-4 h-4 rounded-full flex items-center justify-center
                                            text-xxs font-bold ${severityColor(sev)}`}>
                              {sev}
                            </span>
                          </button>
                          {!isDiscovered && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                setExpandedEvent(prev => prev === `sidebar-${eventId}` ? null : `sidebar-${eventId}`)
                              }}
                              title={isExpanded ? 'Collapse details' : 'Expand details'}
                              className="shrink-0 w-6 h-6 flex items-center justify-center mr-1
                                         rounded-md hover:bg-surface-active text-text-disabled
                                         hover:text-text-secondary transition-colors"
                            >
                              <ChevronDown size={12}
                                className={`transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`} />
                            </button>
                          )}
                        </div>
                        {isExpanded && !isDiscovered && (
                          <div className="px-3 pt-2 pb-2 bg-bg-secondary/50 border-t border-border-subtle animate-fade-in">
                            <EventDetail event={ev} />
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {(isAnalyzing ? discoveredEvents : events).length === 0 && (
                    <div className="flex items-center justify-center py-8 text-text-disabled text-xs">
                      {isAnalyzing ? 'Waiting for events...' : 'No events detected'}
                    </div>
                  )}
                  <div ref={eventsEndRef} />
                </div>
              ),
            },
            {
              id: 'files',
              label: 'Files',
              icon: Folder,
              content: <ProjectFileBrowser projectId={activeProject.id} />,
            },
          ]}
        />

        {/* ── TV Preview area + playback controls ─────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 bg-bg-primary">
          {/* TV container — fills available space, centers the 16:9 stream */}
          <div className="flex-1 flex items-center justify-center p-4 min-h-0 relative">
            <div className="relative h-full rounded-xl overflow-hidden border-2 border-border bg-black shadow-lg cursor-pointer"
                 style={{ aspectRatio: '16/9', maxWidth: '100%' }}
                 onClick={handlePlayPause}
                 title={isPlaying ? 'Click to pause' : 'Click to play'}>
              {isConnected ? (
                <>
                  {/* Stream: H.264 (MSE) or MJPEG depending on format setting */}
                  {streamFormat === 'h264' ? (
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
                  {/* Progress overlay */}
                  {isAnalyzing && progress && (
                    <div className="absolute bottom-3 left-3 right-3 flex items-center gap-2
                                    bg-black/70 backdrop-blur-sm rounded-md px-2.5 py-1.5">
                      <span className="text-xxs text-white/80 font-mono shrink-0">
                        {Math.round(progress.percent || 0)}%
                      </span>
                      <div className="flex-1 h-1 bg-white/20 rounded-full overflow-hidden">
                        <div className="h-full bg-accent rounded-full transition-all duration-300"
                             style={{ width: `${progress.percent || 0}%` }} />
                      </div>
                      {progress.currentLap && (
                        <span className="text-xxs text-white/60 shrink-0">L{progress.currentLap}</span>
                      )}
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

              {/* Top-right controls: window picker + quality settings */}
              <div className="absolute top-3 right-3 flex items-center gap-1.5 z-10" onClick={e => e.stopPropagation()}>
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
                  <div className="space-y-2">
                    <label className="flex items-center justify-between text-xxs text-text-secondary">
                      <span>Format</span>
                      <div className="flex rounded overflow-hidden border border-border">
                        {['mjpeg', 'h264'].map(fmt => (
                          <button
                            key={fmt}
                            onClick={() => { setStreamFormat(fmt); setStreamKey(k => k + 1) }}
                            className={`px-2 py-0.5 text-xxs transition-colors ${
                              streamFormat === fmt
                                ? 'bg-accent text-white'
                                : 'bg-surface text-text-secondary hover:bg-bg-hover'
                            }`}
                          >
                            {fmt === 'mjpeg' ? 'MJPEG' : 'H.264'}
                          </button>
                        ))}
                      </div>
                    </label>
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
                    {streamFormat === 'h264' ? (
                      <label className="flex items-center justify-between text-xxs text-text-secondary">
                        <span>Quality (CRF)</span>
                        <select value={streamCrf} onChange={e => { setStreamCrf(+e.target.value); setStreamKey(k => k + 1) }}
                          className="bg-surface border border-border rounded px-1.5 py-0.5 text-xxs text-text-primary">
                          <option value={18}>Visually lossless (18)</option>
                          <option value={23}>High (23)</option>
                          <option value={28}>Medium (28)</option>
                          <option value={33}>Low (33)</option>
                        </select>
                      </label>
                    ) : (
                      <label className="flex items-center justify-between text-xxs text-text-secondary">
                        <span>Quality</span>
                        <select value={streamQuality} onChange={e => { setStreamQuality(+e.target.value); setStreamKey(k => k + 1) }}
                          className="bg-surface border border-border rounded px-1.5 py-0.5 text-xxs text-text-primary">
                          <option value={40}>Low (40)</option>
                          <option value={55}>Medium (55)</option>
                          <option value={70}>High (70)</option>
                          <option value={85}>Ultra (85)</option>
                          <option value={95}>Max (95)</option>
                          <option value={100}>Lossless (100)</option>
                        </select>
                      </label>
                    )}
                    <label className="flex items-center justify-between text-xxs text-text-secondary">
                      <span>Resolution</span>
                      <select value={streamMaxWidth} onChange={e => { setStreamMaxWidth(+e.target.value); setStreamKey(k => k + 1) }}
                        className="bg-surface border border-border rounded px-1.5 py-0.5 text-xxs text-text-primary">
                        <option value={640}>640p</option>
                        <option value={960}>960p</option>
                        <option value={1280}>1280p</option>
                        <option value={1920}>1920p</option>
                        <option value={2560}>1440p</option>
                        <option value={3840}>Native (4K)</option>
                      </select>
                    </label>
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
              {discoveredEvents.length > 0 && (
                <div className="absolute bottom-14 right-3 flex flex-col-reverse gap-1.5 pointer-events-none"
                     style={{ maxHeight: 'calc(100% - 80px)' }}>
                  {discoveredEvents.slice(-5).reverse().map((ev, i) => {
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

          {/* ── Timeline scrubber ─────────────────────────────────────── */}
          {isConnected && raceDuration > 0 && replayState && (
            <div className="shrink-0 px-4 pt-2 bg-bg-primary">
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
                  const onMove = (ev) => {
                    if (Date.now() - lastSeek < 200) return
                    lastSeek = Date.now()
                    seekTo(ev.clientX)
                  }
                  const onUp = (ev) => {
                    seekTo(ev.clientX)
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
                    style={{ width: `${raceDuration > 0 ? Math.min(100, (replayState.session_time / raceDuration) * 100) : 0}%` }}
                  />
                </div>
                {/* Event markers */}
                {(isAnalyzing ? discoveredEvents : events).map((ev, i) => {
                  const time = ev.startTime ?? ev.start_time_seconds ?? 0
                  if (time <= 0 || raceDuration <= 0) return null
                  const pct = Math.min(100, (time / raceDuration) * 100)
                  return (
                    <div
                      key={`marker-${i}`}
                      className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 rounded-full bg-white/30 pointer-events-none"
                      style={{ left: `${pct}%` }}
                    />
                  )
                })}
                {/* Thumb */}
                <div
                  className="absolute top-1/2 w-3 h-3 rounded-full bg-accent border-2 border-white shadow-md
                             opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                  style={{
                    left: `${raceDuration > 0 ? Math.min(100, (replayState.session_time / raceDuration) * 100) : 0}%`,
                    transform: 'translate(-50%, -50%)',
                  }}
                />
              </div>
              <div className="flex justify-between -mt-0.5 pb-0.5">
                <span className="text-xxs text-text-disabled font-mono">{formatTime(replayState.session_time)}</span>
                <span className="text-xxs text-text-disabled font-mono">{formatTime(raceDuration)}</span>
              </div>
            </div>
          )}

          {/* ── Full playback controls beneath the TV ─────────────────── */}
          {isConnected && (
            <div className="shrink-0 border-t border-border bg-bg-secondary px-4 py-2">
              {/* Replay time display */}
              {replayState && (
                <div className="flex items-center justify-center gap-2 mb-1.5">
                  <span className="text-xxs text-text-disabled font-mono">
                    {formatTime(replayState.session_time)}
                  </span>
                  {replayState.race_laps > 0 && (
                    <span className="text-xxs text-text-disabled flex items-center gap-1">
                      ·
                      <button
                        onClick={() => handleReplaySearch('prev_lap')}
                        title="Previous lap"
                        className="w-4 h-4 rounded flex items-center justify-center hover:bg-bg-hover
                                   text-text-disabled hover:text-text-primary transition-colors"
                      >
                        <Minus size={10} />
                      </button>
                      <span>Lap {replayState.race_laps}</span>
                      <button
                        onClick={() => handleReplaySearch('next_lap')}
                        title="Next lap"
                        className="w-4 h-4 rounded flex items-center justify-center hover:bg-bg-hover
                                   text-text-disabled hover:text-text-primary transition-colors"
                      >
                        <Plus size={10} />
                      </button>
                    </span>
                  )}
                </div>
              )}

              {/* Transport controls */}
              <div className="flex items-center justify-center gap-1">
                {/* Prev incident */}
                <button onClick={() => handleReplaySearch('prev_incident')} title="Previous incident"
                  className="p-1.5 rounded-md hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors">
                  <SkipBack size={14} />
                </button>
                {/* Prev lap */}
                <button onClick={() => handleReplaySearch('prev_lap')} title="Previous lap"
                  className="p-1.5 rounded-md hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors">
                  <Rewind size={14} />
                </button>
                {/* Rewind: -4x */}
                <button onClick={() => handleSetSpeed(-4)} title="Rewind 4×"
                  className={`px-2 py-1 rounded-md text-xxs font-mono transition-colors
                    ${replaySpeed === -4 ? 'bg-accent/15 text-accent' : 'hover:bg-bg-hover text-text-secondary hover:text-text-primary'}`}>
                  ◀◀
                </button>
                {/* Play/Pause toggle */}
                <button onClick={handlePlayPause} title={isPlaying ? 'Pause' : 'Play'}
                  className="p-2 rounded-lg bg-gradient-to-r from-gradient-from to-gradient-to
                             text-white hover:from-gradient-via hover:to-gradient-from
                             transition-all duration-200 shadow-glow-sm mx-1">
                  {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                </button>
                {/* Speed buttons */}
                {[1, 2, 4, 8, 16].map(spd => (
                  <button key={spd} onClick={() => handleSetSpeed(spd)} title={`${spd}× speed`}
                    className={`px-2 py-1 rounded-md text-xxs font-mono transition-colors
                      ${replaySpeed === spd ? 'bg-accent/15 text-accent font-bold' : 'hover:bg-bg-hover text-text-secondary hover:text-text-primary'}`}>
                    {spd}×
                  </button>
                ))}
                {/* Next lap */}
                <button onClick={() => handleReplaySearch('next_lap')} title="Next lap"
                  className="p-1.5 rounded-md hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors">
                  <FastForward size={14} />
                </button>
                {/* Next incident */}
                <button onClick={() => handleReplaySearch('next_incident')} title="Next incident"
                  className="p-1.5 rounded-md hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors">
                  <SkipForward size={14} />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Right sidebar (Cameras + Drivers) ───────────────────────── */}
        {isConnected && (
          <div className="w-48 flex flex-col overflow-hidden border-l border-border bg-bg-primary/50 shrink-0">
            {/* Cameras section */}
            <div className="flex flex-col overflow-hidden" style={{ maxHeight: '45%' }}>
              <div className="shrink-0 px-3 py-2 border-b border-border bg-bg-secondary/50">
                <span className="text-xxs font-medium text-text-primary flex items-center gap-1.5">
                  <Eye size={11} />
                  Cameras
                </span>
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
            {/* Drivers section */}
            <div className="flex-1 flex flex-col overflow-hidden border-t border-border">
              <div className="shrink-0 px-3 py-2 border-b border-border bg-bg-secondary/50">
                <span className="text-xxs font-medium text-text-primary flex items-center gap-1.5">
                  <Users size={11} />
                  Drivers
                </span>
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
          </div>
        )}

      </div>
    </div>
  )
}


/**
 * EventDetail — expanded view showing all captured data for an event.
 */
function EventDetail({ event }) {
  const driverNames = event.driver_names || []
  const involvedDrivers = event.involved_drivers || []
  const metadata = event.metadata || {}

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xxs">
      {/* Left column */}
      <div className="space-y-1.5">
        <DetailRow label="Type" value={EVENT_CONFIG[event.event_type]?.label || event.event_type} />
        <DetailRow label="Severity" value={`${event.severity} / 10`} />
        <DetailRow label="Time" value={`${formatTime(event.start_time_seconds)} — ${formatTime(event.end_time_seconds)}`} />
        <DetailRow label="Duration" value={`${((event.end_time_seconds - event.start_time_seconds) || 0).toFixed(1)}s`} />
        {event.lap_number > 0 && (
          <DetailRow label="Lap" value={event.lap_number} />
        )}
      </div>

      {/* Right column */}
      <div className="space-y-1.5">
        {driverNames.length > 0 && (
          <DetailRow label="Drivers" value={driverNames.join(', ')} />
        )}
        {involvedDrivers.length > 0 && (
          <DetailRow label="Car Indices" value={involvedDrivers.join(', ')} />
        )}
        {event.detector && (
          <DetailRow label="Detector" value={event.detector} />
        )}
      </div>

      {/* Metadata — full width */}
      {Object.keys(metadata).length > 0 && (
        <div className="col-span-2 mt-1 pt-1.5 border-t border-border-subtle">
          <span className="text-text-disabled font-medium block mb-1">Metadata</span>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            {Object.entries(metadata).map(([key, value]) => (
              <DetailRow
                key={key}
                label={key.replace(/_/g, ' ')}
                value={typeof value === 'object' ? JSON.stringify(value) : String(value)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function DetailRow({ label, value }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="text-text-disabled capitalize shrink-0">{label}</span>
      <span className="text-text-secondary truncate">{value}</span>
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
