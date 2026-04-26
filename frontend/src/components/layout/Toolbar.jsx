import {
  Settings,
  HelpCircle,
  Save,
  SaveAll,
  ArrowLeft,
  PanelBottomOpen,
  PanelBottomClose,
  Hash,
} from 'lucide-react'
import { useMemo, useCallback, useEffect, useState, useRef } from 'react'
import StepIndicator from '../projects/StepIndicator'
import { useIRacing } from '../../context/IRacingContext'
import { useProject } from '../../context/ProjectContext'
import { useSettings } from '../../context/SettingsContext'
import { useCapture } from '../../context/CaptureContext'
import { usePipeline } from '../../context/PipelineContext'

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

/**
 * Top toolbar with app title, navigation, and action buttons.
 * Larger (64px), friendlier spacing, professional Clipchamp-inspired styling.
 *
 * @param {Object} props
 * @param {string} [props.projectName] - Active project name (if any)
 * @param {() => void} [props.onOpenSettings] - Callback to open settings panel
 */
function Toolbar({
  activeProject, onBack, onStepClick, stepReadiness,
  pipelineExecutionSteps, pipelineRunningStep,
  pipelineAdvancedMode = false, onTogglePipelineAdvancedMode,
  analysisProgress,
  onOpenSettings, onOpenHelp,
}) {
  const { isConnected, sessionData, subsessionId } = useIRacing()
  const { settings } = useSettings()
  const { updateProject } = useProject()
  const { software } = useCapture()
  const {
    presets,
    projectControlStateMap,
    getProjectControlState,
    saveProjectControlState,
    createPreset,
    updatePreset,
  } = usePipeline()

  const activeControlState = activeProject?.id ? (projectControlStateMap[activeProject.id] || null) : null
  const resolvedPresetId = activeControlState?.preset_id || ''
  const resolvedOverrides = activeControlState?.overrides || {}
  const [presetBusy, setPresetBusy] = useState(false)

  useEffect(() => {
    if (!activeProject?.id) return
    getProjectControlState(activeProject.id).catch(() => {})
  }, [activeProject?.id, getProjectControlState])

  const selectedPresetId = resolvedPresetId
  const selectedPreset = useMemo(
    () => presets.find(p => p.id === selectedPresetId) || null,
    [presets, selectedPresetId],
  )
  const localAugmentations = useMemo(
    () => computeAugmentations(resolvedOverrides, selectedPreset),
    [resolvedOverrides, selectedPreset],
  )
  const hasLocalOverrides = Boolean(Object.keys(localAugmentations).length > 0)

  const handlePresetChange = useCallback(async (presetId) => {
    if (!activeProject?.id) return
    setPresetBusy(true)
    try {
      if (activeControlState) {
        await saveProjectControlState(activeProject.id, {
          schema_version: activeControlState.schema_version || 1,
          preset_id: activeControlState.preset_id || '',
          overrides: resolvedOverrides || {},
          controls: activeControlState.controls || {},
        })
      }
      await saveProjectControlState(activeProject.id, {
        schema_version: 1,
        preset_id: presetId,
        overrides: resolvedOverrides || {},
        controls: activeControlState?.controls || {},
      })
    } finally {
      setPresetBusy(false)
    }
  }, [activeProject?.id, activeControlState, resolvedOverrides, saveProjectControlState])

  const handleSaveToPreset = useCallback(async () => {
    if (!selectedPreset) return
    setPresetBusy(true)
    try {
      await updatePreset(selectedPreset.id, {
        ...(resolvedOverrides || {}),
      })
    } finally {
      setPresetBusy(false)
    }
  }, [selectedPreset, resolvedOverrides, updatePreset])

  const handleSaveAsPreset = useCallback(async () => {
    if (!activeProject?.id) return
    const name = window.prompt('New preset name')
    if (!name) return
    setPresetBusy(true)
    try {
      const created = await createPreset({
        name,
        description: `Saved from ${activeProject.name}`,
        ...(selectedPreset || {}),
        ...(resolvedOverrides || {}),
      })
      await saveProjectControlState(activeProject.id, {
        schema_version: 1,
        preset_id: created.id,
        overrides: resolvedOverrides || {},
        controls: activeControlState?.controls || {},
      })
    } finally {
      setPresetBusy(false)
    }
  }, [activeProject?.id, activeProject?.name, selectedPreset, resolvedOverrides, activeControlState?.controls, createPreset, saveProjectControlState])

  const captureSoftware = settings?.capture_software
  const CAPTURE_LABELS = { obs: 'OBS', shadowplay: 'ShadowPlay', relive: 'ReLive', native: 'LRS Native', manual: 'Manual' }
  const captureLabel = CAPTURE_LABELS[captureSoftware] ?? 'No Software'
  // Look up running state for the selected software
  const activeSoftwareInfo = software.find(s => s.id === captureSoftware)
  const captureRunning = activeSoftwareInfo?.running ?? false

  // ── Session badge state ────────────────────────────────────────────────
  const [showSessionMenu, setShowSessionMenu] = useState(false)
  const sessionMenuRef = useRef(null)
  useEffect(() => {
    if (!showSessionMenu) return
    const handler = (e) => {
      if (sessionMenuRef.current && !sessionMenuRef.current.contains(e.target)) {
        setShowSessionMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showSessionMenu])

  const storedSessionId = activeProject?.subsession_id || 0
  const liveSessionId = subsessionId || 0
  const sessionIdMismatch = liveSessionId > 0 && storedSessionId > 0 && liveSessionId !== storedSessionId
  const sessionIdSyncReady = liveSessionId > 0 && !storedSessionId

  const handleCaptureSession = useCallback(async () => {
    if (!activeProject?.id || !liveSessionId) return
    try { await updateProject(activeProject.id, { subsession_id: liveSessionId }) } catch {}
    setShowSessionMenu(false)
  }, [activeProject?.id, liveSessionId, updateProject])

  const handleClearSession = useCallback(async () => {
    if (!activeProject?.id) return
    try { await updateProject(activeProject.id, { subsession_id: 0 }) } catch {}
    setShowSessionMenu(false)
  }, [activeProject?.id, updateProject])

  return (
    <header className="relative h-toolbar flex items-center px-4 bg-bg-secondary border-b border-border
                        select-none shrink-0 bg-noise">
      {/* Left section */}
      <div className="flex items-center gap-3 shrink-0">
        {activeProject ? (
          <>
            <button
              onClick={onBack}
              className="p-2 rounded-xl hover:bg-surface-hover transition-all duration-150
                         text-text-secondary hover:text-text-primary active:scale-95"
              title="Back to projects"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="flex flex-col justify-center min-w-0">
              <span className="text-sm font-bold text-text-primary leading-tight truncate max-w-48">
                {activeProject.name}
              </span>
              {activeProject.track_name && (
                <span className="text-xxs text-text-tertiary leading-tight truncate max-w-48">
                  {activeProject.track_name}{activeProject.session_type ? ` · ${activeProject.session_type}` : ''}
                </span>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-3">
            <img
              src="/assets/logo_2048.png"
              alt="League Replay Studio"
              className="w-9 h-9 object-contain drop-shadow-[0_0_8px_rgba(255,255,255,0.22)]"
            />
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-extrabold text-gradient tracking-tight">
                League Replay Studio
              </span>
              <span className="text-xxs text-text-disabled font-mono bg-surface/80 px-1.5 py-0.5 rounded">
                v0.1.0
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Center — absolutely positioned so step pills are always at the exact midpoint */}
      {activeProject && (
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center">
          <StepIndicator
            currentStep={activeProject.current_step}
            onStepClick={onStepClick}
            stepReadiness={stepReadiness}
            executionStates={pipelineExecutionSteps}
            runningStep={pipelineRunningStep}
            progress={activeProject.current_step === 'analysis' ? analysisProgress : null}
          />
        </div>
      )}

      {/* Right section */}
      <div className="ml-auto flex items-center gap-1 shrink-0">
        {/* iRacing connection status card */}
        <div
          title={isConnected
            ? (sessionData?.track_name ? `iRacing · ${sessionData.track_name}${sessionData?.drivers?.length > 0 ? ` · ${sessionData.drivers.length}d` : ''}` : 'iRacing · Connected')
            : 'iRacing not connected'}
          className={`flex items-center gap-1 px-2 py-0.5 rounded-md border text-xxs select-none
          ${ isConnected
            ? 'bg-success/10 border-success/20 text-success'
            : 'bg-surface border-border text-text-disabled'
          }`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            isConnected ? 'bg-success animate-pulse-soft' : 'bg-text-disabled'
          }`} />
          <span>iRacing</span>
        </div>

        {/* Capture software — green if running, yellow if configured but not running */}
        <div className={`flex items-center gap-1 px-2 py-0.5 rounded-md border text-xxs select-none
          ${ captureRunning
            ? 'bg-success/10 border-success/20 text-success'
            : captureSoftware
              ? 'bg-warning/10 border-warning/20 text-warning'
              : 'bg-surface border-border text-text-disabled'
          }`}
          title={captureRunning ? `${captureLabel} is running` : `${captureLabel} is not running`}
        >
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            captureRunning ? 'bg-success animate-pulse-soft' : captureSoftware ? 'bg-warning' : 'bg-text-disabled'
          }`} />
          {captureLabel}
        </div>

        {/* Session ID badge — only when a project is open */}
        {activeProject && (
          <div className="relative" ref={sessionMenuRef}>
            <button
              onClick={() => setShowSessionMenu(v => !v)}
              title={
                storedSessionId
                  ? `Stored session #${storedSessionId}${liveSessionId && liveSessionId !== storedSessionId ? ` · Live: #${liveSessionId}` : ''}`
                  : sessionIdSyncReady
                    ? `Click to capture live session #${liveSessionId}`
                    : 'No session ID stored — connect a replay to capture one'
              }
              className={`flex items-center gap-1 px-2 py-0.5 rounded-md border text-xxs select-none cursor-pointer transition-colors
                ${sessionIdMismatch
                  ? 'bg-warning/10 border-warning/20 text-warning hover:bg-warning/15'
                  : sessionIdSyncReady
                    ? 'bg-accent/10 border-accent/30 text-accent hover:bg-accent/15'
                    : storedSessionId
                      ? 'bg-surface border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                      : 'bg-surface border-border text-text-disabled hover:text-text-secondary'
                }`}
            >
              <Hash className="w-3 h-3 shrink-0" />
              <span>{storedSessionId ? String(storedSessionId) : '—'}</span>
            </button>
            {showSessionMenu && (
              <div className="absolute right-0 top-full mt-1 z-50 min-w-[200px] rounded-lg border border-border bg-bg-secondary shadow-lg py-1">
                <p className="px-3 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Session ID</p>
                {storedSessionId > 0 && (
                  <div className="px-3 py-1 text-xs text-text-secondary font-mono">
                    Stored: #{storedSessionId}
                  </div>
                )}
                {liveSessionId > 0 && (
                  <div className="px-3 py-1 text-xs text-text-secondary font-mono">
                    Live: #{liveSessionId}
                  </div>
                )}
                <div className="border-t border-border my-1" />
                {liveSessionId > 0 && (
                  <button
                    onClick={handleCaptureSession}
                    className="w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-surface-hover"
                  >
                    {storedSessionId ? 'Replace with current replay' : 'Capture current replay'}
                  </button>
                )}
                {storedSessionId > 0 && (
                  <button
                    onClick={handleClearSession}
                    className="w-full text-left px-3 py-1.5 text-xs text-warning hover:bg-surface-hover"
                  >
                    Clear stored ID
                  </button>
                )}
                {!liveSessionId && !storedSessionId && (
                  <p className="px-3 py-1.5 text-xs text-text-tertiary">Connect a replay to capture</p>
                )}
              </div>
            )}
          </div>
        )}

        <ToolbarDivider />
        {activeProject && (
          <div className="flex items-center gap-1">
            <select
              value={selectedPresetId}
              onChange={(e) => handlePresetChange(e.target.value)}
              disabled={presetBusy}
              className="h-7 px-2 rounded-md border border-border bg-bg-primary text-xxs text-text-secondary
                         focus:outline-none focus:border-accent min-w-[100px] max-w-[140px]"
              title="Project preset"
            >
              <option value="">Project Default</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button
              onClick={handleSaveToPreset}
              disabled={presetBusy || !selectedPreset}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border text-text-secondary
                         hover:text-text-primary hover:bg-bg-hover disabled:opacity-50"
              title="Save current project augmentations into selected preset"
            >
              <Save className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleSaveAsPreset}
              disabled={presetBusy}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border text-text-secondary
                         hover:text-text-primary hover:bg-bg-hover disabled:opacity-50"
              title="Save as new preset"
            >
              <SaveAll className="w-3.5 h-3.5" />
            </button>
            {hasLocalOverrides && (
              <span className="px-1.5 py-0.5 rounded border border-warning/30 bg-warning/10 text-warning text-[10px] font-medium uppercase tracking-wide">
                Dirty
              </span>
            )}
          </div>
        )}
        {activeProject && (
          <>
            <ToolbarDivider />
            <button
              onClick={onTogglePipelineAdvancedMode}
              className={`h-7 w-7 inline-flex items-center justify-center rounded-md border transition-colors ${
                pipelineAdvancedMode
                  ? 'border-accent/40 text-accent bg-accent/10 hover:bg-accent/15'
                  : 'border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover'
              }`}
              title={pipelineAdvancedMode ? 'Disable docked pipeline footer' : 'Enable docked pipeline footer'}
            >
              {pipelineAdvancedMode ? <PanelBottomClose className="w-3.5 h-3.5" /> : <PanelBottomOpen className="w-3.5 h-3.5" />}
            </button>
          </>
        )}
        <ToolbarDivider />
        <ToolbarButton icon={Settings} title="Settings" onClick={onOpenSettings} />
        <ToolbarButton icon={HelpCircle} title="Help" onClick={onOpenHelp} />
      </div>
    </header>
  )
}

/**
 * Individual toolbar icon button — larger (36px) with better hover state.
 */
function ToolbarButton({ icon: Icon, title, disabled = false, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`p-1.5 rounded-lg transition-all duration-150 cursor-pointer ${
        disabled
          ? 'text-text-disabled cursor-not-allowed opacity-40'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary active:scale-95'
      }`}
    >
      <Icon className="w-4 h-4" />
    </button>
  )
}

/**
 * Vertical divider between toolbar button groups.
 */
function ToolbarDivider() {
  return <div className="w-px h-5 bg-border mx-1" />
}

export default Toolbar
