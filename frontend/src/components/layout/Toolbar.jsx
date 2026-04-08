import {
  Settings,
  HelpCircle,
  Undo2,
  Redo2,
  Save,
  PlayCircle,
  ArrowLeft,
  Wifi,
  WifiOff,
} from 'lucide-react'
import StepIndicator from '../projects/StepIndicator'
import { useIRacing } from '../../context/IRacingContext'
import { useSettings } from '../../context/SettingsContext'

/**
 * Top toolbar with app title, navigation, and action buttons.
 * Larger (64px), friendlier spacing, professional Clipchamp-inspired styling.
 *
 * @param {Object} props
 * @param {string} [props.projectName] - Active project name (if any)
 * @param {() => void} [props.onOpenSettings] - Callback to open settings panel
 * @param {boolean} [props.canUndo] - Whether undo is available
 * @param {boolean} [props.canRedo] - Whether redo is available
 * @param {() => void} [props.onUndo] - Undo callback
 * @param {() => void} [props.onRedo] - Redo callback
 * @param {string} [props.undoDescription] - Description of next undo operation
 * @param {string} [props.redoDescription] - Description of next redo operation
 */
function Toolbar({
  activeProject, onBack, onStepClick, stepReadiness,
  analysisProgress,
  onOpenSettings, onOpenHelp,
  canUndo = false, canRedo = false, onUndo, onRedo,
  undoDescription, redoDescription,
}) {
  const { isConnected, sessionData } = useIRacing()
  const { settings } = useSettings()

  const captureSoftware = settings?.capture_software
  const captureLabel = {
    obs: 'OBS',
    shadowplay: 'ShadowPlay',
    relive: 'ReLive',
    manual: 'Manual',
  }[captureSoftware] ?? 'No Software'
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
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-gradient-from via-gradient-via to-gradient-to
                            flex items-center justify-center shadow-glow-sm">
              <PlayCircle className="w-5 h-5 text-white" />
            </div>
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
            progress={activeProject.current_step === 'analysis' ? analysisProgress : null}
          />
        </div>
      )}

      {/* Right section */}
      <div className="ml-auto flex items-center gap-2 shrink-0">
        {/* iRacing connection status card */}
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs select-none
          ${ isConnected
            ? 'bg-success/10 border-success/20 text-success'
            : 'bg-surface border-border text-text-disabled'
          }`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            isConnected ? 'bg-success animate-pulse-soft' : 'bg-text-disabled'
          }`} />
          { isConnected
            ? (sessionData?.track_name ? `iRacing · ${sessionData.track_name}` : 'iRacing · Connected')
            : 'iRacing'
          }
          {isConnected && sessionData?.drivers?.length > 0 && (
            <span className="ml-0.5 text-success/70">{sessionData.drivers.length}d</span>
          )}
        </div>

        {/* Capture software — always grey, shows configured software name */}
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs select-none
                        bg-surface border-border text-text-secondary">
          <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-text-disabled" />
          {captureLabel}
        </div>

        <ToolbarDivider />
        <ToolbarButton icon={Save} title="Save (Ctrl+S)" disabled />
        <ToolbarDivider />
        <ToolbarButton
          icon={Undo2}
          title={canUndo ? `Undo: ${undoDescription || 'last action'} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}
          disabled={!canUndo}
          onClick={onUndo}
        />
        <ToolbarButton
          icon={Redo2}
          title={canRedo ? `Redo: ${redoDescription || 'last action'} (Ctrl+Y)` : 'Redo (Ctrl+Y)'}
          disabled={!canRedo}
          onClick={onRedo}
        />
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
      className={`p-2 rounded-xl transition-all duration-150 cursor-pointer ${
        disabled
          ? 'text-text-disabled cursor-not-allowed opacity-40'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary active:scale-95'
      }`}
    >
      <Icon className="w-5 h-5" />
    </button>
  )
}

/**
 * Vertical divider between toolbar button groups.
 */
function ToolbarDivider() {
  return <div className="w-px h-6 bg-border mx-1.5" />
}

export default Toolbar
