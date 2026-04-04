import { useMemo } from 'react'
import { useHighlight } from '../../context/HighlightContext'
import { useTimeline, EVENT_COLORS } from '../../context/TimelineContext'

/**
 * HighlightTimeline — Condensed mini-timeline showing all events.
 *
 * Included events are bright and fully opaque.
 * Excluded events are dimmed with striped pattern, showing what was NOT selected.
 * Gives a clear visual overview of the editing decisions.
 */
export default function HighlightTimeline() {
  const { selection, metrics } = useHighlight()
  const { raceDuration, seekTo, playheadTime } = useTimeline()

  const { highlightEvents, fullVideoEvents, excludedEvents } = useMemo(() => {
    const sorted = [...selection.scoredEvents].sort((a, b) => a.start_time_seconds - b.start_time_seconds)
    return {
      highlightEvents: sorted.filter(e => e.inclusion === 'highlight'),
      fullVideoEvents: sorted.filter(e => e.inclusion === 'full-video'),
      excludedEvents: sorted.filter(e => e.inclusion === 'excluded'),
    }
  }, [selection.scoredEvents])

  if (raceDuration <= 0) {
    return (
      <div className="h-full flex items-center justify-center text-text-disabled text-xxs">
        No timeline data
      </div>
    )
  }

  const handleClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const time = (x / rect.width) * raceDuration
    seekTo(time)
  }

  const playheadPct = (playheadTime / raceDuration) * 100

  return (
    <div className="h-full flex flex-col px-3 py-1.5 bg-bg-secondary">
      {/* Label row with legend */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-3">
          <span className="text-xxs text-text-tertiary font-medium">
            Highlight Timeline
          </span>
          <span className="flex items-center gap-1 text-xxs text-text-disabled">
            <span className="inline-block w-2 h-2 rounded-sm bg-accent" /> Highlight
          </span>
          <span className="flex items-center gap-1 text-xxs text-text-disabled">
            <span className="inline-block w-2 h-2 rounded-sm bg-info opacity-50" /> Full-video
          </span>
          <span className="flex items-center gap-1 text-xxs text-text-disabled">
            <span className="inline-block w-2 h-2 rounded-sm bg-text-disabled opacity-20" /> Excluded
          </span>
        </div>
        <span className="text-xxs text-text-disabled font-mono">
          {metrics.eventCount} highlight + {metrics.fullVideoCount || 0} full · {formatCompactDuration(metrics.duration)}
        </span>
      </div>

      {/* Timeline bar */}
      <div
        className="flex-1 relative bg-bg-primary rounded cursor-pointer overflow-hidden min-h-[16px]"
        onClick={handleClick}
      >
        {/* Excluded event segments (background, dimmed) */}
        {excludedEvents.map(evt => {
          const left = (evt.start_time_seconds / raceDuration) * 100
          const width = Math.max(0.15, ((evt.end_time_seconds - evt.start_time_seconds) / raceDuration) * 100)
          const color = EVENT_COLORS[evt.event_type] || '#666'

          return (
            <div
              key={`ex-${evt.id}`}
              className="absolute top-0 bottom-0 rounded-sm"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                backgroundColor: color,
                opacity: 0.12,
              }}
              title={`✗ ${evt.event_type} [${evt.tier || '?'}] (score ${evt.score}) — ${evt.reason}`}
            />
          )
        })}

        {/* Full-video event segments (mid brightness) */}
        {fullVideoEvents.map(evt => {
          const left = (evt.start_time_seconds / raceDuration) * 100
          const width = Math.max(0.15, ((evt.end_time_seconds - evt.start_time_seconds) / raceDuration) * 100)
          const color = EVENT_COLORS[evt.event_type] || '#666'

          return (
            <div
              key={`fv-${evt.id}`}
              className="absolute top-0 bottom-0 rounded-sm border border-white/10"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                backgroundColor: color,
                opacity: 0.4,
              }}
              title={`○ ${evt.event_type} [${evt.tier || '?'}] (score ${evt.score}) — full-video only`}
            />
          )
        })}

        {/* Highlight event segments (foreground, bright) */}
        {highlightEvents.map(evt => {
          const left = (evt.start_time_seconds / raceDuration) * 100
          const width = Math.max(0.2, ((evt.end_time_seconds - evt.start_time_seconds) / raceDuration) * 100)
          const color = EVENT_COLORS[evt.event_type] || '#666'

          return (
            <div
              key={`hl-${evt.id}`}
              className="absolute top-0 bottom-0 rounded-sm ring-1 ring-white/20"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                backgroundColor: color,
                opacity: 0.85,
              }}
              title={`✓ ${evt.event_type} [${evt.tier || '?'}] (score ${evt.score})`}
            />
          )
        })}

        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-accent z-10"
          style={{ left: `${playheadPct}%` }}
        />
      </div>
    </div>
  )
}


function formatCompactDuration(seconds) {
  if (!seconds) return '0s'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
