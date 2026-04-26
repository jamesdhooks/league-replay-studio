import { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react'
import { apiGet, apiPost, apiDelete } from '../services/api'
import { wsClient } from '../services/websocket'

const EncodingContext = createContext(null)

/**
 * EncodingProvider — manages GPU encoding state.
 *
 * Tracks GPU capabilities, export presets, encoding jobs (active/queued/completed),
 * and real-time progress. Subscribes to encoding:* WebSocket events.
 */
export function EncodingProvider({ children }) {
  // ── State ────────────────────────────────────────────────────────────────
  const [gpuInfo, setGpuInfo] = useState(null)
  const [presets, setPresets] = useState([])
  const [activeJobs, setActiveJobs] = useState([])
  const [queuedJobs, setQueuedJobs] = useState([])
  const [recentJobs, setRecentJobs] = useState([])
  const [completedExports, setCompletedExports] = useState([])
  const [autoShutdown, setAutoShutdown] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // ── Detect GPUs ─────────────────────────────────────────────────────────
  const detectGpus = useCallback(async () => {
    try {
      const data = await apiGet('/encoding/gpus')
      setGpuInfo(data)
      return data
    } catch (err) {
      console.error('[Encoding] GPU detection failed:', err)
      return null
    }
  }, [])

  const refreshGpus = useCallback(async () => {
    try {
      const data = await apiPost('/encoding/gpus/refresh')
      setGpuInfo(data)
      return data
    } catch (err) {
      console.error('[Encoding] GPU refresh failed:', err)
      return null
    }
  }, [])

  // ── Presets ─────────────────────────────────────────────────────────────
  const fetchPresets = useCallback(async () => {
    try {
      const data = await apiGet('/encoding/presets')
      setPresets(data.presets || [])
      return data.presets
    } catch (err) {
      console.error('[Encoding] Fetch presets failed:', err)
      return []
    }
  }, [])

  const savePreset = useCallback(async (preset) => {
    try {
      const result = await apiPost('/encoding/presets', preset)
      if (result.success) {
        await fetchPresets()
      }
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchPresets])

  const deletePreset = useCallback(async (presetId) => {
    try {
      await apiDelete(`/encoding/presets/${presetId}`)
      await fetchPresets()
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchPresets])

  const duplicatePreset = useCallback(async (presetId) => {
    try {
      const result = await apiPost(`/encoding/presets/${presetId}/duplicate`)
      if (result.success) {
        await fetchPresets()
      }
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchPresets])

  // ── Auto-shutdown ──────────────────────────────────────────────────────
  const fetchAutoShutdown = useCallback(async () => {
    try {
      const data = await apiGet('/encoding/auto-shutdown')
      setAutoShutdown(data.auto_shutdown || false)
    } catch {
      // ignore
    }
  }, [])

  const toggleAutoShutdown = useCallback(async (enabled) => {
    try {
      const data = await apiPost('/encoding/auto-shutdown', { enabled })
      setAutoShutdown(data.auto_shutdown || false)
      return data
    } catch (err) {
      return { error: err.message }
    }
  }, [])

  // ── Completed exports ──────────────────────────────────────────────────
  const fetchExports = useCallback(async () => {
    try {
      const data = await apiGet('/encoding/exports')
      setCompletedExports(data.exports || [])
      return data.exports
    } catch {
      return []
    }
  }, [])

  // ── Status ──────────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiGet('/encoding/status')
      setActiveJobs(data.active_jobs || [])
      setQueuedJobs(data.queued_jobs || [])
      setRecentJobs(data.recent_jobs || [])
      if (data.auto_shutdown !== undefined) setAutoShutdown(data.auto_shutdown)
      return data
    } catch (err) {
      console.error('[Encoding] Status fetch failed:', err)
      return null
    }
  }, [])

  // ── Start encoding ──────────────────────────────────────────────────────
  const startEncoding = useCallback(async ({ projectId, inputFile, outputDir, presetId, edl, jobType, customPreset }) => {
    setLoading(true)
    setError(null)
    try {
      const result = await apiPost('/encoding/start', {
        project_id: projectId,
        input_file: inputFile,
        output_dir: outputDir,
        preset_id: presetId || '1080p',
        edl: edl || null,
        job_type: jobType || 'full',
        custom_preset: customPreset || null,
      })
      if (result.success && result.job) {
        setActiveJobs(prev => [...prev, result.job])
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
  const cancelJob = useCallback(async (jobId) => {
    try {
      const result = await apiPost(`/encoding/cancel/${jobId}`)
      if (result.success) {
        await fetchStatus()
      }
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchStatus])

  // ── WebSocket subscriptions ─────────────────────────────────────────────
  useEffect(() => {
    const unsubs = [
      wsClient.subscribe('encoding:started', (data) => {
        setActiveJobs(prev => {
          const exists = prev.some(j => j.job_id === data.job_id)
          if (exists) return prev
          return [...prev, {
            ...data,
            state: 'encoding',
            current_step: data.current_step || 'initializing',
            progress: { percentage: 0, current_step: data.current_step || 'initializing' },
            log_entries: [],
          }]
        })
        setError(null)
      }),

      wsClient.subscribe('encoding:progress', (data) => {
        setActiveJobs(prev =>
          prev.map(j =>
            j.job_id === data.job_id
              ? {
                ...j,
                progress: data,
                current_step: data.current_step || j.current_step || 'encoding',
                state: 'encoding',
              }
              : j
          )
        )
      }),

      wsClient.subscribe('encoding:log', (data) => {
        const appendLog = (job) => {
          const nextEntries = [
            ...(Array.isArray(job.log_entries) ? job.log_entries : []),
            {
              ts: data.ts || Date.now() / 1000,
              level: data.level || 'info',
              message: data.message || '',
              detail: data.detail || null,
            },
          ]
          return {
            ...job,
            current_step: data.current_step || job.current_step,
            log_entries: nextEntries.slice(-600),
          }
        }

        setActiveJobs(prev => prev.map(j => (j.job_id === data.job_id ? appendLog(j) : j)))
        setRecentJobs(prev => prev.map(j => (j.job_id === data.job_id ? appendLog(j) : j)))
      }),

      wsClient.subscribe('encoding:gpu_telemetry', (data) => {
        setActiveJobs(prev =>
          prev.map(j =>
            j.job_id === data.job_id
              ? {
                ...j,
                gpu_telemetry: {
                  utilization: data.utilization,
                  memory_used_mb: data.memory_used_mb,
                  memory_total_mb: data.memory_total_mb,
                  memory_percent: data.memory_percent,
                  temperature_c: data.temperature_c,
                  power_draw_w: data.power_draw_w,
                },
              }
              : j
          )
        )
        setRecentJobs(prev =>
          prev.map(j =>
            j.job_id === data.job_id
              ? {
                ...j,
                gpu_telemetry: {
                  utilization: data.utilization,
                  memory_used_mb: data.memory_used_mb,
                  memory_total_mb: data.memory_total_mb,
                  memory_percent: data.memory_percent,
                  temperature_c: data.temperature_c,
                  power_draw_w: data.power_draw_w,
                },
              }
              : j
          )
        )
      }),

      wsClient.subscribe('encoding:completed', (data) => {
        let completedJob = null
        setActiveJobs(prev => {
          completedJob = prev.find(j => j.job_id === data.job_id) || null
          return prev.filter(j => j.job_id !== data.job_id)
        })
        setRecentJobs(prev => [
          {
            ...(completedJob || {}),
            ...data,
            state: 'completed',
            current_step: data.current_step || 'completed',
            progress: {
              ...((completedJob && completedJob.progress) || {}),
              percentage: 100,
              current_step: data.current_step || 'completed',
            },
          },
          ...prev.slice(0, 19),
        ])
        // Refresh completed exports list
        fetchExports()
      }),

      wsClient.subscribe('encoding:error', (data) => {
        let failedJob = null
        setActiveJobs(prev => {
          failedJob = prev.find(j => j.job_id === data.job_id) || null
          return prev.filter(j => j.job_id !== data.job_id)
        })
        setRecentJobs(prev => [
          {
            ...(failedJob || {}),
            ...data,
            current_step: data.current_step || (failedJob?.current_step || 'error'),
            state: data.state || 'error',
          },
          ...prev.slice(0, 19),
        ])
        if (data.error) setError(data.error)
      }),
    ]

    return () => unsubs.forEach(fn => fn())
  }, [])

  // ── Context value ───────────────────────────────────────────────────────
  const value = useMemo(() => ({
    gpuInfo,
    presets,
    activeJobs,
    queuedJobs,
    recentJobs,
    completedExports,
    autoShutdown,
    loading,
    error,

    detectGpus,
    refreshGpus,
    fetchPresets,
    savePreset,
    deletePreset,
    duplicatePreset,
    fetchStatus,
    startEncoding,
    cancelJob,
    fetchAutoShutdown,
    toggleAutoShutdown,
    fetchExports,
  }), [
    gpuInfo, presets, activeJobs, queuedJobs, recentJobs,
    completedExports, autoShutdown, loading, error,
    detectGpus, refreshGpus, fetchPresets, savePreset, deletePreset,
    duplicatePreset, fetchStatus, startEncoding, cancelJob,
    fetchAutoShutdown, toggleAutoShutdown, fetchExports,
  ])

  return (
    <EncodingContext.Provider value={value}>
      {children}
    </EncodingContext.Provider>
  )
}

/**
 * Hook to access encoding state and methods.
 */
export function useEncoding() {
  const context = useContext(EncodingContext)
  if (!context) {
    throw new Error('useEncoding must be used within an EncodingProvider')
  }
  return context
}
