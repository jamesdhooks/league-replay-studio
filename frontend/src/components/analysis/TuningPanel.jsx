import {
  Swords, Flame, RotateCcw, CircleDot, ShieldAlert, SlidersHorizontal, Info,
} from 'lucide-react'
import Tooltip from '../ui/Tooltip'

/**
 * TuningPanel — detection tuning controls for analysis phase.
 */
export default function TuningPanel({ params, onChange, horizontal = false, className = '' }) {
  const containerClass = horizontal
    ? `grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-x-8 gap-y-3 ${className}`
    : `space-y-3 ${className}`

  return (
    <div className={containerClass}>
      {/* Battle */}
      <div>
        <span className="text-xxs font-semibold text-text-primary flex items-center gap-1 mb-1.5">
          <Swords size={11} className="text-event-battle" /> Battle Detection
        </span>
        <TuneField
          label="Gap threshold (s)"
          tooltip="Maximum time gap (seconds) between two adjacent-position cars for a battle to be detected. Lower values require tighter racing. Battles must be sustained for 10+ seconds."
          value={params.battle_gap_threshold}
          onChange={v => onChange('battle_gap_threshold', v || 0.5)}
          step={0.1} min={0.1} max={5}
        />
      </div>
      {/* Crash */}
      <div>
        <span className="text-xxs font-semibold text-text-primary flex items-center gap-1 mb-1.5">
          <Flame size={11} className="text-event-incident" /> Crash Detection
        </span>
        <div className="space-y-1.5">
          <TuneField
            label="Min time loss (s)"
            tooltip="Minimum estimated time lost for an off-track excursion to qualify as a crash."
            value={params.crash_min_time_loss}
            onChange={v => onChange('crash_min_time_loss', v || 10)}
            step={1} min={1} max={60}
          />
          <TuneField
            label="Min off-track (s)"
            tooltip="Minimum duration a car must remain off-track to count as a crash."
            value={params.crash_min_off_track_duration}
            onChange={v => onChange('crash_min_off_track_duration', v || 3)}
            step={0.5} min={0.5} max={30}
          />
        </div>
      </div>
      {/* Spinout */}
      <div>
        <span className="text-xxs font-semibold text-text-primary flex items-center gap-1 mb-1.5">
          <RotateCcw size={11} className="text-event-battle" /> Spinout Detection
        </span>
        <div className="space-y-1.5">
          <TuneField
            label="Min time loss (s)"
            tooltip="Minimum time loss for an off-track moment to classify as a spinout."
            value={params.spinout_min_time_loss}
            onChange={v => onChange('spinout_min_time_loss', v || 2)}
            step={0.5} min={0.5} max={30}
          />
          <TuneField
            label="Max time loss (s)"
            tooltip="Maximum time loss for a spinout. Events above this threshold are classified as crashes."
            value={params.spinout_max_time_loss}
            onChange={v => onChange('spinout_max_time_loss', v || 10)}
            step={1} min={1} max={60}
          />
        </div>
      </div>
      {/* Contact */}
      <div>
        <span className="text-xxs font-semibold text-text-primary flex items-center gap-1 mb-1.5">
          <CircleDot size={11} className="text-event-overtake" /> Contact Detection
        </span>
        <div className="space-y-1.5">
          <TuneField
            label="Time window (s)"
            tooltip="Maximum time window for grouping multiple off-track cars as a single contact event."
            value={params.contact_time_window}
            onChange={v => onChange('contact_time_window', v || 2)}
            step={0.5} min={0.5} max={10}
          />
          <TuneField
            label="Proximity (lap%)"
            tooltip="Maximum track-position difference (fraction of lap) for two cars to be considered in contact."
            value={params.contact_proximity}
            onChange={v => onChange('contact_proximity', v || 0.05)}
            step={0.01} min={0.01} max={1}
          />
        </div>
      </div>
      {/* Close Call */}
      <div>
        <span className="text-xxs font-semibold text-text-primary flex items-center gap-1 mb-1.5">
          <ShieldAlert size={11} className="text-event-fastest" /> Close Call Detection
        </span>
        <div className="space-y-1.5">
          <TuneField
            label="Proximity (lap%)"
            tooltip="Maximum track-position difference between an off-track car and a nearby on-track car."
            value={params.close_call_proximity}
            onChange={v => onChange('close_call_proximity', v || 0.02)}
            step={0.005} min={0.005} max={0.5}
          />
          <TuneField
            label="Max off-track (s)"
            tooltip="Maximum time loss for a close call — recovery must be quick or it becomes a spinout/crash."
            value={params.close_call_max_off_track}
            onChange={v => onChange('close_call_max_off_track', v || 3)}
            step={0.5} min={0.5} max={15}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * TuneField — labelled numeric input with info-icon tooltip.
 */
export function TuneField({ label, tooltip, value, onChange, step, min, max }) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-text-secondary font-medium flex items-center gap-1 shrink-0 text-xxs">
        {label}
        {tooltip && (
          <Tooltip content={tooltip} position="top">
            <Info size={10} className="text-text-disabled hover:text-accent cursor-help transition-colors" />
          </Tooltip>
        )}
      </span>
      <input type="number" step={step} min={min} max={max}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-20 px-2 py-0.5 rounded bg-surface border border-border text-text-primary text-xxs text-right"
      />
    </label>
  )
}
