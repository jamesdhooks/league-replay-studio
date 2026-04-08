import { EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { EVENT_COLORS } from '../../context/TimelineContext'
import { formatTime, formatDuration } from '../../utils/time'

export default function EventTile({
  event: evt, totalDuration, timeOffset = 0,
  isHovered, isSelected,
  onClick, onEnter, onLeave, onRightClick,
  horizontal = false,
}) {
  const color = EVENT_COLORS[evt.event_type] || '#6b7280'
  const isHighlight = evt.inclusion === 'highlight'
  const isFullVideo = evt.inclusion === 'full-video'
  const adjustedStart = evt.start_time_seconds - timeOffset
  const duration = Math.max(0, (evt.end_time_seconds || 0) - (evt.start_time_seconds || 0))
  const opacity = isHighlight ? 1 : isFullVideo ? 0.5 : 0.2
  const pct = totalDuration > 0 ? (adjustedStart / totalDuration) * 100 : 0
  const sizePct = totalDuration > 0 ? Math.max(0.4, (duration / totalDuration) * 100) : 0.4

  const posStyle = horizontal
    ? { left: `${pct}%`, width: `${sizePct}%`, top: 1, bottom: 1 }
    : { top: `${pct}%`, height: `${sizePct}%`, left: 0, right: 0, minHeight: 20 }

  return (
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
      title={[
        EVENT_TYPE_LABELS[evt.event_type] || evt.event_type,
        `Score: ${evt.score ?? '?'} | Tier: ${evt.tier || '?'}`,
        `${formatTime(evt.start_time_seconds)} — ${formatTime(evt.end_time_seconds)} (${formatDuration(duration)})`,
        evt.reason || '',
        isHighlight ? '✓ Selected' : isFullVideo ? '○ Full-video' : '✗ Excluded',
      ].filter(Boolean).join('\n')}
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
  )
}
