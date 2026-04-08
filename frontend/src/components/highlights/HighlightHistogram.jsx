import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { useHighlight, EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { TIER_COLORS } from '../../utils/highlight-scoring'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { useTimeline, EVENT_COLORS } from '../../context/TimelineContext'
import { useToast } from '../../context/ToastContext'
import { formatTime } from '../../utils/time'
import { Columns3, ArrowRight, Layers, RotateCw, ChevronDown, ChevronRight, Download, FileText, Copy, X } from 'lucide-react'

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

function formatDuration(sec) {
  if (!sec || sec <= 0) return '0s'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
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


// ═════════════════════════════════════════════════════════════════════════════
// Scoring Report Modal
// ═════════════════════════════════════════════════════════════════════════════

function generateReportText(allEvents, chosenEvents, pipEvents, metrics, totalDuration) {
  const lines = []
  const hr = '─'.repeat(60)

  lines.push('SCORING ALGORITHM REPORT')
  lines.push(hr)
  lines.push('')

  // Overview
  lines.push('## Overview')
  lines.push(`Total Events Scored: ${allEvents.length}`)
  lines.push(`Chosen for Highlight: ${chosenEvents.length}`)
  lines.push(`PIP Segments: ${pipEvents.length}`)
  lines.push(`Target Duration: ${formatDuration(metrics.duration || 0)} actual`)
  lines.push(`Race Duration: ${formatDuration(totalDuration)}`)
  lines.push('')

  // Score distribution
  const scores = allEvents.map(e => e.score).filter(s => s > 0)
  if (scores.length > 0) {
    lines.push('## Score Distribution (after normalization to 0–10)')
    lines.push(`  Min: ${Math.min(...scores).toFixed(2)}`)
    lines.push(`  Max: ${Math.max(...scores).toFixed(2)}`)
    lines.push(`  Mean: ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)}`)
    const raw = allEvents.map(e => e.raw_score || e.score).filter(s => s > 0)
    if (raw.length > 0) {
      lines.push(`  Raw score range (pre-normalization): ${Math.min(...raw).toFixed(3)} – ${Math.max(...raw).toFixed(3)}`)
    }
    lines.push('')
  }

  // Tier breakdown
  const tierCounts = { S: 0, A: 0, B: 0, C: 0 }
  for (const e of allEvents) tierCounts[e.tier] = (tierCounts[e.tier] || 0) + 1
  lines.push('## Tier Breakdown (all events)')
  lines.push(`  S (>9):  ${tierCounts.S} events`)
  lines.push(`  A (≥7):  ${tierCounts.A} events`)
  lines.push(`  B (≥5):  ${tierCounts.B} events`)
  lines.push(`  C (<5):  ${tierCounts.C} events`)
  lines.push('')

  // Type breakdown
  const typeCounts = {}
  for (const e of allEvents) {
    const t = e.event_type || 'unknown'
    typeCounts[t] = (typeCounts[t] || 0) + 1
  }
  lines.push('## Event Types')
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    const chosen = chosenEvents.filter(e => e.event_type === type).length
    lines.push(`  ${EVENT_TYPE_LABELS[type] || type}: ${count} total, ${chosen} chosen`)
  }
  lines.push('')

  // Bucket allocation
  lines.push('## Timeline Bucket Allocation')
  const bucketCounts = { intro: [], early: [], mid: [], late: [] }
  for (const e of chosenEvents) {
    const b = e.bucket || 'mid'
    if (!bucketCounts[b]) bucketCounts[b] = []
    bucketCounts[b].push(e)
  }
  for (const [bucket, evts] of Object.entries(bucketCounts)) {
    const dur = evts.reduce((s, e) => s + (e.end_time_seconds - e.start_time_seconds), 0)
    lines.push(`  ${bucket}: ${evts.length} events, ${formatDuration(dur)}`)
  }
  lines.push('')

  // Quality metrics
  lines.push('## Quality Metrics')
  lines.push(`  Balance Score: ${metrics.balance ?? '—'}/100`)
  lines.push(`  Pacing Score: ${metrics.pacing ?? '—'}/100`)
  lines.push(`  Driver Coverage: ${metrics.driverCoverage ?? '—'}% (${metrics.driverCount ?? 0}/${metrics.totalDrivers ?? 0})`)
  lines.push('')

  // Per-event detail (chosen events, sorted by time)
  lines.push(hr)
  lines.push('## CHOSEN EVENT DETAILS')
  lines.push(hr)
  const sortedChosen = [...chosenEvents].sort((a, b) => a.start_time_seconds - b.start_time_seconds)
  for (const evt of sortedChosen) {
    lines.push('')
    lines.push(`[${evt.tier}] ${EVENT_TYPE_LABELS[evt.event_type] || evt.event_type} — Score: ${evt.score}`)
    lines.push(`  Time: ${formatTime(evt.start_time_seconds)} – ${formatTime(evt.end_time_seconds)} (${formatDuration(evt.end_time_seconds - evt.start_time_seconds)})`)
    lines.push(`  Bucket: ${evt.bucket} | Severity: ${evt.severity ?? '—'}`)
    if (evt.reason) lines.push(`  Reason: ${evt.reason}`)
    if (evt.score_components) {
      const c = evt.score_components
      const parts = []
      if (c.base != null) parts.push(`base=${c.base}`)
      if (c.position != null && c.position !== 1) parts.push(`pos×${c.position}`)
      if (c.position_change != null && c.position_change !== 1) parts.push(`posΔ×${c.position_change.toFixed(1)}`)
      if (c.consequence != null && c.consequence > 0) parts.push(`cons=${c.consequence}`)
      if (c.narrative_bonus != null && c.narrative_bonus > 0) parts.push(`narr=${c.narrative_bonus}`)
      if (c.user_weight != null && c.user_weight !== 1) parts.push(`wt×${c.user_weight}`)
      if (c.normalization) {
        parts.push(`raw=${c.normalization.raw.toFixed(3)}`)
      }
      lines.push(`  Pipeline: ${parts.join(' → ')}`)
    }
    if (evt.driver_names?.length) {
      lines.push(`  Drivers: ${evt.driver_names.join(', ')}`)
    }
  }
  lines.push('')

  // Excluded events summary
  const excluded = allEvents.filter(e => e.inclusion === 'excluded')
  if (excluded.length > 0) {
    lines.push(hr)
    lines.push(`## EXCLUDED EVENTS (${excluded.length})`)
    lines.push(hr)
    for (const evt of excluded.sort((a, b) => b.score - a.score).slice(0, 20)) {
      lines.push(`  [${evt.tier}] ${EVENT_TYPE_LABELS[evt.event_type] || evt.event_type} score=${evt.score} — ${evt.reason || 'Not selected'}`)
    }
    if (excluded.length > 20) lines.push(`  ... and ${excluded.length - 20} more`)
  }

  return lines.join('\n')
}

function ScoringReportModal({ allEvents, chosenEvents, pipEvents, metrics, totalDuration, onClose }) {
  const reportText = useMemo(() =>
    generateReportText(allEvents, chosenEvents, pipEvents, metrics, totalDuration),
    [allEvents, chosenEvents, pipEvents, metrics, totalDuration]
  )

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(reportText)
  }, [reportText])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-bg-tertiary border border-border rounded-2xl shadow-float w-full max-w-3xl mx-4 flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h3 className="text-lg font-semibold text-text-primary">Scoring Algorithm Report</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border-subtle
                         text-text-secondary hover:text-text-primary hover:border-border rounded transition-colors"
            >
              <Copy size={12} />
              Copy
            </button>
            <button onClick={onClose} className="p-2 rounded-xl hover:bg-surface-hover transition-colors">
              <X className="w-5 h-5 text-text-tertiary" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-6">
          <pre className="text-xs text-text-secondary font-mono whitespace-pre-wrap leading-relaxed">
            {reportText}
          </pre>
        </div>
      </div>
    </div>
  )
}


// ═════════════════════════════════════════════════════════════════════════════
// Sub-components
// ═════════════════════════════════════════════════════════════════════════════

function TimeGutter({ totalDuration, contentHeight, compress, onClick }) {
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
      className="shrink-0 relative border-r border-border-subtle bg-bg-primary/50 cursor-pointer"
      style={{ width: 52 }}
      onClick={onClick}
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


/** Horizontal time ruler — time markers placed left→right at percentage positions. */
function TimeGutterH({ totalDuration, onClick }) {
  const markers = useMemo(() => {
    if (totalDuration <= 0) return []
    const interval =
      totalDuration > 7200 ? 600 :
      totalDuration > 3600 ? 300 :
      totalDuration > 600  ? 60  : 30
    const marks = []
    for (let t = 0; t <= totalDuration; t += interval) {
      marks.push({ time: t, pct: (t / totalDuration) * 100 })
    }
    return marks
  }, [totalDuration])

  return (
    <div
      className="relative border-b border-border-subtle bg-bg-primary/50 cursor-pointer shrink-0 select-none"
      style={{ height: 24 }}
      onClick={onClick}
    >
      {markers.map(m => (
        <div key={m.time}
             className="absolute top-0 bottom-0 flex items-end justify-center pb-0.5"
             style={{ left: `${m.pct}%`, transform: 'translateX(-50%)' }}>
          <span className="text-text-disabled font-mono leading-none" style={{ fontSize: 9 }}>
            {formatTime(m.time)}
          </span>
        </div>
      ))}
    </div>
  )
}


function EventTile({
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


function ResultColumn({
  events, totalDuration, timeOffset = 0, compress, compressPositions,
  hoveredId, selectedId, onClick, onEnter, onLeave,
  width, flex = false, isPip = false,
}) {
  return (
    <div className={`relative ${flex && !width ? 'flex-1 min-w-0' : 'shrink-0'}`} style={width ? { width } : undefined}>
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
          const adjustedStart = evt.start_time_seconds - timeOffset
          const pct = totalDuration > 0 ? (adjustedStart / totalDuration) * 100 : 0
          const hPct = totalDuration > 0 ? Math.max(0.4, (duration / totalDuration) * 100) : 0.4
          topStyle = `${pct}%`
          heightStyle = `${hPct}%`
          minH = '20px'
        }

        return (
          <div
            key={evt.id}
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
        )
      })}
    </div>
  )
}


/**
 * RangeSlider — Dual-handle range slider controlling the visible viewport.
 * Full range = no scrolling (everything on one page).
 * Narrower range = zoomed in, histogram scrolls to show the selected window.
 * The center region is draggable to pan without changing zoom level.
 */
function RangeSlider({ rangeStart, rangeEnd, onChange, totalDuration, events }) {
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
