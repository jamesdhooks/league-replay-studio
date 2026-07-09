import { useEffect, useMemo, useState, useRef, useCallback } from 'react'
import { useCapture } from '../../context/CaptureContext'
import { useScriptState, CAPTURE_MODES } from '../../context/ScriptStateContext'
import { useToast } from '../../context/ToastContext'
import { useSettings } from '../../context/SettingsContext'
import CollapsibleControlsHeader from '../ui/CollapsibleControlsHeader'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { apiGet } from '../../services/api'
import {
  Video, Play, Square, RotateCcw, CheckCircle2, XCircle,
  AlertTriangle, Monitor, Keyboard, FolderOpen, Clock,
  HardDrive, Zap, RefreshCw, FileVideo, ScrollText, Maximize2, Filter, Crosshair,
} from 'lucide-react'
import ClipsPanel from './ClipsPanel'
import ScriptLockBanner from './ScriptLockBanner'
import CaptureRangeSelector from './CaptureRangeSelector'
import TrashBin from './TrashBin'
import ResizableSidebar from '../layout/ResizableSidebar'
import ResizableRowPane from '../ui/ResizableRowPane'
import CollapsibleSection from '../ui/CollapsibleSection'
import PreviewPlayer from '../analysis/PreviewPlayer'
import ProjectFileBrowser from '../projects/ProjectFileBrowser'
import {
  CAPTURE_RESOLUTION_OPTIONS,
  DEFAULT_CAPTURE_RESOLUTION_ID,
  isCaptureResolutionId,
} from '../../utils/captureResolutions'

const VALID_CAPTURE_MODES = new Set(Object.values(CAPTURE_MODES))
const CAPTURE_MODE_META = {
  [CAPTURE_MODES.ALL]: {
    label: 'Capture All',
    desc: 'Capture all script segments',
    icon: Maximize2,
  },
  [CAPTURE_MODES.UNCAPTURED_ONLY]: {
    label: 'Uncaptured Only',
    desc: 'Only segments not yet captured',
    icon: Filter,
  },
  [CAPTURE_MODES.SPECIFIC]: {
    label: 'Specific Segments',
    desc: 'Choose individual segments',
    icon: Crosshair,
  },
  [CAPTURE_MODES.TIME_RANGE]: {
    label: 'Time Range',
    desc: 'Capture within a time window',
    icon: Clock,
  },
}

function readCachedCaptureMode(projectId) {
  if (!projectId) return null
  try {
    const cached = globalThis.localStorage?.getItem(`lrs:capture-mode:${projectId}`)
    return VALID_CAPTURE_MODES.has(cached) ? cached : null
  } catch {
    return null
  }
}

function writeCachedCaptureMode(projectId, mode) {
  if (!projectId || !VALID_CAPTURE_MODES.has(mode)) return
  try {
    globalThis.localStorage?.setItem(`lrs:capture-mode:${projectId}`, mode)
  } catch {
    // Ignore storage failures (private mode/quota), backend remains source of truth.
  }
}

/**
 * CapturePanel — Video capture orchestration UI.
 *
 * Shows: software detection, hotkey configuration status, test button,
 * capture start/stop controls, real-time progress, and post-capture validation.
 *
 * @param {Object} props
 * @param {number} props.projectId - Active project ID
 */
export default function CapturePanel({ projectId, script, totalDuration }) {
  const {
    software, activeSoftware, hotkeys, watchDir,
    captureState, elapsedSeconds, filePath, fileSize, error, testResult, loading,
    detectSoftware, testHotkey, stopCapture, resetCapture,
    startScriptCapture, cancelScriptCapture, scriptCaptureRunning, scriptCaptureProgress, scriptCaptureCancelling,
    scriptCaptureStrategies,
    scriptCaptureLog,
    scriptCurrentSegment,
  } = useCapture()
  const { scriptLocked, preferredSegmentIds, fetchState, fetchCaptureMode, updateCaptureMode, updateCaptureSelection } = useScriptState()
  const { showSuccess, showError } = useToast()
  const { settings, updateSetting } = useSettings()
  // Use settings as the immediate source of truth for selected software
  const selectedSoftwareId = settings?.capture_software ?? activeSoftware
  const [captureMode, setCaptureMode] = useState(() => readCachedCaptureMode(projectId) || CAPTURE_MODES.ALL)
  const [captureModeLoaded, setCaptureModeLoaded] = useState(false)
  const [selectedSegmentIds, setSelectedSegmentIds] = useState([])
  const [captureTimeRange, setCaptureTimeRange] = useState(null)
  const [previewPlaying, setPreviewPlaying] = useState(false)
  const [replaySessionTime, setReplaySessionTime] = useState(null)
  const [controlsCollapsed, setControlsCollapsed] = useLocalStorage('lrs:capture:controlsCollapsed', false)
  const [controlsWidth, setControlsWidth] = useLocalStorage('lrs:capture:controlsWidth', 320)
  const [logsWidth, setLogsWidth] = useLocalStorage('lrs:capture:logsWidth', 520)
  const controlsWidthRef = useRef(controlsWidth)
  const logsWidthRef = useRef(logsWidth)
  useEffect(() => { controlsWidthRef.current = controlsWidth }, [controlsWidth])
  useEffect(() => { logsWidthRef.current = logsWidth }, [logsWidth])

  const startControlsResize = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = controlsWidthRef.current
    const onMove = (mv) => {
      const w = Math.max(260, Math.min(460, startW + mv.clientX - startX))
      setControlsWidth(w)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [setControlsWidth])

  const startLogsResize = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = logsWidthRef.current

    const onMove = (mv) => {
      const next = Math.max(360, Math.min(900, startW - (mv.clientX - startX)))
      setLogsWidth(next)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [setLogsWidth])

  // Load script state on mount
  useEffect(() => {
    if (projectId) fetchState(projectId)
  }, [projectId, fetchState])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const state = await apiGet('/iracing/replay/state')
        if (!cancelled && typeof state?.session_time === 'number') {
          setReplaySessionTime(state.session_time)
        }
      } catch {
        if (!cancelled) setReplaySessionTime(null)
      }
    }

    tick()
    const intervalId = setInterval(tick, 200)
    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    let active = true
    if (!projectId) {
      setCaptureModeLoaded(false)
      return undefined
    }

    const cachedMode = readCachedCaptureMode(projectId)
    if (cachedMode) {
      setCaptureMode(cachedMode)
      setCaptureModeLoaded(true)
    } else {
      setCaptureModeLoaded(false)
    }

    console.debug('[CapturePanel] Loading capture mode', { projectId })
    fetchCaptureMode(projectId)
      .then((result) => {
        const mode = typeof result === 'string' ? result : result?.mode
        console.debug('[CapturePanel] Capture mode response', {
          projectId,
          mode,
          raw: result,
        })
        if (active && mode && VALID_CAPTURE_MODES.has(mode)) {
          setCaptureMode(mode)
          writeCachedCaptureMode(projectId, mode)
        }
      })
      .catch((err) => {
        console.warn('[CapturePanel] Failed to load capture mode', {
          projectId,
          error: err?.message || err,
        })
      })
      .finally(() => {
        if (active) setCaptureModeLoaded(true)
      })
    return () => { active = false }
  }, [projectId, fetchCaptureMode])

  useEffect(() => {
    setSelectedSegmentIds(Array.isArray(preferredSegmentIds) ? preferredSegmentIds : [])
  }, [preferredSegmentIds])

  useEffect(() => {
    const validIds = new Set(
      (script || [])
        .filter((segment) => segment?.type !== 'transition')
        .map((segment) => String(segment.id || segment.segment_id || '').trim())
        .filter(Boolean),
    )

    setSelectedSegmentIds((currentIds) => {
      const filteredIds = currentIds.filter((segmentId) => validIds.has(segmentId))
      if (filteredIds.length === currentIds.length) return currentIds
      if (projectId) {
        updateCaptureSelection(projectId, filteredIds).catch(() => {})
      }
      return filteredIds
    })
  }, [projectId, script, updateCaptureSelection])

  // Keep lock-banner segment states in sync while script capture is running.
  useEffect(() => {
    if (!projectId || !scriptCaptureRunning) return undefined
    const intervalId = setInterval(() => {
      fetchState(projectId)
    }, 1000)
    return () => clearInterval(intervalId)
  }, [projectId, scriptCaptureRunning, fetchState])

  const isCaptureMode = scriptCaptureRunning || captureState === 'capturing'
  const captureResolution = isCaptureResolutionId(settings?.capture_resolution)
    ? settings.capture_resolution
    : DEFAULT_CAPTURE_RESOLUTION_ID

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleTest = async () => {
    const result = await testHotkey()
    if (result.success) {
      showSuccess('Hotkey test passed — recording detected')
    } else {
      showError(result.errors?.[0] || result.error || 'Hotkey test failed')
    }
  }

  const handleStart = async () => {
    if (!projectId || !Array.isArray(script) || script.length === 0) {
      showError('No script available for scripted capture')
      return
    }

    if (captureMode === 'specific_segments' && (!selectedSegmentIds || selectedSegmentIds.length === 0)) {
      showError('Select at least one segment in Specific Segments mode')
      return
    }

    const options = {
      captureMode,
      segmentIds: captureMode === 'specific_segments' ? selectedSegmentIds : null,
      timeRange: captureMode === 'time_range' ? captureTimeRange : null,
      captureResolution,
    }

    const result = await startScriptCapture(projectId, script, options)
    if (result?.accepted) {
      showSuccess('Script capture started')
      return
    }

    showError(result?.error || 'Failed to start script capture')
  }

  const handleStop = async () => {
    const result = await stopCapture()
    if (result.success) {
      showSuccess('Capture completed — file validated')
    } else {
      showError(result.error || 'Capture stopped with errors')
    }
  }

  const handleReset = async () => {
    await resetCapture()
  }

  const handleRefresh = async () => {
    await detectSoftware()
  }

  const SW_LABELS = { obs: 'OBS Studio', shadowplay: 'NVIDIA ShadowPlay', relive: 'AMD ReLive', native: 'LRS Native', manual: 'Manual' }
  const SW_DESCS = {
    obs: 'Full-featured broadcast & recording software',
    shadowplay: 'Low-overhead hardware-accelerated capture (GeForce)',
    relive: 'Hardware capture for AMD GPUs',
    native: 'Built-in C++ capture engine (DXGI/WGC, no 3rd-party software needed)',
    manual: 'Record yourself and provide the file — LRS handles the rest',
  }

  const handleSelectSoftware = async (swId) => {
    try {
      await updateSetting('capture_software', swId)
      detectSoftware() // fire-and-forget to refresh running state
      showSuccess(`Capture method set to ${SW_LABELS[swId] ?? swId}`)
    } catch (err) {
      showError(err.message || 'Failed to update capture method')
    }
  }

  const handleCaptureResolutionChange = async (resolutionId) => {
    if (!isCaptureResolutionId(resolutionId)) return
    try {
      await updateSetting('capture_resolution', resolutionId)
      const preset = CAPTURE_RESOLUTION_OPTIONS.find(option => option.id === resolutionId)
      showSuccess(`Capture resolution set to ${preset?.label ?? resolutionId}`)
    } catch (err) {
      showError(err.message || 'Failed to update capture resolution')
    }
  }

  const handleCaptureModeChange = async (mode) => {
    const prevMode = captureMode
    setCaptureMode(mode)
    writeCachedCaptureMode(projectId, mode)
    if (!projectId) return
    try {
      const persisted = await updateCaptureMode(projectId, mode)
      console.debug('[CapturePanel] Capture mode persisted', {
        projectId,
        prevMode,
        requestedMode: mode,
        persisted,
      })
    } catch (err) {
      console.warn('[CapturePanel] Capture mode persistence failed', {
        projectId,
        prevMode,
        requestedMode: mode,
        error: err?.message || err,
      })
      // Keep UI responsive even if persistence fails; error is surfaced by context.
    }
  }

  const handleSegmentIdsChange = async (segmentIds) => {
    const nextSegmentIds = Array.isArray(segmentIds) ? segmentIds : []
    setSelectedSegmentIds(nextSegmentIds)
    console.debug('[CapturePanel] Specific segment selection changed', {
      projectId,
      selectedCount: nextSegmentIds.length,
      selectedIds: nextSegmentIds,
    })
    if (!projectId) return
    try {
      await updateCaptureSelection(projectId, nextSegmentIds)
    } catch {
      // Keep UI responsive even if persistence fails; error is surfaced by context.
    }
  }

  const togglePreviewPlayback = useCallback(() => {
    setPreviewPlaying(prev => !prev)
  }, [])

  const previewTopbarAction = useMemo(() => {
    if (scriptCaptureRunning) {
      return {
        label: scriptCaptureCancelling ? 'Cancelling…' : 'Cancel',
        icon: Square,
        onClick: cancelScriptCapture,
        disabled: loading || scriptCaptureCancelling,
        className: 'bg-danger/12 text-danger border-danger/30 hover:bg-danger/18',
      }
    }
    if (captureState === 'capturing') {
      return {
        label: 'Stop',
        icon: Square,
        onClick: handleStop,
        disabled: loading,
        className: 'bg-danger/12 text-danger border-danger/30 hover:bg-danger/18',
      }
    }
    if (captureState === 'completed') {
      return {
        label: 'Reset',
        icon: RotateCcw,
        onClick: handleReset,
        disabled: false,
        className: 'bg-bg-primary text-text-primary border-border hover:bg-bg-hover',
      }
    }
    return {
      label: 'Start Capture',
      icon: Play,
      onClick: handleStart,
      disabled: loading || captureState === 'testing',
      className: 'bg-accent/12 text-accent border-accent/30 hover:bg-accent/18',
    }
  }, [scriptCaptureRunning, scriptCaptureCancelling, cancelScriptCapture, captureState, loading, handleStop, handleReset, handleStart])

  const captureStatusBadge = useMemo(() => {
    const config = {
      idle: { label: 'Idle', className: 'text-text-tertiary bg-bg-primary border-border' },
      testing: { label: 'Testing', className: 'text-warning bg-warning/8 border-warning/35' },
      ready: { label: 'Ready', className: 'text-success bg-success/8 border-success/35' },
      capturing: { label: 'Recording', className: 'text-danger bg-danger/8 border-danger/35' },
      validating: { label: 'Validating', className: 'text-accent bg-accent/8 border-accent/35' },
      completed: { label: 'Completed', className: 'text-success bg-success/8 border-success/35' },
      error: { label: 'Error', className: 'text-danger bg-danger/8 border-danger/35' },
    }
    return config[captureState] || config.idle
  }, [captureState])

  const PreviewTopbarActionIcon = previewTopbarAction.icon

  const setupOptionsDisabled = isCaptureMode

  const scriptSidebarContent = (
    <div className="h-full p-3 bg-bg-primary">
      <ScriptLockBanner
        projectId={projectId}
        script={script}
        onLock={() => fetchState(projectId)}
        onUnlock={() => fetchState(projectId)}
        strategies={scriptCaptureStrategies}
        currentSegmentId={scriptCurrentSegment?.segment_id || null}
        captureLog={scriptCaptureLog}
        isExecuting={scriptCaptureRunning}
      />
    </div>
  )

  const setupSidebarContent = (
    <div className="h-full overflow-y-auto space-y-0 bg-bg-secondary">
      {/* ── Error Display ─────────────────────────────────────────── */}
      {error && captureState === 'error' && (
        <div className="mx-2 mt-2 flex items-start gap-2 px-2.5 py-2 bg-danger/5 border border-danger/30 rounded-md">
          <XCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
          <div>
            <p className="text-xs text-danger font-medium">Error</p>
            <p className="text-xxs text-danger/80 mt-0.5">{error}</p>
          </div>
        </div>
      )}

      <div className="border-t border-border-subtle shrink-0">
        <div className="px-2 py-2">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center justify-center rounded-md border px-3 py-2.5 text-sm font-semibold whitespace-nowrap ${captureStatusBadge.className}`}>
              {captureStatusBadge.label}
            </span>
            <button
              onClick={previewTopbarAction.onClick}
              disabled={previewTopbarAction.disabled}
              className={`flex-1 inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${previewTopbarAction.className}`}
            >
              <PreviewTopbarActionIcon className="w-4 h-4" />
              {previewTopbarAction.label}
            </button>
          </div>
        </div>
      </div>

      {scriptLocked && script?.length > 0 && (
        <Section icon={Video} title="Capture Mode">
          <div className="space-y-1.5">
            {!captureModeLoaded ? (
              <div className="text-xxs text-text-tertiary">Loading capture preferences...</div>
            ) : (
              <>
                {Object.entries(CAPTURE_MODE_META).map(([modeKey, meta]) => {
                  const Icon = meta.icon
                  const isSelected = captureMode === modeKey
                  return (
                    <button
                      key={modeKey}
                      onClick={() => handleCaptureModeChange(modeKey)}
                      disabled={setupOptionsDisabled}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md border transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed
                        ${ isSelected
                          ? 'border-accent/50 bg-accent/10 ring-1 ring-accent/20'
                          : 'border-border-subtle bg-bg-primary hover:border-border hover:bg-bg-hover'
                        }`}
                    >
                      <Icon className={`w-4 h-4 shrink-0 ${isSelected ? 'text-accent' : 'text-text-tertiary'}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-text-primary">{meta.label}</div>
                        <div className="text-xxs text-text-tertiary truncate">{meta.desc}</div>
                      </div>
                      {isSelected && <span className="text-xxs font-medium text-accent">Active</span>}
                    </button>
                  )
                })}

                <div className={setupOptionsDisabled ? 'opacity-60 pointer-events-none' : ''}>
                  <CaptureRangeSelector
                    projectId={projectId}
                    script={script}
                    totalDuration={totalDuration || 0}
                    initialMode={captureMode}
                    onModeChange={handleCaptureModeChange}
                    onRangeChange={setCaptureTimeRange}
                    selectedSegmentIds={selectedSegmentIds}
                    onSegmentIdsChange={handleSegmentIdsChange}
                    showModeSelector={false}
                    disabled={setupOptionsDisabled}
                  />
                </div>
              </>
            )}
          </div>
        </Section>
      )}

      <Section icon={FileVideo} title="Capture Resolution">
        <div className="grid grid-cols-2 gap-1.5">
          {CAPTURE_RESOLUTION_OPTIONS.map((option) => {
            const isSelected = captureResolution === option.id
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => handleCaptureResolutionChange(option.id)}
                disabled={setupOptionsDisabled}
                className={`rounded-md border px-2.5 py-2 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                  ${isSelected
                    ? 'border-accent/50 bg-accent/10 ring-1 ring-accent/20'
                    : 'border-border-subtle bg-bg-primary hover:border-border hover:bg-bg-hover'
                  }`}
              >
                <div className="text-xs font-semibold text-text-primary">{option.label}</div>
                <div className="text-xxs text-text-tertiary">{option.detail}</div>
              </button>
            )
          })}
        </div>
      </Section>

      <TrashBin projectId={projectId} />

      <Section icon={Monitor} title="Capture Software">
            <div className="space-y-2">
              {software.length > 0 ? (
                software.map(sw => {
                  const isSelected = sw.id === selectedSoftwareId
                  return (
                    <button
                      key={sw.id}
                      onClick={() => handleSelectSoftware(sw.id)}
                      disabled={setupOptionsDisabled}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md border transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed
                        ${ isSelected
                          ? 'border-accent/50 bg-accent/10 ring-1 ring-accent/20'
                          : 'border-border-subtle bg-bg-primary hover:border-border hover:bg-bg-hover'
                        }`}
                    >
                      {sw.running ? (
                        <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
                      ) : (
                        <XCircle className="w-4 h-4 text-text-disabled shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-text-primary">{SW_LABELS[sw.id] ?? sw.label}</div>
                        <div className="text-xxs text-text-tertiary truncate">
                          {sw.detected_process
                            ? `Detected ${sw.detected_process}`
                            : (SW_DESCS[sw.id] ?? (sw.running ? 'Ready' : 'Not detected'))}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-0.5 shrink-0">
                        {isSelected && <span className="text-xxs font-medium text-accent">Active</span>}
                        <span className={`text-xxs ${sw.running ? 'text-success' : 'text-text-disabled'}`}>
                          {sw.running ? 'Ready' : 'Not found'}
                        </span>
                      </div>
                    </button>
                  )
                })
              ) : (
                <div className="text-xs text-text-tertiary italic">
                  No capture software detected. Install OBS Studio, NVIDIA ShadowPlay, or AMD ReLive.
                </div>
              )}
              <button
                onClick={handleRefresh}
                disabled={setupOptionsDisabled}
                className="flex items-center gap-1.5 px-2 py-1 rounded text-xxs text-text-secondary disabled:opacity-50 disabled:cursor-not-allowed
                           hover:text-text-primary hover:bg-bg-hover transition-colors"
              >
                <RefreshCw className="w-3 h-3" />
                Refresh
              </button>
            </div>
      </Section>

      <Section icon={Keyboard} title="Hotkey Configuration">
            <div className="space-y-2">
              <KeyDisplay label="Start Recording" value={hotkeys.start} />
              <KeyDisplay label="Stop Recording" value={hotkeys.stop || hotkeys.start || '(same as start)'} />
              <p className="text-xxs text-text-tertiary">
                Configure hotkeys in Settings → Capture tab.
              </p>
            </div>
          </Section>

      <Section icon={FolderOpen} title="Output Directory">
            <div className="text-xs text-text-secondary font-mono truncate" title={watchDir || 'Not configured'}>
              {watchDir || 'Not configured — set in Settings'}
            </div>
      </Section>

      <Section icon={Zap} title="Hotkey Validation">
            <div className="space-y-2">
              <p className="text-xxs text-text-tertiary">
                Test sends the start hotkey, checks for a new recording file, then sends stop.
                Make sure your capture software is running first.
              </p>
              <button
                onClick={handleTest}
                disabled={setupOptionsDisabled || loading || captureState === 'testing'}
                className={`w-full flex items-center justify-center gap-2 px-2.5 py-1.5 rounded-md text-xxs
                  font-medium transition-colors
                  ${setupOptionsDisabled || loading || captureState === 'testing'
                    ? 'bg-bg-primary text-text-disabled cursor-wait border border-border'
                    : 'bg-bg-primary text-text-primary hover:bg-bg-hover border border-border'
                  }`}
              >
                <Zap className="w-3.5 h-3.5" />
                {captureState === 'testing' ? 'Testing…' : 'Test Hotkey'}
              </button>

              {testResult && (
                <TestResultDisplay result={testResult} />
              )}
            </div>
      </Section>
    </div>
  )

  const sidebarTabs = [
    {
      id: 'script',
      label: 'Script',
      icon: ScrollText,
      content: scriptSidebarContent,
    },
    {
      id: 'files',
      label: 'Files',
      icon: FolderOpen,
      content: <ProjectFileBrowser projectId={projectId} />,
    },
  ]

  return (
    <div className="flex flex-col flex-1 w-full h-full overflow-hidden min-h-0">
      {/* Content — preview-first workspace */}
      <div className="flex-1 min-h-0 bg-bg-primary overflow-hidden">
        <div className="w-full h-full min-h-0 max-w-[2200px] mx-auto">
          <div className="w-full h-full min-h-0 flex overflow-hidden">
            <ResizableSidebar
              storageKey="lrs:capture:workspace:sidebar"
              defaultWidth={420}
              defaultTab="script"
              tabs={sidebarTabs}
            />

            {controlsCollapsed && (
              <CollapsibleControlsHeader
                collapsed
                icon={Monitor}
                title="Capture Controls"
                onExpand={() => setControlsCollapsed(false)}
                expandTitle="Expand Capture Controls"
              />
            )}

            {!controlsCollapsed && (
              <div
                className="shrink-0 border-r border-border bg-bg-secondary flex flex-col min-h-0"
                style={{ width: controlsWidth }}
              >
                <CollapsibleControlsHeader
                  collapsed={false}
                  icon={Monitor}
                  title="Capture Controls"
                  onCollapse={() => setControlsCollapsed(true)}
                />

                <div className="flex-1 min-h-0 overflow-hidden">
                  {setupSidebarContent}
                </div>
              </div>
            )}

            {!controlsCollapsed && (
              <div
                className="shrink-0 cursor-col-resize group/divider relative"
                style={{ width: 1, marginLeft: -1 }}
                onMouseDown={startControlsResize}
              >
                <div className="absolute inset-y-0 -left-2 -right-2 z-20" />
                <div className="absolute inset-y-0 left-0 w-px bg-border transition-colors group-hover/divider:bg-accent group-active/divider:bg-accent" />
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-hidden flex flex-col lg:flex-row">
              <div className="flex-1 min-h-0 overflow-hidden">
                <ResizableRowPane
                  storageKey="lrs:capture:workspace:timelineHeight"
                  defaultBottomHeight={260}
                  minBottom={140}
                  maxBottom={520}
                  topClassName="bg-bg-primary"
                  bottomClassName="overflow-hidden bg-bg-secondary/30"
                  top={(
                    <div className="h-full min-h-0 flex flex-col">
                      <div className="flex-1 min-h-0">
                        <PreviewPlayer
                          isAnalyzing={false}
                          isPlaying={previewPlaying}
                          onPlayPause={togglePreviewPlayback}
                          isPortrait={false}
                        />
                      </div>
                    </div>
                  )}
                  bottom={(
                    <div className="h-full min-h-0 overflow-hidden">
                      <ClipsPanel
                        projectId={projectId}
                        replaySessionTime={replaySessionTime}
                        showActionLog={false}
                        showClips={false}
                        showCompiled={false}
                        showProgress={false}
                        showScriptError={false}
                        showLatestFailure={false}
                      />
                    </div>
                  )}
                />
              </div>

              <div
                className="hidden lg:block shrink-0 cursor-col-resize group/divider relative"
                style={{ width: 1, marginLeft: -1 }}
                onMouseDown={startLogsResize}
              >
                <div className="absolute inset-y-0 -left-2 -right-2 z-20" />
                <div className="absolute inset-y-0 left-0 w-px bg-border transition-colors group-hover/divider:bg-accent group-active/divider:bg-accent" />
              </div>

              <div
                className="shrink-0 min-h-[280px] lg:min-h-0 overflow-hidden lg:w-[var(--capture-logs-width)]"
                style={{ '--capture-logs-width': `${logsWidth}px` }}
              >
                <div className="h-full min-h-0">
                  <ClipsPanel
                    projectId={projectId}
                    fullHeight
                    showTimeline={false}
                    showSegmentLog={false}
                    showActionLog
                    showClips
                    showCompiled
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


// ── Helper components ──────────────────────────────────────────────────────

function Section({ icon: Icon, title, children }) {
  const storageKey = `lrs:capture:section:${String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

  return (
    <CollapsibleSection
      icon={Icon}
      label={title}
      storageKey={storageKey}
      defaultOpen
    >
      {children}
    </CollapsibleSection>
  )
}


function KeyDisplay({ label, value }) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5 bg-bg-primary border border-border rounded">
      <span className="text-xxs text-text-tertiary">{label}</span>
      <kbd className="px-1.5 py-0.5 bg-bg-secondary border border-border rounded text-xxs font-mono text-text-primary">
        {value || 'Not set'}
      </kbd>
    </div>
  )
}


function MetricBox({ icon: Icon, label, value }) {
  return (
    <div className="bg-bg-secondary rounded px-2.5 py-1.5">
      <div className="flex items-center gap-1 mb-0.5">
        <Icon className="w-3 h-3 text-text-disabled" />
        <span className="text-xxs text-text-tertiary">{label}</span>
      </div>
      <span className="text-sm font-mono text-text-primary">{value}</span>
    </div>
  )
}


function TestResultDisplay({ result }) {
  if (!result) return null

  return (
    <div className={`rounded-md border p-2.5 space-y-1
      ${result.success
        ? 'bg-success/5 border-success/30'
        : 'bg-danger/5 border-danger/30'
      }`}
    >
      <div className="flex items-center gap-1.5">
        {result.success ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-success" />
        ) : (
          <XCircle className="w-3.5 h-3.5 text-danger" />
        )}
        <span className={`text-xs font-medium ${result.success ? 'text-success' : 'text-danger'}`}>
          {result.success ? 'Test Passed' : 'Test Failed'}
        </span>
      </div>

      {result.software_running !== undefined && (
        <div className="text-xxs text-text-tertiary">
          Software: {result.software_running ? '✓ Running' : '✗ Not running'}
        </div>
      )}

      {result.file_detected !== undefined && (
        <div className="text-xxs text-text-tertiary">
          Recording file: {result.file_detected ? '✓ Detected' : '✗ Not detected'}
        </div>
      )}

      {result.detected_file && (
        <div className="text-xxs text-text-tertiary font-mono">
          File: {result.detected_file}
        </div>
      )}

      {result.note && (
        <div className="text-xxs text-text-tertiary italic">{result.note}</div>
      )}

      {result.errors?.map((err, i) => (
        <div key={i} className="text-xxs text-danger">{err}</div>
      ))}
    </div>
  )
}
