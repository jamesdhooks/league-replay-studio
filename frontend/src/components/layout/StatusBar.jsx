import { Circle } from 'lucide-react'

/**
 * Bottom status bar showing connection status, GPU info, and encoding state.
 */
function StatusBar() {
  return (
    <footer className="h-statusbar flex items-center px-3 bg-bg-secondary border-t border-border
                        text-xxs select-none shrink-0">
      {/* Left section: iRacing connection */}
      <div className="flex items-center gap-4">
        <StatusIndicator
          label="iRacing"
          status="disconnected"
        />
      </div>

      {/* Center: spacer */}
      <div className="flex-1" />

      {/* Right section: GPU + encoding status */}
      <div className="flex items-center gap-4">
        <span className="text-text-tertiary">GPU: Detecting...</span>
        <StatusIndicator
          label="Encoding"
          status="idle"
        />
      </div>
    </footer>
  )
}

/**
 * Status indicator with colored dot and label.
 *
 * @param {Object} props
 * @param {string} props.label
 * @param {'connected' | 'disconnected' | 'idle' | 'active' | 'error'} props.status
 */
function StatusIndicator({ label, status }) {
  const colorMap = {
    connected: 'text-success',
    disconnected: 'text-text-disabled',
    idle: 'text-text-tertiary',
    active: 'text-accent',
    error: 'text-danger',
  }

  const labelMap = {
    connected: 'Connected',
    disconnected: 'Disconnected',
    idle: 'Idle',
    active: 'Active',
    error: 'Error',
  }

  return (
    <div className="flex items-center gap-1.5">
      <Circle className={`w-2 h-2 fill-current ${colorMap[status] || 'text-text-disabled'}`} />
      <span className="text-text-secondary">{label}:</span>
      <span className={colorMap[status] || 'text-text-disabled'}>
        {labelMap[status] || status}
      </span>
    </div>
  )
}

export default StatusBar
