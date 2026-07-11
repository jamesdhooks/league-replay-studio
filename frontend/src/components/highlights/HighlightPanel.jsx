import { useEffect, useMemo, useCallback, useRef, useState } from 'react'
import { useHighlight } from '../../context/HighlightContext'
import { useTimeline } from '../../context/TimelineContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { useAnalysis } from '../../context/AnalysisContext'
import { useProject } from '../../context/ProjectContext'
import { useUndoRedo } from '../../context/UndoRedoContext'
import HighlightWeightSliders from './HighlightWeightSliders'
import HighlightEventTable from './HighlightEventTable'
import HighlightMetrics from './HighlightMetrics'
import HighlightHistogram from './HighlightHistogram'
import HighlightPreview from './HighlightPreview'
import HighlightTimeline from './HighlightTimeline'
import EventInspectorPanel from '../inspector/EventInspectorPanel'
import EditHistoryPanel from '../history/EditHistoryPanel'
import ProjectFileBrowser from '../projects/ProjectFileBrowser'
import ResizableSidebar from '../layout/ResizableSidebar'
import CollapsibleSection from '../ui/CollapsibleSection'
import ResizableRowPane from '../ui/ResizableRowPane'
import CollapsibleControlsHeader from '../ui/CollapsibleControlsHeader'
import { Sparkles, List, Search, History, Folder, Film, Scissors, Clapperboard, Clock, AlertCircle } from 'lucide-react'
import LabeledSlider from '../ui/LabeledSlider'

/**
 * HighlightPanel — Main container for the Highlight Editing Suite.
 *
 * Layout: config bar (top), resizable sidebar (left), highlight tuning + event
 * table (right-top), preview + NLE timeline (right-bottom).
 *
 * @param {Object} props
 * @param {number} props.projectId - Active project ID
 */
export default function HighlightPanel({ projectId }) {
  const { loadConfig, loadDrivers, loadPresets, replayMode, setReplayMode, videoSections, sectionConfig, updateSectionConfig, metrics, targetDuration, setTargetDuration, params, setParams } = useHighlight()
  const { loadRaceDuration } = useTimeline()
  const { fetchEvents, events } = useAnalysis()
  const { history } = useUndoRedo()
  const { setStep } = useProject()
  const sidebarRef = useRef(null)
  const [tuningCollapsed, setTuningCollapsed] = useLocalStorage('lrs:editing:tuningCollapsed', false)
  const hasAnalysis = events?.length > 0

  // Resizable tuning pane width
  const [tuningWidth, setTuningWidth] = useLocalStorage('lrs:editing:tuningWidth', 280)
  const tuningRef = useRef(null)
  const tuningWidthRef = useRef(tuningWidth)
  useEffect(() => { tuningWidthRef.current = tuningWidth }, [tuningWidth])

  const startTuningResize = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = tuningWidthRef.current
    const onMove = (mv) => {
      const w = Math.max(220, Math.min(400, startW + mv.clientX - startX))
      setTuningWidth(w)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [setTuningWidth])

  // Histogram + Preview: collapsed state (mutually exclusive — only one expands at a time)
  const [histogramCollapsed, setHistogramCollapsed] = useLocalStorage('lrs:editing:histogramCollapsed', false)
  const [previewCollapsed, setPreviewCollapsed] = useLocalStorage('lrs:editing:previewCollapsed', true)
  const [timelineCollapsed] = useLocalStorage('lrs:editing:timeline:collapsed', false)

  const toggleHistogram = useCallback(() => {
    if (histogramCollapsed) {
      setHistogramCollapsed(false)
      setPreviewCollapsed(true)
    } else {
      setHistogramCollapsed(true)
    }
  }, [histogramCollapsed, setHistogramCollapsed, setPreviewCollapsed])

  const togglePreview = useCallback(() => {
    if (previewCollapsed) {
      setPreviewCollapsed(false)
      setHistogramCollapsed(true)
    } else {
      setPreviewCollapsed(true)
    }
  }, [previewCollapsed, setPreviewCollapsed, setHistogramCollapsed])

  const [eventsLoaded, setEventsLoaded] = useState(false)

  // Load highlight data on mount
  useEffect(() => {
    if (projectId) {
      setEventsLoaded(false)
      fetchEvents(projectId, { limit: 50000 })
        .catch(() => {})
        .finally(() => setEventsLoaded(true))
      loadConfig(projectId)
      loadDrivers(projectId)
      loadPresets()
      loadRaceDuration(projectId)
    }
  }, [projectId, loadConfig, loadDrivers, loadPresets, fetchEvents, loadRaceDuration])

  const sidebarTabs = useMemo(() => [
    {
      id: 'events',
      label: 'Events',
      icon: List,
      count: events.length,
      content: <HighlightEventTable onInspect={() => sidebarRef.current?.switchTab('inspector')} />,
    },
    {
      id: 'inspector',
      label: 'Inspector',
      icon: Search,
      content: <EventInspectorPanel projectId={projectId} />,
    },
    {
      id: 'history',
      label: 'History',
      icon: History,
      count: history.length,
      content: <EditHistoryPanel />,
    },
    {
      id: 'files',
      label: 'Files',
      icon: Folder,
      content: <ProjectFileBrowser projectId={projectId} />,
    },
  ], [projectId, events.length, history.length])

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* No-analysis banner */}
      {!hasAnalysis && eventsLoaded && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 shrink-0">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="text-xs text-amber-200 flex-1">
            No events detected yet. Run analysis to populate the editing view.
          </span>
          <button
            onClick={() => setStep(projectId, 'analysis')}
            className="px-3 py-1 text-xs font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded transition-colors"
          >
            Go to Analysis
          </button>
        </div>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden relative">
        {/* Left sidebar with Events/Inspector/History/Files tabs */}
        <ResizableSidebar
          ref={sidebarRef}
          storageKey="lrs:editing:sidebar"
          defaultTab="events"
          tabs={sidebarTabs}
        />

        {/* Right side: tuning + histogram */}
        <div className="flex-1 flex min-w-0 min-h-0 overflow-hidden">
          {/* Editing Controls collapsed icon bar */}
          {tuningCollapsed && (
            <CollapsibleControlsHeader
              collapsed
              icon={Sparkles}
              title="Editing Controls"
              onExpand={() => setTuningCollapsed(false)}
              expandTitle="Expand Editing Controls"
            />
          )}

          {/* Editing Controls pane (resizable) */}
          {!tuningCollapsed && (
          <div
            ref={tuningRef}
            className="shrink-0 border-r border-border bg-bg-secondary flex flex-col min-h-0"
            style={{ width: tuningWidth }}
          >
            <CollapsibleControlsHeader
              collapsed={false}
              icon={Sparkles}
              title="Editing Controls"
              onCollapse={() => setTuningCollapsed(true)}
            />
            {/* Replay mode toggle */}
            <div className="px-3 py-2 border-b border-border-subtle shrink-0">
              <div className="flex items-center gap-1 p-0.5 bg-bg-primary rounded-lg border border-border">
                <button
                  onClick={() => setReplayMode('highlights')}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xxs font-medium rounded transition-colors
                    ${replayMode === 'highlights'
                      ? 'bg-accent text-white shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'}`}
                >
                  <Scissors className="w-3 h-3" />
                  Highlights
                </button>
                <button
                  onClick={() => setReplayMode('full')}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xxs font-medium rounded transition-colors
                    ${replayMode === 'full'
                      ? 'bg-accent text-white shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'}`}
                >
                  <Film className="w-3 h-3" />
                  Full Race
                </button>
              </div>
              {replayMode === 'full' && (
                <p className="text-xxs text-text-disabled mt-1.5 leading-relaxed">
                  All events included — shows the full race contiguously.
                </p>
              )}
            </div>

            {replayMode !== 'full' && (
              <div className="px-3 py-2 border-b border-border-subtle shrink-0">
                <LabeledSlider
                  label="Target Duration"
                  tooltip="Target duration of the final highlight video — shorter means stricter event selection (0 = no limit)"
                  value={targetDuration ? Math.round(targetDuration / 60) : 0}
                  min={0} max={30} step={1}
                  format={v => v === 0 ? 'No limit' : `${v} min`}
                  tickFormat={v => v === 0 ? 'Off' : `${v}m`}
                  onChange={v => setTargetDuration(v === 0 ? null : v * 60)}
                  labelWidth="7rem"
                />
                <LabeledSlider
                  label="Continuity"
                  tooltip="Prefer nearby events as uninterrupted race sequences. Retained gap footage counts toward the target duration."
                  value={params.continuityPreference ?? 0}
                  min={0} max={100} step={5}
                  format={v => {
                    if (v === 0) return 'Cut-focused'
                    if (v <= 25) return 'Light flow'
                    if (v <= 60) return 'Balanced'
                    if (v <= 85) return 'Continuous'
                    return 'Long takes'
                  }}
                  tickFormat={v => v}
                  onChange={v => setParams(current => ({ ...current, continuityPreference: v }))}
                  labelWidth="7rem"
                />
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {/* Race segments breakdown */}
              <SegmentBreakdown
                sections={videoSections}
                config={sectionConfig}
                onUpdate={updateSectionConfig}
                metrics={metrics}
              />

              <HighlightMetrics />
              <HighlightWeightSliders />
            </div>
          </div>
          )}

          {/* Resize handle for tuning pane */}
          {!tuningCollapsed && (
          <div
            className="shrink-0 cursor-col-resize group/divider relative"
            style={{ width: 1, marginLeft: -1 }}
            onMouseDown={startTuningResize}
          >
            <div className="absolute inset-y-0 -left-2 -right-2 z-20" />
            <div className="absolute inset-y-0 left-0 w-px bg-border transition-colors group-hover/divider:bg-accent group-active/divider:bg-accent" />
          </div>
          )}

          {/* Right column: shared top zone (histogram OR preview) + timeline */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
            <ResizableRowPane
              storageKey="lrs:editing:timelineHeight"
              defaultBottomHeight={160}
              minBottom={80}
              maxBottom={400}
              collapsed={timelineCollapsed}
              collapsedBottomHeight={42}
              containerClassName="flex flex-col flex-1 h-full min-h-0 overflow-hidden"
              top={
                <div className="h-full flex flex-col min-h-0 overflow-hidden">
                  <div className={!histogramCollapsed ? 'flex-1 flex flex-col min-h-0 overflow-hidden' : 'shrink-0'}>
                    <HighlightHistogram
                      onInspect={() => sidebarRef.current?.switchTab('inspector')}
                      projectId={projectId}
                      collapsed={histogramCollapsed}
                      onToggle={toggleHistogram}
                      eventsLoaded={eventsLoaded}
                    />
                  </div>
                  <div className={!previewCollapsed ? 'flex-1 flex flex-col min-h-0 overflow-hidden' : 'shrink-0'}>
                    <HighlightPreview
                      collapsed={previewCollapsed}
                      onToggle={togglePreview}
                    />
                  </div>
                </div>
              }
              bottom={
                <HighlightTimeline onInspect={() => sidebarRef.current?.switchTab('inspector')} />
              }
            />
          </div>
        </div>
      </div>
    </div>
  )
}


const SEGMENT_TYPES = [
  { id: 'intro',              label: 'Intro',             icon: '🎬', defaultDuration: 10 },
  { id: 'qualifying_results', label: 'Qualifying',        icon: '🏁', defaultDuration: 15 },
  { id: 'race',               label: 'Race',              icon: '🏎️', defaultDuration: null  },
  { id: 'race_results',       label: 'Final Standings',   icon: '🏆', defaultDuration: 20 },
]

/**
 * SegmentBreakdown — Toggle and configure individual race segments.
 * Non-race sections expose a duration input; race duration is automatic.
 */
function SegmentBreakdown({ sections, config, onUpdate, metrics }) {
  // Calculate total duration across enabled segments
  const totalSegmentDuration = SEGMENT_TYPES.reduce((sum, seg) => {
    const cfg = config[seg.id] || {}
    if (cfg.enabled === false) return sum
    const section = sections.find(s => s.name === seg.id || s.type === seg.id)
    return sum + (cfg.duration || section?.duration || 0)
  }, 0)

  return (
    <CollapsibleSection
      icon={Clapperboard}
      label="Race Segments"
      storageKey="lrs:editing:segments:expanded"
      defaultOpen={false}
      right={
        <span className="text-[9px] text-text-disabled font-mono">
          {totalSegmentDuration > 0 ? `${Math.round(totalSegmentDuration / 60)}m` : '—'}
        </span>
      }
    >
      <div className="mt-2 space-y-1.5">
        {SEGMENT_TYPES.map(seg => {
          const cfg = config[seg.id] || {}
          const enabled = cfg.enabled !== false
          const section = sections.find(s => s.name === seg.id || s.type === seg.id)
          const clipCount = section?.clip_count || cfg.clipCount || 0
          const isRace = seg.id === 'race'
          // For b-roll sections, use config override → section actual → default
          const durationSec = !isRace
            ? (cfg.duration ?? section?.duration ?? seg.defaultDuration ?? 10)
            : null

          return (
            <div key={seg.id} className={`flex flex-col gap-1 py-1 px-1.5 rounded transition-colors
              ${enabled ? 'bg-bg-primary/50' : 'opacity-40'}`}>
              {/* Row 1: toggle + label + clip count / auto badge */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onUpdate(seg.id, { enabled: !enabled })}
                  className={`w-4 h-4 rounded border text-center text-[10px] leading-4 transition-colors shrink-0
                    ${enabled
                      ? 'bg-accent border-accent text-white'
                      : 'border-border text-transparent hover:border-accent/50'}`}
                >
                  ✓
                </button>
                <span className="text-xxs" style={{ width: 14 }}>{seg.icon}</span>
                <span className="text-xxs text-text-primary flex-1 truncate">{seg.label}</span>
                {isRace && enabled && (
                  <span className="text-[9px] text-text-disabled font-mono">
                    {clipCount > 0 ? `${clipCount} clips` : '—'}
                  </span>
                )}
                {isRace && enabled && (
                  <span className="text-[9px] text-text-disabled italic font-mono w-8 text-right">auto</span>
                )}
              </div>

              {/* Row 2: duration control for non-race sections */}
              {!isRace && enabled && (
                <div className="flex items-center gap-1.5 pl-6">
                  <span className="text-[9px] text-text-disabled">Duration</span>
                  <div className="flex items-center gap-0.5">
                    <button
                      onClick={() => onUpdate(seg.id, { duration: Math.max(5, (durationSec ?? 10) - 5) })}
                      className="w-4 h-4 rounded text-[10px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors leading-none"
                      title="Decrease by 5s"
                    >−</button>
                    <input
                      type="number"
                      className="w-10 text-center text-[9px] font-mono bg-bg-primary border border-border rounded
                                 text-text-primary focus:outline-none focus:border-accent px-0.5 py-0 leading-tight"
                      style={{ height: 16 }}
                      value={Math.round(durationSec ?? 10)}
                      min={5}
                      max={120}
                      step={5}
                      onChange={e => {
                        const v = parseFloat(e.target.value)
                        if (!isNaN(v) && v >= 1) onUpdate(seg.id, { duration: v })
                      }}
                    />
                    <button
                      onClick={() => onUpdate(seg.id, { duration: Math.min(120, (durationSec ?? 10) + 5) })}
                      className="w-4 h-4 rounded text-[10px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors leading-none"
                      title="Increase by 5s"
                    >+</button>
                  </div>
                  <span className="text-[9px] text-text-disabled">s</span>
                  {section?.duration != null && cfg.duration == null && (
                    <span className="text-[8px] text-text-disabled italic">(actual)</span>
                  )}
                </div>
              )}
            </div>
          )
        })}

        <div className="flex items-center justify-between pt-1 border-t border-border-subtle">
          <span className="text-[9px] text-text-disabled">Non-race sections total</span>
          <span className="text-xxs text-text-primary font-semibold font-mono">
            {totalSegmentDuration > 0
              ? `${Math.floor(totalSegmentDuration / 60)}:${String(Math.floor(totalSegmentDuration % 60)).padStart(2, '0')}`
              : '—'}
          </span>
        </div>
      </div>
    </CollapsibleSection>
  )
}
