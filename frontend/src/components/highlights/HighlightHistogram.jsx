import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { useHighlight, EVENT_TYPE_LABELS, tierColor } from '../../context/HighlightContext'
import { useTimeline, EVENT_COLORS } from '../../context/TimelineContext'
import { formatTime } from '../../utils/time'
import { Columns3, ArrowRight, Film, Scissors, Layers } from 'lucide-react'

/**
 * HighlightHistogram — Histogram-based event organizer.
 *
 * Layout: Left = score histogram (columns 1–10, time top→bottom),
 *         Right = result timeline (horizontal sequence of selected events).
 *
 * Each event is a tile:
 *   • Column = score bucket (1–10)
 *   • Vertical position = time in race
 *   • Height = duration (with padding)
 *   • Color = event type
 *   • Opacity: full = selected, faded = rejected
 *   • Border = hover or selected
 *
 * The result timeline shows selected events in order with duration, drivers,
 * and segment type (event / PIP / B-roll / transition).
 */

const BUCKET_COUNT = 10
const BUCKET_LABELS = Array.from({ length: BUCKET_COUNT }, (_, i) => i + 1)

/** Map a score (0–10 range) to a bucket index 0–9 */
function scoreToBucket(score) {
  if (score == null || score <= 0) return 0
  // Scores are 0–10; map directly to 10 buckets (0=<1, 1=1-2, ..., 9=9-10)
  const bucket = Math.floor(score)
  return Math.max(0, Math.min(BUCKET_COUNT - 1, bucket))
}

/** Format seconds to M:SS */
function formatDuration(sec) {
  if (!sec || sec <= 0) return '0s'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

export default function HighlightHistogram() {
  const {
    selection, metrics, toggleOverride, jumpToEvent,
    videoScript,
  } = useHighlight()
  const { raceDuration, seekTo, selectedEventId, setSelectedEventId } = useTimeline()
  const [hoveredId, setHoveredId] = useState(null)
  const histogramRef = useRef(null)

  // ── Compute event buckets ──────────────────────────────────────────────
  const { buckets, totalDuration, allEvents } = useMemo(() => {
    const all = [...(selection.scoredEvents || [])]
      .sort((a, b) => a.start_time_seconds - b.start_time_seconds)

    const dur = raceDuration > 0
      ? raceDuration
      : all.length > 0
        ? Math.max(...all.map(e => e.end_time_seconds || 0))
        : 0

    // Distribute events into 10 buckets by score
    const bkts = Array.from({ length: BUCKET_COUNT }, () => [])
    for (const evt of all) {
      const idx = scoreToBucket(evt.score)
      bkts[idx].push(evt)
    }

    return { buckets: bkts, totalDuration: dur, allEvents: all }
  }, [selection.scoredEvents, raceDuration])

  // ── Selected events for result timeline ────────────────────────────────
  const resultSegments = useMemo(() => {
    const highlights = allEvents
      .filter(e => e.inclusion === 'highlight')
      .sort((a, b) => a.start_time_seconds - b.start_time_seconds)

    // Include transitions and B-roll from videoScript
    const extras = (videoScript || [])
      .filter(s => s.type === 'transition' || s.type === 'broll')
      .map(s => ({
        ...s,
        _isScript: true,
        start_time_seconds: s.start_time_seconds ?? 0,
        end_time_seconds: s.end_time_seconds ?? 0,
      }))

    // Merge and sort by time
    const merged = [
      ...highlights.map(e => ({ ...e, _segType: e.segment_type === 'pip' ? 'pip' : 'event' })),
      ...extras.map(e => ({ ...e, _segType: e.type })),
    ].sort((a, b) => a.start_time_seconds - b.start_time_seconds)

    return merged
  }, [allEvents, videoScript])

  // ── Handle tile click → open inspector ─────────────────────────────────
  const handleTileClick = useCallback((evt) => {
    setSelectedEventId(evt.id)
    jumpToEvent(evt)
  }, [setSelectedEventId, jumpToEvent])

  // ── Handle tile hover → highlight everywhere ───────────────────────────
  const handleTileEnter = useCallback((id) => setHoveredId(id), [])
  const handleTileLeave = useCallback(() => setHoveredId(null), [])

  if (totalDuration <= 0 && allEvents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-disabled text-xs gap-2">
        <Columns3 size={16} className="opacity-40" />
        <span>No events to display. Run analysis first.</span>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* ── LEFT: Score Histogram ──────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 border-r border-border">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-bg-secondary shrink-0">
          <div className="flex items-center gap-2">
            <Columns3 size={14} className="text-accent" />
            <span className="text-xxs font-semibold text-text-primary uppercase tracking-wider">
              Score Histogram
            </span>
          </div>
          <span className="text-xxs text-text-disabled">
            {allEvents.length} events · {formatDuration(totalDuration)} race
          </span>
        </div>

        {/* Column headers (score 1–10, low→high left→right) */}
        <div className="flex shrink-0 border-b border-border-subtle bg-bg-secondary">
          {/* Time gutter */}
          <div className="w-10 shrink-0 text-center text-xxs text-text-disabled py-0.5 border-r border-border-subtle">
            Time
          </div>
          {BUCKET_LABELS.map(label => (
            <div
              key={label}
              className="flex-1 text-center text-xxs text-text-tertiary py-0.5 border-r border-border-subtle last:border-r-0"
            >
              {label}
            </div>
          ))}
        </div>

        {/* Histogram grid — scrollable */}
        <div
          ref={histogramRef}
          className="flex-1 flex min-h-0 overflow-y-auto overflow-x-hidden relative"
        >
          {/* Time gutter with lap markers */}
          <TimeGutter totalDuration={totalDuration} />

          {/* Event columns */}
          <div className="flex-1 flex relative">
            {buckets.map((bucketEvents, bucketIdx) => (
              <HistogramColumn
                key={bucketIdx}
                events={bucketEvents}
                totalDuration={totalDuration}
                hoveredId={hoveredId}
                selectedId={selectedEventId}
                onTileClick={handleTileClick}
                onTileEnter={handleTileEnter}
                onTileLeave={handleTileLeave}
                onOverrideToggle={toggleOverride}
                isLast={bucketIdx === BUCKET_COUNT - 1}
              />
            ))}
          </div>
        </div>

        {/* Legend */}
        <HistogramLegend />
      </div>

      {/* ── RIGHT: Result Timeline ────────────────────────────────────── */}
      <div className="w-72 shrink-0 flex flex-col bg-bg-secondary">
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <ArrowRight size={14} className="text-accent" />
            <span className="text-xxs font-semibold text-text-primary uppercase tracking-wider">
              Result Timeline
            </span>
          </div>
          <span className="text-xxs text-text-disabled">
            {metrics.eventCount || 0} clips · {formatDuration(metrics.duration)}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-1">
          {resultSegments.length === 0 ? (
            <div className="flex items-center justify-center h-full text-text-disabled text-xxs">
              No highlights selected
            </div>
          ) : (
            <div className="space-y-0.5">
              {resultSegments.map((seg, i) => (
                <ResultSegment
                  key={seg.id ?? `seg-${i}`}
                  segment={seg}
                  isHovered={hoveredId === seg.id}
                  isSelected={selectedEventId === seg.id}
                  onEnter={() => seg.id && handleTileEnter(seg.id)}
                  onLeave={handleTileLeave}
                  onClick={() => seg.id && handleTileClick(seg)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}


// ═════════════════════════════════════════════════════════════════════════════
// Sub-components
// ═════════════════════════════════════════════════════════════════════════════

/**
 * TimeGutter — Vertical time markers (every 5 minutes).
 */
function TimeGutter({ totalDuration }) {
  const markers = useMemo(() => {
    if (totalDuration <= 0) return []
    const interval = totalDuration > 600 ? 300 : totalDuration > 120 ? 60 : 30 // 5min, 1min, or 30s
    const marks = []
    for (let t = 0; t <= totalDuration; t += interval) {
      marks.push({ time: t, pct: (t / totalDuration) * 100 })
    }
    return marks
  }, [totalDuration])

  return (
    <div className="w-10 shrink-0 relative border-r border-border-subtle bg-bg-primary/50">
      {markers.map(m => (
        <div
          key={m.time}
          className="absolute left-0 right-0 text-center"
          style={{ top: `${m.pct}%` }}
        >
          <span className="text-text-disabled font-mono leading-none" style={{ fontSize: '8px' }}>
            {formatTime(m.time)}
          </span>
          <div className="absolute top-1.5 right-0 w-1.5 h-px bg-border-subtle" />
        </div>
      ))}
    </div>
  )
}


/**
 * HistogramColumn — One score-bucket column containing event tiles.
 */
function HistogramColumn({
  events, totalDuration, hoveredId, selectedId,
  onTileClick, onTileEnter, onTileLeave, onOverrideToggle,
  isLast,
}) {
  return (
    <div
      className={`flex-1 relative ${isLast ? '' : 'border-r border-border-subtle'}`}
      style={{ minHeight: '200px' }}
    >
      {events.map(evt => (
        <EventTile
          key={evt.id}
          event={evt}
          totalDuration={totalDuration}
          isHovered={hoveredId === evt.id}
          isSelected={selectedId === evt.id}
          onClick={() => onTileClick(evt)}
          onEnter={() => onTileEnter(evt.id)}
          onLeave={onTileLeave}
          onOverrideToggle={() => onOverrideToggle(evt.id)}
        />
      ))}
    </div>
  )
}


/**
 * EventTile — Single event block in the histogram.
 *
 * Positioned vertically by time, height by duration.
 * Color = event type, opacity = inclusion state.
 */
function EventTile({
  event: evt, totalDuration,
  isHovered, isSelected,
  onClick, onEnter, onLeave, onOverrideToggle,
}) {
  const color = EVENT_COLORS[evt.event_type] || '#6b7280'
  const isHighlight = evt.inclusion === 'highlight'
  const isFullVideo = evt.inclusion === 'full-video'
  const isExcluded = evt.inclusion === 'excluded'

  const top = totalDuration > 0 ? (evt.start_time_seconds / totalDuration) * 100 : 0
  const duration = Math.max(0, (evt.end_time_seconds || 0) - (evt.start_time_seconds || 0))
  const heightPct = totalDuration > 0 ? Math.max(1.5, (duration / totalDuration) * 100) : 2

  const opacity = isHighlight ? 1 : isFullVideo ? 0.5 : 0.2
  const borderColor = isSelected
    ? 'rgba(255,255,255,0.8)'
    : isHovered
      ? 'rgba(255,255,255,0.5)'
      : 'rgba(255,255,255,0.1)'
  const borderWidth = isSelected || isHovered ? 2 : 1

  return (
    <div
      className="absolute left-0.5 right-0.5 rounded cursor-pointer transition-all duration-100 overflow-hidden group"
      style={{
        top: `${top}%`,
        height: `${heightPct}%`,
        minHeight: '14px',
        backgroundColor: color,
        opacity,
        borderStyle: 'solid',
        borderWidth: `${borderWidth}px`,
        borderColor,
        zIndex: isSelected ? 20 : isHovered ? 10 : 1,
      }}
      onClick={onClick}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onContextMenu={(e) => {
        e.preventDefault()
        onOverrideToggle()
      }}
      title={[
        `${EVENT_TYPE_LABELS[evt.event_type] || evt.event_type}`,
        `Score: ${evt.score} | Tier: ${evt.tier || '?'}`,
        `Time: ${formatTime(evt.start_time_seconds)} — ${formatTime(evt.end_time_seconds)}`,
        `Duration: ${formatDuration(duration)}`,
        evt.reason || '',
        evt.llm_note ? `💬 ${evt.llm_note}` : '',
        evt.narrative_anchor ? '⚓ Narrative Anchor' : '',
        isHighlight ? '✓ Selected' : isFullVideo ? '○ Full-video' : '✗ Excluded',
      ].filter(Boolean).join('\n')}
    >
      {/* Narrative anchor star */}
      {evt.narrative_anchor && (
        <span className="absolute top-0 right-0 text-yellow-300 leading-none z-10" style={{ fontSize: '8px' }}>★</span>
      )}

      {/* PIP indicator */}
      {evt.segment_type === 'pip' && (
        <div
          className="absolute right-0 top-0 bottom-0 w-1/3 opacity-40"
          style={{
            backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255,255,255,0.3) 2px, rgba(255,255,255,0.3) 4px)',
          }}
        />
      )}

      {/* Content label (visible when tile is tall enough) */}
      <div className="px-0.5 py-px truncate" style={{ fontSize: '7px', lineHeight: '9px' }}>
        <span className="text-white/90 font-medium">
          {EVENT_TYPE_LABELS[evt.event_type]?.slice(0, 3) || '?'}
        </span>
      </div>
    </div>
  )
}


/**
 * ResultSegment — One segment in the result timeline.
 */
function ResultSegment({ segment: seg, isHovered, isSelected, onEnter, onLeave, onClick }) {
  const duration = Math.max(0, (seg.end_time_seconds || 0) - (seg.start_time_seconds || 0))
  const isTransition = seg._segType === 'transition'
  const isBroll = seg._segType === 'broll'
  const isPip = seg._segType === 'pip'
  const isEvent = seg._segType === 'event'

  const color = isEvent || isPip
    ? EVENT_COLORS[seg.event_type] || '#6b7280'
    : isBroll
      ? '#71717a'
      : '#a1a1aa'

  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer transition-all
        ${isSelected ? 'ring-2 ring-accent bg-accent/10' : ''}
        ${isHovered && !isSelected ? 'bg-bg-hover' : ''}
        ${!isHovered && !isSelected ? 'hover:bg-bg-hover' : ''}
        ${isTransition ? 'py-0.5' : ''}
      `}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
      title={seg.llm_note ? `💬 ${seg.llm_note}` : undefined}
    >
      {/* Color indicator */}
      <div
        className="w-1.5 shrink-0 rounded-full self-stretch"
        style={{
          backgroundColor: color,
          backgroundImage: isBroll
            ? 'repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255,255,255,0.15) 2px, rgba(255,255,255,0.15) 4px)'
            : undefined,
          minHeight: isTransition ? '4px' : '16px',
        }}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          {/* Type indicator */}
          {isPip && <Layers size={9} className="text-info shrink-0" />}
          {isTransition && <Scissors size={9} className="text-text-disabled shrink-0" />}
          {isBroll && <Film size={9} className="text-text-disabled shrink-0" />}

          {/* Label */}
          <span className="text-xxs text-text-primary font-medium truncate">
            {isEvent || isPip
              ? EVENT_TYPE_LABELS[seg.event_type] || seg.event_type
              : isTransition
                ? (seg.transition_type || 'CUT').toUpperCase()
                : 'B-ROLL'}
          </span>

          {/* Narrative anchor */}
          {seg.narrative_anchor && (
            <span className="text-yellow-400" style={{ fontSize: '9px' }}>★</span>
          )}
        </div>

        {/* Meta line */}
        <div className="flex items-center gap-1.5 text-text-disabled" style={{ fontSize: '8px' }}>
          <span className="font-mono">{formatDuration(duration)}</span>
          {(isEvent || isPip) && seg.tier && (
            <span
              className="px-0.5 rounded text-white font-bold"
              style={{ backgroundColor: tierColor(seg.tier), fontSize: '7px' }}
            >
              {seg.tier}
            </span>
          )}
          {isPip && <span className="text-info">PIP</span>}
        </div>
      </div>

      {/* Score */}
      {(isEvent || isPip) && seg.score != null && (
        <span className="text-xxs font-mono text-text-tertiary shrink-0">
          {seg.score}
        </span>
      )}
    </div>
  )
}


/**
 * HistogramLegend — Visual legend for the histogram.
 */
function HistogramLegend() {
  return (
    <div className="flex items-center gap-3 px-3 py-1 border-t border-border bg-bg-secondary shrink-0 flex-wrap">
      <span className="text-xxs text-text-disabled">← Low score</span>
      <span className="text-xxs text-text-disabled flex-1 text-center">
        Columns = score buckets (1–10) · Time flows ↓
      </span>
      <span className="text-xxs text-text-disabled">High score →</span>

      <div className="w-full flex items-center gap-3 pt-0.5">
        {Object.entries(EVENT_COLORS).map(([type, color]) => (
          <span key={type} className="flex items-center gap-1 text-text-disabled" style={{ fontSize: '8px' }}>
            <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: color }} />
            {EVENT_TYPE_LABELS[type]?.slice(0, 6) || type}
          </span>
        ))}
        <span className="mx-1 text-text-disabled" style={{ fontSize: '8px' }}>│</span>
        <span className="flex items-center gap-1 text-text-disabled" style={{ fontSize: '8px' }}>
          <span className="inline-block w-2 h-2 rounded-sm bg-accent" /> Selected
        </span>
        <span className="flex items-center gap-1 text-text-disabled" style={{ fontSize: '8px' }}>
          <span className="inline-block w-2 h-2 rounded-sm bg-text-disabled opacity-30" /> Excluded
        </span>
      </div>
    </div>
  )
}
