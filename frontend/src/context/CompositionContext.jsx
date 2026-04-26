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

  const isJobActive = Boolean(activeJob && !['completed', 'error', 'cancelled'].includes(activeJob.state))

  // ── Fetch status ─────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiGet('/composition/status')
      setActiveJob(data.active_job || null)
      setRecentJobs(data.recent_jobs || [])
      const activeLogs = data.active_job?.log_entries
      const recentLogs = Array.isArray(data.recent_jobs) && data.recent_jobs.length > 0
        ? data.recent_jobs[0]?.log_entries
        : null
      if (Array.isArray(activeLogs)) {
        setLogEntries(activeLogs)
      } else if (Array.isArray(recentLogs)) {
        setLogEntries(recentLogs)
      } else {
        setLogEntries([])
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
    compositionSelection, gapPolicy,
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
        preset_id: presetId || '1080p',
        composition_selection: compositionSelection || null,
        gap_policy: gapPolicy || null,
      })
      if (result.success && result.job) {
        setActiveJob(result.job)
        setLogEntries(result.job.log_entries || [])
        fetchStatus().catch(() => {})
      }
      return result
    } catch (err) {
      setError(err.message)
      return { success: false, error: err.message }
    } finally {
      setLoading(false)
    }
  }, [fetchStatus])

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
        fetchStatus().catch(() => {})
      }),

      wsClient.subscribe('composition:progress', (data) => {
        setActiveJob(prev => ({
          ...(prev || {}),
          job_id: data.job_id ?? prev?.job_id,
          project_id: data.project_id ?? prev?.project_id,
          state: data.state || prev?.state || 'processing',
          progress_pct: data.progress_pct ?? prev?.progress_pct ?? 0,
          step: data.step ?? prev?.step,
          segment_index: data.segment_index ?? prev?.segment_index,
          total_segments: data.total_segments ?? prev?.total_segments,
        }))
        if (Array.isArray(data.log_entries)) {
          setLogEntries(prev => data.log_entries.length >= prev.length ? data.log_entries : prev)
        }
      }),

      wsClient.subscribe('composition:completed', (data) => {
        setActiveJob(null)
        setRecentJobs(prev => [
          { ...data, state: 'completed', progress_pct: 100 },
          ...prev.slice(0, 19),
        ])
        fetchStatus().catch(() => {})
      }),

      wsClient.subscribe('composition:error', (data) => {
        setActiveJob(null)
        setRecentJobs(prev => [
          { ...data, state: data.state || 'error' },
          ...prev.slice(0, 19),
        ])
        if (data.error) setError(data.error)
        fetchStatus().catch(() => {})
      }),
    ]

    return () => unsubs.forEach(fn => fn())
  }, [fetchStatus])

  // Fast compositions can finish before all websocket messages are painted.
  // Poll status briefly while active to keep progress/logs in sync.
  useEffect(() => {
    if (!isJobActive) return
    const id = setInterval(() => {
      fetchStatus().catch(() => {})
    }, 400)
    return () => clearInterval(id)
  }, [isJobActive, fetchStatus])

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
