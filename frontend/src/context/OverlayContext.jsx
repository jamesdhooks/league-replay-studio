import { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react'
import { apiGet, apiPost, apiPut, apiDelete } from '../services/api'
import { wsClient } from '../services/websocket'

const OverlayContext = createContext(null)

/**
 * OverlayProvider — manages overlay template state.
 *
 * Tracks template library, engine status, batch rendering progress,
 * and per-project overrides. Subscribes to overlay:* WebSocket events.
 */
export function OverlayProvider({ children }) {
  // ── State ────────────────────────────────────────────────────────────────
  const [templates, setTemplates] = useState([])
  const [selectedTemplateId, setSelectedTemplateId] = useState(null)
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

  // ── Template CRUD ────────────────────────────────────────────────────────
  const fetchTemplates = useCallback(async () => {
    try {
      const data = await apiGet('/overlay/templates')
      setTemplates(data.templates || [])
      return data.templates
    } catch (err) {
      console.error('[Overlay] Fetch templates failed:', err)
      return []
    }
  }, [])

  const getTemplate = useCallback(async (templateId) => {
    try {
      return await apiGet(`/overlay/templates/${templateId}`)
    } catch (err) {
      return null
    }
  }, [])

  const createTemplate = useCallback(async (templateData) => {
    try {
      const result = await apiPost('/overlay/templates', templateData)
      if (result.success) {
        await fetchTemplates()
      }
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchTemplates])

  const updateTemplate = useCallback(async (templateId, updates) => {
    try {
      const result = await apiPut(`/overlay/templates/${templateId}`, updates)
      if (result.success) {
        await fetchTemplates()
      }
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchTemplates])

  const deleteTemplate = useCallback(async (templateId) => {
    try {
      await apiDelete(`/overlay/templates/${templateId}`)
      await fetchTemplates()
      if (selectedTemplateId === templateId) {
        setSelectedTemplateId(null)
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchTemplates, selectedTemplateId])

  const duplicateTemplate = useCallback(async (templateId) => {
    try {
      const result = await apiPost(`/overlay/templates/${templateId}/duplicate`)
      if (result.success) {
        await fetchTemplates()
      }
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchTemplates])

  const exportTemplate = useCallback(async (templateId) => {
    try {
      return await apiPost(`/overlay/templates/${templateId}/export`)
    } catch (err) {
      return { success: false, error: err.message }
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

  // ── Per-project overrides ────────────────────────────────────────────────
  const saveOverride = useCallback(async (projectId, templateId, htmlContent) => {
    try {
      return await apiPost(`/overlay/overrides/${projectId}/${templateId}`, {
        html_content: htmlContent,
      })
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [])

  const getOverride = useCallback(async (projectId, templateId) => {
    try {
      return await apiGet(`/overlay/overrides/${projectId}/${templateId}`)
    } catch {
      return null
    }
  }, [])

  const deleteOverride = useCallback(async (projectId, templateId) => {
    try {
      return await apiDelete(`/overlay/overrides/${projectId}/${templateId}`)
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [])

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
    templates,
    selectedTemplateId,
    engineStatus,
    batchProgress,
    loading,
    error,

    setSelectedTemplateId,
    initEngine,
    shutdownEngine,
    fetchStatus,
    fetchTemplates,
    getTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    duplicateTemplate,
    exportTemplate,
    renderFrame,
    startBatchRender,
    setResolution,
    saveOverride,
    getOverride,
    deleteOverride,
  }), [
    templates, selectedTemplateId, engineStatus, batchProgress, loading, error,
    initEngine, shutdownEngine, fetchStatus, fetchTemplates, getTemplate,
    createTemplate, updateTemplate, deleteTemplate, duplicateTemplate,
    exportTemplate, renderFrame, startBatchRender, setResolution,
    saveOverride, getOverride, deleteOverride,
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
