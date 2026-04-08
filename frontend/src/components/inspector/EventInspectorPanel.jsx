import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTimeline, EVENT_COLORS } from '../../context/TimelineContext'
import { useHighlight } from '../../context/HighlightContext'
import { useToast } from '../../context/ToastContext'
import { EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { formatTimePrecise } from '../../utils/time'
import {
  Info, X, Save, RotateCcw, Scissors, Trash2,
  ChevronDown, Users, Clock, Star, Camera, Zap,
  ToggleLeft, ToggleRight, BarChart2,
} from 'lucide-react'

/** All event types available for the dropdown */
const EVENT_TYPES = [
  'incident', 'battle', 'overtake', 'pit_stop',
  'fastest_lap', 'leader_change', 'first_lap', 'last_lap',
]

/**
 * EventInspectorPanel — Detail panel for the selected timeline event.
 *
 * Shows all event properties: type, severity, timestamps, involved drivers,
 * camera/car assignment, include-in-highlight toggle.
 * Actions: Apply Changes, Revert, Split at Playhead, Delete.
 *
 * @param {Object} props
 * @param {number} props.projectId - Active project ID
 */
export default function EventInspectorPanel({ projectId }) {
  const {
    selectedEventId, setSelectedEventId, events,
    updateEvent, deleteEvent, splitEvent,
    playheadTime, seekTo,
  } = useTimeline()
  const { drivers } = useHighlight()
  const { showSuccess, showError } = useToast()

  // ── Find the selected event ──────────────────────────────────────────────
  const selectedEvent = useMemo(
    () => events.find(e => e.id === selectedEventId) || null,
    [events, selectedEventId],
  )

  // ── Local editing state (copy of event fields for editing) ───────────────
  const [editState, setEditState] = useState(null)
  const [isDirty, setIsDirty] = useState(false)

  // Sync local state when the selected event changes
  useEffect(() => {
    if (selectedEvent) {
      setEditState({
        event_type: selectedEvent.event_type,
        severity: selectedEvent.severity,
        start_time_seconds: selectedEvent.start_time_seconds,
        end_time_seconds: selectedEvent.end_time_seconds,
        start_frame: selectedEvent.start_frame,
        end_frame: selectedEvent.end_frame,
        included_in_highlight: !!selectedEvent.included_in_highlight,
        involved_drivers: Array.isArray(selectedEvent.involved_drivers)
          ? [...selectedEvent.involved_drivers]
          : [],
      })
      setIsDirty(false)
    } else {
      setEditState(null)
      setIsDirty(false)
    }
  }, [selectedEvent])

  // ── Check if local state differs from original ──────────────────────────
  const checkDirty = useCallback((newState) => {
    if (!selectedEvent) return false
    return (
      newState.event_type !== selectedEvent.event_type ||
      newState.severity !== selectedEvent.severity ||
      newState.start_time_seconds !== selectedEvent.start_time_seconds ||
      newState.end_time_seconds !== selectedEvent.end_time_seconds ||
      newState.start_frame !== selectedEvent.start_frame ||
      newState.end_frame !== selectedEvent.end_frame ||
      newState.included_in_highlight !== !!selectedEvent.included_in_highlight ||
      JSON.stringify(newState.involved_drivers) !== JSON.stringify(selectedEvent.involved_drivers)
    )
  }, [selectedEvent])

  // ── Field update helper ─────────────────────────────────────────────────
  const updateField = useCallback((field, value) => {
    setEditState(prev => {
      const next = { ...prev, [field]: value }
      setIsDirty(checkDirty(next))
      return next
    })
  }, [checkDirty])

  // ── Apply changes ─────────────────────────────────────────────────────────
  const handleApply = useCallback(async () => {
    if (!editState || !selectedEvent) return
    try {
      await updateEvent(projectId, selectedEvent.id, editState)
      setIsDirty(false)
      showSuccess('Event updated')
    } catch {
      showError('Failed to update event')
    }
  }, [editState, selectedEvent, projectId, updateEvent, showSuccess, showError])

  // ── Revert to original ────────────────────────────────────────────────────
  const handleRevert = useCallback(() => {
    if (!selectedEvent) return
    setEditState({
      event_type: selectedEvent.event_type,
      severity: selectedEvent.severity,
      start_time_seconds: selectedEvent.start_time_seconds,
      end_time_seconds: selectedEvent.end_time_seconds,
      start_frame: selectedEvent.start_frame,
      end_frame: selectedEvent.end_frame,
      included_in_highlight: !!selectedEvent.included_in_highlight,
      involved_drivers: Array.isArray(selectedEvent.involved_drivers)
        ? [...selectedEvent.involved_drivers]
        : [],
    })
    setIsDirty(false)
  }, [selectedEvent])

  // ── Split at playhead ─────────────────────────────────────────────────────
  const handleSplit = useCallback(async () => {
    if (!selectedEvent) return
    try {
      await splitEvent(projectId, selectedEvent.id, playheadTime)
      showSuccess('Event split at playhead')
    } catch {
      showError('Failed to split event')
    }
  }, [selectedEvent, projectId, splitEvent, playheadTime, showSuccess, showError])

  // ── Delete event ──────────────────────────────────────────────────────────
  const handleDelete = useCallback(async () => {
    if (!selectedEvent) return
    try {
      await deleteEvent(projectId, selectedEvent.id)
      showSuccess('Event deleted')
    } catch {
      showError('Failed to delete event')
    }
  }, [selectedEvent, projectId, deleteEvent, showSuccess, showError])

  // ── Toggle driver inclusion ───────────────────────────────────────────────
  const toggleDriver = useCallback((carIdx) => {
    setEditState(prev => {
      const driverList = [...(prev.involved_drivers || [])]
      const idx = driverList.indexOf(carIdx)
      if (idx >= 0) {
        driverList.splice(idx, 1)
      } else {
        driverList.push(carIdx)
      }
      const next = { ...prev, involved_drivers: driverList }
      setIsDirty(checkDirty(next))
      return next
    })
  }, [checkDirty])

  // ── Compute split availability ────────────────────────────────────────────
  const canSplit = selectedEvent && editState &&
    playheadTime > selectedEvent.start_time_seconds &&
    playheadTime < selectedEvent.end_time_seconds

  // ── Empty state ───────────────────────────────────────────────────────────
  if (!selectedEvent || !editState) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-tertiary p-4 gap-2">
        <Info size={24} className="opacity-40" />
        <p className="text-xs text-center">
          Select an event on the timeline to inspect and edit its properties.
        </p>
      </div>
    )
  }

  const eventColor = EVENT_COLORS[editState.event_type] || '#6b7280'
  const duration = Math.max(0, editState.end_time_seconds - editState.start_time_seconds)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-secondary shrink-0">
        <div
          className="w-3 h-3 rounded-full shrink-0"
          style={{ backgroundColor: eventColor }}
        />
        <h3 className="text-xs font-semibold text-text-primary uppercase tracking-wider flex-1">
          Event Inspector
        </h3>
        {isDirty && (
          <span className="text-xxs text-warning font-medium">Modified</span>
        )}
        <button
          onClick={() => setSelectedEventId(null)}
          className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          title="Close inspector"
        >
          <X size={14} />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* ── Event Type ───────────────────────────────────────────────── */}
        <Section icon={Zap} label="Event Type">
          <div className="relative">
            <select
              value={editState.event_type}
              onChange={(e) => updateField('event_type', e.target.value)}
              className="w-full appearance-none bg-bg-primary border border-border rounded px-2 py-1.5
                         text-xs text-text-primary focus:outline-none focus:border-accent
                         cursor-pointer pr-7"
            >
              {EVENT_TYPES.map(type => (
                <option key={type} value={type}>
                  {EVENT_TYPE_LABELS[type] || type}
                </option>
              ))}
            </select>
            <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
          </div>
        </Section>

        {/* ── Severity ─────────────────────────────────────────────────── */}
        <Section icon={Star} label="Severity">
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={editState.severity}
              onChange={(e) => updateField('severity', parseInt(e.target.value, 10))}
              className="flex-1 h-1.5 accent-accent cursor-pointer"
            />
            <span className="text-xs font-mono text-text-primary w-6 text-right">
              {editState.severity}
            </span>
          </div>
        </Section>

        {/* ── Timestamps ───────────────────────────────────────────────── */}
        <Section icon={Clock} label="Timestamps">
          <div className="grid grid-cols-2 gap-2">
            <FrameInput
              label="Start"
              time={editState.start_time_seconds}
              frame={editState.start_frame}
              onTimeChange={(v) => updateField('start_time_seconds', v)}
              onFrameChange={(v) => updateField('start_frame', v)}
            />
            <FrameInput
              label="End"
              time={editState.end_time_seconds}
              frame={editState.end_frame}
              onTimeChange={(v) => updateField('end_time_seconds', v)}
              onFrameChange={(v) => updateField('end_frame', v)}
            />
          </div>
          <div className="mt-1.5 text-xxs text-text-tertiary">
            Duration: {formatTimePrecise(duration)}
          </div>
        </Section>

        {/* ── Include in Highlight ──────────────────────────────────────── */}
        <Section icon={editState.included_in_highlight ? ToggleRight : ToggleLeft} label="Highlight">
          <button
            onClick={() => updateField('included_in_highlight', !editState.included_in_highlight)}
            className={`flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs transition-colors
              ${editState.included_in_highlight
                ? 'bg-accent/15 text-accent border border-accent/30'
                : 'bg-bg-primary text-text-secondary border border-border'
              }`}
          >
            {editState.included_in_highlight ? (
              <ToggleRight size={16} className="text-accent" />
            ) : (
              <ToggleLeft size={16} className="text-text-disabled" />
            )}
            {editState.included_in_highlight ? 'Included in highlight' : 'Excluded from highlight'}
          </button>
        </Section>

        {/* ── Camera / Target Car ──────────────────────────────────────── */}
        <Section icon={Camera} label="Camera">
          <div className="text-xxs text-text-tertiary">
            {selectedEvent.metadata?.cam_car_idx != null ? (
              <span>
                Target car: #{selectedEvent.metadata.cam_car_idx}
                {drivers.find(d => d.car_idx === selectedEvent.metadata.cam_car_idx)
                  ? ` (${drivers.find(d => d.car_idx === selectedEvent.metadata.cam_car_idx).user_name})`
                  : ''}
              </span>
            ) : (
              <span className="italic">Auto (director camera)</span>
            )}
          </div>
        </Section>

        {/* ── Involved Drivers ──────────────────────────────────────────── */}
        <Section icon={Users} label="Involved Drivers">
          {(() => {
            const involvedDrivers = drivers.filter(d => editState.involved_drivers.includes(d.car_idx))
            return involvedDrivers.length > 0 ? (
              <div className="text-xxs text-accent font-medium mb-1.5 px-2 leading-relaxed">
                {involvedDrivers.map(d => d.user_name || `Car ${d.car_idx}`).join(', ')}
              </div>
            ) : null
          })()}
          {drivers.length > 0 ? (
            <div className="space-y-0.5 max-h-36 overflow-y-auto">
              {drivers.map(driver => {
                const isIncluded = editState.involved_drivers.includes(driver.car_idx)
                return (
                  <label
                    key={driver.car_idx}
                    className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer text-xxs
                      transition-colors hover:bg-bg-hover
                      ${isIncluded ? 'text-text-primary' : 'text-text-disabled'}`}
                  >
                    <input
                      type="checkbox"
                      checked={isIncluded}
                      onChange={() => toggleDriver(driver.car_idx)}
                      className="accent-accent w-3 h-3"
                    />
                    <span className="font-mono text-text-tertiary w-5">#{driver.car_number}</span>
                    <span className="truncate">{driver.user_name || `Car ${driver.car_idx}`}</span>
                  </label>
                )
              })}
            </div>
          ) : (
            <div className="text-xxs text-text-disabled italic">
              No driver data available
            </div>
          )}
        </Section>

        {/* ── Metadata ─────────────────────────────────────────────────── */}
        {selectedEvent.metadata && Object.keys(selectedEvent.metadata).length > 0 && (
          <Section icon={Info} label="Metadata">
            <div className="space-y-0.5">
              {Object.entries(selectedEvent.metadata).map(([key, val]) => (
                <div key={key} className="flex items-center gap-1.5 text-xxs">
                  <span className="text-text-tertiary">{key}:</span>
                  <span className="text-text-secondary font-mono truncate">
                    {typeof val === 'object' ? JSON.stringify(val) : String(val)}
                  </span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ── Score Breakdown ───────────────────────────────────────────── */}
        {selectedEvent.score_components && (
          <Section icon={BarChart2} label={`Score Breakdown — ${selectedEvent.score ?? '?'} [${selectedEvent.tier ?? '?'}]`}>
            <div className="space-y-1">
              {Object.entries(selectedEvent.score_components).map(([key, val]) => {
                const pct = Math.min(100, Math.max(0, Math.abs(val) * 10))
                const isNegative = val < 0
                return (
                  <div key={key} className="space-y-0.5">
                    <div className="flex items-center justify-between text-xxs">
                      <span className="text-text-tertiary capitalize">{key.replace(/_/g, ' ')}</span>
                      <span className={`font-mono ${isNegative ? 'text-danger' : 'text-text-primary'}`}>
                        {isNegative ? '' : '+'}{val}
                      </span>
                    </div>
                    <div className="h-1 bg-bg-primary rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${isNegative ? 'bg-danger' : 'bg-accent'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </Section>
        )}
      </div>

      {/* Action buttons */}
      <div className="border-t border-border px-3 py-2 space-y-1.5 bg-bg-secondary shrink-0">
        {/* Primary row: Apply + Revert */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleApply}
            disabled={!isDirty}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs
              font-medium transition-colors
              ${isDirty
                ? 'bg-accent hover:bg-accent-hover text-white'
                : 'bg-bg-primary text-text-disabled cursor-not-allowed border border-border'
              }`}
          >
            <Save size={12} />
            Apply
          </button>
          <button
            onClick={handleRevert}
            disabled={!isDirty}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs
              font-medium transition-colors
              ${isDirty
                ? 'bg-bg-primary text-text-primary hover:bg-bg-hover border border-border'
                : 'bg-bg-primary text-text-disabled cursor-not-allowed border border-border'
              }`}
          >
            <RotateCcw size={12} />
            Revert
          </button>
        </div>

        {/* Secondary row: Split + Delete */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleSplit}
            disabled={!canSplit}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs
              transition-colors
              ${canSplit
                ? 'text-text-primary hover:bg-bg-hover border border-border'
                : 'text-text-disabled cursor-not-allowed border border-border-subtle'
              }`}
            title={canSplit ? 'Split at playhead position' : 'Move playhead inside event to split'}
          >
            <Scissors size={12} />
            Split
          </button>
          <button
            onClick={handleDelete}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs
                       text-danger hover:bg-danger/10 border border-border transition-colors"
          >
            <Trash2 size={12} />
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}


/**
 * Section wrapper — collapsible section with icon and label.
 */
function Section({ icon: Icon, label, children }) {
  return (
    <div className="border-b border-border-subtle px-3 py-2.5">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={12} className="text-text-tertiary" />
        <span className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">
          {label}
        </span>
      </div>
      {children}
    </div>
  )
}


/**
 * FrameInput — time + frame input pair for precise editing.
 */
function FrameInput({ label, time, frame, onTimeChange, onFrameChange }) {
  return (
    <div className="space-y-1">
      <label className="text-xxs text-text-tertiary">{label}</label>
      <input
        type="text"
        value={formatTimePrecise(time)}
        onChange={(e) => {
          const parsed = parseTimeInput(e.target.value)
          if (parsed !== null) onTimeChange(parsed)
        }}
        className="w-full bg-bg-primary border border-border rounded px-2 py-1 text-xs
                   font-mono text-text-primary focus:outline-none focus:border-accent"
        title={`${label} time (MM:SS.mmm)`}
      />
      <input
        type="number"
        value={frame ?? 0}
        onChange={(e) => onFrameChange(parseInt(e.target.value, 10) || 0)}
        className="w-full bg-bg-primary border border-border rounded px-2 py-1 text-xs
                   font-mono text-text-secondary focus:outline-none focus:border-accent"
        title={`${label} frame`}
      />
    </div>
  )
}


/**
 * Parse MM:SS.mmm format to seconds.
 * Returns null if the format is invalid.
 */
function parseTimeInput(str) {
  if (!str) return null
  const match = str.match(/^(\d+):(\d{2})\.(\d{1,3})$/)
  if (match) {
    const m = parseInt(match[1], 10)
    const s = parseInt(match[2], 10)
    const ms = parseInt(match[3].padEnd(3, '0'), 10)
    return m * 60 + s + ms / 1000
  }
  // Try plain seconds
  const num = parseFloat(str)
  return isNaN(num) ? null : Math.max(0, num)
}
