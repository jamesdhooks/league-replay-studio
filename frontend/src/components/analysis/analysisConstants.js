import {
  AlertTriangle, Swords, ArrowUpDown, Fuel, Zap, Crown, Flag, FlagTriangleRight,
  Flame, RotateCcw, CircleDot, ShieldAlert, CarFront,
} from 'lucide-react'

/**
 * Event type display configuration — icons, labels, and colors.
 */
export const EVENT_CONFIG = {
  incident:      { icon: AlertTriangle,     label: 'Incident',         color: 'text-event-incident',  bg: 'bg-event-incident/10' },
  battle:        { icon: Swords,            label: 'Battle',           color: 'text-event-battle',    bg: 'bg-event-battle/10' },
  overtake:      { icon: ArrowUpDown,       label: 'Overtake',         color: 'text-event-overtake',  bg: 'bg-event-overtake/10' },
  pit_stop:      { icon: Fuel,              label: 'Pit Stop',         color: 'text-event-pit',       bg: 'bg-event-pit/10' },
  fastest_lap:   { icon: Zap,              label: 'Fastest Lap',      color: 'text-event-fastest',   bg: 'bg-event-fastest/10' },
  leader_change: { icon: Crown,            label: 'Leader Change',    color: 'text-event-leader',    bg: 'bg-event-leader/10' },
  pace_lap:      { icon: CarFront,         label: 'Pace Lap',         color: 'text-event-firstlap',  bg: 'bg-event-firstlap/10' },
  first_lap:     { icon: FlagTriangleRight, label: 'First Lap',       color: 'text-event-firstlap',  bg: 'bg-event-firstlap/10' },
  last_lap:      { icon: Flag,             label: 'Last Lap',         color: 'text-event-lastlap',   bg: 'bg-event-lastlap/10' },
  car_contact:   { icon: Flame,            label: 'Car Contact',      color: 'text-event-incident',  bg: 'bg-event-incident/10' },
  contact:       { icon: CircleDot,        label: 'Contact',          color: 'text-event-battle',    bg: 'bg-event-battle/10' },
  lost_control:  { icon: RotateCcw,        label: 'Lost Control',     color: 'text-event-battle',    bg: 'bg-event-battle/10' },
  off_track:     { icon: ShieldAlert,      label: 'Off Track',        color: 'text-event-fastest',   bg: 'bg-event-fastest/10' },
  turn_cutting:  { icon: ShieldAlert,      label: 'Turn Cutting',     color: 'text-event-fastest',   bg: 'bg-event-fastest/10' },
  crash:         { icon: Flame,            label: 'Crash',            color: 'text-event-incident',  bg: 'bg-event-incident/10' },
  spinout:       { icon: RotateCcw,        label: 'Spinout',          color: 'text-event-battle',    bg: 'bg-event-battle/10' },
  close_call:    { icon: ShieldAlert,      label: 'Close Call',       color: 'text-event-fastest',   bg: 'bg-event-fastest/10' },
  undercut:      { icon: ArrowUpDown,      label: 'Undercut',         color: 'text-event-pit',       bg: 'bg-event-pit/10' },
  overcut:       { icon: ArrowUpDown,      label: 'Overcut',          color: 'text-event-pit',       bg: 'bg-event-pit/10' },
  pit_battle:    { icon: Fuel,             label: 'Pit Battle',       color: 'text-event-battle',    bg: 'bg-event-battle/10' },
  race_start:    { icon: Flag,             label: 'Race Start',       color: 'text-event-firstlap',  bg: 'bg-event-firstlap/10' },
  race_finish:   { icon: FlagTriangleRight, label: 'Race Finish',     color: 'text-event-lastlap',   bg: 'bg-event-lastlap/10' },
}

/** Format seconds as M:SS */
export function formatTime(seconds) {
  if (seconds === null || seconds === undefined || seconds < 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Score-based badge color (hex) */
export function scoreColor(score) {
  if (score >= 8) return '#ef4444'
  if (score >= 6) return '#f97316'
  if (score >= 4) return '#3b82f6'
  return '#6b7280'
}

/** Severity badge color (Tailwind classes) */
export function severityColor(severity) {
  if (severity >= 8) return 'bg-danger/20 text-danger'
  if (severity >= 6) return 'bg-warning/20 text-warning'
  if (severity >= 4) return 'bg-accent/20 text-accent'
  return 'bg-surface-active text-text-tertiary'
}

/** Severity colors for overlay cards (on dark backgrounds) */
export function severityColorCard(severity) {
  if (severity >= 8) return 'bg-danger text-white'
  if (severity >= 6) return 'bg-warning text-black'
  if (severity >= 4) return 'bg-accent text-white'
  return 'bg-white/20 text-white'
}
