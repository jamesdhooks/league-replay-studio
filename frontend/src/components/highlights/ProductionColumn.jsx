import React from 'react'
import { EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { EVENT_COLORS } from '../../context/TimelineContext'
import { formatTime, formatDuration } from '../../utils/time'
import { Layers, Merge, Film } from 'lucide-react'

/** Segment type → base color mapping */
function segColor(seg) {
  if (seg.type === 'bridge') return '#374151'  // gray-700
  if (seg.type === 'context') return '#4b5563'  // gray-600
  return EVENT_COLORS[seg.event_type] || '#6b7280'
}

/** Resolution badge icon per segment type */
function ResolutionBadge({ seg }) {
  if (seg.type === 'pip') return <Layers size={8} className="absolute top-0.5 right-0.5 text-white/80 z-10" />
  if (seg.type === 'merge') return <Merge size={8} className="absolute top-0.5 right-0.5 text-white/80 z-10" />
  if (seg.type === 'bridge') return <Film size={8} className="absolute top-0.5 right-0.5 text-white/60 z-10" />
  return null
}

export default function ProductionColumn({
  timeline, totalDuration, timeOffset = 0, compress,
  hoveredId, selectedId, onClick, onEnter, onLeave,
  width, flex = false,
}) {
  if (!timeline || timeline.length === 0) return <div className={flex ? 'flex-1 min-w-0' : 'shrink-0'} style={width ? { width } : undefined} />

  // In compress (edit-time) mode, total edit duration is the last segment's editEnd
  const lastSeg = timeline[timeline.length - 1]
  const editTotal = lastSeg ? (lastSeg.editEnd || 0) : 0

  return (
    <div className={`relative ${flex && !width ? 'flex-1 min-w-0' : 'shrink-0'}`} style={width ? { width } : undefined}>
      {timeline.map(seg => {
        // Bridges are instant cuts — skip rendering (they have zero edit duration).
        // In race-time mode they span huge gaps; in edit-time they contribute nothing.
        if (seg.type === 'bridge') return null

        const color = segColor(seg)
        const isSelected = selectedId === seg.primaryEventId || selectedId === seg.id
        const isHovered = hoveredId === seg.primaryEventId || hoveredId === seg.id

        let topStyle, heightStyle, minH
        if (compress) {
          // Edit-time scale: position by editStart/editDur
          const pct = editTotal > 0 ? (seg.editStart / editTotal) * 100 : 0
          const hPct = editTotal > 0 ? (seg.editDur / editTotal) * 100 : 0
          topStyle = `${pct}%`
          heightStyle = `${hPct}%`
          minH = seg.type === 'bridge' ? '2px' : '18px'
        } else {
          // Race-time scale: position by clipStart relative to race
          const adjustedStart = seg.clipStart - timeOffset
          const pct = totalDuration > 0 ? (adjustedStart / totalDuration) * 100 : 0
          const durationPct = totalDuration > 0 ? (seg.clipDuration / totalDuration) * 100 : 0
          topStyle = `${pct}%`
          heightStyle = `${durationPct}%`
          minH = seg.clipDuration > 0 ? '1px' : '0'
        }

        // Tooltip
        const tipLines = []
        if (seg.type === 'bridge') {
          tipLines.push('B-roll / Bridge')
          tipLines.push(`${formatDuration(seg.clipDuration)}`)
        } else {
          tipLines.push(EVENT_TYPE_LABELS[seg.event_type] || seg.event_type || seg.type)
          tipLines.push(`Score: ${seg.score?.toFixed?.(1) ?? '?'} | Tier: ${seg.tier || '?'}`)
          tipLines.push(`${formatTime(seg.clipStart)} — ${formatTime(seg.clipEnd)} (${formatDuration(seg.clipDuration)})`)
          if (seg.resolution && seg.resolution !== 'placed') tipLines.push(`Resolution: ${seg.resolution}`)
          if (seg.resolutionNote) tipLines.push(seg.resolutionNote)
        }

        const borderStyleVal = seg.type === 'bridge'
          ? '1px dashed rgba(255,255,255,0.15)'
          : undefined

        return (
          <div
            key={seg.id}
            className="absolute left-0 right-0 cursor-pointer overflow-hidden transition-all"
            style={{
              top: topStyle,
              height: heightStyle,
              minHeight: minH,
              backgroundColor: color,
              opacity: seg.type === 'bridge' ? 0.55 : 0.88,
              borderWidth: borderStyleVal ? undefined : (isSelected || isHovered ? 2 : 1),
              borderStyle: borderStyleVal ? undefined : 'solid',
              border: borderStyleVal || undefined,
              borderColor: borderStyleVal ? undefined : (
                isSelected
                  ? 'rgba(255,255,255,0.9)'
                  : isHovered
                    ? 'rgba(255,255,255,0.5)'
                    : 'rgba(255,255,255,0.18)'
              ),
              zIndex: isSelected ? 20 : isHovered ? 10 : 1,
            }}
            onClick={() => seg.type !== 'bridge' && onClick?.(seg)}
            onMouseEnter={() => onEnter?.(seg.primaryEventId || seg.id)}
            onMouseLeave={onLeave}
            title={tipLines.join('\n')}
          >
            <ResolutionBadge seg={seg} />
            <div className="px-1 py-px flex items-center gap-1" style={{ fontSize: 9, lineHeight: '11px' }}>
              <span className="text-white/90 font-medium truncate">
                {seg.type === 'bridge'
                  ? 'B-roll'
                  : seg.type === 'context'
                    ? `ctx: ${EVENT_TYPE_LABELS[seg.event_type] || '?'}`
                    : EVENT_TYPE_LABELS[seg.event_type] || '?'}
              </span>
              {flex && seg.type !== 'bridge' && (
                <>
                  <span className="text-white/50">·</span>
                  <span className="text-white/60 font-mono">{seg.score?.toFixed?.(1) ?? '?'}</span>
                  {seg.tier && <span className="text-white/50 font-mono">{seg.tier}</span>}
                </>
              )}
            </div>
            {/* Driver names */}
            {seg.driver_names?.length > 0 && (
              <div className="px-1 truncate" style={{ fontSize: 8, lineHeight: '10px' }}>
                <span className="text-white/65">{seg.driver_names.slice(0, 2).join(' / ')}</span>
              </div>
            )}
            {flex && seg.type !== 'bridge' && (
              <div className="px-1 truncate" style={{ fontSize: 8, lineHeight: '10px' }}>
                <span className="text-white/60">{formatTime(seg.clipStart)} – {formatTime(seg.clipEnd)}</span>
                <span className="text-white/40 ml-1">({formatDuration(seg.clipDuration)})</span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
