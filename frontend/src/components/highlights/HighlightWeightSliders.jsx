import { useState, useMemo, useRef, useEffect } from 'react'
import { useHighlight, EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { EVENT_COLORS } from '../../context/TimelineContext'
import { useAnalysis } from '../../context/AnalysisContext'
import { useIRacing } from '../../context/IRacingContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { Wand2, SlidersHorizontal, Info, ListOrdered, Target, Clock, Sliders, Film, X, Camera, ChevronDown } from 'lucide-react'
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
    sectionConfig, updateSectionConfig,
  } = useHighlight()

  const { events } = useAnalysis()
  const { isConnected, sessionData } = useIRacing()

  // Only show types that exist in the loaded events; fall back to full list when empty
  const eventTypes = useMemo(() => {
    if (!events || events.length === 0) return Object.keys(EVENT_TYPE_LABELS)
    const present = new Set(events.map(e => e.event_type).filter(Boolean))
    return Object.keys(EVENT_TYPE_LABELS).filter(t => present.has(t))
  }, [events])

  const [collapsed, setCollapsed] = useLocalStorage('lrs:editing:controls:collapsed', {})
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
          <div className="mt-2 flex items-center gap-2">
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
          <div className="mt-2">
            <LabeledSlider
              label="Highlight Length"
              tooltip="Target duration of the final highlight video — shorter means stricter event selection (0 = no limit)"
              value={targetDuration ? Math.round(targetDuration / 60) : 0}
              min={0} max={30} step={1}
              format={v => v === 0 ? 'No limit' : `${v} min`}
              onChange={v => setTargetDuration(v === 0 ? null : v * 60)}
              labelWidth="7rem"
            />
          </div>
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
          <div className="mt-2 space-y-2.5">
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

        {/* Camera hold variability */}
        <LabeledSlider
          label="Cam Variability"
          tooltip="Random ±seconds applied to each camera hold (0 = fixed hold)"
          value={params.cameraHoldVariability ?? 0}
          min={0} max={15} step={1}
          format={v => v === 0 ? 'Fixed' : `±${v}s`}
          onChange={v => setParams(p => ({ ...p, cameraHoldVariability: v }))}
          labelWidth="7rem"
        />

        {/* Driver change probability */}
        <LabeledSlider
          label="Driver Change"
          tooltip="Probability of switching driver focus on each camera cut (0 = never, 100 = always)"
          value={Math.round((params.driverChangeProbability ?? 0.3) * 100)}
          min={0} max={100} step={10}
          format={v => `${v}%`}
          onChange={v => setParams(p => ({ ...p, driverChangeProbability: v / 100 }))}
          labelWidth="7rem"
        />

        {/* Driver recency controls */}
        <LabeledSlider
          label="Driver Recency"
          tooltip="How strongly to penalise showing the same driver again soon. 0 = no penalty, 1 = maximum. Higher values force more driver variety."
          value={params.driverRecencyPenalty ?? 0.5}
          min={0} max={1.0} step={0.05}
          format={v => v === 0 ? 'Off' : v.toFixed(2)}
          onChange={v => setParams(p => ({ ...p, driverRecencyPenalty: v }))}
          labelWidth="7rem"
        />
        <LabeledSlider
          label="Driver Decay"
          tooltip="Seconds for the driver recency penalty to fade back to zero. Short decay = drivers re-qualify quickly."
          value={params.driverRecencyDecay ?? 60}
          min={10} max={300} step={10}
          format={v => `${v}s`}
          onChange={v => setParams(p => ({ ...p, driverRecencyDecay: v }))}
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

        {/* Race finishes cap */}
        <LabeledSlider
          label="Race Finishes"
          tooltip="Max number of race finish events to include in the highlight (0 = no limit — all finishes included)"
          value={params.maxRaceFinishes}
          min={0} max={20} step={1}
          format={v => v === 0 ? 'All' : `${v}`}
          onChange={v => setParams(p => ({ ...p, maxRaceFinishes: v }))}
          labelWidth="7rem"
        />
          </div>
        </CollapsibleSection>
      </div>

      {/* Clip Padding */}
      <div className="pt-2 border-t border-border-subtle space-y-2">
        <CollapsibleSection
          icon={Film}
          label="Clip Padding"
          open={!collapsed.padding}
          onToggle={() => toggle('padding')}
        >
          <div className="mt-2 space-y-2.5">
            {/* Global defaults */}
            <div className="space-y-2">
              <span className="text-xxs text-text-disabled uppercase tracking-wider">Global default</span>
              <LabeledSlider
                label="Lead-in"
                tooltip="Default seconds added before every event's start time. Can be overridden per type below, and per individual event in the Event Inspector."
                value={params.paddingBefore}
                min={0} max={15} step={0.5}
                format={v => `${v}s`}
                onChange={v => setParams(p => ({ ...p, paddingBefore: v }))}
                labelWidth="5rem"
              />
              <LabeledSlider
                label="Follow-out"
                tooltip="Default seconds added after every event's end time. Can be overridden per type below, and per individual event in the Event Inspector."
                value={params.paddingAfter}
                min={0} max={30} step={0.5}
                format={v => `${v}s`}
                onChange={v => setParams(p => ({ ...p, paddingAfter: v }))}
                labelWidth="5rem"
              />
            </div>
            {/* Per-type overrides */}
            <div className="space-y-1">
              <div className="flex items-center gap-1 mb-1">
                <span className="text-xxs text-text-disabled uppercase tracking-wider flex-1">Per type (In / Out)</span>
                <span className="text-xxs text-text-disabled w-10 text-center">In</span>
                <span className="text-xxs text-text-disabled w-10 text-center">Out</span>
                <span className="w-4" />
              </div>
              {eventTypes.map(type => {
                const typeSettings = params.paddingByType?.[type] || {}
                const hasBefore = typeSettings.before != null
                const hasAfter = typeSettings.after != null
                const hasAny = hasBefore || hasAfter
                const color = EVENT_COLORS[type] || '#666'
                return (
                  <div key={type} className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    <span className="text-xxs text-text-secondary flex-1 truncate" title={EVENT_TYPE_LABELS[type]}>
                      {EVENT_TYPE_LABELS[type]}
                    </span>
                    <input
                      type="number"
                      min={0} max={15} step={0.5}
                      value={hasBefore ? typeSettings.before : ''}
                      placeholder={`${params.paddingBefore}`}
                      onChange={e => {
                        const v = e.target.value === '' ? null : parseFloat(e.target.value)
                        setParams(p => ({
                          ...p,
                          paddingByType: {
                            ...p.paddingByType,
                            [type]: { ...p.paddingByType?.[type], before: v },
                          },
                        }))
                      }}
                      className="w-10 text-xxs text-center bg-bg-primary border border-border rounded
                                 px-1 py-0.5 font-mono text-text-primary focus:outline-none
                                 focus:border-accent placeholder:text-text-disabled
                                 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <input
                      type="number"
                      min={0} max={30} step={0.5}
                      value={hasAfter ? typeSettings.after : ''}
                      placeholder={`${params.paddingAfter}`}
                      onChange={e => {
                        const v = e.target.value === '' ? null : parseFloat(e.target.value)
                        setParams(p => ({
                          ...p,
                          paddingByType: {
                            ...p.paddingByType,
                            [type]: { ...p.paddingByType?.[type], after: v },
                          },
                        }))
                      }}
                      className="w-10 text-xxs text-center bg-bg-primary border border-border rounded
                                 px-1 py-0.5 font-mono text-text-primary focus:outline-none
                                 focus:border-accent placeholder:text-text-disabled
                                 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <button
                      onClick={() => {
                        if (!hasAny) return
                        setParams(p => {
                          const pbt = { ...p.paddingByType }
                          delete pbt[type]
                          return { ...p, paddingByType: pbt }
                        })
                      }}
                      className={`shrink-0 transition-colors ${
                        hasAny
                          ? 'text-text-disabled hover:text-danger cursor-pointer'
                          : 'text-transparent pointer-events-none'
                      }`}
                      title="Clear type override"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>

        </CollapsibleSection>
      </div>

      {/* Camera Selection */}
      <div className="pt-2 border-t border-border-subtle space-y-2">
        <CollapsibleSection
          icon={Camera}
          label="Camera Selection"
          open={!collapsed.cameras}
          onToggle={() => toggle('cameras')}
        >
          <div className="mt-2 space-y-4">

            {/* ── Section camera overrides (non-race sections only) ── */}
            <div className="space-y-2">
              <span className="text-xxs text-text-disabled uppercase tracking-wider">Section Cameras</span>
              {[
                { id: 'intro',              label: 'Intro' },
                { id: 'qualifying_results', label: 'Qualifying' },
                { id: 'race_results',       label: 'Results' },
              ].map(({ id, label }) => (
                <SectionCameraSelect
                  key={id}
                  label={label}
                  cameras={sessionData.cameras || []}
                  isConnected={isConnected}
                  value={sectionConfig[id]?.camera_preferences || []}
                  onChange={prefs => updateSectionConfig(id, { camera_preferences: prefs })}
                />
              ))}
            </div>

            {/* ── Race camera weights ── */}
            <div className="space-y-2">
              <span className="text-xxs text-text-disabled uppercase tracking-wider">Race Camera Weights</span>
              <p className="text-xxs text-text-disabled/70 leading-relaxed">
                Probabilistic camera selection for race event clips. Higher weight = more likely to be chosen.
              </p>
              {/* Recency controls */}
              <div className="space-y-2">
                <LabeledSlider
                  label="Recency Penalty"
                  tooltip="How strongly to penalise a camera that was recently chosen. 0 = no penalty, 1 = maximum. Higher values force more camera rotation."
                  value={params.cameraRecencyPenalty}
                  min={0} max={1.0} step={0.05}
                  format={v => v === 0 ? 'Off' : v.toFixed(2)}
                  onChange={v => setParams(p => ({ ...p, cameraRecencyPenalty: v }))}
                  labelWidth="7rem"
                />
                <LabeledSlider
                  label="Penalty Decay"
                  tooltip="Seconds for the recency penalty to fade back to zero. Short decay = cameras re-qualify quickly."
                  value={params.cameraRecencyDecay}
                  min={5} max={120} step={5}
                  format={v => `${v}s`}
                  onChange={v => setParams(p => ({ ...p, cameraRecencyDecay: v }))}
                  labelWidth="7rem"
                />
              </div>
              {/* Per-camera weight sliders */}
              {!isConnected || !sessionData.cameras?.length ? (
                <p className="text-xxs text-text-disabled italic">
                  Connect iRacing to see available cameras. Saved weights will be applied when generating.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {sessionData.cameras.map(cam => {
                    const weight = params.cameraWeights?.[cam.group_name] ?? 50
                    const isDisabled = weight === 0
                    return (
                      <div key={cam.group_num} className={`flex items-center gap-2 ${isDisabled ? 'opacity-40' : ''}`}>
                        <button
                          className="w-3 h-3 rounded-full shrink-0 border border-white/20 hover:scale-125 transition-transform bg-accent/60"
                          style={{ backgroundColor: isDisabled ? '#444' : undefined }}
                          onClick={() => setParams(p => ({
                            ...p,
                            cameraWeights: { ...p.cameraWeights, [cam.group_name]: isDisabled ? 50 : 0 },
                          }))}
                          title={isDisabled ? `Enable ${cam.group_name}` : `Disable ${cam.group_name}`}
                        />
                        <span className={`text-xxs w-20 truncate shrink-0 ${isDisabled ? 'text-text-disabled line-through' : 'text-text-secondary'}`}
                          title={cam.group_name}>
                          {cam.group_name}
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={5}
                          value={weight}
                          disabled={isDisabled}
                          onChange={e => setParams(p => ({
                            ...p,
                            cameraWeights: { ...p.cameraWeights, [cam.group_name]: parseInt(e.target.value, 10) },
                          }))}
                          className="flex-1 h-1 accent-accent cursor-pointer"
                        />
                        <span className="text-xxs text-text-tertiary font-mono w-7 text-right">{weight}</span>
                      </div>
                    )
                  })}
                  <button
                    onClick={() => setParams(p => ({ ...p, cameraWeights: {} }))}
                    className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xxs font-medium
                               text-text-disabled bg-bg-secondary hover:bg-bg-tertiary rounded transition-colors mt-1"
                  >
                    <X className="w-3 h-3" />
                    Reset all to equal weight
                  </button>
                </div>
              )}
            </div>

            {/* ── Probability bar chart ── */}
            {sessionData.cameras?.length > 0 && (
              <CameraProbabilityChart
                cameras={sessionData.cameras}
                cameraWeights={params.cameraWeights || {}}
              />
            )}

          </div>
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

/**
 * Multi-select camera picker for a single non-race section (intro / qualifying / results).
 * Checkpoint boxes are shown in a collapsible dropdown panel.
 */
function SectionCameraSelect({ label, cameras, isConnected, value, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const toggle = name => {
    if (value.includes(name)) onChange(value.filter(n => n !== name))
    else onChange([...value, name])
  }

  const displayText = value.length === 0
    ? 'Default'
    : value.length === cameras.length
      ? 'All cameras'
      : value.length === 1
        ? value[0]
        : `${value.length} cameras`

  return (
    <div ref={ref} className="relative flex items-center gap-2">
      <span className="text-xxs text-text-secondary shrink-0 w-20">{label}</span>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={!isConnected || !cameras.length}
        className={`flex-1 flex items-center justify-between gap-1 px-2 py-1 rounded
                    border text-xxs transition-colors
                    ${isConnected && cameras.length
                      ? 'border-border hover:border-accent/60 text-text-primary cursor-pointer bg-bg-secondary hover:bg-bg-tertiary'
                      : 'border-border/40 text-text-disabled cursor-not-allowed bg-bg-secondary/40'}`}
      >
        <span className="truncate">{displayText}</span>
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && cameras.length > 0 && (
        <div className="absolute left-22 top-full mt-1 z-50 min-w-[160px] bg-bg-elevated border border-border rounded shadow-lg py-1
                        max-h-48 overflow-y-auto"
          style={{ left: '5.5rem' }}
        >
          {/* Clear / select-all row */}
          <div className="flex items-center justify-between px-2 pb-1 mb-1 border-b border-border/40">
            <button
              className="text-xxs text-text-disabled hover:text-text-secondary transition-colors"
              onClick={() => onChange([])}
            >Clear</button>
            <button
              className="text-xxs text-text-disabled hover:text-text-secondary transition-colors"
              onClick={() => onChange(cameras.map(c => c.group_name))}
            >All</button>
          </div>
          {cameras.map(cam => (
            <label
              key={cam.group_num}
              className="flex items-center gap-2 px-2 py-1 hover:bg-bg-tertiary cursor-pointer select-none"
            >
              <input
                type="checkbox"
                checked={value.includes(cam.group_name)}
                onChange={() => toggle(cam.group_name)}
                className="accent-accent w-3 h-3 shrink-0"
              />
              <span className="text-xxs text-text-primary truncate">{cam.group_name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Horizontal bar chart showing normalised camera selection probability
 * based on the user's current weight assignments.
 */
function CameraProbabilityChart({ cameras, cameraWeights }) {
  const segments = useMemo(() => {
    const total = cameras.reduce((sum, cam) => sum + Math.max(0, cameraWeights[cam.group_name] ?? 50), 0)
    if (total === 0) return []
    return cameras
      .map(cam => {
        const w = cameraWeights[cam.group_name] ?? 50
        return { name: cam.group_name, weight: w, prob: w / total }
      })
      .filter(s => s.prob > 0)
      .sort((a, b) => b.prob - a.prob)
  }, [cameras, cameraWeights])

  if (segments.length === 0) return null

  // Generate distinct colors for each camera (cycling through a palette)
  const colors = ['bg-blue-500', 'bg-purple-500', 'bg-pink-500', 'bg-orange-500', 'bg-green-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-rose-500']
  
  let offset = 0
  const bars = segments.map(({ name, prob }, idx) => {
    const start = offset
    offset += prob * 100
    return { name, prob, start, offset: offset - start, color: colors[idx % colors.length] }
  })

  return (
    <div className="space-y-1.5">
      <span className="text-xxs text-text-disabled uppercase tracking-wider">Camera Selection Probability</span>
      {/* Single stacked horizontal bar */}
      <div className="h-6 rounded-lg bg-bg-secondary overflow-hidden flex border border-border">
        {bars.map(({ name, prob, start, offset: width, color }) => (
          <div
            key={name}
            className={`${color} transition-all duration-300 relative group flex items-center justify-center`}
            style={{ width: `${width}%` }}
            title={`${name}: ${(prob * 100).toFixed(1)}%`}
          >
            {/* Show percentage inline if segment is wide enough */}
            {width >= 8 && (
              <span className="text-[10px] font-semibold text-white drop-shadow-sm pointer-events-none">
                {(prob * 100).toFixed(0)}%
              </span>
            )}
            
            {/* Tooltip for small segments */}
            {width < 8 && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-bg-primary border border-border rounded text-xxs text-text-secondary whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 shadow-lg">
                {name}: {(prob * 100).toFixed(1)}%
              </div>
            )}
          </div>
        ))}
      </div>
      
      {/* Legend */}
      <div className="flex flex-wrap gap-2 text-[9px]">
        {bars.map(({ name, prob, color }) => (
          <div key={name} className="flex items-center gap-1">
            <div className={`w-2 h-2 rounded ${color}`} />
            <span className="text-text-secondary">{name}: {(prob * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

