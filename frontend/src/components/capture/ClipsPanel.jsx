import { useMemo } from 'react'
import { useCapture } from '../../context/CaptureContext'
import {
  Film, Loader2, CheckCircle2, XCircle,
  Clapperboard, Trophy, Flag, Star, FileVideo,
} from 'lucide-react'

// ── Section metadata ──────────────────────────────────────────────────────

const SECTION_META = {
  intro:               { label: 'Intro',          color: 'bg-purple-500/20 text-purple-300 border-purple-500/30' },
  qualifying_results:  { label: 'Qualifying',      color: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' },
  race:                { label: 'Race',            color: 'bg-green-500/20 text-green-300 border-green-500/30' },
  race_results:        { label: 'Results',         color: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
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

// ── ClipsPanel ────────────────────────────────────────────────────────────

/**
 * ClipsPanel — Shows the clips captured by the script capture engine.
 *
 * Displays a live progress indicator while `scriptCaptureRunning` is true,
 * then lists each captured clip with its section badge, ID, and duration.
 * A compiled-video row appears when `scriptCompiledPath` is set.
 *
 * @param {Object} props
 * @param {number} [props.projectId] - Active project ID (unused here, available for future use)
 */
export default function ClipsPanel({ projectId }) {
  const {
    scriptCaptureRunning,
    scriptCaptureProgress,
    scriptCaptureClips,
    scriptCompiledPath,
    scriptCaptureError,
    cancelScriptCapture,
  } = useCapture()

  // Group clips by section for the summary row
  const sectionCounts = useMemo(() => {
    const counts = {}
    for (const clip of scriptCaptureClips) {
      const s = clip.section || 'race'
      counts[s] = (counts[s] || 0) + 1
    }
    return counts
  }, [scriptCaptureClips])

  const hasContent = scriptCaptureRunning || scriptCaptureClips.length > 0 || scriptCaptureError

  if (!hasContent) return null

  return (
    <div className="space-y-2">
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
            <button
              onClick={cancelScriptCapture}
              className="text-xxs text-danger hover:text-danger/80 transition-colors"
            >
              Cancel
            </button>
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
                <SectionBadge section={scriptCaptureProgress.section} />
              )}
            </>
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
