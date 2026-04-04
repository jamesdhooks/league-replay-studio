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
  const listAssets = useCallback(async (presetId) => {
    try {
      return await apiGet(`/presets/${presetId}/assets`)
    } catch {
      return { assets: [] }
    }
  }, [])

  const uploadAsset = useCallback(async (presetId, file) => {
    try {
      const formData = new FormData()
      formData.append('file', file)
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

  const deleteAsset = useCallback(async (presetId, filename) => {
    try {
      await apiDelete(`/presets/${presetId}/assets/${filename}`)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }, [])

  // ── Intro video ───────────────────────────────────────────────────────
  const uploadIntroVideo = useCallback(async (presetId, file) => {
    try {
      const formData = new FormData()
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
      const result = await apiPost(`/presets/${presetId}/render-preview`, {
        section,
        element_id: opts.elementId || null,
        frame_data: opts.frameData || null,
        variables: opts.variables || null,
      })
      setPreviewData(result)
      return result
    } catch (err) {
      return { success: false, error: err.message }
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
    uploadIntroVideo,
    deleteIntroVideo,
    renderPreview,
  }), [
    presets, selectedPresetId, selectedPreset, activeSection, sectionElements,
    previewData, loading, error,
    fetchPresets, getPreset, createPreset, updatePreset, deletePreset,
    duplicatePreset, exportPreset, importPreset,
    addElement, updateElement, removeElement,
    listAssets, uploadAsset, deleteAsset,
    uploadIntroVideo, deleteIntroVideo, renderPreview,
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
