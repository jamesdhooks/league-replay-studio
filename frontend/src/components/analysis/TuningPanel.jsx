import {
  Swords, Flame, ShieldAlert,
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
        <LabeledSlider
          label="Max segment"
          tooltip="Maximum target duration for each detected battle segment. Long battles are split into balanced chunks without tiny tail clips."
          value={params.battle_max_segment ?? 45}
          onChange={v => onChange('battle_max_segment', v || 45)}
          step={5} min={15} max={120}
          format={v => `${Math.round(v)}s`}
        />
        <LabeledSlider
          label="Min duration"
          tooltip="Minimum desired duration for a battle segment. If max segment and minimum duration conflict, the detector prefers avoiding very short fragments."
          value={params.battle_min_duration ?? 10}
          onChange={v => onChange('battle_min_duration', v || 10)}
          step={5} min={5} max={30}
          format={v => `${Math.round(v)}s`}
        />
        <LabeledSlider
          label="Cluster size"
          tooltip="Maximum number of drivers allowed in a merged battle cluster. Lower values keep battles more distinct for cleaner narrative beats."
          value={params.battle_max_cluster_drivers ?? 4}
          onChange={v => onChange('battle_max_cluster_drivers', Math.round(v || 4))}
          step={1} min={2} max={6}
          format={v => `${Math.round(v)} drivers`}
        />
        <LabeledSlider
          label="Merge overlap"
          tooltip="Minimum simultaneous overlap (seconds) required before two battle segments can merge. Higher values make merge behavior stricter."
          value={params.battle_merge_min_overlap_seconds ?? 2.0}
          onChange={v => onChange('battle_merge_min_overlap_seconds', v || 2.0)}
          step={0.5} min={0.5} max={10}
          format={v => `${v.toFixed(1)}s`}
        />
        <LabeledSlider
          label="Bridge idle gap"
          tooltip="Maximum allowed idle gap (seconds) between sub-windows inside one merged cluster. Lower values prevent loose chain-merging across the field."
          value={params.battle_merge_max_idle_gap_seconds ?? 5.0}
          onChange={v => onChange('battle_merge_max_idle_gap_seconds', v || 5.0)}
          step={0.5} min={0} max={12}
          format={v => `${v.toFixed(1)}s`}
        />
        <LabeledSlider
          label="Position span"
          tooltip="Maximum race-position delta allowed when merging battles. Lower values keep merged clusters local on track and easier to direct."
          value={params.battle_merge_max_position_delta ?? 2}
          onChange={v => onChange('battle_merge_max_position_delta', Math.round(v || 2))}
          step={1} min={0} max={8}
          format={v => `+/-${Math.round(v)} pos`}
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
            tooltip="Maximum time gap (seconds) between an off-track car and a nearby on-track car. Internally converted to lap-fraction using average lap time."
            value={params.close_call_proximity_seconds ?? 2.0}
            onChange={v => onChange('close_call_proximity_seconds', v || 2.0)}
            step={0.1} min={0.2} max={8}
            format={v => `${v.toFixed(1)}s`}
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
