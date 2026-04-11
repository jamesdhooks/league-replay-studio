import { useMemo, useState, useRef, useEffect } from 'react'
import { useCapture } from '../../context/CaptureContext'
import { useScriptState, CAPTURE_STATES } from '../../context/ScriptStateContext'
import {
  Film, Loader2, CheckCircle2, XCircle,
  Clapperboard, Trophy, Flag, Star, FileVideo,
  ChevronDown, ChevronRight, AlertTriangle,
  Radio, Camera, Repeat, Clock, ArrowRight, Circle,
} from 'lucide-react'

// ── Section metadata ──────────────────────────────────────────────────────

const SECTION_META = {
  intro:               { label: 'Intro',          color: 'bg-purple-500/20 text-purple-300 border-purple-500/30', barColor: 'bg-purple-500' },
  qualifying_results:  { label: 'Qualifying',      color: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30', barColor: 'bg-cyan-500' },
  race:                { label: 'Race',            color: 'bg-green-500/20 text-green-300 border-green-500/30', barColor: 'bg-green-500' },
  race_results:        { label: 'Results',         color: 'bg-amber-500/20 text-amber-300 border-amber-500/30', barColor: 'bg-amber-500' },
}

const SECTION_ICONS = {
  intro:              Star,
  qualifying_results: Flag,
  race:               Clapperboard,
  race_results:       Trophy,
}

function SectionBadge({ section }) {
  const meta = SECTION_META[section] || { label: section, color: 'bg-bg-tertiary text-text-tertiary border-border' }
  const Icon = SECTION_ICONS[section] || Film
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xxs font-medium border ${meta.color}`}>
      <Icon className="w-2.5 h-2.5" />
      {meta.label}
    </span>
  )
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '—'
  const s = Math.round(seconds)
  const m = Math.floor(s / 60)
  const rem = s % 60
  return m > 0 ? `${m}:${String(rem).padStart(2, '0')}` : `${rem}s`
}

function formatTimestamp(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const LOG_ACTION_ICONS = {
  seek: '🎯',
  camera: '📷',
  driver: '🏎️',
  camera_schedule: '🔄',
  record_start: '⏺️',
  record_stop: '⏹️',
  validate: '✅',
  retry: '🔁',
  error: '❌',
  info: 'ℹ️',
}

// ── Script Timeline (read-only, progress bars) ────────────────────────────

function ScriptTimeline({ strategies, currentSegmentId, completedIndex, totalSegments, segmentStates }) {
  if (!strategies?.length) return null

  const totalDuration = strategies.reduce((sum, s) => sum + (s.duration || 0), 0)
  if (totalDuration <= 0) return null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Film className="w-3 h-3 text-text-tertiary" />
        <span className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">
          Script Timeline
        </span>
        <span className="text-xxs text-text-disabled ml-auto tabular-nums">
          {formatDuration(totalDuration)} total
        </span>
      </div>

      {/* Timeline bar */}
      <div className="flex gap-px h-6 rounded overflow-hidden bg-bg-primary border border-border">
        {strategies.map((strat, idx) => {
          const widthPct = Math.max(0.5, (strat.duration / totalDuration) * 100)
          const meta = SECTION_META[strat.section] || SECTION_META.race
          const isCurrent = strat.segment_id === currentSegmentId
          const isCompleted = idx < (completedIndex ?? -1)
          const isPending = idx > (completedIndex ?? -1) && !isCurrent
          // Capture state from persistent tracking
          const captState = segmentStates?.[strat.segment_id]?.capture_state

          let bgClass = 'bg-bg-tertiary/50'
          if (captState === 'captured') bgClass = meta.barColor + '/70'
          else if (captState === 'invalidated') bgClass = 'bg-amber-500/40'
          else if (isCompleted) bgClass = meta.barColor + '/60'
          else if (isCurrent) bgClass = meta.barColor + ' animate-pulse'
          else if (isPending) bgClass = 'bg-bg-tertiary/30'

          const isContiguous = strat.contiguous_with_prev
          const isPip = strat.is_pip || strat.type === 'pip'

          return (
            <div
              key={strat.segment_id || idx}
              className={`relative ${bgClass} transition-all duration-300`}
              style={{ width: `${widthPct}%`, minWidth: '3px' }}
              title={`${strat.segment_id}\n${strat.section} / ${strat.event_type || strat.type}\n${formatDuration(strat.duration)}\n${strat.strategy === 'continue' ? '↔ Contiguous' : '⏺ New recording'}${captState ? `\n● ${captState}` : ''}${isPip ? '\n🖼 PiP segment' : ''}`}
            >
              {/* Contiguous indicator — thin line connecting to previous */}
              {isContiguous && (
                <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent/50" />
              )}

              {/* Current indicator glow */}
              {isCurrent && (
                <div className="absolute inset-0 ring-1 ring-accent ring-inset rounded-sm" />
              )}

              {/* Capture state dot */}
              {captState === 'captured' && (
                <div className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-green-400" />
              )}
              {captState === 'invalidated' && (
                <div className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400" />
              )}

              {/* PiP indicator */}
              {isPip && (
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-blue-500/60" />
              )}
            </div>
          )
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 flex-wrap">
        {Object.entries(SECTION_META).map(([key, meta]) => {
          const count = strategies.filter(s => s.section === key).length
          if (count === 0) return null
          return (
            <span key={key} className="flex items-center gap-1 text-xxs text-text-disabled">
              <span className={`w-2 h-2 rounded-sm ${meta.barColor}/60`} />
              {meta.label} ({count})
            </span>
          )
        })}
        <span className="flex items-center gap-1 text-xxs text-text-disabled">
          <ArrowRight className="w-2.5 h-2.5" />
          = contiguous
        </span>
        {Object.values(segmentStates || {}).some(s => s.capture_state === 'captured') && (
          <span className="flex items-center gap-1 text-xxs text-green-400">
            <CheckCircle2 className="w-2.5 h-2.5" />
            = captured
          </span>
        )}
        {Object.values(segmentStates || {}).some(s => s.capture_state === 'invalidated') && (
          <span className="flex items-center gap-1 text-xxs text-amber-400">
            <AlertTriangle className="w-2.5 h-2.5" />
            = invalidated
          </span>
        )}
      </div>
    </div>
  )
}

// ── Capture Action Log ────────────────────────────────────────────────────

function CaptureActionLog({ log, maxVisible = 50 }) {
  const [expanded, setExpanded] = useState(false)
  const scrollRef = useRef(null)
  const prevCountRef = useRef(0)

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (log.length > prevCountRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    prevCountRef.current = log.length
  }, [log.length])

  if (!log?.length) return null

  const displayLog = expanded ? log : log.slice(-maxVisible)

  return (
    <div className="space-y-1">
      <button
        onClick={() => setExpanded(prev => !prev)}
        aria-label={expanded ? 'Collapse capture log' : 'Expand capture log'}
        className="flex items-center gap-1.5 text-xxs font-semibold text-text-tertiary uppercase
                   tracking-wider hover:text-text-secondary transition-colors"
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <Radio className="w-3 h-3" />
        Capture Log ({log.length} entries)
      </button>

      {expanded && (
        <div
          ref={scrollRef}
          className="max-h-48 overflow-y-auto bg-bg-primary border border-border rounded-md
                     font-mono text-xxs divide-y divide-border-subtle"
        >
          {displayLog.map((entry, idx) => (
            <div
              key={idx}
              className={`flex items-start gap-2 px-2 py-1 ${
                !entry.success ? 'bg-danger/5' : ''
              }`}
            >
              <span className="shrink-0 w-4 text-center">
                {LOG_ACTION_ICONS[entry.action] || '•'}
              </span>
              <span className="shrink-0 text-text-disabled w-14 tabular-nums">
                {formatTimestamp(entry.timestamp)}
              </span>
              {entry.segment_id && (
                <span className="shrink-0 text-accent/70 w-16 truncate" title={entry.segment_id}>
                  {entry.segment_id}
                </span>
              )}
              <span className={`flex-1 truncate ${entry.success ? 'text-text-secondary' : 'text-danger'}`}
                    title={entry.detail}>
                {entry.detail}
              </span>
              {entry.attempt > 1 && (
                <span className="shrink-0 text-warning tabular-nums">
                  ×{entry.attempt}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Segment Strategy Card ─────────────────────────────────────────────────

function SegmentStrategyCard({ strategy, isCurrent, isCompleted }) {
  const meta = SECTION_META[strategy.section] || SECTION_META.race
  const Icon = SECTION_ICONS[strategy.section] || Film

  return (
    <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border transition-all
      ${isCurrent
        ? 'border-accent bg-accent/10 ring-1 ring-accent/30'
        : isCompleted
          ? 'border-success/30 bg-success/5'
          : 'border-border bg-bg-primary'
      }`}
    >
      <div className="shrink-0">
        {isCurrent ? (
          <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" />
        ) : isCompleted ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-success" />
        ) : (
          <Icon className="w-3.5 h-3.5 text-text-disabled" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xxs font-medium text-text-primary truncate">
            {strategy.segment_id}
          </span>
          <SectionBadge section={strategy.section} />
        </div>
        <div className="flex items-center gap-2 text-xxs text-text-disabled mt-0.5">
          <span>{strategy.event_type || strategy.type}</span>
          <span>·</span>
          <span className="tabular-nums">{formatDuration(strategy.duration)}</span>
          {strategy.strategy === 'continue' ? (
            <span className="flex items-center gap-0.5 text-accent/60">
              <ArrowRight className="w-2.5 h-2.5" /> cont.
            </span>
          ) : (
            <span className="flex items-center gap-0.5">
              <Camera className="w-2.5 h-2.5" /> new rec.
            </span>
          )}
          {strategy.has_camera_schedule && (
            <span className="flex items-center gap-0.5">
              <Repeat className="w-2.5 h-2.5" /> sched.
            </span>
          )}
        </div>
      </div>

      <span className="text-xxs text-text-disabled tabular-nums shrink-0">
        {formatDuration(strategy.start_time)}
      </span>
    </div>
  )
}


// ── ClipsPanel ────────────────────────────────────────────────────────────

/**
 * ClipsPanel — Shows script capture progress, timeline, action log, and clips.
 *
 * Displays:
 * - Script timeline visualization with progress bars for each segment
 * - Live action log showing all commands, validations, and retries
 * - Segment strategy cards showing each segment's capture plan
 * - Captured clips list with section badges and metadata
 * - Compiled video status
 */
export default function ClipsPanel({ projectId }) {
  const {
    scriptCaptureRunning,
    scriptCaptureProgress,
    scriptCaptureClips,
    scriptCompiledPath,
    scriptCaptureError,
    scriptCaptureLog,
    scriptCaptureStrategies,
    scriptCurrentSegment,
    cancelScriptCapture,
  } = useCapture()
  const { segments: segmentStates } = useScriptState()

  const [showStrategies, setShowStrategies] = useState(false)

  // Group clips by section for the summary row
  const sectionCounts = useMemo(() => {
    const counts = {}
    for (const clip of scriptCaptureClips) {
      const s = clip.section || 'race'
      counts[s] = (counts[s] || 0) + 1
    }
    return counts
  }, [scriptCaptureClips])

  // Count errors and retries in the log
  const logStats = useMemo(() => {
    let errors = 0
    let retries = 0
    for (const entry of scriptCaptureLog) {
      if (!entry.success) errors++
      if (entry.action === 'retry') retries++
    }
    return { errors, retries }
  }, [scriptCaptureLog])

  const completedIndex = scriptCaptureProgress?.segment_index ?? -1
  const currentSegmentId = scriptCurrentSegment?.segment_id

  const hasContent = scriptCaptureRunning || scriptCaptureClips.length > 0 ||
    scriptCaptureError || scriptCaptureStrategies.length > 0

  if (!hasContent) return null

  return (
    <div className="space-y-3">
      {/* ── Script Timeline Visualization ──────────────────────────────── */}
      {scriptCaptureStrategies.length > 0 && (
        <ScriptTimeline
          strategies={scriptCaptureStrategies}
          currentSegmentId={currentSegmentId}
          completedIndex={completedIndex}
          totalSegments={scriptCaptureProgress?.segment_total || scriptCaptureStrategies.length}
          segmentStates={segmentStates}
        />
      )}

      {/* ── Progress bar (while running) ──────────────────────────────── */}
      {scriptCaptureRunning && (
        <div className="bg-bg-secondary border border-border rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" />
              <span className="text-xs font-medium text-text-primary">
                Script Capture In Progress
              </span>
            </div>
            <div className="flex items-center gap-2">
              {logStats.errors > 0 && (
                <span className="flex items-center gap-1 text-xxs text-warning">
                  <AlertTriangle className="w-3 h-3" />
                  {logStats.errors} {logStats.errors === 1 ? 'issue' : 'issues'}
                </span>
              )}
              <button
                onClick={cancelScriptCapture}
                className="text-xxs text-danger hover:text-danger/80 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>

          {scriptCaptureProgress && (
            <>
              <div className="h-1.5 bg-bg-primary rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-all duration-300"
                  style={{ width: `${Math.min(100, scriptCaptureProgress.percentage || 0)}%` }}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xxs text-text-tertiary">
                  {scriptCaptureProgress.message || ''}
                </span>
                <span className="text-xxs text-text-tertiary tabular-nums">
                  {scriptCaptureProgress.percentage != null
                    ? `${Math.round(scriptCaptureProgress.percentage)}%`
                    : ''}
                </span>
              </div>
              {scriptCaptureProgress.section && (
                <div className="flex items-center gap-2">
                  <SectionBadge section={scriptCaptureProgress.section} />
                  {scriptCaptureProgress.strategy && (
                    <span className="text-xxs text-text-disabled">
                      {scriptCaptureProgress.strategy.strategy === 'continue'
                        ? '↔ Continuous recording'
                        : '⏺ New recording pass'}
                    </span>
                  )}
                </div>
              )}
            </>
          )}

          {/* Current segment info */}
          {scriptCurrentSegment && (
            <div className="flex items-center gap-2 px-2 py-1 bg-bg-primary/50 rounded text-xxs">
              <Camera className="w-3 h-3 text-accent" />
              <span className="text-text-secondary font-medium">
                {scriptCurrentSegment.segment_id}
              </span>
              <span className="text-text-disabled">
                {scriptCurrentSegment.segment_type}
              </span>
              {scriptCurrentSegment.strategy?.strategy === 'continue' && (
                <span className="text-accent/60">↔ cont.</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Error ─────────────────────────────────────────────────────── */}
      {scriptCaptureError && !scriptCaptureRunning && (
        <div className="flex items-start gap-2 px-3 py-2.5 bg-danger/5 border border-danger/30 rounded-md">
          <XCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
          <div>
            <p className="text-xs text-danger font-medium">Script Capture Failed</p>
            <p className="text-xxs text-danger/80 mt-0.5">{scriptCaptureError}</p>
          </div>
        </div>
      )}

      {/* ── Capture Action Log ─────────────────────────────────────────── */}
      <CaptureActionLog log={scriptCaptureLog} />

      {/* ── Segment Strategies (collapsible) ───────────────────────────── */}
      {scriptCaptureStrategies.length > 0 && (
        <div className="space-y-1">
          <button
            onClick={() => setShowStrategies(prev => !prev)}
            aria-label={showStrategies ? 'Collapse segment strategies' : 'Expand segment strategies'}
            className="flex items-center gap-1.5 text-xxs font-semibold text-text-tertiary uppercase
                       tracking-wider hover:text-text-secondary transition-colors"
          >
            {showStrategies ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <Clock className="w-3 h-3" />
            Segment Strategies ({scriptCaptureStrategies.length})
          </button>

          {showStrategies && (
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {scriptCaptureStrategies.map((strat, idx) => (
                <SegmentStrategyCard
                  key={strat.segment_id || idx}
                  strategy={strat}
                  isCurrent={strat.segment_id === currentSegmentId}
                  isCompleted={idx < completedIndex}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Compiled video ────────────────────────────────────────────── */}
      {scriptCompiledPath && (
        <div className="flex items-center gap-2 px-3 py-2 bg-success/5 border border-success/30 rounded-md">
          <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-success">Compiled Video Ready</p>
            <p className="text-xxs text-text-tertiary font-mono truncate" title={scriptCompiledPath}>
              {scriptCompiledPath.split(/[/\\]/).pop()}
            </p>
          </div>
        </div>
      )}

      {/* ── Clips list ────────────────────────────────────────────────── */}
      {scriptCaptureClips.length > 0 && (
        <div className="space-y-1">
          {/* Summary row */}
          <div className="flex items-center gap-2 flex-wrap">
            <Film className="w-3.5 h-3.5 text-text-tertiary" />
            <span className="text-xxs text-text-tertiary font-semibold uppercase tracking-wider">
              {scriptCaptureClips.length} Clip{scriptCaptureClips.length !== 1 ? 's' : ''} Captured
            </span>
            <span className="text-xxs text-text-disabled">·</span>
            {Object.entries(sectionCounts).map(([section, count]) => (
              <span key={section} className="text-xxs text-text-disabled">
                {count}× {SECTION_META[section]?.label || section}
              </span>
            ))}
            {logStats.retries > 0 && (
              <>
                <span className="text-xxs text-text-disabled">·</span>
                <span className="text-xxs text-warning">
                  {logStats.retries} retries
                </span>
              </>
            )}
          </div>

          {/* Individual clips */}
          <div className="rounded-md border border-border overflow-hidden">
            {scriptCaptureClips.map((clip, index) => {
              const duration = clip.end_time_seconds != null && clip.start_time_seconds != null
                ? clip.end_time_seconds - clip.start_time_seconds
                : clip.duration

              return (
                <div
                  key={clip.id || index}
                  className={`flex items-center gap-2 px-3 py-1.5 text-xxs
                    ${index < scriptCaptureClips.length - 1 ? 'border-b border-border-subtle' : ''}
                    bg-bg-primary hover:bg-bg-hover transition-colors`}
                >
                  <FileVideo className="w-3 h-3 text-text-disabled shrink-0" />

                  {/* Clip ID */}
                  <span className="font-mono text-text-tertiary w-24 truncate shrink-0" title={clip.id}>
                    {clip.id || `clip_${index}`}
                  </span>

                  {/* Section badge */}
                  <SectionBadge section={clip.section || 'race'} />

                  {/* Segments covered */}
                  {clip.segments?.length > 1 && (
                    <span className="text-text-disabled" title={clip.segments.join(', ')}>
                      {clip.segments.length} segs
                    </span>
                  )}

                  {/* Duration */}
                  {duration != null && (
                    <span className="text-text-disabled tabular-nums ml-auto">
                      {formatDuration(duration)}
                    </span>
                  )}

                  {/* Overlay template */}
                  {clip.overlay_template_id && (
                    <span className="text-text-disabled italic hidden sm:inline">
                      {clip.overlay_template_id}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
