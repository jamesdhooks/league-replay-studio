import { useState, useCallback, useMemo } from 'react'
import {
  Play,
  Pause,
  Square,
  RefreshCw,
  SkipForward,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Settings,
  Rocket,
  Loader2,
  Video,
  BarChart2,
  Scissors,
  Upload as UploadIcon,
  Youtube,
} from 'lucide-react'
import { usePipeline } from '../../context/PipelineContext'
import { useProject } from '../../context/ProjectContext'
import { useToast } from '../../context/ToastContext'
import { getStepIcon, getStepColor } from '../../utils/pipeline-helpers'
import PresetsTab from './PresetsTab'

/**
 * PipelinePanel — One-click automated pipeline UI.
 *
 * Shows pipeline progress, step status, controls
 * (start/pause/resume/cancel), and preset management.
 */
function PipelinePanel() {
  const {
    currentRun,
    isRunning,
    isPaused,
    canResume,
    currentStep,
    steps,
    presets,
    createPreset,
    updatePreset,
    deletePreset,
    startPipeline,
    pausePipeline,
    resumePipeline,
    cancelPipeline,
    retryStep,
    skipStep,
    loading,
    error,
  } = usePipeline()
  const { currentProject } = useProject()
  const { showSuccess, showError, showWarning } = useToast()

  const [activeTab, setActiveTab] = useState('run')
  const [selectedPreset, setSelectedPreset] = useState(null)
  const [showConfig, setShowConfig] = useState(false)
  const [customConfig, setCustomConfig] = useState({
    skip_capture: false,
    skip_analysis: false,
    auto_edit: true,
    upload_to_youtube: false,
    youtube_privacy: 'unlisted',
    failure_action: 'pause',
  })

  // Step order and metadata
  const stepConfig = useMemo(() => [
    { id: 'capture', label: 'Capture', icon: Video, description: 'Record replay video' },
    { id: 'analysis', label: 'Analysis', icon: BarChart2, description: 'Detect race events' },
    { id: 'editing', label: 'Editing', icon: Scissors, description: 'Apply highlight config' },
    { id: 'export', label: 'Export', icon: UploadIcon, description: 'Encode video' },
    { id: 'upload', label: 'Upload', icon: Youtube, description: 'Upload to YouTube' },
  ], [])

  // ── Start pipeline ───────────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    if (!currentProject?.id) {
      showWarning('Please select a project first')
      return
    }
    try {
      const config = selectedPreset
        ? undefined // Preset provides config
        : customConfig
      await startPipeline({
        projectId: currentProject.id,
        presetId: selectedPreset?.id,
        config,
      })
      showSuccess('Pipeline started')
    } catch (err) {
      showError(err.message || 'Failed to start pipeline')
    }
  }, [currentProject, selectedPreset, customConfig, startPipeline, showSuccess, showError, showWarning])

  // ── Pause/Resume/Cancel ──────────────────────────────────────────────────
  const handlePause = useCallback(async () => {
    try {
      await pausePipeline()
      showSuccess('Pipeline paused')
    } catch (err) {
      showError(err.message || 'Failed to pause pipeline')
    }
  }, [pausePipeline, showSuccess, showError])

  const handleResume = useCallback(async () => {
    try {
      await resumePipeline()
      showSuccess('Pipeline resumed')
    } catch (err) {
      showError(err.message || 'Failed to resume pipeline')
    }
  }, [resumePipeline, showSuccess, showError])

  const handleCancel = useCallback(async () => {
    try {
      await cancelPipeline()
      showWarning('Pipeline cancelled')
    } catch (err) {
      showError(err.message || 'Failed to cancel pipeline')
    }
  }, [cancelPipeline, showWarning, showError])

  // ── Retry/Skip step ──────────────────────────────────────────────────────
  const handleRetry = useCallback(async (stepName) => {
    try {
      await retryStep(stepName)
      showSuccess(`Retrying ${stepName}`)
    } catch (err) {
      showError(err.message || 'Failed to retry step')
    }
  }, [retryStep, showSuccess, showError])

  const handleSkip = useCallback(async (stepName) => {
    try {
      await skipStep(stepName)
      showSuccess(`Skipped ${stepName}`)
    } catch (err) {
      showError(err.message || 'Failed to skip step')
    }
  }, [skipStep, showSuccess, showError])

  // ── Overall progress ─────────────────────────────────────────────────────
  const overallProgress = useMemo(() => {
    if (!steps || Object.keys(steps).length === 0) return 0
    const completed = Object.values(steps).filter(
      s => s.state === 'completed' || s.state === 'skipped'
    ).length
    return Math.round((completed / 5) * 100)
  }, [steps])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-bg-secondary shrink-0">
        <Rocket className="w-5 h-5 text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">Automated Pipeline</h2>
        <div className="flex-1" />
        {isRunning && (
          <span className="px-2 py-0.5 rounded-full text-xxs font-medium border border-accent/30 text-accent bg-accent/5">
            Running…
          </span>
        )}
        {isPaused && (
          <span className="px-2 py-0.5 rounded-full text-xxs font-medium border border-warning/30 text-warning bg-warning/5">
            Paused
          </span>
        )}
        {!isRunning && !isPaused && (
          <span className="px-2 py-0.5 rounded-full text-xxs font-medium border border-border text-text-tertiary bg-bg-primary">
            Ready
          </span>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-border shrink-0">
        {[
          { id: 'run', label: 'Run' },
          { id: 'presets', label: 'Presets' },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
              activeTab === tab.id
                ? 'border-accent text-accent'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'run' ? (
          <div className="space-y-6">
            {/* Current run status */}
            {currentRun ? (
              <div className="space-y-4">
                {/* Progress bar */}
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-text-secondary font-medium">
                      {isRunning ? 'Running…' : isPaused ? 'Paused' : currentRun.state}
                    </span>
                    <span className="font-mono text-text-primary">{overallProgress}%</span>
                  </div>
                  <div className="h-3 bg-bg-primary rounded-full overflow-hidden border border-border">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        currentRun.state === 'failed' ? 'bg-danger' :
                        currentRun.state === 'completed' ? 'bg-success' :
                        'bg-accent'
                      }`}
                      style={{ width: `${overallProgress}%` }}
                    />
                  </div>
                </div>

                {/* Steps */}
                <div className="space-y-2">
                  {stepConfig.map(({ id, label, icon: Icon, description }) => {
                    const step = steps[id]
                    const StepIcon = getStepIcon(step)
                    const isCurrentStep = currentStep === id

                    return (
                      <div
                        key={id}
                        className={`p-3 rounded-lg border transition-colors ${
                          isCurrentStep
                            ? 'border-accent/40 bg-accent/5'
                            : 'border-border bg-bg-secondary/50'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-lg bg-bg-primary ${getStepColor(step)}`}>
                              <Icon className="w-4 h-4" />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-medium text-text-primary">{label}</span>
                                <StepIcon
                                  className={`w-3.5 h-3.5 ${getStepColor(step)} ${
                                    step?.state === 'running' ? 'animate-spin' : ''
                                  }`}
                                />
                              </div>
                              <p className="text-xxs text-text-tertiary">{description}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {step?.state === 'running' && (
                              <span className="text-xs font-mono text-accent">
                                {Math.round(step.progress || 0)}%
                              </span>
                            )}
                            {step?.state === 'failed' && (
                              <div className="flex gap-1">
                                <button
                                  onClick={() => handleRetry(id)}
                                  className="px-2 py-1 text-xxs font-medium bg-accent hover:bg-accent-hover text-white rounded transition-colors"
                                >
                                  Retry
                                </button>
                                <button
                                  onClick={() => handleSkip(id)}
                                  className="px-2 py-1 text-xxs font-medium bg-bg-primary text-text-secondary hover:bg-bg-hover border border-border rounded transition-colors"
                                >
                                  Skip
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                        {step?.error && (
                          <div className="mt-2 p-2 bg-danger/5 border border-danger/30 rounded text-xxs text-danger">
                            {step.error}
                          </div>
                        )}
                        {/* Step progress bar */}
                        {step?.state === 'running' && (
                          <div className="mt-2 h-1 bg-bg-primary rounded-full overflow-hidden">
                            <div
                              className="h-full bg-accent transition-all duration-300"
                              style={{ width: `${step.progress || 0}%` }}
                            />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                {/* Controls */}
                <div className="flex gap-2">
                  {isRunning && (
                    <>
                      <button
                        onClick={handlePause}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-warning text-white rounded-lg hover:bg-warning/90 transition-colors text-xs font-medium"
                      >
                        <Pause className="w-4 h-4" />
                        Pause
                      </button>
                      <button
                        onClick={handleCancel}
                        className="flex items-center justify-center gap-2 px-4 py-2 bg-danger text-white rounded-lg hover:bg-danger/90 transition-colors text-xs font-medium"
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
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-success text-white rounded-lg hover:bg-success/90 transition-colors text-xs font-medium"
                      >
                        <Play className="w-4 h-4" />
                        Resume
                      </button>
                      <button
                        onClick={handleCancel}
                        className="flex items-center justify-center gap-2 px-4 py-2 bg-danger text-white rounded-lg hover:bg-danger/90 transition-colors text-xs font-medium"
                      >
                        <Square className="w-4 h-4" />
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : (
              /* Start new pipeline */
              <div className="space-y-4">
                {/* Project indicator */}
                <div className="p-3 bg-bg-secondary rounded-lg border border-border">
                  <div className="text-xxs text-text-tertiary uppercase tracking-wider mb-1">Project</div>
                  <div className="text-xs text-text-primary font-medium">
                    {currentProject?.name || 'No project selected'}
                  </div>
                </div>

                {/* Preset selector */}
                <div className="space-y-2">
                  <label className="block text-xxs text-text-tertiary uppercase tracking-wider font-semibold">Pipeline Preset</label>
                  <div className="relative">
                    <select
                      value={selectedPreset?.id || ''}
                      onChange={(e) => {
                        const preset = presets.find(p => p.id === e.target.value)
                        setSelectedPreset(preset || null)
                      }}
                      className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-xs text-text-primary appearance-none focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
                    >
                      <option value="">Custom Configuration</option>
                      {presets.map(preset => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary pointer-events-none" />
                  </div>
                  {selectedPreset && (
                    <p className="text-xxs text-text-tertiary">{selectedPreset.description}</p>
                  )}
                </div>

                {/* Custom config (when no preset) */}
                {!selectedPreset && (
                  <div className="space-y-3">
                    <button
                      onClick={() => setShowConfig(!showConfig)}
                      className="flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary transition-colors"
                    >
                      {showConfig ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      <Settings className="w-3.5 h-3.5" />
                      Configuration Options
                    </button>

                    {showConfig && (
                      <div className="space-y-3 p-3 bg-bg-secondary/50 rounded-lg border border-border">
                        <label className="flex items-center gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={customConfig.skip_capture}
                            onChange={(e) => setCustomConfig(c => ({ ...c, skip_capture: e.target.checked }))}
                            className="w-4 h-4 rounded border-border bg-bg-primary text-accent focus:ring-accent"
                          />
                          <span className="text-xs text-text-secondary">Skip capture (use existing video)</span>
                        </label>

                        <label className="flex items-center gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={customConfig.skip_analysis}
                            onChange={(e) => setCustomConfig(c => ({ ...c, skip_analysis: e.target.checked }))}
                            className="w-4 h-4 rounded border-border bg-bg-primary text-accent focus:ring-accent"
                          />
                          <span className="text-xs text-text-secondary">Skip analysis (use existing events)</span>
                        </label>

                        <label className="flex items-center gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={customConfig.auto_edit}
                            onChange={(e) => setCustomConfig(c => ({ ...c, auto_edit: e.target.checked }))}
                            className="w-4 h-4 rounded border-border bg-bg-primary text-accent focus:ring-accent"
                          />
                          <span className="text-xs text-text-secondary">Auto-apply highlight config</span>
                        </label>

                        <label className="flex items-center gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={customConfig.upload_to_youtube}
                            onChange={(e) => setCustomConfig(c => ({ ...c, upload_to_youtube: e.target.checked }))}
                            className="w-4 h-4 rounded border-border bg-bg-primary text-accent focus:ring-accent"
                          />
                          <span className="text-xs text-text-secondary">Upload to YouTube</span>
                        </label>

                        {customConfig.upload_to_youtube && (
                          <div className="pl-7">
                            <label className="block text-xxs text-text-tertiary mb-1">Privacy</label>
                            <select
                              value={customConfig.youtube_privacy}
                              onChange={(e) => setCustomConfig(c => ({ ...c, youtube_privacy: e.target.value }))}
                              className="w-full px-2 py-1.5 text-xs bg-bg-primary border border-border rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                            >
                              <option value="private">Private</option>
                              <option value="unlisted">Unlisted</option>
                              <option value="public">Public</option>
                            </select>
                          </div>
                        )}

                        <div>
                          <label className="block text-xxs text-text-tertiary mb-1">On failure</label>
                          <select
                            value={customConfig.failure_action}
                            onChange={(e) => setCustomConfig(c => ({ ...c, failure_action: e.target.value }))}
                            className="w-full px-2 py-1.5 text-xs bg-bg-primary border border-border rounded text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                          >
                            <option value="pause">Pause (wait for intervention)</option>
                            <option value="skip">Skip failed step</option>
                            <option value="abort">Abort pipeline</option>
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Start button */}
                <button
                  onClick={handleStart}
                  disabled={loading || !currentProject}
                  className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm
                    font-semibold transition-colors
                    ${loading || !currentProject
                      ? 'bg-accent/50 text-white cursor-not-allowed'
                      : 'bg-accent hover:bg-accent-hover text-white shadow-lg shadow-accent/20'
                    }`}
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Starting…
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4" />
                      Start Pipeline
                    </>
                  )}
                </button>
              </div>
            )}

            {/* Error display */}
            {error && (
              <div className="flex items-start gap-2 px-3 py-2.5 bg-danger/5 border border-danger/30 rounded-md">
                <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs text-danger font-medium">Error</p>
                  <p className="text-xxs text-danger/80 mt-0.5">{error}</p>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Presets tab */
          <PresetsTab
            presets={presets}
            createPreset={createPreset}
            updatePreset={updatePreset}
            deletePreset={deletePreset}
            showSuccess={showSuccess}
            showError={showError}
          />
        )}
      </div>
    </div>
  )
}

export default PipelinePanel
