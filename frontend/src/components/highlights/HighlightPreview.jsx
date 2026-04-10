import { memo } from 'react'
import { Eye, WifiOff, ChevronDown, ChevronRight } from 'lucide-react'
import { useIRacing } from '../../context/IRacingContext'
import { useStream } from '../../hooks/useStream'
import { H264StreamPlayer, HlsStreamPlayer } from '../analysis/StreamPlayers'

/**
 * HighlightPreview — collapsible live stream panel for the editing view.
 *
 * Sits between the Score Histogram and the Final Script timeline.
 * Collapse state is lifted into HighlightPanel so opening this tab
 * automatically collapses the Score Histogram, and vice-versa.
 *
 * Props:
 *   collapsed  {boolean}  — controlled from HighlightPanel
 *   onToggle   {fn}       — called with no args when header is clicked
 */
export default memo(function HighlightPreview({ collapsed, onToggle }) {
  const { isConnected } = useIRacing()

  const {
    streamFormat,
    streamKey, setStreamKey,
    streamLoaded, setStreamLoaded,
    streamError, setStreamError,
    streamResetting, handleStreamReset,
    activeStreamUrl, streamUrl,
  } = useStream()

  return (
    <div className="h-full flex flex-col overflow-hidden border-b border-border bg-bg-secondary">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <button
        onClick={onToggle}
        className="flex items-center gap-2 px-3 py-2 w-full text-left hover:bg-bg-primary/40 transition-colors shrink-0"
      >
        {collapsed
          ? <ChevronRight className="w-3 h-3 text-text-tertiary shrink-0" />
          : <ChevronDown  className="w-3 h-3 text-text-tertiary shrink-0" />}
        <Eye className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="text-xs font-semibold text-text-primary uppercase tracking-wider flex-1">
          Preview
        </span>
        {!isConnected && (
          <span className="flex items-center gap-1 text-xxs text-text-disabled">
            <WifiOff className="w-3 h-3" /> Not connected
          </span>
        )}
      </button>

      {/* ── Body ─────────────────────────────────────────────────────── */}
      {!collapsed && (
        <div className="relative bg-black overflow-hidden" style={{ aspectRatio: '16/9', width: '100%' }}>
          {isConnected ? (
            <>
              {streamFormat === 'hls' ? (
                <HlsStreamPlayer
                  key={streamKey}
                  src={activeStreamUrl}
                  className="w-full h-full object-cover"
                  onLoad={() => setStreamLoaded(true)}
                  onError={(err) => setStreamError(err?.message || 'HLS stream error')}
                />
              ) : streamFormat === 'h264' ? (
                <H264StreamPlayer
                  key={streamKey}
                  src={activeStreamUrl}
                  className="w-full h-full object-cover"
                  onLoad={() => setStreamLoaded(true)}
                  onError={(err) => setStreamError(err?.message || 'H.264 stream error')}
                />
              ) : (
                <img
                  key={streamKey}
                  src={streamUrl}
                  alt="iRacing replay"
                  className="w-full h-full object-cover"
                  onError={() => setStreamError('MJPEG stream failed to load')}
                  onLoad={(e) => { e.target.style.opacity = '1'; setStreamLoaded(true) }}
                />
              )}

              {/* Loading overlay */}
              {streamResetting || (!streamLoaded && !streamError) ? (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                  <span className="text-xs text-white/60">
                    {streamResetting ? 'Resetting stream…' : 'Connecting…'}
                  </span>
                </div>
              ) : null}

              {/* Error overlay */}
              {streamError && !streamResetting && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 gap-2">
                  <span className="text-xs text-white/70">{streamError}</span>
                  <button
                    onClick={handleStreamReset}
                    className="px-3 py-1 rounded text-xxs bg-accent/20 text-accent border border-accent/30 hover:bg-accent/30"
                  >
                    Retry
                  </button>
                </div>
              )}

              {/* Reset button */}
              <button
                onClick={handleStreamReset}
                disabled={streamResetting}
                title="Hard-reset preview stream"
                className="absolute top-2 right-2 px-2 py-1 rounded text-xxs bg-black/70 text-white/70 hover:text-white border border-white/10 transition-colors disabled:opacity-40"
              >
                ↺
              </button>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-2 py-8">
              <WifiOff className="w-6 h-6 text-text-disabled opacity-40" />
              <span className="text-xs text-text-disabled">iRacing not connected</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
})
