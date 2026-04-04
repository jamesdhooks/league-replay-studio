import { useState, useCallback, useEffect, lazy, Suspense, useTransition } from 'react'
import { Loader2, BarChart3 } from 'lucide-react'
import Toolbar from './Toolbar'
import { useProject } from '../../context/ProjectContext'
import { useAnalysis } from '../../context/AnalysisContext'
import { useUndoRedo } from '../../context/UndoRedoContext'
import { useSettings } from '../../context/SettingsContext'

// ── Lazy-loaded panels (code splitting) ──────────────────────────────────────
const ProjectLibrary = lazy(() => import('../projects/ProjectLibrary'))
const ProjectView = lazy(() => import('../projects/ProjectView'))
const SettingsPanel = lazy(() => import('../settings/SettingsPanel'))
const HelpPanel = lazy(() => import('../help/HelpPanel'))

/** Inline fallback for Suspense boundaries */
function PanelFallback() {
  return (
    <div className="flex items-center justify-center h-full text-zinc-500">
      <Loader2 className="w-6 h-6 animate-spin mr-2" />
      Loading…
    </div>
  )
}

/**
 * Main application layout shell.
 * Renders: toolbar (top), sidebar (left), main area (center), status bar (bottom).
 */
function AppShell() {
  const { activeProject, openProject, closeProject, setStep } = useProject()
  const { events, eventSummary } = useAnalysis()
  const { loading: settingsLoading } = useSettings()
  const [showSettings, setShowSettings] = useState(false)
  const { undo, redo, canUndo, canRedo, history, currentIndex } = useUndoRedo()

  // React 19 concurrent: mark project loading as a non-urgent transition
  const [isPending, startTransition] = useTransition()

  // True while a project is being fetched after the user clicks open
  const [projectLoading, setProjectLoading] = useState(false)

  // App-ready fade: once settings load, flip appReady so we can fade out the splash
  const [appReady, setAppReady] = useState(false)
  const [splashDone, setSplashDone] = useState(false)
  useEffect(() => {
    if (!settingsLoading) {
      setAppReady(true)
      // Keep splash mounted briefly so the fade-out animation plays
      const t = setTimeout(() => setSplashDone(true), 600)
      return () => clearTimeout(t)
    }
  }, [settingsLoading])

  const handleOpenProject = useCallback(async (project) => {
    setProjectLoading(true)
    try {
      // Use React 19 transition to keep UI responsive during heavy state update
      startTransition(() => {
        openProject(project.id).finally(() => setProjectLoading(false))
      })
    } catch {
      setProjectLoading(false)
    }
  }, [openProject, startTransition])

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
    {/* ── Full-screen app splash (settings / backend boot) ──────────────── */}
    {!splashDone && (
      <div
        className={`fixed inset-0 z-50 flex flex-col items-center justify-center
                    bg-bg-primary transition-opacity duration-500
                    ${appReady ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
      >
        <div className="flex flex-col items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-gradient-from via-gradient-via to-gradient-to
                          flex items-center justify-center shadow-glow">
            <BarChart3 size={30} className="text-white" />
          </div>
          <div className="text-center">
            <p className="text-base font-bold text-text-primary tracking-tight">League Replay Studio</p>
            <p className="text-xs text-text-tertiary mt-1">Starting up…</p>
          </div>
          <Loader2 size={18} className="animate-spin text-text-disabled mt-2" />
        </div>
      </div>
    )}

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
          <Suspense fallback={<PanelFallback />}>
            {showSettings ? (
              <SettingsPanel onClose={closeSettings} />
            ) : activeProject ? (
              <ProjectView
                project={activeProject}
                isLoading={projectLoading}
              />
            ) : (
              <ProjectLibrary onOpenProject={handleOpenProject} />
            )}
          </Suspense>
        </main>
      </div>
    </div>

    <Suspense fallback={null}>
      {showHelp && <HelpPanel onClose={closeHelp} />}
    </Suspense>
    </>
  )
}

export default AppShell
