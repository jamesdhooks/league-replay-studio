import {
  BarChart3, Loader2, ChevronDown, ChevronUp,
  Minus, Check, Film, X,
} from 'lucide-react'
import Tooltip from '../ui/Tooltip'
import EventDetail from './EventDetail'
import { EVENT_CONFIG, formatTime, scoreColor } from './analysisConstants'

export default function EventsTabContent({
  isAnalyzing, isScanning, isRedetecting, progress,
  events, eventSummary, eventSort, activeFilter,
  expandedEvent, focusedEvent, raceStart, isSeeking,
  overrides,
  handleFilterChange, cycleSort, seekToEvent,
  setExpandedEvent, toggleOverride,
  eventsEndRef,
}) {
  return (
    <div className="flex flex-col h-full">

      {isAnalyzing ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4 py-10">
          <Loader2 size={22} className="animate-spin text-text-disabled" />
          <span className="text-xs text-text-disabled text-center">
            {isScanning ? 'Collecting telemetry…' : 'Detecting events…'}
          </span>
          {!isScanning && progress != null && (
            <div className="w-full max-w-[160px]">
              <div className="h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-gradient-from to-gradient-to
                             rounded-full transition-all duration-500"
                  style={{ width: `${Math.max(0, Math.min(100, ((progress.percent ?? 85) - 85) / 12 * 100))}%` }}
                />
              </div>
              {progress.message && (
                <span className="text-xxs text-text-disabled mt-1.5 block text-center truncate">
                  {progress.message}
                </span>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* Filter chips */}
          {eventSummary && eventSummary.total_events > 0 && (
            <div className="px-3 py-2 border-b border-border-subtle flex flex-wrap gap-1">
              {eventSummary.by_type.map(({ event_type, count }) => {
                const cfg = EVENT_CONFIG[event_type] || {}
                const Icon = cfg.icon || BarChart3
                const isActive = activeFilter === event_type
                return (
                  <Tooltip
                    key={event_type}
                    content={`${cfg.label || event_type}: ${count} event${count !== 1 ? 's' : ''} — click to ${isActive ? 'show all' : 'filter'}`}
                    position="bottom"
                    delay={200}
                  >
                    <button
                      onClick={() => handleFilterChange(event_type)}
                      className={`flex items-center gap-1 px-1.5 py-0.5 text-xxs rounded
                                 transition-colors border
                                 ${isActive
                                   ? 'border-accent bg-accent/10 text-accent'
                                   : 'border-border text-text-tertiary hover:text-text-secondary'
                                 }`}
                    >
                      <Icon size={9} className={cfg.color} />
                      <span>{count}</span>
                    </button>
                  </Tooltip>
                )
              })}
            </div>
          )}

          {/* Sortable table header */}
          <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,auto)_1fr_auto_auto] border-b border-border bg-bg-secondary">
            {[
              { key: 'type',     label: 'Type' },
              { key: 'driver',   label: 'Driver(s)' },
              { key: 'time',     label: 'Time' },
              { key: 'severity', label: 'Score' },
            ].map(({ key, label }) => (
              <button key={key} onClick={() => cycleSort(key)}
                className="flex items-center gap-0.5 px-2 py-1.5 text-xxs font-semibold
                           text-text-secondary hover:text-text-primary hover:bg-bg-hover
                           transition-colors text-left whitespace-nowrap">
                {label}
                {eventSort.col === key
                  ? eventSort.dir === 'asc'
                    ? <ChevronUp size={9} className="text-accent shrink-0 ml-0.5" />
                    : <ChevronDown size={9} className="text-accent shrink-0 ml-0.5" />
                  : null}
              </button>
            ))}
          </div>

          {/* Event rows */}
          {(() => {
            const sorted = [...events].sort((a, b) => {
              const dir = eventSort.dir === 'asc' ? 1 : -1
              switch (eventSort.col) {
                case 'type':     return dir * ((a.event_type || '').localeCompare(b.event_type || ''))
                case 'driver':   return dir * ((a.driver_names?.[0] || '').localeCompare(b.driver_names?.[0] || ''))
                case 'time':     return dir * ((a.start_time_seconds || 0) - (b.start_time_seconds || 0))
                case 'severity': return dir * ((a.severity || 0) - (b.severity || 0))
                default: return 0
              }
            })
            return sorted.map((ev) => {
              const type = ev.event_type
              const cfg = EVENT_CONFIG[type] || {}
              const Icon = cfg.icon || BarChart3
              const startSec = ev.start_time_seconds
              const sev = ev.severity
              const eventId = ev.id
              const isExpanded = expandedEvent === `sidebar-${eventId}`
              const driverNames = ev.driver_names || []
              const override = overrides[String(eventId)] || null
              return (
                <div key={`e-${eventId}`}
                     className="border-b border-border-subtle/30 animate-slide-right">
                  <div
                    className={`grid grid-cols-[auto_minmax(0,auto)_1fr_auto_auto_auto]
                               hover:bg-bg-hover transition-colors
                               ${isSeeking ? 'cursor-wait opacity-60 pointer-events-none' : 'cursor-pointer'}
                               ${focusedEvent?.id === ev.id ? 'bg-accent/10 border-l-2 border-accent' : ''}`}
                    onClick={() => seekToEvent(ev)}
                  >
                    {/* Override toggle */}
                    <div className="flex items-center px-1 py-1.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleOverride(eventId) }}
                        className={`w-4 h-4 rounded border flex items-center justify-center transition-colors
                          ${override === 'highlight'
                            ? 'bg-success border-success text-white'
                            : override === 'full-video'
                              ? 'bg-info border-info text-white'
                              : override === 'exclude'
                                ? 'bg-danger border-danger text-white'
                                : 'border-border-subtle text-text-disabled hover:border-text-tertiary'
                          }`}
                        title={
                          override === 'highlight' ? 'Force highlight (click for full-video)'
                          : override === 'full-video' ? 'Force full-video (click to exclude)'
                          : override === 'exclude' ? 'Force excluded (click for auto)'
                          : 'Auto (click to force highlight)'
                        }
                      >
                        {override === 'highlight' && <Check className="w-2.5 h-2.5" />}
                        {override === 'full-video' && <Film className="w-2.5 h-2.5" />}
                        {override === 'exclude' && <X className="w-2.5 h-2.5" />}
                        {!override && <Minus className="w-2.5 h-2.5 opacity-30" />}
                      </button>
                    </div>
                    {/* Type */}
                    <div className="flex items-center gap-1.5 px-2 py-1.5 min-w-0">
                      <Icon size={11} className={`${cfg.color || 'text-text-tertiary'} shrink-0`} />
                      <span className="text-xxs text-text-primary truncate">{cfg.label || type}</span>
                    </div>
                    {/* Driver(s) */}
                    <div className="flex items-center px-2 py-1.5 min-w-0">
                      <span className="text-xxs text-text-secondary truncate">
                        {driverNames.length > 0 ? driverNames.join(', ') : '—'}
                      </span>
                    </div>
                    {/* Time */}
                    <div className="flex items-center px-2 py-1.5">
                      <span className="text-xxs text-text-disabled font-mono whitespace-nowrap">{formatTime(Math.max(0, startSec - raceStart))}</span>
                    </div>
                    {/* Score badge */}
                    <div className="flex items-center gap-0.5 px-2 py-1.5">
                      <span
                        className="w-5 h-5 rounded flex items-center justify-center text-xxs font-bold text-white"
                        style={{ backgroundColor: scoreColor(sev) }}
                        title={`Score: ${sev}`}
                      >
                        {sev}
                      </span>
                    </div>
                    {/* Expand */}
                    <div className="flex items-center px-1 py-1.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setExpandedEvent(prev => prev === `sidebar-${eventId}` ? null : `sidebar-${eventId}`)
                        }}
                        className="w-4 h-4 flex items-center justify-center rounded hover:bg-surface-active
                                   text-text-disabled hover:text-text-secondary transition-colors shrink-0"
                      >
                        <ChevronDown size={10}
                          className={`transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`} />
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-3 pt-2 pb-2 bg-bg-secondary/50 border-t border-border-subtle animate-fade-in">
                      <EventDetail event={ev} />
                    </div>
                  )}
                </div>
              )
            })
          })()}

          {events.length === 0 && (
            <div className="flex items-center justify-center py-8 text-text-disabled text-xs">
              No events detected
            </div>
          )}
          <div ref={eventsEndRef} />
        </div>
      )}
    </div>
  )
}
