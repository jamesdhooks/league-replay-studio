import { useMemo, useState, useCallback, useRef } from 'react'
import { useHighlight, EVENT_TYPE_LABELS, tierColor } from '../../context/HighlightContext'
import { useTimeline, EVENT_COLORS } from '../../context/TimelineContext'
import { formatTime } from '../../utils/time'
import { Columns3, ArrowRight, Layers } from 'lucide-react'

/**
 * HighlightHistogram — Unified score histogram + result timeline.
 *
 * LEFT: 10 score-bucket columns. Events are positioned vertically by race time,
 *       sized by duration. Opacity reflects selection state.
 *
 * RIGHT extension: Two result columns — "Chosen Events" and "PIP" — using the
 *       SAME time axis as the histogram so alignment is visual and instant.
 *
 * Compress toggle: switches result columns from time-based to sequential stacking,
 *       eliminating dead air to preview the final edit sequence.
 *
 * The entire view uses a tall scrollable container (3px per second of race time)
 * so events are spread out and readable.
 */

const BUCKET_COUNT = 10
const BUCKET_LABELS = Array.from({ length: BUCKET_COUNT }, (_, i) => i + 1)
const PX_PER_SECOND = 3    // 3 pixels per second of race time
const MIN_HEIGHT_PX = 900  // never shorter than this

/** Map a score (0–10) to bucket index 0–9 */
function scoreToBucket(score) {
  if (score == null || score <= 0) return 0
  return Math.max(0, Math.min(BUCKET_COUNT - 1, Math.floor(score)))
}

function formatDuration(sec) {
  if (!sec || sec <= 0) return '0s'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

// ─────────────────────────────────────────────────────────────────────────────

export default function HighlightHistogram() {
  const { selection, metrics, toggleOverride, jumpToEvent } = useHighlight()
  const { raceDuration, selectedEventId, setSelectedEventId } = useTimeline()
  const [hoveredId, setHoveredId] = useState(null)
  const [compress, setCompress] = useState(false)
  const scrollRef = useRef(null)

  // ── Derive data ───────────────────────────────────────────────────────────
  const { buckets, totalDuration, allEvents, chosenEvents, pipEvents } = useMemo(() => {
    const all = [...(selection.scoredEvents || [])]
      .sort((a, b) => a.start_time_seconds - b.start_time_seconds)

    const dur = raceDuration > 0
      ? raceDuration
      : all.length > 0 ? Math.max(...all.map(e => e.end_time_seconds || 0)) : 0

    const bkts = Array.from({ length: BUCKET_COUNT }, () => [])
    for (const evt of all) bkts[scoreToBucket(evt.score)].push(evt)

    const highlights = all.filter(e => e.inclusion === 'highlight')
    return {
      buckets: bkts,
      totalDuration: dur,
      allEvents: all,
      chosenEvents: highlights.filter(e => e.segment_type !== 'pip'),
      pipEvents: highlights.filter(e => e.segment_type === 'pip'),
    }
  }, [selection.scoredEvents, raceDuration])

  // Tall scrollable height
  const contentHeight = useMemo(() =>
    Math.max(MIN_HEIGHT_PX, totalDuration * PX_PER_SECOND),
    [totalDuration],
  )

  // Compressed sequential positions for result columns
  const compressState = useMemo(() => {
    if (!compress) return null
    const ITEM_H = 38
    const GAP = 4
    const map = new Map()
    let top = 0
    const combined = [...chosenEvents, ...pipEvents]
      .sort((a, b) => a.start_time_seconds - b.start_time_seconds)
    for (const evt of combined) {
      map.set(evt.id, top)
      top += ITEM_H + GAP
    }
    return { map, totalHeight: top + 20 }
  }, [compress, chosenEvents, pipEvents])

  const handleClick = useCallback((evt) => {
    setSelectedEventId(evt.id)
    jumpToEvent(evt)
  }, [setSelectedEventId, jumpToEvent])

  if (totalDuration <= 0 && allEvents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-disabled text-xs gap-2">
        <Columns3 size={16} className="opacity-40" />
        <span>No events to display. Run analysis first.</span>
      </div>
    )
  }

  const innerHeight = compress && compressState ? compressState.totalHeight : contentHeight

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">

      {/* ── Header bar ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-secondary shrink-0">
        <Columns3 size={13} className="text-accent shrink-0" />
        <span className="text-xs font-semibold text-text-primary uppercase tracking-wider whitespace-nowrap">
          Score Histogram
        </span>
        <span className="text-xs text-text-disabled">
          {allEvents.length} events · {formatDuration(totalDuration)}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setCompress(v => !v)}
          className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors
            ${compress
              ? 'bg-accent/15 text-accent border-accent/30'
              : 'text-text-tertiary border-border-subtle hover:text-text-secondary hover:border-border'}`}
        >
          ⇟ {compress ? 'Compressed' : 'Compress'}
        </button>
        <div className="w-px h-4 bg-border-subtle mx-1" />
        <ArrowRight size={12} className="text-accent shrink-0" />
        <span className="text-xs font-semibold text-text-primary uppercase tracking-wider whitespace-nowrap">
          Result
        </span>
        <span className="text-xs text-text-disabled">
          {metrics.eventCount || 0} clips · {formatDuration(metrics.duration)}
        </span>
      </div>

      {/* ── Column headers ─────────────────────────────────────────────── */}
      <div className="flex shrink-0 border-b border-border-subtle bg-bg-secondary select-none">
        <div className="shrink-0 border-r border-border-subtle text-center text-xs text-text-disabled py-1.5"
             style={{ width: 52 }}>
          Time
        </div>
        {BUCKET_LABELS.map(label => (
          <div key={label}
               className="flex-1 text-center text-xs font-semibold text-text-tertiary py-1.5 border-r border-border-subtle last:border-r-0 min-w-0">
            {label}
          </div>
        ))}
        <div className="shrink-0 bg-border" style={{ width: 1 }} />
        <div className="shrink-0 text-center text-xs text-text-disabled py-1.5 border-r border-border-subtle"
             style={{ width: 130 }}>
          Chosen Events
        </div>
        <div className="shrink-0 text-center text-xs text-text-disabled py-1.5"
             style={{ width: 88 }}>
          PIP
        </div>
      </div>

      {/* ── Unified scrollable area ─────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden" ref={scrollRef}>
        <div className="flex" style={{ minHeight: `${innerHeight}px`, position: 'relative' }}>

          {/* Time gutter */}
          <TimeGutter totalDuration={totalDuration} innerHeight={innerHeight} compress={compress} />

          {/* Histogram bucket columns */}
          {buckets.map((bucketEvents, idx) => (
            <div
              key={idx}
              className={`flex-1 relative ${idx < BUCKET_COUNT - 1 ? 'border-r border-border-subtle' : ''}`}
              style={{ minHeight: `${innerHeight}px` }}
            >
              {bucketEvents.map(evt => (
                <EventTile
                  key={evt.id}
                  event={evt}
                  totalDuration={totalDuration}
                  isHovered={hoveredId === evt.id}
                  isSelected={selectedEventId === evt.id}
                  onClick={() => handleClick(evt)}
                  onEnter={() => setHoveredId(evt.id)}
                  onLeave={() => setHoveredId(null)}
                  onRightClick={() => toggleOverride(evt.id)}
                />
              ))}
            </div>
          ))}

          {/* Separator between histogram and result */}
          <div className="shrink-0 bg-border" style={{ width: 1 }} />

          {/* Result: Chosen events */}
          <ResultColumn
            events={chosenEvents}
            totalDuration={totalDuration}
            compress={compress}
            compressPositions={compressState?.map}
            hoveredId={hoveredId}
            selectedId={selectedEventId}
            onClick={handleClick}
            onEnter={id => setHoveredId(id)}
            onLeave={() => setHoveredId(null)}
            width={130}
          />

          {/* Result: PIP events */}
          <ResultColumn
            events={pipEvents}
            totalDuration={totalDuration}
            compress={compress}
            compressPositions={compressState?.map}
            hoveredId={hoveredId}
            selectedId={selectedEventId}
            onClick={handleClick}
            onEnter={id => setHoveredId(id)}
            onLeave={() => setHoveredId(null)}
            width={88}
            isPip
          />
        </div>
      </div>

      {/* ── Legend ─────────────────────────────────────────────────────── */}
      <HistogramLegend />
    </div>
  )
}


// ═════════════════════════════════════════════════════════════════════════════
// Sub-components
// ═════════════════════════════════════════════════════════════════════════════

function TimeGutter({ totalDuration, innerHeight, compress }) {
  const markers = useMemo(() => {
    if (compress || totalDuration <= 0) return []
    const interval =
      totalDuration > 7200 ? 600 :
      totalDuration > 3600 ? 300 :
      totalDuration > 600  ? 60  : 30
    const marks = []
    for (let t = 0; t <= totalDuration; t += interval) {
      marks.push({ time: t, pct: (t / totalDuration) * 100 })
    }
    return marks
  }, [totalDuration, compress])

  return (
    <div
      className="shrink-0 relative border-r border-border-subtle bg-bg-primary/50"
      style={{ width: 52, minHeight: `${innerHeight}px` }}
    >
      {markers.map(m => (
        <div key={m.time} className="absolute left-0 right-0" style={{ top: `${m.pct}%` }}>
          <span
            className="block text-center text-text-disabled font-mono leading-none"
            style={{ fontSize: 10 }}
          >
            {formatTime(m.time)}
          </span>
          <div className="absolute right-0 top-2 bg-border-subtle" style={{ width: 8, height: 1 }} />
        </div>
      ))}
    </div>
  )
}


function EventTile({
  event: evt, totalDuration,
  isHovered, isSelected,
  onClick, onEnter, onLeave, onRightClick,
}) {
  const color = EVENT_COLORS[evt.event_type] || '#6b7280'
  const isHighlight = evt.inclusion === 'highlight'
  const isFullVideo = evt.inclusion === 'full-video'
  const top = totalDuration > 0 ? (evt.start_time_seconds / totalDuration) * 100 : 0
  const duration = Math.max(0, (evt.end_time_seconds || 0) - (evt.start_time_seconds || 0))
  const heightPct = totalDuration > 0 ? Math.max(0.4, (duration / totalDuration) * 100) : 0.4
  const opacity = isHighlight ? 1 : isFullVideo ? 0.5 : 0.2

  return (
    <div
      className="absolute left-0.5 right-0.5 rounded cursor-pointer transition-all duration-100 overflow-hidden"
      style={{
        top: `${top}%`,
        height: `${heightPct}%`,
        minHeight: 20,
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


function ResultColumn({
  events, totalDuration, compress, compressPositions,
  hoveredId, selectedId, onClick, onEnter, onLeave,
  width, isPip = false,
}) {
  return (
    <div className="shrink-0 relative" style={{ width }}>
      {events.map(evt => {
        const color = EVENT_COLORS[evt.event_type] || '#6b7280'
        const isSelected = selectedId === evt.id
        const isHovered = hoveredId === evt.id
        const duration = Math.max(0, (evt.end_time_seconds || 0) - (evt.start_time_seconds || 0))

        let topStyle, heightStyle, minH
        if (compress && compressPositions) {
          topStyle = `${compressPositions.get(evt.id) ?? 0}px`
          heightStyle = '34px'
          minH = '34px'
        } else {
          const pct = totalDuration > 0 ? (evt.start_time_seconds / totalDuration) * 100 : 0
          const hPct = totalDuration > 0 ? Math.max(0.4, (duration / totalDuration) * 100) : 0.4
          topStyle = `${pct}%`
          heightStyle = `${hPct}%`
          minH = '20px'
        }

        return (
          <div
            key={evt.id}
            className="absolute left-1 right-1 rounded cursor-pointer overflow-hidden transition-all"
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
            <div className="px-1 py-px truncate" style={{ fontSize: 9, lineHeight: '11px' }}>
              <span className="text-white/90 font-medium">
                {EVENT_TYPE_LABELS[evt.event_type]?.slice(0, 5) || '?'}
              </span>
            </div>
            {compress && (
              <div className="px-1 truncate" style={{ fontSize: 8, lineHeight: '10px', opacity: 0.7 }}>
                <span className="text-white/70">{formatTime(evt.start_time_seconds)}</span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}


function HistogramLegend() {
  return (
    <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border bg-bg-secondary shrink-0 flex-wrap">
      <span className="text-xs text-text-disabled">← Low score</span>
      <span className="text-xs text-text-disabled flex-1 text-center">
        Columns = score buckets (1–10) · Time flows ↓
      </span>
      <span className="text-xs text-text-disabled">High score →</span>

      <div className="w-full flex items-center gap-3 pt-0.5 flex-wrap">
        {Object.entries(EVENT_COLORS).map(([type, color]) => (
          <span key={type} className="flex items-center gap-1 text-text-disabled" style={{ fontSize: 9 }}>
            <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: color }} />
            {EVENT_TYPE_LABELS[type]?.slice(0, 6) || type}
          </span>
        ))}
        <span className="mx-1 text-text-disabled" style={{ fontSize: 9 }}>│</span>
        <span className="flex items-center gap-1 text-text-disabled" style={{ fontSize: 9 }}>
          <span className="inline-block w-2 h-2 rounded-sm bg-accent" /> Selected
        </span>
        <span className="flex items-center gap-1 text-text-disabled" style={{ fontSize: 9 }}>
          <span className="inline-block w-2 h-2 rounded-sm bg-text-disabled opacity-30" /> Excluded
        </span>
      </div>
    </div>
  )
}

