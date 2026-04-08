import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { useHighlight, EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { useTimeline, EVENT_COLORS } from '../../context/TimelineContext'
import { useToast } from '../../context/ToastContext'
import { formatTime, formatDuration } from '../../utils/time'
import { Columns3, ArrowRight, RotateCw, ChevronDown, ChevronRight, Download, FileText } from 'lucide-react'
import ScoringReportModal from './ScoringReportModal'
import EventTile from './EventTile'
import ResultColumn from './ResultColumn'
import RangeSlider from '../ui/RangeSlider'
import { TimeGutter, TimeGutterH } from './TimeGutter'

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
const MIN_HEIGHT_PX = 900  // fallback height before container is measured
const BUCKET_COL_WIDTH = 44 // column width in vertical mode
const BUCKET_ROW_H = 32     // row height in horizontal mode
const CHOSEN_ROW_H = 56     // result row height in horizontal mode

/** Map a score (0–10) to bucket index 0–9 */
function scoreToBucket(score) {
  if (score == null || score <= 0) return 0
  return Math.max(0, Math.min(BUCKET_COUNT - 1, Math.floor(score)))
}

// ─────────────────────────────────────────────────────────────────────────────

export default function HighlightHistogram({ onInspect, projectId }) {
  const { selection, metrics, toggleOverride, jumpToEvent, applyHighlights, generateVideoScript } = useHighlight()
  const { raceDuration, selectedEventId, setSelectedEventId, playheadTime, seekTo } = useTimeline()
  const { addToast } = useToast()
  const [hoveredId, setHoveredId] = useState(null)
  const [compress, setCompress] = useState(false)
  const [horizontal, setHorizontal] = useState(false)
  const [histogramCollapsed, setHistogramCollapsed] = useState(false)
  const [showReport, setShowReport] = useState(false)
  const [activeTypes, setActiveTypes] = useState(null)  // null = all types visible
  const scrollRef = useRef(null)

  const handleApply = useCallback(async () => {
    if (!projectId) return
    try {
      await applyHighlights(projectId)
      await generateVideoScript(projectId)
      addToast('success', 'Highlights applied to timeline')
    } catch {
      addToast('error', 'Failed to apply highlights')
    }
  }, [projectId, applyHighlights, generateVideoScript, addToast])

  // Resizable split between histogram and chosen events
  const [chosenWidth, setChosenWidth] = useLocalStorage('lrs:editing:chosenWidth', 200)
  const chosenWidthRef = useRef(chosenWidth)
  useEffect(() => { chosenWidthRef.current = chosenWidth }, [chosenWidth])
  const startChosenResize = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = chosenWidthRef.current
    const onMove = (mv) => {
      const w = Math.max(120, Math.min(400, startW - (mv.clientX - startX)))
      setChosenWidth(w)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [setChosenWidth])

  // Range slider / viewport zoom state
  const [rangeStart, setRangeStart] = useState(0)
  const [rangeEnd, setRangeEnd] = useState(1)
  const [containerH, setContainerH] = useState(0)
  const [containerW, setContainerW] = useState(0)
  const syncingRef = useRef(false)

  // Observe both scroll viewport dimensions (re-run when mode changes)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => { setContainerH(el.clientHeight); setContainerW(el.clientWidth) }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [horizontal, histogramCollapsed])

  const containerSize = horizontal ? containerW : containerH

  // ── Derive data ───────────────────────────────────────────────────────────
  // ── Type legend state ──────────────────────────────────────────────────
  // typeSet: all event types present in current scored data
  const typeSet = useMemo(() => {
    const types = new Set()
    for (const e of selection.scoredEvents || []) if (e.event_type) types.add(e.event_type)
    return types
  }, [selection.scoredEvents])

  const handleLegendClick = useCallback((type) => {
    setActiveTypes(prev => {
      if (prev === null) {
        // All showing — solo just this type
        return new Set([type])
      }
      const next = new Set(prev)
      if (next.has(type)) {
        next.delete(type)
        if (next.size === 0) return null  // all deselected → show all again
        return next
      } else {
        next.add(type)
        if (next.size >= typeSet.size) return null  // all selected → show all
        return next
      }
    })
  }, [typeSet])

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

  // ── Filtered buckets for histogram display (legend filter, display-only) ──
  const filteredBuckets = useMemo(() => {
    if (!activeTypes) return buckets
    return buckets.map(b => b.filter(e => activeTypes.has(e.event_type)))
  }, [buckets, activeTypes])

  const rangeWidth = rangeEnd - rangeStart

  // Compressed sequential positions for result columns (must compute before contentSize)
  const compressState = useMemo(() => {
    if (!compress) return null
    const combined = [...chosenEvents, ...pipEvents]
      .sort((a, b) => a.start_time_seconds - b.start_time_seconds)
    if (horizontal) {
      // Horizontal: sequential stacking left→right
      const ITEM_W = 80
      const GAP = 4
      const map = new Map()
      let left = 0
      for (const evt of combined) {
        map.set(evt.id, left)
        left += ITEM_W + GAP
      }
      return { map, totalWidth: left + 20, horizontal: true }
    } else {
      // Vertical: sequential stacking top→bottom
      const ITEM_H = 38
      const GAP = 4
      const map = new Map()
      let top = 0
      for (const evt of combined) {
        map.set(evt.id, top)
        top += ITEM_H + GAP
      }
      return { map, totalHeight: top + 20, horizontal: false }
    }
  }, [compress, chosenEvents, pipEvents, horizontal])

  // contentSize = containerSize / rangeWidth: full range = one page, narrower = scrollable.
  // IMPORTANT: must be exactly containerSize / rangeWidth (not clamped by MIN_HEIGHT_PX) so
  // the scroll-sync math stays correct: scrollTop = rangeStart * contentSize puts rangeStart
  // at the top of the viewport and rangeEnd at the bottom.  MIN_HEIGHT_PX is only a fallback
  // for when the container has not yet been measured (containerSize === 0).
  const contentSize = useMemo(() => {
    if (!horizontal && compress && compressState) return compressState.totalHeight
    if (horizontal && compress && compressState) return compressState.totalWidth || MIN_HEIGHT_PX
    if (containerSize <= 0) return MIN_HEIGHT_PX
    return containerSize / Math.max(0.001, rangeWidth)
  }, [containerSize, rangeWidth, horizontal, compress, compressState])

  // Sync: range slider → scroll position (axis-aware)
  useEffect(() => {
    if (compress) return // compressed mode manages its own layout
    const el = scrollRef.current
    if (!el || containerSize <= 0) return
    const target = Math.round(rangeStart * contentSize)
    const current = horizontal ? el.scrollLeft : el.scrollTop
    if (Math.abs(current - target) < 1) return
    syncingRef.current = true
    if (horizontal) el.scrollLeft = target
    else el.scrollTop = target
  }, [rangeStart, contentSize, containerSize, compress, horizontal])

  // Sync: scroll → range (keep zoom constant, pan only)
  const handleScroll = useCallback(() => {
    if (compress) return
    if (syncingRef.current) { syncingRef.current = false; return }
    const el = scrollRef.current
    if (!el || containerSize <= 0 || contentSize <= containerSize + 1) return
    const rw = rangeEnd - rangeStart
    const scrollPos = horizontal ? el.scrollLeft : el.scrollTop
    const newStart = Math.max(0, Math.min(1 - rw, scrollPos / contentSize))
    setRangeStart(newStart)
    setRangeEnd(newStart + rw)
  }, [compress, containerSize, contentSize, rangeStart, rangeEnd, horizontal])

  const setRange = useCallback((s, e) => {
    setRangeStart(s)
    setRangeEnd(e)
  }, [])

  const handleClick = useCallback((evt) => {
    setSelectedEventId(evt.id)
    jumpToEvent(evt)
    seekTo(evt.start_time_seconds)
    onInspect?.()
  }, [setSelectedEventId, jumpToEvent, seekTo, onInspect])

  // Click on time gutter — absolute position within content → time
  const handleGutterClick = useCallback((e) => {
    if (!scrollRef.current || totalDuration <= 0) return
    const rect = scrollRef.current.getBoundingClientRect()
    const pos = horizontal
      ? e.clientX - rect.left + scrollRef.current.scrollLeft
      : e.clientY - rect.top + scrollRef.current.scrollTop
    const time = Math.max(0, Math.min(totalDuration, (pos / contentSize) * totalDuration))
    seekTo(time)
  }, [horizontal, totalDuration, contentSize, seekTo])

  // Playhead: 0-100% along the time axis
  const playheadPct = useMemo(() => {
    if (totalDuration <= 0 || compress) return null
    return (playheadTime / totalDuration) * 100
  }, [playheadTime, totalDuration, compress])

  if (totalDuration <= 0 && allEvents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-disabled text-xs gap-2">
        <Columns3 size={16} className="opacity-40" />
        <span>No events to display. Run analysis first.</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">

      {/* ── Header bar ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-secondary shrink-0">
        <button onClick={() => setHistogramCollapsed(v => !v)} className="shrink-0">
          {histogramCollapsed ? <ChevronRight className="w-3 h-3 text-text-tertiary" /> : <ChevronDown className="w-3 h-3 text-text-tertiary" />}
        </button>
        <Columns3 size={13} className="text-accent shrink-0" />
        <span className="text-xs font-semibold text-text-primary uppercase tracking-wider whitespace-nowrap">
          Score Histogram
        </span>
        {!histogramCollapsed && (
          <>
        <span className="text-xs text-text-disabled">
          {allEvents.length} events · {formatDuration(totalDuration)}
        </span>
        <div className="flex-1" />
        {/* Horizontal / Vertical toggle */}
        <button
          onClick={() => setHorizontal(v => !v)}
          className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border transition-colors
            ${horizontal
              ? 'bg-accent/15 text-accent border-accent/30'
              : 'text-text-tertiary border-border-subtle hover:text-text-secondary hover:border-border'}`}
        >
          <RotateCw size={11} />
          {horizontal ? 'Horizontal' : 'Vertical'}
        </button>
        <button
          onClick={() => setCompress(v => !v)}
          className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border transition-colors
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
        <div className="w-px h-4 bg-border-subtle mx-1" />
        <button
          onClick={() => setShowReport(true)}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border transition-colors
            text-text-tertiary border-border-subtle hover:text-text-secondary hover:border-border"
        >
          <FileText size={11} />
          View Report
        </button>
        <button
          onClick={handleApply}
          className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium
                     bg-accent hover:bg-accent-hover text-white rounded transition-colors"
        >
          <Download className="w-3.5 h-3.5" />
          Apply to Timeline
        </button>
          </>
        )}
        {histogramCollapsed && <div className="flex-1" />}
      </div>

      {!histogramCollapsed && (
      <>

      {/* ── Type legend ────────────────────────────────────────────────── */}
      {typeSet.size > 0 && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border-subtle bg-bg-secondary shrink-0 flex-wrap">
          {activeTypes !== null && (
            <button
              onClick={() => setActiveTypes(null)}
              className="flex items-center gap-1 px-1.5 py-0.5 text-xxs font-medium rounded border border-accent/40 text-accent bg-accent/10 hover:bg-accent/20 transition-colors whitespace-nowrap"
            >
              Show All
            </button>
          )}
          {[...typeSet].sort().map(type => {
            const color   = EVENT_COLORS[type] || '#6b7280'
            const label   = EVENT_TYPE_LABELS[type] || type
            const isOn    = activeTypes === null || activeTypes.has(type)
            return (
              <button
                key={type}
                onClick={() => handleLegendClick(type)}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xxs font-medium border transition-all whitespace-nowrap"
                style={{
                  backgroundColor: isOn ? `${color}22` : 'transparent',
                  borderColor:     isOn ? `${color}55` : 'rgba(100,116,139,0.25)',
                  color:           isOn ? color       : 'rgba(100,116,139,0.5)',
                  opacity:         isOn ? 1           : 0.55,
                }}
                title={activeTypes === null ? `Show only ${label}` : `Toggle ${label}`}
              >
                <span
                  className="inline-block shrink-0"
                  style={{ width: 6, height: 6, borderRadius: 1, backgroundColor: color, opacity: isOn ? 1 : 0.45 }}
                />
                {label}
              </button>
            )
          })}
        </div>
      )}

      {/* ── Column headers — vertical mode only ───────────────────────── */}
      {!horizontal && (
        <div className="flex shrink-0 border-b border-border-subtle bg-bg-secondary select-none">
          <div className="shrink-0 border-r border-border-subtle text-center text-xs text-text-disabled py-1.5"
               style={{ width: 52 }}>
            Time
          </div>
          {BUCKET_LABELS.map(label => (
            <div key={label}
                 className="text-center text-xs font-semibold text-text-tertiary py-1.5 border-r border-border-subtle last:border-r-0 min-w-0"
                 style={{ width: BUCKET_COL_WIDTH }}>
              {label}
            </div>
          ))}
          <div className="shrink-0 bg-border" style={{ width: 1 }} />
          {compress && (
            <div className="shrink-0 text-center text-xs text-text-disabled py-1.5 border-r border-border-subtle"
                 style={{ width: 48 }}>
              Time
            </div>
          )}
          <div className="flex-1 text-center text-xs text-text-disabled py-1.5 border-r border-border-subtle min-w-0">
            Chosen Events
          </div>
          <div className="shrink-0 text-center text-xs text-text-disabled py-1.5"
               style={{ width: 72 }}>
            PIP
          </div>
        </div>
      )}

      {/* ── Body: horizontal or vertical ───────────────────────────────── */}
      {horizontal ? (

        /* HORIZONTAL: time flows left→right, score buckets are rows */
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Fixed left label column — score row labels */}
          <div className="shrink-0 flex flex-col border-r border-border bg-bg-secondary select-none z-10">
            <div className="border-b border-border-subtle text-xs text-text-disabled flex items-center justify-center"
                 style={{ height: 24, width: 40 }}>⏱</div>
            {BUCKET_LABELS.map(n => (
              <div key={n}
                   className="border-b border-border-subtle text-xs font-semibold text-text-tertiary flex items-center justify-center"
                   style={{ height: BUCKET_ROW_H, width: 40 }}>
                {n}
              </div>
            ))}
            <div className="border-t border-border text-xs text-text-disabled flex items-center justify-center"
                 style={{ width: 40, height: CHOSEN_ROW_H }}>✓</div>
          </div>

          {/* Scrollable horizontal time axis */}
          <div className="flex-1 overflow-x-auto overflow-y-hidden" ref={scrollRef} onScroll={handleScroll}>
            <div className="flex flex-col relative" style={{ width: `${contentSize}px`, minWidth: '100%' }}>
              <TimeGutterH totalDuration={totalDuration} onClick={handleGutterClick} />

              {filteredBuckets.map((bucketEvents, idx) => (
                <div key={idx}
                     className={`relative${idx < BUCKET_COUNT - 1 ? ' border-b border-border-subtle' : ''}`}
                     style={{ height: BUCKET_ROW_H }}>
                  {bucketEvents.map(evt => (
                    <EventTile
                      key={evt.id} event={evt} totalDuration={totalDuration}
                      isHovered={hoveredId === evt.id} isSelected={selectedEventId === evt.id}
                      onClick={() => handleClick(evt)} onEnter={() => setHoveredId(evt.id)}
                      onLeave={() => setHoveredId(null)} onRightClick={() => toggleOverride(evt.id)}
                      horizontal
                    />
                  ))}
                </div>
              ))}

              <div className="relative border-t border-border" style={{ height: CHOSEN_ROW_H, ...(compress && compressState ? { width: compressState.totalWidth } : {}) }}>
                {[...chosenEvents, ...pipEvents].map(evt => {
                  if (compress && compressState) {
                    const left = compressState.map.get(evt.id) ?? 0
                    const color = EVENT_COLORS[evt.event_type] || '#6b7280'
                    const isSelected = selectedEventId === evt.id
                    const isHovered = hoveredId === evt.id
                    return (
                      <div
                        key={evt.id}
                        className="absolute cursor-pointer transition-all duration-100 overflow-hidden"
                        style={{
                          left, width: 80, top: 1, bottom: 1,
                          backgroundColor: color, opacity: 0.88,
                          borderWidth: isSelected || isHovered ? 2 : 1,
                          borderStyle: 'solid',
                          borderColor: isSelected ? 'rgba(255,255,255,0.8)' : isHovered ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.1)',
                          zIndex: isSelected ? 20 : isHovered ? 10 : 1,
                        }}
                        onClick={() => handleClick(evt)}
                        onMouseEnter={() => setHoveredId(evt.id)}
                        onMouseLeave={() => setHoveredId(null)}
                        onContextMenu={e => { e.preventDefault(); toggleOverride(evt.id) }}
                        title={`${EVENT_TYPE_LABELS[evt.event_type]} · ${formatTime(evt.start_time_seconds)}`}
                      >
                        <div className="px-0.5 py-px truncate" style={{ fontSize: 9, lineHeight: '11px' }}>
                          <span className="text-white/90 font-medium">{EVENT_TYPE_LABELS[evt.event_type]?.slice(0, 6) || '?'}</span>
                        </div>
                        <div className="px-0.5 truncate" style={{ fontSize: 8, lineHeight: '10px' }}>
                          <span className="text-white/60">{formatTime(evt.start_time_seconds)}</span>
                        </div>
                      </div>
                    )
                  }
                  return (
                    <EventTile
                      key={evt.id} event={evt} totalDuration={totalDuration}
                      isHovered={hoveredId === evt.id} isSelected={selectedEventId === evt.id}
                      onClick={() => handleClick(evt)} onEnter={() => setHoveredId(evt.id)}
                      onLeave={() => setHoveredId(null)} onRightClick={() => toggleOverride(evt.id)}
                      horizontal
                    />
                  )
                })}
              </div>

              {/* Playhead — vertical line */}
              {playheadPct != null && (
                <div className="absolute top-0 bottom-0 pointer-events-none z-30"
                     style={{ left: `${playheadPct}%` }}>
                  <div className="w-px h-full bg-red-500" />
                  <div className="absolute top-0 left-0 -mt-1 -ml-1 w-2 h-2 bg-red-500 rounded-full" />
                </div>
              )}
            </div>
          </div>
        </div>

      ) : (

        /* VERTICAL: time flows top→bottom, score buckets are columns */
        <div className="flex-1 overflow-y-auto overflow-x-hidden" ref={scrollRef} onScroll={handleScroll}>
          <div className="flex" style={{ height: `${contentSize}px`, position: 'relative' }}>
            <TimeGutter
              totalDuration={totalDuration}
              contentHeight={contentSize}
              compress={compress}
              onClick={handleGutterClick}
            />

            {filteredBuckets.map((bucketEvents, idx) => (
              <div
                key={idx}
                className={`relative ${idx < BUCKET_COUNT - 1 ? 'border-r border-border-subtle' : ''}`}
                style={{ width: BUCKET_COL_WIDTH }}
              >
                {bucketEvents.map(evt => (
                  <EventTile
                    key={evt.id} event={evt} totalDuration={totalDuration}
                    isHovered={hoveredId === evt.id} isSelected={selectedEventId === evt.id}
                    onClick={() => handleClick(evt)} onEnter={() => setHoveredId(evt.id)}
                    onLeave={() => setHoveredId(null)} onRightClick={() => toggleOverride(evt.id)}
                  />
                ))}
              </div>
            ))}

            {/* Playhead — horizontal line */}
            {playheadPct != null && (
              <div className="absolute left-0 right-0 pointer-events-none z-30"
                   style={{ top: `${playheadPct}%` }}>
                <div className="h-px bg-red-500 w-full" />
                <div className="absolute left-0 -top-1 w-2 h-2 bg-red-500 rounded-full" />
              </div>
            )}

            {compress && (
              <div className="shrink-0 relative border-r border-border-subtle bg-bg-primary/30"
                   style={{ width: 48 }}>
                {chosenEvents.concat(pipEvents)
                  .sort((a, b) => a.start_time_seconds - b.start_time_seconds)
                  .map((evt) => {
                    const top = compressState?.map?.get(evt.id) ?? 0
                    return (
                      <div key={evt.id} className="absolute left-0 right-0 text-center font-mono text-text-disabled"
                           style={{ top, fontSize: 9, lineHeight: '34px' }}>
                        {formatTime(evt.start_time_seconds)}
                      </div>
                    )
                  })}
              </div>
            )}

            <ResultColumn
              events={chosenEvents} totalDuration={totalDuration}
              compress={compress} compressPositions={compressState?.map}
              hoveredId={hoveredId} selectedId={selectedEventId}
              onClick={handleClick} onEnter={id => setHoveredId(id)}
              onLeave={() => setHoveredId(null)} flex
            />

            <ResultColumn
              events={pipEvents} totalDuration={totalDuration}
              compress={compress} compressPositions={compressState?.map}
              hoveredId={hoveredId} selectedId={selectedEventId}
              onClick={handleClick} onEnter={id => setHoveredId(id)}
              onLeave={() => setHoveredId(null)} width={72} isPip
            />
          </div>
        </div>
      )}

      {/* ── Range slider (viewport zoom) ─────────────────────────────── */}
      <RangeSlider
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        onChange={setRange}
        totalDuration={totalDuration}
        events={allEvents}
      />
      </>
      )}

      {/* ── Scoring Report Modal ─────────────────────────────────────── */}
      {showReport && (
        <ScoringReportModal
          allEvents={allEvents}
          chosenEvents={chosenEvents}
          pipEvents={pipEvents}
          metrics={metrics}
          totalDuration={totalDuration}
          onClose={() => setShowReport(false)}
        />
      )}
    </div>
  )
}
