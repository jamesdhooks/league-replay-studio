import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import { useAnalysis } from '../../context/AnalysisContext'
import { useProject } from '../../context/ProjectContext'
import { usePipeline } from '../../context/PipelineContext'
import { useIRacing } from '../../context/IRacingContext'
import { useToast } from '../../context/ToastContext'
import { useHighlight } from '../../context/HighlightContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { apiPost, apiGet } from '../../services/api'
import {
  Play, BarChart3, Loader2,
  XCircle, Terminal, ChevronDown,
  List, WifiOff, RefreshCw,
  Folder, SlidersHorizontal,
} from 'lucide-react'
import ProjectFileBrowser from '../projects/ProjectFileBrowser'
import ResizableSidebar from '../layout/ResizableSidebar'
import PreviewPlayer from './PreviewPlayer'
import PlaybackTimeline from './PlaybackTimeline'
import AnalysisRightPanel from './AnalysisRightPanel'
import AnalysisTuningColumn from './AnalysisTuningColumn'
import AnalysisTelemetryExplorer from './AnalysisTelemetryExplorer'
import TuningPanel from './TuningPanel'
import LogTabContent from './LogTabContent'
import EventsTabContent from './EventsTabContent'
import DataStreamViz from '../collect/DataStreamViz'
import ResizableRowPane from '../ui/ResizableRowPane'

export default memo(function AnalysisPanel() {
  // ── Context ────────────────────────────────────────────────────────────
  const {
    isAnalyzing, isScanning, progress, events, eventSummary, error,
    analysisLog, discoveredEvents, hasTelemetry, hasEvents, analysisStatus,
    startAnalysis, startRescan, cancelAnalysis, clearAnalysis, clearTelemetry, clearEvents,
    fetchEvents, fetchEventSummary, fetchAnalysisStatus,
    loadAnalysisLog, clearDiscoveredEvents, clearLog,
  } = useAnalysis()
  const { activeProject, advanceStep } = useProject()
  const {
    currentRun: pipelineRun,
    currentStep: pipelineCurrentStep,
    steps: pipelineSteps,
    cancelPipeline,
  } = usePipeline()
  const { isConnected } = useIRacing()
  const { overrides, toggleOverride, params } = useHighlight()
  const { showError, showWarning } = useToast()

  const isPipelineRunActive = ['running', 'paused', 'waiting_intervention'].includes(pipelineRun?.state)
  const isPipelineProjectMatch = Boolean(activeProject?.id && pipelineRun?.project_id === activeProject.id)
  const pipelineAnalysisStepState = pipelineSteps?.analysis?.state
  const isPipelineAnalysisActive = isPipelineProjectMatch
    && isPipelineRunActive
    && (
      pipelineCurrentStep === 'analysis'
      || pipelineAnalysisStepState === 'running'
      || (pipelineCurrentStep == null && pipelineAnalysisStepState === 'pending')
    )

  const effectiveIsAnalyzing = isAnalyzing || isPipelineAnalysisActive
  const effectiveIsScanning = isScanning || (isPipelineAnalysisActive && !hasTelemetry)
  const effectiveProgress = progress || (isPipelineAnalysisActive
    ? {
        percent: Math.max(0, Math.round(Number(pipelineSteps?.analysis?.progress || 0))),
        message: 'Automated pipeline is running replay analysis…',
        detail: '',
      }
    : null)

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

  // Window picker state now lives inside PreviewPlayer via LivePreviewContext.

  // Replay controls
  const [replaySpeed, setReplaySpeed] = useState(1)
  const [isPlaying, setIsPlaying] = useState(true)
  const [replayState, setReplayState] = useState(null)
  const [focusedEvent, setFocusedEvent] = useState(null)
  const [autoLoop, setAutoLoop] = useState(false)
  const [sessionMatch, setSessionMatch] = useState(null)
  const [isSeeking, setIsSeeking] = useState(false)

  // Stream settings now live inside PreviewPlayer via LivePreviewContext.

  // Tuning parameters
  const [tuningParams, setTuningParams] = useLocalStorage('lrs:analysis:tuningParams', {
    incident_lead_in: 2.0,
    incident_follow_out: 8.0,
    battle_gap_threshold: 0.5,
    battle_max_segment: 45.0,
    battle_min_duration: 10.0,
    battle_max_cluster_drivers: 4,
    battle_merge_min_overlap_seconds: 2.0,
    battle_merge_max_idle_gap_seconds: 5.0,
    battle_merge_max_position_delta: 2,
    close_call_proximity_seconds: 2.0,
    close_call_max_time_loss: 2.0,
  })
  const [showTuningPanel, setShowTuningPanel] = useState(false)
  const [showTelemetryExplorer, setShowTelemetryExplorer] = useState(false)
  const [showTuning, setShowTuning] = useState(false)
  const [isRedetecting, setIsRedetecting] = useState(false)

  // Right panel
  const [rightPanelWidth, setRightPanelWidth] = useLocalStorage('lrs:analysis:rightPanelWidth', 320)

  // Data loading
  const [isDataLoading, setIsDataLoading] = useState(true)

  // Timeline
  const [raceDuration, setRaceDuration] = useState(0)
  const [raceStart, setRaceStart] = useState(0)
  const [raceSessionNum, setRaceSessionNum] = useState(null)

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
  // Stream lifecycle now managed inside PreviewPlayer / useStream.
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
    if (!focusedEvent || !replayState || isSeeking) return
    const t = replayState.session_time
    if (t == null) return
    if (autoLoop && t > focusedEvent.end_time_seconds + 1.5) {
      seekToEvent(focusedEvent)
    } else if (!autoLoop && isPlaying && t > focusedEvent.end_time_seconds + 0.5) {
      // Stop playback at the end of the focused event when not looping
      apiPost('/iracing/replay/speed', { speed: 0 })
        .then(() => { setIsPlaying(false); setReplaySpeed(0) })
        .catch(() => {})
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
          if (data?.tuning_params) {
            const next = { ...data.tuning_params }
            if (next.close_call_proximity_seconds == null) {
              if (next.close_call_proximity_pct != null) {
                next.close_call_proximity_seconds = Number(next.close_call_proximity_pct) * 90
              } else if (next.close_call_proximity != null) {
                const legacy = Number(next.close_call_proximity)
                next.close_call_proximity_seconds = legacy <= 1 ? legacy * 90 : legacy
              }
            }
            setTuningParams(prev => ({ ...prev, ...next }))
          }
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
        setRaceSessionNum(data?.race_session_num ?? null)
      })
      .catch(() => {})
  }, [activeProject?.id, events])

  useEffect(() => {
    // Only auto-scroll to the bottom while analysis is actively running —
    // not after it completes, so the slide-in animation starts at the top.
    if (effectiveIsAnalyzing && sidebarTab === 'events' && eventsEndRef.current) {
      eventsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [discoveredEvents, sidebarTab, effectiveIsAnalyzing])

  useEffect(() => {
    if (wasAnalyzingRef.current && !effectiveIsAnalyzing) {
      setSidebarTab('events')
    }
    wasAnalyzingRef.current = effectiveIsAnalyzing
  }, [effectiveIsAnalyzing, setSidebarTab])

  useEffect(() => {
    if (!cameraFollow || !effectiveIsAnalyzing || discoveredEvents.length === 0) return
    const latest = discoveredEvents[discoveredEvents.length - 1]
    if (lastCameraEventRef.current === latest.id) return
    lastCameraEventRef.current = latest.id
    const carIdx = latest.carIdx ?? latest.car_idx
    if (carIdx != null) {
      apiPost('/iracing/replay/camera', { car_idx: carIdx, group_num: 0 }).catch(() => {})
    }
  }, [cameraFollow, effectiveIsAnalyzing, discoveredEvents])

  // ── Derived values ─────────────────────────────────────────────────────
  const hasEventsLocal = events.length > 0 || hasEvents

  // Analysis-phase rendering uses effective clip windows so operators preview
  // what capture will actually use: per-event override → per-type → global.
  const paddedEvents = useMemo(() => {
    if (!events?.length) return []

    return events.map((event) => {
      const typePad = params?.paddingByType?.[event.event_type] || {}
      const padBefore = event.metadata?.padding_before
        ?? typePad.before
        ?? params?.paddingBefore
        ?? 0
      const padAfter = event.metadata?.padding_after
        ?? typePad.after
        ?? params?.paddingAfter
        ?? 0

      const coreStart = event.start_time_seconds ?? event.startTime ?? 0
      const coreEndRaw = event.end_time_seconds ?? event.endTime ?? coreStart
      const coreEnd = Math.max(coreStart, coreEndRaw)

      const start = Math.max(0, coreStart - Math.max(0, padBefore))
      const end = Math.max(start, coreEnd + Math.max(0, padAfter))

      return {
        ...event,
        start_time_seconds: start,
        end_time_seconds: end,
        core_start_time_seconds: coreStart,
        core_end_time_seconds: coreEnd,
        padding_before_effective: padBefore,
        padding_after_effective: padAfter,
        // Ensure driver_names is preserved (fallback if not in original event)
        driver_names: event.driver_names || [],
      }
    })
  }, [events, params])

  const filteredEvents = useMemo(() => {
    if (!paddedEvents.length) return []
    const list = activeFilter
      ? paddedEvents.filter(e => e.event_type === activeFilter)
      : paddedEvents
    return [...list].sort((a, b) => (a.start_time_seconds ?? 0) - (b.start_time_seconds ?? 0))
  }, [paddedEvents, activeFilter])

  // ── Handlers ───────────────────────────────────────────────────────────
  const handleStart = async () => {
    setSidebarTab('log')
    try { await startAnalysis(activeProject.id, tuningParams) } catch {}
  }

  const handleRescan = async () => {
    setSidebarTab('log')
    try { await startRescan(activeProject.id) } catch {}
  }

  const handleCancel = async () => {
    try {
      const isPipelineRunForProject = Boolean(activeProject?.id && pipelineRun?.project_id === activeProject.id)
      const isPipelineActive = ['running', 'paused', 'waiting_intervention'].includes(pipelineRun?.state)
      const isPipelineInAnalysis = pipelineCurrentStep === 'analysis' || pipelineSteps?.analysis?.state === 'running'

      if (isPipelineRunForProject && isPipelineActive && isPipelineInAnalysis) {
        await cancelPipeline()
        return
      }

      await cancelAnalysis(activeProject.id)
    } catch {}
  }

  const handleClear = async () => {
    try { await clearAnalysis(activeProject.id) } catch {}
  }

  const handleClearTelemetry = async () => {
    try { await clearTelemetry(activeProject.id) } catch {}
  }

  const handleClearEvents = async () => {
    try { await clearEvents(activeProject.id) } catch {}
  }

  const handleExploreTelemetry = () => setShowTelemetryExplorer(true)
  const handleFilterChange = (type) => {
    setActiveFilter(prev => prev === type ? '' : type)
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

  // ── Idle state: no analysis running, no telemetry, no events ─────────
  // Once telemetry exists, fall through to the full editor so the user can
  // run event detection via the phase cards in the tuning column.
  if (!effectiveIsAnalyzing && !hasTelemetry && !hasEventsLocal && discoveredEvents.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="flex flex-col items-center gap-3 text-center max-w-sm">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-gradient-from via-gradient-via to-gradient-to
                          flex items-center justify-center shadow-glow-sm">
            <BarChart3 size={28} className="text-white" />
          </div>
          <h2 className="text-lg font-bold text-text-primary">Replay Analysis</h2>

          <p className="text-sm text-text-tertiary leading-relaxed">
            Scans the replay at 16× to collect telemetry, then automatically detects battles, incidents, overtakes, and key moments.
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
            Collect &amp; Analyze
          </button>
          {!isConnected && (
            <p className="text-xs text-text-disabled flex items-center gap-1">
              <WifiOff size={12} /> iRacing must be running with a replay loaded
            </p>
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
                  isAnalyzing={effectiveIsAnalyzing}
                  progress={effectiveProgress}
                  analysisLog={analysisLog}
                  onClearLog={clearLog}
                />
              ),
            },
            {
              id: 'events',
              label: 'Events',
              icon: List,
              count: effectiveIsAnalyzing ? null : (eventSummary?.total_events || events.length || 0),
              content: (
                <EventsTabContent
                  isAnalyzing={effectiveIsAnalyzing}
                  isScanning={effectiveIsScanning}
                  isRedetecting={isRedetecting}
                  progress={effectiveProgress}
                  events={filteredEvents}
                  eventSummary={eventSummary}
                  eventSort={eventSort}
                  activeFilter={activeFilter}
                  expandedEvent={expandedEvent}
                  focusedEvent={focusedEvent}
                  raceStart={raceStart}
                  isSeeking={isSeeking}
                  overrides={overrides}
                  handleFilterChange={handleFilterChange}
                  cycleSort={cycleSort}
                  seekToEvent={seekToEvent}
                  setExpandedEvent={setExpandedEvent}
                  toggleOverride={toggleOverride}
                  eventsEndRef={eventsEndRef}
                  feedEvents={feedEvents}
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

        {/* Analysis tuning column (resizable, collapsible) */}
        <AnalysisTuningColumn
          tuningParams={tuningParams}
          updateTuning={updateTuning}
          isAnalyzing={effectiveIsAnalyzing}
          isScanning={effectiveIsScanning}
          progress={effectiveProgress}
          error={error}
          hasTelemetry={hasTelemetry}
          hasEventsLocal={hasEventsLocal}
          eventSummary={eventSummary}
          analysisStatus={analysisStatus}
          isConnected={isConnected}
          isRedetecting={isRedetecting}
          handleCancel={handleCancel}
          handleRescan={handleRescan}
          handleReanalyze={handleReanalyze}
          handleClear={handleClear}
          handleClearTelemetry={handleClearTelemetry}
          handleClearEvents={handleClearEvents}
          handleExploreTelemetry={handleExploreTelemetry}
          advanceStep={advanceStep}
          activeProjectId={activeProject.id}
        />

        {/* Center + right column */}
        <div className={`flex-1 flex min-w-0 bg-bg-primary overflow-hidden ${isPortrait ? 'flex-col' : ''}`}>

          {/* Telemetry explorer — replaces preview + right panel when open */}
          {showTelemetryExplorer ? (
            <AnalysisTelemetryExplorer
              projectId={activeProject.id}
              analysisStatus={analysisStatus}
              onClose={() => setShowTelemetryExplorer(false)}
            />
          ) : (
            <>
              {/* Center column: preview + timeline */}
              <div className="flex-1 flex flex-col min-w-0 min-h-0">
                <ResizableRowPane
                  storageKey="lrs:analysis:timelineHeight"
                  defaultBottomHeight={220}
                  minBottom={130}
                  maxBottom={460}
                  topClassName="bg-bg-primary"
                  bottomClassName="overflow-hidden bg-bg-secondary/30"
                  top={(
                    <div className="relative h-full min-h-0 min-w-0 flex flex-col">
                      <PreviewPlayer
                        isAnalyzing={effectiveIsAnalyzing}
                        isPlaying={isPlaying}
                        sessionMatch={sessionMatch}
                        onPlayPause={handlePlayPause}
                        isPortrait={isPortrait}
                        overlayContent={effectiveIsAnalyzing && effectiveIsScanning ? (
                          <div className="absolute inset-0 bg-bg-secondary/20 pointer-events-none">
                            <DataStreamViz
                              isCollecting={true}
                              tickCount={effectiveProgress?.totalTicks ?? analysisStatus?.total_ticks ?? 0}
                              hz={4}
                              label={activeProject?.name ?? ''}
                            />
                          </div>
                        ) : null}
                      />
                    </div>
                  )}
                  bottom={(
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
                  )}
                />
              </div>

              {/* Right panel: Cameras / Drivers */}
              <AnalysisRightPanel
                isConnected={isConnected}
                isAnalyzing={effectiveIsAnalyzing}
                replayState={replayState}
                cameraGroups={cameraGroups}
                drivers={drivers}
                rightPanelWidth={rightPanelWidth}
                setRightPanelWidth={setRightPanelWidth}
                isPortrait={isPortrait}
                handleSwitchCamera={handleSwitchCamera}
                handleSwitchDriver={handleSwitchDriver}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
})
