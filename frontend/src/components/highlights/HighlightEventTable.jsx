import { useHighlight, EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { EVENT_COLORS } from '../../context/TimelineContext'
import { formatTime } from '../../utils/time'
import {
  ArrowUpDown, ArrowUp, ArrowDown,
  Check, X, Minus, Film, ChevronDown,
} from 'lucide-react'

/**
 * HighlightEventTable — Sortable, filterable event selection table.
 *
 * Columns: Override, Score, Severity, Duration, Type, Time, Reason.
 * Manual override checkboxes cycle: auto → force-include → force-exclude → auto.
 * Clicking a row jumps the timeline playhead to that event.
 */
export default function HighlightEventTable() {
  const {
    filteredEvents, toggleOverride, jumpToEvent,
    sortColumn, sortDirection, handleSort,
    filterType, setFilterType,
    filterInclusion, setFilterInclusion,
  } = useHighlight()

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Filter bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-bg-secondary shrink-0">
        <span className="text-xxs text-text-tertiary">Filter:</span>

        {/* Type filter */}
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="text-xxs bg-bg-primary border border-border rounded px-1.5 py-0.5
                     text-text-primary focus:outline-none focus:border-accent"
        >
          <option value="">All types</option>
          {Object.entries(EVENT_TYPE_LABELS).map(([type, label]) => (
            <option key={type} value={type}>{label}</option>
          ))}
        </select>

        {/* Inclusion filter */}
        <select
          value={filterInclusion}
          onChange={(e) => setFilterInclusion(e.target.value)}
          className="text-xxs bg-bg-primary border border-border rounded px-1.5 py-0.5
                     text-text-primary focus:outline-none focus:border-accent"
        >
          <option value="">All events</option>
          <option value="highlight">Highlight</option>
          <option value="full-video">Full-video</option>
          <option value="excluded">Excluded</option>
        </select>

        <span className="flex-1" />
        <span className="text-xxs text-text-disabled">
          {filteredEvents.length} events
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xxs">
          <thead className="sticky top-0 bg-bg-secondary z-10">
            <tr className="border-b border-border">
              <th className="w-8 px-1 py-1.5 text-center text-text-tertiary font-medium">✓</th>
              <th className="w-8 px-1 py-1.5 text-center text-text-tertiary font-medium">Tier</th>
              <SortableHeader column="score" label="Score" current={sortColumn} direction={sortDirection} onSort={handleSort} />
              <SortableHeader column="severity" label="Sev" current={sortColumn} direction={sortDirection} onSort={handleSort} />
              <SortableHeader column="duration" label="Dur" current={sortColumn} direction={sortDirection} onSort={handleSort} />
              <SortableHeader column="type" label="Type" current={sortColumn} direction={sortDirection} onSort={handleSort} />
              <SortableHeader column="time" label="Time" current={sortColumn} direction={sortDirection} onSort={handleSort} />
              <th className="px-2 py-1.5 text-left text-text-tertiary font-medium">Reason</th>
            </tr>
          </thead>
          <tbody>
            {filteredEvents.map(evt => {
              const override = evt.override || null
              const color = EVENT_COLORS[evt.event_type] || '#666'
              const isOverridden = override !== null

              return (
                <tr
                  key={evt.id}
                  onClick={() => jumpToEvent(evt)}
                  className={`border-b border-border-subtle cursor-pointer transition-colors
                    ${evt.inclusion === 'highlight'
                      ? isOverridden
                        ? 'bg-accent/5 hover:bg-accent/10'
                        : 'hover:bg-bg-hover'
                      : evt.inclusion === 'full-video'
                        ? isOverridden
                          ? 'bg-info/5 hover:bg-info/10 opacity-70'
                          : 'opacity-60 hover:opacity-80'
                        : isOverridden
                          ? 'bg-danger/5 hover:bg-danger/10 opacity-50'
                          : 'opacity-30 hover:opacity-50'
                    }`}
                >
                  {/* Override checkbox */}
                  <td className="px-1 py-1 text-center">
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleOverride(evt.id) }}
                      className={`w-4 h-4 rounded border flex items-center justify-center transition-colors
                        ${override === 'highlight'
                          ? 'bg-success border-success text-white'
                          : override === 'full-video'
                            ? 'bg-info border-info text-white'
                            : override === 'exclude'
                              ? 'bg-danger border-danger text-white'
                              : evt.inclusion === 'highlight'
                                ? 'border-border-subtle text-success'
                                : evt.inclusion === 'full-video'
                                  ? 'border-border-subtle text-info'
                                  : 'border-border-subtle text-text-disabled'
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
                      {!override && evt.inclusion === 'highlight' && <Minus className="w-2.5 h-2.5" />}
                      {!override && evt.inclusion === 'full-video' && <Film className="w-2 h-2 opacity-50" />}
                    </button>
                  </td>

                  {/* Tier badge */}
                  <td className="px-1 py-1 text-center">
                    <span
                      className="inline-block w-5 h-5 rounded text-white font-bold flex items-center justify-center"
                      style={{ backgroundColor: tierColor(evt.tier), fontSize: '9px' }}
                      title={`Tier ${evt.tier}${evt.bucket ? ` (${evt.bucket})` : ''}`}
                    >
                      {evt.tier || '-'}
                    </span>
                  </td>

                  {/* Score */}
                  <td className="px-2 py-1 font-mono text-text-primary text-right">
                    {evt.score}
                  </td>

                  {/* Severity */}
                  <td className="px-2 py-1 text-center">
                    <span
                      className="inline-block px-1 py-0.5 rounded text-white font-medium"
                      style={{ backgroundColor: severityColor(evt.severity), fontSize: '9px' }}
                    >
                      {evt.severity}
                    </span>
                  </td>

                  {/* Duration */}
                  <td className="px-2 py-1 font-mono text-text-secondary text-right">
                    {evt.duration.toFixed(1)}s
                  </td>

                  {/* Type */}
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-1">
                      <div
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: color }}
                      />
                      <span className="text-text-primary truncate">
                        {EVENT_TYPE_LABELS[evt.event_type] || evt.event_type}
                      </span>
                    </div>
                  </td>

                  {/* Time */}
                  <td className="px-2 py-1 font-mono text-text-secondary">
                    {formatTime(evt.start_time_seconds)}
                  </td>

                  {/* Reason */}
                  <td className="px-2 py-1 text-text-tertiary truncate max-w-[120px]" title={evt.reason}>
                    {evt.reason}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {filteredEvents.length === 0 && (
          <div className="flex items-center justify-center py-8 text-text-disabled text-xs">
            No events match current filters
          </div>
        )}
      </div>
    </div>
  )
}


/** Sortable column header */
function SortableHeader({ column, label, current, direction, onSort }) {
  const isActive = current === column
  return (
    <th
      className="px-2 py-1.5 text-left text-text-tertiary font-medium cursor-pointer
                 hover:text-text-primary select-none"
      onClick={() => onSort(column)}
    >
      <div className="flex items-center gap-0.5">
        {label}
        {isActive ? (
          direction === 'asc' ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />
        ) : (
          <ArrowUpDown className="w-2.5 h-2.5 opacity-30" />
        )}
      </div>
    </th>
  )
}


/** Map severity to color */
function severityColor(severity) {
  if (severity >= 8) return '#ef4444'
  if (severity >= 6) return '#f97316'
  if (severity >= 4) return '#eab308'
  if (severity >= 2) return '#22c55e'
  return '#6b7280'
}

/** Map tier to color (S/A/B/C) */
function tierColor(tier) {
  switch (tier) {
    case 'S': return '#ef4444'  // Red — must-have
    case 'A': return '#f97316'  // Orange — high priority
    case 'B': return '#3b82f6'  // Blue — medium priority
    case 'C': return '#6b7280'  // Gray — low priority
    default:  return '#6b7280'
  }
}
