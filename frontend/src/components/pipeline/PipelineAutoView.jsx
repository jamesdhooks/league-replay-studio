import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
  Play,
  Pause,
  Square,
  RotateCcw,
  SkipForward,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  AlertTriangle,
  Rocket,
  Video,
  BarChart2,
  Scissors,
  Clapperboard,
  Upload as UploadIcon,
  Youtube,
  ShieldCheck,
  RefreshCcw,
} from 'lucide-react'
import { usePipeline } from '../../context/PipelineContext'
import { useProject } from '../../context/ProjectContext'
import { useToast } from '../../context/ToastContext'
import { useAnalysis } from '../../context/AnalysisContext'
import { useCapture } from '../../context/CaptureContext'
import { useComposition } from '../../context/CompositionContext'
import { useEncoding } from '../../context/EncodingContext'
import { useYouTube } from '../../context/YouTubeContext'
import LogViewer from '../ui/LogViewer'
import {
  normalizeAnalysisLogEntries,
  normalizeCaptureLogEntries,
  normalizeCompositionLogEntries,
  normalizeEncodingLogEntries,
  normalizePipelineLogEntries,
  normalizeUploadEntries,
} from '../../utils/logEntries'

// ── Step metadata ────────────────────────────────────────────────────────────

const STEP_META = [
  { id: 'analysis', label: 'Analysis', icon: BarChart2,    desc: 'Detect race events' },
  { id: 'editing',  label: 'Editing',  icon: Scissors,     desc: 'Apply highlight config' },
  { id: 'capture',  label: 'Capture',  icon: Video,       desc: 'Record replay video' },
  { id: 'compose',  label: 'Compose',  icon: Clapperboard, desc: 'Trim, overlay & stitch clips' },
  { id: 'export',   label: 'Export',   icon: UploadIcon,   desc: 'Encode for delivery' },
  { id: 'upload',   label: 'Upload',   icon: Youtube,      desc: 'Upload to YouTube' },
]

function areValuesEqual(a, b) {
  if (a === b) return true
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}

function computeAugmentations(overrides = {}, preset = null) {
  if (!overrides || typeof overrides !== 'object') return {}
  const out = {}
  Object.entries(overrides).forEach(([key, value]) => {
    const base = preset ? preset[key] : undefined
    if (!areValuesEqual(value, base)) {
      out[key] = value
    }
  })
  return out
}

function formatFileName(filePath) {
  if (!filePath) return ''
  const normalized = String(filePath).replace(/\\+/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] || normalized
}

function extractPathsFromText(text) {
  if (!text || typeof text !== 'string') return []
  const matches = text.match(/[A-Za-z]:\\[^\r\n"']+/g) || []
  return matches.filter((candidate) => /\.[A-Za-z0-9]{2,8}$/.test(candidate.trim()))
}

function collectPathsFromValue(value, out) {
  if (!value) return
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/[\\/]/.test(trimmed) && /\.[A-Za-z0-9]{2,8}$/.test(trimmed)) {
      out.push(trimmed)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectPathsFromValue(item, out))
    return
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectPathsFromValue(item, out))
  }
}

// ── Step state helpers ───────────────────────────────────────────────────────

function stepStateIcon(step) {
  const state = step?.state
  if (state === 'completed') return <CheckCircle2 className="w-4 h-4 text-success" />
  if (state === 'failed')    return <XCircle className="w-4 h-4 text-danger" />
  if (state === 'running')   return <Loader2 className="w-4 h-4 text-accent animate-spin" />
  if (state === 'skipped')   return <SkipForward className="w-4 h-4 text-text-disabled" />
  if (state === 'paused')    return <Pause className="w-4 h-4 text-warning" />
  return <Clock className="w-4 h-4 text-text-disabled" />
}

function stepBorderClass(step, isCurrent) {
  const state = step?.state
  if (isCurrent && state === 'running') return 'border-accent/50 bg-accent/5'
  if (state === 'completed')            return 'border-success/30 bg-success/3'
  if (state === 'failed')               return 'border-danger/40 bg-danger/5'
  if (state === 'paused')               return 'border-warning/40 bg-warning/5'
  return 'border-border bg-bg-secondary/40'
}

// ── Preset / start config ────────────────────────────────────────────────────

function StartConfig({
  presets,
  selectedPreset,
  onPresetChange,
  enabledSteps,
  onToggleStep,
  onStart,
  disabled,
  dirtyAugmentations,
}) {
  const dirtyCount = Object.keys(dirtyAugmentations || {}).length
  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">
          Execution Preset
        </label>
        <select
          value={selectedPreset?.id || ''}
          onChange={(e) => {
            const p = presets.find(p => p.id === e.target.value) || null
            onPresetChange(p)
          }}
          className="w-full px-3 py-2 bg-bg-primary border border-border rounded-lg text-xs
                     text-text-primary focus:outline-none focus:border-accent"
        >
          <option value="">— Default config —</option>
          {presets.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {selectedPreset && (
          <p className="mt-1 text-xxs text-text-tertiary">{selectedPreset.description}</p>
        )}
        {dirtyCount > 0 && (
          <p className="mt-1 text-xxs text-warning">
            {dirtyCount} local augmentation{dirtyCount !== 1 ? 's' : ''} relative to this preset
          </p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-xxs font-semibold uppercase tracking-wider text-text-tertiary">Execution Path</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {STEP_META.map(({ id, label, icon: Icon, desc }) => {
            const enabled = enabledSteps[id]
            return (
              <button
                key={id}
                type="button"
                onClick={() => onToggleStep(id)}
                className={`p-3 rounded-xl border text-left transition-all duration-150 ${
                  enabled
                    ? 'border-accent/40 bg-accent/5 hover:bg-accent/10'
                    : 'border-border bg-bg-secondary/40 opacity-50 hover:opacity-70'
                }`}
                title={enabled ? 'Click to disable' : 'Click to enable'}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className={`p-1.5 rounded-lg ${
                    enabled ? 'bg-accent/10 text-accent' : 'bg-bg-primary text-text-disabled'
                  }`}>
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  <span className={`text-[10px] font-semibold uppercase tracking-wide ${
                    enabled ? 'text-accent' : 'text-text-disabled'
                  }`}>
                    {enabled ? 'on' : 'off'}
                  </span>
                </div>
                <p className="text-xxs font-semibold text-text-primary">{label}</p>
                <p className="text-xxs text-text-tertiary mt-0.5 leading-tight">{desc}</p>
              </button>
            )
          })}
        </div>
        <p className="text-xxs text-text-tertiary">If you disable a step, execution stops at the last enabled stage.</p>
      </div>

      <button
        onClick={onStart}
        disabled={disabled}
        className="flex items-center justify-center gap-2 w-full px-5 py-3 bg-accent
                   hover:bg-accent-hover text-white rounded-xl font-semibold text-sm
                   transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                   shadow-md shadow-accent/20"
      >
        <Rocket className="w-4 h-4" />
        Run Pipeline
      </button>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

/**
 * PipelineAutoView — Unified automated pipeline surface.
 *
 * In simple mode this is shown centered in the main canvas.
 * In advanced mode this same surface is shown docked as a footer.
 */
export default function PipelineAutoView({ docked = false }) {
  const {
    currentRun,
    isRunning,
    isPaused,
    canResume,
    currentStep,
    steps,
    logEntries,
    presets,
    startPipeline,
    runPreflight,
    pausePipeline,
    resumePipeline,
    cancelPipeline,
    retryStep,
    skipStep,
    resetPipeline,
    getProjectControlState,
    saveProjectControlState,
    projectControlStateMap,
    loading,
  } = usePipeline()
  const { analysisLog } = useAnalysis()
  const { scriptCaptureLog } = useCapture()
  const { activeJob: activeCompositionJob, recentJobs: recentCompositionJobs, logEntries: compositionLogEntries } = useComposition()
  const { activeJobs: activeEncodingJobs, recentJobs: recentEncodingJobs } = useEncoding()
  const { activeUpload, uploadHistory } = useYouTube()

  const { currentProject, setStep } = useProject()
  const { showSuccess, showError, showWarning } = useToast()

  const [selectedPreset, setSelectedPreset] = useState(null)
  const [enabledSteps, setEnabledSteps] = useState({
    analysis: true,
    editing: true,
    capture: true,
    compose: true,
    export: true,
    upload: true,
  })
  const [preflightIssues, setPreflightIssues] = useState(null) // null = not checked yet
  const [preflightChecking, setPreflightChecking] = useState(false)
  const logEndRef = useRef(null)
  const logContainerRef = useRef(null)

  // Keep preset + project overrides synced across topbar and auto view.
  useEffect(() => {
    if (!currentProject?.id) return
    getProjectControlState(currentProject.id).catch(() => {})
  }, [currentProject?.id, getProjectControlState])

  const activeControlState = useMemo(() => {
    if (!currentProject?.id) return null
    return projectControlStateMap[currentProject.id] || null
  }, [currentProject?.id, projectControlStateMap])

  const activeOverrides = activeControlState?.overrides || {}

  useEffect(() => {
    if (!currentProject?.id) return
    if (!activeControlState) return

    const preset = presets.find(p => p.id === (activeControlState.preset_id || '')) || null
    setSelectedPreset(preset)

    const o = activeOverrides
    setEnabledSteps({
      analysis: !o.skip_analysis,
      editing: o.auto_edit !== false,
      capture: !o.skip_capture,
      compose: !o.skip_compose,
      export: !o.skip_export,
      upload: o.upload_to_youtube !== false,
    })
  }, [currentProject?.id, activeControlState, activeOverrides, presets])

  const dirtyAugmentations = useMemo(
    () => computeAugmentations(activeOverrides, selectedPreset),
    [activeOverrides, selectedPreset],
  )

  const activeEncodingJob = useMemo(() => {
    const projectId = currentProject?.id
    if (!projectId) return null
    return activeEncodingJobs.find((job) => job.project_id === projectId)
      || recentEncodingJobs.find((job) => job.project_id === projectId)
      || null
  }, [currentProject?.id, activeEncodingJobs, recentEncodingJobs])

  const activeCompositionLogEntries = useMemo(() => {
    const projectId = currentProject?.id
    if (!projectId) return []
    if (activeCompositionJob?.project_id === projectId && Array.isArray(compositionLogEntries) && compositionLogEntries.length > 0) {
      return compositionLogEntries
    }
    const recent = recentCompositionJobs.find((job) => job.project_id === projectId)
    return recent?.log_entries || []
  }, [currentProject?.id, activeCompositionJob, compositionLogEntries, recentCompositionJobs])

  const dynamicLogSource = useMemo(() => {
    switch (currentStep) {
      case 'analysis': {
        const entries = normalizeAnalysisLogEntries(analysisLog)
        return { label: 'analysis', entries: entries.length > 0 ? entries : normalizePipelineLogEntries(logEntries).filter((entry) => entry.step === 'analysis') }
      }
      case 'capture': {
        const entries = normalizeCaptureLogEntries(scriptCaptureLog)
        return { label: 'capture', entries: entries.length > 0 ? entries : normalizePipelineLogEntries(logEntries).filter((entry) => entry.step === 'capture') }
      }
      case 'compose': {
        const entries = normalizeCompositionLogEntries(activeCompositionLogEntries)
        return { label: 'compose', entries: entries.length > 0 ? entries : normalizePipelineLogEntries(logEntries).filter((entry) => entry.step === 'compose') }
      }
      case 'export': {
        const entries = normalizeEncodingLogEntries(activeEncodingJob?.log_entries || [])
        return { label: 'export', entries: entries.length > 0 ? entries : normalizePipelineLogEntries(logEntries).filter((entry) => entry.step === 'export') }
      }
      case 'upload': {
        const entries = normalizeUploadEntries(activeUpload, uploadHistory)
        return { label: 'upload', entries: entries.length > 0 ? entries : normalizePipelineLogEntries(logEntries).filter((entry) => entry.step === 'upload') }
      }
      case 'editing':
      default:
        return { label: 'pipeline', entries: normalizePipelineLogEntries(logEntries) }
    }
  }, [
    currentStep,
    analysisLog,
    scriptCaptureLog,
    activeCompositionLogEntries,
    activeEncodingJob,
    activeUpload,
    uploadHistory,
    logEntries,
  ])

  const activityLogEntries = dynamicLogSource.entries

  // Auto-scroll log to bottom when new entries arrive
  useEffect(() => {
    if (!logEndRef.current || !logContainerRef.current) return
    const container = logContainerRef.current
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80
    if (isNearBottom) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [activityLogEntries])

  // Overall progress derived from steps — skipped steps are excluded from the
  // denominator so they don't inflate the percentage from the start of a run.
  const overallProgress = useMemo(() => {
    if (!steps || Object.keys(steps).length === 0) return 0
    const stepValues = Object.values(steps).filter(s => s?.state !== 'skipped')
    const total = stepValues.length || 1
    const sum = stepValues.reduce((acc, step) => {
      if (!step) return acc
      if (step.state === 'completed') return acc + 100
      const pct = Number(step.progress || 0)
      return acc + Math.max(0, Math.min(100, pct))
    }, 0)
    return Math.round(sum / total)
  }, [steps])

  // Current step label
  const currentStepLabel = useMemo(() => {
    const meta = STEP_META.find(m => m.id === currentStep)
    return meta?.label || ''
  }, [currentStep])

  // Last log entry for the "latest activity" ticker
  const lastLog = activityLogEntries.length > 0 ? activityLogEntries[activityLogEntries.length - 1] : null

  const createdFiles = useMemo(() => {
    const byPath = new Map()

    const upsert = (pathValue, step = 'pipeline', ts = 0) => {
      const path = String(pathValue || '').trim()
      if (!path) return
      const key = path.toLowerCase()
      const prev = byPath.get(key)
      if (!prev || ts >= prev.ts) {
        byPath.set(key, {
          path,
          step,
          ts,
          name: formatFileName(path),
        })
      }
    }

    Object.entries(steps || {}).forEach(([stepName, stepState]) => {
      const paths = []
      collectPathsFromValue(stepState?.output, paths)
      const ts = Number(stepState?.completed_at || stepState?.started_at || 0)
      paths.forEach((path) => upsert(path, stepName, ts))
    })

    ;(activityLogEntries || []).forEach((entry) => {
      const ts = Number(entry?.ts || 0)
      const step = entry?.step || 'pipeline'
      const text = `${entry?.message || ''} ${entry?.detail || ''}`
      extractPathsFromText(text).forEach((path) => upsert(path, step, ts))
    })

    return Array.from(byPath.values())
      .sort((a, b) => (b.ts - a.ts) || a.path.localeCompare(b.path))
      .slice(0, 80)
  }, [steps, activityLogEntries])

  const normalizeStepExecution = useCallback((sourceEnabled) => {
    const order = STEP_META.map(s => s.id)
    const lastEnabledIdx = Math.max(...order.map((id, idx) => (sourceEnabled[id] ? idx : -1)))
    const normalizedEnabled = {}
    order.forEach((id, idx) => {
      normalizedEnabled[id] = sourceEnabled[id] && idx <= lastEnabledIdx
    })

    const runtimeConfig = {
      skip_analysis: !normalizedEnabled.analysis,
      auto_edit: normalizedEnabled.editing,
      non_interactive: !normalizedEnabled.editing,
      skip_capture: !normalizedEnabled.capture,
      skip_compose: !normalizedEnabled.compose,
      skip_export: !normalizedEnabled.export,
      upload_to_youtube: normalizedEnabled.upload,
    }
    return { normalizedEnabled, runtimeConfig }
  }, [])

  const persistProjectExecutionOverrides = useCallback(async (presetId, nextEnabled) => {
    if (!currentProject?.id) return
    const { normalizedEnabled, runtimeConfig } = normalizeStepExecution(nextEnabled)
    setEnabledSteps(normalizedEnabled)
    await saveProjectControlState(currentProject.id, {
      schema_version: activeControlState?.schema_version || 1,
      preset_id: presetId || '',
      overrides: runtimeConfig,
      controls: activeControlState?.controls || {},
    })
  }, [currentProject?.id, normalizeStepExecution, saveProjectControlState, activeControlState?.schema_version, activeControlState?.controls])

  const handlePresetChange = useCallback(async (presetObj) => {
    if (!currentProject?.id) {
      setSelectedPreset(presetObj)
      return
    }
    setSelectedPreset(presetObj)
    try {
      // Autosave current control-state before switching preset base.
      if (activeControlState) {
        await saveProjectControlState(currentProject.id, {
          schema_version: activeControlState.schema_version || 1,
          preset_id: activeControlState.preset_id || '',
          overrides: activeOverrides,
          controls: activeControlState.controls || {},
        })
      }
      await persistProjectExecutionOverrides(presetObj?.id || '', enabledSteps)
    } catch {
      // non-fatal; local state is still updated
    }
  }, [currentProject?.id, activeControlState, activeOverrides, enabledSteps, persistProjectExecutionOverrides, saveProjectControlState])

  const handleToggleStepEnabled = useCallback(async (stepId) => {
    const nextEnabled = {
      ...enabledSteps,
      [stepId]: !enabledSteps[stepId],
    }
    if (!Object.values(nextEnabled).some(Boolean)) {
      showWarning('At least one step must remain enabled')
      return
    }
    try {
      await persistProjectExecutionOverrides(selectedPreset?.id || '', nextEnabled)
    } catch (err) {
      showError(err.message || 'Failed to save step toggles')
    }
  }, [enabledSteps, persistProjectExecutionOverrides, selectedPreset?.id, showError, showWarning])

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleStart = useCallback(async () => {
    if (!currentProject?.id) {
      showWarning('Please select a project first')
      return
    }
    const { normalizedEnabled, runtimeConfig } = normalizeStepExecution(enabledSteps)
    setEnabledSteps(normalizedEnabled)

    // Run preflight first
    setPreflightChecking(true)
    try {
      const result = await runPreflight({
        projectId: currentProject.id,
        presetId: selectedPreset?.id,
        config: runtimeConfig,
      })
      setPreflightIssues(result.issues || [])
      if (!result.ok) {
        setPreflightChecking(false)
        return // Block start — errors shown in UI
      }
    } catch {
      setPreflightIssues([])
    } finally {
      setPreflightChecking(false)
    }

    try {
      await startPipeline({
        projectId: currentProject.id,
        presetId: selectedPreset?.id,
        config: runtimeConfig,
      })
      setPreflightIssues(null)
      showSuccess('Pipeline started')
    } catch (err) {
      showError(err.message || 'Failed to start pipeline')
    }
  }, [currentProject, selectedPreset, enabledSteps, normalizeStepExecution, runPreflight, startPipeline, showSuccess, showError, showWarning])

  const handlePause = useCallback(async () => {
    try { await pausePipeline(); showSuccess('Pipeline paused') }
    catch (err) { showError(err.message || 'Failed to pause') }
  }, [pausePipeline, showSuccess, showError])

  const handleResume = useCallback(async () => {
    try { await resumePipeline(); showSuccess('Pipeline resumed') }
    catch (err) { showError(err.message || 'Failed to resume') }
  }, [resumePipeline, showSuccess, showError])

  const handleCancel = useCallback(async () => {
    try { await cancelPipeline(); showWarning('Pipeline cancelled') }
    catch (err) { showError(err.message || 'Failed to cancel') }
  }, [cancelPipeline, showWarning, showError])

  const handleRetry = useCallback(async (stepId) => {
    try { await retryStep(stepId); showSuccess(`Retrying ${stepId}`) }
    catch (err) { showError(err.message || 'Retry failed') }
  }, [retryStep, showSuccess, showError])

  const handleSkip = useCallback(async (stepId) => {
    try { await skipStep(stepId); showSuccess(`Skipped ${stepId}`) }
    catch (err) { showError(err.message || 'Skip failed') }
  }, [skipStep, showSuccess, showError])

  const handleReset = useCallback(async () => {
    if (!currentProject?.id) return
    try {
      await resetPipeline({ projectId: currentProject.id })
      setPreflightIssues(null)
      showSuccess('Pipeline reset to start state')
    } catch (err) {
      showError(err.message || 'Failed to reset pipeline')
    }
  }, [currentProject?.id, resetPipeline, showSuccess, showError])

  // ── Run state helpers ──────────────────────────────────────────────────────

  const runState = currentRun?.state
  const isComplete = runState === 'completed'
  const isFailed = runState === 'failed'
  const isWaiting = runState === 'waiting_intervention'
  const hasRun = !!currentRun

  const progressBarColor = isFailed ? 'bg-danger' : isComplete ? 'bg-success' : 'bg-accent'

  const statusBadge = useMemo(() => {
    if (isRunning)  return { label: 'Running', cls: 'text-accent border-accent/30 bg-accent/5' }
    if (isPaused)   return { label: 'Paused', cls: 'text-warning border-warning/30 bg-warning/5' }
    if (isWaiting)  return { label: 'Action needed', cls: 'text-warning border-warning/30 bg-warning/5' }
    if (isComplete) return { label: 'Complete', cls: 'text-success border-success/30 bg-success/5' }
    if (isFailed)   return { label: 'Failed', cls: 'text-danger border-danger/30 bg-danger/5' }
    return { label: 'Ready', cls: 'text-text-tertiary border-border bg-bg-primary' }
  }, [isRunning, isPaused, isWaiting, isComplete, isFailed])

  // ── Render unified surface ─────────────────────────────────────────────────

  if (docked) {
    return (
      <div className="w-full border-t border-border bg-bg-primary">
        <div className="max-w-[1360px] mx-auto">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-bg-secondary">
          <Rocket className="w-3.5 h-3.5 text-accent" />
          <span className="text-xxs font-semibold text-text-primary">Auto Pipeline</span>
          <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${statusBadge.cls}`}>
            {statusBadge.label}
          </span>
          {selectedPreset && (
            <span className="px-1.5 py-0.5 rounded-md border border-accent/30 bg-accent/10 text-accent text-[10px] font-medium truncate max-w-[140px]">
              {selectedPreset.name}
            </span>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => {
              if (!currentProject?.id) return
              setStep(currentProject.id, 'pipeline').catch(() => {})
            }}
            className="h-6 px-2 rounded-md border border-border text-[10px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            title="Open Auto tab"
          >
            Auto
          </button>
        </div>

        {!hasRun && (
          <div className="px-3 py-2 flex items-center gap-2">
            <p className="text-xxs text-text-tertiary truncate">
              Configure full options in Auto tab. Current toggles/preset will be used if you start here.
            </p>
            <button
              onClick={handleStart}
              disabled={loading || preflightChecking || !currentProject?.id}
              className="h-7 px-2.5 rounded-md bg-accent hover:bg-accent-hover text-white text-xxs font-semibold
                         disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
            >
              {preflightChecking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              Start
            </button>
          </div>
        )}

        {hasRun && (
          <div className="px-3 py-2 flex items-center gap-2">
            <div className="flex-1 min-w-0 space-y-1.5">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-text-secondary truncate">
                  {isRunning && currentStepLabel
                    ? `${currentStepLabel} running`
                    : isComplete ? 'Complete'
                    : isFailed ? 'Failed'
                    : isPaused ? 'Paused'
                    : isWaiting ? 'Action needed'
                    : 'Idle'}
                </span>
                <span className="font-mono text-text-primary tabular-nums">{overallProgress}%</span>
              </div>
              <div className="h-1.5 bg-bg-secondary rounded-full overflow-hidden border border-border">
                <div className={`h-full rounded-full transition-all duration-500 ${progressBarColor}`} style={{ width: `${overallProgress}%` }} />
              </div>

              <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
                {STEP_META.map(({ id, label, icon: Icon }) => {
                  const step = steps[id]
                  const isCurrent = currentStep === id
                  return (
                    <div key={id} className={`w-[92px] shrink-0 px-2 py-1.5 rounded-lg border ${stepBorderClass(step, isCurrent)}`}>
                      <div className="flex items-center justify-between gap-1">
                        <div className="inline-flex items-center gap-1 min-w-0">
                          <Icon className="w-3 h-3 shrink-0" />
                          <span className="text-[10px] font-medium text-text-primary truncate">{label}</span>
                        </div>
                        <span className="shrink-0">{stepStateIcon(step)}</span>
                      </div>
                    </div>
                  )
                })}
              </div>

              {lastLog && (
                <p className="text-[10px] text-text-disabled truncate">
                  {lastLog.step}: {lastLog.message}
                </p>
              )}
            </div>

            <div className="shrink-0 flex items-center gap-1">
              {isRunning && (
                <button
                  onClick={handlePause}
                  className="h-7 px-2 rounded-md bg-warning text-white text-[10px] font-semibold inline-flex items-center gap-1"
                  title="Pause"
                >
                  <Pause className="w-3 h-3" />
                  Pause
                </button>
              )}
              {canResume && (
                <button
                  onClick={handleResume}
                  className="h-7 px-2 rounded-md bg-success text-white text-[10px] font-semibold inline-flex items-center gap-1"
                  title="Resume"
                >
                  <Play className="w-3 h-3" />
                  Resume
                </button>
              )}
              {(isRunning || canResume) && (
                <button
                  onClick={handleCancel}
                  className="h-7 w-7 rounded-md border border-border text-text-secondary hover:text-danger hover:border-danger/40 inline-flex items-center justify-center"
                  title="Cancel"
                >
                  <Square className="w-3.5 h-3.5" />
                </button>
              )}
              {(isComplete || isFailed) && (
                <button
                  onClick={handleStart}
                  disabled={loading || preflightChecking}
                  className="h-7 px-2 rounded-md bg-accent hover:bg-accent-hover text-white text-[10px] font-semibold inline-flex items-center gap-1 disabled:opacity-50"
                  title="Run again"
                >
                  {preflightChecking ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                  Again
                </button>
              )}
              <button
                onClick={handleReset}
                className="h-7 w-7 rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover inline-flex items-center justify-center"
                title="Reset run"
              >
                <RefreshCcw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 w-full min-h-0 items-center justify-center bg-bg-primary p-4 md:p-6 overflow-auto">
      <div className="w-full max-w-3xl max-h-full flex flex-col rounded-2xl border border-border bg-bg-primary shadow-xl shadow-black/10 overflow-hidden">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border bg-bg-secondary shrink-0">
        <div className="p-1.5 rounded-lg bg-accent/10">
          <Rocket className="w-4 h-4 text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-text-primary">Automated Pipeline</h2>
            <span className={`px-2 py-0.5 rounded-full text-xxs font-medium border ${statusBadge.cls}`}>
              {statusBadge.label}
            </span>
          </div>
          {currentProject && (
            <p className="text-xxs text-text-tertiary mt-0.5 truncate">{currentProject.name}</p>
          )}
        </div>
        {selectedPreset && (
          <span className="px-2 py-0.5 rounded-md border border-accent/30 bg-accent/10 text-accent text-xxs font-medium">
            {selectedPreset.name}
          </span>
        )}
      </div>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-5 py-5 space-y-5">

          {/* ── No run yet: start config ───────────────────────────────── */}
          {!hasRun && (
            <>
              <StartConfig
                presets={presets}
                selectedPreset={selectedPreset}
                onPresetChange={handlePresetChange}
                enabledSteps={enabledSteps}
                onToggleStep={handleToggleStepEnabled}
                onStart={handleStart}
                disabled={loading || preflightChecking}
                dirtyAugmentations={dirtyAugmentations}
              />

              {/* Preflight checking indicator */}
              {preflightChecking && (
                <div className="flex items-center gap-2 text-xs text-text-tertiary">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Checking prerequisites…
                </div>
              )}

              {/* Preflight issues */}
              {preflightIssues && preflightIssues.length > 0 && (
                <div className="space-y-1.5">
                  {preflightIssues.map((issue, idx) => (
                    <div
                      key={idx}
                      className={`flex items-start gap-2 p-3 rounded-xl border text-xs ${
                        issue.level === 'error'
                          ? 'bg-danger/5 border-danger/30 text-danger'
                          : 'bg-warning/5 border-warning/30 text-warning'
                      }`}
                    >
                      {issue.level === 'error'
                        ? <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                      <span>{issue.message}</span>
                    </div>
                  ))}
                  {preflightIssues.some(i => i.level === 'error') && (
                    <p className="text-xxs text-text-tertiary">
                      Fix the errors above before starting the pipeline.
                    </p>
                  )}
                </div>
              )}

              {/* All-clear badge */}
              {preflightIssues && preflightIssues.length === 0 && (
                <div className="flex items-center gap-2 text-xs text-success">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  All preflight checks passed
                </div>
              )}
            </>
          )}

          {/* ── Active / completed run ─────────────────────────────────── */}
          {hasRun && (
            <>
              {/* Overall progress */}
              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-text-secondary font-medium">
                    {isRunning && currentStepLabel
                      ? `Running ${currentStepLabel}…`
                      : isComplete ? 'Pipeline complete!'
                      : isFailed ? 'Pipeline failed'
                      : isPaused ? 'Paused'
                      : isWaiting ? 'Waiting for action'
                      : 'Idle'}
                  </span>
                  <span className="font-mono text-text-primary tabular-nums">{overallProgress}%</span>
                </div>
                <div className="h-2.5 bg-bg-secondary rounded-full overflow-hidden border border-border">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${progressBarColor} ${
                      isRunning ? 'relative overflow-hidden' : ''
                    }`}
                    style={{ width: `${overallProgress}%` }}
                  >
                    {/* Shimmer animation while running */}
                    {isRunning && (
                      <div
                        className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent
                                   animate-shimmer"
                        style={{ backgroundSize: '200% 100%' }}
                      />
                    )}
                  </div>
                </div>
              </div>

              {/* Step timeline */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {STEP_META.map(({ id, label, icon: Icon, desc }) => {
                  const step = steps[id]
                  const isCurrent = currentStep === id

                  return (
                    <div
                      key={id}
                      className={`p-3 rounded-xl border transition-all duration-200 ${stepBorderClass(step, isCurrent)}`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className={`p-1.5 rounded-lg ${
                          isCurrent && step?.state === 'running'
                            ? 'bg-accent/10 text-accent'
                            : step?.state === 'completed'
                            ? 'bg-success/10 text-success'
                            : step?.state === 'failed'
                            ? 'bg-danger/10 text-danger'
                            : 'bg-bg-primary text-text-tertiary'
                        }`}>
                          <Icon className="w-3.5 h-3.5" />
                        </div>
                        {stepStateIcon(step)}
                      </div>
                      <p className="text-xxs font-semibold text-text-primary">{label}</p>
                      <p className="text-xxs text-text-tertiary mt-0.5 leading-tight">{desc}</p>
                      {/* Per-step progress bar when running */}
                      {step?.state === 'running' && step?.progress != null && (
                        <div className="mt-1.5 h-0.5 bg-bg-primary rounded-full overflow-hidden">
                          <div
                            className="h-full bg-accent transition-all duration-300"
                            style={{ width: `${step.progress}%` }}
                          />
                        </div>
                      )}
                      {/* Skipped badge */}
                      {step?.state === 'skipped' && (
                        <p className="text-xxs text-text-disabled mt-1">skipped</p>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Failed step error details + actions */}
              {isFailed && (
                <div className="p-4 bg-danger/5 border border-danger/30 rounded-xl space-y-3">
                  <div className="flex items-center gap-2">
                    <XCircle className="w-4 h-4 text-danger shrink-0" />
                    <span className="text-sm font-semibold text-danger">Pipeline Failed</span>
                  </div>
                  {STEP_META.map(({ id, label }) => {
                    const step = steps[id]
                    if (step?.state !== 'failed') return null
                    return (
                      <div key={id} className="space-y-2">
                        <p className="text-xs text-danger">
                          <strong>{label}:</strong> {step.error || 'Unknown error'}
                        </p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleRetry(id)}
                            className="flex items-center gap-1 px-3 py-1.5 text-xxs font-medium
                                       bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors"
                          >
                            <RotateCcw className="w-3 h-3" />
                            Retry {label}
                          </button>
                          <button
                            onClick={() => handleSkip(id)}
                            className="flex items-center gap-1 px-3 py-1.5 text-xxs font-medium
                                       border border-border text-text-secondary hover:text-text-primary
                                       hover:bg-bg-hover rounded-lg transition-colors"
                          >
                            <SkipForward className="w-3 h-3" />
                            Skip
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Waiting for intervention */}
              {isWaiting && (
                <div className="p-4 bg-warning/5 border border-warning/30 rounded-xl flex items-start gap-3">
                  <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-warning">Action Required</p>
                    <p className="text-xxs text-text-secondary mt-0.5">
                      The pipeline is waiting for you to complete the current step manually, then click Resume.
                    </p>
                  </div>
                </div>
              )}

              {/* Controls */}
              <div className="flex gap-2">
                {isRunning && (
                  <>
                    <button
                      onClick={handlePause}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5
                                 bg-warning text-white rounded-xl hover:bg-warning/90 transition-colors
                                 text-xs font-semibold"
                    >
                      <Pause className="w-4 h-4" />
                      Pause
                    </button>
                    <button
                      onClick={handleCancel}
                      className="flex items-center justify-center gap-2 px-4 py-2.5
                                 bg-bg-secondary border border-border text-text-secondary
                                 hover:text-danger hover:border-danger/40 rounded-xl
                                 transition-colors text-xs font-semibold"
                    >
                      <Square className="w-4 h-4" />
                      Cancel
                    </button>
                  </>
                )}
                {canResume && (
                  <>
                    <button
                      onClick={handleResume}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5
                                 bg-success text-white rounded-xl hover:bg-success/90 transition-colors
                                 text-xs font-semibold"
                    >
                      <Play className="w-4 h-4" />
                      Resume
                    </button>
                    <button
                      onClick={handleCancel}
                      className="flex items-center justify-center gap-2 px-4 py-2.5
                                 bg-bg-secondary border border-border text-text-secondary
                                 hover:text-danger hover:border-danger/40 rounded-xl
                                 transition-colors text-xs font-semibold"
                    >
                      <Square className="w-4 h-4" />
                      Cancel
                    </button>
                  </>
                )}
                {(isComplete || isFailed) && (
                  <button
                    onClick={handleStart}
                    disabled={loading || preflightChecking}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5
                               bg-accent hover:bg-accent-hover text-white rounded-xl
                               transition-colors text-xs font-semibold
                               disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {preflightChecking
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : <RotateCcw className="w-4 h-4" />}
                    Run Again
                  </button>
                )}
                <button
                  onClick={handleReset}
                  className="flex items-center justify-center gap-2 px-4 py-2.5
                             bg-bg-secondary border border-border text-text-secondary
                             hover:text-text-primary hover:bg-bg-hover rounded-xl
                             transition-colors text-xs font-semibold"
                  title="Clear pipeline state and return to beginning"
                >
                  <RefreshCcw className="w-4 h-4" />
                  Reset Run
                </button>
              </div>

              {/* ── Log panel ─────────────────────────────────────────── */}
              <div className="rounded-xl border border-border overflow-hidden">
                <LogViewer
                  title="Activity Log"
                  subtitle={`${dynamicLogSource.label} feed`}
                  entries={activityLogEntries}
                  rawEntries={logEntries}
                  schema="league-replay-studio.activity-log"
                  emptyMessage={isRunning ? 'Waiting for log entries...' : 'No log entries yet'}
                  maxHeightClass="max-h-48"
                  className="bg-bg-primary"
                  bodyClassName="bg-bg-primary"
                  headerClassName="border-border"
                  compact
                  listRef={logContainerRef}
                  footerRef={logEndRef}
                >
                  {isRunning && lastLog ? (
                    <span className="text-xxs text-text-disabled truncate ml-2 max-w-[200px]">
                      {lastLog.message}
                    </span>
                  ) : null}
                </LogViewer>
              </div>

              {/* ── Created files panel ────────────────────────────────── */}
              <div className="rounded-xl border border-border overflow-hidden">
                <div className="px-3 py-2 bg-bg-secondary border-b border-border">
                  <span className="text-xxs font-semibold text-text-secondary uppercase tracking-wider">
                    Created Files
                  </span>
                </div>
                <div className="max-h-44 overflow-y-auto bg-bg-primary py-1" style={{ scrollbarWidth: 'thin' }}>
                  {createdFiles.length === 0 ? (
                    <p className="text-xxs text-text-disabled text-center py-4">
                      No generated files detected yet
                    </p>
                  ) : (
                    createdFiles.map((file, idx) => (
                      <div key={`${file.path}-${idx}`} className="flex items-start gap-2 px-3 py-1.5 text-xxs font-mono">
                        <span className="text-text-disabled shrink-0 w-14 truncate capitalize">[{file.step}]</span>
                        <div className="min-w-0 flex-1">
                          <p className="text-text-primary truncate">{file.name}</p>
                          <p className="text-text-disabled truncate">{file.path}</p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

            </>
          )}
        </div>
      </div>

      </div>
    </div>
  )
}
