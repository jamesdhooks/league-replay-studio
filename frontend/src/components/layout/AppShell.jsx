import { useState, useCallback } from 'react'
import Toolbar from './Toolbar'
import Sidebar from './Sidebar'
import StatusBar from './StatusBar'
import ProjectLibrary from '../projects/ProjectLibrary'
import ProjectView from '../projects/ProjectView'
import SettingsPanel from '../settings/SettingsPanel'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { useProject } from '../../context/ProjectContext'
import { useUndoRedo } from '../../context/UndoRedoContext'

/**
 * Main application layout shell.
 * Renders: toolbar (top), sidebar (left), main area (center), status bar (bottom).
 */
function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage('sidebar_collapsed', false)
  const { activeProject, openProject, closeProject } = useProject()
  const [showSettings, setShowSettings] = useState(false)
  const { undo, redo, canUndo, canRedo, history, currentIndex } = useUndoRedo()

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => !prev)
  }, [setSidebarCollapsed])

  const handleOpenProject = useCallback((project) => {
    openProject(project.id)
  }, [openProject])

  const openSettings = useCallback(() => setShowSettings(true), [])
  const closeSettings = useCallback(() => setShowSettings(false), [])

  // Compute undo/redo descriptions for toolbar tooltips
  const undoDescription = canUndo ? history[currentIndex]?.description : undefined
  const redoDescription = canRedo ? history[currentIndex + 1]?.description : undefined

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-bg-primary">
      {/* Top toolbar */}
      <Toolbar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        projectName={activeProject?.name}
        onOpenSettings={openSettings}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        undoDescription={undoDescription}
        redoDescription={redoDescription}
      />

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar — only show when not viewing a project */}
        {!activeProject && !showSettings && (
          <Sidebar collapsed={sidebarCollapsed} onOpenSettings={openSettings} />
        )}

        {/* Main area */}
        <main className="flex-1 flex flex-col overflow-hidden bg-bg-primary">
          {showSettings ? (
            <SettingsPanel onClose={closeSettings} />
          ) : activeProject ? (
            <ProjectView
              project={activeProject}
              onBack={closeProject}
            />
          ) : (
            <ProjectLibrary onOpenProject={handleOpenProject} />
          )}
        </main>
      </div>

      {/* Bottom status bar */}
      <StatusBar />
    </div>
  )
}

export default AppShell
