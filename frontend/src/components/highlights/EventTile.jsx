import { EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { EVENT_COLORS } from '../../context/TimelineContext'
import { formatTime, formatDuration } from '../../utils/time'

export default function EventTile({
  event: evt, totalDuration, timeOffset = 0,
  isHovered, isSelected,
  onClick, onEnter, onLeave, onRightClick,
  horizontal = false,
  paddingBefore = 0, paddingAfter = 0,
}) {
  const color = EVENT_COLORS[evt.event_type] || '#6b7280'
  const isHighlight = evt.inclusion === 'highlight'
  const isFullVideo = evt.inclusion === 'full-video'
  const adjustedStart = evt.start_time_seconds - timeOffset
  const duration = Math.max(0, (evt.end_time_seconds || 0) - (evt.start_time_seconds || 0))
  const opacity = isHighlight ? 1 : isFullVideo ? 0.5 : 0.2
  const pct = totalDuration > 0 ? (adjustedStart / totalDuration) * 100 : 0
  const durationPct = totalDuration > 0 ? (duration / totalDuration) * 100 : 0
  const padBeforePct = totalDuration > 0 ? (paddingBefore / totalDuration) * 100 : 0
  const padAfterPct = totalDuration > 0 ? (paddingAfter / totalDuration) * 100 : 0
  
  // Effective size: only based on duration, never inflated by padding alone.
  // Padding is rendered as separate faded strips around the event body.
  const hasContent = duration > 0
  const sizePct = hasContent
    ? Math.max(0.4, durationPct)  // Min 0.4% to ensure visibility when event exists
    : 0  // Zero size for instantaneous events with no padding

  const posStyle = horizontal
    ? { left: `${pct}%`, width: `${sizePct}%`, top: 1, bottom: 1 }
    : { top: `${pct}%`, height: `${sizePct}%`, left: 0, right: 0, minHeight: hasContent ? 20 : 0 }

  // Min 3px ensures padding is always visible even for short durations in a long race
  const padBeforeStyle = horizontal
    ? { left: `${Math.max(0, pct - padBeforePct)}%`, width: `${padBeforePct}%`, minWidth: 3, top: 1, bottom: 1 }
    : { top: `${Math.max(0, pct - padBeforePct)}%`, height: `${padBeforePct}%`, minHeight: 3, left: 0, right: 0 }

  const padAfterStyle = horizontal
    ? { left: `${pct + sizePct}%`, width: `${padAfterPct}%`, minWidth: 3, top: 1, bottom: 1 }
    : { top: `${pct + sizePct}%`, height: `${padAfterPct}%`, minHeight: 3, left: 0, right: 0 }

  return (
    <>
      {padBeforePct > 0 && (
        <div
          className="absolute pointer-events-none"
          style={{ ...padBeforeStyle, backgroundColor: color, opacity: opacity * 0.25, zIndex: 0 }}
        />
      )}
      {padAfterPct > 0 && (
        <div
          className="absolute pointer-events-none"
          style={{ ...padAfterStyle, backgroundColor: color, opacity: opacity * 0.25, zIndex: 0 }}
        />
      )}
      <div
        className="absolute cursor-pointer transition-all duration-100 overflow-hidden"
        style={{
          ...posStyle,
          backgroundColor: color,
          opacity,
          borderWidth: isSelected || isHovered ? 2 : 1,
          borderStyle: 'solid',
          borderColor: isSelected
            ? 'rgba(255,255,255,0.8)'
            : isHovered
              ? 'rgba(255,255,255,0.5)'
              : 'rgba(255,255,255,0.1)',
          zIndex: isSelected ? 20 : isHovered ? 10 : 1,
        }}
        onClick={onClick}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onContextMenu={e => { e.preventDefault(); onRightClick() }}
      >
        {evt.narrative_anchor && (
          <span className="absolute top-0 right-0 text-yellow-300 z-10 leading-none" style={{ fontSize: 8 }}>★</span>
        )}
        {evt.segment_type === 'pip' && (
          <div
            className="absolute right-0 top-0 bottom-0 w-1/3 opacity-30"
            style={{ backgroundImage: 'repeating-linear-gradient(45deg,transparent,transparent 2px,rgba(255,255,255,0.3) 2px,rgba(255,255,255,0.3) 4px)' }}
          />
        )}
        <div className="px-0.5 py-px truncate" style={{ fontSize: 9, lineHeight: '11px' }}>
          <span className="text-white/90 font-medium">
            {EVENT_TYPE_LABELS[evt.event_type]?.slice(0, 3) || '?'}
          </span>
        </div>
      </div>
    </>
  )
}
