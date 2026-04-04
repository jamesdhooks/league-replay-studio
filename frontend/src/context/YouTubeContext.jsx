import { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react'
import { apiGet, apiPost, apiPut } from '../services/api'
import { wsClient } from '../services/websocket'

const YouTubeContext = createContext(null)

/**
 * YouTubeProvider — manages YouTube channel integration state.
 *
 * Tracks connection status, upload progress, video listing,
 * and quota usage. Subscribes to youtube:* WebSocket events.
 */
export function YouTubeProvider({ children }) {
  // ── State ────────────────────────────────────────────────────────────────
  const [connectionStatus, setConnectionStatus] = useState({
    state: 'disconnected',
    channel: null,
  })
  const [uploadDefaults, setUploadDefaults] = useState(null)
  const [activeUpload, setActiveUpload] = useState(null)
  const [uploadHistory, setUploadHistory] = useState([])
  const [videos, setVideos] = useState([])
  const [videosNextPage, setVideosNextPage] = useState(null)
  const [videosTotalResults, setVideosTotalResults] = useState(0)
  const [quota, setQuota] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // ── Fetch connection status ─────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiGet('/youtube/status')
      setConnectionStatus(data)
      return data
    } catch (err) {
      console.error('[YouTube] Status fetch failed:', err)
      return null
    }
  }, [])

  // ── OAuth2 flow ─────────────────────────────────────────────────────────
  const getAuthUrl = useCallback(async (clientId, redirectUri) => {
    try {
      const data = await apiPost('/youtube/auth/url', {
        client_id: clientId,
        redirect_uri: redirectUri,
      })
      return data.auth_url
    } catch (err) {
      console.error('[YouTube] Auth URL failed:', err)
      throw err
    }
  }, [])

  const handleAuthCallback = useCallback(async (clientId, clientSecret, code, redirectUri) => {
    try {
      const data = await apiPost('/youtube/auth/callback', {
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        redirect_uri: redirectUri,
      })
      setConnectionStatus({ state: 'connected', channel: data.channel })
      return data
    } catch (err) {
      console.error('[YouTube] Auth callback failed:', err)
      throw err
    }
  }, [])

  const disconnect = useCallback(async () => {
    try {
      await apiPost('/youtube/disconnect')
      setConnectionStatus({ state: 'disconnected', channel: null })
    } catch (err) {
      console.error('[YouTube] Disconnect failed:', err)
      throw err
    }
  }, [])

  const refreshConnection = useCallback(async () => {
    try {
      const data = await apiPost('/youtube/refresh')
      if (data.success) {
        setConnectionStatus({ state: data.state, channel: data.channel })
      }
      return data
    } catch (err) {
      console.error('[YouTube] Refresh failed:', err)
      throw err
    }
  }, [])

  // ── Upload defaults ─────────────────────────────────────────────────────
  const fetchUploadDefaults = useCallback(async () => {
    try {
      const data = await apiGet('/youtube/upload/defaults')
      setUploadDefaults(data)
      return data
    } catch (err) {
      console.error('[YouTube] Fetch defaults failed:', err)
      return null
    }
  }, [])

  const updateUploadDefaults = useCallback(async (updates) => {
    try {
      const data = await apiPut('/youtube/upload/defaults', updates)
      setUploadDefaults(data)
      return data
    } catch (err) {
      console.error('[YouTube] Update defaults failed:', err)
      throw err
    }
  }, [])

  const previewMetadata = useCallback(async (titleTemplate, descriptionTemplate, projectData) => {
    try {
      return await apiPost('/youtube/upload/preview', {
        title_template: titleTemplate,
        description_template: descriptionTemplate,
        project_data: projectData,
      })
    } catch (err) {
      console.error('[YouTube] Preview metadata failed:', err)
      throw err
    }
  }, [])

  // ── Upload ──────────────────────────────────────────────────────────────
  const startUpload = useCallback(async ({ filePath, title, description, tags, privacy, projectId, playlistId }) => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiPost('/youtube/upload/start', {
        file_path: filePath,
        title,
        description,
        tags,
        privacy,
        project_id: projectId,
        playlist_id: playlistId,
      })
      setActiveUpload(data.job)
      return data
    } catch (err) {
      setError(err.message)
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  const cancelUpload = useCallback(async (jobId) => {
    try {
      return await apiPost(`/youtube/upload/cancel/${jobId}`)
    } catch (err) {
      console.error('[YouTube] Cancel failed:', err)
      throw err
    }
  }, [])

  const fetchUploadStatus = useCallback(async () => {
    try {
      const data = await apiGet('/youtube/upload/status')
      setActiveUpload(data.active_upload)
      setUploadHistory(data.history || [])
      return data
    } catch (err) {
      console.error('[YouTube] Upload status failed:', err)
      return null
    }
  }, [])

  // ── Videos ──────────────────────────────────────────────────────────────
  const fetchVideos = useCallback(async (pageToken = null) => {
    try {
      const params = pageToken ? `?page_token=${pageToken}` : ''
      const data = await apiGet(`/youtube/videos${params}`)
      if (pageToken) {
        setVideos(prev => [...prev, ...data.videos])
      } else {
        setVideos(data.videos || [])
      }
      setVideosNextPage(data.next_page_token || null)
      setVideosTotalResults(data.total_results || 0)
      return data
    } catch (err) {
      console.error('[YouTube] Videos fetch failed:', err)
      return null
    }
  }, [])

  // ── Quota ───────────────────────────────────────────────────────────────
  const fetchQuota = useCallback(async () => {
    try {
      const data = await apiGet('/youtube/quota')
      setQuota(data)
      return data
    } catch (err) {
      console.error('[YouTube] Quota fetch failed:', err)
      return null
    }
  }, [])

  // ── WebSocket subscriptions ─────────────────────────────────────────────
  useEffect(() => {
    const unsub = wsClient.subscribeCategory('youtube', (event, data) => {
      switch (event) {
        case 'youtube:connected':
          setConnectionStatus({ state: 'connected', channel: data.channel })
          break
        case 'youtube:disconnected':
          setConnectionStatus({ state: 'disconnected', channel: null })
          break
        case 'youtube:upload_started':
          setActiveUpload(data)
          break
        case 'youtube:upload_progress':
          setActiveUpload(data)
          break
        case 'youtube:upload_completed':
          setActiveUpload(data)
          // Move to history after a delay
          setTimeout(() => {
            setActiveUpload(null)
            setUploadHistory(prev => [data, ...prev].slice(0, 50))
          }, 3000)
          break
        case 'youtube:upload_error':
          setActiveUpload(data)
          break
        case 'youtube:quota_warning':
          setQuota(data)
          break
        default:
          break
      }
    })

    return unsub
  }, [])

  // ── Fetch initial state on mount ────────────────────────────────────────
  useEffect(() => {
    fetchStatus()
    fetchQuota()
  }, [fetchStatus, fetchQuota])

  // ── Context value ───────────────────────────────────────────────────────
  const value = useMemo(() => ({
    // Connection
    connectionStatus,
    isConnected: connectionStatus.state === 'connected',
    channel: connectionStatus.channel,
    fetchStatus,
    getAuthUrl,
    handleAuthCallback,
    disconnect,
    refreshConnection,

    // Upload defaults
    uploadDefaults,
    fetchUploadDefaults,
    updateUploadDefaults,
    previewMetadata,

    // Upload
    activeUpload,
    uploadHistory,
    startUpload,
    cancelUpload,
    fetchUploadStatus,
    loading,
    error,

    // Videos
    videos,
    videosNextPage,
    videosTotalResults,
    fetchVideos,

    // Quota
    quota,
    fetchQuota,
  }), [
    connectionStatus, fetchStatus, getAuthUrl, handleAuthCallback, disconnect, refreshConnection,
    uploadDefaults, fetchUploadDefaults, updateUploadDefaults, previewMetadata,
    activeUpload, uploadHistory, startUpload, cancelUpload, fetchUploadStatus, loading, error,
    videos, videosNextPage, videosTotalResults, fetchVideos,
    quota, fetchQuota,
  ])

  return (
    <YouTubeContext.Provider value={value}>
      {children}
    </YouTubeContext.Provider>
  )
}

/**
 * Hook to access YouTube state and actions.
 */
export function useYouTube() {
  const context = useContext(YouTubeContext)
  if (!context) {
    throw new Error('useYouTube must be used within a YouTubeProvider')
  }
  return context
}
