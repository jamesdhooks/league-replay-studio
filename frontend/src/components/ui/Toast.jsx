import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react'

/**
 * Toast notification component.
 *
 * @param {Object} props
 * @param {'success' | 'error' | 'warning' | 'info'} props.type
 * @param {string} props.message
 * @param {() => void} props.onClose
 */
function Toast({ type = 'info', message, onClose }) {
  const config = {
    success: {
      icon: CheckCircle,
      bg: 'bg-success-muted border-success/30',
      iconColor: 'text-success',
      textColor: 'text-success-text',
    },
    error: {
      icon: XCircle,
      bg: 'bg-danger-muted border-danger/30',
      iconColor: 'text-danger',
      textColor: 'text-danger-text',
    },
    warning: {
      icon: AlertTriangle,
      bg: 'bg-warning-muted border-warning/30',
      iconColor: 'text-warning',
      textColor: 'text-warning-text',
    },
    info: {
      icon: Info,
      bg: 'bg-info-muted border-info/30',
      iconColor: 'text-info',
      textColor: 'text-info-text',
    },
  }

  const { icon: Icon, bg, iconColor, textColor } = config[type] || config.info

  return (
    <div
      className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-lg border
                  shadow-lg animate-slide-up min-w-[280px] max-w-[400px] ${bg}`}
      role="alert"
    >
      <Icon className={`w-4 h-4 shrink-0 ${iconColor}`} />
      <span className={`text-sm flex-1 ${textColor}`}>{message}</span>
      <button
        onClick={onClose}
        className="p-0.5 rounded hover:bg-white/10 transition-colors shrink-0"
      >
        <X className="w-3.5 h-3.5 text-text-tertiary" />
      </button>
    </div>
  )
}

export default Toast
