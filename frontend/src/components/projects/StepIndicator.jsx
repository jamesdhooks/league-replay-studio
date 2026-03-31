import {
  FolderOpen,
  Film,
  BarChart3,
  Scissors,
  Download,
  Upload,
  Check,
  Circle,
} from 'lucide-react'
import { WORKFLOW_STEPS } from '../../utils/constants'

/**
 * Step icons mapping by step ID.
 */
const STEP_ICONS = {
  setup: FolderOpen,
  capture: Film,
  analysis: BarChart3,
  editing: Scissors,
  export: Download,
  upload: Upload,
}

/**
 * Workflow step indicator bar.
 * Shows progress through the project lifecycle: Setup → Capture → Analysis → Editing → Export → Upload.
 *
 * @param {Object} props
 * @param {string} props.currentStep - The current active step ID
 * @param {(step: string) => void} [props.onStepClick] - Callback when a completed/active step is clicked
 * @param {boolean} [props.compact=false] - Whether to render a compact version
 */
function StepIndicator({ currentStep, onStepClick, compact = false }) {
  const currentIdx = WORKFLOW_STEPS.findIndex(s => s.id === currentStep)

  return (
    <div className={`flex items-center ${compact ? 'gap-1' : 'gap-0.5'}`}>
      {WORKFLOW_STEPS.map((step, idx) => {
        let status
        if (idx < currentIdx) status = 'completed'
        else if (idx === currentIdx) status = 'active'
        else status = 'pending'

        const Icon = STEP_ICONS[step.id] || Circle
        const isClickable = status === 'completed' || status === 'active'
        const isLast = idx === WORKFLOW_STEPS.length - 1

        return (
          <div key={step.id} className="flex items-center">
            <button
              onClick={() => isClickable && onStepClick?.(step.id)}
              disabled={!isClickable}
              title={`${step.label}${status === 'completed' ? ' ✓' : status === 'active' ? ' (current)' : ''}`}
              className={`
                flex items-center gap-1.5 rounded-md transition-colors
                ${compact ? 'px-1.5 py-1' : 'px-2.5 py-1.5'}
                ${status === 'completed'
                  ? 'text-success hover:bg-success/10 cursor-pointer'
                  : status === 'active'
                    ? 'text-accent bg-accent/10 font-medium cursor-pointer'
                    : 'text-text-disabled cursor-not-allowed'
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
                ${idx < currentIdx ? 'bg-success' : 'bg-border'}
              `} />
            )}
          </div>
        )
      })}
    </div>
  )
}

export default StepIndicator
