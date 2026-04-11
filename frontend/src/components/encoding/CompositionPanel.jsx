import { useState, useCallback, useMemo, useEffect } from 'react'
import { useComposition } from '../../context/CompositionContext'
import { useEncoding } from '../../context/EncodingContext'
import { useToast } from '../../context/ToastContext'
import { formatTime } from '../../utils/time'
import {
  Film, Play, Square, Settings2, Sliders, Clock,
  CheckCircle2, XCircle, AlertTriangle, Layers, Loader2,
  ChevronDown, ChevronRight, FileVideo, Scissors, Palette,
  Zap, BarChart2, Eye, RefreshCw,
} from 'lucide-react'

/**
 * State-to-UI mapping for composition pipeline steps.
 */
const STEP_META = {
  trimming: { label: 'Trimming Clips', icon: Scissors, color: 'text-amber-400', range: [0, 25] },
  overlaying: { label: 'Rendering Overlays', icon: Palette, color: 'text-blue-400', range: [25, 65] },
  transitions: { label: 'Inserting Transitions', icon: Film, color: 'text-purple-400', range: [65, 80] },
  stitching: { label: 'Stitching Final Video', icon: Layers, color: 'text-emerald-400', range: [80, 100] },
}

/**
 * CompositionPanel — Encoding step with composition pipeline UI.
 *
 * Shows:
 * - Transition configuration (fade-to-black threshold, duration)
 * - Trim buffer configuration
 * - Overlay template selection per section
 * - Large progress view with structured backend logging
 * - Visual script progress (which segment is being processed)
 * - Start / cancel controls
 *
 * @param {Object} props
 * @param {number} props.projectId - Active project ID
 * @param {Array} [props.script] - Video composition script
 * @param {Array} [props.clipsManifest] - Captured clips from capture step
 * @param {string} [props.outputDir] - Project output directory
 */
export default function CompositionPanel({
  projectId, script = [], clipsManifest = [], outputDir = '',
}) {
  const {
    activeJob, recentJobs, logEntries, loading, error,
    startComposition, cancelComposition, fetchStatus,
  } = useComposition()
  const { presets: encodingPresets, fetchPresets } = useEncoding()
  const { showSuccess, showError } = useToast()

  // ── Configuration state ──────────────────────────────────────────────────
  const [fadeThreshold, setFadeThreshold] = useState(5.0)
  const [fadeDuration, setFadeDuration] = useState(1.5)
  const [trimStartBuffer, setTrimStartBuffer] = useState(0.5)
  const [trimEndBuffer, setTrimEndBuffer] = useState(0.5)
  const [overlayTemplateId, setOverlayTemplateId] = useState('')
  const [selectedPresetId, setSelectedPresetId] = useState('youtube_1080p60')
  const [showConfig, setShowConfig] = useState(true)
  const [showLog, setShowLog] = useState(true)

  useEffect(() => {
    fetchStatus()
    fetchPresets()
  }, [fetchStatus, fetchPresets])

  // ── Derived state ────────────────────────────────────────────────────────
  const isActive = !!activeJob
  const currentStep = activeJob?.step || null
  const stepMeta = currentStep ? STEP_META[currentStep] : null
  const progressPct = activeJob?.progress_pct || 0
  const segIdx = activeJob?.segment_index ?? 0
  const totalSegs = activeJob?.total_segments ?? 0

  // Count segments by section
  const sectionCounts = useMemo(() => {
    const counts = { intro: 0, qualifying: 0, race: 0, results: 0 }
    for (const seg of script) {
      const sec = seg.section || 'race'
      if (sec in counts) counts[sec]++
    }
    return counts
  }, [script])

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    if (!clipsManifest.length) {
      showError('No captured clips — run capture step first')
      return
    }
    if (!script.length) {
      showError('No script — configure the editing step first')
      return
    }

    const result = await startComposition({
      projectId,
      script,
      clipsManifest,
      overlayConfig: overlayTemplateId
        ? { template_id: overlayTemplateId, per_section: {} }
        : null,
      transitionConfig: {
        fade_threshold: fadeThreshold,
        fade_duration: fadeDuration,
      },
      trimConfig: {
        trim_start_buffer: trimStartBuffer,
        trim_end_buffer: trimEndBuffer,
      },
      outputDir,
      presetId: selectedPresetId,
    })

    if (result.success) {
      showSuccess('Composition pipeline started')
    } else {
      showError(result.error || 'Failed to start composition')
    }
  }, [
    projectId, script, clipsManifest, overlayTemplateId,
    fadeThreshold, fadeDuration, trimStartBuffer, trimEndBuffer,
    outputDir, selectedPresetId, startComposition, showSuccess, showError,
  ])

  const handleCancel = useCallback(async () => {
    if (!activeJob?.job_id) return
    const result = await cancelComposition(activeJob.job_id)
    if (result.success) {
      showSuccess('Composition cancelled')
    } else {
      showError(result.error || 'Failed to cancel')
    }
  }, [activeJob, cancelComposition, showSuccess, showError])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-bg-secondary shrink-0">
        <Film className="w-5 h-5 text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">Compose & Encode</h2>
        <div className="flex-1" />
        {isActive && (
          <span className="px-2 py-0.5 rounded-full text-xxs font-medium border border-accent/30 text-accent bg-accent/5">
            Composing…
          </span>
        )}
        {!isActive && (
          <span className="px-2 py-0.5 rounded-full text-xxs font-medium border border-border text-text-tertiary bg-bg-primary">
            Ready
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* ── Active Job: Progress View ─────────────────────────────────── */}
        {isActive && (
          <div className="p-4 space-y-4">
            {/* Large progress */}
            <div className="bg-bg-secondary rounded-xl border border-border p-6 space-y-4">
              {/* Step indicator */}
              <div className="flex items-center gap-3">
                {stepMeta && (
                  <>
                    <stepMeta.icon className={`w-6 h-6 ${stepMeta.color}`} />
                    <div>
                      <h3 className="text-base font-bold text-text-primary">{stepMeta.label}</h3>
                      <p className="text-xs text-text-secondary">
                        Segment {segIdx + 1} of {totalSegs}
                      </p>
                    </div>
                  </>
                )}
                {!stepMeta && (
                  <>
                    <Loader2 className="w-6 h-6 text-accent animate-spin" />
                    <h3 className="text-base font-bold text-text-primary">Processing…</h3>
                  </>
                )}
              </div>

              {/* Main progress bar */}
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-text-secondary font-medium">Overall Progress</span>
                  <span className="font-mono text-text-primary">{progressPct.toFixed(1)}%</span>
                </div>
                <div className="w-full bg-bg-primary rounded-full h-4 overflow-hidden border border-border">
                  <div
                    className="h-full rounded-full transition-all duration-500 bg-gradient-to-r from-accent to-accent-hover"
                    style={{ width: `${Math.min(100, progressPct)}%` }}
                  />
                </div>
              </div>

              {/* Step progress pills */}
              <div className="flex gap-1">
                {Object.entries(STEP_META).map(([key, meta]) => {
                  const isCurrentStep = currentStep === key
                  const isPast = progressPct > meta.range[1]
                  const isFuture = progressPct < meta.range[0]

                  return (
                    <div
                      key={key}
                      className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md text-xxs font-medium transition-colors
                        ${isCurrentStep
                          ? 'bg-accent/10 border border-accent/40 text-accent'
                          : isPast
                            ? 'bg-success/10 border border-success/30 text-success'
                            : 'bg-bg-primary border border-border text-text-disabled'
                        }`}
                    >
                      {isPast && <CheckCircle2 className="w-3 h-3" />}
                      {isCurrentStep && <Loader2 className="w-3 h-3 animate-spin" />}
                      <meta.icon className="w-3 h-3" />
                      <span className="hidden sm:inline">{meta.label.split(' ')[0]}</span>
                    </div>
                  )
                })}
              </div>

              {/* Cancel button */}
              <button
                onClick={handleCancel}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs
                  font-medium bg-danger hover:bg-danger/90 text-white transition-colors"
              >
                <Square className="w-3.5 h-3.5" />
                Cancel Composition
              </button>
            </div>

            {/* Log entries */}
            <LogViewer
              entries={logEntries}
              expanded={showLog}
              onToggle={() => setShowLog(v => !v)}
            />
          </div>
        )}

        {/* ── Configuration (when not composing) ────────────────────────── */}
        {!isActive && (
          <div className="p-4 space-y-4">
            {/* Script summary */}
            <Section icon={BarChart2} title="Script Summary">
              <div className="grid grid-cols-4 gap-2">
                {Object.entries(sectionCounts).map(([sec, count]) => (
                  <div key={sec} className="bg-bg-primary border border-border rounded-md px-3 py-2 text-center">
                    <div className="text-sm font-mono font-bold text-text-primary">{count}</div>
                    <div className="text-xxs text-text-tertiary capitalize">{sec}</div>
                  </div>
                ))}
              </div>
              <p className="text-xxs text-text-tertiary mt-1.5">
                {script.length} total segments · {clipsManifest.length} captured clips
              </p>
            </Section>

            {/* Transition config */}
            <Section
              icon={Film}
              title="Transitions"
              collapsible
              expanded={showConfig}
              onToggle={() => setShowConfig(v => !v)}
            >
              <div className="space-y-3">
                <ConfigSlider
                  label="Fade Threshold"
                  description="Insert fade-to-black when gap between events exceeds this duration"
                  value={fadeThreshold}
                  onChange={setFadeThreshold}
                  min={1}
                  max={30}
                  step={0.5}
                  unit="s"
                />
                <ConfigSlider
                  label="Fade Duration"
                  description="Duration of the fade-to-black transition clip"
                  value={fadeDuration}
                  onChange={setFadeDuration}
                  min={0.5}
                  max={5}
                  step={0.25}
                  unit="s"
                />
              </div>
            </Section>

            {/* Trim config */}
            <Section icon={Scissors} title="Clip Trimming">
              <div className="space-y-3">
                <ConfigSlider
                  label="Trim Start Buffer"
                  description="Seconds to trim from the start of each captured clip's pre-roll"
                  value={trimStartBuffer}
                  onChange={setTrimStartBuffer}
                  min={0}
                  max={5}
                  step={0.1}
                  unit="s"
                />
                <ConfigSlider
                  label="Trim End Buffer"
                  description="Seconds to trim from the end of each captured clip's post-roll"
                  value={trimEndBuffer}
                  onChange={setTrimEndBuffer}
                  min={0}
                  max={5}
                  step={0.1}
                  unit="s"
                />
              </div>
            </Section>

            {/* Overlay template */}
            <Section icon={Layers} title="Overlay Template">
              <input
                type="text"
                value={overlayTemplateId}
                onChange={e => setOverlayTemplateId(e.target.value)}
                placeholder="e.g. broadcast (leave empty to skip overlays)"
                className="w-full bg-bg-primary border border-border rounded-md px-3 py-2
                  text-xs text-text-primary placeholder:text-text-disabled
                  focus:outline-none focus:ring-1 focus:ring-accent font-mono"
              />
              <p className="text-xxs text-text-tertiary mt-1">
                The overlay template used during composition. Leave empty to skip overlay rendering.
              </p>
            </Section>

            {/* Encoding preset */}
            <Section icon={Zap} title="Encoding Preset">
              <select
                value={selectedPresetId}
                onChange={e => setSelectedPresetId(e.target.value)}
                className="w-full bg-bg-primary border border-border rounded-md px-3 py-2
                  text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              >
                {encodingPresets.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
                {encodingPresets.length === 0 && (
                  <option value="youtube_1080p60">YouTube 1080p60 (default)</option>
                )}
              </select>
            </Section>

            {/* Start button */}
            <button
              onClick={handleStart}
              disabled={loading || !clipsManifest.length || !script.length}
              className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm
                font-semibold transition-colors
                ${loading || !clipsManifest.length || !script.length
                  ? 'bg-accent/50 text-white cursor-not-allowed'
                  : 'bg-accent hover:bg-accent-hover text-white shadow-lg shadow-accent/20'
                }`}
            >
              <Play className="w-4 h-4" />
              Start Composition
            </button>

            {!clipsManifest.length && (
              <div className="flex items-start gap-2 px-3 py-2 bg-warning/5 border border-warning/30 rounded-md">
                <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
                <p className="text-xxs text-warning">
                  No captured clips available. Complete the Capture step first.
                </p>
              </div>
            )}

            {/* Recent jobs */}
            {recentJobs.length > 0 && (
              <Section icon={CheckCircle2} title="Recent Compositions">
                <div className="space-y-1.5">
                  {recentJobs.slice(0, 5).map(job => (
                    <div
                      key={job.job_id}
                      className={`flex items-center gap-2 px-3 py-2 rounded-md border
                        ${job.state === 'completed'
                          ? 'bg-success/5 border-success/30'
                          : 'bg-danger/5 border-danger/30'
                        }`}
                    >
                      {job.state === 'completed' ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-danger shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-text-secondary truncate">
                          {job.clip_count || '?'} clips · {job.preset_id || 'custom'}
                        </div>
                        {job.elapsed_seconds > 0 && (
                          <div className="text-xxs text-text-tertiary">
                            {formatTime(job.elapsed_seconds)}
                          </div>
                        )}
                        {job.error && (
                          <div className="text-xxs text-danger truncate">{job.error}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Error display */}
            {error && (
              <div className="flex items-start gap-2 px-3 py-2.5 bg-danger/5 border border-danger/30 rounded-md">
                <XCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs text-danger font-medium">Error</p>
                  <p className="text-xxs text-danger/80 mt-0.5">{error}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}


// ── Helper Components ──────────────────────────────────────────────────────

function Section({ icon: Icon, title, children, collapsible, expanded, onToggle }) {
  const [localExpanded, setLocalExpanded] = useState(true)
  const isExpanded = collapsible ? (expanded ?? localExpanded) : true
  const toggle = collapsible ? (onToggle || (() => setLocalExpanded(v => !v))) : undefined

  return (
    <div className="space-y-2">
      <button
        onClick={toggle}
        disabled={!collapsible}
        className={`flex items-center gap-1.5 w-full text-left ${collapsible ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <Icon className="w-3.5 h-3.5 text-text-tertiary" />
        <h3 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider flex-1">{title}</h3>
        {collapsible && (
          isExpanded
            ? <ChevronDown className="w-3 h-3 text-text-disabled" />
            : <ChevronRight className="w-3 h-3 text-text-disabled" />
        )}
      </button>
      {isExpanded && children}
    </div>
  )
}


function ConfigSlider({ label, description, value, onChange, min, max, step, unit }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs text-text-secondary">{label}</label>
        <span className="text-xs font-mono text-text-primary">{value}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 bg-bg-primary rounded-full appearance-none cursor-pointer
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:cursor-pointer"
      />
      {description && (
        <p className="text-xxs text-text-disabled">{description}</p>
      )}
    </div>
  )
}


function LogViewer({ entries = [], expanded, onToggle }) {
  return (
    <div className="bg-bg-secondary rounded-lg border border-border overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-bg-hover transition-colors"
      >
        <Eye className="w-3.5 h-3.5 text-text-tertiary" />
        <h3 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider flex-1 text-left">
          Composition Log ({entries.length})
        </h3>
        {expanded
          ? <ChevronDown className="w-3 h-3 text-text-disabled" />
          : <ChevronRight className="w-3 h-3 text-text-disabled" />
        }
      </button>

      {expanded && (
        <div className="max-h-60 overflow-y-auto border-t border-border">
          {entries.length === 0 ? (
            <div className="px-4 py-3 text-xs text-text-disabled text-center">
              No log entries yet…
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {entries.map((entry, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-2 px-4 py-1.5 text-xxs ${
                    entry.success === false ? 'bg-danger/5' : ''
                  }`}
                >
                  {entry.success === false ? (
                    <XCircle className="w-3 h-3 text-danger shrink-0 mt-0.5" />
                  ) : (
                    <CheckCircle2 className="w-3 h-3 text-success/60 shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 min-w-0">
                    <span className="font-mono text-text-tertiary mr-2">[{entry.step_name}]</span>
                    <span className={entry.success === false ? 'text-danger' : 'text-text-secondary'}>
                      {entry.detail}
                    </span>
                    {entry.segment_id && (
                      <span className="text-text-disabled ml-1">({entry.segment_id})</span>
                    )}
                  </div>
                  <span className="text-text-disabled font-mono shrink-0">
                    {entry.progress_pct?.toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
