import { createContext, useContext, useMemo, useState } from 'react'
import { useStream } from '../hooks/useStream'

const LivePreviewContext = createContext(null)

/**
 * LivePreviewProvider
 *
 * Holds one shared useStream() instance for the entire app so preview stream
 * state survives step/tab switches.
 */
export function LivePreviewProvider({ children }) {
  const stream = useStream()
  const [streamVisible, setStreamVisible] = useState(true)
  const [showQualitySettings, setShowQualitySettings] = useState(false)
  const [showWindowPicker, setShowWindowPicker] = useState(false)

  const value = useMemo(() => ({
    ...stream,
    streamVisible,
    setStreamVisible,
    showQualitySettings,
    setShowQualitySettings,
    showWindowPicker,
    setShowWindowPicker,
  }), [
    stream,
    streamVisible,
    showQualitySettings,
    showWindowPicker,
  ])

  return (
    <LivePreviewContext.Provider value={value}>
      {children}
    </LivePreviewContext.Provider>
  )
}

export function useLivePreview() {
  const context = useContext(LivePreviewContext)
  if (!context) {
    throw new Error('useLivePreview must be used within a LivePreviewProvider')
  }
  return context
}
