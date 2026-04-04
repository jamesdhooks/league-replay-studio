import { useEffect } from 'react'
import { useTimeline } from '../../context/TimelineContext'
import { useAnalysis } from '../../context/AnalysisContext'
import TimelineCanvas from './TimelineCanvas'
import TimelineToolbar from './TimelineToolbar'
import TimelineContextMenu from './TimelineContextMenu'
import { Film } from 'lucide-react'

/**
 * Timeline — NLE-style multi-track timeline editor.
 *
 * Integrates the canvas renderer, toolbar controls, and context menu.
 * Loads race data on mount and registers keyboard shortcuts.
 *
 * @param {Object} props
 * @param {number} props.projectId - Active project ID
 */
export default function Timeline({ projectId }) {
  const { loadRaceDuration, handleKeyDown, raceDuration, setActiveProjectId } = useTimeline()
  const { fetchEvents, events } = useAnalysis()

  // Load race data on mount / project change
  useEffect(() => {
    if (projectId) {
      loadRaceDuration(projectId)
      fetchEvents(projectId, { limit: 1000 })
      setActiveProjectId(projectId)
    }
    return () => {
      setActiveProjectId(null)
    }
  }, [projectId, loadRaceDuration, fetchEvents, setActiveProjectId])

  // Register keyboard shortcuts
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // Empty state
  if (raceDuration <= 0 && events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-tertiary gap-2 p-8">
        <Film size={32} className="opacity-50" />
        <p className="text-sm font-medium">No timeline data available</p>
        <p className="text-xs text-text-disabled">
          Run analysis first to detect events and populate the timeline.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg-primary">
      {/* Toolbar with zoom, playback, and in/out controls */}
      <TimelineToolbar />

      {/* Canvas-based timeline */}
      <TimelineCanvas />

      {/* Right-click context menu */}
      <TimelineContextMenu projectId={projectId} />
    </div>
  )
}
