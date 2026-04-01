import { Wifi, WifiOff, Clapperboard } from 'lucide-react'
import { useIRacing } from '../../context/IRacingContext'

/**
 * Bottom status bar showing connection status.
 * Taller (36px), with clearer status icons and pulse indicators.
 */
function StatusBar() {
  const { isConnected, sessionData } = useIRacing()

  const iracingStatus = isConnected ? 'connected' : 'disconnected'
  const iracingLabel = isConnected && sessionData.track_name
    ? `iRacing — ${sessionData.track_name}`
    : 'iRacing'

  return (
    <footer className="h-statusbar flex items-center px-4 bg-bg-secondary border-t border-border
                        text-xs select-none shrink-0">
      {/* Left section: connection statuses */}
      <div className="flex items-center gap-5">
        <StatusIndicator
          icon={isConnected ? Wifi : WifiOff}
          label={iracingLabel}
          status={iracingStatus}
        />
        {isConnected && sessionData.drivers.length > 0 && (
          <span className="text-text-tertiary">
            {sessionData.drivers.length} drivers
          </span>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />
    </footer>
  )
}

/**
 * Status indicator with colored dot, icon, and label.
 *
 * @param {Object} props
 * @param {import('lucide-react').LucideIcon} [props.icon]
 * @param {string} props.label
 * @param {'connected' | 'disconnected' | 'idle' | 'active' | 'error'} props.status
 */
function StatusIndicator({ icon: Icon, label, status }) {
  const colorMap = {
    connected: 'text-success',
    disconnected: 'text-text-disabled',
    idle: 'text-text-tertiary',
    active: 'text-accent',
    error: 'text-danger',
  }

  const dotColor = {
    connected: 'bg-success',
    disconnected: 'bg-text-disabled',
    idle: 'bg-text-tertiary',
    active: 'bg-accent',
    error: 'bg-danger',
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
      <span className={`w-2 h-2 rounded-full ${dotColor[status] || 'bg-text-disabled'}
                        ${status === 'connected' || status === 'active' ? 'animate-pulse-soft' : ''}`} />
      {Icon && <Icon className={`w-3.5 h-3.5 ${colorMap[status] || 'text-text-disabled'}`} />}
      <span className="text-text-secondary">{label}:</span>
      <span className={colorMap[status] || 'text-text-disabled'}>
        {labelMap[status] || status}
      </span>
    </div>
  )
}

export default StatusBar
