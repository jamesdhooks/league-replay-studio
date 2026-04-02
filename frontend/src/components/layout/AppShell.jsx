import { useState, useCallback } from 'react'
import Toolbar from './Toolbar'
import ProjectLibrary from '../projects/ProjectLibrary'
import ProjectView from '../projects/ProjectView'
import SettingsPanel from '../settings/SettingsPanel'
import HelpPanel from '../help/HelpPanel'
import { useProject } from '../../context/ProjectContext'
import { useAnalysis } from '../../context/AnalysisContext'
import { useUndoRedo } from '../../context/UndoRedoContext'

/**
 * Main application layout shell.
 * Renders: toolbar (top), sidebar (left), main area (center), status bar (bottom).
 */
function AppShell() {
  const { activeProject, openProject, closeProject, setStep } = useProject()
  const { events, eventSummary } = useAnalysis()
  const [showSettings, setShowSettings] = useState(false)
  const { undo, redo, canUndo, canRedo, history, currentIndex } = useUndoRedo()

  const handleOpenProject = useCallback((project) => {
    openProject(project.id)
  }, [openProject])

  const handleStepClick = useCallback(async (stepId) => {
    if (activeProject) {
      try { await setStep(activeProject.id, stepId) } catch {}
    }
  }, [activeProject, setStep])

  const [showHelp, setShowHelp] = useState(false)
  const openSettings = useCallback(() => setShowSettings(true), [])
  const closeSettings = useCallback(() => setShowSettings(false), [])
  const openHelp = useCallback(() => setShowHelp(true), [])
  const closeHelp = useCallback(() => setShowHelp(false), [])

  // Compute undo/redo descriptions for toolbar tooltips
  const undoDescription = canUndo ? history[currentIndex]?.description : undefined
  const redoDescription = canRedo ? history[currentIndex + 1]?.description : undefined

  // Compute step readiness based on available data
  const hasAnalysis = (events?.length > 0) || (eventSummary?.total_events > 0)
  const stepReadiness = {
    analysis: true,
    editing: hasAnalysis,
    capture: hasAnalysis,
    export: true,
    upload: true,
  }

  return (
    <>
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-bg-primary">
      {/* Top toolbar */}
      <Toolbar
        activeProject={activeProject}
        onBack={closeProject}
        onStepClick={handleStepClick}
        stepReadiness={stepReadiness}
        onOpenSettings={openSettings}
        onOpenHelp={openHelp}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        undoDescription={undoDescription}
        redoDescription={redoDescription}
      />

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Main area */}
        <main className="flex-1 flex flex-col overflow-hidden bg-bg-primary">
          {showSettings ? (
            <SettingsPanel onClose={closeSettings} />
          ) : activeProject ? (
            <ProjectView
              project={activeProject}
            />
          ) : (
            <ProjectLibrary onOpenProject={handleOpenProject} />
          )}
        </main>
      </div>
    </div>

    {showHelp && <HelpPanel onClose={closeHelp} />}
    </>
  )
}

export default AppShell
