/**
 * Progress bar component — taller track, better visual feedback.
 *
 * @param {Object} props
 * @param {number} props.value - Progress value 0–100
 * @param {string} [props.label]
 * @param {'default' | 'success' | 'warning' | 'danger'} [props.variant='default']
 * @param {boolean} [props.showPercentage=true]
 * @param {string} [props.className]
 */
function ProgressBar({
  value = 0,
  label,
  variant = 'default',
  showPercentage = true,
  className = '',
}) {
  const clamped = Math.min(100, Math.max(0, value))

  const barColor = {
    default: 'bg-accent',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
  }

  return (
    <div className={`space-y-1.5 ${className}`}>
      {(label || showPercentage) && (
        <div className="flex items-center justify-between text-sm">
          {label && <span className="text-text-secondary font-medium">{label}</span>}
          {showPercentage && (
            <span className="text-text-tertiary font-mono text-xs">{Math.round(clamped)}%</span>
          )}
        </div>
      )}
      <div className="w-full h-2.5 bg-surface rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ease-out ${barColor[variant]}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}

export default ProgressBar
