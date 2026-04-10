import React from 'react'
import { EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { EVENT_COLORS } from '../../context/TimelineContext'
import { formatTime, formatDuration } from '../../utils/time'
import { Layers } from 'lucide-react'

export default function ResultColumn({
  events, totalDuration, timeOffset = 0, compress, compressPositions,
  hoveredId, selectedId, onClick, onEnter, onLeave,
  width, flex = false, isPip = false, paddingParams = null,
}) {
  return (
    <div className={`relative ${flex && !width ? 'flex-1 min-w-0' : 'shrink-0'}`} style={width ? { width } : undefined}>
      {events.map(evt => {
        const color = EVENT_COLORS[evt.event_type] || '#6b7280'
        const isSelected = selectedId === evt.id
        const isHovered = hoveredId === evt.id
        const duration = Math.max(0, (evt.end_time_seconds || 0) - (evt.start_time_seconds || 0))

        // Compute per-event padding (type override → global default → 0)
        const typeSettings = paddingParams?.paddingByType?.[evt.event_type] || {}
        const paddingBefore = typeSettings.before != null ? typeSettings.before : (paddingParams?.paddingBefore ?? 0)
        const paddingAfter = typeSettings.after != null ? typeSettings.after : (paddingParams?.paddingAfter ?? 0)

        let topStyle, heightStyle, minH, padBeforeStyle, padAfterStyle
        if (compress && compressPositions) {
          topStyle = `${compressPositions.get(evt.id) ?? 0}px`
          heightStyle = '34px'
          minH = '34px'
          padBeforeStyle = null
          padAfterStyle = null
        } else {
          const adjustedStart = evt.start_time_seconds - timeOffset
          const pct = totalDuration > 0 ? (adjustedStart / totalDuration) * 100 : 0
          const durationPct = totalDuration > 0 ? (duration / totalDuration) * 100 : 0
          const padBeforePct = totalDuration > 0 ? (paddingBefore / totalDuration) * 100 : 0
          const padAfterPct = totalDuration > 0 ? (paddingAfter / totalDuration) * 100 : 0
          const heightPct = duration > 0 ? durationPct : 0
          topStyle = `${pct}%`
          heightStyle = `${heightPct}%`
          minH = duration > 0 ? '1px' : '0'
          padBeforeStyle = padBeforePct > 0
            ? { top: `${Math.max(0, pct - padBeforePct)}%`, height: `${padBeforePct}%`, minHeight: 3 }
            : null
          padAfterStyle = padAfterPct > 0
            ? { top: `${pct + heightPct}%`, height: `${padAfterPct}%`, minHeight: 3 }
            : null
        }

        return (
          <React.Fragment key={evt.id}>
            {padBeforeStyle && (
              <div className="absolute left-0 right-0 pointer-events-none"
                style={{ ...padBeforeStyle, backgroundColor: color, opacity: 0.22, zIndex: 0 }} />
            )}
            {padAfterStyle && (
              <div className="absolute left-0 right-0 pointer-events-none"
                style={{ ...padAfterStyle, backgroundColor: color, opacity: 0.22, zIndex: 0 }} />
            )}
            <div
            className="absolute left-0 right-0 cursor-pointer overflow-hidden transition-all"
            style={{
              top: topStyle,
              height: heightStyle,
              minHeight: minH,
              backgroundColor: color,
              opacity: 0.88,
              borderWidth: isSelected || isHovered ? 2 : 1,
              borderStyle: 'solid',
              borderColor: isSelected
                ? 'rgba(255,255,255,0.9)'
                : isHovered
                  ? 'rgba(255,255,255,0.5)'
                  : 'rgba(255,255,255,0.18)',
              zIndex: isSelected ? 20 : isHovered ? 10 : 1,
            }}
            onClick={() => onClick(evt)}
            onMouseEnter={() => onEnter(evt.id)}
            onMouseLeave={onLeave}
            title={[
              EVENT_TYPE_LABELS[evt.event_type] || evt.event_type,
              `Score: ${evt.score ?? '?'} | Tier: ${evt.tier || '?'}`,
              `${formatTime(evt.start_time_seconds)} — ${formatTime(evt.end_time_seconds)} (${formatDuration(duration)})`,
              isPip ? '• PIP' : '',
            ].filter(Boolean).join('\n')}
          >
            {isPip && <Layers size={8} className="absolute top-0.5 right-0.5 text-white/80 z-10" />}
            <div className="px-1 py-px flex items-center gap-1" style={{ fontSize: 9, lineHeight: '11px' }}>
              <span className="text-white/90 font-medium truncate">
                {EVENT_TYPE_LABELS[evt.event_type] || '?'}
              </span>
              {flex && !isPip && (
                <>
                  <span className="text-white/50">·</span>
                  <span className="text-white/60 font-mono">{typeof evt.score === 'number' ? evt.score.toFixed(1) : '?'}</span>
                  {evt.tier && <span className="text-white/50 font-mono">{evt.tier}</span>}
                </>
              )}
            </div>
            {/* Driver names */}
            {evt.driver_names?.length > 0 && (
              <div className="px-1 truncate" style={{ fontSize: 8, lineHeight: '10px' }}>
                <span className="text-white/65">{evt.driver_names.slice(0, 2).join(' / ')}</span>
              </div>
            )}
            {flex && !isPip && (compress || parseInt(heightStyle) > 26) && (
              <div className="px-1 truncate" style={{ fontSize: 8, lineHeight: '10px' }}>
                <span className="text-white/60">{formatTime(evt.start_time_seconds)} – {formatTime(evt.end_time_seconds)}</span>
                <span className="text-white/40 ml-1">({formatDuration(duration)})</span>
              </div>
            )}
            {!flex && compress && (
              <div className="px-1 truncate" style={{ fontSize: 8, lineHeight: '10px', opacity: 0.7 }}>
                <span className="text-white/70">{formatTime(evt.start_time_seconds)}</span>
              </div>
            )}
          </div>
          </React.Fragment>
        )
      })}
    </div>
  )
}
