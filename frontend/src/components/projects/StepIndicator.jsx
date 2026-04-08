import {
  Film,
  BarChart3,
  Scissors,
  Download,
  Upload,
  Layers,
  Check,
  Circle,
  Lock,
} from 'lucide-react'
import { WORKFLOW_STEPS } from '../../utils/constants'

/**
 * Step icons mapping by step ID.
 */
const STEP_ICONS = {
  capture: Film,
  analysis: BarChart3,
  editing: Scissors,
  overlay: Layers,
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
function StepIndicator({ currentStep, onStepClick, stepReadiness = {}, compact = false, progress = null }) {
  const currentIdx = WORKFLOW_STEPS.findIndex(s => s.id === currentStep)

  return (
    <div className={`flex items-center ${compact ? 'gap-1' : 'gap-0.5'}`}>
      {WORKFLOW_STEPS.map((step, idx) => {
        const Icon = STEP_ICONS[step.id] || Circle
        const isReady = stepReadiness[step.id] ?? false
        const isCurrent = idx === currentIdx
        const isLast = idx === WORKFLOW_STEPS.length - 1

        // A step is "completed" only if it's before current AND its data is ready
        let status
        if (isCurrent) status = 'active'
        else if (idx < currentIdx && isReady) status = 'completed'
        else if (isReady) status = 'ready'
        else status = 'pending'

        // Show progress bar on the active step when progress data exists
        const showProgress = isCurrent && progress != null && progress.percent != null && progress.percent < 100

        return (
          <div key={step.id} className="flex items-center">
            <div className="flex flex-col items-stretch">
              <button
                onClick={() => onStepClick?.(step.id)}
                title={`${step.label}${status === 'completed' ? ' ✓' : status === 'active' ? ' (current)' : ''}`}
                className={`
                  flex items-center gap-1.5 rounded-lg transition-all duration-150 cursor-pointer
                  ${compact ? 'px-1.5 py-1' : 'px-3 py-1.5'}
                  ${status === 'completed'
                    ? 'text-success hover:bg-success/10'
                    : status === 'active'
                      ? 'bg-gradient-to-r from-gradient-from/20 via-gradient-via/15 to-gradient-to/20 text-accent font-semibold ring-1 ring-accent/20'
                      : 'text-text-secondary hover:bg-bg-hover'
                  }
                `}
              >
                {status === 'completed' ? (
                  <Check className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} shrink-0`} />
                ) : (
                  <Icon className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} shrink-0`} />
                )}
                {!compact && (
                  <span className="text-xs whitespace-nowrap">{step.label}</span>
                )}
              </button>
              {showProgress && (
                <div className="h-0.5 mx-1 -mt-0.5 rounded-full overflow-hidden bg-white/10">
                  <div
                    className="h-full bg-accent rounded-full transition-all duration-500"
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
              )}
            </div>
            {!isLast && (
              <div className={`
                ${compact ? 'w-2' : 'w-4'} h-px mx-0.5
                ${status === 'completed' ? 'bg-success' : 'bg-border'}
              `} />
            )}
          </div>
        )
      })}
    </div>
  )
}

export default StepIndicator
