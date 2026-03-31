import { useCallback } from 'react'
import Toolbar from './Toolbar'
import Sidebar from './Sidebar'
import StatusBar from './StatusBar'
import ProjectLibrary from '../projects/ProjectLibrary'
import ProjectView from '../projects/ProjectView'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { useProject } from '../../context/ProjectContext'

/**
 * Main application layout shell.
 * Renders: toolbar (top), sidebar (left), main area (center), status bar (bottom).
 */
function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage('sidebar_collapsed', false)
  const { activeProject, openProject, closeProject } = useProject()

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => !prev)
  }, [setSidebarCollapsed])

  const handleOpenProject = useCallback((project) => {
    openProject(project.id)
  }, [openProject])

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-bg-primary">
      {/* Top toolbar */}
      <Toolbar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        projectName={activeProject?.name}
      />

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar */}
        <Sidebar collapsed={sidebarCollapsed} />

        {/* Main area */}
        <main className="flex-1 flex flex-col overflow-hidden bg-bg-primary">
          {activeProject ? (
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
