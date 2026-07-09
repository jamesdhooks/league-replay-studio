import { createContext, useContext, useState, useCallback, useMemo } from 'react'
import { apiGet, apiPost, apiPut, apiDelete } from '../services/api'

const PresetContext = createContext(null)

const VIDEO_SECTIONS = ['intro', 'qualifying_results', 'race', 'race_results']

const SECTION_LABELS = {
  intro: 'Intro',
  qualifying_results: 'Qualifying',
  race: 'Race',
  race_results: 'Results',
}

const SECTION_COLORS = {
  intro: '#8b5cf6',
  qualifying_results: '#06b6d4',
  race: '#3b82f6',
  race_results: '#f59e0b',
}

/**
 * PresetProvider — manages overlay preset state and CRUD operations.
 */
export function PresetProvider({ children }) {
  const [presets, setPresets] = useState([])
  const [selectedPresetId, setSelectedPresetId] = useState(null)
  const [activeSection, setActiveSection] = useState('race')
  const [previewData, setPreviewData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // ── Fetch presets ─────────────────────────────────────────────────────
  const fetchPresets = useCallback(async () => {
    try {
      const data = await apiGet('/presets')
      setPresets(data.presets || [])
      return data.presets
    } catch (err) {
      console.error('[Preset] Fetch failed:', err)
      return []
    }
  }, [])

  const getPreset = useCallback(async (presetId) => {
    try {
      return await apiGet(`/presets/${presetId}`)
    } catch {
      return null
    }
  }, [])

  const createPreset = useCallback(async (data) => {
    try {
      const result = await apiPost('/presets', data)
      if (result.success) await fetchPresets()
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchPresets])

  const updatePreset = useCallback(async (presetId, updates) => {
    try {
      const result = await apiPut(`/presets/${presetId}`, updates)
      if (result.success) await fetchPresets()
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchPresets])

  const linkTemplateToPreset = useCallback(async (presetId, templateId) => {
    // Legacy compat — style is now set directly on the design
    return updatePreset(presetId, { style: templateId })
  }, [updatePreset])

  const deletePreset = useCallback(async (presetId) => {
    try {
      await apiDelete(`/presets/${presetId}`)
      await fetchPresets()
      if (selectedPresetId === presetId) setSelectedPresetId(null)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchPresets, selectedPresetId])

  const duplicatePreset = useCallback(async (presetId) => {
    try {
      const result = await apiPost(`/presets/${presetId}/duplicate`)
      if (result.success) await fetchPresets()
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchPresets])

  const exportPreset = useCallback(async (presetId) => {
    try {
      return await apiPost(`/presets/${presetId}/export`)
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [])

  const importPreset = useCallback(async (presetData) => {
    try {
      const result = await apiPost('/presets/import', { preset_data: presetData })
      if (result.success) await fetchPresets()
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchPresets])

  // ── Element CRUD ──────────────────────────────────────────────────────
  const addElement = useCallback(async (presetId, section, element) => {
    try {
      const result = await apiPost(`/presets/${presetId}/sections/${section}/elements`, element)
      if (result.success) await fetchPresets()
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchPresets])

  const updateElement = useCallback(async (presetId, section, elementId, updates) => {
    try {
      const result = await apiPut(`/presets/${presetId}/sections/${section}/elements/${elementId}`, updates)
      if (result.success) await fetchPresets()
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchPresets])

  const removeElement = useCallback(async (presetId, section, elementId) => {
    try {
      await apiDelete(`/presets/${presetId}/sections/${section}/elements/${elementId}`)
      await fetchPresets()
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchPresets])

  // ── Asset management ──────────────────────────────────────────────────
  const listAssets = useCallback(async (presetId, opts = {}) => {
    try {
      const query = new URLSearchParams()
      if (opts.projectId != null) query.set('project_id', String(opts.projectId))
      const qs = query.toString()
      return await apiGet(`/presets/${presetId}/assets${qs ? `?${qs}` : ''}`)
    } catch {
      return { assets: [], count: 0, bindings: { defaults: {}, overrides: {}, effective: {} } }
    }
  }, [])

  const uploadAsset = useCallback(async (presetId, file, opts = {}) => {
    try {
      const formData = new globalThis.FormData()
      formData.append('file', file)
      formData.append('scope', opts.scope || 'global')
      if (opts.projectId != null) formData.append('project_id', String(opts.projectId))
      if (opts.variableName) formData.append('variable_name', opts.variableName)
      const response = await fetch(`/api/presets/${presetId}/assets`, {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) throw new Error('Upload failed')
      return await response.json()
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [])

  const deleteAsset = useCallback(async (presetId, filename, opts = {}) => {
    try {
      const query = new URLSearchParams()
      query.set('scope', opts.scope || 'global')
      if (opts.projectId != null) query.set('project_id', String(opts.projectId))
      await apiDelete(`/presets/${presetId}/assets/${encodeURIComponent(filename)}?${query.toString()}`)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [])

  const moveAssetScope = useCallback(async (presetId, filename, opts = {}) => {
    try {
      return await apiPut(`/presets/${presetId}/assets/${encodeURIComponent(filename)}/scope`, {
        source_scope: opts.sourceScope || null,
        target_scope: opts.targetScope,
        project_id: opts.projectId ?? null,
      })
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [])

  const setAssetVariable = useCallback(async (presetId, variableName, opts = {}) => {
    try {
      return await apiPut(`/presets/${presetId}/asset-variables/${encodeURIComponent(variableName)}`, {
        filename: opts.filename || null,
        scope: opts.scope || 'global',
        project_id: opts.projectId ?? null,
        clear: opts.clear === true,
      })
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [])

  // ── Intro video ───────────────────────────────────────────────────────
  const uploadIntroVideo = useCallback(async (presetId, file) => {
    try {
      const formData = new globalThis.FormData()
      formData.append('file', file)
      const response = await fetch(`/api/presets/${presetId}/intro-video`, {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) throw new Error('Upload failed')
      const result = await response.json()
      if (result.success) await fetchPresets()
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchPresets])

  const deleteIntroVideo = useCallback(async (presetId) => {
    try {
      await apiDelete(`/presets/${presetId}/intro-video`)
      await fetchPresets()
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [fetchPresets])

  // ── Render preview ────────────────────────────────────────────────────
  const renderPreview = useCallback(async (presetId, section, opts = {}) => {
    try {
      const derivedPageIndex = Number.isFinite(opts.pageIndex)
        ? Number(opts.pageIndex)
        : Number.isFinite(opts.frameData?.overlay_page_index)
          ? Number(opts.frameData.overlay_page_index)
          : null
      const result = await apiPost(`/presets/${presetId}/render-preview`, {
        section,
        project_id: opts.projectId ?? null,
        element_id: opts.elementId || null,
        frame_data: opts.frameData || null,
        page_index: derivedPageIndex,
        variables: opts.variables || null,
        analyze_animations: opts.analyzeAnimations ?? true,
        include_rendered_html: opts.includeRenderedHtml ?? false,
        render_screenshot: opts.renderScreenshot ?? true,
        include_debug: opts.includeDebug ?? false,
        prefer_html_content: opts.preferHtmlContent ?? false,
      })
      setPreviewData(result)
      return result
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [])

  // ── HTML content management ───────────────────────────────────────────
  const getHtmlRecord = useCallback(async (presetId) => {
    try {
      return await apiGet(`/presets/${presetId}/html`)
    } catch {
      return null
    }
  }, [])

  const getHtmlContent = useCallback(async (presetId) => {
    try {
      const result = await apiGet(`/presets/${presetId}/html`)
      return result.html_content
    } catch {
      return null
    }
  }, [])

  const updateHtmlContent = useCallback(async (presetId, htmlContent, opts = {}) => {
    try {
      return await apiPut(`/presets/${presetId}/html`, {
        html_content: htmlContent,
        summary: opts.summary || '',
        author: opts.author || 'user',
        source: opts.source || 'ui',
        expected_sha256: opts.expectedSha256 || opts.expected_sha256 || null,
      })
    } catch (err) {
      return { success: false, error: err.message, detail: err.detail, status: err.status }
    }
  }, [])

  const listRevisions = useCallback(async (presetId) => {
    try {
      return await apiGet(`/presets/${presetId}/revisions`)
    } catch (err) {
      return { revisions: [], count: 0, error: err.message }
    }
  }, [])

  const getRevision = useCallback(async (presetId, revisionId) => {
    try {
      return await apiGet(`/presets/${presetId}/revisions/${revisionId}`)
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [])

  const restoreRevision = useCallback(async (presetId, revisionId, opts = {}) => {
    try {
      return await apiPost(`/presets/${presetId}/revisions/${revisionId}/restore`, {
        summary: opts.summary || '',
        author: opts.author || 'user',
        source: opts.source || 'ui',
        expected_sha256: opts.expectedSha256 || opts.expected_sha256 || null,
      })
    } catch (err) {
      return { success: false, error: err.message, detail: err.detail, status: err.status }
    }
  }, [])

  const validateHtmlContent = useCallback(async (presetId, htmlContent, opts = {}) => {
    try {
      return await apiPost(`/presets/${presetId}/validate-html`, {
        html_content: htmlContent,
        project_id: opts.projectId ?? null,
        frame_data: opts.frameData || null,
        render_screenshot: opts.renderScreenshot ?? false,
      })
    } catch (err) {
      return { success: false, valid: false, error: err.message }
    }
  }, [])

  const renderEditorPreview = useCallback(async (presetId, htmlContent, frameData, opts = {}) => {
    try {
      const derivedPageIndex = Number.isFinite(opts.pageIndex)
        ? Number(opts.pageIndex)
        : Number.isFinite(frameData?.overlay_page_index)
          ? Number(frameData.overlay_page_index)
          : null
      return await apiPost(`/presets/${presetId}/editor-preview`, {
        html_content: htmlContent,
        project_id: opts.projectId ?? null,
        frame_data: frameData,
        page_index: derivedPageIndex,
        include_rendered_html: opts.includeRenderedHtml ?? false,
        render_screenshot: opts.renderScreenshot ?? true,
      })
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [])

  const getDataContext = useCallback(async (presetId, opts = {}) => {
    try {
      const query = opts.projectId != null ? `?project_id=${encodeURIComponent(opts.projectId)}` : ''
      return await apiGet(`/presets/${presetId}/editor-context${query}`)
    } catch {
      return null
    }
  }, [])

  // ── Selected preset helper ────────────────────────────────────────────
  const selectedPreset = useMemo(() => {
    return presets.find(p => p.id === selectedPresetId) || null
  }, [presets, selectedPresetId])

  const sectionElements = useMemo(() => {
    if (!selectedPreset) return []
    return selectedPreset.sections?.[activeSection] || []
  }, [selectedPreset, activeSection])

  const value = useMemo(() => ({
    presets,
    selectedPresetId,
    selectedPreset,
    activeSection,
    sectionElements,
    previewData,
    loading,
    error,
    VIDEO_SECTIONS,
    SECTION_LABELS,
    SECTION_COLORS,
    setSelectedPresetId,
    setActiveSection,
    fetchPresets,
    getPreset,
    createPreset,
    updatePreset,
    linkTemplateToPreset,
    deletePreset,
    duplicatePreset,
    exportPreset,
    importPreset,
    addElement,
    updateElement,
    removeElement,
    listAssets,
    uploadAsset,
    deleteAsset,
    moveAssetScope,
    setAssetVariable,
    uploadIntroVideo,
    deleteIntroVideo,
    renderPreview,
    getHtmlRecord,
    getHtmlContent,
    updateHtmlContent,
    listRevisions,
    getRevision,
    restoreRevision,
    validateHtmlContent,
    renderEditorPreview,
    getDataContext,
  }), [
    presets, selectedPresetId, selectedPreset, activeSection, sectionElements,
    previewData, loading, error,
    fetchPresets, getPreset, createPreset, updatePreset, deletePreset,
    linkTemplateToPreset,
    duplicatePreset, exportPreset, importPreset,
    addElement, updateElement, removeElement,
    listAssets, uploadAsset, deleteAsset, moveAssetScope, setAssetVariable,
    uploadIntroVideo, deleteIntroVideo, renderPreview,
    getHtmlRecord, getHtmlContent, updateHtmlContent, listRevisions, getRevision,
    restoreRevision, validateHtmlContent, renderEditorPreview, getDataContext,
  ])

  return (
    <PresetContext.Provider value={value}>
      {children}
    </PresetContext.Provider>
  )
}

export function usePreset() {
  const context = useContext(PresetContext)
  if (!context) {
    throw new Error('usePreset must be used within a PresetProvider')
  }
  return context
}
