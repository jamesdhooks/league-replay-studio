import { useEffect, useMemo } from 'react'
import { useHighlight } from '../../context/HighlightContext'
import { useAnalysis } from '../../context/AnalysisContext'
import { useUndoRedo } from '../../context/UndoRedoContext'
import HighlightWeightSliders from './HighlightWeightSliders'
import HighlightEventTable from './HighlightEventTable'
import HighlightMetrics from './HighlightMetrics'
import HighlightHistogram from './HighlightHistogram'
import HighlightConfigBar from './HighlightConfigBar'
import EventInspectorPanel from '../inspector/EventInspectorPanel'
import EditHistoryPanel from '../history/EditHistoryPanel'
import Timeline from '../timeline/Timeline'
import PreviewPanel from '../preview/PreviewPanel'
import ProjectFileBrowser from '../projects/ProjectFileBrowser'
import ResizableSidebar from '../layout/ResizableSidebar'
import { Sparkles, List, Search, History, Folder } from 'lucide-react'

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
  const { loadConfig, loadDrivers, loadPresets } = useHighlight()
  const { fetchEvents, events } = useAnalysis()
  const { history } = useUndoRedo()

  // Load highlight data on mount
  useEffect(() => {
    if (projectId) {
      fetchEvents(projectId, { limit: 1000 })
      loadConfig(projectId)
      loadDrivers(projectId)
      loadPresets()
    }
  }, [projectId, loadConfig, loadDrivers, loadPresets, fetchEvents])

  const sidebarTabs = useMemo(() => [
    {
      id: 'events',
      label: 'Events',
      icon: List,
      count: events.length,
      content: <HighlightEventTable />,
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
    <div className="flex flex-col h-full overflow-hidden">
      {/* Config bar (presets + A/B compare) */}
      <HighlightConfigBar projectId={projectId} />

      <div className="flex flex-1 min-h-0 overflow-hidden relative">
        {/* Left sidebar with Events/Inspector/History/Files tabs */}
        <ResizableSidebar
          storageKey="lrs:editing:sidebar"
          defaultTab="events"
          tabs={sidebarTabs}
        />

        {/* Right side: single column */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Top: Highlight tuning */}
          <div className="flex-1 flex min-h-0 overflow-hidden">
            {/* Weight sliders + metrics */}
            <div className="w-72 shrink-0 border-r border-border overflow-y-auto bg-bg-secondary">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                <Sparkles className="w-4 h-4 text-accent" />
                <h3 className="text-xs font-semibold text-text-primary uppercase tracking-wider">
                  Highlight Tuning
                </h3>
              </div>
              <HighlightWeightSliders />
              <HighlightMetrics />
            </div>

            {/* Histogram-based event organizer */}
            <div className="flex-1 flex flex-col min-w-0">
              <div className="flex-1 min-h-0 overflow-hidden">
                <HighlightHistogram />
              </div>
            </div>
          </div>

          {/* Bottom: Preview + NLE Timeline */}
          <div className="h-56 shrink-0 border-t border-border">
            <PreviewPanel projectId={projectId} />
          </div>
          <div className="h-40 shrink-0 border-t border-border">
            <Timeline projectId={projectId} />
          </div>
        </div>
      </div>
    </div>
  )
}
