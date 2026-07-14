import { useState, useMemo, useRef, useEffect } from 'react'
import { useHighlight, EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { EVENT_COLORS } from '../../context/TimelineContext'
import { useAnalysis } from '../../context/AnalysisContext'
import { useIRacing } from '../../context/IRacingContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { Wand2, SlidersHorizontal, Info, ListOrdered, Target, Sliders, Film, X, Camera, ChevronDown, Shuffle, HelpCircle, Save, Trash2, BookMarked, Users } from 'lucide-react'
import HighlightControlsHelp from './HighlightControlsHelp'
import Tooltip from '../ui/Tooltip'
import CollapsibleSection from '../ui/CollapsibleSection'
import LabeledSlider from '../ui/LabeledSlider'
import { resolveTypePadding } from '../../utils/highlight-padding'

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
    params, setParams,
    sectionConfig, updateSectionConfig,
    presets, currentPresetId, hasUnsavedChanges,
    loadPreset, savePreset, deletePreset,
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

  const [showHelp, setShowHelp] = useState(false)
  const [saveMode, setSaveMode] = useState(false)   // inline save-as input visible
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)
  const saveInputRef = useRef(null)

  useEffect(() => {
    if (saveMode) {
      setSaveName(currentPresetId || '')
      setTimeout(() => saveInputRef.current?.focus(), 0)
    }
  }, [saveMode, currentPresetId])

  const handleLoadPreset = (id) => {
    const p = presets.find(x => x.id === id || x.name === id)
    if (p) loadPreset(p)
  }

  const handleSaveAs = async () => {
    const name = saveName.trim()
    if (!name) return
    setSaving(true)
    try {
      await savePreset(name)
      setSaveMode(false)
    } catch (_e) {
      // error is already logged in context
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!currentPresetId) return
    if (!window.confirm(`Delete preset "${currentPresetId}"?`)) return
    try { await deletePreset(currentPresetId) } catch (_e) { /* logged */ }
  }

  const currentPreset = presets.find(p => p.id === currentPresetId || p.name === currentPresetId)

  return (
    <div className="space-y-0">

      {/* Preset selector bar */}
      <div className="mx-2 mb-2 space-y-1.5">
        {/* Row 1: select + action buttons */}
        <div className="flex items-center gap-1.5">
          <BookMarked className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
          <select
            value={currentPresetId || ''}
            onChange={e => handleLoadPreset(e.target.value)}
            className="flex-1 h-7 px-2 rounded-md border border-border bg-bg-primary text-xxs
                       text-text-secondary focus:outline-none focus:border-accent min-w-0"
            title="Load a highlight preset"
          >
            <option value="">{hasUnsavedChanges || !currentPresetId ? '— custom —' : 'Select preset'}</option>
            {presets.map(p => (
              <option key={p.id ?? p.name} value={p.id ?? p.name}>{p.name}</option>
            ))}
          </select>

          {/* Overwrite / Save-as toggle */}
          <button
            onClick={() => setSaveMode(v => !v)}
            className="h-7 px-2 inline-flex items-center gap-1 rounded-md border border-border
                       text-xxs text-text-secondary hover:text-text-primary hover:bg-bg-hover
                       transition-colors shrink-0"
            title={currentPreset && hasUnsavedChanges ? 'Overwrite or save as new preset' : 'Save as preset'}
          >
            <Save className="w-3 h-3" />
            {currentPreset && hasUnsavedChanges ? 'Save*' : 'Save'}
          </button>

          {/* Delete */}
          {currentPreset && (
            <button
              onClick={handleDelete}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border
                         text-text-tertiary hover:text-red-400 hover:border-red-400/40 hover:bg-red-400/10
                         transition-colors shrink-0"
              title={`Delete "${currentPreset.name}"`}
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Row 2: inline save-as input (conditional) */}
        {saveMode && (
          <div className="flex items-center gap-1.5">
            <input
              ref={saveInputRef}
              type="text"
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveAs(); if (e.key === 'Escape') setSaveMode(false) }}
              placeholder="Preset name…"
              className="flex-1 h-7 px-2 rounded-md border border-accent/40 bg-bg-primary text-xxs
                         text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent"
            />
            <button
              onClick={handleSaveAs}
              disabled={saving || !saveName.trim()}
              className="h-7 px-2.5 rounded-md bg-accent text-white text-xxs font-medium
                         hover:bg-accent/80 disabled:opacity-50 transition-colors shrink-0"
            >
              {saving ? '…' : 'Save'}
            </button>
            <button
              onClick={() => setSaveMode(false)}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border
                         text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Unsaved changes badge */}
        {currentPreset && hasUnsavedChanges && !saveMode && (
          <p className="text-[10px] text-warning/80 leading-none px-0.5">
            Unsaved changes to &ldquo;{currentPreset.name}&rdquo;
          </p>
        )}
      </div>

      {/* Help button */}
      <div className="pb-2 mx-2">
        <button
          onClick={() => setShowHelp(true)}
          className="flex items-center gap-2 w-full px-3 py-2 text-xs font-medium
                     text-accent bg-accent/10 hover:bg-accent/20 border border-accent/20
                     rounded-lg transition-colors"
        >
          <HelpCircle className="w-3.5 h-3.5 shrink-0" />
          <span>What do these controls do?</span>
        </button>
      </div>

      {/* Event type weights */}
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

      {/* Mix & Diversity — Balanced Selection v3 */}
      <div className="pt-2 border-t border-border-subtle space-y-2">
        <CollapsibleSection
          icon={Shuffle}
          label="Mix & Diversity"
          open={!collapsed.mixDiversity}
          onToggle={() => toggle('mixDiversity')}
        >
          <div className="mt-2 space-y-3">
            {/* Master diversity slider */}
            <LabeledSlider
              label="Diversity Strength"
              tooltip="0 = pure score-greedy (highest score wins). 100 = strict mix targets enforced. The selector applies type decay, bucket-spread, mix floors, and mix caps in proportion to this knob."
              min={0}
              max={100}
              step={5}
              value={params.diversityStrength ?? 50}
              onChange={v => setParams(p => ({ ...p, diversityStrength: v }))}
              valueDisplay={`${params.diversityStrength ?? 50}`}
            />

            {/* Normalization mode */}
            <div className="flex items-center justify-between gap-2">
              <Tooltip content="Cross-type: stretches all positive raw scores onto one 0.5–10 scale so weights act honestly across types. Per-type (legacy): each type normalized independently — every type spans the full range regardless of its base importance.">
                <span className="text-xxs text-text-secondary cursor-help">Score Normalization</span>
              </Tooltip>
              <select
                value={params.normalizationMode ?? 'cross_type'}
                onChange={e => setParams(p => ({ ...p, normalizationMode: e.target.value }))}
                className="text-xxs bg-surface-2 border border-border-subtle rounded px-1.5 py-0.5"
              >
                <option value="cross_type">Cross-type (recommended)</option>
                <option value="per_type">Per-type (legacy)</option>
              </select>
            </div>

            {/* Per-type mix targets */}
            <div className="pt-2 border-t border-border-subtle/50">
              <div className="flex items-center gap-1.5 mb-2">
                <span className="text-xxs font-medium text-text-secondary">Mix Targets</span>
                <Tooltip content="Approximate share of total script time per event type. Diversity Strength determines how strictly these are enforced. Floors push types up; caps stop selection of a type once hit.">
                  <Info className="w-3 h-3 text-text-tertiary" />
                </Tooltip>
              </div>
              <div className="space-y-1.5">
                {eventTypes.map(type => {
                  const label = EVENT_TYPE_LABELS[type]
                  const mn = (params.mixMin && params.mixMin[type] != null) ? Math.round(params.mixMin[type] * 100) : 0
                  const mx = (params.mixMax && params.mixMax[type] != null) ? Math.round(params.mixMax[type] * 100) : 100
                  const tgt = (params.mixTargets && params.mixTargets[type] != null) ? Math.round(params.mixTargets[type] * 100) : null
                  return (
                    <div key={type} className="flex items-center gap-2">
                      <span className="text-xxs w-16 truncate text-text-secondary" title={label}>{label}</span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={5}
                        placeholder="min"
                        value={mn || ''}
                        onChange={e => {
                          const v = parseInt(e.target.value, 10)
                          const next = { ...(params.mixMin || {}) }
                          if (Number.isFinite(v) && v > 0) next[type] = v / 100
                          else delete next[type]
                          setParams(p => ({ ...p, mixMin: next }))
                        }}
                        className="w-12 text-xxs bg-surface-2 border border-border-subtle rounded px-1 py-0.5 font-mono"
                        title="Soft floor (% of script time)"
                      />
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={5}
                        placeholder="tgt"
                        value={tgt || ''}
                        onChange={e => {
                          const v = parseInt(e.target.value, 10)
                          const next = { ...(params.mixTargets || {}) }
                          if (Number.isFinite(v) && v > 0) next[type] = v / 100
                          else delete next[type]
                          setParams(p => ({ ...p, mixTargets: next }))
                        }}
                        className="w-12 text-xxs bg-surface-2 border border-accent/30 rounded px-1 py-0.5 font-mono"
                        title="Target share (% of script time)"
                      />
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={5}
                        placeholder="max"
                        value={(params.mixMax && params.mixMax[type] != null) ? mx : ''}
                        onChange={e => {
                          const v = parseInt(e.target.value, 10)
                          const next = { ...(params.mixMax || {}) }
                          if (Number.isFinite(v) && v >= 0 && v < 100) next[type] = v / 100
                          else delete next[type]
                          setParams(p => ({ ...p, mixMax: next }))
                        }}
                        className="w-12 text-xxs bg-surface-2 border border-border-subtle rounded px-1 py-0.5 font-mono"
                        title="Hard cap (% of script time)"
                      />
                    </div>
                  )
                })}
              </div>
              <div className="text-xxs text-text-tertiary mt-1.5 italic">
                min · target · max (all % of script time, blank = unset)
              </div>
            </div>

            {/* Advanced diminishing-returns knobs */}
            <details className="pt-2 border-t border-border-subtle/50">
              <summary className="text-xxs text-text-secondary cursor-pointer select-none">Advanced</summary>
              <div className="mt-2 space-y-2.5">
                <LabeledSlider
                  label="Type Decay Base"
                  tooltip="Geometric falloff applied to each successive event of the same type. Lower = faster diminishing returns. 1.0 = no decay."
                  min={0.5}
                  max={1.0}
                  step={0.01}
                  value={params.typeDecayBase ?? 0.85}
                  onChange={v => setParams(p => ({ ...p, typeDecayBase: v }))}
                  valueDisplay={(params.typeDecayBase ?? 0.85).toFixed(2)}
                />
                <LabeledSlider
                  label="Bucket Repeat Penalty"
                  tooltip="Penalty for stacking same-type events into the same temporal bucket (early/mid/late race). Higher = better temporal spread."
                  min={0}
                  max={1.0}
                  step={0.05}
                  value={params.bucketRepeatPenalty ?? 0.25}
                  onChange={v => setParams(p => ({ ...p, bucketRepeatPenalty: v }))}
                  valueDisplay={(params.bucketRepeatPenalty ?? 0.25).toFixed(2)}
                />
              </div>
            </details>
          </div>
        </CollapsibleSection>
      </div>

      {/* Driver Coverage */}
      <div className="pt-2 border-t border-border-subtle space-y-2">
        <CollapsibleSection
          icon={Users}
          label="Driver Coverage"
          open={!collapsed.driverCoverage}
          onToggle={() => toggle('driverCoverage')}
        >
          <div className="mt-2 space-y-2.5">
            <LabeledSlider
              label="Coverage Strength"
              tooltip="How strongly to push for field-wide driver coverage. 0 = disabled (pure score-greedy). Higher values boost events featuring drivers not yet seen in the reel and gently penalise repeated drivers. Still favours front-runners and story moments."
              min={0}
              max={100}
              step={5}
              value={params.driverCoverageStrength ?? 35}
              onChange={v => setParams(p => ({ ...p, driverCoverageStrength: v }))}
              valueDisplay={`${params.driverCoverageStrength ?? 35}`}
              labelWidth="7rem"
            />
            <LabeledSlider
              label="New Driver Boost"
              tooltip="Score multiplier ceiling for events that introduce a driver not yet featured in the reel. 1.0 = no boost. Works in proportion to Coverage Strength."
              min={1.0}
              max={2.0}
              step={0.05}
              value={params.newDriverBoost ?? 1.40}
              onChange={v => setParams(p => ({ ...p, newDriverBoost: v }))}
              valueDisplay={`${(params.newDriverBoost ?? 1.40).toFixed(2)}×`}
              labelWidth="7rem"
            />
            <LabeledSlider
              label="Repeat Penalty"
              tooltip="Fractional score penalty applied when every involved driver has already been shown. 0 = no penalty. Works in proportion to Coverage Strength."
              min={0}
              max={0.75}
              step={0.05}
              value={params.repeatDriverPenalty ?? 0.25}
              onChange={v => setParams(p => ({ ...p, repeatDriverPenalty: v }))}
              valueDisplay={(params.repeatDriverPenalty ?? 0.25).toFixed(2)}
              labelWidth="7rem"
            />
            <LabeledSlider
              label="Coverage Target"
              tooltip="Fraction of the field (0.30–0.90) to aim for when Coverage Strength > 0. Once this share of drivers appears in the reel the rebalance pass stops swapping."
              min={0.30}
              max={0.90}
              step={0.05}
              value={params.targetUniqueDriverShare ?? 0.60}
              onChange={v => setParams(p => ({ ...p, targetUniqueDriverShare: v }))}
              valueDisplay={`${Math.round((params.targetUniqueDriverShare ?? 0.60) * 100)}%`}
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
            <ControlGroupLabel>Continuity rhythm</ControlGroupLabel>
            <LabeledSlider
              label="Continuity"
              tooltip="Prefer nearby events as uninterrupted capture blocks. Retained gap footage counts toward the target duration."
              value={params.continuityPreference ?? 0}
              min={0} max={100} step={5}
              format={v => {
                if (v === 0) return 'Cut-focused'
                if (v <= 25) return 'Light flow'
                if (v <= 60) return 'Balanced'
                if (v <= 85) return 'Continuous'
                return 'Long takes'
              }}
              tickFormat={v => v}
              onChange={v => setParams(current => ({ ...current, continuityPreference: v }))}
              labelWidth="7rem"
            />
            <LabeledSlider
              label="Block Length"
              tooltip="Preferred duration for each continuity block. Auto follows the main Continuity slider."
              value={params.continuityBlockDuration ?? 0}
              min={0} max={300} step={15}
              format={v => v === 0 ? 'Auto' : `${v}s`}
              onChange={v => setParams(p => ({ ...p, continuityBlockDuration: v }))}
              labelWidth="7rem"
            />
            <LabeledSlider
              label="Block Count"
              tooltip="Preferred number of continuity blocks distributed across the race. Auto follows the main Continuity slider."
              value={params.continuityBlockCount ?? 0}
              min={0} max={18} step={1}
              format={v => v === 0 ? 'Auto' : `${v}`}
              onChange={v => setParams(p => ({ ...p, continuityBlockCount: v }))}
              labelWidth="7rem"
            />
            <LabeledSlider
              label="Gap Reach"
              tooltip="Largest race-time gap the planner may close inside one continuity block. Auto follows the main Continuity slider."
              value={params.continuityGapReach ?? 0}
              min={0} max={180} step={5}
              format={v => v === 0 ? 'Auto' : `${v}s`}
              onChange={v => setParams(p => ({ ...p, continuityGapReach: v }))}
              labelWidth="7rem"
            />
            <LabeledSlider
              label="Block Variety"
              tooltip="Prefer continuity blocks containing a mix of event types. This affects the event mix within each block, not the overall reel mix."
              value={params.continuityEventDiversity ?? 0}
              min={0} max={100} step={5}
              format={v => {
                if (v === 0) return 'Score-first'
                if (v <= 25) return 'Light variety'
                if (v <= 60) return 'Balanced mix'
                if (v <= 85) return 'Varied'
                return 'Rich mix'
              }}
              tickFormat={v => v}
              onChange={v => setParams(p => ({ ...p, continuityEventDiversity: v }))}
              labelWidth="7rem"
            />

            <ControlGroupLabel>Battle selection</ControlGroupLabel>
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

        {/* Battle gap intensity */}
        <LabeledSlider
          label="Gap Intensity"
          tooltip="How much tighter average gap boosts a battle segment's score. Higher values prefer wheel-to-wheel moments over distant following. 0 = off."
          value={params.battleGapBonus ?? 0.5}
          min={0} max={2.0} step={0.1}
          format={v => v === 0 ? 'Off' : `${v.toFixed(1)}×`}
          onChange={v => setParams(p => ({ ...p, battleGapBonus: v }))}
          labelWidth="7rem"
        />

        <ControlGroupLabel>Camera rhythm</ControlGroupLabel>
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

        <ControlGroupLabel>Event emphasis</ControlGroupLabel>
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

        <ControlGroupLabel>Race phases</ControlGroupLabel>
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

        <ControlGroupLabel>Driver focus</ControlGroupLabel>
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
                const { before, after, sourceType } = resolveTypePadding(params, type)
                const hasBefore = before != null
                const hasAfter = after != null
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
                      value={hasBefore ? before : ''}
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
                      value={hasAfter ? after : ''}
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
                          delete pbt[sourceType || type]
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

      {/* Help button */}
      {showHelp && <HighlightControlsHelp onClose={() => setShowHelp(false)} />}

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
function ControlGroupLabel({ children }) {
  return (
    <div className="pt-2 first:pt-0 border-t first:border-t-0 border-border-subtle">
      <span className="text-xxs font-medium text-text-disabled uppercase tracking-wider">{children}</span>
    </div>
  )
}

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

