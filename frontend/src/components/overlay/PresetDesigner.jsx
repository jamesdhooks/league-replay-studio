import { useState, useEffect, useCallback, useRef } from 'react'
import { usePreset } from '../../context/PresetContext'
import { useOverlay } from '../../context/OverlayContext'
import { useLLM } from '../../context/LLMContext'
import { useToast } from '../../context/ToastContext'
import ElementEditor from './ElementEditor'
import VariableEditor from './VariableEditor'
import AssetManager from './AssetManager'
import {
  Layers, Plus, Trash2, Upload,
  ArrowLeft, Eye, EyeOff, Monitor,
  Palette, Image, Film, GripVertical, RefreshCw,
  Loader2, Box, BarChart3, Sparkles, Send, Wand2,
} from 'lucide-react'

const SECTION_ICONS = {
  intro: Film,
  qualifying_results: BarChart3,
  race: Monitor,
  race_results: BarChart3,
}

/**
 * PresetDesigner — Full overlay design suite with per-section element management.
 */
export default function PresetDesigner({ presetId, onClose }) {
  const {
    selectedPreset, activeSection, sectionElements,
    SECTION_LABELS, SECTION_COLORS, VIDEO_SECTIONS,
    setActiveSection, setSelectedPresetId,
    updatePreset, addElement, updateElement, removeElement,
    renderPreview, fetchPresets,
    uploadIntroVideo, deleteIntroVideo,
  } = usePreset()
  const { initEngine, engineStatus } = useOverlay()
  const { isAvailable, generateElement, augmentElement, loading: llmLoading } = useLLM()
  const { addToast } = useToast()

  const [selectedElementId, setSelectedElementId] = useState(null)
  const [previewImage, setPreviewImage] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [showVariables, setShowVariables] = useState(false)
  const [showAssets, setShowAssets] = useState(false)
  const [showAIPrompt, setShowAIPrompt] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiMode, setAiMode] = useState('create') // 'create' or 'augment'
  const previewTimeoutRef = useRef(null)

  // Select the preset on mount
  useEffect(() => {
    setSelectedPresetId(presetId)
    fetchPresets()
  }, [presetId, setSelectedPresetId, fetchPresets])

  // Auto-refresh preview when section or elements change
  useEffect(() => {
    if (selectedPreset && engineStatus?.engine_initialized) {
      handleRefreshPreview()
    }
  }, [activeSection, selectedPreset?.sections?.[activeSection]?.length])

  const selectedElement = sectionElements.find(e => e.id === selectedElementId)

  // ── Preview rendering ─────────────────────────────────────────────────
  const handleRefreshPreview = useCallback(async () => {
    if (!selectedPreset) return
    // Debounce
    if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current)
    previewTimeoutRef.current = setTimeout(async () => {
      setPreviewLoading(true)
      try {
        const result = await renderPreview(selectedPreset.id, activeSection)
        if (result?.png_base64) {
          setPreviewImage(`data:image/png;base64,${result.png_base64}`)
        }
      } catch {
        // Preview errors are non-fatal
      } finally {
        setPreviewLoading(false)
      }
    }, 300)
  }, [selectedPreset, activeSection, renderPreview])

  // ── Element actions ───────────────────────────────────────────────────
  const handleAddElement = useCallback(async () => {
    if (!selectedPreset) return
    const result = await addElement(selectedPreset.id, activeSection, {
      name: `Element ${(sectionElements.length || 0) + 1}`,
      template: `<div style="position:absolute; left:{{pos.x}}%; top:{{pos.y}}%; width:{{pos.w}}%; height:{{pos.h}}%;\n  font-family: var(--font-primary, 'Inter', sans-serif); color: var(--color-primary, #ffffff);\n  display:flex; align-items:center; justify-content:center;\n  background: var(--color-background, rgba(0,0,0,0.75)); border-radius: 6px;\n  font-size: clamp(0.6rem, 1vw, 1rem); text-shadow: 0 1px 4px rgba(0,0,0,0.5);">\n  {{ frame.driver_name | default('Driver Name') }}\n</div>`,
      position: { x: 10, y: 10, w: 20, h: 10 },
      z_index: 10 + sectionElements.length,
      visible: true,
    })
    if (result.success) {
      setSelectedElementId(result.element?.id)
      addToast('Element added', 'success')
      handleRefreshPreview()
    }
  }, [selectedPreset, activeSection, sectionElements, addElement, addToast, handleRefreshPreview])

  const handleRemoveElement = useCallback(async (elemId) => {
    if (!selectedPreset) return
    const result = await removeElement(selectedPreset.id, activeSection, elemId)
    if (result.success) {
      if (selectedElementId === elemId) setSelectedElementId(null)
      addToast('Element removed', 'success')
      handleRefreshPreview()
    }
  }, [selectedPreset, activeSection, removeElement, selectedElementId, addToast, handleRefreshPreview])

  const handleToggleVisibility = useCallback(async (elem) => {
    if (!selectedPreset) return
    await updateElement(selectedPreset.id, activeSection, elem.id, {
      visible: !elem.visible,
    })
    handleRefreshPreview()
  }, [selectedPreset, activeSection, updateElement, handleRefreshPreview])

  const handleElementUpdate = useCallback(async (elementId, updates) => {
    if (!selectedPreset) return
    const result = await updateElement(selectedPreset.id, activeSection, elementId, updates)
    if (result.success) {
      handleRefreshPreview()
    }
    return result
  }, [selectedPreset, activeSection, updateElement, handleRefreshPreview])

  // ── Intro video ───────────────────────────────────────────────────────
  const handleIntroVideoUpload = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file || !selectedPreset) return
    const result = await uploadIntroVideo(selectedPreset.id, file)
    if (result.success) {
      addToast('Intro video uploaded', 'success')
    } else {
      addToast(result.error || 'Upload failed', 'error')
    }
  }, [selectedPreset, uploadIntroVideo, addToast])

  const handleDeleteIntroVideo = useCallback(async () => {
    if (!selectedPreset) return
    await deleteIntroVideo(selectedPreset.id)
    addToast('Intro video removed', 'success')
  }, [selectedPreset, deleteIntroVideo, addToast])

  // ── AI element generation / augmentation ─────────────────────────────
  const handleAISubmit = useCallback(async () => {
    if (!selectedPreset || !aiPrompt.trim()) return

    if (aiMode === 'augment' && selectedElement) {
      const result = await augmentElement(
        aiPrompt.trim(),
        activeSection,
        selectedPreset.id,
        selectedElement.id,
      )
      if (result?.element) {
        await handleElementUpdate(selectedElement.id, result.element)
        addToast(result.explanation || 'Element updated by AI', 'success')
        setAiPrompt('')
        handleRefreshPreview()
      }
    } else {
      const result = await generateElement(
        aiPrompt.trim(),
        activeSection,
        selectedPreset.id,
        sectionElements,
      )
      if (result?.element) {
        const addResult = await addElement(selectedPreset.id, activeSection, result.element)
        if (addResult.success) {
          setSelectedElementId(addResult.element?.id || result.element.id)
          addToast(result.explanation || 'Element created by AI', 'success')
          setAiPrompt('')
          handleRefreshPreview()
        }
      }
    }
  }, [selectedPreset, aiPrompt, aiMode, selectedElement, activeSection, sectionElements,
      generateElement, augmentElement, addElement, handleElementUpdate, addToast, handleRefreshPreview])

  if (!selectedPreset) {
    return (
      <div className="flex items-center justify-center h-full text-text-tertiary">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading preset...
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-bg-primary text-text-primary">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="p-1 rounded hover:bg-bg-secondary text-text-tertiary">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <Layers className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-semibold">{selectedPreset.name}</span>
          {selectedPreset.is_builtin && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-secondary text-text-tertiary uppercase">Built-in</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowAssets(!showAssets)}
            className={`p-1 rounded text-text-tertiary hover:text-text-primary ${showAssets ? 'bg-blue-600/20 text-blue-400' : 'hover:bg-bg-secondary'}`}
            title="Assets"
          >
            <Image className="w-4 h-4" />
          </button>
          <button onClick={() => setShowVariables(!showVariables)}
            className={`p-1 rounded text-text-tertiary hover:text-text-primary ${showVariables ? 'bg-blue-600/20 text-blue-400' : 'hover:bg-bg-secondary'}`}
            title="Variables"
          >
            <Palette className="w-4 h-4" />
          </button>
          {isAvailable() && (
            <button onClick={() => setShowAIPrompt(!showAIPrompt)}
              className={`p-1 rounded text-text-tertiary hover:text-text-primary ${showAIPrompt ? 'bg-purple-600/20 text-purple-400' : 'hover:bg-bg-secondary'}`}
              title="AI Element Designer"
            >
              <Sparkles className="w-4 h-4" />
            </button>
          )}
          {!engineStatus?.engine_initialized && (
            <button onClick={() => initEngine()} className="text-xs px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white">
              Init Engine
            </button>
          )}
        </div>
      </div>

      {/* ── Section tabs ────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-border overflow-x-auto">
        {VIDEO_SECTIONS.map(section => {
          const Icon = SECTION_ICONS[section] || Monitor
          const isActive = activeSection === section
          const elementCount = selectedPreset.sections?.[section]?.length || 0
          return (
            <button
              key={section}
              onClick={() => { setActiveSection(section); setSelectedElementId(null) }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                isActive
                  ? 'text-white shadow-sm'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-bg-secondary'
              }`}
              style={isActive ? { backgroundColor: SECTION_COLORS[section] + 'dd' } : {}}
            >
              <Icon className="w-3.5 h-3.5" />
              {SECTION_LABELS[section]}
              <span className={`text-[10px] px-1 py-0 rounded-full ${
                isActive ? 'bg-white/20' : 'bg-bg-secondary'
              }`}>
                {elementCount}
              </span>
            </button>
          )
        })}
      </div>

      {/* ── Main content area ────────────────────────────────────────────── */}
      <div className="flex-1 flex min-h-0">
        {/* ── Left: Element list ──────────────────────────────────────── */}
        <div className="w-56 flex-shrink-0 border-r border-border flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-xs font-medium text-text-secondary">Elements</span>
            {!selectedPreset.is_builtin && (
              <button onClick={handleAddElement}
                className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white">
                <Plus className="w-3 h-3" /> Add
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {sectionElements.map(elem => (
              <div
                key={elem.id}
                onClick={() => setSelectedElementId(elem.id)}
                className={`group flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-xs ${
                  selectedElementId === elem.id
                    ? 'bg-blue-600/20 text-blue-300 border border-blue-500/30'
                    : 'hover:bg-bg-secondary text-text-secondary'
                }`}
              >
                <GripVertical className="w-3 h-3 text-text-tertiary flex-shrink-0" />
                <span className="flex-1 truncate">{elem.name}</span>
                <button
                  onClick={e => { e.stopPropagation(); handleToggleVisibility(elem) }}
                  className="p-0.5 rounded hover:bg-bg-secondary"
                >
                  {elem.visible
                    ? <Eye className="w-3 h-3 text-text-tertiary" />
                    : <EyeOff className="w-3 h-3 text-text-tertiary opacity-50" />
                  }
                </button>
                {!selectedPreset.is_builtin && (
                  <button
                    onClick={e => { e.stopPropagation(); handleRemoveElement(elem.id) }}
                    className="p-0.5 rounded hover:bg-red-700/50 text-text-tertiary hover:text-red-400 opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
            {sectionElements.length === 0 && (
              <div className="text-center text-text-tertiary text-[10px] py-4">
                No elements in this section.
                {!selectedPreset.is_builtin && <br />}
                {!selectedPreset.is_builtin && 'Click + Add to create one.'}
              </div>
            )}
          </div>

          {/* Intro video section (only for intro tab) */}
          {activeSection === 'intro' && (
            <div className="border-t border-border px-3 py-2">
              <div className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider mb-1">Intro Video</div>
              {selectedPreset.intro_video_path ? (
                <div className="flex items-center gap-1 text-xs text-text-secondary">
                  <Film className="w-3 h-3 text-green-400" />
                  <span className="truncate flex-1">Video uploaded</span>
                  {!selectedPreset.is_builtin && (
                    <button onClick={handleDeleteIntroVideo} className="p-0.5 rounded hover:bg-red-700/50 text-text-tertiary hover:text-red-400">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ) : !selectedPreset.is_builtin ? (
                <label className="flex items-center gap-1 text-xs text-text-tertiary cursor-pointer hover:text-text-secondary">
                  <Upload className="w-3 h-3" />
                  <span>Upload video</span>
                  <input type="file" accept="video/*" onChange={handleIntroVideoUpload} className="hidden" />
                </label>
              ) : (
                <span className="text-[10px] text-text-tertiary">No video</span>
              )}
            </div>
          )}
        </div>

        {/* ── Center: Preview ─────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
            <span className="text-xs text-text-tertiary">Live Preview</span>
            <button onClick={handleRefreshPreview} disabled={previewLoading}
              className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-bg-secondary hover:bg-border text-text-secondary disabled:opacity-50">
              {previewLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Refresh
            </button>
          </div>
          <div className="flex-1 flex items-center justify-center p-4 bg-[#0a0a0a] overflow-hidden">
            {previewImage ? (
              <img
                src={previewImage}
                alt="Overlay preview"
                className="max-w-full max-h-full object-contain border border-border/30 rounded"
                style={{ imageRendering: 'auto' }}
              />
            ) : (
              <div className="text-text-tertiary text-xs flex flex-col items-center gap-2">
                <Monitor className="w-8 h-8 opacity-30" />
                {engineStatus?.engine_initialized
                  ? 'Click Refresh to render preview'
                  : 'Initialize the overlay engine to see preview'
                }
              </div>
            )}
          </div>
        </div>

        {/* ── Right: Element properties ───────────────────────────────── */}
        <div className="w-72 flex-shrink-0 border-l border-border overflow-y-auto">
          {selectedElement ? (
            <ElementEditor
              element={selectedElement}
              isBuiltin={selectedPreset.is_builtin}
              onUpdate={(updates) => handleElementUpdate(selectedElement.id, updates)}
              onRefreshPreview={handleRefreshPreview}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-text-tertiary text-xs p-4">
              <Box className="w-6 h-6 mb-2 opacity-30" />
              Select an element to edit its properties
            </div>
          )}
        </div>
      </div>

      {/* ── Bottom panels (variables / assets) ──────────────────────────── */}
      {showVariables && selectedPreset && (
        <VariableEditor
          preset={selectedPreset}
          onUpdate={(variables) => updatePreset(selectedPreset.id, { variables })}
          onClose={() => setShowVariables(false)}
        />
      )}
      {showAssets && selectedPreset && (
        <AssetManager
          presetId={selectedPreset.id}
          isBuiltin={selectedPreset.is_builtin}
          onClose={() => setShowAssets(false)}
        />
      )}

      {/* ── AI Prompt Panel ────────────────────────────────────────────── */}
      {showAIPrompt && isAvailable() && (
        <div className="border-t border-border bg-bg-secondary px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-purple-400" />
            <span className="text-xs font-semibold text-text-primary">AI Element Designer</span>
            <div className="flex items-center gap-1 ml-auto">
              <button
                onClick={() => setAiMode('create')}
                className={`text-[10px] px-2 py-0.5 rounded ${
                  aiMode === 'create'
                    ? 'bg-purple-600 text-white'
                    : 'bg-bg-primary text-text-tertiary hover:text-text-secondary border border-border'
                }`}
              >
                <Plus className="w-3 h-3 inline mr-0.5" />
                Create New
              </button>
              <button
                onClick={() => setAiMode('augment')}
                disabled={!selectedElement}
                className={`text-[10px] px-2 py-0.5 rounded ${
                  aiMode === 'augment'
                    ? 'bg-purple-600 text-white'
                    : 'bg-bg-primary text-text-tertiary hover:text-text-secondary border border-border'
                } disabled:opacity-30 disabled:cursor-not-allowed`}
                title={!selectedElement ? 'Select an element to modify' : 'Modify selected element'}
              >
                <Wand2 className="w-3 h-3 inline mr-0.5" />
                Modify Selected
              </button>
            </div>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleAISubmit()}
              placeholder={
                aiMode === 'create'
                  ? `Describe a new element for the ${activeSection} section...`
                  : selectedElement
                    ? `Describe changes to "${selectedElement.name}"...`
                    : 'Select an element first'
              }
              disabled={llmLoading || (aiMode === 'augment' && !selectedElement)}
              className="flex-1 px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                         text-text-primary placeholder:text-text-disabled
                         focus:outline-none focus:ring-2 focus:ring-purple-500/40 focus:border-purple-500
                         transition-colors disabled:opacity-50"
            />
            <button
              onClick={handleAISubmit}
              disabled={llmLoading || !aiPrompt.trim() || (aiMode === 'augment' && !selectedElement)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-500
                         text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {llmLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {llmLoading ? 'Generating...' : 'Generate'}
            </button>
          </div>
          <p className="text-[10px] text-text-tertiary mt-1.5">
            {aiMode === 'create'
              ? 'Describe the element you want. The AI knows all available template variables and will create properly formatted Jinja2/HTML.'
              : 'Describe changes to make. The AI will preserve the element identity and modify its template, position, or styling.'
            }
          </p>
        </div>
      )}
    </div>
  )
}
