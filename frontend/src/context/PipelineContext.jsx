import { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react'
import { apiGet, apiPost, apiPut, apiDelete } from '../services/api'
import { wsClient } from '../services/websocket'

const PipelineContext = createContext(null)

/**
 * PipelineProvider — manages one-click automated pipeline state.
 *
 * Tracks pipeline runs, step progress, presets, and provides
 * control actions (start/pause/resume/cancel/retry).
 * Subscribes to pipeline:* and automation:* WebSocket events.
 */
export function PipelineProvider({ children }) {
  // ── State ────────────────────────────────────────────────────────────────
  const [currentRun, setCurrentRun] = useState(null)
  const [runHistory, setRunHistory] = useState([])
  const [presets, setPresets] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Derived state
  const isRunning = currentRun?.state === 'running'
  const isPaused = currentRun?.state === 'paused' || currentRun?.state === 'waiting_intervention'
  const canResume = isPaused
  const currentStep = currentRun?.current_step || null

  // ── Fetch status ─────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiGet('/pipeline/status')
      setCurrentRun(data.run)
      return data
    } catch (err) {
      console.error('[Pipeline] Status fetch failed:', err)
      return null
    }
  }, [])

  // ── Fetch run history ────────────────────────────────────────────────────
  const fetchHistory = useCallback(async (limit = 20) => {
    try {
      const data = await apiGet(`/pipeline/history?limit=${limit}`)
      setRunHistory(data.runs || [])
      return data.runs
    } catch (err) {
      console.error('[Pipeline] History fetch failed:', err)
      return []
    }
  }, [])

  // ── Pipeline control ─────────────────────────────────────────────────────
  const startPipeline = useCallback(async ({ projectId, presetId, config }) => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiPost('/pipeline/start', {
        project_id: projectId,
        preset_id: presetId,
        config,
      })
      setCurrentRun(data.run)
      return data
    } catch (err) {
      setError(err.message)
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  const pausePipeline = useCallback(async () => {
    try {
      const data = await apiPost('/pipeline/pause')
      setCurrentRun(data.run)
      return data
    } catch (err) {
      console.error('[Pipeline] Pause failed:', err)
      throw err
    }
  }, [])

  const resumePipeline = useCallback(async () => {
    try {
      const data = await apiPost('/pipeline/resume')
      setCurrentRun(data.run)
      return data
    } catch (err) {
      console.error('[Pipeline] Resume failed:', err)
      throw err
    }
  }, [])

  const cancelPipeline = useCallback(async () => {
    try {
      const data = await apiPost('/pipeline/cancel')
      setCurrentRun(data.run)
      return data
    } catch (err) {
      console.error('[Pipeline] Cancel failed:', err)
      throw err
    }
  }, [])

  const retryStep = useCallback(async (stepName) => {
    try {
      const data = await apiPost('/pipeline/retry', { step_name: stepName })
      setCurrentRun(data.run)
      return data
    } catch (err) {
      console.error('[Pipeline] Retry failed:', err)
      throw err
    }
  }, [])

  const skipStep = useCallback(async (stepName) => {
    try {
      const data = await apiPost('/pipeline/skip', { step_name: stepName })
      setCurrentRun(data.run)
      return data
    } catch (err) {
      console.error('[Pipeline] Skip failed:', err)
      throw err
    }
  }, [])

  // ── Presets ──────────────────────────────────────────────────────────────
  const fetchPresets = useCallback(async () => {
    try {
      const data = await apiGet('/pipeline/presets')
      setPresets(data.presets || [])
      return data.presets
    } catch (err) {
      console.error('[Pipeline] Presets fetch failed:', err)
      return []
    }
  }, [])

  const createPreset = useCallback(async (presetData) => {
    try {
      const data = await apiPost('/pipeline/presets', presetData)
      setPresets(prev => [...prev, data.preset])
      return data.preset
    } catch (err) {
      console.error('[Pipeline] Create preset failed:', err)
      throw err
    }
  }, [])

  const updatePreset = useCallback(async (presetId, updates) => {
    try {
      const data = await apiPut(`/pipeline/presets/${presetId}`, updates)
      setPresets(prev => prev.map(p => p.id === presetId ? data.preset : p))
      return data.preset
    } catch (err) {
      console.error('[Pipeline] Update preset failed:', err)
      throw err
    }
  }, [])

  const deletePreset = useCallback(async (presetId) => {
    try {
      await apiDelete(`/pipeline/presets/${presetId}`)
      setPresets(prev => prev.filter(p => p.id !== presetId))
      return true
    } catch (err) {
      console.error('[Pipeline] Delete preset failed:', err)
      throw err
    }
  }, [])

  // ── WebSocket subscriptions ─────────────────────────────────────────────
  useEffect(() => {
    // Subscribe to both 'pipeline:' and 'automation:' events
    const unsub1 = wsClient.subscribeCategory('pipeline', (event, data) => {
      handlePipelineEvent(event, data)
    })

    const unsub2 = wsClient.subscribeCategory('automation', (event, data) => {
      handlePipelineEvent(event, data)
    })

    return () => {
      unsub1()
      unsub2()
    }
  }, [])

  const handlePipelineEvent = useCallback((event, data) => {
    switch (event) {
      case 'pipeline:started':
      case 'automation:started':
        setCurrentRun(data)
        break

      case 'pipeline:paused':
      case 'automation:paused':
        setCurrentRun(data)
        break

      case 'pipeline:resumed':
      case 'automation:resumed':
        setCurrentRun(data)
        break

      case 'pipeline:cancelled':
      case 'automation:cancelled':
        setCurrentRun(data)
        break

      case 'pipeline:completed':
      case 'automation:completed':
        setCurrentRun(data)
        // Add to history
        setRunHistory(prev => [data, ...prev].slice(0, 50))
        break

      case 'pipeline:failed':
      case 'automation:failed':
        setCurrentRun(prev => prev ? { ...prev, ...data, state: 'failed' } : data)
        break

      case 'pipeline:step_started':
      case 'automation:step_started':
        setCurrentRun(prev => {
          if (!prev || prev.run_id !== data.run_id) return prev
          return {
            ...prev,
            current_step: data.step,
            steps: {
              ...prev.steps,
              [data.step]: {
                ...(prev.steps?.[data.step] || {}),
                state: 'running',
                progress: 0,
              },
            },
          }
        })
        break

      case 'pipeline:step_progress':
      case 'automation:step_progress':
        setCurrentRun(prev => {
          if (!prev || prev.run_id !== data.run_id) return prev
          return {
            ...prev,
            steps: {
              ...prev.steps,
              [data.step]: {
                ...(prev.steps?.[data.step] || {}),
                progress: data.progress,
                output: { ...(prev.steps?.[data.step]?.output || {}), ...data.output },
              },
            },
          }
        })
        break

      case 'pipeline:step_completed':
      case 'automation:step_completed':
        setCurrentRun(prev => {
          if (!prev || prev.run_id !== data.run_id) return prev
          return {
            ...prev,
            steps: {
              ...prev.steps,
              [data.step]: {
                ...(prev.steps?.[data.step] || {}),
                state: 'completed',
                progress: 100,
              },
            },
          }
        })
        break

      case 'pipeline:step_error':
      case 'automation:step_error':
        setCurrentRun(prev => {
          if (!prev || prev.run_id !== data.run_id) return prev
          return {
            ...prev,
            steps: {
              ...prev.steps,
              [data.step]: {
                ...(prev.steps?.[data.step] || {}),
                state: 'failed',
                error: data.error,
              },
            },
          }
        })
        break

      case 'pipeline:step_skipped':
      case 'automation:step_skipped':
        setCurrentRun(prev => {
          if (!prev || prev.run_id !== data.run_id) return prev
          return {
            ...prev,
            steps: {
              ...prev.steps,
              [data.step]: {
                ...(prev.steps?.[data.step] || {}),
                state: 'skipped',
              },
            },
          }
        })
        break

      case 'pipeline:waiting_intervention':
      case 'automation:waiting_intervention':
        setCurrentRun(prev => {
          if (!prev || prev.run_id !== data.run_id) return prev
          return { ...prev, state: 'waiting_intervention' }
        })
        break

      default:
        break
    }
  }, [])

  // ── Fetch initial state on mount ────────────────────────────────────────
  useEffect(() => {
    fetchStatus()
    fetchPresets()
  }, [fetchStatus, fetchPresets])

  // ── Context value ───────────────────────────────────────────────────────
  const value = useMemo(() => ({
    // Current run state
    currentRun,
    isRunning,
    isPaused,
    canResume,
    currentStep,
    steps: currentRun?.steps || {},

    // History
    runHistory,
    fetchHistory,

    // Control
    fetchStatus,
    startPipeline,
    pausePipeline,
    resumePipeline,
    cancelPipeline,
    retryStep,
    skipStep,

    // Presets
    presets,
    fetchPresets,
    createPreset,
    updatePreset,
    deletePreset,

    // Loading/Error
    loading,
    error,
  }), [
    currentRun, isRunning, isPaused, canResume, currentStep,
    runHistory, fetchHistory,
    fetchStatus, startPipeline, pausePipeline, resumePipeline, cancelPipeline, retryStep, skipStep,
    presets, fetchPresets, createPreset, updatePreset, deletePreset,
    loading, error,
  ])

  return (
    <PipelineContext.Provider value={value}>
      {children}
    </PipelineContext.Provider>
  )
}

/**
 * Hook to access pipeline state and actions.
 */
export function usePipeline() {
  const context = useContext(PipelineContext)
  if (!context) {
    throw new Error('usePipeline must be used within a PipelineProvider')
  }
  return context
}
