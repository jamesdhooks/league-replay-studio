import { memo } from 'react'
import { Eye, WifiOff, ChevronDown, ChevronRight } from 'lucide-react'
import { useIRacing } from '../../context/IRacingContext'
import { useHighlight, EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { useStream } from '../../hooks/useStream'
import { H264StreamPlayer, HlsStreamPlayer } from '../analysis/StreamPlayers'
import { formatTime } from '../../utils/time'

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
  const { scriptActionLog } = useHighlight()

  const {
    streamFormat,
    streamKey, setStreamKey,
    streamLoaded, setStreamLoaded,
    streamError, setStreamError,
    streamResetting, handleStreamReset,
    activeStreamUrl, streamUrl,
  } = useStream()

  // Show last 4 actions in the feed (most recent at top)
  const recentActions = scriptActionLog.slice(-4).reverse()

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

              {/* ── Script action feed ───────────────────────────────── */}
              {recentActions.length > 0 && (
                <div className="absolute bottom-2 right-2 flex flex-col gap-1 items-end pointer-events-none"
                     style={{ maxWidth: '60%' }}>
                  {recentActions.map((action, i) => {
                    const isLatest = i === 0
                    const label = action.eventType
                      ? (EVENT_TYPE_LABELS[action.eventType] || action.eventType)
                      : (action.section ? action.section.replace('_', ' ') : 'Bridge')
                    return (
                      <div
                        key={action.id + action.ts}
                        className="rounded px-2 py-1 text-right leading-snug"
                        style={{
                          background: isLatest ? 'rgba(0,0,0,0.82)' : 'rgba(0,0,0,0.52)',
                          border: isLatest ? '1px solid rgba(99,102,241,0.55)' : '1px solid rgba(255,255,255,0.08)',
                          opacity: isLatest ? 1 : Math.max(0.3, 1 - i * 0.25),
                        }}
                      >
                        <div className="text-[10px] font-semibold text-white/90">{label}</div>
                        {action.cameraLabel && (
                          <div className="text-[9px] text-indigo-300/80 font-mono">{action.cameraLabel}</div>
                        )}
                        {action.driverName && (
                          <div className="text-[9px] text-emerald-300/80">Focus: {action.driverName}</div>
                        )}
                        {action.involvedDrivers?.length > 1 && (
                          <div className="text-[8px] text-white/40 truncate">
                            {action.involvedDrivers.slice(0, 3).join(' · ')}{action.involvedDrivers.length > 3 ? ` +${action.involvedDrivers.length - 3}` : ''}
                          </div>
                        )}
                        <div className="text-[8px] text-white/30 font-mono">{formatTime(action.raceTime)}</div>
                      </div>
                    )
                  })}
                </div>
              )}
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
