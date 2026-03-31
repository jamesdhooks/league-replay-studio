import { useState, useCallback } from 'react'
import Toolbar from './Toolbar'
import Sidebar from './Sidebar'
import StatusBar from './StatusBar'
import { useLocalStorage } from '../../hooks/useLocalStorage'

/**
 * Main application layout shell.
 * Renders: toolbar (top), sidebar (left), main area (center), status bar (bottom).
 */
function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage('sidebar_collapsed', false)

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => !prev)
  }, [setSidebarCollapsed])

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-bg-primary">
      {/* Top toolbar */}
      <Toolbar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
      />

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar */}
        <Sidebar collapsed={sidebarCollapsed} />

        {/* Main area */}
        <main className="flex-1 flex flex-col overflow-hidden bg-bg-primary">
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="text-center space-y-4">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-accent/10 flex items-center justify-center">
                <svg
                  className="w-8 h-8 text-accent"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z"
                  />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-text-primary">
                League Replay Studio
              </h2>
              <p className="text-sm text-text-secondary max-w-md">
                Professional iRacing replay editor. Create a new project or open an existing one to get started.
              </p>
              <div className="flex items-center justify-center gap-3 pt-2">
                <button
                  className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg
                             text-sm font-medium transition-colors"
                >
                  New Project
                </button>
                <button
                  className="px-4 py-2 bg-surface hover:bg-surface-hover text-text-primary
                             rounded-lg text-sm font-medium border border-border transition-colors"
                >
                  Open Project
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* Bottom status bar */}
      <StatusBar />
    </div>
  )
}

export default AppShell
