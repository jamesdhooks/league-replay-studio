import { Play, Pause, SkipBack, SkipForward } from 'lucide-react'

/**
 * PlaybackControls — Unified compact transport bar.
 *
 * Modeled on the editing tab's compact strip.  Every playback surface
 * (analysis, editing, overlay, compose preview, …) should use this
 * single component so transport controls look and behave identically.
 *
 * Layout (left → right):
 *   [leftSlot] [◀ prev] [▶ play] [▶▶ next] [position] ═══progress═══ [centerSlot] [time] [drift] [speeds] [rightSlot]
 *
 * All sections are optional — omit a prop and that section disappears.
 */
export default function PlaybackControls({
  // ── Navigation ────────────────────────────────────────────────
  onPrev,
  onNext,
  prevDisabled = false,
  nextDisabled = false,
  prevTitle = 'Previous',
  nextTitle = 'Next',

  // ── Play / Pause ──────────────────────────────────────────────
  isPlaying = false,
  onPlayPause,
  playDisabled = false,
  playTitle,

  // ── Position indicator (e.g. "3 / 15") ────────────────────────
  position,

  // ── Progress bar (0‑1 fraction) ───────────────────────────────
  progress,

  // ── Time display ──────────────────────────────────────────────
  timeDisplay,

  // ── Drift badge ───────────────────────────────────────────────
  driftSeconds,
  driftTitle,

  // ── Speed selector ────────────────────────────────────────────
  speeds = [1, 2, 4, 8],
  activeSpeed = 1,
  onSpeedChange,

  // ── Slot content ──────────────────────────────────────────────
  leftSlot,
  centerSlot,
  rightSlot,

  // ── Styling overrides ─────────────────────────────────────────
  className = '',
}) {
  const effectivePlayTitle = playTitle ?? (isPlaying ? 'Pause' : 'Play')

  return (
    <div className={`flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-bg-primary shrink-0 ${className}`}>
      {/* Left slot — extra content before nav buttons */}
      {leftSlot}

      {/* Prev */}
      {onPrev && (
        <button
          onClick={onPrev}
          disabled={prevDisabled}
          title={prevTitle}
          className="p-1 rounded hover:bg-bg-secondary disabled:opacity-30 text-text-secondary hover:text-text-primary transition-colors"
        >
          <SkipBack size={12} />
        </button>
      )}

      {/* Play / Pause */}
      {onPlayPause && (
        <button
          onClick={onPlayPause}
          disabled={playDisabled}
          title={effectivePlayTitle}
          className="p-1 rounded transition-colors disabled:opacity-30 text-accent hover:text-accent-light hover:bg-accent/10"
        >
          {isPlaying ? <Pause size={13} /> : <Play size={13} />}
        </button>
      )}

      {/* Next */}
      {onNext && (
        <button
          onClick={onNext}
          disabled={nextDisabled}
          title={nextTitle}
          className="p-1 rounded hover:bg-bg-secondary disabled:opacity-30 text-text-secondary hover:text-text-primary transition-colors"
        >
          <SkipForward size={12} />
        </button>
      )}

      {/* Position indicator */}
      {position != null && (
        <span className="text-xxs font-mono text-text-disabled w-12 text-center shrink-0 whitespace-nowrap">
          {position}
        </span>
      )}

      {/* Progress bar */}
      {progress != null && (
        <div className="flex-1 h-1 bg-bg-secondary rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-300"
            style={{ width: `${Math.max(0, Math.min(100, progress * 100))}%` }}
          />
        </div>
      )}

      {/* Center slot — between progress and time/speeds */}
      {centerSlot}

      {/* Time display */}
      {timeDisplay != null && (
        <span
          title="Current time"
          className="shrink-0 font-mono tabular-nums text-xs font-semibold text-text-primary min-w-[4.5rem] text-right"
        >
          {timeDisplay}
        </span>
      )}

      {/* Drift badge */}
      {driftSeconds != null && (
        <span
          title={driftTitle || `Drift: ${driftSeconds > 0 ? '+' : ''}${driftSeconds.toFixed(2)}s`}
          className={`shrink-0 text-xxs font-mono px-1.5 py-0.5 rounded tabular-nums transition-colors ${
            Math.abs(driftSeconds) > 2
              ? 'bg-red-500/20 text-red-400'
              : Math.abs(driftSeconds) > 0.5
                ? 'bg-yellow-500/20 text-yellow-400'
                : 'bg-green-500/15 text-green-400'
          }`}
        >
          Δ{driftSeconds > 0 ? '+' : ''}{driftSeconds.toFixed(1)}s
        </span>
      )}

      {/* Speed selector */}
      {speeds && speeds.length > 0 && onSpeedChange && (
        <div className="flex items-center gap-px">
          {speeds.map(spd => (
            <button
              key={spd}
              onClick={() => onSpeedChange(spd)}
              className={`px-1.5 py-0.5 text-xxs font-mono rounded transition-colors ${
                activeSpeed === spd
                  ? 'bg-accent text-white'
                  : 'text-text-disabled hover:text-text-primary hover:bg-bg-secondary'
              }`}
              title={`${spd}× playback speed`}
            >
              {spd}×
            </button>
          ))}
        </div>
      )}

      {/* Right slot */}
      {rightSlot}
    </div>
  )
}
