import { useMemo, useState, useRef, useEffect, useCallback } from 'react'
import { useCapture } from '../../context/CaptureContext'
import { useScriptState, CAPTURE_STATES } from '../../context/ScriptStateContext'
import { useTimelineViewport } from '../../hooks/useTimelineViewport'
import CollapsiblePanelHeader from '../ui/CollapsiblePanelHeader'
import ConfigurableTimelineTracks from '../ui/ConfigurableTimelineTracks'
import RangeSlider from '../ui/RangeSlider'
import LogViewer from '../ui/LogViewer'
import { normalizeCaptureLogEntries } from '../../utils/logEntries'
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

function getFailureHint(latestFailure, scriptCaptureError) {
  const detail = String(latestFailure?.detail || '').toLowerCase()
  const error = String(scriptCaptureError || '').toLowerCase()
  const combined = `${detail} ${error}`

  if (combined.includes('seek validation') || combined.includes('drift=')) {
    return 'Replay seek validation is failing. Click the iRacing replay timeline once, ensure replay mode is active, and retry capture.'
  }
  if (combined.includes('not connected') || combined.includes('telemetry')) {
    return 'iRacing connection/telemetry is unavailable. Reconnect iRacing and confirm live status before starting capture.'
  }
  if (combined.includes('timed out') || combined.includes('clip file not found') || combined.includes('watch folder')) {
    return 'Recorder output was not detected. Verify start/stop hotkeys and confirm the capture output folder in Settings → Capture matches your recorder.'
  }
  if (combined.includes('no start hotkey') || combined.includes('hotkey')) {
    return 'Hotkey setup is invalid. Reconfigure start/stop hotkeys in Settings → Capture, then run Hotkey Validation.'
  }
  return 'Open Capture Log for the exact failing command and retry after correcting recorder/iRacing replay setup.'
}

// ── Script Timeline (read-only, progress bars) ────────────────────────────

function ScriptTimeline({ strategies, currentSegmentId, completedIndex, totalSegments, segmentStates, replaySessionTime }) {
  const visibleStrategies = useMemo(
    () => (Array.isArray(strategies)
      ? strategies.filter((strat) => String(strat?.type || '').toLowerCase() !== 'bridge')
      : []),
    [strategies],
  )

  const totalDuration = useMemo(
    () => visibleStrategies.reduce((sum, s) => sum + (s.duration || 0), 0),
    [visibleStrategies],
  )
  const hasTimeline = visibleStrategies.length > 0 && totalDuration > 0

  const {
    containerRef,
    scrollRef,
    rangeStart,
    rangeEnd,
    setRange,
    contentWidth,
    toX,
    handleTimelineScroll,
  } = useTimelineViewport({
    totalDuration: hasTimeline ? totalDuration : 1,
    fallbackWidth: 800,
  })

  const SECTION_ROW_H = 18
  const SEGMENT_ROW_H = 46
  const TICK_ROW_H = 24
  const TIMELINE_CANVAS_H = SECTION_ROW_H + SEGMENT_ROW_H + TICK_ROW_H

  const timelineEntries = useMemo(() => {
    let cursor = 0
    return visibleStrategies.map((strat, idx) => {
      const duration = Math.max(0, Number(strat.duration || 0))
      const start = cursor
      const end = start + duration
      cursor = end
      return { strat, idx, start, end, duration }
    })
  }, [visibleStrategies])

  const sectionSpans = useMemo(() => {
    const spans = new Map()
    for (const entry of timelineEntries) {
      const key = entry.strat.section || 'race'
      if (!spans.has(key)) {
        spans.set(key, { start: entry.start, end: entry.end })
      } else {
        const current = spans.get(key)
        current.start = Math.min(current.start, entry.start)
        current.end = Math.max(current.end, entry.end)
      }
    }
    return Array.from(spans.entries())
  }, [timelineEntries])

  const playheadRatio = useMemo(() => {
    if (typeof replaySessionTime !== 'number' || Number.isNaN(replaySessionTime)) {
      return null
    }

    let cumulative = 0
    for (const strat of visibleStrategies) {
      const segStart = Number(strat.start_time || 0)
      const segEnd = Number(strat.end_time || segStart + (strat.duration || 0))
      const segDuration = Math.max(0, segEnd - segStart)

      if (replaySessionTime < segStart) {
        return cumulative / totalDuration
      }
      if (replaySessionTime <= segEnd) {
        const inSeg = Math.max(0, replaySessionTime - segStart)
        return Math.min(1, (cumulative + inSeg) / totalDuration)
      }

      cumulative += segDuration
    }

    return 1
  }, [replaySessionTime, totalDuration, visibleStrategies])

  const playheadX = playheadRatio == null ? null : playheadRatio * contentWidth

  const tickMarks = useMemo(() => {
    const tickCount = Math.min(8, Math.max(4, Math.round(totalDuration / 30)))
    const step = totalDuration / tickCount
    return Array.from({ length: tickCount + 1 }, (_, index) => {
      const value = Math.min(totalDuration, index * step)
      return { value, left: toX(value) }
    })
  }, [contentWidth, totalDuration])

  const rangeSliderEvents = useMemo(() => (
    timelineEntries.map(({ strat, start, end }) => ({
      start_time_seconds: start,
      end_time_seconds: end,
      event_type: strat.section || 'race',
      inclusion: strat.section === 'race' ? 'highlight' : null,
    }))
  ), [timelineEntries])

  if (!hasTimeline) return null

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden" ref={containerRef}>
      <ConfigurableTimelineTracks
        gutterWidth={52}
        canvasHeight={TIMELINE_CANVAS_H}
        contentWidth={contentWidth}
        containerClassName="flex-1 h-full min-h-0 flex overflow-hidden bg-bg-primary"
        scrollClassName="flex-1 min-h-0 overflow-x-hidden overflow-y-hidden"
        scrollRef={scrollRef}
        onScroll={handleTimelineScroll}
        playheadX={playheadX}
        playheadClassName="bg-accent"
        playheadDraggingClassName="bg-accent"
        rows={[
          {
            key: 'section',
            label: 'Sect',
            height: SECTION_ROW_H,
            render: ({ top, height }) => (
              <div className="absolute left-0 right-0 border-b border-border-subtle" style={{ top, height }}>
                {sectionSpans.map(([sectionName, span]) => {
                  const meta = SECTION_META[sectionName] || SECTION_META.race
                  const left = toX(span.start)
                  const width = Math.max(4, toX(span.end - span.start))
                  return (
                    <div key={sectionName} className="absolute top-0 h-full flex items-center overflow-hidden" style={{ left, width }}>
                      <div className={`absolute inset-0 ${meta.barColor}/18 border-r border-white/10`} />
                      <span className="relative truncate pl-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                        {meta.label}
                      </span>
                    </div>
                  )
                })}
              </div>
            ),
          },
          {
            key: 'segments',
            label: 'Evt',
            height: SEGMENT_ROW_H,
            render: ({ top, height }) => (
              <div className="absolute left-0 right-0 border-b border-border-subtle" style={{ top, height }}>
                {timelineEntries.map(({ strat, idx, start, duration }) => {
                  const left = toX(start)
                  const width = Math.max(4, toX(duration))
                  const meta = SECTION_META[strat.section] || SECTION_META.race
                  const isCurrent = strat.segment_id === currentSegmentId
                  const isCompleted = idx < (completedIndex ?? -1)
                  const captState = segmentStates?.[strat.segment_id]?.capture_state
                  let segmentClass = 'bg-bg-tertiary/35 border-border-subtle'
                  if (captState === 'captured') segmentClass = `${meta.barColor}/55 border-success/30`
                  else if (captState === 'invalidated') segmentClass = 'bg-amber-500/30 border-amber-500/40'
                  else if (isCompleted) segmentClass = `${meta.barColor}/42 border-white/10`
                  else if (isCurrent) segmentClass = `${meta.barColor}/65 border-accent/40`

                  return (
                    <div
                      key={strat.segment_id || idx}
                      className={`absolute top-1 bottom-1 rounded-sm border transition-all duration-300 ${segmentClass}`}
                      style={{ left, width }}
                      title={`${strat.segment_id}\n${strat.section} / ${strat.event_type || strat.type}\n${formatDuration(strat.duration)}\n${strat.strategy === 'continue' ? '↔ Contiguous' : '⏺ New recording'}${captState ? `\n● ${captState}` : ''}${strat.is_pip || strat.type === 'pip' ? '\n🖼 PiP segment' : ''}`}
                    >
                      {strat.contiguous_with_prev && (
                        <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent/50" />
                      )}
                      {isCurrent && (
                        <div className="absolute inset-0 ring-1 ring-accent/60 ring-inset rounded-sm animate-pulse" />
                      )}
                      {captState === 'captured' && (
                        <div className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-green-400" />
                      )}
                      {captState === 'invalidated' && (
                        <div className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400" />
                      )}
                      {(strat.is_pip || strat.type === 'pip') && (
                        <div className="absolute bottom-0 left-0 right-0 h-1 bg-blue-500/60 rounded-b-sm" />
                      )}
                    </div>
                  )
                })}
              </div>
            ),
          },
          {
            key: 'ticks',
            label: 'Tick',
            height: TICK_ROW_H,
            render: ({ top, height }) => (
              <div className="absolute left-0 right-0" style={{ top, height }}>
                {tickMarks.map((tick, index) => (
                  <div key={index} className="absolute top-0 bottom-0" style={{ left: tick.left }}>
                    <div className="w-px h-2 bg-border" />
                    <span className="absolute top-2 left-1 text-[10px] text-text-disabled whitespace-nowrap tabular-nums">
                      {formatDuration(tick.value)}
                    </span>
                  </div>
                ))}
              </div>
            ),
          },
        ]}
      />

      <RangeSlider
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        onChange={setRange}
        totalDuration={totalDuration}
        events={rangeSliderEvents}
        playheadTime={playheadRatio != null ? playheadRatio * totalDuration : null}
      />
    </div>
  )
}

// ── Capture Action Log ────────────────────────────────────────────────────

function buildStructuredCaptureLog({ rawEntries, entries, visibleEntries, clearedCount }) {
  const rawLog = Array.isArray(rawEntries) ? rawEntries : []
  const failures = rawLog.filter(entry => entry?.success === false)
  const retries = rawLog.filter(entry => entry?.action === 'retry')
  const latestFailure = failures[failures.length - 1] || null

  return {
    schema: 'league-replay-studio.capture-log',
    schema_version: 1,
    copied_at: new Date().toISOString(),
    raw_entry_count: rawLog.length,
    display_entry_count: entries.length,
    visible_entry_count: visibleEntries.length,
    cleared_visible_count: clearedCount,
    failure_count: failures.length,
    retry_count: retries.length,
    latest_failure: latestFailure,
    raw_entries: rawLog,
    display_entries: entries,
    visible_entries: visibleEntries,
  }
}

function CaptureActionLog({ log, maxVisible = 50, expandedByDefault = false, maxHeightClass = 'max-h-48', variant = 'card' }) {
  const isSidebar = variant === 'sidebar'
  const entries = normalizeCaptureLogEntries(log)

  if (!entries.length) return null

  return (
    <LogViewer
      title="Capture Log"
      entries={entries}
      rawEntries={log}
      schema="league-replay-studio.capture-log"
      emptyMessage="No capture log entries yet"
      maxVisible={expandedByDefault ? null : maxVisible}
      maxHeightClass={maxHeightClass}
      className={`h-full min-h-0 ${isSidebar ? '' : 'border border-border bg-bg-primary'}`}
      headerClassName={isSidebar ? '' : 'bg-transparent'}
      bodyClassName={isSidebar ? 'bg-transparent' : 'bg-bg-primary'}
      collapsible
      defaultExpanded={expandedByDefault}
      buildPayload={buildStructuredCaptureLog}
    >
      <Radio className="w-3 h-3 shrink-0 text-text-tertiary" />
    </LogViewer>
  )
}

function ScriptSegmentLog({ strategies, currentSegmentId, completedIndex, maxHeightClass = 'max-h-[520px]' }) {
  if (!strategies?.length) return null

  return (
    <div className="border-t border-border bg-bg-primary">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border bg-bg-secondary text-xxs font-semibold text-text-tertiary uppercase tracking-wider">
        <Clock className="w-3 h-3" />
        Script Log ({strategies.length} segments)
      </div>
      <div className={`${maxHeightClass} overflow-y-auto`}>
        {strategies.map((strat, idx) => (
          <SegmentStrategyCard
            key={strat.segment_id || idx}
            strategy={strat}
            isCurrent={strat.segment_id === currentSegmentId}
            isCompleted={idx < completedIndex}
          />
        ))}
      </div>
    </div>
  )
}

function IdlePanelPlaceholder({ icon: Icon, title, subtitle }) {
  return (
    <div className="h-full min-h-[140px] flex items-center justify-center px-4 py-6">
      <div className="flex flex-col items-center text-center gap-1.5 max-w-xs">
        <div className="w-9 h-9 rounded-full border border-border bg-bg-primary/70 flex items-center justify-center">
          <Icon className="w-4 h-4 text-text-disabled" />
        </div>
        <p className="text-xs font-medium text-text-secondary">{title}</p>
        <p className="text-xxs text-text-disabled">{subtitle}</p>
      </div>
    </div>
  )
}

// ── Segment Strategy Card ─────────────────────────────────────────────────

function SegmentStrategyCard({ strategy, isCurrent, isCompleted }) {
  const meta = SECTION_META[strategy.section] || SECTION_META.race
  const Icon = SECTION_ICONS[strategy.section] || Film

  return (
    <div className={`flex items-center gap-2 px-3 py-2 border-b border-border-subtle last:border-b-0 transition-colors
      ${isCurrent
        ? 'bg-accent/10 ring-1 ring-inset ring-accent/35'
        : isCompleted
          ? 'bg-success/5'
          : 'bg-bg-primary'
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
export default function ClipsPanel({
  projectId,
  replaySessionTime = null,
  fullHeight = false,
  showTimeline = true,
  showSegmentLog = true,
  showActionLog = true,
  showClips = true,
  showCompiled = true,
  showProgress = true,
  showScriptError = true,
  showLatestFailure = true,
}) {
  const {
    scriptCaptureRunning,
    scriptCaptureProgress,
    scriptCaptureClips,
    scriptCompiledPath,
    scriptCaptureError,
    scriptCaptureLog,
    scriptCaptureStrategies,
    scriptCurrentSegment,
    scriptCaptureCancelling,
    cancelScriptCapture,
  } = useCapture()
  const { segments: segmentStates } = useScriptState()

  const [showTimelinePanel, setShowTimelinePanel] = useState(true)

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

  const latestFailure = useMemo(() => {
    for (let i = scriptCaptureLog.length - 1; i >= 0; i -= 1) {
      const entry = scriptCaptureLog[i]
      if (entry && entry.success === false) return entry
    }
    return null
  }, [scriptCaptureLog])

  const latestFailureHint = useMemo(
    () => getFailureHint(latestFailure, scriptCaptureError),
    [latestFailure, scriptCaptureError],
  )

  const completedIndex = scriptCaptureProgress?.segment_index ?? -1
  const currentSegmentId = scriptCurrentSegment?.segment_id
  const activeCurrentSegmentId = scriptCaptureRunning ? currentSegmentId : null
  const timelineTotalDuration = useMemo(
    () => scriptCaptureStrategies.reduce((sum, strategy) => sum + (strategy.duration || 0), 0),
    [scriptCaptureStrategies],
  )
  const timelineSubtitle = useMemo(() => {
    if (!scriptCaptureStrategies.length) return null
    const countLabel = `${scriptCaptureStrategies.length} segment${scriptCaptureStrategies.length === 1 ? '' : 's'}`
    const totalLabel = timelineTotalDuration > 0 ? ` · ${formatDuration(timelineTotalDuration)} total` : ''
    return `${countLabel}${totalLabel}`
  }, [scriptCaptureStrategies.length, timelineTotalDuration])

  const showIdleTimelinePlaceholder = showTimeline && !scriptCaptureRunning && scriptCaptureStrategies.length === 0
  const showIdleActionLogPlaceholder = showActionLog && !scriptCaptureRunning && scriptCaptureLog.length === 0

  const hasContent =
    showIdleTimelinePlaceholder ||
    showIdleActionLogPlaceholder ||
    (showProgress && scriptCaptureRunning) ||
    (showClips && scriptCaptureClips.length > 0) ||
    (showScriptError && !!scriptCaptureError) ||
    (showLatestFailure && !!latestFailure) ||
    (showTimeline && scriptCaptureStrategies.length > 0) ||
    (showSegmentLog && scriptCaptureStrategies.length > 0) ||
    (showActionLog && scriptCaptureLog.length > 0) ||
    (showCompiled && !!scriptCompiledPath)

  if (!hasContent) return null

  if (fullHeight) {
    return (
      <div className="h-full min-h-0 flex min-w-0 overflow-hidden bg-bg-primary">
        <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
        {showLatestFailure && latestFailure && (
          <div className="flex items-start gap-2 px-3 py-2.5 bg-danger/5 border-b border-danger/30">
            <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-xs text-danger font-medium">Latest iRacing Command Failure</p>
              <p className="text-xxs text-danger/80 mt-0.5 break-words">{latestFailure.detail || 'Command failed'}</p>
              <p className="mt-1 text-xxs text-warning">{latestFailureHint}</p>
            </div>
          </div>
        )}

        {(showTimeline || showActionLog) && (
          <div className={`grid flex-1 min-h-0 min-w-0 ${showTimeline && showActionLog ? 'xl:grid-cols-[minmax(0,1fr)_360px]' : 'grid-cols-1'}`}>
            {showTimeline && (
              <div className="min-h-0 h-full bg-bg-primary overflow-hidden flex flex-col border-r border-border">
                <div className="flex items-center border-b border-border bg-bg-secondary shrink-0">
                  <CollapsiblePanelHeader
                    open={showTimelinePanel}
                    onToggle={() => setShowTimelinePanel(prev => !prev)}
                    icon={Film}
                    title="Capture Timeline"
                    subtitle={showTimelinePanel ? timelineSubtitle : null}
                    className="flex-1"
                  />
                </div>
                {showTimelinePanel && (
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    {showIdleTimelinePlaceholder ? (
                      <IdlePanelPlaceholder
                        icon={Film}
                        title="Capture timeline appears during capture"
                        subtitle="Start scripted capture to see segment progress and playhead movement."
                      />
                    ) : (
                      <>
                        <ScriptTimeline
                          strategies={scriptCaptureStrategies}
                          currentSegmentId={activeCurrentSegmentId}
                          completedIndex={completedIndex}
                          totalSegments={scriptCaptureProgress?.segment_total || scriptCaptureStrategies.length}
                          segmentStates={segmentStates}
                          replaySessionTime={replaySessionTime}
                        />
                        {showSegmentLog && (
                          <ScriptSegmentLog
                            strategies={scriptCaptureStrategies}
                            currentSegmentId={activeCurrentSegmentId}
                            completedIndex={completedIndex}
                            maxHeightClass="flex-1 min-h-0"
                          />
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {showActionLog && (
              <div className="min-h-0 bg-bg-secondary/60 overflow-hidden flex flex-col">
                {showIdleActionLogPlaceholder ? (
                  <IdlePanelPlaceholder
                    icon={Radio}
                    title="Capture logs appear during capture"
                    subtitle="Run capture to view replay commands, retries, and validation events."
                  />
                ) : (
                  <CaptureActionLog
                    log={scriptCaptureLog}
                    maxVisible={5000}
                    expandedByDefault
                    maxHeightClass="flex-1"
                    variant="sidebar"
                  />
                )}
              </div>
            )}
          </div>
        )}

        {showCompiled && scriptCompiledPath && (
          <div className="flex items-center gap-2 px-3 py-2 bg-success/5 border-t border-success/30">
            <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-success">Compiled Video Ready</p>
              <p className="text-xxs text-text-tertiary font-mono truncate" title={scriptCompiledPath}>
                {scriptCompiledPath.split(/[/\\]/).pop()}
              </p>
            </div>
          </div>
        )}
        </div>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 flex flex-col gap-3">
      {/* ── Script Timeline Visualization ──────────────────────────────── */}
      {showTimeline && (
        <div className="flex-1 min-h-0 overflow-hidden bg-bg-primary flex flex-col">
          <div className="flex items-center border-b border-border bg-bg-secondary shrink-0">
            <CollapsiblePanelHeader
              open={showTimelinePanel}
              onToggle={() => setShowTimelinePanel(prev => !prev)}
              icon={Film}
                title="Capture Timeline"
              subtitle={showTimelinePanel ? timelineSubtitle : null}
              className="flex-1"
            />
          </div>
          {showTimelinePanel && (
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
              {showIdleTimelinePlaceholder ? (
                <IdlePanelPlaceholder
                  icon={Film}
                  title="Capture timeline appears during capture"
                  subtitle="Start scripted capture to see segment progress and playhead movement."
                />
              ) : (
                <ScriptTimeline
                  strategies={scriptCaptureStrategies}
                  currentSegmentId={activeCurrentSegmentId}
                  completedIndex={completedIndex}
                  totalSegments={scriptCaptureProgress?.segment_total || scriptCaptureStrategies.length}
                  segmentStates={segmentStates}
                  replaySessionTime={replaySessionTime}
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Progress bar (while running) ──────────────────────────────── */}
      {showProgress && scriptCaptureRunning && (
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
                disabled={scriptCaptureCancelling}
                className="text-xxs text-danger hover:text-danger/80 disabled:opacity-70 disabled:cursor-wait transition-colors"
              >
                {scriptCaptureCancelling ? 'Cancelling…' : 'Cancel'}
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
      {showScriptError && scriptCaptureError && !scriptCaptureRunning && (
        <div className="flex items-start gap-2 px-3 py-2.5 bg-danger/5 border border-danger/30 rounded-md">
          <XCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
          <div>
            <p className="text-xs text-danger font-medium">Script Capture Failed</p>
            <p className="text-xxs text-danger/80 mt-0.5">{scriptCaptureError}</p>
          </div>
        </div>
      )}

      {/* ── Latest iRacing command failure (always visible) ───────────── */}
      {showLatestFailure && latestFailure && (
        <div className="flex items-start gap-2 px-3 py-2.5 bg-danger/5 border border-danger/30 rounded-md">
          <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs text-danger font-medium">Latest iRacing Command Failure</p>
            <p className="text-xxs text-danger/80 mt-0.5 break-words">
              {latestFailure.detail || 'Command failed'}
            </p>
            <div className="mt-1 text-xxs text-danger/70">
              {latestFailure.action ? `Action: ${latestFailure.action}` : ''}
              {latestFailure.segment_id ? ` • Segment: ${latestFailure.segment_id}` : ''}
              {latestFailure.attempt > 1 ? ` • Attempt: ${latestFailure.attempt}` : ''}
            </div>
            <p className="mt-1 text-xxs text-warning">
              {latestFailureHint}
            </p>
          </div>
        </div>
      )}

      {/* ── Capture Action Log ─────────────────────────────────────────── */}
      {showActionLog && (
        showIdleActionLogPlaceholder ? (
          <div className="overflow-hidden bg-bg-secondary">
            <IdlePanelPlaceholder
              icon={Radio}
              title="Capture logs appear during capture"
              subtitle="Run capture to view replay commands, retries, and validation events."
            />
          </div>
        ) : (
          <CaptureActionLog log={scriptCaptureLog} />
        )
      )}

      {/* ── Script Segments ─────────────────────────────────────────────── */}
      {showSegmentLog && scriptCaptureStrategies.length > 0 && (
        <div className="border border-border bg-bg-primary">
          <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border bg-bg-secondary text-xxs font-semibold text-text-tertiary uppercase tracking-wider">
            <Clock className="w-3 h-3" />
            Script Segments ({scriptCaptureStrategies.length})
          </div>

          <div className="max-h-64 overflow-y-auto">
            {scriptCaptureStrategies.map((strat, idx) => (
              <SegmentStrategyCard
                key={strat.segment_id || idx}
                strategy={strat}
                isCurrent={strat.segment_id === activeCurrentSegmentId}
                isCompleted={idx < completedIndex}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Compiled video ────────────────────────────────────────────── */}
      {showCompiled && scriptCompiledPath && (
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
      {showClips && scriptCaptureClips.length > 0 && (
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
