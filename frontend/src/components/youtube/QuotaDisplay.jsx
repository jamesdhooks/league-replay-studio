import {
  RefreshCw,
  AlertTriangle,
  Gauge,
} from 'lucide-react'

/**
 * QuotaDisplay — YouTube Data API quota usage visualisation.
 *
 * Shows a progress bar, remaining units, estimated uploads left,
 * and a warning when usage is high.
 */
function QuotaDisplay({ quota, onRefresh }) {
  if (!quota) {
    return (
      <div className="flex items-center justify-center h-32">
        <span className="text-sm text-text-tertiary">Loading quota info...</span>
      </div>
    )
  }

  const percentage = quota.percentage || 0
  const isWarning = quota.warning

  return (
    <div className="space-y-6 max-w-md">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gauge className="w-5 h-5 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">Daily API Quota</h3>
        </div>
        <button
          onClick={onRefresh}
          className="p-1 text-text-secondary hover:text-text-primary rounded transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div>
        <div className="flex justify-between text-sm mb-1">
          <span className="text-text-secondary">
            {quota.used.toLocaleString()} / {quota.limit.toLocaleString()} units
          </span>
          <span className={isWarning ? 'text-yellow-400 font-medium' : 'text-text-tertiary'}>
            {percentage}%
          </span>
        </div>
        <div className="w-full h-3 bg-surface rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              isWarning ? 'bg-yellow-500' : 'bg-accent'
            }`}
            style={{ width: `${Math.min(percentage, 100)}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="p-3 bg-surface rounded-lg">
          <p className="text-xs text-text-tertiary">Remaining</p>
          <p className="text-lg font-semibold text-text-primary">
            {quota.remaining.toLocaleString()}
          </p>
        </div>
        <div className="p-3 bg-surface rounded-lg">
          <p className="text-xs text-text-tertiary">Uploads Left</p>
          <p className="text-lg font-semibold text-text-primary">
            {quota.uploads_remaining}
          </p>
        </div>
      </div>

      {isWarning && (
        <div className="flex items-center gap-2 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
          <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />
          <p className="text-sm text-yellow-400">
            Approaching daily quota limit. Consider waiting until tomorrow for more uploads.
          </p>
        </div>
      )}

      <p className="text-xs text-text-disabled">
        Date: {quota.date} • Quota resets daily at midnight Pacific Time.
      </p>
    </div>
  )
}

export default QuotaDisplay
