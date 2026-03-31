import { useMemo } from 'react'
import { useHighlight } from '../../context/HighlightContext'
import { useTimeline, EVENT_COLORS } from '../../context/TimelineContext'

/**
 * HighlightTimeline — Condensed mini-timeline showing highlight segments.
 *
 * Renders a horizontal bar representing the full race with colored segments
 * for each included event. Gives a visual overview of the highlight reel.
 */
export default function HighlightTimeline() {
  const { selection, metrics } = useHighlight()
  const { raceDuration, seekTo, playheadTime } = useTimeline()

  const includedEvents = useMemo(
    () => selection.scoredEvents.filter(e => e.included).sort((a, b) => a.start_time_seconds - b.start_time_seconds),
    [selection.scoredEvents],
  )

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
      {/* Label */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-xxs text-text-tertiary font-medium">
          Highlight Preview
        </span>
        <span className="text-xxs text-text-disabled font-mono">
          {metrics.eventCount} clips · {formatCompactDuration(metrics.duration)}
        </span>
      </div>

      {/* Timeline bar */}
      <div
        className="flex-1 relative bg-bg-primary rounded cursor-pointer overflow-hidden min-h-[12px]"
        onClick={handleClick}
      >
        {/* Event segments */}
        {includedEvents.map(evt => {
          const left = (evt.start_time_seconds / raceDuration) * 100
          const width = Math.max(0.2, ((evt.end_time_seconds - evt.start_time_seconds) / raceDuration) * 100)
          const color = EVENT_COLORS[evt.event_type] || '#666'

          return (
            <div
              key={evt.id}
              className="absolute top-0 bottom-0 rounded-sm"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                backgroundColor: color,
                opacity: 0.8,
              }}
              title={`${evt.event_type} (${evt.score})`}
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
