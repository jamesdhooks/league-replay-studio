/**
 * CaptureRangeSelector — Adjustable start/end markers for partial capture.
 *
 * Shows a timeline with draggable range handles + segment annotations.
 * Also provides capture mode selector (all / uncaptured / range / specific).
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useScriptState, CAPTURE_MODES } from '../../context/ScriptStateContext'
import { formatTime } from '../../utils/time'
import RangeSlider from '../ui/RangeSlider'
import { Maximize2, Crosshair, Filter, Clock } from 'lucide-react'

const MODE_LABELS = {
  [CAPTURE_MODES.ALL]:              { label: 'Capture All',       icon: Maximize2,  desc: 'Capture all script segments' },
  [CAPTURE_MODES.UNCAPTURED_ONLY]:  { label: 'Uncaptured Only',   icon: Filter,     desc: 'Only capture segments not yet recorded' },
  [CAPTURE_MODES.SPECIFIC]:         { label: 'Specific Segments', icon: Crosshair,  desc: 'Select individual segments to capture' },
  [CAPTURE_MODES.TIME_RANGE]:       { label: 'Time Range',        icon: Clock,      desc: 'Capture segments within a time window' },
}

function formatEventLabel(segment) {
  const explicit = [
    segment.event_name,
    segment.event_title,
    segment.event_label,
    segment.event_type,
    segment.type,
  ].find((value) => typeof value === 'string' && value.trim())

  if (!explicit) return 'Event'

  return String(explicit)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function formatDriverLabel(segment) {
  const driverNames = Array.isArray(segment.driver_names)
    ? segment.driver_names.filter((name) => typeof name === 'string' && name.trim())
    : []

  if (driverNames.length > 0) return driverNames.join(', ')

  const involvedDrivers = Array.isArray(segment.involved_drivers) ? segment.involved_drivers : []
  if (involvedDrivers.length > 0) {
    return involvedDrivers
      .map((driver) => {
        if (driver && typeof driver === 'object') {
          return driver.name || driver.driver_name || driver.label || driver.id
        }
        return `#${driver}`
      })
      .filter(Boolean)
      .join(', ')
  }

  return 'No drivers listed'
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function CaptureRangeSelector({
  projectId,
  script = [],
  totalDuration = 0,
  initialMode = CAPTURE_MODES.ALL,
  onModeChange,
  onRangeChange,
  selectedSegmentIds,
  onSegmentIdsChange,
  showModeSelector = true,
  disabled = false,
}) {
  const { captureRange, setCaptureRange: setCaptureRangeApi } = useScriptState()
  const [mode, setMode] = useState(initialMode || CAPTURE_MODES.ALL)
  const [saveState, setSaveState] = useState('idle') // 'idle' | 'saving' | 'saved'
  const [hasUnsaved, setHasUnsaved] = useState(false)
  const saveTimerRef = useRef(null)

  useEffect(() => {
    setMode(initialMode || CAPTURE_MODES.ALL)
  }, [initialMode])
  
  // Normalized 0-1 range for the slider
  const [rangeStart, setRangeStart] = useState(
    captureRange && totalDuration > 0 
      ? captureRange.start / totalDuration 
      : 0
  )
  const [rangeEnd, setRangeEnd] = useState(
    captureRange && totalDuration > 0 
      ? captureRange.end / totalDuration 
      : 1
  )

  // Convert script segments to RangeSlider event format
  const rangeSliderEvents = useMemo(() =>
    script
      .filter(s => s.type !== 'transition' && s.type !== 'bridge')
      .map(s => ({
        start_time_seconds: s.start_time_seconds || 0,
        end_time_seconds: s.end_time_seconds || 0,
        event_type: s.section || 'race',
        inclusion: s.section === 'race' ? 'highlight' : null,
      })),
    [script]
  )

  // Segment list for specific mode
  const segmentList = useMemo(() => {
    const seen = new Set()
    return script
      .filter((s) => {
        if (s.type === 'transition' || s.type === 'bridge') return false
        const start = Number(s.start_time_seconds || 0)
        const end = Number(s.end_time_seconds || 0)
        const id = String(s.id || s.segment_id || '').trim()
        if (!id) return false
        if ((end - start) <= 0) return false
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      .map(s => ({
        id: String(s.id || s.segment_id || '').trim(),
        section: s.section || 'race',
        start: Number(s.start_time_seconds || 0),
        end: Number(s.end_time_seconds || 0),
        duration: Math.max(0, Number(s.end_time_seconds || 0) - Number(s.start_time_seconds || 0)),
        eventLabel: formatEventLabel(s),
        driverLabel: formatDriverLabel(s),
      }))
  }, [script])

  // Calculate effective duration from script if totalDuration is 0
  const effectiveDuration = useMemo(() => {
    if (totalDuration > 0) return totalDuration
    // Fallback: use max end time from segments
    const maxEnd = Math.max(0, ...segmentList.map(s => s.end || 0))
    return maxEnd > 0 ? maxEnd : 1 // Return at least 1 to avoid division by zero
  }, [totalDuration, segmentList])

  // Section boundaries for annotation (unique sections with their time ranges)
  const sectionBoundaries = useMemo(() => {
    const boundaries = {}
    for (const seg of segmentList) {
      if (!boundaries[seg.section]) {
        boundaries[seg.section] = { section: seg.section, start: seg.start, end: seg.end }
      } else {
        boundaries[seg.section].start = Math.min(boundaries[seg.section].start, seg.start)
        boundaries[seg.section].end = Math.max(boundaries[seg.section].end, seg.end)
      }
    }
    const sectionOrder = ['intro', 'qualifying_results', 'race', 'race_results']
    return sectionOrder
      .filter(s => boundaries[s])
      .map(s => boundaries[s])
  }, [segmentList])

  // Section boundary coloring for the slider's bottom strip
  const SECTION_COLORS = {
    intro: 'rgba(168,85,247,0.7)',           // purple
    qualifying_results: 'rgba(6,182,212,0.7)', // cyan
    race: 'rgba(34,197,94,0.7)',              // green
    race_results: 'rgba(245,158,11,0.7)',     // amber
  }

  const sectionBands = useMemo(() => {
    if (effectiveDuration <= 0) return []
    return sectionBoundaries.map(section => {
      const startPct = (section.start / effectiveDuration) * 100
      const endPct = (section.end / effectiveDuration) * 100
      const label = section.section
        .replace(/_results$/, ' Results')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase())
      return {
        section: section.section,
        start: section.start,
        end: section.end,
        startPct,
        widthPct: endPct - startPct,
        color: SECTION_COLORS[section.section] || 'rgba(107,114,128,0.5)',
        label,
      }
    })
  }, [sectionBoundaries, effectiveDuration])

  const handleModeChange = useCallback((newMode) => {
    setMode(newMode)
    onModeChange?.(newMode)
  }, [onModeChange])

  const handleRangeSliderChange = useCallback((start, end) => {
    if (disabled) return
    setRangeStart(start)
    setRangeEnd(end)
    setHasUnsaved(true)
    setSaveState('idle')
    // Notify parent of seconds-based range for preview
    if (effectiveDuration > 0) {
      onRangeChange?.({ 
        start: start * effectiveDuration, 
        end: end * effectiveDuration 
      })
    }
  }, [disabled, effectiveDuration, onRangeChange])

  const handleApplyRange = useCallback(async () => {
    if (effectiveDuration <= 0) return
    setSaveState('saving')
    try {
      const startSecs = rangeStart * effectiveDuration
      const endSecs = rangeEnd * effectiveDuration
      await setCaptureRangeApi(projectId, startSecs, endSecs)
      setHasUnsaved(false)
      setSaveState('saved')
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => setSaveState('idle'), 2000)
    } catch {
      setSaveState('idle')
    }
  }, [rangeStart, rangeEnd, effectiveDuration, setCaptureRangeApi, projectId])

  const handleClearRange = useCallback(async () => {
    await setCaptureRangeApi(projectId, null, null)
    setRangeStart(0)
    setRangeEnd(1)
  }, [setCaptureRangeApi, projectId])

  const displayStart = rangeStart * effectiveDuration
  const displayEnd = rangeEnd * effectiveDuration

  const selectedTotalDuration = useMemo(() => {
    const selectedIds = new Set(selectedSegmentIds || [])
    return segmentList.reduce((sum, seg) => (
      selectedIds.has(seg.id) ? sum + (seg.duration || 0) : sum
    ), 0)
  }, [segmentList, selectedSegmentIds])

  const selectedCount = (selectedSegmentIds || []).length

  return (
    <div className="space-y-1.5">
      {showModeSelector && (
        <div className="flex items-center gap-2">
          <span className="text-xxs text-text-tertiary font-semibold uppercase tracking-wider">Capture Mode:</span>
          <div className="flex gap-1">
            {Object.entries(MODE_LABELS).map(([key, { label, icon: Icon }]) => (
              <button
                key={key}
                onClick={() => handleModeChange(key)}
                disabled={disabled}
                className={`flex items-center gap-1 px-2 py-1 text-xxs rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                  ${mode === key
                    ? 'bg-accent/10 text-accent border border-accent/30'
                    : 'bg-bg-secondary text-text-tertiary border border-border hover:border-text-tertiary'
                  }`}
              >
                <Icon className="w-3 h-3" />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Mode description */}
      <p className="text-xxs text-text-tertiary">{MODE_LABELS[mode]?.desc}</p>

      {/* Time range controls */}
      {mode === CAPTURE_MODES.TIME_RANGE && (
        <div className="space-y-1.5">
          <div className="w-full">
            <RangeSlider
              rangeStart={rangeStart}
              rangeEnd={rangeEnd}
              onChange={handleRangeSliderChange}
              totalDuration={effectiveDuration}
              events={rangeSliderEvents}
              sectionBands={sectionBands}
            />
          </div>
          
          {/* Section legend */}
          {sectionBands.length > 0 && (
            <div className="flex items-center gap-3 text-[10px] text-text-tertiary px-1 flex-wrap">
              {sectionBands.map(band => (
                <span key={band.section} className="flex items-center gap-1">
                  <span className="w-3 h-1.5 rounded-sm inline-block" style={{ backgroundColor: band.color }} />
                  {band.label}
                </span>
              ))}
            </div>
          )}

          <div className="px-1 pt-0.5">
            <div className="flex items-center justify-between text-xxs text-text-tertiary tabular-nums">
              <span>Start {formatTime(displayStart)}</span>
              <span>End {formatTime(displayEnd)}</span>
            </div>
            <div className="text-center text-xxs text-accent font-medium tabular-nums mt-0.5">
              {formatTime(displayEnd - displayStart)} selected
            </div>
          </div>
          <button
            onClick={handleApplyRange}
            disabled={saveState === 'saving' || disabled}
            className={`w-full px-3 py-1 text-xxs font-medium rounded border transition-colors flex items-center justify-center gap-1.5
              ${
                saveState === 'saved'
                  ? 'bg-green-500/10 text-green-400 border-green-500/30'
                  : hasUnsaved
                    ? 'bg-accent text-white border-accent hover:bg-accent-hover'
                    : 'bg-accent/10 text-accent border-accent/30 hover:bg-accent/20'
              }`}
          >
            {saveState === 'saving' && (
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
            )}
            {saveState === 'saved' ? '✓ Range Saved' : hasUnsaved ? 'Save Range' : 'Range Saved'}
          </button>
        </div>
      )}

      {/* Specific segments selector */}
      {mode === CAPTURE_MODES.SPECIFIC && (
        <div className="space-y-1.5">
          <div className="max-h-64 overflow-y-auto pr-1 space-y-1.5">
            {segmentList.map(seg => {
              const selected = selectedSegmentIds?.includes(seg.id)
              return (
                <label
                  key={seg.id}
                  className={`flex items-start gap-2 text-xxs px-2 py-1 rounded cursor-pointer
                    ${selected ? 'bg-accent/10 text-accent' : 'bg-bg-secondary/50 text-text-tertiary'}`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={disabled}
                    onChange={() => {
                      const ids = selected
                        ? (selectedSegmentIds || []).filter(id => id !== seg.id)
                        : [...(selectedSegmentIds || []), seg.id]
                      onSegmentIdsChange?.(ids)
                    }}
                    className="rounded border-border"
                  />
                  <div className="flex-1 min-w-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 items-start">
                    <div className="truncate text-text-secondary">
                      <span className="font-mono">{seg.id}</span> - {seg.eventLabel}
                    </div>
                    <div className="text-right text-text-disabled capitalize whitespace-nowrap">
                      {seg.section.replace(/_/g, ' ')}
                    </div>
                    <div className="truncate text-text-disabled">
                      {seg.driverLabel}
                    </div>
                    <div className="text-right text-text-tertiary tabular-nums whitespace-nowrap">
                      {formatTime(seg.start)} - {formatTime(seg.end)} ({formatTime(seg.duration)})
                    </div>
                  </div>
                </label>
              )
            })}
          </div>

          <div className="text-xxs text-accent bg-accent/5 border border-accent/20 rounded px-2 py-1 flex items-center justify-between tabular-nums">
            <span>{selectedCount} selected</span>
            <span>Total {formatTime(selectedTotalDuration)}</span>
          </div>
        </div>
      )}

      {/* Active range indicator */}
      {captureRange && mode !== CAPTURE_MODES.TIME_RANGE && (
        <div className="text-xxs text-accent bg-accent/5 border border-accent/20 rounded px-2 py-1 flex items-center justify-between">
          <span>Active range: {formatTime(captureRange.start)} – {formatTime(captureRange.end)}</span>
          <button
            onClick={handleClearRange}
            disabled={disabled}
            className="text-text-tertiary hover:text-text-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  )
}
