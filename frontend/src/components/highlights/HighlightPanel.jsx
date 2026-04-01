import { useEffect } from 'react'
import { useHighlight, EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { useAnalysis } from '../../context/AnalysisContext'
import { useTimeline } from '../../context/TimelineContext'
import { useUndoRedo } from '../../context/UndoRedoContext'
import HighlightWeightSliders from './HighlightWeightSliders'
import HighlightEventTable from './HighlightEventTable'
import HighlightMetrics from './HighlightMetrics'
import HighlightTimeline from './HighlightTimeline'
import HighlightConfigBar from './HighlightConfigBar'
import EventInspectorPanel from '../inspector/EventInspectorPanel'
import EditHistoryPanel from '../history/EditHistoryPanel'
import Timeline from '../timeline/Timeline'
import { Sparkles } from 'lucide-react'

/**
 * HighlightPanel — Main container for the Highlight Editing Suite.
 *
 * Orchestrates: weight sliders, event table, metrics, timeline preview,
 * config bar (presets + A/B), event inspector / edit history, and the NLE timeline.
 *
 * @param {Object} props
 * @param {number} props.projectId - Active project ID
 */
export default function HighlightPanel({ projectId }) {
  const { loadConfig, loadDrivers, loadPresets } = useHighlight()
  const { fetchEvents } = useAnalysis()
  const { selectedEventId } = useTimeline()
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

  // Show right panel when event selected OR when there's history to show
  const showRightPanel = selectedEventId || history.length > 0

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Config bar (presets + A/B compare) */}
      <HighlightConfigBar projectId={projectId} />

      {/* Main editing area */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left panel: weights + metrics */}
        <div className="w-72 shrink-0 border-r border-border overflow-y-auto bg-bg-secondary">
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
            <Sparkles className="w-4 h-4 text-accent" />
            <h3 className="text-xs font-semibold text-text-primary uppercase tracking-wider">
              Highlight Tuning
            </h3>
          </div>

          {/* Weight sliders */}
          <HighlightWeightSliders />

          {/* Metrics dashboard */}
          <HighlightMetrics />
        </div>

        {/* Center panel: event table + highlight timeline */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Event selection table */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <HighlightEventTable />
          </div>

          {/* Highlight timeline preview */}
          <div className="h-16 shrink-0 border-t border-border">
            <HighlightTimeline />
          </div>
        </div>

        {/* Right panel: Inspector (event selected) or Edit History */}
        {showRightPanel && (
          <div className="w-72 shrink-0 border-l border-border bg-bg-secondary overflow-hidden">
            {selectedEventId ? (
              <EventInspectorPanel projectId={projectId} />
            ) : (
              <EditHistoryPanel />
            )}
          </div>
        )}
      </div>

      {/* NLE Timeline at bottom */}
      <div className="h-56 shrink-0 border-t border-border">
        <Timeline projectId={projectId} />
      </div>
    </div>
  )
}
