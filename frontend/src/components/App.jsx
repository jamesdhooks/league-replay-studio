import { useEffect } from 'react'
import { ToastProvider } from '../context/ToastContext'
import { ModalProvider } from '../context/ModalContext'
import { IRacingProvider } from '../context/IRacingContext'
import { ProjectProvider } from '../context/ProjectContext'
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
        <IRacingProvider>
          <ProjectProvider>
            <AppShell />
          </ProjectProvider>
        </IRacingProvider>
      </ModalProvider>
    </ToastProvider>
  )
}

export default App
