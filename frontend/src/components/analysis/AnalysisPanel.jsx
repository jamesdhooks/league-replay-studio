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
  Eye, Users,
} from 'lucide-react'

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
}

/**
 * AnalysisPanel — Full layout with:
 *  - Fixed top bar: controls + progress + clear analysis
 *  - Full-height middle: wide tabbed sidebar (Log/Events) + 16:9 MJPEG TV + playback controls
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

  // Sidebar tab: 'log' | 'events'
  const [sidebarTab, setSidebarTab] = useLocalStorage('lrs:analysis:sidebarTab', 'log')
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
  const [streamQuality, setStreamQuality] = useLocalStorage('lrs:analysis:streamQuality', 70)
  const [streamMaxWidth, setStreamMaxWidth] = useLocalStorage('lrs:analysis:streamMaxWidth', 1280)
  const [showQualitySettings, setShowQualitySettings] = useState(false)
  // Stream key — changes to force <img> reload when quality settings change
  const [streamKey, setStreamKey] = useState(0)

  // Drivers list for camera switching
  const [drivers, setDrivers] = useState([])
  const [showDriverPicker, setShowDriverPicker] = useState(false)

  // Camera groups
  const [cameraGroups, setCameraGroups] = useState([])
  const [showCameraPicker, setShowCameraPicker] = useState(false)

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
    try { await startAnalysis(activeProject.id) } catch {}
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
      setShowDriverPicker(false)
    } catch {}
  }

  const handleSwitchCamera = async (groupNum) => {
    const carIdx = replayState?.cam_car_idx ?? 0
    try {
      await apiPost('/iracing/replay/camera', { car_idx: carIdx, group_num: groupNum })
      setShowCameraPicker(false)
    } catch {}
  }

  const streamUrl = `/api/iracing/stream?fps=${streamFps}&quality=${streamQuality}&max_width=${streamMaxWidth}&_k=${streamKey}`

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

        {error && (
          <div className="flex items-center gap-1.5 px-4 py-1.5 bg-danger/10 border-t border-danger/20">
            <XCircle size={12} className="text-danger shrink-0" />
            <span className="text-xxs text-danger">{error}</span>
          </div>
        )}
      </div>

      {/* ── Main area: sidebar + TV + controls (fills remaining height) ── */}
      <div className="flex-1 flex overflow-hidden min-h-0">

        {/* ── Tabbed sidebar (Log / Events) — wider ───────────────────── */}
        <div className="w-96 flex flex-col overflow-hidden border-r border-border bg-bg-primary/50 shrink-0">
          {/* Tab bar */}
          <div className="flex shrink-0 border-b border-border">
            <button
              onClick={() => setSidebarTab('log')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium
                         transition-colors border-b-2
                         ${sidebarTab === 'log'
                           ? 'border-accent text-accent bg-accent/5'
                           : 'border-transparent text-text-tertiary hover:text-text-secondary'
                         }`}
            >
              <Terminal size={13} />
              Log ({analysisLog.length})
            </button>
            <button
              onClick={() => setSidebarTab('events')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium
                         transition-colors border-b-2
                         ${sidebarTab === 'events'
                           ? 'border-accent text-accent bg-accent/5'
                           : 'border-transparent text-text-tertiary hover:text-text-secondary'
                         }`}
            >
              <List size={13} />
              Events ({discoveredEvents.length || eventSummary?.total_events || 0})
            </button>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto">
            {sidebarTab === 'log' ? (
              /* ── Log tab ─────────────────────────────────────────── */
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
            ) : (
              /* ── Events tab ──────────────────────────────────────── */
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

                {/* Event list */}
                {(isAnalyzing ? discoveredEvents : events).map((ev) => {
                  const isDiscovered = isAnalyzing
                  const type = isDiscovered ? ev.type : ev.event_type
                  const cfg = EVENT_CONFIG[type] || {}
                  const Icon = cfg.icon || BarChart3
                  const names = isDiscovered ? (ev.driverNames || []) : (ev.driver_names || [])
                  const startSec = isDiscovered ? ev.startTime : ev.start_time_seconds
                  const sev = ev.severity
                  const eventId = isDiscovered ? ev.id : ev.id
                  const isExpanded = expandedEvent === `sidebar-${eventId}`

                  return (
                    <div key={`${isDiscovered ? 'd' : 'e'}-${eventId}`}
                         className="border-b border-border-subtle/30 animate-slide-right">
                      <div className="flex items-center hover:bg-bg-hover transition-colors">
                        {/* Main clickable area — seeks the replay */}
                        <button
                          onClick={() => seekToEvent(ev)}
                          title="Seek replay to this event"
                          className="flex-1 flex items-center gap-2 px-3 py-2.5 text-left min-w-0"
                        >
                          <Icon size={14} className={cfg.color || 'text-text-tertiary'} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-medium text-text-primary truncate">
                                {cfg.label || type}
                              </span>
                              {names.length > 0 && (
                                <span className="text-xxs text-text-disabled truncate max-w-[100px]">
                                  {names[0]}
                                </span>
                              )}
                            </div>
                            <span className="text-xxs text-text-disabled font-mono">
                              {formatTime(startSec)}
                            </span>
                          </div>
                          <span className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center
                                          text-xxs font-bold ${severityColor(sev)}`}>
                            {sev}
                          </span>
                        </button>
                        {/* Separate expand button */}
                        {!isDiscovered && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setExpandedEvent(prev => prev === `sidebar-${eventId}` ? null : `sidebar-${eventId}`)
                            }}
                            title={isExpanded ? 'Collapse details' : 'Expand details'}
                            className="shrink-0 w-8 h-8 flex items-center justify-center mr-1
                                       rounded-md hover:bg-surface-active text-text-disabled
                                       hover:text-text-secondary transition-colors"
                          >
                            <ChevronDown size={14}
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
            )}
          </div>
        </div>

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
                  {/* MJPEG stream instead of polling screenshots */}
                  <img
                    key={streamKey}
                    src={streamUrl}
                    alt="iRacing replay"
                    className="w-full h-full object-cover"
                    onError={(e) => { e.target.style.opacity = '0.15' }}
                    onLoad={(e) => { e.target.style.opacity = '1' }}
                  />
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
                  <Video size={32} className="text-text-disabled" />
                  <span className="text-xs text-text-disabled">iRacing not connected</span>
                  <span className="text-xxs text-text-disabled">Connect iRacing to see preview</span>
                </div>
              )}

              {/* Top-right controls: window picker + quality settings */}
              <div className="absolute top-3 right-3 flex items-center gap-1.5 z-10">
                <button
                  onClick={() => { setShowQualitySettings(prev => !prev) }}
                  title="Stream quality settings"
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-xxs
                             bg-black/70 backdrop-blur-sm text-white/70 hover:text-white border border-white/10
                             transition-colors"
                >
                  <Settings size={11} />
                </button>
                <button
                  onClick={() => { setShowWindowPicker(prev => !prev); if (!showWindowPicker) fetchWindows() }}
                  title={captureTarget.mode === 'manual' ? 'Manual capture target' : 'Auto-detecting iRacing'}
                  className={`flex items-center gap-1 px-2 py-1 rounded-md text-xxs transition-colors
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
                                rounded-lg shadow-xl z-20 animate-fade-in p-3">
                  <span className="text-xxs font-medium text-text-primary block mb-2">Stream Quality</span>
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
                    <label className="flex items-center justify-between text-xxs text-text-secondary">
                      <span>Quality</span>
                      <select value={streamQuality} onChange={e => { setStreamQuality(+e.target.value); setStreamKey(k => k + 1) }}
                        className="bg-surface border border-border rounded px-1.5 py-0.5 text-xxs text-text-primary">
                        <option value={40}>Low (40)</option>
                        <option value={55}>Medium (55)</option>
                        <option value={70}>High (70)</option>
                        <option value={85}>Ultra (85)</option>
                        <option value={95}>Max (95)</option>
                      </select>
                    </label>
                    <label className="flex items-center justify-between text-xxs text-text-secondary">
                      <span>Resolution</span>
                      <select value={streamMaxWidth} onChange={e => { setStreamMaxWidth(+e.target.value); setStreamKey(k => k + 1) }}
                        className="bg-surface border border-border rounded px-1.5 py-0.5 text-xxs text-text-primary">
                        <option value={640}>640p</option>
                        <option value={960}>960p</option>
                        <option value={1280}>1280p</option>
                        <option value={1920}>1920p</option>
                      </select>
                    </label>
                  </div>
                </div>
              )}

              {/* Window picker dropdown */}
              {showWindowPicker && (
                <div className="absolute top-10 right-3 w-72 max-h-52 overflow-y-auto
                                bg-bg-secondary border border-border rounded-lg shadow-xl z-20
                                animate-fade-in">
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
                    windowList.map(win => (
                      <button
                        key={win.hwnd}
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
                    <span className="text-xxs text-text-disabled">
                      · Lap {replayState.race_laps}
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

                {/* Separator */}
                <div className="w-px h-5 bg-border mx-1" />

                {/* Camera switcher */}
                <div className="relative">
                  <button onClick={() => { setShowCameraPicker(prev => !prev); setShowDriverPicker(false) }}
                    title="Switch camera"
                    className="p-1.5 rounded-md hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors">
                    <Eye size={14} />
                  </button>
                  {showCameraPicker && (
                    <div className="absolute bottom-full mb-1 right-0 w-48 max-h-40 overflow-y-auto
                                    bg-bg-secondary border border-border rounded-lg shadow-xl z-20 animate-fade-in">
                      {cameraGroups.map(cam => (
                        <button key={cam.group_num}
                          onClick={() => handleSwitchCamera(cam.group_num)}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xxs
                                     hover:bg-bg-hover transition-colors text-text-secondary">
                          <Eye size={10} />
                          <span>{cam.group_name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Driver switcher */}
                <div className="relative">
                  <button onClick={() => { setShowDriverPicker(prev => !prev); setShowCameraPicker(false) }}
                    title="Switch to driver"
                    className="p-1.5 rounded-md hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors">
                    <Users size={14} />
                  </button>
                  {showDriverPicker && (
                    <div className="absolute bottom-full mb-1 right-0 w-56 max-h-52 overflow-y-auto
                                    bg-bg-secondary border border-border rounded-lg shadow-xl z-20 animate-fade-in">
                      {drivers.filter(d => !d.is_spectator).map(d => (
                        <button key={d.car_idx}
                          onClick={() => handleSwitchDriver(d.car_idx)}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xxs
                                     hover:bg-bg-hover transition-colors
                                     ${replayState?.cam_car_idx === d.car_idx ? 'bg-accent/10 text-accent' : 'text-text-secondary'}`}>
                          <span className="font-mono shrink-0 w-5 text-right">#{d.car_number}</span>
                          <span className="truncate">{d.user_name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
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
