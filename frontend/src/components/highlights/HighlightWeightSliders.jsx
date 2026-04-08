import { useState, useMemo } from 'react'
import { useHighlight, EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { EVENT_COLORS } from '../../context/TimelineContext'
import { Wand2, SlidersHorizontal, ChevronDown, ChevronRight, Info } from 'lucide-react'
import Tooltip from '../ui/Tooltip'

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

  const [collapsed, setCollapsed] = useState({})
  const toggle = (key) => setCollapsed(p => ({ ...p, [key]: !p[key] }))

  return (
    <div className="p-3 space-y-3">
      {/* Event type weights */}
      <div className="space-y-2">
        <button
          onClick={() => toggle('priorities')}
          className="flex items-center gap-1 w-full text-left"
        >
          {collapsed.priorities ? <ChevronRight className="w-3 h-3 text-text-tertiary" /> : <ChevronDown className="w-3 h-3 text-text-tertiary" />}
          <h4 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">
            Event Priorities
          </h4>
        </button>
        {!collapsed.priorities && (
          <>
            {eventTypes.map(type => {
          const color = EVENT_COLORS[type] || '#666'
          const label = EVENT_TYPE_LABELS[type]
          const value = weights[type] ?? 50
          const isDisabled = value === 0

          return (
            <div key={type} className={`flex items-center gap-2 ${isDisabled ? 'opacity-40' : ''}`}>
              <button
                className="w-3 h-3 rounded-full shrink-0 border border-white/20 hover:scale-125 transition-transform"
                style={{ backgroundColor: isDisabled ? '#444' : color }}
                onClick={() => setWeight(type, isDisabled ? 50 : 0)}
                title={isDisabled ? `Enable ${label}` : `Disable ${label}`}
              />
              <span className={`text-xxs w-16 truncate ${isDisabled ? 'text-text-disabled line-through' : 'text-text-secondary'}`} title={label}>
                {label}
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={value}
                onChange={(e) => setWeight(type, parseInt(e.target.value, 10))}
                className="flex-1 h-1 accent-accent cursor-pointer"
                style={{ accentColor: isDisabled ? '#555' : color }}
                disabled={isDisabled}
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
          </>
        )}
      </div>

      {/* Minimum score threshold */}
      <div className="pt-2 border-t border-border-subtle space-y-1.5">
        <button
          onClick={() => toggle('minScore')}
          className="flex items-center gap-1 w-full text-left"
        >
          {collapsed.minScore ? <ChevronRight className="w-3 h-3 text-text-tertiary" /> : <ChevronDown className="w-3 h-3 text-text-tertiary" />}
          <h4 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">
            Minimum Score
          </h4>
        </button>
        {!collapsed.minScore && (
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
        )}
      </div>

      {/* Target duration */}
      <div className="pt-2 border-t border-border-subtle space-y-1.5">
        <button
          onClick={() => toggle('duration')}
          className="flex items-center gap-1 w-full text-left"
        >
          {collapsed.duration ? <ChevronRight className="w-3 h-3 text-text-tertiary" /> : <ChevronDown className="w-3 h-3 text-text-tertiary" />}
          <h4 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">
            Target Duration
          </h4>
        </button>
        {!collapsed.duration && (
          <ParamSlider
            label="Highlight Length"
            tooltip="Target duration of the final highlight video — shorter means stricter event selection (0 = no limit)"
            value={targetDuration ? Math.round(targetDuration / 60) : 0}
            min={0} max={30} step={1}
            format={v => v === 0 ? 'No limit' : `${v} min`}
            onChange={v => setTargetDuration(v === 0 ? null : v * 60)}
          />
        )}
      </div>

      {/* Direction & Camera Tuning */}
      <div className="pt-2 border-t border-border-subtle space-y-2">
        <button
          onClick={() => toggle('direction')}
          className="flex items-center gap-1.5 w-full text-left"
        >
          {collapsed.direction ? <ChevronRight className="w-3 h-3 text-text-tertiary" /> : <ChevronDown className="w-3 h-3 text-text-tertiary" />}
          <SlidersHorizontal className="w-3 h-3 text-text-tertiary" />
          <h4 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">
            Direction Tuning
          </h4>
        </button>

        {!collapsed.direction && (
          <>
            {/* Battle sticky period */}
        <ParamSlider
          label="Battle Hold"
          tooltip="Seconds to follow one battle before switching cameras"
          value={params.battleStickyPeriod}
          min={5} max={30} step={5}
          format={v => `${v}s`}
          onChange={v => setParams(p => ({ ...p, battleStickyPeriod: v }))}
        />

        {/* Battle gap threshold */}
        <ParamSlider
          label="Battle Gap"
          tooltip="Max estimated-time gap between adjacent cars to qualify as a battle"
          value={params.battleGap}
          min={0.3} max={3.0} step={0.1}
          format={v => `${v.toFixed(1)}s`}
          onChange={v => setParams(p => ({ ...p, battleGap: v }))}
        />

        {/* Battle front bias */}
        <ParamSlider
          label="Front Bias"
          tooltip="Extra score boost for front-of-field battles over mid-pack — inspired by iRacingReplayDirector BattleFactor"
          value={params.battleFrontBias}
          min={1.0} max={2.5} step={0.1}
          format={v => `${v.toFixed(1)}×`}
          onChange={v => setParams(p => ({ ...p, battleFrontBias: v }))}
        />

        {/* Camera sticky period */}
        <ParamSlider
          label="Camera Hold"
          tooltip="Seconds to hold one camera angle before rotating to another"
          value={params.cameraStickyPeriod}
          min={5} max={30} step={5}
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

        {/* Ignore first-lap incidents toggle */}
        <ParamToggle
          label="Skip 1st Lap Incidents"
          tooltip="Exclude crash/incident/spinout events detected during the first 15% of the race"
          value={params.ignoreIncidentsDuringFirstLap}
          onChange={v => setParams(p => ({ ...p, ignoreIncidentsDuringFirstLap: v }))}
        />

        {/* Race phase boost — first lap */}
        <ParamSlider
          label="First Lap Boost"
          tooltip="Score multiplier for events within the First Lap Window"
          value={params.firstLapWeight}
          min={0.5} max={3.0} step={0.1}
          format={v => `${v.toFixed(1)}×`}
          onChange={v => setParams(p => ({ ...p, firstLapWeight: v }))}
        />

        <ParamSlider
          label="First Lap Window"
          tooltip="Seconds from race start during which First Lap Boost applies (0 = off)"
          value={params.firstLapStickyPeriod}
          min={0} max={120} step={10}
          format={v => v === 0 ? 'Off' : `${v}s`}
          onChange={v => setParams(p => ({ ...p, firstLapStickyPeriod: v }))}
        />

        {/* Race phase boost — last lap */}
        <ParamSlider
          label="Last Lap Boost"
          tooltip="Score multiplier for events within the Last Lap Window"
          value={params.lastLapWeight}
          min={0.5} max={3.0} step={0.1}
          format={v => `${v.toFixed(1)}×`}
          onChange={v => setParams(p => ({ ...p, lastLapWeight: v }))}
        />

        <ParamSlider
          label="Last Lap Window"
          tooltip="Seconds before race end during which Last Lap Boost applies (0 = off)"
          value={params.lastLapStickyPeriod}
          min={0} max={120} step={10}
          format={v => v === 0 ? 'Off' : `${v}s`}
          onChange={v => setParams(p => ({ ...p, lastLapStickyPeriod: v }))}
        />

        {/* Late race bonus */}
        <ParamSlider
          label="Late Race At"
          tooltip="Race fraction (0–1) after which the late-race score bonus activates"
          value={params.lateRaceThreshold}
          min={0.5} max={0.95} step={0.05}
          format={v => `${Math.round(v * 100)}%`}
          onChange={v => setParams(p => ({ ...p, lateRaceThreshold: v }))}
        />

        <ParamSlider
          label="Late Race Boost"
          tooltip="Score multiplier applied to all events beyond the Late Race threshold"
          value={params.lateRaceMultiplier}
          min={1.0} max={2.0} step={0.1}
          format={v => `${v.toFixed(1)}×`}
          onChange={v => setParams(p => ({ ...p, lateRaceMultiplier: v }))}
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

        {/* Preferred-driver exclusive mode toggle */}
        <ParamToggle
          label="Preferred Only"
          tooltip="When on, only events featuring preferred drivers are included (mandatory events always kept)"
          value={params.preferredDriversOnly}
          onChange={v => setParams(p => ({ ...p, preferredDriversOnly: v }))}
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

        {/* PiP threshold */}
        <ParamSlider
          label="PiP Threshold"
          tooltip="Minimum score for two overlapping events to be shown in Picture-in-Picture instead of one being dropped"
          value={params.pipThreshold}
          min={5} max={10} step={0.5}
          format={v => v.toFixed(1)}
          onChange={v => setParams(p => ({ ...p, pipThreshold: v }))}
        />
          </>
        )}
      </div>

    </div>
  )
}


/**
 * Reusable toggle row for boolean detection tuning parameters.
 */
function ParamToggle({ label, tooltip, value, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <Tooltip content={tooltip} position="top" delay={200}>
        <span className="text-xxs text-text-secondary shrink-0 flex items-center gap-1 cursor-help" style={{ minWidth: '7rem' }}>
          {label}
          <Info className="w-3 h-3 text-text-disabled shrink-0" />
        </span>
      </Tooltip>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full
                    border transition-colors focus:outline-none
                    ${value ? 'bg-accent border-accent' : 'bg-bg-tertiary border-border'}`}
      >
        <span
          className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform
                      ${value ? 'translate-x-3.5' : 'translate-x-0.5'}`}
        />
      </button>
      <span className="text-xxs font-mono text-text-tertiary">{value ? 'On' : 'Off'}</span>
    </div>
  )
}


/**
 * Reusable slider row for detection tuning parameters.
 * Shows tick marks with formatted values below the slider.
 */
function ParamSlider({ label, tooltip, value, min, max, step, format, onChange }) {
  const range = max - min
  const valuePct = range > 0 ? ((value - min) / range) * 100 : 0

  // Generate evenly spaced ticks (min + max + a few in between)
  const ticks = useMemo(() => {
    const count = Math.min(5, Math.round(range / step))
    if (count <= 1) return [min, max]
    const tickStep = range / count
    const result = []
    for (let i = 0; i <= count; i++) {
      const v = min + Math.round((tickStep * i) / step) * step
      if (v <= max) result.push(v)
    }
    if (result[result.length - 1] !== max) result.push(max)
    return [...new Set(result)]
  }, [min, max, step, range])

  return (
    <div>
      <div className="flex items-center gap-2">
        <Tooltip content={tooltip} position="top" delay={200}>
          <span className="text-xxs text-text-secondary shrink-0 flex items-center gap-1 cursor-help" style={{ minWidth: '7rem' }}>
            {label}
            <Info className="w-3 h-3 text-text-disabled shrink-0" />
          </span>
        </Tooltip>
        <div className="flex-1 flex flex-col gap-0">
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            className="w-full h-1 accent-accent cursor-pointer"
          />
          {/* Tick marks aligned to slider */}
          <div className="relative w-full" style={{ height: 12 }}>
            {ticks.map(v => {
              const pct = range > 0 ? ((v - min) / range) * 100 : 0
              return (
                <div key={v} className="absolute flex flex-col items-center" style={{ left: `${pct}%`, transform: 'translateX(-50%)' }}>
                  <div className="w-px h-1 bg-text-disabled/40" />
                  <span className="text-[8px] text-text-disabled font-mono leading-none mt-px">{format(v)}</span>
                </div>
              )
            })}
            {/* Current value indicator */}
            <div className="absolute flex flex-col items-center" style={{ left: `${valuePct}%`, transform: 'translateX(-50%)', top: -2 }}>
              <div className="w-px h-1.5 bg-accent" />
            </div>
          </div>
        </div>
        <span className="text-xxs text-accent font-mono shrink-0 font-semibold" style={{ minWidth: '3rem', textAlign: 'right' }}>
          {format(value)}
        </span>
      </div>
    </div>
  )
}
