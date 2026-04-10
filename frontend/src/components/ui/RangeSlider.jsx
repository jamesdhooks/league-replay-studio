import { useMemo, useCallback, useRef } from 'react'
import { EVENT_COLORS } from '../../context/TimelineContext'
import { formatTime } from '../../utils/time'

/**
 * RangeSlider — Dual-handle range slider controlling the visible viewport.
 * Full range = no scrolling (everything on one page).
 * Narrower range = zoomed in, histogram scrolls to show the selected window.
 * The center region is draggable to pan without changing zoom level.
 */
export default function RangeSlider({ rangeStart, rangeEnd, onChange, totalDuration, events, playheadTime = null }) {
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

  const playheadPct = useMemo(() => {
    if (totalDuration <= 0) return null
    if (typeof playheadTime !== 'number' || Number.isNaN(playheadTime)) return null
    const clamped = Math.max(0, Math.min(totalDuration, playheadTime))
    return (clamped / totalDuration) * 100
  }, [playheadTime, totalDuration])

  return (
    <div className="shrink-0 border-t-2 border-border bg-bg-secondary px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-text-secondary font-mono w-14">
          {formatTime(totalDuration * rangeStart)}
        </span>
        <div ref={trackRef} className="relative flex-1 h-7 bg-bg-primary border border-border rounded select-none">
          {/* Event bars with width */}
          {miniEvents.map((ev, i) => (
            <div key={i} className="absolute top-0 bottom-0 rounded-[1px]"
                 style={{ left: `${ev.pct}%`,
                          width: `${Math.max(0.3, ev.endPct - ev.pct)}%`,
                          backgroundColor: ev.color,
                          opacity: ev.highlight ? 0.5 : 0.12,
                          pointerEvents: 'none' }} />
          ))}

          {/* Current playhead marker */}
          {playheadPct != null && (
            <div
              className="absolute top-0 bottom-0 z-20 pointer-events-none"
              style={{ left: `${playheadPct}%` }}
              title={`Playhead: ${formatTime((playheadPct / 100) * totalDuration)}`}
            >
              <div className="h-full w-px bg-red-500" />
              <div className="absolute -top-1 -left-1 w-2 h-2 rounded-full bg-red-500" />
            </div>
          )}

          {/* Dimmed regions outside range */}
          <div className="absolute inset-y-0 left-0 bg-black/55 rounded-l pointer-events-none" style={{ width: `${leftPct}%` }} />
          <div className="absolute inset-y-0 right-0 bg-black/55 rounded-r pointer-events-none" style={{ width: `${100 - leftPct - widthPct}%` }} />

          {/* Active region highlight */}
          <div
            className="absolute inset-y-0 border-y-2 border-accent/60 bg-accent/10 pointer-events-none"
            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
          />

          {/* Center pan region */}
          <div
            className="absolute inset-y-0 cursor-grab active:cursor-grabbing"
            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            onMouseDown={(e) => startDrag('pan', e)}
          />

          {/* Left handle */}
          <div
            className="absolute top-0 bottom-0 w-3 cursor-ew-resize bg-accent hover:bg-accent-hover z-10 rounded-l flex items-center justify-center"
            style={{ left: `${leftPct}%` }}
            onMouseDown={(e) => startDrag('start', e)}
          >
            <div className="w-px h-3 bg-white/50" />
          </div>

          {/* Right handle */}
          <div
            className="absolute top-0 bottom-0 w-3 cursor-ew-resize bg-accent hover:bg-accent-hover z-10 rounded-r flex items-center justify-center"
            style={{ left: `calc(${leftPct + widthPct}% - 12px)` }}
            onMouseDown={(e) => startDrag('end', e)}
          >
            <div className="w-px h-3 bg-white/50" />
          </div>
        </div>
        <span className="text-[10px] text-text-secondary font-mono w-14 text-right">
          {formatTime(totalDuration * rangeEnd)}
        </span>
        <button
          onClick={() => onChange(0, 1)}
          disabled={!isZoomed}
          className={`text-xs px-2 py-0.5 rounded border transition-colors ${
            isZoomed
              ? 'text-accent border-accent/40 hover:bg-accent/10 cursor-pointer'
              : 'text-text-disabled border-border-subtle cursor-not-allowed opacity-40'
          }`}
        >
          Reset
        </button>
      </div>
    </div>
  )
}
