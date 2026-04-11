import { memo, useState, useEffect, useRef } from 'react'
import { Eye, WifiOff, ChevronDown, ChevronRight, Activity } from 'lucide-react'
import { useIRacing } from '../../context/IRacingContext'
import { useHighlight, EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import PreviewPlayer from '../analysis/PreviewPlayer'
import { formatTime } from '../../utils/time'

/**
 * HighlightPreview — collapsible live stream panel for the editing view.
 *
 * Uses the same PreviewPlayer component as the Analysis step, giving it
 * identical controls: visibility toggle, stream reset, quality settings,
 * and window picker.
 *
 * Includes feed health monitoring with visual activity indicator and polling
 * fallback to detect stale feeds.
 */
export default memo(function HighlightPreview({ collapsed, onToggle }) {
  const { isConnected } = useIRacing()
  const { scriptActionLog } = useHighlight()
  const lastActionCountRef = useRef(0)
  const [isFeedActive, setIsFeedActive] = useState(false)
  const activeTimerRef = useRef(null)

  // Show last 4 actions in the feed (most recent at top)
  const recentActions = scriptActionLog.slice(-4).reverse()

  // Monitor for new actions: poll every 200ms to detect updates
  // If feed is being actively updated, show a pulsing indicator
  useEffect(() => {
    if (collapsed) return

    // Periodic health check: if we see new actions, mark as active
    const checkInterval = setInterval(() => {
      if (scriptActionLog.length > lastActionCountRef.current) {
        lastActionCountRef.current = scriptActionLog.length
        setIsFeedActive(true)
        // Reset active indicator after 800ms of no new updates
        if (activeTimerRef.current) clearTimeout(activeTimerRef.current)
        activeTimerRef.current = setTimeout(() => {
          setIsFeedActive(false)
        }, 800)
      }
    }, 200)

    return () => {
      clearInterval(checkInterval)
      if (activeTimerRef.current) clearTimeout(activeTimerRef.current)
    }
  }, [collapsed, scriptActionLog])

  return (
    <div className="h-full flex flex-col overflow-hidden border-b border-border bg-bg-secondary relative">
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
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* PreviewPlayer provides: stream feed, visibility toggle, quality settings, window picker, reset */}
          <PreviewPlayer />
        </div>
      )}

      {/* ── Script action feed (absolutely positioned, bottom-right) ─── */}
      {!collapsed && (
        <div className="absolute bottom-3 right-3 w-fit bg-bg-primary border border-border-subtle rounded px-3 py-2 space-y-1 shadow-lg">
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="text-[9px] uppercase tracking-wider text-text-tertiary font-semibold">Event Feed</div>
            {/* Activity indicator: pulsing dot when feed is receiving updates */}
            {isFeedActive && (
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-success animate-pulse"></div>
                <span className="text-[8px] text-success font-mono">LIVE</span>
              </div>
            )}
          </div>
          {recentActions.length > 0 ? (
            recentActions.map((action, i) => {
              const isLatest = i === 0
              const label = action.eventType
                ? (EVENT_TYPE_LABELS[action.eventType] || action.eventType)
                : (action.section ? action.section.replace('_', ' ') : 'Bridge')
              return (
                <div
                  key={action.id + action.ts}
                  className="flex items-center gap-2 text-right leading-snug"
                  style={{ opacity: isLatest ? 1 : Math.max(0.3, 1 - i * 0.25) }}
                >
                  <span className="text-[9px] text-text-disabled font-mono shrink-0">{formatTime(action.raceTime)}</span>
                  <span className={`text-[10px] font-semibold flex-1 truncate ${isLatest ? 'text-text-primary' : 'text-text-secondary'}`}>{label}</span>
                  {action.cameraLabel && (
                    <span className="text-[9px] text-indigo-300/80 font-mono shrink-0">{action.cameraLabel}</span>
                  )}
                  {action.driverName && (
                    <span className="text-[9px] text-emerald-300/80 shrink-0">{action.driverName}</span>
                  )}
                </div>
              )
            })
          ) : (
            <div className="text-[10px] text-text-disabled">No script actions yet. Press Play in the timeline to populate this feed.</div>
          )}
        </div>
      )}
    </div>
  )
})


