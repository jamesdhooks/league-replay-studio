import { Sparkles } from 'lucide-react'

/**
 * AIDesignerToggleButton — shared toggle trigger for AI Designer panels.
 */
export default function AIDesignerToggleButton({
  active,
  onClick,
  disabled = false,
  label = 'AI Designer',
  title = 'AI Designer',
  className = '',
}) {
  const stateClass = active
    ? 'bg-purple-600/20 text-purple-400 border border-purple-500/40'
    : 'text-text-tertiary hover:text-text-primary hover:bg-bg-secondary border border-transparent'

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors ${stateClass} disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
    >
      <Sparkles className="w-4 h-4" />
      {label}
    </button>
  )
}
