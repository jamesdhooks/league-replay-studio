import {
  Swords, Flame, ShieldAlert, AlertTriangle,
} from 'lucide-react'
import LabeledSlider from '../ui/LabeledSlider'

/**
 * TuningPanel — detection tuning controls for analysis phase.
 */
export default function TuningPanel({ params, onChange, horizontal = false, className = '' }) {
  const containerClass = horizontal
    ? `grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-x-8 gap-y-4 ${className}`
    : `space-y-4 ${className}`

  return (
    <div className={containerClass}>
      {/* Incident clip window */}
      <div>
        <span className="text-xxs font-semibold text-text-primary flex items-center gap-1 mb-1.5">
          <AlertTriangle size={11} className="text-event-incident" /> Incident Clip Window
        </span>
        <div className="space-y-2.5">
          <LabeledSlider
            label="Lead-in"
            tooltip="Seconds of footage to include before the incident moment. More lead-in captures the build-up."
            value={params.incident_lead_in ?? 2.0}
            onChange={v => onChange('incident_lead_in', v || 2.0)}
            step={0.5} min={0.5} max={10}
            format={v => `${v.toFixed(1)}s`}
          />
          <LabeledSlider
            label="Follow-out"
            tooltip="Seconds of footage to include after the incident moment. More follow-out shows the recovery."
            value={params.incident_follow_out ?? 8.0}
            onChange={v => onChange('incident_follow_out', v || 8.0)}
            step={0.5} min={2} max={30}
            format={v => `${v.toFixed(1)}s`}
          />
        </div>
      </div>
      {/* Battle */}
      <div>
        <span className="text-xxs font-semibold text-text-primary flex items-center gap-1 mb-1.5">
          <Swords size={11} className="text-event-battle" /> Battle Detection
        </span>
        <LabeledSlider
          label="Gap threshold"
          tooltip="Maximum time gap (seconds) between two adjacent-position cars for a battle to be detected. Lower values require tighter racing. Battles must be sustained for 10+ seconds."
          value={params.battle_gap_threshold ?? 0.5}
          onChange={v => onChange('battle_gap_threshold', v || 0.5)}
          step={0.1} min={0.1} max={5}
          format={v => `${v.toFixed(1)}s`}
        />
      </div>
      {/* Close Call */}
      <div>
        <span className="text-xxs font-semibold text-text-primary flex items-center gap-1 mb-1.5">
          <ShieldAlert size={11} className="text-event-fastest" /> Close Call Detection
        </span>
        <div className="space-y-2.5">
          <LabeledSlider
            label="Proximity"
            tooltip="Maximum track-position gap (fraction of lap) between an off-track car and a nearby on-track car."
            value={params.close_call_proximity_pct ?? 0.02}
            onChange={v => onChange('close_call_proximity_pct', v || 0.02)}
            step={0.005} min={0.005} max={0.5}
            format={v => `${(v * 100).toFixed(1)}%`}
          />
          <LabeledSlider
            label="Max time loss"
            tooltip="Maximum estimated time loss (seconds) during the off-track frame. Only single-frame excursions where the car immediately returns on-track qualify — higher values allow slower recoveries to still count as close calls."
            value={params.close_call_max_time_loss ?? 2.0}
            onChange={v => onChange('close_call_max_time_loss', v || 2.0)}
            step={0.5} min={0.5} max={15}
            format={v => `${v.toFixed(1)}s`}
          />
        </div>
      </div>
    </div>
  )
}
