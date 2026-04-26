import { useState, useRef, useMemo, useEffect, useCallback, memo } from 'react'
import { Minus, Plus, Activity } from 'lucide-react'
import { EVENT_COLORS } from '../../context/TimelineContext'
import { apiPost } from '../../services/api'
import { EVENT_CONFIG, formatTime } from './analysisConstants'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { useTimelineViewport } from '../../hooks/useTimelineViewport'
import EventControlsBar from '../ui/EventControlsBar'
import PlaybackControls from '../ui/PlaybackControls'
import CollapsiblePanelHeader from '../ui/CollapsiblePanelHeader'
import ConfigurableTimelineTracks from '../ui/ConfigurableTimelineTracks'
import RangeSlider from '../ui/RangeSlider'

const EVENT_ROW_MIN_H = 46
const TICK_ROW_H = 24
const GUTTER_W = 52

export default memo(function PlaybackTimeline({
  isConnected,
  raceDuration,
  raceStart,
  raceSessionNum,
  replayState,
  replaySpeed,
  isPlaying,
  isSeeking,
  focusedEvent,
  setFocusedEvent,
  autoLoop,
  setAutoLoop,
  filteredEvents,
  seekToEvent,
  navigateEvent,
  handlePlayPause,
  handleSetSpeed,
  handleReplaySearch,
  handleSwitchDriver,
  overrides,
  toggleOverride,
  className = '',
}) {
  const [scrubbing, setScrubbing] = useState(false)
  const [optimisticTime, setOptimisticTime] = useState(null)
  const [tooltipEvent, setTooltipEvent] = useState(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })
  const [collapsed, setCollapsed] = useLocalStorage('lrs:analysis:timeline:collapsed', false)

  const baseWindow = useMemo(() => {
    const start = raceStart || 0
    const liveTime = Number(replayState?.session_time || 0)
    const fallbackEnd = Math.max(start + 600, liveTime + 120)
    return {
      start,
      end: raceDuration > 0 ? raceDuration : fallbackEnd,
    }
  }, [raceDuration, raceStart, replayState?.session_time])

  const baseSpan = Math.max(1, (baseWindow.end || 0) - (baseWindow.start || 0))

  const {
    containerRef,
    scrollRef,
    rangeStart,
    rangeEnd,
    setRange,
    setRangeStart,
    setRangeEnd,
    containerHeight,
    contentWidth,
    pxPerUnit,
    toX,
    handleTimelineScroll,
  } = useTimelineViewport({
    totalDuration: baseSpan,
    fallbackWidth: Math.max(baseSpan * 24, 640),
    measureKey: `${collapsed}:${raceDuration}`,
  })

  const eventRowHeight = Math.max(EVENT_ROW_MIN_H, containerHeight > 0 ? containerHeight - TICK_ROW_H : EVENT_ROW_MIN_H)

  const sliderEvents = useMemo(() => (
    (filteredEvents || []).map((ev) => ({
      start_time_seconds: Math.max(0, (ev.start_time_seconds ?? 0) - baseWindow.start),
      end_time_seconds: Math.max(0, (ev.end_time_seconds ?? ev.start_time_seconds ?? 0) - baseWindow.start),
      event_type: ev.event_type,
    }))
  ), [filteredEvents, baseWindow.start])

  const displayTime = scrubbing && optimisticTime !== null ? optimisticTime : replayState?.session_time

  const playheadInBase = replayState?.session_time != null
    ? Math.max(0, Math.min(baseSpan, replayState.session_time - baseWindow.start))
    : null

  const displayTimeInBase = displayTime != null
    ? Math.max(0, Math.min(baseSpan, displayTime - baseWindow.start))
    : null

  const playheadX = displayTimeInBase != null ? (displayTimeInBase / baseSpan) * contentWidth : null
  const activeEventIndex = useMemo(() => {
    if (!focusedEvent?.id) return -1
    return filteredEvents.findIndex((event) => event.id === focusedEvent.id)
  }, [filteredEvents, focusedEvent?.id])

  const tickMarks = useMemo(() => {
    const rawInterval = 80 / Math.max(1, pxPerUnit)
    const niceIntervals = [1, 5, 10, 15, 30, 60, 120, 300, 600]
    const interval = niceIntervals.find((value) => value >= rawInterval) || 600
    const major = interval * 5
    const marks = []
    for (let time = 0; time <= baseSpan + interval; time += interval) {
      marks.push({ time, major: time % major === 0 })
    }
    return marks
  }, [baseSpan, pxPerUnit])

  useEffect(() => {
    setRangeStart(0)
    setRangeEnd(1)
  }, [focusedEvent?.id])

  const showDisconnectedNotice = !isConnected
  const hasRealTimingData = raceDuration > 0

  const getTimeFromClientX = useCallback((clientX) => {
    const element = scrollRef.current
    if (!element || contentWidth <= 0) return baseWindow.start
    const rect = element.getBoundingClientRect()
    const x = clientX - rect.left + element.scrollLeft
    const pct = Math.max(0, Math.min(1, x / contentWidth))
    return baseWindow.start + (pct * baseSpan)
  }, [baseSpan, baseWindow.start, contentWidth])

  const handleTimelinePointerDown = useCallback((event) => {
    event.preventDefault()
    event.stopPropagation()

    const initialTime = getTimeFromClientX(event.clientX)
    setOptimisticTime(initialTime)
    setScrubbing(true)
    apiPost('/iracing/replay/seek-time', {
      session_num: raceSessionNum,
      session_time_ms: Math.round(initialTime * 1000),
      resolve_session: false,
    })

    let lastSeek = Date.now()

    const onMove = (moveEvent) => {
      const time = getTimeFromClientX(moveEvent.clientX)
      setOptimisticTime(time)
      if (Date.now() - lastSeek < 150) return
      lastSeek = Date.now()
      apiPost('/iracing/replay/seek-time', {
        session_num: raceSessionNum,
        session_time_ms: Math.round(time * 1000),
        resolve_session: false,
      })
    }

    const onUp = (upEvent) => {
      const time = getTimeFromClientX(upEvent.clientX)
      setOptimisticTime(time)
      apiPost('/iracing/replay/seek-time', {
        session_num: raceSessionNum,
        session_time_ms: Math.round(time * 1000),
        resolve_session: false,
      }).finally(() => {
        setTimeout(() => {
          setScrubbing(false)
          setOptimisticTime(null)
        }, 300)
      })
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [getTimeFromClientX, raceSessionNum])

  return (
    <div className={`h-full min-h-0 flex flex-col overflow-hidden bg-bg-primary ${className}`}>
      <div className="flex items-center border-b border-border bg-bg-secondary shrink-0">
        <CollapsiblePanelHeader
          open={!collapsed}
          onToggle={() => setCollapsed(v => !v)}
          icon={Activity}
          title="Event Timeline"
          subtitle={`${filteredEvents.length} events`}
          className="flex-1"
        />
      </div>

      {showDisconnectedNotice && !collapsed && (
        <div className="px-3 py-2 border-b border-border-subtle text-xxs text-text-tertiary bg-bg-primary/60">
          Timeline is unavailable until iRacing reconnects.
        </div>
      )}

      {!collapsed && (
        <>
          {focusedEvent && (
            <div className="border-b border-border-subtle">
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
                className="mb-0 px-2 py-1"
              />
            </div>
          )}

          {replayState && (
            <PlaybackControls
              leftSlot={
                <div className="flex items-center gap-2 shrink-0">
                  {replayState.race_laps > 0 && (
                    <span className="flex items-center gap-1 text-text-secondary">
                      <button
                        onClick={() => handleReplaySearch('prev_lap')}
                        title="Previous lap"
                        className="p-0.5 rounded hover:bg-bg-secondary text-text-disabled hover:text-text-primary transition-colors"
                      >
                        <Minus size={10} />
                      </button>
                      <span className="text-xxs font-semibold font-mono tabular-nums">Lap {replayState.race_laps}</span>
                      <button
                        onClick={() => handleReplaySearch('next_lap')}
                        title="Next lap"
                        className="p-0.5 rounded hover:bg-bg-secondary text-text-disabled hover:text-text-primary transition-colors"
                      >
                        <Plus size={10} />
                      </button>
                    </span>
                  )}
                </div>
              }
              onPrev={() => navigateEvent('prev')}
              prevDisabled={!filteredEvents.length}
              prevTitle="Previous event"
              onNext={() => navigateEvent('next')}
              nextDisabled={!filteredEvents.length}
              nextTitle="Next event"
              isPlaying={isPlaying}
              onPlayPause={handlePlayPause}
              playDisabled={!isConnected}
              playTitle={isConnected ? undefined : 'iRacing not connected'}
              position={activeEventIndex >= 0
                ? `${activeEventIndex + 1} / ${filteredEvents.length}`
                : `– / ${filteredEvents.length}`}
              progress={displayTimeInBase != null ? (displayTimeInBase / baseSpan) : 0}
              timeDisplay={formatTime(replayState.session_time)}
              speeds={[1, 2, 4, 8, 16]}
              activeSpeed={replaySpeed}
              onSpeedChange={handleSetSpeed}
            />
          )}

          <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden bg-bg-primary relative">
            <ConfigurableTimelineTracks
              gutterWidth={GUTTER_W}
              canvasHeight={eventRowHeight + TICK_ROW_H}
              contentWidth={contentWidth}
              containerClassName="flex-1 h-full min-h-0 flex overflow-hidden bg-bg-primary"
              scrollClassName="flex-1 min-h-0 overflow-x-hidden overflow-y-hidden"
              scrollRef={scrollRef}
              onScroll={handleTimelineScroll}
              playheadX={playheadX}
              onPlayheadMouseDown={handleTimelinePointerDown}
              playheadTitle="Drag to scrub event timeline"
              playheadClassName="bg-accent"
              playheadDraggingClassName="bg-accent"
              isPlayheadDragging={scrubbing}
              rows={[
                {
                  key: 'events',
                  label: 'Evt',
                  height: eventRowHeight,
                  render: ({ top, height }) => (
                    <div
                      className="absolute left-0 right-0 border-b border-border-subtle cursor-ew-resize"
                      style={{ top, height }}
                      onMouseDown={handleTimelinePointerDown}
                    >
                        {focusedEvent && (
                          <div
                            className="absolute top-1 bottom-1 rounded-sm"
                            style={{
                              left: toX(Math.max(0, focusedEvent.start_time_seconds - baseWindow.start)),
                              width: Math.max(3, toX(Math.max(0, focusedEvent.end_time_seconds - focusedEvent.start_time_seconds))),
                            }}
                          >
                            <div className={`w-full h-full rounded-sm opacity-20 ${(EVENT_CONFIG[focusedEvent.event_type] || {}).bg || 'bg-white/15'}`} />
                          </div>
                        )}

                        {filteredEvents.map((ev, index) => {
                          const time = ev.startTime ?? ev.start_time_seconds ?? 0
                          if (time <= 0) return null
                          const eventTime = Math.max(0, time - baseWindow.start)
                          const left = toX(eventTime)
                          const markerColor = EVENT_COLORS[ev.event_type] || '#ffffff'
                          const lineWidth = Math.max(2, Math.min(4, Math.round(pxPerUnit * 0.08)))
                          return (
                            <div
                              key={`line-${index}`}
                              className="absolute top-0 bottom-0 cursor-pointer transition-all duration-150 z-10"
                              style={{
                                left: `${Math.round(left - (lineWidth / 2))}px`,
                                width: `${lineWidth}px`,
                                backgroundColor: markerColor,
                                opacity: 0.92,
                                boxShadow: `0 0 0 1px ${markerColor}33`,
                              }}
                              onClick={(clickEvent) => {
                                clickEvent.stopPropagation()
                                setTooltipEvent(null)
                                seekToEvent(ev)
                              }}
                              onMouseEnter={(hoverEvent) => {
                                const rect = hoverEvent.currentTarget.getBoundingClientRect()
                                setTooltipEvent(ev)
                                setTooltipPos({ x: rect.left + (rect.width / 2), y: rect.top })
                              }}
                              onMouseLeave={() => setTooltipEvent(null)}
                            />
                          )
                        })}
                    </div>
                  ),
                },
                {
                  key: 'ticks',
                  label: '',
                  gutterClassName: 'border-b-0 flex items-center justify-end pr-2',
                  height: TICK_ROW_H,
                  render: ({ top, height }) => (
                    <div
                      className="absolute left-0 right-0 cursor-ew-resize bg-bg-secondary border-t border-border-subtle"
                      style={{ top, height }}
                      onMouseDown={handleTimelinePointerDown}
                    >
                        {tickMarks.map(({ time, major }) => (
                          <div key={time} className="absolute top-0 bottom-0" style={{ left: toX(time) }}>
                            <div className={`w-px ${major ? 'h-full bg-border' : 'h-1/2 bg-border-subtle'}`} />
                            {major && (
                              <span className="absolute top-1 left-1 whitespace-nowrap text-[10px] font-mono text-text-disabled">
                                {formatTime(time)}
                              </span>
                            )}
                          </div>
                        ))}
                    </div>
                  ),
                },
              ]}
            />

            {!hasRealTimingData && (
              <div className="absolute top-2 right-2 px-2 py-1 rounded-md border border-border bg-bg-secondary/90 text-xxs text-text-tertiary">
                Using live fallback timeline (timing data pending)
              </div>
            )}
          </div>

          <RangeSlider
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            onChange={setRange}
            totalDuration={baseSpan}
            events={sliderEvents}
            playheadTime={displayTimeInBase}
          />

          {tooltipEvent && tooltipPos && (
            <div
              className="fixed z-50 px-2.5 py-1.5 bg-black/95 border border-white/20 rounded-lg shadow-elevated text-xxs pointer-events-none"
              style={{ left: tooltipPos.x, top: tooltipPos.y - 8, transform: 'translate(-50%, -100%)' }}
            >
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: EVENT_COLORS[tooltipEvent.event_type] || '#fff' }} />
                <span className="text-white font-semibold">{(EVENT_CONFIG[tooltipEvent.event_type] || {}).label || tooltipEvent.event_type}</span>
              </div>
              <div className="text-white/50 mt-0.5">
                {tooltipEvent.driver_names?.length > 0 ? tooltipEvent.driver_names.join(' · ') : '—'}
              </div>
              <div className="text-white/40 mt-0.5">
                {formatTime(Math.max(0, (tooltipEvent.start_time_seconds ?? 0) - raceStart))}
                {' '}→{' '}
                {formatTime(Math.max(0, (tooltipEvent.end_time_seconds ?? 0) - raceStart))}
                {' '}·{' '}Severity {tooltipEvent.severity ?? '?'}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
})
