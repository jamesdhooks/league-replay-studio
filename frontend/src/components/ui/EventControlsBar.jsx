import { SkipBack, Check, X, Film, Minus, Users, Repeat, BarChart3, Clock } from 'lucide-react'
import { EVENT_CONFIG, formatTime } from '../analysis/analysisConstants'
import { EVENT_COLORS } from '../../context/TimelineContext'

/**
 * EventControlsBar — Reusable event controls component.
 * 
 * Displays event information and provides unified controls for:
 * - Seeking to event start
 * - Toggling event override (highlight/full-video/exclude/auto)
 * - Switching driver POV
 * - Auto-loop toggling
 * - Closing focused event
 * 
 * Used in both analysis PlaybackTimeline and inspector EventPreviewControls.
 * 
 * @param {Object} props
 * @param {Object} props.event - Event object with id, event_type, start_time_seconds, etc.
 * @param {number} props.raceStart - Race start time (seconds) for relative time display
 * @param {number} props.raceDuration - Full race duration for context
 * @param {Object} props.replayState - Current replay state with cam_car_idx, session_time
 * @param {Function} props.onSeekToEvent - Callback to seek to event start
 * @param {Function} props.onToggleOverride - Callback to toggle event override
 * @param {Function} props.onSwitchDriver - Callback to switch POV (carIdx)
 * @param {Function} props.onToggleAutoLoop - Callback to toggle auto-loop
 * @param {Function} props.onClose - Callback to close/unfocus event
 * @param {Object} props.overrides - Map of event ID to override state
 * @param {boolean} props.autoLoop - Whether auto-loop is enabled
 * @param {boolean} props.isSeeking - Whether currently seeking
 * @param {string} props.className - Additional CSS classes for wrapper
 * @param {boolean} props.showClose - Whether to show close button (default: true)
 * @param {boolean} props.compact - Compact layout mode (default: false)
 * @param {'sidebar'|'timeline'} props.theme - Color theme: 'sidebar' or 'timeline' (default: 'sidebar')
 */
export default function EventControlsBar({
  event,
  raceStart = 0,
  raceDuration = 0,
  replayState = null,
  onSeekToEvent = () => {},
  onToggleOverride = () => {},
  onSwitchDriver = () => {},
  onToggleAutoLoop = () => {},
  onClose = () => {},
  overrides = {},
  autoLoop = false,
  isSeeking = false,
  className = '',
  showClose = true,
  compact = false,
  theme = 'sidebar',
}) {
  if (!event) return null

  const cfg = EVENT_CONFIG[event.event_type] || {}
  const EvIcon = cfg.icon || BarChart3
  const names = event.driver_names || []
  const evDrivers = (event.involved_drivers || []).slice(0, 5)
  const ov = overrides[String(event.id)] || null
  const evStartRel = formatTime(Math.max(0, event.start_time_seconds - raceStart))
  const evEndRel = formatTime(Math.max(0, event.end_time_seconds - raceStart))
  const evDuration = Math.max(0, event.end_time_seconds - event.start_time_seconds)

  const baseClass = compact
    ? 'flex items-center gap-1.5 flex-wrap'
    : 'flex items-center gap-2 flex-wrap'

  const isTimelineTheme = theme === 'timeline'

  const iconSize = compact ? 10 : 12
  const buttonSize = compact ? 'text-xxs' : 'text-xs'
  const buttonPadding = compact ? 'px-1 py-0.5' : 'px-1.5 py-0.5'

  // Theme-aware styling
  const buttonBaseClass = isTimelineTheme
    ? 'bg-white/10 hover:bg-white/20 text-white/80 border border-white/15'
    : 'bg-bg-primary hover:bg-bg-hover text-text-secondary hover:text-text-primary border border-border'
  
  const buttonActiveClass = isTimelineTheme
    ? 'bg-accent/25 text-accent border-accent/40'
    : 'bg-accent/25 text-accent border-accent/40'

  const textSecondaryClass = isTimelineTheme ? 'text-white/40' : 'text-text-secondary'
  const textTertiaryClass = isTimelineTheme ? 'text-white/30' : 'text-text-tertiary'
  const textPrimaryClass = isTimelineTheme ? 'text-white' : 'text-text-primary'
  const iconColorClass = isTimelineTheme ? `${cfg.color || 'text-white/70'}` : cfg.color || 'text-text-primary'

  return (
    <div className={`${baseClass} ${className}`}>
      {/* Event info header */}
      <EvIcon size={iconSize} className={`shrink-0 ${iconColorClass}`} />
      <span className={`${compact ? 'text-xxs' : 'text-xs'} font-semibold ${textPrimaryClass} shrink-0`}>
        {cfg.label || event.event_type}
      </span>

      {!compact && names.length > 0 && (
        <span className={`text-xxs ${textSecondaryClass} shrink-0`}>{names.join(' · ')}</span>
      )}

      <span className={`flex items-center gap-1 ${buttonSize} ${textTertiaryClass} font-mono shrink-0`}>
        <Clock size={compact ? 7 : 9} />
        {evStartRel} – {evEndRel} ({evDuration.toFixed(1)}s)
      </span>

      {event.severity != null && (
        <span className={`${buttonSize} ${textTertiaryClass} font-mono shrink-0`}>
          Severity {event.severity}
        </span>
      )}

      {/* Control buttons */}
      <button
        onClick={() => onSeekToEvent(event)}
        disabled={isSeeking}
        className={`flex items-center gap-1 rounded ${buttonPadding} ${buttonSize} ${buttonBaseClass} transition-colors disabled:opacity-40 shrink-0`}
        title="Seek to event start"
      >
        <SkipBack size={compact ? 8 : 9} />
        {!compact && <span>{isTimelineTheme ? 'Rewind' : 'Seek'}</span>}
      </button>

      <button
        onClick={() => onToggleOverride(event.id)}
        className={`flex items-center gap-1 rounded ${buttonPadding} ${buttonSize} border transition-colors shrink-0
          ${ov === 'highlight' ? 'bg-success/25 text-success border-success/40'
            : ov === 'full-video' ? 'bg-info/25 text-info border-info/40'
            : ov === 'exclude' ? 'bg-danger/25 text-danger border-danger/40'
            : buttonBaseClass}`}
        title={ov ? `Override: ${ov}` : 'Auto'}
      >
        {ov === 'highlight' && <><Check size={compact ? 7 : 8} /> {!compact && 'Incl'}</>}
        {ov === 'full-video' && <><Film size={compact ? 7 : 8} /> {!compact && 'Full'}</>}
        {ov === 'exclude' && <><X size={compact ? 7 : 8} /> {!compact && 'Excl'}</>}
        {!ov && <><Minus size={compact ? 7 : 8} /> {!compact && 'Auto'}</>}
      </button>

      {/* Driver POV buttons */}
      {evDrivers.map((carIdx, i) => {
        const name = names[i] || `Car ${carIdx}`
        const isActive = replayState?.cam_car_idx === carIdx
        return (
          <button
            key={carIdx}
            onClick={() => onSwitchDriver(carIdx)}
            className={`flex items-center gap-1 rounded ${buttonPadding} ${buttonSize} border transition-colors shrink-0
              ${isActive ? buttonActiveClass : buttonBaseClass}`}
            title={`Switch to ${name}'s POV`}
          >
            <Users size={compact ? 7 : 8} />
            {!compact && <span>{name}</span>}
            {compact && <span className="text-xxs">{carIdx}</span>}
          </button>
        )
      })}

      {/* Auto-loop button */}
      <button
        onClick={() => onToggleAutoLoop()}
        className={`flex items-center gap-1 rounded ${buttonPadding} ${buttonSize} border transition-colors shrink-0
          ${autoLoop ? buttonActiveClass : buttonBaseClass}`}
        title={autoLoop ? 'Auto-loop enabled' : 'Enable auto-loop'}
      >
        <Repeat size={compact ? 7 : 8} />
        {!compact && <span>Loop</span>}
      </button>

      {/* Close button */}
      {showClose && (
        <button
          onClick={() => onClose()}
          className={`${compact ? 'ml-auto' : ''} flex items-center gap-1 rounded ${buttonPadding} ${buttonSize} ${buttonBaseClass} transition-colors shrink-0`}
          title="Close"
        >
          {!compact && <span>Close</span>}
          <X size={compact ? 8 : 10} />
        </button>
      )}
    </div>
  )
}
