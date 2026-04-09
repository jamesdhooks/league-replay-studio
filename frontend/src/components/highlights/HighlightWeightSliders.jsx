import { useState } from 'react'
import { useHighlight, EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { EVENT_COLORS } from '../../context/TimelineContext'
import { Wand2, SlidersHorizontal, Info, ListOrdered, Target, Clock, Sliders } from 'lucide-react'
import Tooltip from '../ui/Tooltip'
import CollapsibleSection from '../ui/CollapsibleSection'
import LabeledSlider from '../ui/LabeledSlider'

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
        <CollapsibleSection
          icon={ListOrdered}
          label="Event Priorities"
          open={!collapsed.priorities}
          onToggle={() => toggle('priorities')}
        >
          <div className="mt-2 space-y-2">
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
          </div>
        </CollapsibleSection>
      </div>

      {/* Minimum score threshold */}
      <div className="pt-2 border-t border-border-subtle space-y-1.5">
        <CollapsibleSection
          icon={Target}
          label="Minimum Score"
          open={!collapsed.minScore}
          onToggle={() => toggle('minScore')}
        >
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
        </CollapsibleSection>
      </div>

      {/* Target duration */}
      <div className="pt-2 border-t border-border-subtle space-y-1.5">
        <CollapsibleSection
          icon={Clock}
          label="Target Duration"
          open={!collapsed.duration}
          onToggle={() => toggle('duration')}
        >
        {!collapsed.duration && (
          <LabeledSlider
            label="Highlight Length"
            tooltip="Target duration of the final highlight video — shorter means stricter event selection (0 = no limit)"
            value={targetDuration ? Math.round(targetDuration / 60) : 0}
            min={0} max={30} step={1}
            format={v => v === 0 ? 'No limit' : `${v} min`}
            onChange={v => setTargetDuration(v === 0 ? null : v * 60)}
            labelWidth="7rem"
          />
        )}
        </CollapsibleSection>
      </div>

      {/* Direction & Camera Tuning */}
      <div className="pt-2 border-t border-border-subtle space-y-2">
        <CollapsibleSection
          icon={Sliders}
          label="Direction Tuning"
          open={!collapsed.direction}
          onToggle={() => toggle('direction')}
        >

        {!collapsed.direction && (
          <div className="mt-1 space-y-2.5">
            {/* Battle sticky period */}
        <LabeledSlider
          label="Battle Hold"
          tooltip="Seconds to follow one battle before switching cameras"
          value={params.battleStickyPeriod}
          min={5} max={30} step={5}
          format={v => `${v}s`}
          onChange={v => setParams(p => ({ ...p, battleStickyPeriod: v }))}
          labelWidth="7rem"
        />

        {/* Battle gap threshold */}
        <LabeledSlider
          label="Battle Gap"
          tooltip="Max estimated-time gap between adjacent cars to qualify as a battle"
          value={params.battleGap}
          min={0.3} max={3.0} step={0.1}
          format={v => `${v.toFixed(1)}s`}
          onChange={v => setParams(p => ({ ...p, battleGap: v }))}
          labelWidth="7rem"
        />

        {/* Battle front bias */}
        <LabeledSlider
          label="Front Bias"
          tooltip="Extra score boost for front-of-field battles over mid-pack — inspired by iRacingReplayDirector BattleFactor"
          value={params.battleFrontBias}
          min={1.0} max={2.5} step={0.1}
          format={v => `${v.toFixed(1)}×`}
          onChange={v => setParams(p => ({ ...p, battleFrontBias: v }))}
          labelWidth="7rem"
        />

        {/* Camera sticky period */}
        <LabeledSlider
          label="Camera Hold"
          tooltip="Seconds to hold one camera angle before rotating to another"
          value={params.cameraStickyPeriod}
          min={5} max={30} step={5}
          format={v => `${v}s`}
          onChange={v => setParams(p => ({ ...p, cameraStickyPeriod: v }))}
          labelWidth="7rem"
        />

        {/* Overtake boost */}
        <LabeledSlider
          label="Overtake Boost"
          tooltip="Score multiplier applied to events involving a position change"
          value={params.overtakeBoost}
          min={1.0} max={3.0} step={0.1}
          format={v => `${v.toFixed(1)}×`}
          onChange={v => setParams(p => ({ ...p, overtakeBoost: v }))}
          labelWidth="7rem"
        />

        {/* Incident position cutoff */}
        <LabeledSlider
          label="Incident Pos Cutoff"
          tooltip="Ignore incidents from cars ranked below this position (0 = include all)"
          value={params.incidentPositionCutoff}
          min={0} max={40} step={1}
          format={v => v === 0 ? 'Off' : `P${v}+`}
          onChange={v => setParams(p => ({ ...p, incidentPositionCutoff: v }))}
          labelWidth="7rem"
        />

        {/* Ignore first-lap incidents toggle */}
        <ParamToggle
          label="Skip 1st Lap Incidents"
          tooltip="Exclude crash/incident/spinout events detected during the first 15% of the race"
          value={params.ignoreIncidentsDuringFirstLap}
          onChange={v => setParams(p => ({ ...p, ignoreIncidentsDuringFirstLap: v }))}
        />

        {/* Race phase boost — first lap */}
        <LabeledSlider
          label="First Lap Boost"
          tooltip="Score multiplier for events within the First Lap Window"
          value={params.firstLapWeight}
          min={0.5} max={3.0} step={0.1}
          format={v => `${v.toFixed(1)}×`}
          onChange={v => setParams(p => ({ ...p, firstLapWeight: v }))}
          labelWidth="7rem"
        />

        <LabeledSlider
          label="First Lap Window"
          tooltip="Seconds from race start during which First Lap Boost applies (0 = off)"
          value={params.firstLapStickyPeriod}
          min={0} max={120} step={10}
          format={v => v === 0 ? 'Off' : `${v}s`}
          onChange={v => setParams(p => ({ ...p, firstLapStickyPeriod: v }))}
          labelWidth="7rem"
        />

        {/* Race phase boost — last lap */}
        <LabeledSlider
          label="Last Lap Boost"
          tooltip="Score multiplier for events within the Last Lap Window"
          value={params.lastLapWeight}
          min={0.5} max={3.0} step={0.1}
          format={v => `${v.toFixed(1)}×`}
          onChange={v => setParams(p => ({ ...p, lastLapWeight: v }))}
          labelWidth="7rem"
        />

        <LabeledSlider
          label="Last Lap Window"
          tooltip="Seconds before race end during which Last Lap Boost applies (0 = off)"
          value={params.lastLapStickyPeriod}
          min={0} max={120} step={10}
          format={v => v === 0 ? 'Off' : `${v}s`}
          onChange={v => setParams(p => ({ ...p, lastLapStickyPeriod: v }))}
          labelWidth="7rem"
        />

        {/* Late race bonus */}
        <LabeledSlider
          label="Late Race At"
          tooltip="Race fraction (0–1) after which the late-race score bonus activates"
          value={params.lateRaceThreshold}
          min={0.5} max={0.95} step={0.05}
          format={v => `${Math.round(v * 100)}%`}
          onChange={v => setParams(p => ({ ...p, lateRaceThreshold: v }))}
          labelWidth="7rem"
        />

        <LabeledSlider
          label="Late Race Boost"
          tooltip="Score multiplier applied to all events beyond the Late Race threshold"
          value={params.lateRaceMultiplier}
          min={1.0} max={2.0} step={0.1}
          format={v => `${v.toFixed(1)}×`}
          onChange={v => setParams(p => ({ ...p, lateRaceMultiplier: v }))}
          labelWidth="7rem"
        />

        {/* Preferred driver boost */}
        <LabeledSlider
          label="Driver Boost"
          tooltip="Score multiplier for events featuring preferred drivers"
          value={params.preferredDriverBoost}
          min={1.0} max={3.0} step={0.1}
          format={v => `${v.toFixed(1)}×`}
          onChange={v => setParams(p => ({ ...p, preferredDriverBoost: v }))}
          labelWidth="7rem"
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
        <LabeledSlider
          label="PiP Threshold"
          tooltip="Minimum score for two overlapping events to be shown in Picture-in-Picture instead of one being dropped"
          value={params.pipThreshold}
          min={5} max={10} step={0.5}
          format={v => v.toFixed(1)}
          onChange={v => setParams(p => ({ ...p, pipThreshold: v }))}
          labelWidth="7rem"
        />
          </div>
        )}
        </CollapsibleSection>
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

