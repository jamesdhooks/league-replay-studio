import {
  Film,
  BarChart3,
  Scissors,
  Download,
  Upload,
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
function StepIndicator({ currentStep, onStepClick, stepReadiness = {}, compact = false }) {
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

        return (
          <div key={step.id} className="flex items-center">
            <button
              onClick={() => onStepClick?.(step.id)}
              title={`${step.label}${status === 'completed' ? ' ✓' : status === 'active' ? ' (current)' : status === 'pending' ? ' (not ready)' : ''}`}
              className={`
                flex items-center gap-1.5 rounded-lg transition-all duration-150
                ${compact ? 'px-1.5 py-1' : 'px-3 py-1.5'}
                ${status === 'completed'
                  ? 'text-success hover:bg-success/10 cursor-pointer'
                  : status === 'active'
                    ? 'bg-gradient-to-r from-gradient-from/20 via-gradient-via/15 to-gradient-to/20 text-accent font-semibold cursor-pointer ring-1 ring-accent/20'
                    : status === 'ready'
                      ? 'text-text-secondary hover:bg-bg-hover cursor-pointer'
                      : 'text-text-disabled hover:bg-bg-hover/50 cursor-pointer opacity-60'
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
