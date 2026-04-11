import { useCallback, useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { useProject } from '../../context/ProjectContext'
import { useAnalysis } from '../../context/AnalysisContext'
import AnalysisPanel from '../analysis/AnalysisPanel'
import HighlightPanel from '../highlights/HighlightPanel'
import OverlayPanel from '../overlay/OverlayPanel'
import OverlayPreviewStep from '../overlay/OverlayPreviewStep'
import PipConfigurator from '../overlay/PipConfigurator'
import CapturePanel from '../capture/CapturePanel'
import EncodingPanel from '../encoding/EncodingPanel'
import CompositionPanel from '../encoding/CompositionPanel'
import YouTubePanel from '../youtube/YouTubePanel'
import PipelinePanel from '../pipeline/PipelinePanel'
import StepGate from '../common/StepGate'

/**
 * Project view — shown when a project is open.
 * Shows a content-area spinner while the project record is loading,
 * then renders step content.
 */
function ProjectView({ project, isLoading }) {
  const { advanceStep } = useProject()
  const { events, eventSummary } = useAnalysis()

  const handleAdvance = useCallback(async () => {
    try {
      await advanceStep(project.id)
    } catch {
      // Advance failed
    }
  }, [project.id, advanceStep])

  // While the project record itself is still fetching, show a neutral spinner
  // in the content area (not the analysis-specific one).
  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 animate-fade-in">
        <Loader2 size={22} className="animate-spin text-text-disabled" />
        <p className="text-xs text-text-tertiary">Opening project…</p>
      </div>
    )
  }

  const hasAnalysis = (events?.length > 0) || (eventSummary?.total_events > 0)

  // Determine what to show in the main content area based on current step
  const renderStepContent = () => {
    switch (project.current_step) {
      case 'analysis':
        return <AnalysisPanel />

      case 'editing':
        return <HighlightPanel projectId={project.id} />

      case 'overlay':
        if (!hasAnalysis) return <StepGate currentStep="overlay" requiredStep="analysis" />
        return (
          <div className="flex flex-1 overflow-hidden">
            {/* Left: Overlay template config + PiP */}
            <div className="w-1/2 border-r border-border overflow-y-auto">
              <OverlayPanel />
              <div className="border-t border-border p-4">
                <PipConfigurator projectId={project.id} />
              </div>
            </div>
            {/* Right: Overlay preview with read-only timeline */}
            <div className="w-1/2 overflow-hidden">
              <OverlayPreviewStep
                script={project.script || []}
                projectId={project.id}
              />
            </div>
          </div>
        )

      case 'capture':
        if (!hasAnalysis) return <StepGate currentStep="capture" requiredStep="analysis" />
        return (
          <CapturePanel
            projectId={project.id}
            script={project.script || []}
            totalDuration={project.race_duration || 0}
          />
        )

      case 'export':
        return (
          <div className="flex flex-1 overflow-hidden">
            {/* Left: Standard encoding panel */}
            <div className="w-1/2 border-r border-border overflow-hidden">
              <EncodingPanel projectId={project.id} />
            </div>
            {/* Right: Composition pipeline (trim, overlay, transition, stitch) */}
            <div className="w-1/2 overflow-hidden">
              <CompositionPanel
                projectId={project.id}
                script={project.script || []}
                clipsManifest={project.clips_manifest || project.clips || []}
                outputDir={project.output_dir || project.project_dir || ''}
              />
            </div>
          </div>
        )

      case 'upload':
        return <YouTubePanel />

      case 'pipeline':
        return <PipelinePanel />

      default:
        return (
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <div className="text-center space-y-4 max-w-md">
              <h3 className="text-lg font-semibold text-text-primary capitalize">
                {project.current_step}
              </h3>
              <p className="text-sm text-text-secondary">
                This step is under construction.
              </p>
            </div>
          </div>
        )
    }
  }

  return (
    <div className="flex flex-1 overflow-hidden">
        {/* Step content */}
        {renderStepContent()}
    </div>
  )
}

export default ProjectView
