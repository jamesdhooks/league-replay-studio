import { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react'
import { apiGet, apiPost, apiPut, apiDelete } from '../services/api'
import { wsClient } from '../services/websocket'

const OverlayContext = createContext(null)

/**
 * OverlayProvider — manages overlay rendering engine state.
 *
 * Tracks engine status, batch rendering progress, and WebSocket events.
 * Template CRUD has been removed — designs own their HTML content directly.
 */
export function OverlayProvider({ children }) {
  // ── State ────────────────────────────────────────────────────────────────
  const [engineStatus, setEngineStatus] = useState({ state: 'idle', engine_initialized: false })
  const [batchProgress, setBatchProgress] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // ── Engine lifecycle ─────────────────────────────────────────────────────
  const initEngine = useCallback(async (resolution = '1080p') => {
    setLoading(true)
    try {
      const result = await apiPost('/overlay/init', { resolution })
      if (result.success) {
        setEngineStatus(prev => ({ ...prev, state: 'ready', engine_initialized: true }))
      }
      return result
    } catch (err) {
      setError(err.message)
      return { success: false, error: err.message }
    } finally {
      setLoading(false)
    }
  }, [])

  const shutdownEngine = useCallback(async () => {
    try {
      await apiPost('/overlay/shutdown')
      setEngineStatus({ state: 'idle', engine_initialized: false })
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [])

  // ── Fetch status ─────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiGet('/overlay/status')
      setEngineStatus(data)
      return data
    } catch (err) {
      console.error('[Overlay] Status fetch failed:', err)
      return null
    }
  }, [])

  // ── Rendering ────────────────────────────────────────────────────────────
  const renderFrame = useCallback(async (templateId, frameData, projectId = null) => {
    try {
      return await apiPost('/overlay/render', {
        template_id: templateId,
        frame_data: frameData,
        project_id: projectId,
      })
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [])

  const startBatchRender = useCallback(async (templateId, frames, outputDir, projectId = null) => {
    try {
      const result = await apiPost('/overlay/batch', {
        template_id: templateId,
        frames,
        output_dir: outputDir,
        project_id: projectId,
      })
      if (result.success) {
        setBatchProgress({
          batch_id: result.batch_id,
          total_frames: result.total_frames,
          rendered_frames: 0,
          percentage: 0,
          state: 'rendering',
        })
      }
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [])

  // ── Resolution ───────────────────────────────────────────────────────────
  const setResolution = useCallback(async (resolution) => {
    try {
      return await apiPost('/overlay/resolution', { resolution })
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [])

  // ── Editor methods (legacy compat — prefer PresetContext equivalents) ──
  const renderEditorPreview = useCallback(async (templateId, htmlContent, frameData, projectId = null) => {
    try {
      return await apiPost('/overlay/editor/preview', {
        template_id: templateId,
        html_content: htmlContent,
        frame_data: frameData,
        project_id: projectId,
      })
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [])

  const getDataContext = useCallback(async (templateId, projectId = null) => {
    try {
      const query = projectId != null ? `?project_id=${encodeURIComponent(projectId)}` : ''
      return await apiGet(`/overlay/editor/context/${templateId}${query}`)
    } catch {
      return null
    }
  }, [])

  // ── Auto-initialize engine on mount ─────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const autoInit = async () => {
      const status = await fetchStatus()
      if (!cancelled && status && !status.engine_initialized) {
        await initEngine()
      }
    }
    autoInit()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── WebSocket subscriptions ──────────────────────────────────────────────
  useEffect(() => {
    const unsubs = [
      wsClient.subscribe('overlay:render_started', (data) => {
        setBatchProgress({
          batch_id: data.batch_id,
          total_frames: data.total_frames,
          rendered_frames: 0,
          percentage: 0,
          state: 'rendering',
        })
        setError(null)
      }),

      wsClient.subscribe('overlay:render_progress', (data) => {
        setBatchProgress(prev => prev ? {
          ...prev,
          rendered_frames: data.rendered_frames,
          percentage: data.percentage,
        } : prev)
      }),

      wsClient.subscribe('overlay:render_completed', (data) => {
        setBatchProgress(prev => prev ? {
          ...prev,
          state: 'completed',
          percentage: 100,
          rendered_frames: data.rendered_frames || prev.total_frames,
        } : null)
      }),

      wsClient.subscribe('overlay:error', (data) => {
        setBatchProgress(prev => prev ? { ...prev, state: 'error' } : null)
        if (data.error) setError(data.error)
      }),
    ]

    return () => unsubs.forEach(fn => fn())
  }, [])

  // ── Context value ────────────────────────────────────────────────────────
  const value = useMemo(() => ({
    engineStatus,
    batchProgress,
    loading,
    error,

    initEngine,
    shutdownEngine,
    fetchStatus,
    renderFrame,
    startBatchRender,
    setResolution,
    renderEditorPreview,
    getDataContext,
  }), [
    engineStatus, batchProgress, loading, error,
    initEngine, shutdownEngine, fetchStatus,
    renderFrame, startBatchRender, setResolution,
    renderEditorPreview, getDataContext,
  ])

  return (
    <OverlayContext.Provider value={value}>
      {children}
    </OverlayContext.Provider>
  )
}

/**
 * Hook to access overlay state and methods.
 */
export function useOverlay() {
  const context = useContext(OverlayContext)
  if (!context) {
    throw new Error('useOverlay must be used within an OverlayProvider')
  }
  return context
}
