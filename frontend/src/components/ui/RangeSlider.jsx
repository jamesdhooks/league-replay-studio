import { useMemo, useCallback, useRef } from 'react'
import { EVENT_COLORS } from '../../context/TimelineContext'
import { formatTime } from '../../utils/time'

/**
 * RangeSlider — Dual-handle range slider controlling the visible viewport.
 * Full range = no scrolling (everything on one page).
 * Narrower range = zoomed in, histogram scrolls to show the selected window.
 * The center region is draggable to pan without changing zoom level.
 */
export default function RangeSlider({ rangeStart, rangeEnd, onChange, totalDuration, events }) {
  const trackRef = useRef(null)

  const pctToFraction = useCallback((clientX) => {
    if (!trackRef.current) return 0
    const rect = trackRef.current.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }, [])

  const startDrag = useCallback((handle, e) => {
    e.preventDefault()
    e.stopPropagation()
    const startFrac = pctToFraction(e.clientX)
    const capturedStart = rangeStart
    const capturedEnd = rangeEnd
    const capturedWidth = capturedEnd - capturedStart
    const onMove = (mv) => {
      const frac = pctToFraction(mv.clientX)
      if (handle === 'start') {
        onChange(Math.max(0, Math.min(frac, capturedEnd - 0.02)), capturedEnd)
      } else if (handle === 'end') {
        onChange(capturedStart, Math.min(1, Math.max(frac, capturedStart + 0.02)))
      } else {
        // pan: keep width constant
        const delta = frac - startFrac
        const newStart = Math.max(0, Math.min(1 - capturedWidth, capturedStart + delta))
        onChange(newStart, newStart + capturedWidth)
      }
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pctToFraction, rangeStart, rangeEnd, onChange])

  // Mini event density preview
  const miniEvents = useMemo(() => {
    if (totalDuration <= 0) return []
    return events.map(e => ({
      pct: (e.start_time_seconds / totalDuration) * 100,
      endPct: ((e.end_time_seconds || e.start_time_seconds) / totalDuration) * 100,
      color: EVENT_COLORS[e.event_type] || '#6b7280',
      highlight: e.inclusion === 'highlight',
    }))
  }, [events, totalDuration])

  const leftPct = rangeStart * 100
  const widthPct = (rangeEnd - rangeStart) * 100
  const isZoomed = rangeStart > 0.001 || rangeEnd < 0.999

  return (
    <div className="shrink-0 border-t border-border bg-bg-secondary px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[9px] text-text-disabled font-mono w-12">
          {formatTime(totalDuration * rangeStart)}
        </span>
        <div ref={trackRef} className="relative flex-1 h-5 bg-bg-primary border border-border-subtle rounded-sm select-none">
          {/* Event bars with width */}
          {miniEvents.map((ev, i) => (
            <div key={i} className="absolute top-0 bottom-0 rounded-[1px]"
                 style={{ left: `${ev.pct}%`,
                          width: `${Math.max(0.3, ev.endPct - ev.pct)}%`,
                          backgroundColor: ev.color,
                          opacity: ev.highlight ? 0.5 : 0.12,
                          pointerEvents: 'none' }} />
          ))}

          {/* Dimmed regions outside range */}
          <div className="absolute inset-y-0 left-0 bg-black/40 rounded-l-sm pointer-events-none" style={{ width: `${leftPct}%` }} />
          <div className="absolute inset-y-0 right-0 bg-black/40 rounded-r-sm pointer-events-none" style={{ width: `${100 - leftPct - widthPct}%` }} />

          {/* Active region highlight */}
          {isZoomed && (
            <div
              className="absolute inset-y-0 border-y border-accent/20 bg-accent/5 pointer-events-none"
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            />
          )}

          {/* Center pan region */}
          <div
            className="absolute inset-y-0 cursor-grab active:cursor-grabbing"
            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            onMouseDown={(e) => startDrag('pan', e)}
          />

          {/* Left handle */}
          <div
            className="absolute top-0 bottom-0 w-2 cursor-ew-resize bg-accent/70 hover:bg-accent z-10 rounded-l-sm"
            style={{ left: `${leftPct}%` }}
            onMouseDown={(e) => startDrag('start', e)}
          />

          {/* Right handle */}
          <div
            className="absolute top-0 bottom-0 w-2 cursor-ew-resize bg-accent/70 hover:bg-accent z-10 rounded-r-sm"
            style={{ left: `calc(${leftPct + widthPct}% - 8px)` }}
            onMouseDown={(e) => startDrag('end', e)}
          />
        </div>
        <span className="text-[9px] text-text-disabled font-mono w-12 text-right">
          {formatTime(totalDuration * rangeEnd)}
        </span>
        {isZoomed && (
          <button
            onClick={() => onChange(0, 1)}
            className="text-[9px] text-accent hover:text-accent-hover"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  )
}
