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
}
