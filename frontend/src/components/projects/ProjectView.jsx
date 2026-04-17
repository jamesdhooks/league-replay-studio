import { useCallback, useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { useProject } from '../../context/ProjectContext'
import { useAnalysis } from '../../context/AnalysisContext'
import AnalysisPanel from '../analysis/AnalysisPanel'
import HighlightPanel from '../highlights/HighlightPanel'
import OverlayStudio from '../overlay/OverlayStudio'
import CapturePanel from '../capture/CapturePanel'
import EncodingPanel from '../encoding/EncodingPanel'
import CompositionPanel from '../encoding/CompositionPanel'
import YouTubePanel from '../youtube/YouTubePanel'
import PipelinePanel from '../pipeline/PipelinePanel'
import StepGate from '../common/StepGate'
import { useHighlight } from '../../context/HighlightContext'

/**
 * Project view — shown when a project is open.
 * Shows a content-area spinner while the project record is loading,
 * then renders step content.
 */
function ProjectView({ project, isLoading }) {
  const { advanceStep, updateProject } = useProject()
  const { events, eventSummary } = useAnalysis()
  const { videoScript, scriptProjectId } = useHighlight()

  const handleAdvance = useCallback(async () => {
    try {
      await advanceStep(project.id)
    } catch {
      // Advance failed
    }
  }, [project.id, advanceStep])

  const resolvedScript = useMemo(() => {
    if (Array.isArray(project.script) && project.script.length > 0) {
      return project.script
    }
    if (scriptProjectId === project.id && Array.isArray(videoScript) && videoScript.length > 0) {
      return videoScript
    }
    return []
  }, [project.id, project.script, scriptProjectId, videoScript])

  const handleScriptChange = useCallback(async (nextScript) => {
    if (!project?.id || !Array.isArray(nextScript)) return
    await updateProject(project.id, {
      script: nextScript,
    })
  }, [project?.id, updateProject])

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
          <OverlayStudio
            projectId={project.id}
            script={resolvedScript}
            scriptGeneratedAt={project.script_generated_at || null}
            onScriptChange={handleScriptChange}
          />
        )

      case 'capture':
        if (!hasAnalysis) return <StepGate currentStep="capture" requiredStep="analysis" />
        return (
          <CapturePanel
            projectId={project.id}
            script={resolvedScript}
            totalDuration={project.race_duration || 0}
          />
        )

      case 'compose':
        return (
          <CompositionPanel
            projectId={project.id}
            script={resolvedScript}
            clipsManifest={project.clips_manifest || project.clips || []}
            outputDir={project.output_dir || project.project_dir || ''}
          />
        )

      case 'export':
        return <EncodingPanel projectId={project.id} />

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
