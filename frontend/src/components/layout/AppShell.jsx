import { useState, useCallback, useEffect, useRef, useMemo, lazy, Suspense, useTransition } from 'react'
import { Loader2, FolderOpen, Radio } from 'lucide-react'
import Toolbar from './Toolbar'
import { useProject } from '../../context/ProjectContext'
import { useAnalysis } from '../../context/AnalysisContext'
import { useHighlight } from '../../context/HighlightContext'
import { useUndoRedo } from '../../context/UndoRedoContext'
import { useSettings } from '../../context/SettingsContext'
import { usePipeline } from '../../context/PipelineContext'
import { useHotkeys } from '../../hooks/useHotkeys'
import { useSharedPreviewSurface } from '../../context/SharedPreviewSurfaceContext'
import SharedPreviewHost from '../ui/SharedPreviewHost'

// ── Lazy-loaded panels (code splitting) ──────────────────────────────────────
const ProjectLibrary = lazy(() => import('../projects/ProjectLibrary'))
const ProjectView = lazy(() => import('../projects/ProjectView'))
const SettingsPanel = lazy(() => import('../settings/SettingsPanel'))
const HelpPanel = lazy(() => import('../help/HelpPanel'))
const CollectPage = lazy(() => import('../collect/CollectPage'))

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
// ── Top-level nav tabs (shown on the home screen, no active project) ─────────
const HOME_TABS = [
  { id: 'projects', label: 'Projects', icon: FolderOpen },
  { id: 'collect',  label: 'Collect',  icon: Radio },
]

function AppShell() {
  const [activeTab, setActiveTab] = useState('projects')
  const { activeProject, openProject, closeProject, setStep } = useProject()
  const { events, eventSummary, isAnalyzing, progress: analysisProgress } = useAnalysis()
  const { videoScript, scriptProjectId } = useHighlight()
  const { currentRun, currentStep: pipelineCurrentStep } = usePipeline()
  const { loading: settingsLoading } = useSettings()
  const [showSettings, setShowSettings] = useState(false)
  const { undo, redo, canUndo, canRedo } = useUndoRedo()

  // React 19 concurrent: mark project loading as a non-urgent transition
  const [isPending, startTransition] = useTransition()

  // True while a project is being fetched after the user clicks open
  const [projectLoading, setProjectLoading] = useState(false)
  const [pipelineAdvancedMode, setPipelineAdvancedMode] = useState(() => {
    try {
      const saved = localStorage.getItem('lrs_pipeline_advanced_mode')
      if (saved == null) return true
      return saved === '1'
    } catch {
      return true
    }
  })
  const fallbackPreviewRef = useRef(null)
  const { registerFallbackTarget, unregisterFallbackTarget } = useSharedPreviewSurface()

  useEffect(() => {
    if (!fallbackPreviewRef.current) return undefined
    const element = fallbackPreviewRef.current
    registerFallbackTarget(element)
    return () => unregisterFallbackTarget(element)
  }, [registerFallbackTarget, unregisterFallbackTarget])

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

  const togglePipelineAdvancedMode = useCallback(() => {
    setPipelineAdvancedMode((prev) => {
      const next = !prev
      try {
        localStorage.setItem('lrs_pipeline_advanced_mode', next ? '1' : '0')
      } catch {
        // ignore storage failures
      }
      return next
    })
  }, [])

  const [showHelp, setShowHelp] = useState(false)
  const openSettings = useCallback(() => setShowSettings(true), [])
  const closeSettings = useCallback(() => setShowSettings(false), [])
  const openHelp = useCallback(() => setShowHelp(true), [])
  const closeHelp = useCallback(() => setShowHelp(false), [])

  // ── Global keyboard shortcuts ──────────────────────────────────────────
  useHotkeys('mod+z', () => canUndo && undo(), {
    description: 'Undo',
    scope: 'global',
  })
  useHotkeys('mod+shift+z', () => canRedo && redo(), {
    description: 'Redo',
    scope: 'global',
  })
  useHotkeys('mod+,', () => setShowSettings((v) => !v), {
    description: 'Toggle settings',
    scope: 'global',
  })
  useHotkeys('escape', () => {
    if (showSettings) closeSettings()
    else if (showHelp) closeHelp()
  }, {
    description: 'Close panel',
    scope: 'global',
    enabled: showSettings || showHelp,
  })

  // Compute step readiness based on available data
  const STEP_ORDER = ['pipeline', 'analysis', 'editing', 'overlay', 'capture', 'compose', 'export', 'upload']
  const analysisStepIndex = STEP_ORDER.indexOf('analysis')
  const editingStepIndex = STEP_ORDER.indexOf('editing')
  const currentStepIndex = STEP_ORDER.indexOf(activeProject?.current_step)
  const projectHasPassedAnalysis = currentStepIndex > analysisStepIndex
  const projectHasPassedEditing = currentStepIndex > editingStepIndex

  const hasAnalysis = projectHasPassedAnalysis || (events?.length > 0) || (eventSummary?.total_events > 0)

  const hasProjectScript = Array.isArray(activeProject?.script) && activeProject.script.length > 0
  const hasCachedScript = scriptProjectId === activeProject?.id && Array.isArray(videoScript) && videoScript.length > 0
  const hasPersistedScriptMarker = Boolean(activeProject?.script_generated_at)
  const hasScript = hasProjectScript || hasCachedScript || hasPersistedScriptMarker

  const hasEditing = hasScript || projectHasPassedEditing
  const pipelineRunForActiveProject = currentRun && activeProject && currentRun.project_id === activeProject.id
    ? currentRun
    : null

  const pipelineAnalysisProgress = useMemo(() => {
    const percent = pipelineRunForActiveProject?.steps?.analysis?.progress
    if (percent == null) return null
    return {
      percent: Number(percent),
      message: 'Automated analysis running…',
    }
  }, [pipelineRunForActiveProject])

  const effectiveAnalysisProgress = isAnalyzing ? analysisProgress : pipelineAnalysisProgress

  const stepReadiness = {
    pipeline: true,
    analysis: true,
    editing: hasEditing,
    overlay: hasAnalysis && hasScript,
    capture: hasAnalysis && hasScript,
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
          <img
            src="/assets/logo_2048.png"
            alt="League Replay Studio"
            className="w-16 h-16 object-contain drop-shadow-[0_0_10px_rgba(255,255,255,0.22)]"
          />
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
        pipelineExecutionSteps={pipelineRunForActiveProject?.steps || {}}
        pipelineRunningStep={pipelineRunForActiveProject?.current_step || null}
        pipelineAdvancedMode={pipelineAdvancedMode}
        onTogglePipelineAdvancedMode={togglePipelineAdvancedMode}
        analysisProgress={effectiveAnalysisProgress}
        onOpenSettings={openSettings}
        onOpenHelp={openHelp}
      />

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Tab bar — only shown on home screen (no active project, no settings) */}
        {!activeProject && !showSettings && (
          <nav className="flex shrink-0 border-b border-border bg-bg-secondary px-4">
            {HOME_TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium
                            border-b-2 transition-all duration-150
                  ${activeTab === id
                    ? 'border-accent text-accent'
                    : 'border-transparent text-text-secondary hover:text-text-primary hover:border-border'
                  }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </nav>
        )}

        {/* Main area */}
        <main className="flex-1 flex flex-col overflow-hidden bg-bg-primary">
          <Suspense fallback={<PanelFallback />}>
            {showSettings ? (
              <SettingsPanel onClose={closeSettings} />
            ) : activeProject ? (
              <ProjectView
                project={activeProject}
                isLoading={projectLoading}
                pipelineAdvancedMode={pipelineAdvancedMode}
              />
            ) : activeTab === 'collect' ? (
              <CollectPage />
            ) : (
              <ProjectLibrary onOpenProject={handleOpenProject} />
            )}
          </Suspense>
        </main>

        <SharedPreviewHost />
      </div>

      <div
        ref={fallbackPreviewRef}
        className="fixed right-4 bottom-4 w-[360px] max-w-[calc(100vw-2rem)] aspect-video pointer-events-none"
      />
    </div>

    <Suspense fallback={null}>
      {showHelp && <HelpPanel onClose={closeHelp} />}
    </Suspense>
    </>
  )
}

export default AppShell
