import { useState, useRef, memo } from 'react'
import { Minus, Plus, SkipBack, Rewind, Play, Pause, FastForward, SkipForward } from 'lucide-react'
import { EVENT_COLORS } from '../../context/TimelineContext'
import { apiPost } from '../../services/api'
import { EVENT_CONFIG, formatTime } from './analysisConstants'
import EventControlsBar from '../ui/EventControlsBar'

/**
 * PlaybackTimeline — scrubber + event markers + transport controls + focused event header.
 * Sits flush under the preview player.
 */
export default memo(function PlaybackTimeline({
  isConnected, isAnalyzing,
  raceDuration, raceStart, raceSessionNum,
  replayState, replaySpeed,
  isPlaying, isSeeking,
  focusedEvent, setFocusedEvent,
  autoLoop, setAutoLoop,
  filteredEvents,
  seekToEvent, navigateEvent,
  handlePlayPause, handleSetSpeed, handleReplaySearch,
  handleSwitchDriver,
  overrides, toggleOverride,
}) {
  const scrubberRef = useRef(null)
  const [scrubbing, setScrubbing] = useState(false)
  const [optimisticTime, setOptimisticTime] = useState(null)
  const [tooltipEvent, setTooltipEvent] = useState(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })

  if (!isConnected || isAnalyzing) return null

  return (
    <div className="shrink-0 bg-[#0f0f13] border-t border-white/10 px-4 py-3">
      {/* Focused event controls bar */}
      {focusedEvent && (
        <div className="mb-2 pb-2 border-b border-white/10">
          <EventControlsBar
            event={focusedEvent}
            raceStart={raceStart}
            raceDuration={raceDuration}
            replayState={replayState}
            onSeekToEvent={seekToEvent}
            onToggleOverride={toggleOverride}
            onSwitchDriver={handleSwitchDriver}
            onToggleAutoLoop={() => setAutoLoop(v => !v)}
            onClose={() => {
              setFocusedEvent(null)
              setAutoLoop(false)
            }}
            overrides={overrides}
            autoLoop={autoLoop}
            isSeeking={isSeeking}
            showClose={true}
            compact={false}
            theme="timeline"
            className="mb-0"
          />
        </div>
      )}

      {/* Timeline scrubber */}
      {raceDuration > 0 && replayState && (
        <div className="mb-2">
          {(() => {
            let viewStart, viewEnd
            if (focusedEvent) {
              const evStart = focusedEvent.start_time_seconds
              const evEnd = focusedEvent.end_time_seconds
              const evDuration = Math.max(1, evEnd - evStart)
              const pad = Math.max(2, evDuration * 0.15)
              viewStart = Math.max(0, evStart - pad)
              viewEnd = evEnd + pad
            } else {
              viewStart = raceStart
              viewEnd = raceDuration
            }
            const viewSpan = viewEnd - viewStart || 1
            const toPct = (t) => Math.max(0, Math.min(1, (t - viewStart) / viewSpan))
            const displayTime = scrubbing && optimisticTime !== null ? optimisticTime : replayState.session_time
            const evLeftPct = focusedEvent ? toPct(focusedEvent.start_time_seconds) * 100 : 0
            const evWidthPct = focusedEvent ? (toPct(focusedEvent.end_time_seconds) - toPct(focusedEvent.start_time_seconds)) * 100 : 0
            const focusedCfg = focusedEvent ? (EVENT_CONFIG[focusedEvent.event_type] || {}) : {}
            const markerEvents = !focusedEvent ? filteredEvents : []

            return (
              <>
              {/* Event dot timeline — separate strip above the scrub bar */}
              {markerEvents.length > 0 && (
                <div className="relative h-3 mb-1">
                  <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-px bg-white/10" />
                  {markerEvents.map((ev, i) => {
                    const time = ev.startTime ?? ev.start_time_seconds ?? 0
                    if (time <= 0) return null
                    const pct = toPct(time) * 100
                    const markerColor = EVENT_COLORS[ev.event_type] || '#ffffff'
                    return (
                      <div key={`dot-${i}`}
                        className="absolute top-1/2 w-2 h-2 rounded-full cursor-pointer
                                   hover:w-2.5 hover:h-2.5 transition-all duration-150 z-10
                                   hover:shadow-[0_0_6px_rgba(255,255,255,0.5)]"
                        style={{ left: `${pct}%`, backgroundColor: markerColor, opacity: 0.85, transform: 'translate(-50%, -50%)' }}
                        onClick={(e) => { e.stopPropagation(); setTooltipEvent(null); seekToEvent(ev) }}
                        onMouseEnter={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect()
                          setTooltipEvent(ev)
                          setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top })
                        }}
                        onMouseLeave={() => setTooltipEvent(null)}
                      />
                    )
                  })}
                </div>
              )}
              <div ref={scrubberRef} className="relative h-5 group cursor-pointer select-none"
                onMouseDown={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const pctToTime = (clientX) => {
                    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
                    return viewStart + pct * viewSpan
                  }
                  const initialTime = pctToTime(e.clientX)
                  setOptimisticTime(initialTime)
                  setScrubbing(true)
                  apiPost('/iracing/replay/seek-time', { session_num: raceSessionNum, session_time_ms: Math.round(initialTime * 1000) })
                  let lastSeek = Date.now()
                  const onMove = (mv) => {
                    const t = pctToTime(mv.clientX)
                    setOptimisticTime(t)
                    if (Date.now() - lastSeek < 150) return
                    lastSeek = Date.now()
                    apiPost('/iracing/replay/seek-time', { session_num: raceSessionNum, session_time_ms: Math.round(t * 1000) })
                  }
                  const onUp = (up) => {
                    const t = pctToTime(up.clientX)
                    setOptimisticTime(t)
                    apiPost('/iracing/replay/seek-time', { session_num: raceSessionNum, session_time_ms: Math.round(t * 1000) })
                      .finally(() => { setTimeout(() => { setScrubbing(false); setOptimisticTime(null) }, 300) })
                    document.removeEventListener('mousemove', onMove)
                    document.removeEventListener('mouseup', onUp)
                  }
                  document.addEventListener('mousemove', onMove)
                  document.addEventListener('mouseup', onUp)
                }}
              >
                <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-1.5 bg-white/8 rounded-full overflow-hidden">
                  {focusedEvent && (
                    <div className="absolute top-0 bottom-0 rounded-sm" style={{ left: `${evLeftPct}%`, width: `${evWidthPct}%` }}>
                      <div className={`w-full h-full rounded-sm opacity-20 ${focusedCfg.bg || 'bg-white/15'}`} />
                    </div>
                  )}
                  <div className={`h-full bg-gradient-to-r from-gradient-from via-gradient-via to-gradient-to rounded-full transition-all duration-200 ${scrubbing ? 'opacity-30' : ''}`}
                    style={{ width: `${toPct(replayState.session_time) * 100}%` }} />
                  {scrubbing && optimisticTime !== null && (
                    <div className="absolute top-0 left-0 h-full bg-gradient-to-r from-gradient-from via-gradient-via to-gradient-to rounded-full opacity-70"
                      style={{ width: `${toPct(optimisticTime) * 100}%` }} />
                  )}
                </div>
                <div className={`absolute top-1/2 w-3 h-3 rounded-full bg-accent border-2 border-white shadow-md
                  ${scrubbing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity pointer-events-none`}
                  style={{ left: `${toPct(displayTime) * 100}%`, transform: 'translate(-50%, -50%)' }} />
              </div>
              </>
            )
          })()}
          <div className="flex justify-between -mt-0.5">
            <span className="text-xxs text-white/30 font-mono">
              {focusedEvent
                ? formatTime(Math.max(0, focusedEvent.start_time_seconds - raceStart))
                : formatTime(Math.max(0, (scrubbing && optimisticTime !== null ? optimisticTime : replayState.session_time) - raceStart))}
            </span>
            <span className="text-xxs text-white/30 font-mono">
              {focusedEvent
                ? formatTime(Math.max(0, focusedEvent.end_time_seconds - raceStart))
                : formatTime(raceDuration - raceStart)}
            </span>
          </div>
        </div>
      )}

      {/* Event marker tooltip */}
      {tooltipEvent && tooltipPos && (
        <div className="fixed z-50 px-2.5 py-1.5 bg-black/95 border border-white/20 rounded-lg shadow-elevated text-xxs pointer-events-none"
          style={{ left: tooltipPos.x, top: tooltipPos.y - 8, transform: 'translate(-50%, -100%)' }}>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: EVENT_COLORS[tooltipEvent.event_type] || '#fff' }} />
            <span className="text-white font-semibold">{(EVENT_CONFIG[tooltipEvent.event_type] || {}).label || tooltipEvent.event_type}</span>
          </div>
          {/* Drivers — always show, "—" if empty */}
          <div className="text-white/50 mt-0.5">
            {tooltipEvent.driver_names?.length > 0 ? tooltipEvent.driver_names.join(' · ') : '—'}
          </div>
          <div className="text-white/40 mt-0.5">
            {formatTime(Math.max(0, (tooltipEvent.start_time_seconds ?? 0) - raceStart))}
            &nbsp;→&nbsp;
            {formatTime(Math.max(0, (tooltipEvent.end_time_seconds ?? 0) - raceStart))}
            &nbsp;·&nbsp;Severity {tooltipEvent.severity ?? '?'}
          </div>
        </div>
      )}

      {/* Transport row: time/lap on left, controls center-right */}
      {replayState && (
        <div className="flex items-center gap-4">
          {/* Time + lap on the left */}
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-sm text-white/70 font-mono font-semibold tabular-nums">
              {formatTime(replayState.session_time)}
            </span>
            {replayState.race_laps > 0 && (
              <span className="flex items-center gap-1.5 text-white/60">
                <button onClick={() => handleReplaySearch('prev_lap')} title="Previous lap"
                  className="w-6 h-6 rounded-md flex items-center justify-center bg-white/8 hover:bg-white/15 text-white/50 hover:text-white/90 border border-white/10 transition-colors">
                  <Minus size={12} />
                </button>
                <span className="text-sm font-semibold font-mono tabular-nums min-w-[52px] text-center">Lap {replayState.race_laps}</span>
                <button onClick={() => handleReplaySearch('next_lap')} title="Next lap"
                  className="w-6 h-6 rounded-md flex items-center justify-center bg-white/8 hover:bg-white/15 text-white/50 hover:text-white/90 border border-white/10 transition-colors">
                  <Plus size={12} />
                </button>
              </span>
            )}
          </div>

          {/* Transport controls */}
          <div className="flex items-center justify-center gap-1.5 flex-1">
            <button onClick={() => navigateEvent('prev')} disabled={!filteredEvents.length} title="Previous event"
              className="p-2 rounded-lg hover:bg-white/10 text-white/50 hover:text-white/90 transition-colors disabled:opacity-30">
              <SkipBack size={18} />
            </button>
            <button onClick={() => handleReplaySearch('prev_lap')} title="Previous lap"
              className="p-2 rounded-lg hover:bg-white/10 text-white/50 hover:text-white/90 transition-colors">
              <Rewind size={18} />
            </button>
            <button onClick={() => handleSetSpeed(-4)} title="Rewind 4×"
              className={`px-2.5 py-1.5 rounded-lg text-xs font-mono transition-colors
                ${replaySpeed === -4 ? 'bg-accent/15 text-accent' : 'hover:bg-white/10 text-white/50 hover:text-white/90'}`}>
              ◀◀
            </button>
            <button onClick={handlePlayPause} title={isPlaying ? 'Pause' : 'Play'}
              className="p-2.5 rounded-xl bg-gradient-to-r from-gradient-from to-gradient-to text-white hover:from-gradient-via hover:to-gradient-from transition-all duration-200 shadow-glow-sm mx-1">
              {isPlaying ? <Pause size={20} /> : <Play size={20} />}
            </button>
            {[1, 2, 4, 8, 16].map(spd => (
              <button key={spd} onClick={() => handleSetSpeed(spd)} title={`${spd}× speed`}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-mono transition-colors
                  ${replaySpeed === spd ? 'bg-accent/15 text-accent font-bold' : 'hover:bg-white/10 text-white/50 hover:text-white/90'}`}>
                {spd}×
              </button>
            ))}
            <button onClick={() => handleReplaySearch('next_lap')} title="Next lap"
              className="p-2 rounded-lg hover:bg-white/10 text-white/50 hover:text-white/90 transition-colors">
              <FastForward size={18} />
            </button>
            <button onClick={() => navigateEvent('next')} disabled={!filteredEvents.length} title="Next event"
              className="p-2 rounded-lg hover:bg-white/10 text-white/50 hover:text-white/90 transition-colors disabled:opacity-30">
              <SkipForward size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
})
