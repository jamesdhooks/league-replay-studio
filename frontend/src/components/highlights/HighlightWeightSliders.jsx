import { useHighlight, EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { EVENT_COLORS } from '../../context/TimelineContext'
import { Wand2, SlidersHorizontal } from 'lucide-react'

/**
 * HighlightWeightSliders — Priority sliders for each event type.
 *
 * Includes: per-type weight (0–100), minimum severity threshold, target duration,
 * and detection/camera tuning parameters.
 * Changes trigger instant reprocessing via HighlightContext.
 */
export default function HighlightWeightSliders() {
  const {
    weights, setWeight, autoBalance,
    minSeverity, setMinSeverity,
    targetDuration, setTargetDuration,
    params, setParams,
  } = useHighlight()

  const eventTypes = Object.keys(EVENT_TYPE_LABELS)

  return (
    <div className="p-3 space-y-3">
      {/* Event type weights */}
      <div className="space-y-2">
        <h4 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">
          Event Priorities
        </h4>
        {eventTypes.map(type => {
          const color = EVENT_COLORS[type] || '#666'
          const label = EVENT_TYPE_LABELS[type]
          const value = weights[type] ?? 50

          return (
            <div key={type} className="flex items-center gap-2">
              <div
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: color }}
              />
              <span className="text-xxs text-text-secondary w-16 truncate" title={label}>
                {label}
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={value}
                onChange={(e) => setWeight(type, parseInt(e.target.value, 10))}
                className="flex-1 h-1 accent-accent cursor-pointer"
                style={{ accentColor: color }}
              />
              <span className="text-xxs text-text-tertiary font-mono w-7 text-right">
                {value}
              </span>
            </div>
          )
        })}

        {/* Auto-balance button */}
        <button
          onClick={autoBalance}
          className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xxs font-medium
                     text-accent bg-accent/10 hover:bg-accent/20 rounded transition-colors"
        >
          <Wand2 className="w-3 h-3" />
          Auto-balance weights
        </button>
      </div>

      {/* Minimum score threshold */}
      <div className="pt-2 border-t border-border-subtle space-y-1.5">
        <h4 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">
          Minimum Score
        </h4>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={10}
            value={minSeverity}
            onChange={(e) => setMinSeverity(parseInt(e.target.value, 10))}
            className="flex-1 h-1 accent-accent cursor-pointer"
          />
          <span className="text-xxs text-text-tertiary font-mono w-5 text-right">
            {minSeverity}
          </span>
        </div>
      </div>

      {/* Target duration */}
      <div className="pt-2 border-t border-border-subtle space-y-1.5">
        <h4 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">
          Target Duration
        </h4>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            step={10}
            value={targetDuration || ''}
            onChange={(e) => {
              const v = e.target.value ? parseFloat(e.target.value) : null
              setTargetDuration(v)
            }}
            placeholder="No limit"
            className="flex-1 px-2 py-1 text-xs bg-bg-primary border border-border rounded
                       text-text-primary placeholder:text-text-disabled
                       focus:outline-none focus:border-accent"
          />
          <span className="text-xxs text-text-tertiary">sec</span>
        </div>
      </div>

      {/* Direction & Camera Tuning */}
      <div className="pt-2 border-t border-border-subtle space-y-2">
        <div className="flex items-center gap-1.5">
          <SlidersHorizontal className="w-3 h-3 text-text-tertiary" />
          <h4 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">
            Direction Tuning
          </h4>
        </div>

        {/* Battle sticky period */}
        <ParamSlider
          label="Battle Hold"
          tooltip="Seconds to follow one battle before switching cameras"
          value={params.battleStickyPeriod}
          min={30} max={300} step={10}
          format={v => `${v}s`}
          onChange={v => setParams(p => ({ ...p, battleStickyPeriod: v }))}
        />

        {/* Camera sticky period */}
        <ParamSlider
          label="Camera Hold"
          tooltip="Seconds to hold one camera angle before rotating to another"
          value={params.cameraStickyPeriod}
          min={5} max={60} step={5}
          format={v => `${v}s`}
          onChange={v => setParams(p => ({ ...p, cameraStickyPeriod: v }))}
        />

        {/* Overtake boost */}
        <ParamSlider
          label="Overtake Boost"
          tooltip="Score multiplier applied to events involving a position change"
          value={params.overtakeBoost}
          min={1.0} max={3.0} step={0.1}
          format={v => `${v.toFixed(1)}×`}
          onChange={v => setParams(p => ({ ...p, overtakeBoost: v }))}
        />

        {/* Incident position cutoff */}
        <ParamSlider
          label="Incident Pos Cutoff"
          tooltip="Ignore incidents from cars ranked below this position (0 = include all)"
          value={params.incidentPositionCutoff}
          min={0} max={40} step={1}
          format={v => v === 0 ? 'Off' : `P${v}+`}
          onChange={v => setParams(p => ({ ...p, incidentPositionCutoff: v }))}
        />

        {/* Preferred driver boost */}
        <ParamSlider
          label="Driver Boost"
          tooltip="Score multiplier for events featuring preferred drivers"
          value={params.preferredDriverBoost}
          min={1.0} max={3.0} step={0.1}
          format={v => `${v.toFixed(1)}×`}
          onChange={v => setParams(p => ({ ...p, preferredDriverBoost: v }))}
        />

        {/* Preferred drivers input */}
        <div>
          <span className="text-xxs text-text-secondary block mb-0.5">Preferred Drivers</span>
          <input
            type="text"
            value={params.preferredDrivers}
            onChange={(e) => setParams(p => ({ ...p, preferredDrivers: e.target.value }))}
            placeholder="Name1, Name2, ..."
            className="w-full px-2 py-1 text-xxs bg-bg-primary border border-border rounded
                       text-text-primary placeholder:text-text-disabled
                       focus:outline-none focus:border-accent"
          />
        </div>
      </div>

    </div>
  )
}


/**
 * Reusable slider row for detection tuning parameters.
 */
function ParamSlider({ label, tooltip, value, min, max, step, format, onChange }) {
  return (
    <div className="flex items-center gap-2" title={tooltip}>
      <span className="text-xxs text-text-secondary shrink-0" style={{ minWidth: '7rem' }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 h-1 accent-accent cursor-pointer"
      />
      <span className="text-xxs text-text-tertiary font-mono shrink-0" style={{ minWidth: '3rem', textAlign: 'right' }}>
        {format(value)}
      </span>
    </div>
  )
}
