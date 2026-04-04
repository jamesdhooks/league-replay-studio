import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react'

/**
 * Toast notification component — larger, friendlier.
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
      className={`pointer-events-auto flex items-center gap-3 px-5 py-3.5 rounded-xl border
                  shadow-elevated animate-slide-up min-w-[320px] max-w-[440px] ${bg}`}
      role="alert"
    >
      <Icon className={`w-5 h-5 shrink-0 ${iconColor}`} />
      <span className={`text-sm font-medium flex-1 ${textColor}`}>{message}</span>
      <button
        onClick={onClose}
        className="p-1 rounded-lg hover:bg-white/10 transition-colors shrink-0 cursor-pointer"
      >
        <X className="w-4 h-4 text-text-tertiary" />
      </button>
    </div>
  )
}

export default Toast
