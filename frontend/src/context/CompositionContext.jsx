import { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react'
import { apiGet, apiPost } from '../services/api'
import { wsClient } from '../services/websocket'

const CompositionContext = createContext(null)

/**
 * CompositionProvider — manages video composition pipeline state.
 *
 * Tracks composition jobs (trim → overlay → transition → stitch),
 * real-time progress via WebSocket, and structured log entries.
 */
export function CompositionProvider({ children }) {
  // ── State ────────────────────────────────────────────────────────────────
  const [activeJob, setActiveJob] = useState(null)
  const [recentJobs, setRecentJobs] = useState([])
  const [logEntries, setLogEntries] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // ── Fetch status ─────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiGet('/composition/status')
      setActiveJob(data.active_job || null)
      setRecentJobs(data.recent_jobs || [])
      if (data.active_job?.log_entries) {
        setLogEntries(data.active_job.log_entries)
      }
      return data
    } catch (err) {
      console.error('[Composition] Status fetch failed:', err)
      return null
    }
  }, [])

  // ── Start composition ───────────────────────────────────────────────────
  const startComposition = useCallback(async ({
    projectId, script, clipsManifest, overlayConfig,
    transitionConfig, trimConfig, outputDir, presetId,
  }) => {
    setLoading(true)
    setError(null)
    try {
      const result = await apiPost('/composition/start', {
        project_id: projectId,
        script,
        clips_manifest: clipsManifest,
        overlay_config: overlayConfig || null,
        transition_config: transitionConfig || null,
        trim_config: trimConfig || null,
        output_dir: outputDir,
        preset_id: presetId || 'youtube_1080p60',
      })
      if (result.success && result.job) {
        setActiveJob(result.job)
        setLogEntries(result.job.log_entries || [])
      }
      return result
    } catch (err) {
      setError(err.message)
      return { success: false, error: err.message }
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Cancel ──────────────────────────────────────────────────────────────
  const cancelComposition = useCallback(async (jobId) => {
    try {
      const result = await apiPost(`/composition/cancel/${jobId}`)
      if (result.success) {
        await fetchStatus()
      }
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchStatus])

  // ── Get job ──────────────────────────────────────────────────────────────
  const getJob = useCallback(async (jobId) => {
    try {
      const data = await apiGet(`/composition/job/${jobId}`)
      return data.job
    } catch (err) {
      return null
    }
  }, [])

  // ── WebSocket subscriptions ─────────────────────────────────────────────
  useEffect(() => {
    const unsubs = [
      wsClient.subscribe('composition:started', (data) => {
        setActiveJob(prev => ({
          ...prev,
          ...data,
          state: 'processing',
          progress_pct: 0,
        }))
        setLogEntries([])
        setError(null)
      }),

      wsClient.subscribe('composition:progress', (data) => {
        setActiveJob(prev => prev ? {
          ...prev,
          state: data.state || prev.state,
          progress_pct: data.progress_pct || prev.progress_pct,
          step: data.step,
          segment_index: data.segment_index,
          total_segments: data.total_segments,
        } : prev)
        if (data.log_entries) {
          setLogEntries(data.log_entries)
        }
      }),

      wsClient.subscribe('composition:completed', (data) => {
        setActiveJob(null)
        setRecentJobs(prev => [
          { ...data, state: 'completed', progress_pct: 100 },
          ...prev.slice(0, 19),
        ])
      }),

      wsClient.subscribe('composition:error', (data) => {
        setActiveJob(null)
        setRecentJobs(prev => [
          { ...data, state: data.state || 'error' },
          ...prev.slice(0, 19),
        ])
        if (data.error) setError(data.error)
      }),
    ]

    return () => unsubs.forEach(fn => fn())
  }, [])

  // ── Context value ───────────────────────────────────────────────────────
  const value = useMemo(() => ({
    activeJob,
    recentJobs,
    logEntries,
    loading,
    error,

    fetchStatus,
    startComposition,
    cancelComposition,
    getJob,
  }), [
    activeJob, recentJobs, logEntries, loading, error,
    fetchStatus, startComposition, cancelComposition, getJob,
  ])

  return (
    <CompositionContext.Provider value={value}>
      {children}
    </CompositionContext.Provider>
  )
}

/**
 * Hook to access composition state and methods.
 */
export function useComposition() {
  const context = useContext(CompositionContext)
  if (!context) {
    throw new Error('useComposition must be used within a CompositionProvider')
  }
  return context
}
