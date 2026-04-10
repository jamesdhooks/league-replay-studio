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
import { Sparkles, List, Search, History, Folder, Film, Scissors, Clapperboard, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react'

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
  const { loadConfig, loadDrivers, loadPresets, replayMode, setReplayMode, presets, loadPreset, savePreset, deletePreset, videoSections, sectionConfig, updateSectionConfig, metrics, currentPresetId, hasUnsavedChanges } = useHighlight()
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

  // Resizable timeline pane height (bottom of right column)
  const [timelineHeight, setTimelineHeight] = useLocalStorage('lrs:editing:timelineHeight', 160)
  const timelineHeightRef = useRef(timelineHeight)
  useEffect(() => { timelineHeightRef.current = timelineHeight }, [timelineHeight])

  const startTimelineResize = useCallback((e) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = timelineHeightRef.current
    const onMove = (mv) => {
      const h = Math.max(80, Math.min(400, startH - (mv.clientY - startY)))
      setTimelineHeight(h)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [setTimelineHeight])

  // Histogram + Preview: collapsed state (mutually exclusive — only one expands at a time)
  const [histogramCollapsed, setHistogramCollapsed] = useLocalStorage('lrs:editing:histogramCollapsed', false)
  const [previewCollapsed, setPreviewCollapsed] = useLocalStorage('lrs:editing:previewCollapsed', true)

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
            <button
              onClick={() => setTuningCollapsed(false)}
              className="shrink-0 w-9 border-r border-border bg-bg-secondary flex flex-col items-center py-2 gap-3
                         hover:bg-bg-primary/50 transition-colors cursor-pointer"
              title="Expand Editing Controls"
            >
              <Sparkles className="w-4 h-4 text-accent" />
            </button>
          )}

          {/* Editing Controls pane (resizable) */}
          {!tuningCollapsed && (
          <div
            ref={tuningRef}
            className="shrink-0 border-r border-border bg-bg-secondary flex flex-col min-h-0"
            style={{ width: tuningWidth }}
          >
            {/* Section header */}
            <button
              onClick={() => setTuningCollapsed(true)}
              className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 w-full text-left hover:bg-bg-primary/50 transition-colors"
            >
              <Sparkles className="w-4 h-4 text-accent" />
              <h3 className="text-xs font-semibold text-text-primary uppercase tracking-wider flex-1">
                Editing Controls
              </h3>
              <ChevronRight className="w-3 h-3 text-text-tertiary" />
            </button>
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

            {/* Presets — inline below mode toggle */}
            <PresetSelector
              presets={presets}
              currentPresetId={currentPresetId}
              hasUnsavedChanges={hasUnsavedChanges}
              onLoad={loadPreset}
              onSave={savePreset}
              onDelete={deletePreset}
            />

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

            {/* Top zone — always flex-1; histogram and preview share this space.
                The active panel fills the zone; the collapsed one shows header only. */}
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
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

            {/* Resize handle — splits top zone from timeline */}
            <div
              className="shrink-0 cursor-row-resize group/divider relative"
              style={{ height: 1, marginTop: -1 }}
              onMouseDown={startTimelineResize}
            >
              <div className="absolute inset-x-0 -top-2 -bottom-2 z-20" />
              <div className="absolute inset-x-0 top-0 h-px bg-border transition-colors group-hover/divider:bg-accent group-active/divider:bg-accent" />
            </div>

            {/* Timeline strip (bottom, fixed height) */}
            <div
              className="shrink-0 overflow-hidden"
              style={{ height: timelineHeight }}
            >
              <HighlightTimeline />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


/**
 * PresetSelector — Compact inline preset picker for the tuning pane.
 */
function PresetSelector({ presets, onLoad, onSave, onDelete, currentPresetId, hasUnsavedChanges }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')

  const handleSave = async () => {
    if (!name.trim()) return
    try {
      await onSave(name.trim())
      setName('')
      setSaving(false)
    } catch {}
  }

  return (
    <div className="px-3 py-2 border-b border-border-subtle shrink-0">
      <div className="flex items-center gap-1.5">
        <span className="text-xxs text-text-tertiary font-medium">Preset:</span>
        <div className="relative flex-1">
          <button
            onClick={() => setOpen(v => !v)}
            className="w-full flex items-center justify-between px-2 py-1 text-xxs bg-bg-primary border border-border
                       rounded text-text-primary hover:border-accent transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="truncate">
                {currentPresetId && !hasUnsavedChanges ? currentPresetId : 'Select preset...'}
              </span>
              {hasUnsavedChanges && (
                <span title="Unsaved changes" className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0"></span>
              )}
            </div>
            <Folder className="w-3 h-3 text-text-disabled shrink-0" />
          </button>
          {open && (
            <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-bg-secondary border border-border rounded-lg shadow-lg py-1">
              {presets.length === 0 && (
                <div className="px-3 py-2 text-xxs text-text-disabled">No presets</div>
              )}
              {presets.map(p => (
                <div key={p.name} className="flex items-center gap-1 px-3 py-1 hover:bg-bg-hover">
                  <button onClick={() => { onLoad(p); setOpen(false) }} className="flex-1 text-left text-xxs text-text-primary truncate">
                    {p.name}
                  </button>
                  <button onClick={() => onDelete(p.name)} className="p-0.5 text-text-disabled hover:text-danger">
                    ×
                  </button>
                </div>
              ))}
              <div className="border-t border-border-subtle mt-1 pt-1 px-3 py-1">
                {saving ? (
                  <div className="flex items-center gap-1">
                    <input
                      type="text" value={name} onChange={e => setName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleSave()}
                      placeholder="Preset name..." autoFocus
                      className="flex-1 px-1.5 py-0.5 text-xxs bg-bg-primary border border-border rounded text-text-primary
                                 placeholder:text-text-disabled focus:outline-none focus:border-accent"
                    />
                    <button onClick={handleSave} className="text-xxs text-accent hover:text-accent-hover">Save</button>
                  </div>
                ) : (
                  <button onClick={() => setSaving(true)} className="text-xxs text-accent hover:text-accent-hover">
                    + Save current...
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}


const SEGMENT_TYPES = [
  { id: 'intro', label: 'Intro', icon: '🎬' },
  { id: 'qualifying', label: 'Qualifying', icon: '🏁' },
  { id: 'race', label: 'Race', icon: '🏎️' },
  { id: 'final_standings', label: 'Final Standings', icon: '🏆' },
]

/**
 * SegmentBreakdown — Toggle and configure individual race segments.
 * Each segment can be enabled/disabled and has its own clip allocation.
 * Total video duration = sum of all enabled segments.
 */
function SegmentBreakdown({ sections, config, onUpdate, metrics }) {
  const [expanded, setExpanded] = useLocalStorage('lrs:editing:segments:expanded', false)

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
      open={expanded}
      onToggle={() => setExpanded(v => !v)}
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
          const segDuration = cfg.duration || section?.duration || 0

          return (
            <div key={seg.id} className={`flex items-center gap-2 py-1 px-1.5 rounded transition-colors
              ${enabled ? 'bg-bg-primary/50' : 'opacity-40'}`}>
              <button
                onClick={() => onUpdate(seg.id, { enabled: !enabled })}
                className={`w-4 h-4 rounded border text-center text-[10px] leading-4 transition-colors
                  ${enabled
                    ? 'bg-accent border-accent text-white'
                    : 'border-border text-transparent hover:border-accent/50'}`}
              >
                ✓
              </button>
              <span className="text-xxs" style={{ width: 14 }}>{seg.icon}</span>
              <span className="text-xxs text-text-primary flex-1 truncate">{seg.label}</span>
              {enabled && (
                <>
                  <span className="text-[9px] text-text-disabled font-mono">
                    {clipCount > 0 ? `${clipCount} clips` : '—'}
                  </span>
                  <span className="text-[9px] text-text-disabled font-mono w-8 text-right">
                    {segDuration > 0 ? `${Math.round(segDuration)}s` : '—'}
                  </span>
                </>
              )}
            </div>
          )
        })}

        <div className="flex items-center justify-between pt-1 border-t border-border-subtle">
          <span className="text-[9px] text-text-disabled">Total video duration</span>
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
