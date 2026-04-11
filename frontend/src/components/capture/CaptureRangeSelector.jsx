/**
 * CaptureRangeSelector — Adjustable start/end markers for partial capture.
 *
 * Shows a miniature timeline with draggable range handles.
 * Also provides capture mode selector (all / uncaptured / range / specific).
 */

import { useState, useCallback, useRef, useMemo } from 'react'
import { useScriptState, CAPTURE_MODES } from '../../context/ScriptStateContext'
import { Maximize2, Crosshair, Filter, Clock, ChevronDown, ChevronUp } from 'lucide-react'

const MODE_LABELS = {
  [CAPTURE_MODES.ALL]:              { label: 'Capture All',       icon: Maximize2,  desc: 'Capture all script segments' },
  [CAPTURE_MODES.UNCAPTURED_ONLY]:  { label: 'Uncaptured Only',   icon: Filter,     desc: 'Only capture segments not yet recorded' },
  [CAPTURE_MODES.SPECIFIC]:         { label: 'Specific Segments', icon: Crosshair,  desc: 'Select individual segments to capture' },
  [CAPTURE_MODES.TIME_RANGE]:       { label: 'Time Range',        icon: Clock,      desc: 'Capture segments within a time window' },
}

function formatTime(s) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

/**
 * Miniature timeline with draggable range handles.
 */
function RangeTimeline({ totalDuration, rangeStart, rangeEnd, segments, onRangeChange }) {
  const trackRef = useRef(null)

  const handleMouseDown = useCallback((handle) => (e) => {
    e.preventDefault()
    const track = trackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()

    const onMove = (ev) => {
      const x = Math.max(0, Math.min(ev.clientX - rect.left, rect.width))
      const t = (x / rect.width) * totalDuration
      if (handle === 'start') {
        onRangeChange(Math.min(t, rangeEnd - 1), rangeEnd)
      } else {
        onRangeChange(rangeStart, Math.max(t, rangeStart + 1))
      }
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [totalDuration, rangeStart, rangeEnd, onRangeChange])

  const startPct = totalDuration > 0 ? (rangeStart / totalDuration) * 100 : 0
  const endPct = totalDuration > 0 ? (rangeEnd / totalDuration) * 100 : 100

  return (
    <div className="space-y-1">
      {/* Timeline track */}
      <div ref={trackRef} className="relative h-8 bg-zinc-800 rounded cursor-crosshair select-none">
        {/* Segment blocks */}
        {segments.map((seg) => {
          const left = totalDuration > 0 ? (seg.start / totalDuration) * 100 : 0
          const width = totalDuration > 0 ? ((seg.end - seg.start) / totalDuration) * 100 : 0
          const sectionColor = {
            intro: 'bg-purple-500/40',
            qualifying_results: 'bg-cyan-500/40',
            race: 'bg-green-500/40',
            race_results: 'bg-amber-500/40',
          }[seg.section] || 'bg-zinc-600/40'
          return (
            <div
              key={seg.id}
              className={`absolute top-1 bottom-1 rounded-sm ${sectionColor}`}
              style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
              title={`${seg.id} (${seg.section})`}
            />
          )
        })}

        {/* Selected range overlay */}
        <div
          className="absolute top-0 bottom-0 bg-blue-500/20 border-x border-blue-400/50"
          style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
        />

        {/* Handles */}
        <div
          className="absolute top-0 bottom-0 w-2 bg-blue-400 cursor-ew-resize rounded-l hover:bg-blue-300 transition-colors"
          style={{ left: `${startPct}%` }}
          onMouseDown={handleMouseDown('start')}
          title={`Start: ${formatTime(rangeStart)}`}
        />
        <div
          className="absolute top-0 bottom-0 w-2 bg-blue-400 cursor-ew-resize rounded-r hover:bg-blue-300 transition-colors"
          style={{ left: `calc(${endPct}% - 8px)` }}
          onMouseDown={handleMouseDown('end')}
          title={`End: ${formatTime(rangeEnd)}`}
        />
      </div>

      {/* Time labels */}
      <div className="flex justify-between text-xs text-zinc-500">
        <span>{formatTime(rangeStart)}</span>
        <span className="text-blue-400">{formatTime(rangeEnd - rangeStart)} selected</span>
        <span>{formatTime(rangeEnd)}</span>
      </div>
    </div>
  )
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function CaptureRangeSelector({
  projectId,
  script = [],
  totalDuration = 0,
  onModeChange,
  onRangeChange,
  selectedSegmentIds,
  onSegmentIdsChange,
}) {
  const { captureRange, setCaptureRange: setCaptureRangeApi } = useScriptState()
  const [mode, setMode] = useState(CAPTURE_MODES.ALL)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [localStart, setLocalStart] = useState(captureRange?.start ?? 0)
  const [localEnd, setLocalEnd] = useState(captureRange?.end ?? totalDuration)

  // Segment list for the timeline
  const segmentList = useMemo(() =>
    script
      .filter(s => s.type !== 'transition')
      .map(s => ({
        id: s.id || s.segment_id || '',
        section: s.section || 'race',
        start: s.start_time_seconds || 0,
        end: s.end_time_seconds || 0,
      })),
    [script]
  )

  const handleModeChange = useCallback((newMode) => {
    setMode(newMode)
    onModeChange?.(newMode)
  }, [onModeChange])

  const handleRangeChange = useCallback((start, end) => {
    setLocalStart(start)
    setLocalEnd(end)
    onRangeChange?.({ start, end })
  }, [onRangeChange])

  const handleApplyRange = useCallback(async () => {
    if (mode === CAPTURE_MODES.TIME_RANGE || captureRange) {
      await setCaptureRangeApi(projectId, localStart, localEnd)
    }
  }, [mode, captureRange, setCaptureRangeApi, projectId, localStart, localEnd])

  const handleClearRange = useCallback(async () => {
    await setCaptureRangeApi(projectId, null, null)
    setLocalStart(0)
    setLocalEnd(totalDuration)
  }, [setCaptureRangeApi, projectId, totalDuration])

  return (
    <div className="space-y-3">
      {/* Mode selector */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500 font-medium">Capture Mode:</span>
        <div className="flex gap-1">
          {Object.entries(MODE_LABELS).map(([key, { label, icon: Icon }]) => (
            <button
              key={key}
              onClick={() => handleModeChange(key)}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors
                ${mode === key
                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : 'bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-600'
                }`}
            >
              <Icon size={12} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Mode description */}
      <p className="text-xs text-zinc-500">{MODE_LABELS[mode]?.desc}</p>

      {/* Time range controls */}
      {mode === CAPTURE_MODES.TIME_RANGE && (
        <div className="space-y-2">
          <RangeTimeline
            totalDuration={totalDuration}
            rangeStart={localStart}
            rangeEnd={localEnd}
            segments={segmentList}
            onRangeChange={handleRangeChange}
          />
          <div className="flex gap-2">
            <button
              onClick={handleApplyRange}
              className="px-3 py-1 text-xs rounded bg-blue-500/20 text-blue-400 
                         hover:bg-blue-500/30 transition-colors"
            >
              Apply Range
            </button>
            <button
              onClick={handleClearRange}
              className="px-3 py-1 text-xs rounded bg-zinc-700 text-zinc-300 
                         hover:bg-zinc-600 transition-colors"
            >
              Clear Range
            </button>
          </div>
        </div>
      )}

      {/* Specific segments selector */}
      {mode === CAPTURE_MODES.SPECIFIC && (
        <div className="space-y-1 max-h-32 overflow-y-auto">
          {segmentList.map(seg => {
            const selected = selectedSegmentIds?.includes(seg.id)
            return (
              <label
                key={seg.id}
                className={`flex items-center gap-2 text-xs px-2 py-1 rounded cursor-pointer
                  ${selected ? 'bg-blue-500/10 text-blue-400' : 'bg-zinc-800/50 text-zinc-400'}`}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => {
                    const ids = selected
                      ? (selectedSegmentIds || []).filter(id => id !== seg.id)
                      : [...(selectedSegmentIds || []), seg.id]
                    onSegmentIdsChange?.(ids)
                  }}
                  className="rounded border-zinc-600"
                />
                <span className="font-mono truncate">{seg.id}</span>
                <span className="text-zinc-600 ml-auto">{seg.section}</span>
              </label>
            )
          })}
        </div>
      )}

      {/* Advanced toggle for existing range indicator */}
      {captureRange && mode !== CAPTURE_MODES.TIME_RANGE && (
        <div className="text-xs text-blue-400 bg-blue-500/10 rounded px-2 py-1 flex items-center justify-between">
          <span>Active range: {formatTime(captureRange.start)} – {formatTime(captureRange.end)}</span>
          <button onClick={handleClearRange} className="text-zinc-400 hover:text-zinc-300">
            Clear
          </button>
        </div>
      )}
    </div>
  )
}
