import { useEffect } from 'react'
import { ToastProvider } from '../context/ToastContext'
import { ModalProvider } from '../context/ModalContext'
import { IRacingProvider } from '../context/IRacingContext'
import { ProjectProvider } from '../context/ProjectContext'
import { SettingsProvider } from '../context/SettingsContext'
import { AnalysisProvider } from '../context/AnalysisContext'
import { wsClient } from '../services/websocket'
import AppShell from './layout/AppShell'

/**
 * Root application component.
 * Wraps all providers and renders the layout shell.
 */
function App() {
  // Start the WebSocket connection when the app mounts
  useEffect(() => {
    wsClient.connect()
    return () => wsClient.disconnect()
  }, [])

  return (
    <ToastProvider>
      <ModalProvider>
        <SettingsProvider>
          <IRacingProvider>
            <ProjectProvider>
              <AnalysisProvider>
                <AppShell />
              </AnalysisProvider>
            </ProjectProvider>
          </IRacingProvider>
        </SettingsProvider>
      </ModalProvider>
    </ToastProvider>
  )
}

export default App
