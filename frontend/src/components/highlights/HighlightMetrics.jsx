import { memo, useState, useMemo } from 'react'
import { useHighlight, tierColor } from '../../context/HighlightContext'
import { useTimeline } from '../../context/TimelineContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { Clock, BarChart3, Activity, Users, Target, Info } from 'lucide-react'
import Tooltip from '../ui/Tooltip'
import CollapsibleSection from '../ui/CollapsibleSection'

/**
 * HighlightMetrics — Live metrics dashboard.
 *
 * Shows: duration, event count, coverage %, balance score, pacing score, driver coverage.
 * Updates within 100ms of any parameter change (computed in HighlightContext).
 */
export default memo(function HighlightMetrics() {
  const { metrics, targetDuration, videoScript } = useHighlight()
  const { raceDuration } = useTimeline()
  const [metricsExpanded, setMetricsExpanded] = useLocalStorage('lrs:editing:metrics:expanded', true)

  // Full production video duration: sum all edit segments (includes intro/outro sections).
  // This matches the "X total" shown in the race script timeline.
  const videoDuration = useMemo(() => {
    if (!videoScript?.length) return metrics.duration
    return videoScript
      .filter(s => s.type !== 'transition')
      .reduce((acc, s) => {
        const rawDur  = Math.max(0, (s.end_time_seconds || 0) - (s.start_time_seconds || 0))
        const padBef  = Math.max(0, Number(s.clip_padding       || 0))
        const padAft  = Math.max(0, Number(s.clip_padding_after || 0))
        // Bridges contribute 0 edit-time (instant cuts)
        if (s.type === 'bridge') return acc
        return acc + Math.max(1, rawDur + padBef + padAft)
      }, 0)
  }, [videoScript, metrics.duration])

  const overTarget = targetDuration && videoDuration > targetDuration
  const underTarget = targetDuration && videoDuration < targetDuration * 0.9

  return (
    <CollapsibleSection
      icon={BarChart3}
      label="Highlight Metrics"
      open={metricsExpanded}
      onToggle={() => setMetricsExpanded(v => !v)}
    >
      <div className="mt-2 space-y-2">
          {/* Duration */}
          <MetricRow
            icon={Clock}
            label="Duration"
            tooltip="Total production video duration (highlights + context fills + intro/outro)"
            value={formatDuration(videoDuration)}
            suffix={targetDuration ? ` / ${formatDuration(targetDuration)}` : ''}
            warning={overTarget ? 'Over target' : underTarget ? 'Under target' : null}
            warningColor={overTarget ? 'text-danger' : 'text-warning'}
          />

          {/* Event count */}
          <MetricRow
            icon={Target}
            label="Events"
            tooltip="Number of events selected as highlights vs total detected events"
            value={`${metrics.eventCount} / ${metrics.totalEvents}`}
          />

          {/* Coverage */}
          <MetricRow
            icon={BarChart3}
            label="Coverage"
            tooltip="Percentage of the race timeline covered by selected highlights"
            value={`${metrics.coveragePct}%`}
          />

          {/* Balance */}
          <MetricBar
            icon={Activity}
            label="Balance"
            tooltip="How evenly highlights are distributed across the race timeline (higher = more balanced)"
            value={metrics.balance}
            color={metrics.balance >= 60 ? 'bg-success' : metrics.balance >= 30 ? 'bg-warning' : 'bg-danger'}
          />

          {/* Pacing */}
          <MetricBar
            icon={Activity}
            label="Pacing"
            tooltip="Variety and tempo of event types — higher means better pacing with mixed event types"
            value={metrics.pacing}
            color={metrics.pacing >= 60 ? 'bg-success' : metrics.pacing >= 30 ? 'bg-warning' : 'bg-danger'}
          />

          {/* Driver coverage */}
          <MetricRow
            icon={Users}
            label="Drivers"
            tooltip="Number of unique drivers featured in highlights vs total drivers in the race"
            value={`${metrics.driverCount} / ${metrics.totalDrivers}`}
            suffix={` (${metrics.driverCoverage}%)`}
          />

          {/* Tier distribution */}
          {metrics.tierCounts && (
            <div className="pt-1 border-t border-border-subtle">
              <div className="flex items-center gap-2 mb-1">
                <BarChart3 className="w-3 h-3 text-text-tertiary shrink-0" />
                <span className="text-xxs text-text-secondary">Tier Distribution</span>
              </div>
              <div className="flex gap-1.5 ml-5">
                {['S', 'A', 'B', 'C'].map(tier => (
                  <div key={tier} className="flex items-center gap-0.5">
                    <span
                      className="inline-block w-4 h-4 rounded text-white font-bold flex items-center justify-center"
                      style={{
                        backgroundColor: tierColor(tier),
                        fontSize: '8px',
                      }}
                    >
                      {tier}
                    </span>
                    <span className="text-xxs text-text-secondary font-mono">
                      {metrics.tierCounts[tier] || 0}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </CollapsibleSection>
    )
  })


/** Single metric row with icon, label, value and optional tooltip */
function MetricRow({ icon: Icon, label, value, suffix, warning, warningColor, tooltip }) {
  const labelEl = (
    <span className="text-xxs text-text-secondary flex-1 flex items-center gap-1">
      {label}
      {tooltip && <Info className="w-3 h-3 text-text-disabled cursor-help shrink-0" />}
    </span>
  )
  return (
    <div className="flex items-center gap-2">
      <Icon className="w-3 h-3 text-text-tertiary shrink-0" />
      {tooltip ? <Tooltip content={tooltip} position="top" delay={200}>{labelEl}</Tooltip> : labelEl}
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


/** Metric with a progress bar (0–100) and optional tooltip */
function MetricBar({ icon: Icon, label, value, color, tooltip }) {
  const labelEl = (
    <span className="text-xxs text-text-secondary flex-1 flex items-center gap-1">
      {label}
      {tooltip && <Info className="w-3 h-3 text-text-disabled cursor-help shrink-0" />}
    </span>
  )
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <Icon className="w-3 h-3 text-text-tertiary shrink-0" />
        {tooltip ? <Tooltip content={tooltip} position="top" delay={200}>{labelEl}</Tooltip> : labelEl}
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
