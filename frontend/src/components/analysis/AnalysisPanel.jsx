import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { useAnalysis } from '../../context/AnalysisContext'
import { useProject } from '../../context/ProjectContext'
import { useIRacing } from '../../context/IRacingContext'
import { useToast } from '../../context/ToastContext'
import { useHighlight } from '../../context/HighlightContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { apiPost, apiGet, apiDelete } from '../../services/api'
import {
  Play, BarChart3, Loader2, CheckCircle2,
  XCircle, Terminal, ChevronDown, ChevronUp,
  List, Zap, WifiOff, RefreshCw,
  Folder, SlidersHorizontal, Minus, Check, Film, X,
} from 'lucide-react'
import ProjectFileBrowser from '../projects/ProjectFileBrowser'
import ResizableSidebar from '../layout/ResizableSidebar'
import Tooltip from '../ui/Tooltip'
import PreviewPlayer from './PreviewPlayer'
import PlaybackTimeline from './PlaybackTimeline'
import AnalysisRightPanel from './AnalysisRightPanel'
import EventDetail from './EventDetail'
import TuningPanel from './TuningPanel'
import { EVENT_CONFIG, formatTime, scoreColor } from './analysisConstants'

export default memo(function AnalysisPanel() {
  // ── Context ────────────────────────────────────────────────────────────
  const {
    isAnalyzing, isScanning, progress, events, eventSummary, error,
    analysisLog, discoveredEvents, hasTelemetry, hasEvents, analysisStatus,
    startAnalysis, startRescan, cancelAnalysis, clearAnalysis,
    fetchEvents, fetchEventSummary, fetchAnalysisStatus,
    loadAnalysisLog, clearDiscoveredEvents,
  } = useAnalysis()
  const { activeProject, advanceStep } = useProject()
  const { isConnected } = useIRacing()
  const { overrides, toggleOverride } = useHighlight()
  const { showError, showWarning } = useToast()

  // ── Local state ────────────────────────────────────────────────────────
  const [activeFilter, setActiveFilter] = useState('')
  const logEndRef = useRef(null)
  const eventsEndRef = useRef(null)
  const [expandedEvent, setExpandedEvent] = useState(null)
  const [sidebarTab, setSidebarTab] = useLocalStorage('lrs:analysis:sidebar:tab', 'log')
  const wasAnalyzingRef = useRef(false)

  // Event feed overlay
  const [feedEvents, setFeedEvents] = useState([])
  const feedTimersRef = useRef(new Map())
  const FEED_LIFETIME_MS = 5000

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

  useEffect(() => {
    return () => feedTimersRef.current.forEach(t => clearTimeout(t))
  }, [])

  // Camera follow
  const [cameraFollow, setCameraFollow] = useLocalStorage('lrs:analysis:cameraFollow', false)
  const lastCameraEventRef = useRef(null)

  // Event table sort
  const [eventSort, setEventSort] = useState({ col: 'time', dir: 'asc' })

  // Window picker
  const [showWindowPicker, setShowWindowPicker] = useState(false)
  const [windowList, setWindowList] = useState([])
  const [captureTarget, setCaptureTarget] = useState({ mode: 'auto', hwnd: null })
  const [loadingWindows, setLoadingWindows] = useState(false)

  // Replay controls
  const [replaySpeed, setReplaySpeed] = useState(1)
  const [isPlaying, setIsPlaying] = useState(true)
  const [replayState, setReplayState] = useState(null)
  const [focusedEvent, setFocusedEvent] = useState(null)
  const [autoLoop, setAutoLoop] = useState(false)
  const [sessionMatch, setSessionMatch] = useState(null)
  const [isSeeking, setIsSeeking] = useState(false)

  // Stream settings
  const [streamFps, setStreamFps] = useLocalStorage('lrs:analysis:streamFps', 15)
  const [streamFormat, setStreamFormat] = useLocalStorage('lrs:analysis:streamFormat', 'mjpeg')
  const [mjpegQuality, setMjpegQuality] = useLocalStorage('lrs:analysis:mjpegQuality', 85)
  const [mjpegMaxWidth, setMjpegMaxWidth] = useLocalStorage('lrs:analysis:mjpegMaxWidth', 1280)
  const [h264Crf, setH264Crf] = useLocalStorage('lrs:analysis:h264Crf', 23)
  const [h264MaxWidth, setH264MaxWidth] = useLocalStorage('lrs:analysis:h264MaxWidth', 1280)
  const [streamHlsCrf, setStreamHlsCrf] = useLocalStorage('lrs:analysis:streamHlsCrf', 23)
  const [showQualitySettings, setShowQualitySettings] = useState(false)
  const [streamKey, setStreamKey] = useState(0)
  const [streamLoaded, setStreamLoaded] = useState(false)
  const [streamError, setStreamError] = useState(null)
  const [streamResetting, setStreamResetting] = useState(false)
  const [streamVisible, setStreamVisible] = useState(true)

  // Tuning parameters
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
  const [showTuningPanel, setShowTuningPanel] = useState(false)
  const [showTuning, setShowTuning] = useState(false)
  const [isRedetecting, setIsRedetecting] = useState(false)

  // Right panel
  const [rightPanelWidth, setRightPanelWidth] = useLocalStorage('lrs:analysis:rightPanelWidth', 320)

  // Data loading
  const [isDataLoading, setIsDataLoading] = useState(true)

  // Timeline
  const [raceDuration, setRaceDuration] = useState(0)
  const [raceStart, setRaceStart] = useState(0)
  const [raceSessionNum, setRaceSessionNum] = useState(0)

  // Portrait mode
  const [isPortrait, setIsPortrait] = useState(() => window.innerWidth < window.innerHeight)
  useEffect(() => {
    const mq = window.matchMedia('(orientation: portrait)')
    const handler = (e) => setIsPortrait(e.matches)
    mq.addEventListener('change', handler)
    const onResize = () => setIsPortrait(window.innerWidth < window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => { mq.removeEventListener('change', handler); window.removeEventListener('resize', onResize) }
  }, [])

  // Drivers & cameras
  const [drivers, setDrivers] = useState([])
  const [cameraGroups, setCameraGroups] = useState([])

  // ── Effects ────────────────────────────────────────────────────────────
  useEffect(() => { setStreamLoaded(false); setStreamError(null) }, [streamKey])

  useEffect(() => {
    if (!isConnected) return
    const fetchSession = () => {
      apiGet('/iracing/session').then(data => {
        if (data.drivers?.length) setDrivers(data.drivers)
        if (data.cameras?.length) setCameraGroups(data.cameras)
      }).catch(() => {})
    }
    fetchSession()
    const interval = setInterval(fetchSession, 5000)
    return () => clearInterval(interval)
  }, [isConnected])

  useEffect(() => {
    if (!isConnected) return
    const interval = setInterval(() => {
      apiGet('/iracing/replay/state').then(data => {
        setReplayState(data)
        if (data.replay_speed !== undefined) {
          setIsPlaying(data.replay_speed !== 0)
          setReplaySpeed(Math.abs(data.replay_speed))
        }
      }).catch(() => {})
    }, 1000)
    return () => clearInterval(interval)
  }, [isConnected])

  useEffect(() => {
    if (!isConnected || !activeProject?.id || !hasTelemetry) {
      setSessionMatch(null)
      return
    }
    const check = () => {
      apiGet(`/projects/${activeProject.id}/analysis/session-match`)
        .then(setSessionMatch)
        .catch(() => {})
    }
    check()
    const interval = setInterval(check, 5000)
    return () => clearInterval(interval)
  }, [isConnected, activeProject?.id, hasTelemetry])

  useEffect(() => {
    if (!autoLoop || !focusedEvent || !replayState || isSeeking) return
    const t = replayState.session_time
    if (t != null && t > focusedEvent.end_time_seconds + 1.5) {
      seekToEvent(focusedEvent)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayState])

  useEffect(() => {
    if (!activeProject?.id) return
    setIsDataLoading(true)
    const logFetch = apiGet(`/projects/${activeProject.id}/analysis/log`)
      .then(data => { if (data?.entries?.length > 0) loadAnalysisLog(data.entries) })
      .catch(() => {})
    Promise.all([
      fetchAnalysisStatus(activeProject.id),
      fetchEvents(activeProject.id, { limit: 50000 }),
      fetchEventSummary(activeProject.id),
      logFetch,
      apiGet(`/projects/${activeProject.id}/analysis/tuning`)
        .then(data => {
          if (data?.tuning_params) setTuningParams(prev => ({ ...prev, ...data.tuning_params }))
        })
        .catch(() => {}),
    ]).finally(() => setIsDataLoading(false))
  }, [activeProject?.id, fetchAnalysisStatus, fetchEvents, fetchEventSummary, loadAnalysisLog])

  useEffect(() => {
    if (!activeProject?.id) return
    apiGet(`/projects/${activeProject.id}/analysis/race-duration`)
      .then(data => {
        setRaceDuration(data?.duration_seconds || 0)
        setRaceStart(data?.race_start_seconds || 0)
        setRaceSessionNum(data?.race_session_num ?? 0)
      })
      .catch(() => {})
  }, [activeProject?.id, events])

  useEffect(() => {
    if (sidebarTab === 'events' && eventsEndRef.current) {
      eventsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [discoveredEvents, sidebarTab])

  useEffect(() => {
    if (wasAnalyzingRef.current && !isAnalyzing) {
      setSidebarTab('events')
    }
    wasAnalyzingRef.current = isAnalyzing
  }, [isAnalyzing, setSidebarTab])

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

  // ── Derived values ─────────────────────────────────────────────────────
  const hasEventsLocal = events.length > 0 || hasEvents

  const streamUrl = `/api/iracing/stream?fps=${streamFps}&quality=${mjpegQuality}&max_width=${mjpegMaxWidth}&_k=${streamKey}`
  const h264Url   = `/api/iracing/stream/h264?fps=${streamFps}&crf=${h264Crf}&max_width=${h264MaxWidth}&_k=${streamKey}`
  const hlsUrl    = `/api/iracing/stream/hls/playlist.m3u8?fps=${streamFps}&crf=${streamHlsCrf}&max_width=${h264MaxWidth}&_k=${streamKey}`
  const activeStreamUrl = streamFormat === 'h264' ? h264Url : streamFormat === 'hls' ? hlsUrl : streamUrl

  const filteredEvents = (() => {
    if (!events?.length) return []
    const list = activeFilter
      ? events.filter(e => e.event_type === activeFilter)
      : events
    return [...list].sort((a, b) => (a.start_time_seconds ?? 0) - (b.start_time_seconds ?? 0))
  })()

  // ── Handlers ───────────────────────────────────────────────────────────
  const handleStreamReset = async () => {
    if (streamResetting) return
    setStreamResetting(true)
    setStreamLoaded(false)
    setStreamError(null)
    try {
      await apiPost('/iracing/stream/reset', {
        fps: streamFps,
        quality: mjpegQuality,
        max_width: mjpegMaxWidth,
      })
    } catch {
    } finally {
      setStreamKey(k => k + 1)
      setStreamResetting(false)
    }
  }

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

  const handleStart = async () => {
    setSidebarTab('log')
    try { await startAnalysis(activeProject.id, tuningParams) } catch {}
  }

  const handleRescan = async () => {
    setSidebarTab('log')
    try { await startRescan(activeProject.id) } catch {}
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
    await fetchEvents(activeProject.id, { eventType: newFilter, limit: 50000 })
  }

  const handleReanalyze = async () => {
    if (!activeProject?.id || isRedetecting) return
    setIsRedetecting(true)
    clearDiscoveredEvents()
    setSidebarTab('log')
    try {
      await apiPost(`/projects/${activeProject.id}/analyze/redetect`, tuningParams)
      await fetchEvents(activeProject.id, { limit: 50000 })
      await fetchEventSummary(activeProject.id)
    } catch {} finally {
      setIsRedetecting(false)
    }
  }

  const handleRedetect = handleReanalyze

  const updateTuning = (key, value) => {
    setTuningParams(prev => ({ ...prev, [key]: value }))
  }

  const seekToEvent = async (event) => {
    if (!isConnected || !activeProject?.id || isSeeking) return
    const startTimeSec = event.start_time_seconds ?? event.startTime ?? 0
    const carIdx = event.carIdx ?? event.car_idx
      ?? (event.involved_drivers && event.involved_drivers[0])
      ?? null
    setIsSeeking(true)
    try {
      const result = await apiPost(`/projects/${activeProject.id}/analysis/seek-event`, {
        start_time_seconds: startTimeSec,
        car_idx: carIdx,
      })
      setIsPlaying(true)
      setReplaySpeed(1)
      setFocusedEvent(event)
      if (result && result.verified === false) {
        showWarning(
          `Seek may not have landed correctly — target ${result.frame ?? '?'} actual ${result.actual_frame ?? '?'}. ` +
          'Try re-detecting events or check that a race replay is loaded.',
          { duration: 7000 }
        )
      }
    } catch (err) {
      const detail = err?.detail ?? err?.message ?? 'Unknown error'
      showError(`Seek failed: ${detail}`, { duration: 7000 })
    } finally {
      setIsSeeking(false)
    }
  }

  const navigateEvent = useCallback((direction) => {
    if (!filteredEvents.length) return
    const currentTime = focusedEvent?.start_time_seconds
      ?? replayState?.session_time ?? 0
    let target
    if (direction === 'next') {
      target = filteredEvents.find(e => (e.start_time_seconds ?? 0) > currentTime + 0.5)
      if (!target) target = filteredEvents[0]
    } else {
      const reversed = [...filteredEvents].reverse()
      target = reversed.find(e => (e.start_time_seconds ?? 0) < currentTime - 0.5)
      if (!target) target = reversed[0]
    }
    if (target) seekToEvent(target)
  }, [filteredEvents, focusedEvent, replayState, seekToEvent])

  const handlePlayPause = async () => {
    if (!isConnected) return
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

  // ── Early returns ──────────────────────────────────────────────────────
  if (!activeProject) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary">
        <p>Select a project to view analysis</p>
      </div>
    )
  }

  if (isDataLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <Loader2 size={22} className="animate-spin text-text-disabled" />
        <p className="text-xs text-text-tertiary">Loading analysis data…</p>
      </div>
    )
  }

  // ── Idle state: no analysis running, no events ────────────────────────
  if (!isAnalyzing && !hasEventsLocal && discoveredEvents.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="flex flex-col items-center gap-3 text-center max-w-sm">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-gradient-from via-gradient-via to-gradient-to
                          flex items-center justify-center shadow-glow-sm">
            <BarChart3 size={28} className="text-white" />
          </div>
          <h2 className="text-lg font-bold text-text-primary">Replay Analysis</h2>

          {hasTelemetry ? (
            <>
              <p className="text-sm text-text-tertiary leading-relaxed">
                Telemetry collected. Adjust tuning parameters and run event detection — no iRacing connection required.
              </p>
              <div className="w-full mt-2">
                <button
                  onClick={() => setShowTuningPanel(v => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs
                             border border-border rounded-lg hover:bg-bg-hover transition-colors text-text-secondary"
                >
                  <span className="flex items-center gap-1.5">
                    <SlidersHorizontal size={13} className="text-accent" />
                    Tuning Parameters
                  </span>
                  <ChevronDown size={13} className={`transition-transform ${showTuningPanel ? 'rotate-180' : ''}`} />
                </button>
                {showTuningPanel && (
                  <TuningPanel params={tuningParams} onChange={updateTuning} className="mt-2" />
                )}
              </div>
              <div className="flex gap-2 mt-1">
                <button
                  onClick={handleReanalyze}
                  disabled={isRedetecting}
                  className="flex items-center gap-2 px-6 py-3 text-sm font-semibold
                             text-white bg-gradient-to-r from-gradient-from to-gradient-to
                             rounded-xl hover:from-gradient-via hover:to-gradient-from
                             transition-all duration-200 shadow-glow-sm hover:shadow-glow disabled:opacity-50"
                >
                  {isRedetecting
                    ? <Loader2 size={16} className="animate-spin" />
                    : <SlidersHorizontal size={16} />}
                  {isRedetecting ? 'Analyzing...' : 'Re-analyze'}
                </button>
                {isConnected && (
                  <button
                    onClick={handleRescan}
                    className="flex items-center gap-2 px-4 py-3 text-sm font-medium
                               text-text-secondary border border-border rounded-xl
                               hover:bg-bg-hover transition-colors"
                  >
                    <RefreshCw size={14} />
                    Re-collect Telemetry
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-text-tertiary leading-relaxed">
                Scan the replay at 16× speed to detect battles, incidents, overtakes, and key moments.
              </p>
              <button
                onClick={handleStart}
                disabled={!isConnected}
                title={!isConnected ? 'iRacing must be connected and a replay loaded' : undefined}
                className="flex items-center gap-2 px-6 py-3 text-sm font-semibold
                           text-white bg-gradient-to-r from-gradient-from to-gradient-to
                           rounded-xl hover:from-gradient-via hover:to-gradient-from
                           transition-all duration-200 shadow-glow-sm hover:shadow-glow mt-2
                           disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Play size={16} />
                Analyze Replay
              </button>
              {!isConnected && (
                <p className="text-xs text-text-disabled flex items-center gap-1">
                  <WifiOff size={12} /> iRacing must be running with a replay loaded
                </p>
              )}
            </>
          )}

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
      <div className="flex-1 flex overflow-hidden min-h-0 relative">

        {/* Tabbed sidebar (Log / Events / Files) */}
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
                <LogTabContent
                  isAnalyzing={isAnalyzing}
                  progress={progress}
                  analysisLog={analysisLog}
                />
              ),
            },
            {
              id: 'events',
              label: 'Events',
              icon: List,
              count: isAnalyzing ? null : (eventSummary?.total_events || events.length || 0),
              content: (
                <EventsTabContent
                  showTuning={showTuning}
                  setShowTuning={setShowTuning}
                  isAnalyzing={isAnalyzing}
                  isScanning={isScanning}
                  isRedetecting={isRedetecting}
                  progress={progress}
                  events={events}
                  eventSummary={eventSummary}
                  eventSort={eventSort}
                  activeFilter={activeFilter}
                  expandedEvent={expandedEvent}
                  focusedEvent={focusedEvent}
                  raceStart={raceStart}
                  isSeeking={isSeeking}
                  overrides={overrides}
                  tuningParams={tuningParams}
                  handleFilterChange={handleFilterChange}
                  handleReanalyze={handleReanalyze}
                  cycleSort={cycleSort}
                  seekToEvent={seekToEvent}
                  setExpandedEvent={setExpandedEvent}
                  toggleOverride={toggleOverride}
                  updateTuning={updateTuning}
                  eventsEndRef={eventsEndRef}
                />
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

        {/* Center + right column */}
        <div className={`flex-1 flex min-w-0 bg-bg-primary overflow-hidden ${isPortrait ? 'flex-col' : ''}`}>
          {/* Center column: preview + timeline */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <PreviewPlayer
              isConnected={isConnected}
              isAnalyzing={isAnalyzing}
              isPlaying={isPlaying}
              streamFormat={streamFormat}
              streamKey={streamKey}
              activeStreamUrl={activeStreamUrl}
              streamUrl={streamUrl}
              streamLoaded={streamLoaded}
              setStreamLoaded={setStreamLoaded}
              streamError={streamError}
              setStreamError={setStreamError}
              streamResetting={streamResetting}
              handleStreamReset={handleStreamReset}
              streamVisible={streamVisible}
              setStreamVisible={setStreamVisible}
              sessionMatch={sessionMatch}
              feedEvents={feedEvents}
              showQualitySettings={showQualitySettings}
              setShowQualitySettings={setShowQualitySettings}
              streamFps={streamFps}
              setStreamFps={setStreamFps}
              mjpegQuality={mjpegQuality}
              setMjpegQuality={setMjpegQuality}
              mjpegMaxWidth={mjpegMaxWidth}
              setMjpegMaxWidth={setMjpegMaxWidth}
              h264Crf={h264Crf}
              setH264Crf={setH264Crf}
              streamHlsCrf={streamHlsCrf}
              setStreamHlsCrf={setStreamHlsCrf}
              setStreamKey={setStreamKey}
              setStreamFormat={setStreamFormat}
              showWindowPicker={showWindowPicker}
              setShowWindowPicker={setShowWindowPicker}
              captureTarget={captureTarget}
              windowList={windowList}
              loadingWindows={loadingWindows}
              fetchWindows={fetchWindows}
              selectWindow={selectWindow}
              resetToAuto={resetToAuto}
              onPlayPause={handlePlayPause}
              isPortrait={isPortrait}
            />

            <PlaybackTimeline
              isConnected={isConnected}
              isAnalyzing={isAnalyzing}
              raceDuration={raceDuration}
              raceStart={raceStart}
              raceSessionNum={raceSessionNum}
              replayState={replayState}
              replaySpeed={replaySpeed}
              isPlaying={isPlaying}
              isSeeking={isSeeking}
              focusedEvent={focusedEvent}
              setFocusedEvent={setFocusedEvent}
              autoLoop={autoLoop}
              setAutoLoop={setAutoLoop}
              filteredEvents={filteredEvents}
              seekToEvent={seekToEvent}
              navigateEvent={navigateEvent}
              handlePlayPause={handlePlayPause}
              handleSetSpeed={handleSetSpeed}
              handleReplaySearch={handleReplaySearch}
              handleSwitchDriver={handleSwitchDriver}
              overrides={overrides}
              toggleOverride={toggleOverride}
            />
          </div>

          {/* Right panel: Analysis / Cameras / Drivers */}
          <AnalysisRightPanel
            isAnalyzing={isAnalyzing}
            isScanning={isScanning}
            progress={progress}
            error={error}
            hasTelemetry={hasTelemetry}
            hasEventsLocal={hasEventsLocal}
            eventSummary={eventSummary}
            analysisStatus={analysisStatus}
            isConnected={isConnected}
            isRedetecting={isRedetecting}
            replayState={replayState}
            cameraGroups={cameraGroups}
            drivers={drivers}
            rightPanelWidth={rightPanelWidth}
            setRightPanelWidth={setRightPanelWidth}
            isPortrait={isPortrait}
            handleCancel={handleCancel}
            handleRescan={handleRescan}
            handleReanalyze={handleReanalyze}
            handleClear={handleClear}
            handleSwitchCamera={handleSwitchCamera}
            handleSwitchDriver={handleSwitchDriver}
            advanceStep={advanceStep}
            activeProjectId={activeProject.id}
          />
        </div>
      </div>
    </div>
  )
})


// ── Sidebar tab content sub-components ───────────────────────────────────

function LogTabContent({ isAnalyzing, progress, analysisLog }) {
  return (
    <div className="font-mono">
      {isAnalyzing && progress && (
        <div className="px-3 pt-2 pb-1.5 border-b border-border-subtle sticky top-0 bg-bg-secondary z-10">
          <div className="h-1 bg-bg-tertiary rounded-full overflow-hidden">
            <div
              className="h-full bg-accent/70 rounded-full transition-all duration-500"
              style={{ width: `${progress.percent ?? 0}%` }}
            />
          </div>
          <span className="text-xxs text-text-disabled mt-1 block truncate">
            {progress.message || 'Analyzing...'}
          </span>
        </div>
      )}
      {analysisLog.length === 0 && !isAnalyzing && (
        <div className="flex items-center justify-center py-8 text-text-disabled text-xs">
          No log entries yet
        </div>
      )}
      {analysisLog.length === 0 && isAnalyzing && (
        <div className="flex items-center gap-2 px-3 py-4 text-text-disabled text-xxs">
          <Loader2 size={11} className="animate-spin shrink-0" />
          <span>Initializing...</span>
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
            <span className="text-text-disabled font-mono mr-1.5">
              {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
            <span className="text-text-secondary">{entry.message}</span>
            {entry.detail && (
              <span className="text-text-disabled ml-1">— {entry.detail}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}


function EventsTabContent({
  showTuning, setShowTuning,
  isAnalyzing, isScanning, isRedetecting, progress,
  events, eventSummary, eventSort, activeFilter,
  expandedEvent, focusedEvent, raceStart, isSeeking,
  overrides, tuningParams,
  handleFilterChange, handleReanalyze, cycleSort, seekToEvent,
  setExpandedEvent, toggleOverride, updateTuning,
  eventsEndRef,
}) {
  return (
    <div className="flex flex-col h-full">
      {/* Sub-navigation: Events list ↔ Tuning */}
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
          Detection
        </button>
        {showTuning && (
          <button
            onClick={handleReanalyze}
            disabled={isRedetecting}
            className="ml-auto flex items-center gap-1 px-2 py-0.5 text-xxs font-medium
                       text-white bg-gradient-to-r from-gradient-from to-gradient-to
                       rounded transition-all duration-150 shadow-glow-sm disabled:opacity-50"
          >
            {isRedetecting
              ? <Loader2 size={9} className="animate-spin" />
              : <SlidersHorizontal size={9} />}
            {isRedetecting ? 'Running…' : 'Re-analyze'}
          </button>
        )}
      </div>

      {showTuning ? (
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
          <TuningPanel params={tuningParams} onChange={updateTuning} />
        </div>
      ) : isAnalyzing ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4 py-10">
          <Loader2 size={22} className="animate-spin text-text-disabled" />
          <span className="text-xs text-text-disabled text-center">
            {isScanning ? 'Collecting telemetry…' : 'Detecting events…'}
          </span>
          {!isScanning && progress != null && (
            <div className="w-full max-w-[160px]">
              <div className="h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-gradient-from to-gradient-to
                             rounded-full transition-all duration-500"
                  style={{ width: `${Math.max(0, Math.min(100, ((progress.percent ?? 55) - 55) / 40 * 100))}%` }}
                />
              </div>
              {progress.message && (
                <span className="text-xxs text-text-disabled mt-1.5 block text-center truncate">
                  {progress.message}
                </span>
              )}
            </div>
          )}
        </div>
      ) : (
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
              { key: 'severity', label: 'Score' },
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

          {/* Event rows */}
          {(() => {
            const sorted = [...events].sort((a, b) => {
              const dir = eventSort.dir === 'asc' ? 1 : -1
              switch (eventSort.col) {
                case 'type':     return dir * ((a.event_type || '').localeCompare(b.event_type || ''))
                case 'driver':   return dir * ((a.driver_names?.[0] || '').localeCompare(b.driver_names?.[0] || ''))
                case 'time':     return dir * ((a.start_time_seconds || 0) - (b.start_time_seconds || 0))
                case 'severity': return dir * ((a.severity || 0) - (b.severity || 0))
                default: return 0
              }
            })
            return sorted.map((ev) => {
              const type = ev.event_type
              const cfg = EVENT_CONFIG[type] || {}
              const Icon = cfg.icon || BarChart3
              const startSec = ev.start_time_seconds
              const sev = ev.severity
              const eventId = ev.id
              const isExpanded = expandedEvent === `sidebar-${eventId}`
              const driverNames = ev.driver_names || []
              const override = overrides[String(eventId)] || null
              return (
                <div key={`e-${eventId}`}
                     className="border-b border-border-subtle/30 animate-slide-right">
                  <div
                    className={`grid grid-cols-[auto_minmax(0,auto)_1fr_auto_auto_auto]
                               hover:bg-bg-hover transition-colors
                               ${isSeeking ? 'cursor-wait opacity-60 pointer-events-none' : 'cursor-pointer'}
                               ${focusedEvent?.id === ev.id ? 'bg-accent/10 border-l-2 border-accent' : ''}`}
                    onClick={() => seekToEvent(ev)}
                  >
                    {/* Override toggle */}
                    <div className="flex items-center px-1 py-1.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleOverride(eventId) }}
                        className={`w-4 h-4 rounded border flex items-center justify-center transition-colors
                          ${override === 'highlight'
                            ? 'bg-success border-success text-white'
                            : override === 'full-video'
                              ? 'bg-info border-info text-white'
                              : override === 'exclude'
                                ? 'bg-danger border-danger text-white'
                                : 'border-border-subtle text-text-disabled hover:border-text-tertiary'
                          }`}
                        title={
                          override === 'highlight' ? 'Force highlight (click for full-video)'
                          : override === 'full-video' ? 'Force full-video (click to exclude)'
                          : override === 'exclude' ? 'Force excluded (click for auto)'
                          : 'Auto (click to force highlight)'
                        }
                      >
                        {override === 'highlight' && <Check className="w-2.5 h-2.5" />}
                        {override === 'full-video' && <Film className="w-2.5 h-2.5" />}
                        {override === 'exclude' && <X className="w-2.5 h-2.5" />}
                        {!override && <Minus className="w-2.5 h-2.5 opacity-30" />}
                      </button>
                    </div>
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
                      <span className="text-xxs text-text-disabled font-mono whitespace-nowrap">{formatTime(Math.max(0, startSec - raceStart))}</span>
                    </div>
                    {/* Score badge */}
                    <div className="flex items-center gap-0.5 px-2 py-1.5">
                      <span
                        className="w-5 h-5 rounded flex items-center justify-center text-xxs font-bold text-white"
                        style={{ backgroundColor: scoreColor(sev) }}
                        title={`Score: ${sev}`}
                      >
                        {sev}
                      </span>
                    </div>
                    {/* Expand */}
                    <div className="flex items-center px-1 py-1.5">
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
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-3 pt-2 pb-2 bg-bg-secondary/50 border-t border-border-subtle animate-fade-in">
                      <EventDetail event={ev} />
                    </div>
                  )}
                </div>
              )
            })
          })()}

          {events.length === 0 && (
            <div className="flex items-center justify-center py-8 text-text-disabled text-xs">
              No events detected
            </div>
          )}
          <div ref={eventsEndRef} />
        </div>
      )}
    </div>
  )
}
