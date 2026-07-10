import {
  Film,
  BarChart3,
  Scissors,
  Download,
  Upload,
  Layers,
  Clapperboard,
  Rocket,
  Check,
  Circle,
  Lock,
  Loader2,
  AlertTriangle,
} from 'lucide-react'
import { WORKFLOW_STEPS } from '../../utils/constants'

/**
 * Step icons mapping by step ID.
 */
const STEP_ICONS = {
  pipeline: Rocket,
  capture: Film,
  analysis: BarChart3,
  editing: Scissors,
  overlay: Layers,
  compose: Clapperboard,
  export: Download,
  upload: Upload,
}

/**
 * Workflow step indicator bar.
 * All steps are always clickable — step gating is handled by the view layer.
 * Completed steps show green checkmarks; the active step has a gradient ring;
 * future steps are dimmed but still clickable.
 *
 * @param {Object} props
 * @param {string} props.currentStep - The current active step ID
 * @param {(step: string) => void} [props.onStepClick] - Callback when any step is clicked
 * @param {Object} [props.stepReadiness] - Map of step ID → boolean indicating data readiness
 * @param {boolean} [props.compact=false] - Whether to render a compact version
 */
function StepIndicator({
  currentStep,
  onStepClick,
  stepReadiness = {},
  executionStates = {},
  runningStep = null,
  compact = false,
  progress = null,
}) {
  const currentIdx = WORKFLOW_STEPS.findIndex(s => s.id === currentStep)

  return (
    <div className={`flex items-center ${compact ? 'gap-1' : 'gap-0.5'}`}>
      {WORKFLOW_STEPS.map((step, idx) => {
        const Icon = STEP_ICONS[step.id] || Circle
        const isReady = stepReadiness[step.id] ?? false
        const isCurrent = idx === currentIdx
        const isLast = idx === WORKFLOW_STEPS.length - 1
        const execState = executionStates?.[step.id]?.state
        const execProgressRaw = executionStates?.[step.id]?.progress
        const isRunningStep = runningStep === step.id || execState === 'running'
        const isBackgroundRunning = isRunningStep && !isCurrent

        // A step is "completed" only if it's before current AND its data is ready
        let status
        if (execState === 'failed') status = 'failed'
        else if (isBackgroundRunning) status = 'background-running'
        else if (execState === 'completed' || execState === 'skipped') status = 'completed'
        else if (isCurrent) status = 'active'
        else if (idx < currentIdx && isReady) status = 'completed'
        else if (isReady) status = 'ready'
        else status = 'pending'

        const fallbackProgress = step.id === 'analysis' ? progress?.percent : null
        const stepProgress = Number(execProgressRaw ?? fallbackProgress ?? 0)
        const normalizedProgress = Math.max(0, Math.min(100, stepProgress))
        const showProgressFill = normalizedProgress > 0 && status !== 'failed'

        // Show progress bar on any running step that has partial progress (0 < x < 100)
        const showProgress = normalizedProgress > 0 && normalizedProgress < 100

        return (
          <div key={step.id} className="flex items-center">
            <div className="flex flex-col items-stretch">
              <button
                onClick={() => onStepClick?.(step.id)}
                title={`${step.label}${status === 'completed' ? ' ✓' : ''}${isCurrent ? ' (current)' : ''}`}
                className={`
                  relative overflow-hidden flex items-center gap-1.5 rounded-lg font-medium transition-all duration-150 cursor-pointer
                  ${compact ? 'px-1.5 py-1' : 'px-3 py-1.5'}
                  ${step.id === 'pipeline'
                    ? isCurrent
                      ? 'bg-accent/20 text-accent ring-1 ring-accent/30'
                      : 'text-accent/70 hover:bg-accent/10 hover:text-accent'
                    : isCurrent
                      ? 'bg-gradient-to-r from-gradient-from/20 via-gradient-via/15 to-gradient-to/20 text-accent ring-1 ring-accent/20'
                    : status === 'background-running'
                      ? 'bg-violet-500/8 text-violet-300 ring-1 ring-violet-400/20'
                    : status === 'failed'
                      ? 'bg-danger/10 text-danger ring-1 ring-danger/30'
                    : status === 'completed'
                      ? 'text-success hover:bg-success/10'
                    : 'text-text-secondary hover:bg-bg-hover'
                  }
                `}
              >
                {showProgressFill && (
                  <div
                    className={`absolute inset-y-0 left-0 pointer-events-none ${isCurrent ? 'bg-accent/24' : 'bg-accent/12'}`}
                    style={{ width: `${normalizedProgress}%` }}
                    aria-hidden="true"
                  />
                )}
                {status === 'failed' ? (
                  <AlertTriangle className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} shrink-0 relative z-[1]`} />
                ) : isRunningStep ? (
                  <Loader2 className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} shrink-0 animate-spin relative z-[1]`} />
                ) : status === 'completed' && step.id !== 'pipeline' ? (
                  <Check className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} shrink-0 relative z-[1]`} />
                ) : (
                  <Icon className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} shrink-0 relative z-[1]`} />
                )}
                {!compact && (
                  <span className="text-xs whitespace-nowrap relative z-[1]">{step.label}</span>
                )}
              </button>
              {showProgress && (
                <div className="h-0.5 mx-1 -mt-0.5 rounded-full overflow-hidden bg-white/10">
                  <div
                    className="h-full bg-accent rounded-full transition-all duration-500"
                    style={{ width: `${normalizedProgress}%` }}
                  />
                </div>
              )}
            </div>
            {/* Divider after pipeline step to separate it from the linear workflow */}
            {step.id === 'pipeline' ? (
              <div className={`${compact ? 'w-px h-4' : 'w-px h-5'} mx-2 bg-border`} />
            ) : !isLast ? (
              <div className={`
                ${compact ? 'w-2' : 'w-4'} h-px mx-0.5
                ${status === 'completed' ? 'bg-success' : 'bg-border'}
              `} />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export default StepIndicator
