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

  // Core size remains visible for very short non-zero events.
  const hasContent = duration > 0
  const coreSizePct = hasContent
    ? Math.max(0.4, durationPct)  // Min 0.4% to ensure visibility when event exists
    : 0  // Zero size for instantaneous events with no padding

  // Render as one parent tile spanning lead-in + core + lead-out.
  const fullStartPct = Math.max(0, pct - padBeforePct)
  const fullSizePct = coreSizePct + padBeforePct + padAfterPct
  const hasVisibleTile = fullSizePct > 0

  const tileStyle = horizontal
    ? {
        left: `${fullStartPct}%`,
        width: `${fullSizePct}%`,
        minWidth: hasVisibleTile ? 3 : 0,
        top: 1,
        bottom: 1,
      }
    : {
        top: `${fullStartPct}%`,
        height: `${fullSizePct}%`,
        minHeight: hasVisibleTile ? 3 : 0,
        left: 0,
        right: 0,
      }

  const relBeforePct = fullSizePct > 0 ? (padBeforePct / fullSizePct) * 100 : 0
  const relCorePct = fullSizePct > 0 ? (coreSizePct / fullSizePct) * 100 : 0
  const relAfterPct = Math.max(0, 100 - relBeforePct - relCorePct)

  const baseAlpha = Math.max(0.12, opacity)
  const coreAlpha = Math.min(1, baseAlpha)
  const padAlpha = Math.min(1, baseAlpha * 0.35)

  if (!hasVisibleTile) return null

  return (
    <div
      className="absolute cursor-pointer transition-all duration-100 overflow-hidden"
      style={{
        ...tileStyle,
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
      {padBeforePct > 0 && (
        <div
          className="absolute pointer-events-none"
          style={horizontal
            ? { left: 0, top: 0, bottom: 0, width: `${relBeforePct}%`, backgroundColor: color, opacity: padAlpha }
            : { top: 0, left: 0, right: 0, height: `${relBeforePct}%`, backgroundColor: color, opacity: padAlpha }}
        />
      )}

      {coreSizePct > 0 && (
        <div
          className="absolute pointer-events-none"
          style={horizontal
            ? { left: `${relBeforePct}%`, top: 0, bottom: 0, width: `${relCorePct}%`, backgroundColor: color, opacity: coreAlpha }
            : { top: `${relBeforePct}%`, left: 0, right: 0, height: `${relCorePct}%`, backgroundColor: color, opacity: coreAlpha }}
        />
      )}

      {padAfterPct > 0 && (
        <div
          className="absolute pointer-events-none"
          style={horizontal
            ? { left: `${relBeforePct + relCorePct}%`, top: 0, bottom: 0, width: `${relAfterPct}%`, backgroundColor: color, opacity: padAlpha }
            : { top: `${relBeforePct + relCorePct}%`, left: 0, right: 0, height: `${relAfterPct}%`, backgroundColor: color, opacity: padAlpha }}
        />
      )}

      {evt.narrative_anchor && (
        <span className="absolute top-0 right-0 text-yellow-300 z-10 leading-none" style={{ fontSize: 8 }}>★</span>
      )}
      {evt.segment_type === 'pip' && (
        <div
          className="absolute right-0 top-0 bottom-0 w-1/3 opacity-30 pointer-events-none"
          style={{ backgroundImage: 'repeating-linear-gradient(45deg,transparent,transparent 2px,rgba(255,255,255,0.3) 2px,rgba(255,255,255,0.3) 4px)' }}
        />
      )}

      <div className="absolute inset-0 px-0.5 py-px truncate pointer-events-none" style={{ fontSize: 9, lineHeight: '11px' }}>
        <span className="text-white/90 font-medium">
          {EVENT_TYPE_LABELS[evt.event_type]?.slice(0, 3) || '?'}
        </span>
      </div>
    </div>
  )
}
