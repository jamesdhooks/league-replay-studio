import { useState, useEffect, useCallback } from 'react'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { useProject } from '../../context/ProjectContext'
import StepIndicator from './StepIndicator'
import ProjectFileBrowser from './ProjectFileBrowser'
import AnalysisPanel from '../analysis/AnalysisPanel'
import HighlightPanel from '../highlights/HighlightPanel'

/**
 * Project view — shown when a project is open.
 * Displays step indicator, current step content area, and file browser sidebar.
 *
 * @param {Object} props
 * @param {Object} props.project - The active project object
 * @param {() => void} props.onBack - Return to project library
 */
function ProjectView({ project, onBack }) {
  const { advanceStep, setStep } = useProject()
  const [showFileBrowser, setShowFileBrowser] = useState(true)

  const handleStepClick = useCallback(async (stepId) => {
    try {
      await setStep(project.id, stepId)
    } catch {
      // Step navigation failed
    }
  }, [project.id, setStep])

  const handleAdvance = useCallback(async () => {
    try {
      await advanceStep(project.id)
    } catch {
      // Advance failed
    }
  }, [project.id, advanceStep])

  // Labels for each step
  const stepDescriptions = {
    setup: 'Configure project settings and select your replay file.',
    capture: 'Record the replay using OBS, ShadowPlay, or ReLive.',
    analysis: 'Scan the replay to detect race events and key moments.',
    editing: 'Edit the timeline, tune highlights, and configure overlays.',
    export: 'Encode the final video with GPU-accelerated rendering.',
    upload: 'Upload to YouTube or other platforms.',
  }

  const nextStepLabels = {
    setup: 'Begin Capture',
    capture: 'Start Analysis',
    analysis: 'Open Editor',
    editing: 'Export Video',
    export: 'Upload',
    upload: 'Complete',
  }

  // Determine what to show in the main content area based on current step
  const renderStepContent = () => {
    switch (project.current_step) {
      case 'analysis':
        return <AnalysisPanel />

      case 'editing':
        return <HighlightPanel projectId={project.id} />

      default:
        return (
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <div className="text-center space-y-4 max-w-md">
              <h3 className="text-lg font-semibold text-text-primary capitalize">
                {project.current_step}
              </h3>
              <p className="text-sm text-text-secondary">
                {stepDescriptions[project.current_step] || ''}
              </p>

              {project.current_step !== 'upload' && (
                <button
                  onClick={handleAdvance}
                  className="flex items-center gap-1.5 mx-auto px-4 py-2 bg-accent hover:bg-accent-hover
                             text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {nextStepLabels[project.current_step] || 'Continue'}
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        )
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Project header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border shrink-0">
        <button
          onClick={onBack}
          className="p-1 rounded-md hover:bg-surface-hover transition-colors text-text-secondary
                     hover:text-text-primary"
          title="Back to projects"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>

        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-text-primary truncate">
            {project.name}
          </h2>
          {project.track_name && (
            <p className="text-xxs text-text-tertiary truncate">
              {project.track_name}
              {project.session_type && ` · ${project.session_type}`}
            </p>
          )}
        </div>

        <StepIndicator
          currentStep={project.current_step}
          onStepClick={handleStepClick}
        />
      </div>

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Step content */}
        {renderStepContent()}

        {/* File browser sidebar */}
        {showFileBrowser && (
          <div className="w-64 border-l border-border bg-bg-secondary shrink-0 overflow-hidden">
            <ProjectFileBrowser projectId={project.id} />
          </div>
        )}
      </div>
    </div>
  )
}

export default ProjectView
