import { useHighlight } from '../../context/HighlightContext'
import { useTimeline } from '../../context/TimelineContext'
import { Clock, BarChart3, Activity, Users, Target } from 'lucide-react'

/**
 * HighlightMetrics — Live metrics dashboard.
 *
 * Shows: duration, event count, coverage %, balance score, pacing score, driver coverage.
 * Updates within 100ms of any parameter change (computed in HighlightContext).
 */
export default function HighlightMetrics() {
  const { metrics, targetDuration } = useHighlight()
  const { raceDuration } = useTimeline()

  const overTarget = targetDuration && metrics.duration > targetDuration
  const underTarget = targetDuration && metrics.duration < targetDuration * 0.9

  return (
    <div className="p-3 border-t border-border-subtle space-y-2">
      <h4 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">
        Highlight Metrics
      </h4>

      {/* Duration */}
      <MetricRow
        icon={Clock}
        label="Duration"
        value={formatDuration(metrics.duration)}
        suffix={targetDuration ? ` / ${formatDuration(targetDuration)}` : ''}
        warning={overTarget ? 'Over target' : underTarget ? 'Under target' : null}
        warningColor={overTarget ? 'text-danger' : 'text-warning'}
      />

      {/* Event count */}
      <MetricRow
        icon={Target}
        label="Events"
        value={`${metrics.eventCount} / ${metrics.totalEvents}`}
      />

      {/* Coverage */}
      <MetricRow
        icon={BarChart3}
        label="Coverage"
        value={`${metrics.coveragePct}%`}
      />

      {/* Balance */}
      <MetricBar
        icon={Activity}
        label="Balance"
        value={metrics.balance}
        color={metrics.balance >= 60 ? 'bg-success' : metrics.balance >= 30 ? 'bg-warning' : 'bg-danger'}
      />

      {/* Pacing */}
      <MetricBar
        icon={Activity}
        label="Pacing"
        value={metrics.pacing}
        color={metrics.pacing >= 60 ? 'bg-success' : metrics.pacing >= 30 ? 'bg-warning' : 'bg-danger'}
      />

      {/* Driver coverage */}
      <MetricRow
        icon={Users}
        label="Drivers"
        value={`${metrics.driverCount} / ${metrics.totalDrivers}`}
        suffix={` (${metrics.driverCoverage}%)`}
      />
    </div>
  )
}


/** Single metric row with icon, label, value */
function MetricRow({ icon: Icon, label, value, suffix, warning, warningColor }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="w-3 h-3 text-text-tertiary shrink-0" />
      <span className="text-xxs text-text-secondary flex-1">{label}</span>
      <span className="text-xxs text-text-primary font-mono">
        {value}
        {suffix && <span className="text-text-tertiary">{suffix}</span>}
      </span>
      {warning && (
        <span className={`text-xxs font-medium ${warningColor}`}>{warning}</span>
      )}
    </div>
  )
}


/** Metric with a progress bar (0–100) */
function MetricBar({ icon: Icon, label, value, color }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <Icon className="w-3 h-3 text-text-tertiary shrink-0" />
        <span className="text-xxs text-text-secondary flex-1">{label}</span>
        <span className="text-xxs text-text-primary font-mono">{value}</span>
      </div>
      <div className="h-1 bg-bg-primary rounded-full overflow-hidden ml-5">
        <div
          className={`h-full rounded-full transition-all duration-150 ${color}`}
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
    </div>
  )
}


/** Format seconds to M:SS or H:MM:SS */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
