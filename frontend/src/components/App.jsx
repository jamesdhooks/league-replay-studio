import { useState, useEffect } from 'react'
import { ToastProvider } from '../context/ToastContext'
import { ModalProvider } from '../context/ModalContext'
import { IRacingProvider } from '../context/IRacingContext'
import { ProjectProvider } from '../context/ProjectContext'
import { SettingsProvider } from '../context/SettingsContext'
import { useSettings } from '../context/SettingsContext'
import { AnalysisProvider } from '../context/AnalysisContext'
import { CaptureProvider } from '../context/CaptureContext'
import { UndoRedoProvider } from '../context/UndoRedoContext'
import { TimelineProvider } from '../context/TimelineContext'
import { HighlightProvider } from '../context/HighlightContext'
import { EncodingProvider } from '../context/EncodingContext'
import { PreviewProvider } from '../context/PreviewContext'
import { OverlayProvider } from '../context/OverlayContext'
import { PresetProvider } from '../context/PresetContext'
import { YouTubeProvider } from '../context/YouTubeContext'
import { PipelineProvider } from '../context/PipelineContext'
import { wsClient } from '../services/websocket'
import AppShell from './layout/AppShell'
import SetupWizard from './wizard/SetupWizard'

/**
 * Checks wizard status and shows SetupWizard when needed.
 * Must be rendered inside SettingsProvider.
 */
function WizardController() {
  const { updateSettings } = useSettings()
  const [showWizard, setShowWizard] = useState(false)

  useEffect(() => {
    fetch('/api/wizard/status')
      .then((r) => r.json())
      .then((data) => {
        if (!data.completed) setShowWizard(true)
      })
      .catch(() => {
        // If the endpoint fails, don't block the user
      })
  }, [])

  const handleComplete = async (collectedSettings) => {
    try {
      await fetch('/api/wizard/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: collectedSettings }),
      })
      await updateSettings({ ...collectedSettings, wizard_completed: true })
    } catch {
      // Non-fatal — wizard still closes
    }
    setShowWizard(false)
  }

  const handleSkip = async () => {
    try {
      await fetch('/api/wizard/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: {} }),
      })
      await updateSettings({ wizard_completed: true })
    } catch {
      // Non-fatal
    }
    setShowWizard(false)
  }

  if (!showWizard) return null
  return <SetupWizard onComplete={handleComplete} onSkip={handleSkip} />
}

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
                <CaptureProvider>
                  <EncodingProvider>
                    <PreviewProvider>
                      <OverlayProvider>
                        <PresetProvider>
                        <YouTubeProvider>
                          <PipelineProvider>
                            <UndoRedoProvider>
                            <TimelineProvider>
                              <HighlightProvider>
                                <AppShell />
                                <WizardController />
                              </HighlightProvider>
                            </TimelineProvider>
                            </UndoRedoProvider>
                          </PipelineProvider>
                        </YouTubeProvider>
                        </PresetProvider>
                      </OverlayProvider>
                    </PreviewProvider>
                  </EncodingProvider>
                </CaptureProvider>
              </AnalysisProvider>
            </ProjectProvider>
          </IRacingProvider>
        </SettingsProvider>
      </ModalProvider>
    </ToastProvider>
  )
}

export default App
