import { useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import { useProject } from '../../context/ProjectContext'
import { useAnalysis } from '../../context/AnalysisContext'
import AnalysisPanel from '../analysis/AnalysisPanel'
import HighlightPanel from '../highlights/HighlightPanel'
import CapturePanel from '../capture/CapturePanel'
import EncodingPanel from '../encoding/EncodingPanel'
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
        if (!hasAnalysis) return <StepGate currentStep="editing" requiredStep="analysis" />
        return <HighlightPanel projectId={project.id} />

      case 'capture':
        if (!hasAnalysis) return <StepGate currentStep="capture" requiredStep="analysis" />
        return <CapturePanel projectId={project.id} />

      case 'export':
        return <EncodingPanel projectId={project.id} />

      case 'upload':
        return (
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <div className="text-center space-y-4 max-w-md">
              <h3 className="text-lg font-semibold text-text-primary">Upload</h3>
              <p className="text-sm text-text-secondary">
                Upload to YouTube or other platforms.
              </p>
            </div>
          </div>
        )

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
