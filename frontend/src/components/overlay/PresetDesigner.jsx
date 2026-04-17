import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { usePreset } from '../../context/PresetContext'
import { useOverlay } from '../../context/OverlayContext'
import { useLLM } from '../../context/LLMContext'
import { useToast } from '../../context/ToastContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import ElementEditor from './ElementEditor'
import VariableEditor from './VariableEditor'
import AssetManager from './AssetManager'
import ResizableSplitPane from '../ui/ResizableSplitPane'
import AIPromptComposer from '../ui/AIPromptComposer'
import AIDesignerToggleButton from '../ui/AIDesignerToggleButton'
import AIDesignerPanelMeta from '../ui/AIDesignerPanelMeta'
import IsolatedHtmlPreview from '../ui/IsolatedHtmlPreview'
import PreviewPlayer from '../analysis/PreviewPlayer'
import {
  Layers, Plus, Trash2, Upload,
  ArrowLeft, Eye, EyeOff, Monitor,
  Palette, Image, Film, GripVertical, RefreshCw,
  Loader2, Box, BarChart3, Sparkles, Wand2, History, RotateCcw, PenSquare, Wrench,
} from 'lucide-react'

const SECTION_ICONS = {
  intro: Film,
  qualifying_results: BarChart3,
  race: Monitor,
  race_results: BarChart3,
}

const PREVIEW_RENDER_TIMEOUT_MS = 15000

function sanitizePreviewHtmlForInlineRender(html, renderWidth = 1920, renderHeight = 1080) {
  if (!html || typeof html !== 'string') return ''

  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')

    doc.querySelectorAll('script,iframe,object,embed,frame,frameset,base,meta[http-equiv="refresh"]').forEach((node) => {
      node.remove()
    })

    const allElements = doc.body ? Array.from(doc.body.querySelectorAll('*')) : []
    allElements.forEach((el) => {
      Array.from(el.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase()
        const value = String(attr.value || '')

        if (name.startsWith('on')) {
          el.removeAttribute(attr.name)
          return
        }

        if ((name === 'src' || name === 'href' || name === 'xlink:href') && /^\s*javascript:/i.test(value)) {
          el.removeAttribute(attr.name)
        }
      })
    })

    // Inline mode has no top-level html/body viewport. Remap those root selectors
    // to our controlled preview root so full-width templates don't clip.
    const rewriteRootSelectors = (css) => {
      if (!css) return ''
      return css
        .replace(/(^|[^\w-])html(?=[^\w-]|$)/g, '$1.lrs-designer-inline-overlay-root')
        .replace(/(^|[^\w-])body(?=[^\w-]|$)/g, '$1.lrs-designer-inline-overlay-root')
    }

    const styleText = Array.from(doc.querySelectorAll('style'))
      .map((style) => rewriteRootSelectors(style.textContent || ''))
      .join('\n')
    const bodyHtml = doc.body ? doc.body.innerHTML : ''
    const safeW = Math.max(1, Number(renderWidth) || 1920)
    const safeH = Math.max(1, Number(renderHeight) || 1080)

    return `
      <style id="lrs-designer-inline-overlay-style">
        .lrs-designer-inline-overlay-root, .lrs-designer-inline-overlay-root * { box-sizing: border-box; }
        .lrs-designer-inline-overlay-root {
          position: relative;
          width: ${safeW}px;
          height: ${safeH}px;
          min-width: ${safeW}px;
          min-height: ${safeH}px;
          max-width: ${safeW}px;
          max-height: ${safeH}px;
          overflow: hidden;
          background: transparent !important;
          background-color: transparent !important;
        }
        .lrs-designer-inline-overlay-root .overlay-container,
        .lrs-designer-inline-overlay-root #overlay-root,
        .lrs-designer-inline-overlay-root #root {
          width: 100% !important;
          height: 100% !important;
          background: transparent !important;
          background-color: transparent !important;
        }
        ${styleText}
        /* Final transparency guard: must come AFTER injected template styles. */
        .lrs-designer-inline-overlay-root,
        .lrs-designer-inline-overlay-root .overlay-container,
        .lrs-designer-inline-overlay-root #overlay-root,
        .lrs-designer-inline-overlay-root #root {
          background: transparent !important;
          background-color: transparent !important;
        }
      </style>
      <div class="lrs-designer-inline-overlay-root">${bodyHtml}</div>
    `
  } catch {
    return ''
  }
}

/**
 * PresetDesigner — Full overlay design suite with per-section element management.
 */
export default function PresetDesigner({ presetId, onClose, onOpenBuild }) {
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
  const [previewHtml, setPreviewHtml] = useState(null)
  const [previewRenderMode, setPreviewRenderMode] = useLocalStorage('lrs:overlay:designer:previewRenderMode', 'png')
  const [showLiveStreamUnderlay, setShowLiveStreamUnderlay] = useLocalStorage('lrs:overlay:designer:showLiveStreamUnderlay', false)
  const [previewRenderSize, setPreviewRenderSize] = useState({ width: 1920, height: 1080 })
  const [previewLoading, setPreviewLoading] = useState(false)
  const [showVariables, setShowVariables] = useState(false)
  const [showAssets, setShowAssets] = useState(false)
  const [showAIPrompt, setShowAIPrompt] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiMode, setAiMode] = useState('create') // 'create', 'augment', or 'augment_all'
  const [showPromptHistory, setShowPromptHistory] = useState(false)
  const [aiPromptHistory, setAiPromptHistory] = useLocalStorage('lrs:overlay:aiPromptHistory', [])
  const previewTimeoutRef = useRef(null)
  const previewViewportRef = useRef(null)
  const [previewViewportSize, setPreviewViewportSize] = useState({ width: 0, height: 0 })

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
  }, [activeSection, previewRenderMode, selectedPreset?.sections?.[activeSection]?.length])

  useEffect(() => {
    const node = previewViewportRef.current
    if (!node) return undefined

    const measure = () => {
      const rect = node.getBoundingClientRect()
      setPreviewViewportSize({ width: Math.max(0, rect.width), height: Math.max(0, rect.height) })
    }

    const obs = new ResizeObserver(measure)
    obs.observe(node)
    measure()

    return () => obs.disconnect()
  }, [])

  const previewOverlayScale = useMemo(() => {
    const sourceW = Number(previewRenderSize?.width) || 1920
    const sourceH = Number(previewRenderSize?.height) || 1080
    const boxW = Number(previewViewportSize?.width) || sourceW
    const boxH = Number(previewViewportSize?.height) || sourceH
    return Math.min(1, boxW / sourceW, boxH / sourceH)
  }, [previewRenderSize?.height, previewRenderSize?.width, previewViewportSize?.height, previewViewportSize?.width])

  // Keep a valid selection per section and default to the first element on tab change.
  useEffect(() => {
    if (!Array.isArray(sectionElements) || sectionElements.length === 0) {
      setSelectedElementId(null)
      return
    }

    const selectedStillExists = sectionElements.some((elem) => elem.id === selectedElementId)
    if (!selectedStillExists) {
      setSelectedElementId(sectionElements[0].id)
    }
  }, [activeSection, sectionElements, selectedElementId])

  const selectedElement = sectionElements.find(e => e.id === selectedElementId)

  // ── Preview rendering ─────────────────────────────────────────────────
  const handleRefreshPreview = useCallback(async () => {
    if (!selectedPreset) return
    // Debounce
    if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current)
    previewTimeoutRef.current = setTimeout(async () => {
      setPreviewLoading(true)
      try {
        const result = await Promise.race([
          renderPreview(selectedPreset.id, activeSection, {
            includeRenderedHtml: previewRenderMode === 'html',
            renderScreenshot: previewRenderMode !== 'html',
          }),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Preview render timed out')), PREVIEW_RENDER_TIMEOUT_MS)
          }),
        ])
        const renderWidth = Number(result?.width) || 1920
        const renderHeight = Number(result?.height) || 1080
        setPreviewRenderSize({ width: renderWidth, height: renderHeight })

        if (previewRenderMode === 'html') {
          const safeHtml = sanitizePreviewHtmlForInlineRender(result?.rendered_html, renderWidth, renderHeight)
          if (safeHtml) {
            setPreviewHtml(safeHtml)
            setPreviewImage(null)
          } else {
            setPreviewHtml(null)
            addToast('HTML preview was blocked by safeguards', 'warning')
          }
        } else if (result?.png_base64) {
          setPreviewImage(`data:image/png;base64,${result.png_base64}`)
          setPreviewHtml(null)
        }
      } catch (err) {
        // Preview errors are non-fatal, but show a helpful toast for timeout/stalls.
        if (err?.message?.includes('timed out')) {
          addToast('Preview refresh timed out. Try Refresh again.', 'warning')
        }
      } finally {
        setPreviewLoading(false)
      }
    }, 300)
  }, [selectedPreset, activeSection, renderPreview, addToast, previewRenderMode])

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
    if (selectedPreset.is_builtin) {
      addToast('Built-in presets are read-only. Duplicate the preset to use AI modifications.', 'warning')
      return
    }
    const promptText = aiPrompt.trim()

    setAiPromptHistory((prev) => {
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        prompt: promptText,
        mode: aiMode,
        section: activeSection,
        elementName: selectedElement?.name || null,
        createdAt: new Date().toISOString(),
      }
      return [entry, ...(Array.isArray(prev) ? prev : [])]
    })

    if (aiMode === 'augment' && selectedElement) {
      const result = await augmentElement(
        promptText,
        activeSection,
        selectedPreset.id,
        selectedElement.id,
      )
      if (result?.element) {
        const updateResult = await handleElementUpdate(selectedElement.id, result.element)
        if (updateResult?.success) {
          addToast(result.explanation || 'Element updated by AI', 'success')
          setAiPrompt('')
          handleRefreshPreview()
        } else {
          addToast(updateResult?.error || 'AI generated changes, but they could not be saved.', 'error')
        }
      }
    } else if (aiMode === 'augment_all' && sectionElements.length > 0) {
      let successCount = 0
      let failureCount = 0

      for (const elem of sectionElements) {
        const result = await augmentElement(
          promptText,
          activeSection,
          selectedPreset.id,
          elem.id,
          { silent: true },
        )

        if (result?.element) {
          const updateResult = await handleElementUpdate(elem.id, result.element)
          if (updateResult?.success) {
            successCount += 1
          } else {
            failureCount += 1
          }
        } else {
          failureCount += 1
        }
      }

      if (successCount > 0) {
        addToast(`AI modified ${successCount} element${successCount === 1 ? '' : 's'}`, 'success')
      }
      if (failureCount > 0) {
        addToast(`Failed to modify ${failureCount} element${failureCount === 1 ? '' : 's'}`, 'warning')
      }
      if (successCount > 0) {
        setAiPrompt('')
        handleRefreshPreview()
      }
    } else {
      const result = await generateElement(
        promptText,
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
      generateElement, augmentElement, addElement, handleElementUpdate, addToast, handleRefreshPreview, setAiPromptHistory])

  if (!selectedPreset) {
    return (
      <div className="flex items-center justify-center h-full text-text-tertiary">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading preset...
      </div>
    )
  }

  const elementsPane = (
    <div className="h-full min-h-0 flex flex-col bg-bg-primary">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-text-secondary">Elements</span>
        {!selectedPreset.is_builtin && (
          <button onClick={handleAddElement}
            className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white">
            <Plus className="w-3 h-3" /> Add
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1 min-h-0">
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

      {activeSection === 'intro' && (
        <div className="border-t border-border px-3 py-2 shrink-0">
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
  )

  const previewPane = (
    <div className="h-full min-h-0 flex flex-col bg-bg-primary">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <Eye className="w-3.5 h-3.5 text-accent" />
          Live Preview
        </span>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded border border-border bg-bg-secondary px-1 py-0.5">
            <button
              type="button"
              onClick={() => setPreviewRenderMode('png')}
              className={`text-[10px] px-2 py-0.5 rounded ${previewRenderMode === 'png' ? 'bg-blue-600 text-white' : 'text-text-tertiary hover:text-text-primary'}`}
            >
              PNG
            </button>
            <button
              type="button"
              onClick={() => setPreviewRenderMode('html')}
              className={`text-[10px] px-2 py-0.5 rounded ${previewRenderMode === 'html' ? 'bg-blue-600 text-white' : 'text-text-tertiary hover:text-text-primary'}`}
            >
              HTML
            </button>
          </div>
          <button
            type="button"
            onClick={() => setShowLiveStreamUnderlay((prev) => !prev)}
            className={`text-[10px] px-2 py-0.5 rounded border ${
              showLiveStreamUnderlay
                ? 'bg-emerald-600/20 text-emerald-300 border-emerald-500/40'
                : 'bg-bg-secondary text-text-tertiary border-border hover:text-text-primary'
            }`}
            title="Show live iRacing stream under the overlay"
          >
            {showLiveStreamUnderlay ? 'Stream On' : 'Stream Off'}
          </button>
          <button onClick={handleRefreshPreview} disabled={previewLoading}
            className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-bg-secondary hover:bg-border text-text-secondary disabled:opacity-50">
            {previewLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Refresh
          </button>
        </div>
      </div>
      <div ref={previewViewportRef} className="relative flex-1 min-h-0 flex items-center justify-center p-4 bg-[#0a0a0a] overflow-hidden">
        {showLiveStreamUnderlay && (
          <div
            className="absolute left-1/2 top-1/2 z-0"
            style={{
              width: `${previewRenderSize.width}px`,
              height: `${previewRenderSize.height}px`,
              marginLeft: `-${previewRenderSize.width / 2}px`,
              marginTop: `-${previewRenderSize.height / 2}px`,
              transformOrigin: 'center center',
              transform: `scale(${previewOverlayScale})`,
            }}
          >
            <PreviewPlayer
              isAnalyzing={false}
              isPlaying={false}
              onPlayPause={() => {}}
              isPortrait={false}
            />
          </div>
        )}

        {previewRenderMode === 'png' && previewImage ? (
          <img
            src={previewImage}
            alt="Overlay preview"
            className="relative z-10 max-w-full max-h-full object-contain border border-border/30 rounded pointer-events-none"
            style={{ imageRendering: 'auto' }}
          />
        ) : previewRenderMode === 'html' && previewHtml ? (
          <IsolatedHtmlPreview
            html={previewHtml}
            className="absolute left-1/2 top-1/2 z-10 border-0 bg-transparent pointer-events-none"
            style={{
              width: `${previewRenderSize.width}px`,
              height: `${previewRenderSize.height}px`,
              marginLeft: `-${previewRenderSize.width / 2}px`,
              marginTop: `-${previewRenderSize.height / 2}px`,
              transformOrigin: 'center center',
              transform: `scale(${previewOverlayScale})`,
              background: 'transparent',
            }}
          />
        ) : (
          <div className="text-text-tertiary text-xs flex flex-col items-center gap-2">
            {previewLoading ? (
              <>
                <Loader2 className="w-8 h-8 opacity-60 animate-spin" />
                <span>Rendering preview...</span>
              </>
            ) : (
              <>
                <Monitor className="w-8 h-8 opacity-30" />
                {engineStatus?.engine_initialized
                  ? 'Click Refresh to render preview'
                  : 'Initialize the overlay engine to see preview'
                }
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )

  const inspectorPane = (
    <div className="h-full min-h-0 overflow-y-auto bg-bg-primary">
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
  )

  return (
    <div className="flex flex-col h-full bg-bg-primary text-text-primary">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-secondary shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <button onClick={onClose} className="p-1 rounded hover:bg-bg-hover text-text-tertiary">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="inline-flex items-center gap-2 min-w-0">
            <PenSquare className="w-4 h-4 text-accent" />
            <span className="text-sm font-semibold text-text-primary">Design</span>
            <span className="text-xs text-text-tertiary truncate">{selectedPreset.name}</span>
          </div>
          {selectedPreset.is_builtin && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-secondary text-text-tertiary uppercase">Built-in</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {typeof onOpenBuild === 'function' && (
            <button
              onClick={onOpenBuild}
              className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-secondary border border-transparent"
              title="Open Build workspace"
            >
              <Wrench className="w-4 h-4" />
              Open Build
            </button>
          )}
          <button onClick={() => setShowAssets(!showAssets)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${showAssets ? 'bg-blue-600/20 text-blue-400 border border-blue-500/40' : 'text-text-tertiary hover:text-text-primary hover:bg-bg-secondary border border-transparent'}`}
            title="Assets"
          >
            <Image className="w-4 h-4" />
            Assets
          </button>
          <button onClick={() => setShowVariables(!showVariables)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${showVariables ? 'bg-blue-600/20 text-blue-400 border border-blue-500/40' : 'text-text-tertiary hover:text-text-primary hover:bg-bg-secondary border border-transparent'}`}
            title="Variables"
          >
            <Palette className="w-4 h-4" />
            Variables
          </button>
          {isAvailable() && (
            <AIDesignerToggleButton
              active={showAIPrompt}
              onClick={() => setShowAIPrompt(!showAIPrompt)}
              disabled={selectedPreset.is_builtin}
              title="AI Designer"
              label="AI Designer"
            />
          )}
          {!engineStatus?.engine_initialized && (
            <button onClick={() => initEngine()} className="text-xs px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white">
              Init Engine
            </button>
          )}
        </div>
      </div>

      {/* ── Section tabs ────────────────────────────────────────────────── */}
      <div className="flex border-b border-border bg-bg-secondary shrink-0">
        {VIDEO_SECTIONS.map(section => {
          const Icon = SECTION_ICONS[section] || Monitor
          const isActive = activeSection === section
          const elementCount = selectedPreset.sections?.[section]?.length || 0
          return (
            <button
              key={section}
              onClick={() => {
                setActiveSection(section)
                const firstElementId = selectedPreset.sections?.[section]?.[0]?.id || null
                setSelectedElementId(firstElementId)
              }}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors
                border-b-2 ${isActive
                  ? `border-accent text-accent bg-accent/5`
                  : 'border-transparent text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
                }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {SECTION_LABELS[section]}
              {elementCount > 0 && (
                <span className="ml-1 px-1.5 py-0 rounded-full text-xxs bg-bg-primary border border-border">
                  {elementCount}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* ── Main content area ────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <ResizableSplitPane
          storageKey="lrs:overlay:designer:leftWidth"
          defaultLeftWidth={260}
          minLeft={220}
          maxLeftPct={0.32}
          containerClassName="flex h-full min-h-0 overflow-hidden relative"
          leftClassName="h-full min-h-0 overflow-hidden"
          rightClassName="h-full min-h-0 overflow-hidden"
          left={elementsPane}
          right={(
            <ResizableSplitPane
              storageKey="lrs:overlay:designer:centerWidth"
              defaultLeftWidth={980}
              minLeft={420}
              maxLeftPct={0.8}
              containerClassName="flex h-full min-h-0 overflow-hidden relative"
              leftClassName="h-full min-h-0 overflow-hidden"
              rightClassName="h-full min-h-0 overflow-hidden"
              left={previewPane}
              right={inspectorPane}
            />
          )}
        />
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
        <div className="border-t border-border bg-bg-secondary px-4 py-3 relative">
          {showPromptHistory && (
            <div className="absolute left-4 right-4 bottom-full mb-2 rounded-lg border border-border bg-bg-primary shadow-xl z-30 max-h-64 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                <span className="text-xs font-semibold text-text-primary">AI Prompt History</span>
                <button
                  type="button"
                  onClick={() => setAiPromptHistory([])}
                  className="text-[10px] px-2 py-1 rounded border border-border text-text-tertiary hover:text-text-primary hover:bg-bg-secondary"
                  title="Clear prompt history"
                >
                  <RotateCcw className="w-3 h-3 inline mr-1" />
                  Clear
                </button>
              </div>
              <div className="max-h-52 overflow-y-auto divide-y divide-border/60">
                {Array.isArray(aiPromptHistory) && aiPromptHistory.length > 0 ? (
                  aiPromptHistory.map((entry) => (
                    <div key={entry.id} className="px-3 py-2.5">
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-[10px] text-text-tertiary mb-1">
                            <span className="uppercase tracking-wide">
                              {entry.mode === 'augment'
                                ? 'Modify Selected'
                                : entry.mode === 'augment_all'
                                  ? 'Modify All'
                                  : 'Create New'}
                            </span>
                            <span className="mx-1">•</span>
                            <span>{entry.section || 'race'}</span>
                            {entry.elementName ? <span className="mx-1">• {entry.elementName}</span> : null}
                          </div>
                          <div className="text-xs text-text-primary break-words">{entry.prompt}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setAiPrompt(entry.prompt || '')
                            if (entry.mode === 'create' || entry.mode === 'augment' || entry.mode === 'augment_all') {
                              setAiMode(entry.mode)
                            }
                            setShowPromptHistory(false)
                          }}
                          className="text-[10px] px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white whitespace-nowrap"
                        >
                          Use
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="px-3 py-6 text-xs text-text-tertiary text-center">
                    No AI prompt history yet.
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 mb-2">
            <AIDesignerPanelMeta subtitle="describe what to change" />
            <div className="flex items-center gap-1 ml-auto">
              <button
                type="button"
                onClick={() => setShowPromptHistory(v => !v)}
                className={`text-[10px] px-2 py-0.5 rounded border ${
                  showPromptHistory
                    ? 'bg-purple-600 text-white border-purple-500'
                    : 'bg-bg-primary text-text-tertiary hover:text-text-secondary border-border'
                }`}
                title="Show AI prompt history"
              >
                <History className="w-3 h-3 inline mr-0.5" />
                History
              </button>
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
              <button
                onClick={() => setAiMode('augment_all')}
                disabled={sectionElements.length === 0}
                className={`text-[10px] px-2 py-0.5 rounded ${
                  aiMode === 'augment_all'
                    ? 'bg-purple-600 text-white'
                    : 'bg-bg-primary text-text-tertiary hover:text-text-secondary border border-border'
                } disabled:opacity-30 disabled:cursor-not-allowed`}
                title={sectionElements.length === 0 ? 'No elements to modify' : 'Modify all elements in this section'}
              >
                <Wand2 className="w-3 h-3 inline mr-0.5" />
                Modify All
              </button>
            </div>
          </div>
          <AIPromptComposer
            value={aiPrompt}
            onChange={setAiPrompt}
            onSubmit={handleAISubmit}
            loading={llmLoading}
            submitLabel="Generate"
            loadingLabel="Generating..."
            disabled={(aiMode === 'augment' && !selectedElement) || (aiMode === 'augment_all' && sectionElements.length === 0)}
            placeholder={
              aiMode === 'create'
                ? `Describe a new element for the ${activeSection} section...`
                : aiMode === 'augment_all'
                  ? `Describe changes to apply to all ${sectionElements.length} element${sectionElements.length === 1 ? '' : 's'}...`
                  : selectedElement
                    ? `Describe changes to "${selectedElement.name}"...`
                    : 'Select an element first'
            }
          />
          <AIDesignerPanelMeta
            helper={aiMode === 'create'
              ? 'Enter to generate - creates new element HTML using available template variables.'
              : aiMode === 'augment_all'
                ? 'Enter to generate - applies the same change to every element in this section.'
                : 'Enter to generate - preserves element identity and modifies template, position, or styling.'
            }
            showHeader={false}
          />
        </div>
      )}
    </div>
  )
}
