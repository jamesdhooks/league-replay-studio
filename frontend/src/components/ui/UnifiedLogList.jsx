import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  XCircle,
  Zap,
} from 'lucide-react'

function levelMeta(level) {
  switch (level) {
    case 'error':
      return { Icon: XCircle, iconClass: 'text-danger', textClass: 'text-danger' }
    case 'warning':
      return { Icon: AlertTriangle, iconClass: 'text-warning', textClass: 'text-warning' }
    case 'success':
      return { Icon: CheckCircle2, iconClass: 'text-success', textClass: 'text-success' }
    case 'detect':
      return { Icon: Zap, iconClass: 'text-warning', textClass: 'text-text-secondary' }
    default:
      return { Icon: Info, iconClass: 'text-text-disabled', textClass: 'text-text-secondary' }
  }
}

function formatLogTimestamp(ts) {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function UnifiedLogList({
  entries = [],
  emptyMessage = 'No log entries yet',
  loadingMessage = null,
  isLoading = false,
  reverse = true,
  maxHeightClass = 'max-h-48',
  className = '',
  rowClassName = '',
  listRef = null,
  footerRef = null,
  showStep = true,
  showDivider = true,
  compact = false,
}) {
  const normalizedEntries = Array.isArray(entries) ? entries : []
  const displayEntries = reverse ? [...normalizedEntries].reverse() : normalizedEntries

  if (normalizedEntries.length === 0 && isLoading && loadingMessage) {
    return (
      <div className={`flex items-center gap-2 px-3 py-4 text-text-disabled text-xxs ${className}`}>
        <Loader2 size={11} className="animate-spin shrink-0" />
        <span>{loadingMessage}</span>
      </div>
    )
  }

  if (normalizedEntries.length === 0) {
    return (
      <div className={`flex items-center justify-center py-8 text-text-disabled text-xs ${className}`}>
        {emptyMessage}
      </div>
    )
  }

  return (
    <div ref={listRef} className={`${maxHeightClass} overflow-y-auto font-mono ${showDivider ? 'divide-y divide-border-subtle/30' : ''} ${className}`}>
      {displayEntries.map((entry, idx) => {
        const meta = levelMeta(entry.level)
        const Icon = meta.Icon
        return (
          <div
            key={entry.id || `${entry.step || 'log'}-${entry.ts || 0}-${idx}`}
            className={`flex gap-2 px-3 ${compact ? 'py-1' : 'py-1.5'} text-xxs animate-fade-in ${rowClassName}`}
          >
            <span className="shrink-0 select-none mt-0.5">
              <Icon size={11} className={meta.iconClass} />
            </span>
            <div className="flex-1 min-w-0">
              <span className="text-text-disabled font-mono mr-1.5">
                {formatLogTimestamp(entry.ts)}
              </span>
              {showStep && entry.step && (
                <span className="text-text-disabled font-mono mr-1.5 uppercase">[{entry.step}]</span>
              )}
              <span className={meta.textClass}>{entry.message}</span>
              {entry.detail && (
                <span className="text-text-disabled ml-1">— {entry.detail}</span>
              )}
            </div>
          </div>
        )
      })}
      {footerRef ? <div ref={footerRef} /> : null}
    </div>
  )
}
