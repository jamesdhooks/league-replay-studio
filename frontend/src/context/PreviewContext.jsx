import { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { apiGet, apiPost } from '../services/api'
import { wsClient } from '../services/websocket'

const PreviewContext = createContext(null)

/**
 * PreviewProvider — manages video preview state.
 *
 * Tracks tiered preview generation (keyframes, sprites, proxy, audio),
 * playback state, preview modes, and real-time progress.
 * Subscribes to preview:* WebSocket events.
 */
export function PreviewProvider({ children }) {
  // ── State ────────────────────────────────────────────────────────────────
  const [previewJobs, setPreviewJobs] = useState({})          // { [projectId]: jobStatus }
  const [activeProjectId, setActiveProjectId] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Playback state
  const [playing, setPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [previewMode, setPreviewMode] = useState('full')      // full | highlight | source | split
  const [currentTime, setCurrentTime] = useState(0)

  // Sprite sheet data
  const [spritesIndex, setSpritesIndex] = useState(null)

  // ── Derived active job ─────────────────────────────────────────────────
  const activeJob = useMemo(
    () => (activeProjectId != null ? previewJobs[activeProjectId] : null),
    [previewJobs, activeProjectId],
  )

  // ── Init preview ──────────────────────────────────────────────────────
  const initPreview = useCallback(async ({ projectId, inputFile, previewDir }) => {
    setLoading(true)
    setError(null)
    try {
      const result = await apiPost('/preview/init', {
        project_id: projectId,
        input_file: inputFile,
        preview_dir: previewDir,
      })
      if (result.success && result.job) {
        setPreviewJobs(prev => ({ ...prev, [projectId]: result.job }))
      }
      return result
    } catch (err) {
      setError(err.message)
      return { success: false, error: err.message }
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Get status ─────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async (projectId) => {
    try {
      const data = await apiGet(`/preview/status/${projectId}`)
      setPreviewJobs(prev => ({ ...prev, [projectId]: data }))
      return data
    } catch (err) {
      console.error('[Preview] Status fetch failed:', err)
      return null
    }
  }, [])

  // ── Cancel ─────────────────────────────────────────────────────────────
  const cancelPreview = useCallback(async (projectId) => {
    try {
      const result = await apiPost(`/preview/cancel/${projectId}`)
      if (result.success) {
        await fetchStatus(projectId)
      }
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchStatus])

  // ── Fetch sprites index ────────────────────────────────────────────────
  const fetchSpritesIndex = useCallback(async (projectId) => {
    try {
      const data = await apiGet(`/preview/sprites/${projectId}`)
      setSpritesIndex(data)
      return data
    } catch (err) {
      console.error('[Preview] Sprites index fetch failed:', err)
      return null
    }
  }, [])

  // ── Get video info ─────────────────────────────────────────────────────
  const fetchVideoInfo = useCallback(async (projectId, inputFile) => {
    try {
      const data = await apiGet(`/preview/info/${projectId}?input_file=${encodeURIComponent(inputFile)}`)
      return data
    } catch (err) {
      console.error('[Preview] Video info failed:', err)
      return null
    }
  }, [])

  // ── URL helpers ────────────────────────────────────────────────────────
  const getSpriteSheetUrl = useCallback((projectId, sheetIndex) => {
    return `/api/preview/sprite/${projectId}/${sheetIndex}`
  }, [])

  const getFrameUrl = useCallback((projectId, timestamp, inputFile) => {
    return `/api/preview/frame/${projectId}?t=${timestamp}&input_file=${encodeURIComponent(inputFile)}`
  }, [])

  const getProxyUrl = useCallback((projectId) => {
    return `/api/preview/proxy/${projectId}`
  }, [])

  const getAudioUrl = useCallback((projectId) => {
    return `/api/preview/audio/${projectId}`
  }, [])

  // ── Playback controls ─────────────────────────────────────────────────
  const play = useCallback(() => setPlaying(true), [])
  const pause = useCallback(() => setPlaying(false), [])
  const togglePlay = useCallback(() => setPlaying(p => !p), [])

  const seek = useCallback((time) => {
    setCurrentTime(Math.max(0, time))
  }, [])

  const cycleSpeed = useCallback(() => {
    const speeds = [0.25, 0.5, 1, 2]
    setPlaybackSpeed(prev => {
      const idx = speeds.indexOf(prev)
      return speeds[(idx + 1) % speeds.length]
    })
  }, [])

  // ── WebSocket subscriptions ─────────────────────────────────────────────
  useEffect(() => {
    const unsubs = [
      wsClient.subscribe('preview:progress', (data) => {
        if (data.project_id != null) {
          setPreviewJobs(prev => ({ ...prev, [data.project_id]: data }))
        }
      }),

      wsClient.subscribe('preview:tier_ready', (data) => {
        if (data.project_id != null) {
          setPreviewJobs(prev => ({ ...prev, [data.project_id]: data }))
          // Auto-load sprites index when sprites are ready
          if (data.tier === 'sprites' && data.project_id === activeProjectId) {
            fetchSpritesIndex(data.project_id)
          }
        }
      }),

      wsClient.subscribe('preview:ready', (data) => {
        if (data.project_id != null) {
          setPreviewJobs(prev => ({ ...prev, [data.project_id]: data }))
        }
      }),

      wsClient.subscribe('preview:error', (data) => {
        if (data.project_id != null) {
          setPreviewJobs(prev => ({ ...prev, [data.project_id]: data }))
          if (data.error) setError(data.error)
        }
      }),
    ]

    return () => unsubs.forEach(fn => fn())
  }, [activeProjectId, fetchSpritesIndex])

  // ── Context value ───────────────────────────────────────────────────────
  const value = useMemo(() => ({
    // State
    previewJobs,
    activeJob,
    activeProjectId,
    loading,
    error,
    spritesIndex,

    // Playback
    playing,
    playbackSpeed,
    previewMode,
    currentTime,

    // Actions
    initPreview,
    fetchStatus,
    cancelPreview,
    fetchSpritesIndex,
    fetchVideoInfo,
    setActiveProjectId,

    // URL helpers
    getSpriteSheetUrl,
    getFrameUrl,
    getProxyUrl,
    getAudioUrl,

    // Playback controls
    play,
    pause,
    togglePlay,
    seek,
    setCurrentTime,
    setPlaybackSpeed,
    cycleSpeed,
    setPreviewMode,
    setPlaying,
  }), [
    previewJobs, activeJob, activeProjectId, loading, error, spritesIndex,
    playing, playbackSpeed, previewMode, currentTime,
    initPreview, fetchStatus, cancelPreview, fetchSpritesIndex, fetchVideoInfo,
    setActiveProjectId,
    getSpriteSheetUrl, getFrameUrl, getProxyUrl, getAudioUrl,
    play, pause, togglePlay, seek, cycleSpeed,
  ])

  return (
    <PreviewContext.Provider value={value}>
      {children}
    </PreviewContext.Provider>
  )
}

/**
 * Hook to access preview state and methods.
 */
export function usePreview() {
  const context = useContext(PreviewContext)
  if (!context) {
    throw new Error('usePreview must be used within a PreviewProvider')
  }
  return context
}
