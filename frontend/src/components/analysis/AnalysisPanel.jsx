import { useState, useEffect } from 'react'
import { useAnalysis } from '../../context/AnalysisContext'
import { useProject } from '../../context/ProjectContext'
import {
  Play, Square, BarChart3, AlertTriangle, Swords, ArrowUpDown,
  Fuel, Zap, Crown, Flag, FlagTriangleRight, Loader2, CheckCircle2,
  XCircle,
} from 'lucide-react'

/**
 * Event type display configuration — icons, labels, and colors.
 */
const EVENT_CONFIG = {
  incident:      { icon: AlertTriangle,   label: 'Incidents',      color: 'text-event-incident',  bg: 'bg-event-incident/10' },
  battle:        { icon: Swords,          label: 'Battles',        color: 'text-event-battle',    bg: 'bg-event-battle/10' },
  overtake:      { icon: ArrowUpDown,     label: 'Overtakes',      color: 'text-event-overtake',  bg: 'bg-event-overtake/10' },
  pit_stop:      { icon: Fuel,            label: 'Pit Stops',      color: 'text-event-pit',       bg: 'bg-event-pit/10' },
  fastest_lap:   { icon: Zap,             label: 'Fastest Laps',   color: 'text-event-fastest',   bg: 'bg-event-fastest/10' },
  leader_change: { icon: Crown,           label: 'Leader Changes', color: 'text-event-leader',    bg: 'bg-event-leader/10' },
  first_lap:     { icon: FlagTriangleRight, label: 'First Lap',    color: 'text-event-firstlap',  bg: 'bg-event-firstlap/10' },
  last_lap:      { icon: Flag,            label: 'Last Lap',       color: 'text-event-lastlap',   bg: 'bg-event-lastlap/10' },
}

/**
 * AnalysisPanel — Main UI for replay analysis.
 *
 * Shows:
 *  - Start/cancel analysis controls
 *  - Real-time progress bar during scanning
 *  - Event summary with type breakdown
 *  - Scrollable event list with severity badges
 */
export default function AnalysisPanel() {
  const {
    isAnalyzing, progress, events, eventSummary, error,
    startAnalysis, cancelAnalysis, fetchEvents, fetchEventSummary,
    fetchAnalysisStatus,
  } = useAnalysis()
  const { activeProject } = useProject()
  const [activeFilter, setActiveFilter] = useState('')

  // Load analysis data when project changes
  useEffect(() => {
    if (activeProject?.id) {
      fetchAnalysisStatus(activeProject.id)
      fetchEvents(activeProject.id)
      fetchEventSummary(activeProject.id)
    }
  }, [activeProject?.id, fetchAnalysisStatus, fetchEvents, fetchEventSummary])

  if (!activeProject) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary">
        <p>Select a project to view analysis</p>
      </div>
    )
  }

  const handleStart = async () => {
    try {
      await startAnalysis(activeProject.id)
    } catch {
      // Error is set in context
    }
  }

  const handleCancel = async () => {
    try {
      await cancelAnalysis(activeProject.id)
    } catch {
      // Error is set in context
    }
  }

  const handleFilterChange = async (type) => {
    const newFilter = activeFilter === type ? '' : type
    setActiveFilter(newFilter)
    await fetchEvents(activeProject.id, { eventType: newFilter })
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <BarChart3 size={18} className="text-accent" />
          <h2 className="text-sm font-medium text-text-primary">Replay Analysis</h2>
        </div>
        <div className="flex items-center gap-2">
          {isAnalyzing ? (
            <button
              onClick={handleCancel}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium
                         text-danger bg-danger/10 rounded-md hover:bg-danger/20
                         transition-colors"
            >
              <Square size={14} />
              Cancel
            </button>
          ) : (
            <button
              onClick={handleStart}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium
                         text-accent bg-accent/10 rounded-md hover:bg-accent/20
                         transition-colors"
            >
              <Play size={14} />
              Analyze
            </button>
          )}
        </div>
      </div>

      {/* ── Progress Bar ── */}
      {isAnalyzing && progress && (
        <div className="px-4 py-3 border-b border-border bg-bg-secondary">
          <div className="flex items-center gap-2 mb-2">
            <Loader2 size={14} className="text-accent animate-spin" />
            <span className="text-xs text-text-secondary">
              {progress.message || 'Analyzing...'}
            </span>
          </div>
          <div className="w-full h-1.5 bg-surface rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-300"
              style={{ width: `${progress.percent || 0}%` }}
            />
          </div>
          {progress.totalTicks > 0 && (
            <p className="text-xxs text-text-tertiary mt-1">
              {progress.totalTicks} telemetry samples collected
            </p>
          )}
        </div>
      )}

      {/* ── Completion Summary ── */}
      {!isAnalyzing && progress?.percent === 100 && (
        <div className="px-4 py-3 border-b border-border bg-success-muted">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-success" />
            <span className="text-xs text-success-text font-medium">
              {progress.message}
            </span>
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="px-4 py-3 border-b border-border bg-danger-muted">
          <div className="flex items-center gap-2">
            <XCircle size={14} className="text-danger" />
            <span className="text-xs text-danger-text">{error}</span>
          </div>
        </div>
      )}

      {/* ── Event Summary ── */}
      {eventSummary && eventSummary.total_events > 0 && (
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-xs font-medium text-text-secondary mb-2">
            Events Detected ({eventSummary.total_events})
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {eventSummary.by_type.map(({ event_type, count }) => {
              const config = EVENT_CONFIG[event_type] || {}
              const Icon = config.icon || BarChart3
              const isActive = activeFilter === event_type
              return (
                <button
                  key={event_type}
                  onClick={() => handleFilterChange(event_type)}
                  className={`flex items-center gap-1 px-2 py-1 text-xxs rounded-md
                             transition-colors border
                             ${isActive
                               ? 'border-accent bg-accent/10 text-accent'
                               : 'border-border hover:border-border-strong text-text-secondary hover:text-text-primary'
                             }`}
                >
                  <Icon size={12} className={config.color} />
                  <span>{config.label || event_type}</span>
                  <span className="ml-0.5 font-mono">{count}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Event List ── */}
      <div className="flex-1 overflow-y-auto">
        {events.length === 0 && !isAnalyzing && (
          <div className="flex flex-col items-center justify-center h-full text-text-tertiary gap-2 p-4">
            <BarChart3 size={32} className="opacity-50" />
            <p className="text-sm">No events detected yet</p>
            <p className="text-xs">Click Analyze to scan the replay</p>
          </div>
        )}

        {events.map((event) => {
          const config = EVENT_CONFIG[event.event_type] || {}
          const Icon = config.icon || BarChart3
          return (
            <div
              key={event.id}
              className="flex items-center gap-3 px-4 py-2.5 border-b border-border-subtle
                         hover:bg-bg-hover transition-colors cursor-pointer"
            >
              {/* Type icon */}
              <div className={`flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center ${config.bg || 'bg-surface'}`}>
                <Icon size={14} className={config.color || 'text-text-secondary'} />
              </div>

              {/* Event info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-text-primary">
                    {config.label || event.event_type}
                  </span>
                  {event.lap_number && (
                    <span className="text-xxs text-text-tertiary">Lap {event.lap_number}</span>
                  )}
                </div>
                <div className="text-xxs text-text-tertiary mt-0.5">
                  {formatTime(event.start_time_seconds)} — {formatTime(event.end_time_seconds)}
                  {event.involved_drivers?.length > 0 && (
                    <span className="ml-2">
                      · {event.involved_drivers.length} driver{event.involved_drivers.length > 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </div>

              {/* Severity badge */}
              <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xxs font-bold
                              ${severityColor(event.severity)}`}>
                {event.severity}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Format seconds as M:SS */
function formatTime(seconds) {
  if (seconds === null || seconds === undefined || seconds < 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Severity badge color */
function severityColor(severity) {
  if (severity >= 8) return 'bg-danger/20 text-danger'
  if (severity >= 6) return 'bg-warning/20 text-warning'
  if (severity >= 4) return 'bg-accent/20 text-accent'
  return 'bg-surface-active text-text-tertiary'
}
