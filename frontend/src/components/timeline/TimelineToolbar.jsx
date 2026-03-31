import { useTimeline } from '../../context/TimelineContext'
import { formatTime } from '../../utils/time'
import {
  ZoomIn, ZoomOut, Maximize2,
  SkipBack, Play, Pause, SkipForward,
  ArrowLeftToLine, ArrowRightToLine, X,
} from 'lucide-react'

/**
 * TimelineToolbar — controls above the timeline canvas.
 *
 * Shows: zoom controls, playback/shuttle controls, timecode display,
 * in/out point buttons, playback rate indicator.
 */
export default function TimelineToolbar() {
  const {
    pixelsPerSecond, zoomIn, zoomOut, zoomToFit,
    playheadTime, isPlaying, setIsPlaying, playbackRate,
    shuttleReverse, shuttleStop, shuttleForward,
    inPoint, outPoint, setInPointAtPlayhead, setOutPointAtPlayhead, clearInOutPoints,
    raceDuration,
  } = useTimeline()

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-bg-secondary shrink-0">
      {/* ── Zoom controls ── */}
      <div className="flex items-center gap-0.5 mr-2">
        <ToolButton onClick={zoomOut} title="Zoom out">
          <ZoomOut size={14} />
        </ToolButton>
        <span className="text-xxs text-text-tertiary font-mono w-12 text-center select-none">
          {pixelsPerSecond >= 1
            ? `${pixelsPerSecond.toFixed(0)}px/s`
            : `${(1/pixelsPerSecond).toFixed(0)}s/px`
          }
        </span>
        <ToolButton onClick={zoomIn} title="Zoom in">
          <ZoomIn size={14} />
        </ToolButton>
        <ToolButton onClick={zoomToFit} title="Zoom to fit">
          <Maximize2 size={14} />
        </ToolButton>
      </div>

      {/* ── Divider ── */}
      <div className="w-px h-5 bg-border mx-1" />

      {/* ── Shuttle controls (J/K/L) ── */}
      <div className="flex items-center gap-0.5 mr-2">
        <ToolButton
          onClick={shuttleReverse}
          title="Reverse (J)"
          active={playbackRate < 0}
        >
          <SkipBack size={14} />
        </ToolButton>
        <ToolButton
          onClick={() => isPlaying ? shuttleStop() : setIsPlaying(true)}
          title={isPlaying ? 'Pause (K)' : 'Play (K)'}
          active={isPlaying}
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        </ToolButton>
        <ToolButton
          onClick={shuttleForward}
          title="Forward (L)"
          active={playbackRate > 1}
        >
          <SkipForward size={14} />
        </ToolButton>
        {playbackRate !== 1 && playbackRate !== 0 && (
          <span className="text-xxs text-accent font-mono ml-1 select-none">
            {playbackRate > 0 ? `${playbackRate}×` : `${playbackRate}×`}
          </span>
        )}
      </div>

      {/* ── Divider ── */}
      <div className="w-px h-5 bg-border mx-1" />

      {/* ── Timecode display ── */}
      <div className="flex items-center gap-2 mr-2">
        <span className="text-xs font-mono text-text-primary select-none">
          {formatTime(playheadTime)}
        </span>
        <span className="text-xxs text-text-tertiary select-none">/</span>
        <span className="text-xs font-mono text-text-tertiary select-none">
          {formatTime(raceDuration)}
        </span>
      </div>

      {/* ── Divider ── */}
      <div className="w-px h-5 bg-border mx-1" />

      {/* ── In/Out controls ── */}
      <div className="flex items-center gap-0.5">
        <ToolButton
          onClick={setInPointAtPlayhead}
          title="Set in-point (I)"
          active={inPoint !== null}
        >
          <ArrowLeftToLine size={14} />
        </ToolButton>
        {inPoint !== null && (
          <span className="text-xxs text-success font-mono select-none">
            {formatTime(inPoint)}
          </span>
        )}
        <ToolButton
          onClick={setOutPointAtPlayhead}
          title="Set out-point (O)"
          active={outPoint !== null}
        >
          <ArrowRightToLine size={14} />
        </ToolButton>
        {outPoint !== null && (
          <span className="text-xxs text-danger font-mono select-none">
            {formatTime(outPoint)}
          </span>
        )}
        {(inPoint !== null || outPoint !== null) && (
          <ToolButton onClick={clearInOutPoints} title="Clear in/out points">
            <X size={12} />
          </ToolButton>
        )}
      </div>

      {/* ── Spacer ── */}
      <div className="flex-1" />

      {/* ── Keyboard hints ── */}
      <div className="hidden md:flex items-center gap-1.5 text-xxs text-text-disabled select-none">
        <kbd className="px-1 py-0.5 bg-surface rounded text-text-tertiary">J</kbd>
        <kbd className="px-1 py-0.5 bg-surface rounded text-text-tertiary">K</kbd>
        <kbd className="px-1 py-0.5 bg-surface rounded text-text-tertiary">L</kbd>
        <span className="mx-1">·</span>
        <kbd className="px-1 py-0.5 bg-surface rounded text-text-tertiary">I</kbd>
        <kbd className="px-1 py-0.5 bg-surface rounded text-text-tertiary">O</kbd>
        <span className="mx-1">·</span>
        <kbd className="px-1 py-0.5 bg-surface rounded text-text-tertiary">Scroll</kbd>
        <span>zoom</span>
      </div>
    </div>
  )
}

/**
 * Tiny toolbar button with hover/active states.
 */
function ToolButton({ children, onClick, title, active }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1 rounded transition-colors
        ${active
          ? 'bg-accent/20 text-accent'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
        }`}
    >
      {children}
    </button>
  )
}
