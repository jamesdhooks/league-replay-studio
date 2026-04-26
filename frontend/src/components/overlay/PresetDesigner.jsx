import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { usePreset } from '../../context/PresetContext'
import { useOverlay } from '../../context/OverlayContext'
import { useProject } from '../../context/ProjectContext'
import { useOverlaySettings } from '../../context/OverlaySettingsContext'
import { useToast } from '../../context/ToastContext'
import VariableEditor from './VariableEditor'
import AssetManager from './AssetManager'
import ResizableSidebar from '../layout/ResizableSidebar'
import IsolatedHtmlPreview from '../ui/IsolatedHtmlPreview'
import PreviewPlayer from '../analysis/PreviewPlayer'
import IracingCommandLog from '../highlights/IracingCommandLog'
import { wsClient } from '../../services/websocket'
import OverlayWorkspaceTopbar from './OverlayWorkspaceTopbar'
import {
  Trash2,
  Eye, EyeOff, Monitor,
  Palette, Image, Film, RefreshCw,
  Loader2, Award, Flag, Wrench, ZoomIn, ZoomOut, Maximize2, Bug, Copy,
  Terminal, AlertTriangle,
} from 'lucide-react'

const SECTION_ICONS = {
  intro: Film,
  qualifying_results: Award,
  race: Flag,
  race_results: Monitor,
}

const SECTION_ACTIVE_ICON_COLORS = {
  intro: 'text-blue-400',
  qualifying_results: 'text-amber-400',
  race: 'text-emerald-400',
  race_results: 'text-purple-400',
}

const PREVIEW_RENDER_TIMEOUT_MS = 15000

function sanitizePreviewHtmlForInlineRender(html, renderWidth = 1920, renderHeight = 1080) {
  if (!html || typeof html !== 'string') return ''

  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')

    // Strip dangerous embedding/navigation tags.
    doc.querySelectorAll('iframe,object,embed,frame,frameset,base,meta[http-equiv="refresh"]').forEach((n) => n.remove())

    // Keep the local Tailwind runtime and CDN fallback; strip everything else.
    const allowedScriptSources = new Set([
      'https://cdn.tailwindcss.com',
      'http://cdn.tailwindcss.com',
      '//cdn.tailwindcss.com',
    ])
    doc.querySelectorAll('script').forEach((scriptEl) => {
      const src = (scriptEl.getAttribute('src') || '').trim()
      const id = (scriptEl.getAttribute('id') || '').trim()
      const isAllowedInlineRuntime = !src && id === 'lrs-tailwind-runtime'
      if (!isAllowedInlineRuntime && (!src || !allowedScriptSources.has(src))) {
        scriptEl.remove()
      }
    })

    // Strip event handlers and javascript: URLs.
    doc.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase()
        if (name.startsWith('on')) { el.removeAttribute(attr.name); return }
        if ((name === 'src' || name === 'href' || name === 'xlink:href') && /^\s*javascript:/i.test(attr.value)) {
          el.removeAttribute(attr.name)
        }
      })
    })

    // Inject base sizing so html/body fill the iframe at the render resolution.
    const safeW = Math.max(1, Number(renderWidth) || 1920)
    const safeH = Math.max(1, Number(renderHeight) || 1080)
    const baseStyle = doc.createElement('style')
    baseStyle.id = 'lrs-iframe-base'
    baseStyle.textContent = [
      `:root,html,body{margin:0;padding:0;width:${safeW}px;height:${safeH}px;background:transparent!important;background-color:transparent!important;overflow:hidden;}`,
    ].join('')
    doc.head.prepend(baseStyle)

    // Return a complete document — the iframe has a real html/body context so
    // Tailwind's runtime can inject styles into its own <head> as intended.
    return '<!DOCTYPE html>' + doc.documentElement.outerHTML
  } catch {
    return ''
  }
}

/**
 * PresetDesigner — Full overlay design suite with per-section element management.
 */
export default function PresetDesigner({ presetId, onOpenBuild }) {
  const {
    presets, selectedPreset: contextSelectedPreset, activeSection,
    SECTION_LABELS, VIDEO_SECTIONS,
    setActiveSection, setSelectedPresetId,
    updatePreset,
    renderPreview, fetchPresets,
  } = usePreset()
  const { activeProject } = useProject()
  const { initEngine, engineStatus } = useOverlay()
  const {
    previewRenderMode,
    setPreviewRenderMode,
    overlayVisible,
    setOverlayVisible,
    showLiveStreamUnderlay,
    setShowLiveStreamUnderlay,
    previewZoom,
    setPreviewZoom,
    showEventOverlay,
    setShowEventOverlay,
    debugEnabled,
    setDebugEnabled,
  } = useOverlaySettings()
  const { showSuccess, showError, showWarning, showInfo } = useToast()
  const addToast = useCallback((message, type = 'info') => {
    if (type === 'success') return showSuccess(message)
    if (type === 'error') return showError(message)
    if (type === 'warning') return showWarning(message)
    return showInfo(message)
  }, [showError, showInfo, showSuccess, showWarning])

  const [previewImage, setPreviewImage] = useState(null)
  const [previewHtml, setPreviewHtml] = useState(null)
  const [previewRenderSize, setPreviewRenderSize] = useState({ width: 1920, height: 1080 })
  const [previewLoading, setPreviewLoading] = useState(false)
  const previewTimeoutRef = useRef(null)
  const previewViewportRef = useRef(null)
  const [previewViewportSize, setPreviewViewportSize] = useState({ width: 0, height: 0 })
    const [previewRenderDebug, setPreviewRenderDebug] = useState(null)
  const [commandFeedCount, setCommandFeedCount] = useState(0)
  const [lastCommandLabel, setLastCommandLabel] = useState(null)

  useEffect(() => {
    const unsub = wsClient.subscribe('iracing:command', (data) => {
      setCommandFeedCount((prev) => prev + 1)
      setLastCommandLabel(data?.command || null)
    })
    return unsub
  }, [])

  const selectedPreset = useMemo(() => {
    if (contextSelectedPreset?.id) return contextSelectedPreset
    return presets.find((preset) => preset.id === presetId) || null
  }, [presets, presetId, contextSelectedPreset])

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

  const appliedPreviewScale = useMemo(() => previewOverlayScale, [previewOverlayScale])

  const handleCopyDebugPanel = useCallback(async () => {
    const payload = {
      panel: 'design-debug',
      presetId: selectedPreset?.id || null,
      render: {
        source: previewRenderDebug?.render_source || null,
        hasHtmlContent: previewRenderDebug?.has_html_content ?? null,
        sectionElementCount: previewRenderDebug?.section_element_count ?? null,
        preferHtmlContent: previewRenderDebug?.prefer_html_content ?? null,
        htmlLength: previewRenderDebug?.html_length ?? null,
      },
      frameSummary: previewRenderDebug?.frame_summary || null,
      commands: {
        count: commandFeedCount,
        lastLabel: lastCommandLabel,
      },
      raw: previewRenderDebug || {},
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      showSuccess('Design debug copied')
    } catch {
      showError('Failed to copy design debug')
    }
  }, [commandFeedCount, lastCommandLabel, previewRenderDebug, selectedPreset?.id, showError, showSuccess])

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
            projectId: activeProject?.id ?? null,
            includeRenderedHtml: previewRenderMode === 'html',
            renderScreenshot: previewRenderMode !== 'html',
              includeDebug: true,
            preferHtmlContent: true,
          }),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Preview render timed out')), PREVIEW_RENDER_TIMEOUT_MS)
          }),
        ])
        const renderWidth = Number(result?.width) || 1920
        const renderHeight = Number(result?.height) || 1080
        setPreviewRenderSize({ width: renderWidth, height: renderHeight })
        setPreviewRenderDebug(result?.debug_render || null)
        console.debug('[PresetDesigner][render-preview]', {
          presetId: selectedPreset.id,
          section: activeSection,
          mode: previewRenderMode,
          debugRender: result?.debug_render || null,
        })

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

  if (!selectedPreset) {
    return (
      <div className="flex items-center justify-center h-full text-text-tertiary">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading preset...
      </div>
    )
  }

  const sectionTabs = VIDEO_SECTIONS.map((section) => ({
    id: section,
    label: SECTION_LABELS[section],
    icon: SECTION_ICONS[section] || Monitor,
    activeIconClass: SECTION_ACTIVE_ICON_COLORS[section] || '',
    count: selectedPreset.sections?.[section]?.length || 0,
  }))

  const topbarContextControls = (
    <>
      <button
        onClick={handleRefreshPreview}
        disabled={previewLoading}
        className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-bg-secondary hover:bg-border text-text-secondary disabled:opacity-50"
        title="Refresh design preview"
      >
        {previewLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        Refresh
      </button>

      {typeof onOpenBuild === 'function' && (
        <button
          onClick={onOpenBuild}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xxs font-medium border border-border text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
          title="Open Build workspace"
        >
          <Wrench className="w-3.5 h-3.5" />
          Open Build
        </button>
      )}

      {!engineStatus?.engine_initialized && (
        <button onClick={() => initEngine()} className="rounded-md bg-blue-600 px-2 py-1 text-xxs font-medium text-white hover:bg-blue-500">
          Init Engine
        </button>
      )}
    </>
  )

  const topbarCommonControls = (
    <>
      <div className="flex items-center gap-1 rounded-md border border-border bg-bg-primary/50 px-1 py-0.5">
        <button
          onClick={() => setPreviewRenderMode('png')}
          className={`px-2 py-0.5 rounded text-xxs font-medium transition-colors ${
            previewRenderMode === 'png'
              ? 'bg-accent/20 text-accent border border-accent/40'
              : 'text-text-tertiary hover:text-text-primary'
          }`}
          title="Render as PNG snapshot"
        >
          PNG
        </button>
        <button
          onClick={() => setPreviewRenderMode('html')}
          className={`px-2 py-0.5 rounded text-xxs font-medium transition-colors ${
            previewRenderMode === 'html'
              ? 'bg-accent/20 text-accent border border-accent/40'
              : 'text-text-tertiary hover:text-text-primary'
          }`}
          title="Render native HTML/CSS overlay"
        >
          HTML
        </button>
      </div>

      <div className="flex items-center gap-1 rounded-md border border-border bg-bg-primary/50 px-2 py-1">
        <button onClick={() => setPreviewZoom(z => Math.max(z - 0.1, 0.25))} className="p-0.5 rounded hover:bg-bg-secondary" title="Zoom out">
          <ZoomOut className="w-3 h-3 text-text-tertiary" />
        </button>
        <span className="w-8 text-center text-[10px] tabular-nums text-text-tertiary">
          {Math.round(previewZoom * 100)}%
        </span>
        <button onClick={() => setPreviewZoom(z => Math.min(z + 0.1, 3))} className="p-0.5 rounded hover:bg-bg-secondary" title="Zoom in">
          <ZoomIn className="w-3 h-3 text-text-tertiary" />
        </button>
        <button onClick={() => setPreviewZoom(1)} className="ml-1 p-0.5 rounded hover:bg-bg-secondary" title="Fit to view">
          <Maximize2 className="w-3 h-3 text-text-tertiary" />
        </button>
      </div>

      <div className="flex items-center gap-0.5 rounded-md border border-border bg-bg-primary/50 px-1 py-0.5">
        <button
          onClick={() => setOverlayVisible(v => !v)}
          className={`rounded p-1 transition-colors ${
            overlayVisible
              ? 'bg-accent/15 text-accent hover:bg-accent/20'
              : 'text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
          }`}
          title={overlayVisible ? 'Hide overlay' : 'Show overlay'}
          aria-label={overlayVisible ? 'Hide overlay' : 'Show overlay'}
        >
          {overlayVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
        </button>

        <button
          onClick={() => setShowLiveStreamUnderlay(v => !v)}
          className={`rounded p-1 transition-colors ${
            showLiveStreamUnderlay
              ? 'bg-accent/15 text-accent hover:bg-accent/20'
              : 'text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
          }`}
          title={showLiveStreamUnderlay ? 'Hide live stream underlay' : 'Show live stream underlay'}
          aria-label={showLiveStreamUnderlay ? 'Hide live stream underlay' : 'Show live stream underlay'}
        >
          <Monitor className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => setShowEventOverlay(v => !v)}
          className={`rounded p-1 transition-colors ${
            showEventOverlay
              ? 'bg-accent/15 text-accent hover:bg-accent/20'
              : 'text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
          }`}
          title={showEventOverlay ? 'Hide iRacing command events' : 'Show iRacing command events'}
          aria-label={showEventOverlay ? 'Hide iRacing command events' : 'Show iRacing command events'}
        >
          <Terminal className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={() => setDebugEnabled(v => !v)}
          className={`rounded p-1 transition-colors ${
            debugEnabled
              ? 'bg-accent/15 text-accent hover:bg-accent/20'
              : 'text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
          }`}
          title="Toggle design preview debugging"
          aria-label={debugEnabled ? 'Disable design preview debugging' : 'Enable design preview debugging'}
        >
          <Bug className="w-3.5 h-3.5" />
        </button>
      </div>
    </>
  )

  const previewPane = (
    <div className="h-full min-h-0 flex flex-col bg-bg-primary">
      <div className="flex items-center justify-end px-3 py-1.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          {previewRenderDebug?.render_source && (
            <span className="px-2 py-0.5 rounded border border-border bg-bg-secondary text-[10px] font-mono text-text-tertiary">
              source: {previewRenderDebug.render_source}
            </span>
          )}
          {previewRenderDebug?.html_length != null && (
            <span className="px-2 py-0.5 rounded border border-border bg-bg-secondary text-[10px] font-mono text-text-tertiary">
              html: {previewRenderDebug.html_length}
            </span>
          )}
        </div>
      </div>
      <div ref={previewViewportRef} className="relative flex-1 min-h-0 flex items-center justify-center p-4 bg-[#0a0a0a] overflow-hidden">
        {activeProject && !activeProject.subsession_id && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-900/70 border border-amber-600/40 text-amber-300 text-[10px] pointer-events-none">
            <AlertTriangle className="w-3 h-3 shrink-0" />
            No iRacing session linked — showing sample data
          </div>
        )}
        {showLiveStreamUnderlay && (
          <div
            className="absolute left-1/2 top-1/2 z-0"
            style={{
              width: `${previewRenderSize.width}px`,
              height: `${previewRenderSize.height}px`,
              marginLeft: `-${previewRenderSize.width / 2}px`,
              marginTop: `-${previewRenderSize.height / 2}px`,
              transformOrigin: 'center center',
              transform: `scale(${appliedPreviewScale})`,
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

        {overlayVisible && previewRenderMode === 'png' && previewImage ? (
          <img
            src={previewImage}
            alt="Overlay preview"
            className="relative z-10 max-w-full max-h-full object-contain border border-border/30 rounded pointer-events-none"
            style={{ imageRendering: 'auto' }}
          />
        ) : overlayVisible && previewRenderMode === 'html' && previewHtml ? (
          <IsolatedHtmlPreview
            html={previewHtml}
            className="absolute left-1/2 top-1/2 z-10 border-0 bg-transparent pointer-events-none"
            style={{
              width: `${previewRenderSize.width}px`,
              height: `${previewRenderSize.height}px`,
              marginLeft: `-${previewRenderSize.width / 2}px`,
              marginTop: `-${previewRenderSize.height / 2}px`,
              transformOrigin: 'center center',
              transform: `scale(${appliedPreviewScale})`,
              background: 'transparent',
            }}
            zoom={previewZoom}
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

        {debugEnabled && (
          <div className="absolute left-3 bottom-3 z-20 w-80 max-w-[calc(100%-1.5rem)] rounded-lg border border-amber-500/30 bg-black/75 text-[10px] font-mono text-amber-100 shadow-xl backdrop-blur-sm">
            <div className="px-2 py-1 border-b border-amber-500/20 flex items-center justify-between">
              <span className="font-semibold">Design Debug</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCopyDebugPanel}
                  className="inline-flex items-center gap-1 rounded border border-amber-500/20 px-1.5 py-0.5 text-[9px] text-amber-200 transition-colors hover:bg-amber-500/10"
                  title="Copy formatted debug details"
                  aria-label="Copy formatted debug details"
                >
                  <Copy className="w-3 h-3" />
                  Copy
                </button>
                <span className="text-amber-300/80">{selectedPreset?.id || 'n/a'}</span>
              </div>
            </div>
            <div className="px-2 py-1.5 space-y-1.5 leading-4">
              <div className="grid grid-cols-[120px_1fr] gap-1">
                <span className="text-amber-300/80">Render source</span>
                <span>{previewRenderDebug?.render_source || 'n/a'}</span>
                <span className="text-amber-300/80">Has html</span>
                <span>{previewRenderDebug?.has_html_content == null ? 'n/a' : String(previewRenderDebug.has_html_content)}</span>
                <span className="text-amber-300/80">Section elems</span>
                <span>{previewRenderDebug?.section_element_count == null ? 'n/a' : String(previewRenderDebug.section_element_count)}</span>
                <span className="text-amber-300/80">Prefer html</span>
                <span>{previewRenderDebug?.prefer_html_content == null ? 'n/a' : String(previewRenderDebug.prefer_html_content)}</span>
                <span className="text-amber-300/80">HTML len</span>
                <span>{previewRenderDebug?.html_length == null ? 'n/a' : String(previewRenderDebug.html_length)}</span>
                <span className="text-amber-300/80">Commands</span>
                <span>{commandFeedCount}{lastCommandLabel ? ` (${lastCommandLabel})` : ''}</span>
              </div>
            </div>
          </div>
        )}

        {showEventOverlay && <IracingCommandLog />}
      </div>
    </div>
  )

  const sidebarTabs = [
    {
      id: 'variables',
      label: 'Variables',
      icon: Palette,
      content: (
        <VariableEditor
          preset={selectedPreset}
          activeSection={activeSection}
          activeSectionElements={selectedPreset.sections?.[activeSection] || []}
          projectId={activeProject?.id ?? null}
          onUpdate={(variables) => updatePreset(selectedPreset.id, { variables })}
          onClose={() => {}}
        />
      ),
    },
    {
      id: 'assets',
      label: 'Assets',
      icon: Image,
      content: (
        <AssetManager
          presetId={selectedPreset.id}
          projectId={activeProject?.id ?? null}
          isBuiltin={false}
          onClose={() => {}}
        />
      ),
    },
  ]

  return (
    <div className="flex flex-col h-full bg-bg-primary text-text-primary">
      <OverlayWorkspaceTopbar
        tabs={sectionTabs}
        activeTab={activeSection}
        onTabChange={(section) => {
          setActiveSection(section)
        }}
        contextControls={topbarContextControls}
        commonControls={topbarCommonControls}
      />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <ResizableSidebar
          storageKey="lrs:overlay:designer:sidebar"
          defaultWidth={260}
          defaultTab="variables"
          tabs={sidebarTabs}
        />
        <div className="flex-1 min-h-0 overflow-hidden">
          {previewPane}
        </div>
      </div>
    </div>
  )
}
