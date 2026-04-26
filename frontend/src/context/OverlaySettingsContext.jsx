import { createContext, useContext } from 'react'
import { useLocalStorage } from '../hooks/useLocalStorage'

const OverlaySettingsContext = createContext(null)

/**
 * Provider for shared overlay studio settings (render mode, zoom, visibility, stream)
 * Available to all tabs: Preview, Design, Build, Data, PiP
 */
export function OverlaySettingsProvider({ children }) {
  const [previewRenderMode, setPreviewRenderMode] = useLocalStorage('lrs:overlay:global:renderMode', 'png')
  const [overlayVisible, setOverlayVisible] = useLocalStorage('lrs:overlay:global:overlayVisible', true)
  const [showLiveStreamUnderlay, setShowLiveStreamUnderlay] = useLocalStorage('lrs:overlay:global:streamUnderlay', false)
  const [previewZoom, setPreviewZoom] = useLocalStorage('lrs:overlay:global:zoom', 1)
  const [showEventOverlay, setShowEventOverlay] = useLocalStorage('lrs:overlay:global:events', true)
  const [debugEnabled, setDebugEnabled] = useLocalStorage('lrs:overlay:global:debug', false)

  const value = {
    previewRenderMode,
    setPreviewRenderMode,
    overlayVisible,
    setOverlayVisible,
    showLiveStreamUnderlay,
    setShowLiveStreamUnderlay,
    previewZoom,
    setPreviewZoom,
    showEventOverlay,
    setShowEventOverlay,
    debugEnabled,
    setDebugEnabled,
  }

  return (
    <OverlaySettingsContext.Provider value={value}>
      {children}
    </OverlaySettingsContext.Provider>
  )
}

export function useOverlaySettings() {
  const context = useContext(OverlaySettingsContext)
  if (!context) {
    throw new Error('useOverlaySettings must be used within OverlaySettingsProvider')
  }
  return context
}
