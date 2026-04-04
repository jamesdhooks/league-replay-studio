import { useState, useCallback, useMemo } from 'react'
import {
  Play,
  Pause,
  Square,
  RefreshCw,
  SkipForward,
  CheckCircle,
  XCircle,
  Clock,
  Loader2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Settings,
  Rocket,
  Video,
  BarChart2,
  Scissors,
  Upload as UploadIcon,
  Youtube,
} from 'lucide-react'
import { usePipeline } from '../../context/PipelineContext'
import { useProject } from '../../context/ProjectContext'
import { useToast } from '../../context/ToastContext'

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

  // ── Get step state icon ──────────────────────────────────────────────────
  const getStepIcon = useCallback((step) => {
    if (!step) return Clock
    switch (step.state) {
      case 'completed':
        return CheckCircle
      case 'running':
        return Loader2
      case 'failed':
        return XCircle
      case 'skipped':
        return SkipForward
      case 'paused':
        return Pause
      default:
        return Clock
    }
  }, [])

  const getStepColor = useCallback((step) => {
    if (!step) return 'text-slate-500'
    switch (step.state) {
      case 'completed':
        return 'text-green-500'
      case 'running':
        return 'text-blue-500'
      case 'failed':
        return 'text-red-500'
      case 'skipped':
        return 'text-amber-500'
      case 'paused':
        return 'text-amber-500'
      default:
        return 'text-slate-500'
    }
  }, [])

  // ── Overall progress ─────────────────────────────────────────────────────
  const overallProgress = useMemo(() => {
    if (!steps || Object.keys(steps).length === 0) return 0
    const completed = Object.values(steps).filter(
      s => s.state === 'completed' || s.state === 'skipped'
    ).length
    return Math.round((completed / 5) * 100)
  }, [steps])

  return (
    <div className="flex flex-col h-full bg-slate-900 rounded-lg border border-slate-700">
      {/* Header with tabs */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <Rocket className="w-5 h-5 text-blue-400" />
          <span className="font-medium text-white">Automated Pipeline</span>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => setActiveTab('run')}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              activeTab === 'run'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-white hover:bg-slate-700'
            }`}
          >
            Run
          </button>
          <button
            onClick={() => setActiveTab('presets')}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              activeTab === 'presets'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-white hover:bg-slate-700'
            }`}
          >
            Presets
          </button>
        </div>
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
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-300">
                      {isRunning ? 'Running...' : isPaused ? 'Paused' : currentRun.state}
                    </span>
                    <span className="text-slate-400">{overallProgress}%</span>
                  </div>
                  <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${
                        currentRun.state === 'failed' ? 'bg-red-500' :
                        currentRun.state === 'completed' ? 'bg-green-500' :
                        'bg-blue-500'
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
                            ? 'border-blue-500 bg-slate-800'
                            : 'border-slate-700 bg-slate-800/50'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-lg bg-slate-700 ${getStepColor(step)}`}>
                              <Icon className="w-4 h-4" />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-white">{label}</span>
                                <StepIcon
                                  className={`w-4 h-4 ${getStepColor(step)} ${
                                    step?.state === 'running' ? 'animate-spin' : ''
                                  }`}
                                />
                              </div>
                              <p className="text-xs text-slate-400">{description}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {step?.state === 'running' && (
                              <span className="text-sm text-blue-400">
                                {Math.round(step.progress || 0)}%
                              </span>
                            )}
                            {step?.state === 'failed' && (
                              <div className="flex gap-1">
                                <button
                                  onClick={() => handleRetry(id)}
                                  className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-500"
                                >
                                  Retry
                                </button>
                                <button
                                  onClick={() => handleSkip(id)}
                                  className="px-2 py-1 text-xs bg-slate-600 text-white rounded hover:bg-slate-500"
                                >
                                  Skip
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                        {step?.error && (
                          <div className="mt-2 p-2 bg-red-900/30 border border-red-700 rounded text-xs text-red-300">
                            {step.error}
                          </div>
                        )}
                        {/* Step progress bar */}
                        {step?.state === 'running' && (
                          <div className="mt-2 h-1 bg-slate-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-500 transition-all duration-300"
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
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-500 transition-colors"
                      >
                        <Pause className="w-4 h-4" />
                        Pause
                      </button>
                      <button
                        onClick={handleCancel}
                        className="flex items-center justify-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-500 transition-colors"
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
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-500 transition-colors"
                      >
                        <Play className="w-4 h-4" />
                        Resume
                      </button>
                      <button
                        onClick={handleCancel}
                        className="flex items-center justify-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-500 transition-colors"
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
                <div className="p-3 bg-slate-800 rounded-lg border border-slate-700">
                  <div className="text-sm text-slate-400 mb-1">Project</div>
                  <div className="text-white font-medium">
                    {currentProject?.name || 'No project selected'}
                  </div>
                </div>

                {/* Preset selector */}
                <div className="space-y-2">
                  <label className="block text-sm text-slate-300">Pipeline Preset</label>
                  <div className="relative">
                    <select
                      value={selectedPreset?.id || ''}
                      onChange={(e) => {
                        const preset = presets.find(p => p.id === e.target.value)
                        setSelectedPreset(preset || null)
                      }}
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white appearance-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    >
                      <option value="">Custom Configuration</option>
                      {presets.map(preset => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                  </div>
                  {selectedPreset && (
                    <p className="text-xs text-slate-400">{selectedPreset.description}</p>
                  )}
                </div>

                {/* Custom config (when no preset) */}
                {!selectedPreset && (
                  <div className="space-y-3">
                    <button
                      onClick={() => setShowConfig(!showConfig)}
                      className="flex items-center gap-2 text-sm text-slate-300 hover:text-white"
                    >
                      {showConfig ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      <Settings className="w-4 h-4" />
                      Configuration Options
                    </button>

                    {showConfig && (
                      <div className="space-y-3 p-3 bg-slate-800/50 rounded-lg border border-slate-700">
                        <label className="flex items-center gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={customConfig.skip_capture}
                            onChange={(e) => setCustomConfig(c => ({ ...c, skip_capture: e.target.checked }))}
                            className="w-4 h-4 rounded border-slate-500 bg-slate-700 text-blue-500 focus:ring-blue-500"
                          />
                          <span className="text-sm text-slate-300">Skip capture (use existing video)</span>
                        </label>

                        <label className="flex items-center gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={customConfig.skip_analysis}
                            onChange={(e) => setCustomConfig(c => ({ ...c, skip_analysis: e.target.checked }))}
                            className="w-4 h-4 rounded border-slate-500 bg-slate-700 text-blue-500 focus:ring-blue-500"
                          />
                          <span className="text-sm text-slate-300">Skip analysis (use existing events)</span>
                        </label>

                        <label className="flex items-center gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={customConfig.auto_edit}
                            onChange={(e) => setCustomConfig(c => ({ ...c, auto_edit: e.target.checked }))}
                            className="w-4 h-4 rounded border-slate-500 bg-slate-700 text-blue-500 focus:ring-blue-500"
                          />
                          <span className="text-sm text-slate-300">Auto-apply highlight config</span>
                        </label>

                        <label className="flex items-center gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={customConfig.upload_to_youtube}
                            onChange={(e) => setCustomConfig(c => ({ ...c, upload_to_youtube: e.target.checked }))}
                            className="w-4 h-4 rounded border-slate-500 bg-slate-700 text-blue-500 focus:ring-blue-500"
                          />
                          <span className="text-sm text-slate-300">Upload to YouTube</span>
                        </label>

                        {customConfig.upload_to_youtube && (
                          <div className="pl-7">
                            <label className="block text-xs text-slate-400 mb-1">Privacy</label>
                            <select
                              value={customConfig.youtube_privacy}
                              onChange={(e) => setCustomConfig(c => ({ ...c, youtube_privacy: e.target.value }))}
                              className="w-full px-2 py-1.5 text-sm bg-slate-700 border border-slate-600 rounded text-white"
                            >
                              <option value="private">Private</option>
                              <option value="unlisted">Unlisted</option>
                              <option value="public">Public</option>
                            </select>
                          </div>
                        )}

                        <div>
                          <label className="block text-xs text-slate-400 mb-1">On failure</label>
                          <select
                            value={customConfig.failure_action}
                            onChange={(e) => setCustomConfig(c => ({ ...c, failure_action: e.target.value }))}
                            className="w-full px-2 py-1.5 text-sm bg-slate-700 border border-slate-600 rounded text-white"
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
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Starting...
                    </>
                  ) : (
                    <>
                      <Play className="w-5 h-5" />
                      Start Pipeline
                    </>
                  )}
                </button>
              </div>
            )}

            {/* Error display */}
            {error && (
              <div className="p-3 bg-red-900/30 border border-red-700 rounded-lg flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-red-300">{error}</div>
              </div>
            )}
          </div>
        ) : (
          /* Presets tab */
          <PresetsTab />
        )}
      </div>
    </div>
  )
}

/**
 * PresetsTab — Pipeline presets management.
 */
function PresetsTab() {
  const {
    presets,
    createPreset,
    updatePreset,
    deletePreset,
  } = usePipeline()
  const { showSuccess, showError } = useToast()

  const [editingPreset, setEditingPreset] = useState(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    skip_capture: false,
    skip_analysis: false,
    auto_edit: true,
    upload_to_youtube: false,
    youtube_privacy: 'unlisted',
    failure_action: 'pause',
    notify_on_completion: 'toast',
  })

  const handleCreate = useCallback(async () => {
    if (!formData.name) {
      showError('Name is required')
      return
    }
    try {
      await createPreset(formData)
      showSuccess('Preset created')
      setShowCreateForm(false)
      setFormData({
        name: '',
        description: '',
        skip_capture: false,
        skip_analysis: false,
        auto_edit: true,
        upload_to_youtube: false,
        youtube_privacy: 'unlisted',
        failure_action: 'pause',
        notify_on_completion: 'toast',
      })
    } catch (err) {
      showError(err.message || 'Failed to create preset')
    }
  }, [formData, createPreset, showSuccess, showError])

  const handleDelete = useCallback(async (presetId) => {
    if (!confirm('Delete this preset?')) return
    try {
      await deletePreset(presetId)
      showSuccess('Preset deleted')
    } catch (err) {
      showError(err.message || 'Failed to delete preset')
    }
  }, [deletePreset, showSuccess, showError])

  return (
    <div className="space-y-4">
      {/* Create new */}
      {!showCreateForm && (
        <button
          onClick={() => setShowCreateForm(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-slate-700 text-slate-300 rounded-lg hover:bg-slate-600 hover:text-white transition-colors"
        >
          <Settings className="w-4 h-4" />
          Create New Preset
        </button>
      )}

      {showCreateForm && (
        <div className="p-4 bg-slate-800 rounded-lg border border-slate-600 space-y-3">
          <div>
            <label className="block text-sm text-slate-300 mb-1">Name</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData(f => ({ ...f, name: e.target.value }))}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white focus:border-blue-500"
              placeholder="My Preset"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">Description</label>
            <input
              type="text"
              value={formData.description}
              onChange={(e) => setFormData(f => ({ ...f, description: e.target.value }))}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white focus:border-blue-500"
              placeholder="Describe this preset..."
            />
          </div>
          {/* Quick toggles */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.upload_to_youtube}
                onChange={(e) => setFormData(f => ({ ...f, upload_to_youtube: e.target.checked }))}
                className="w-4 h-4 rounded border-slate-500 bg-slate-700"
              />
              <span className="text-sm text-slate-300">Upload to YouTube</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.auto_edit}
                onChange={(e) => setFormData(f => ({ ...f, auto_edit: e.target.checked }))}
                className="w-4 h-4 rounded border-slate-500 bg-slate-700"
              />
              <span className="text-sm text-slate-300">Auto-apply highlights</span>
            </label>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              className="flex-1 px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-500"
            >
              Create
            </button>
            <button
              onClick={() => setShowCreateForm(false)}
              className="px-3 py-2 bg-slate-600 text-white rounded hover:bg-slate-500"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Preset list */}
      <div className="space-y-2">
        {presets.map(preset => (
          <div
            key={preset.id}
            className="p-3 bg-slate-800 rounded-lg border border-slate-700"
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="font-medium text-white">{preset.name}</div>
                <p className="text-sm text-slate-400">{preset.description}</p>
                <div className="flex flex-wrap gap-2 mt-2">
                  {preset.upload_to_youtube && (
                    <span className="px-2 py-0.5 text-xs bg-red-900/30 text-red-300 rounded">
                      YouTube
                    </span>
                  )}
                  {preset.auto_edit && (
                    <span className="px-2 py-0.5 text-xs bg-blue-900/30 text-blue-300 rounded">
                      Auto-edit
                    </span>
                  )}
                  <span className="px-2 py-0.5 text-xs bg-slate-700 text-slate-300 rounded">
                    On fail: {preset.failure_action}
                  </span>
                </div>
              </div>
              <button
                onClick={() => handleDelete(preset.id)}
                className="p-1 text-slate-400 hover:text-red-400"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}

        {presets.length === 0 && !showCreateForm && (
          <div className="text-center py-8 text-slate-500">
            No presets yet. Create one to get started.
          </div>
        )}
      </div>
    </div>
  )
}

export default PipelinePanel
