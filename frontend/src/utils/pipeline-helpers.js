import {
  CheckCircle,
  Loader2,
  XCircle,
  SkipForward,
  Pause,
  Clock,
} from 'lucide-react'

/**
 * Returns the appropriate icon component for a pipeline step's state.
 */
export function getStepIcon(step) {
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
}

/**
 * Returns the Tailwind color class for a pipeline step's state.
 */
export function getStepColor(step) {
  if (!step) return 'text-text-disabled'
  switch (step.state) {
    case 'completed':
      return 'text-success'
    case 'running':
      return 'text-accent'
    case 'failed':
      return 'text-danger'
    case 'skipped':
      return 'text-warning'
    case 'paused':
      return 'text-warning'
    default:
      return 'text-text-disabled'
  }
}
