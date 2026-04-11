import { memo, useState, useEffect, useRef } from 'react'
import { Eye, WifiOff, ChevronDown, ChevronRight, Zap } from 'lucide-react'
import { useIRacing } from '../../context/IRacingContext'
import { useHighlight, EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { EVENT_COLORS } from '../../context/TimelineContext'
import PreviewPlayer from '../analysis/PreviewPlayer'
import { formatTime } from '../../utils/time'

// Section accent colours — mirrors SECTION_STYLES in HighlightTimeline
const SECTION_TEXT_COLORS = {
  intro:               'rgba(192,165,255,0.95)',
  qualifying_results:  'rgba(103,232,249,0.95)',
  race:                'rgba(253,186,116,0.95)',
  race_results:        'rgba(134,239,172,0.95)',
}

function getEntryColor(action) {
  if (action.eventType === 'seek') return '#64748b'
  if (action.eventType && EVENT_COLORS[action.eventType]) return EVENT_COLORS[action.eventType]
  if (action.section && SECTION_TEXT_COLORS[action.section]) return SECTION_TEXT_COLORS[action.section]
  return '#94a3b8'
}

function getEntryLabel(action) {
  if (action.eventType === 'seek') return 'Seek'
  if (action.eventType) return EVENT_TYPE_LABELS[action.eventType] || action.eventType.replace(/_/g, ' ')
  if (action.section) return action.section.replace(/_/g, ' ')
  return 'Bridge'
}

function getCameraTextColor(action) {
  // Match HighlightTimeline camera track text color for race clips.
  if ((action.section || 'race') === 'race') return 'rgba(220,210,255,0.85)'
  // Non-race sections inherit their section accent text color.
  return SECTION_TEXT_COLORS[action.section] || 'rgba(220,210,255,0.85)'
}

/**
 * HighlightPreview — collapsible live preview + script event feed.
 *
 * The event feed is a dedicated collapsible section below the video stream,
 * showing all logged script actions in newest-at-bottom order with
 * animated entry for newly added rows and per-event colour coding.
 */
export default memo(function HighlightPreview({ collapsed, onToggle }) {
  const { isConnected } = useIRacing()
  const { scriptActionLog, clearScriptActionLog } = useHighlight()

  const [feedCollapsed, setFeedCollapsed] = useState(false)
  const prevLenRef   = useRef(0)
  const [newKeys, setNewKeys] = useState(new Set())
  const feedScrollRef = useRef(null)

  // Detect new entries → animate them in and keep viewport pinned to top
  useEffect(() => {
    if (scriptActionLog.length <= prevLenRef.current) return
    const fresh = new Set(
      scriptActionLog.slice(prevLenRef.current).map(a => `${a.id}_${a.ts}`)
    )
    prevLenRef.current = scriptActionLog.length
    setNewKeys(fresh)
    // Keep newest entries visible immediately at the top.
    requestAnimationFrame(() => {
      if (feedScrollRef.current) feedScrollRef.current.scrollTop = 0
    })
    // Keep highlight long enough to be noticeable.
    const t = setTimeout(() => setNewKeys(new Set()), 1200)
    return () => clearTimeout(t)
  }, [scriptActionLog])

  const orderedActions = [...scriptActionLog].reverse()

  const handleClearFeed = () => {
    prevLenRef.current = 0
    setNewKeys(new Set())
    clearScriptActionLog()
  }

  return (
    <>
      {/* Keyframe for new-entry slide-in animation */}
      <style>{`
        @keyframes lrs-feed-in {
          0%   { opacity: 0; transform: translateY(-10px) scale(0.94); }
          60%  { opacity: 1; transform: translateY(0)     scale(1.015); }
          100% { opacity: 1; transform: translateY(0)     scale(1); }
        }
        @keyframes lrs-feed-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(251, 191, 36, 0.55); }
          100% { box-shadow: 0 0 0 10px rgba(251, 191, 36, 0); }
        }
        .lrs-feed-new {
          animation: lrs-feed-in 0.5s cubic-bezier(0.16,1,0.3,1) both, lrs-feed-pulse 0.9s ease-out;
        }
      `}</style>

      <div className="h-full flex flex-col overflow-hidden border-b border-border bg-bg-secondary">
        {/* ── Preview header ───────────────────────────────────────────── */}
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

        {/* ── Expanded body ────────────────────────────────────────────── */}
        {!collapsed && (
          <div className="flex-1 min-h-0 overflow-hidden relative">
            {/* Video stream */}
            <PreviewPlayer />

            {/* ── Event feed overlay (bottom-right) ───────────────────── */}
            <div className="absolute right-3 bottom-3 w-[320px] max-w-[calc(100%-1.5rem)] border border-border rounded-lg bg-bg-primary shadow-xl">
              <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border-subtle/70 shrink-0">
                <button
                  type="button"
                  onClick={() => setFeedCollapsed(v => !v)}
                  className="flex items-center gap-1.5 min-w-0 flex-1 text-left hover:text-text-primary transition-colors"
                >
                  {feedCollapsed
                    ? <ChevronRight className="w-3 h-3 text-text-tertiary shrink-0" />
                    : <ChevronDown  className="w-3 h-3 text-text-tertiary shrink-0" />}
                  <Zap className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
                  <span className="text-[10px] font-semibold text-text-primary uppercase tracking-wide flex-1">
                    Event Feed
                  </span>
                </button>
                {scriptActionLog.length > 0 && (
                  <span className="text-[10px] text-text-tertiary font-mono">
                    {scriptActionLog.length}
                  </span>
                )}
                {scriptActionLog.length > 0 && (
                  <button
                    type="button"
                    onClick={handleClearFeed}
                    className="px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide text-text-tertiary hover:text-text-primary hover:bg-bg-secondary border border-border-subtle transition-colors"
                    title="Clear event feed"
                  >
                    Clear
                  </button>
                )}
                {newKeys.size > 0 && (
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
                    <span className="text-[8px] text-green-400 font-mono">LIVE</span>
                  </span>
                )}
              </div>

              {!feedCollapsed && (
                <div ref={feedScrollRef} className="overflow-y-auto px-1.5 py-1.5 space-y-1" style={{ maxHeight: 220, minHeight: 90 }}>
                  <div className="grid grid-cols-[48px_minmax(0,1fr)_76px_76px] items-center gap-2 px-2 py-1 text-[9px] uppercase tracking-wide text-text-tertiary border-b border-border-subtle/70">
                    <span className="text-right font-mono">Time</span>
                    <span>Event</span>
                    <span className="font-mono">Camera</span>
                    <span>Driver</span>
                  </div>
                  {orderedActions.length === 0 ? (
                    <p className="text-xs text-text-disabled text-center py-6">
                      Press Play to start script execution.
                    </p>
                  ) : (
                    orderedActions.map(action => {
                      const key   = `${action.id}_${action.ts}`
                      const isNew = newKeys.has(key)
                      const color = getEntryColor(action)
                      const label = getEntryLabel(action)
                      return (
                        <div
                          key={key}
                          className={`grid grid-cols-[48px_minmax(0,1fr)_76px_76px] items-center gap-2 rounded px-2 py-1 transition-colors${isNew ? ' lrs-feed-new' : ''}`}
                          style={{
                            borderLeft: `3px solid ${color}`,
                            backgroundColor: isNew ? `${color}33` : 'rgba(0,0,0,0.12)',
                          }}
                        >
                          <span className="text-[10px] text-text-disabled font-mono tabular-nums text-right">
                            {formatTime(action.raceTime)}
                          </span>
                          <span className="text-[11px] font-semibold truncate" style={{ color }}>
                            {label}
                          </span>
                          <span
                            className="text-[10px] font-mono truncate"
                            style={{ color: action.cameraLabel ? getCameraTextColor(action) : 'rgba(148,163,184,0.7)' }}
                          >
                            {action.cameraLabel || '—'}
                          </span>
                          <span className={`text-[10px] font-semibold truncate ${action.driverName ? 'text-emerald-300' : 'text-text-disabled'}`}>
                            {action.driverName || '—'}
                          </span>
                        </div>
                      )
                    })
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
})


