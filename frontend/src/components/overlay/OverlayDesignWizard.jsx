import { useState, useCallback, useEffect, useRef } from 'react'
import { Sparkles, Wrench, Loader2, ArrowRight, ArrowLeft, X, RotateCcw, Check } from 'lucide-react'
import { usePreset } from '../../context/PresetContext'
import { useProject } from '../../context/ProjectContext'
import { useToast } from '../../context/ToastContext'
import { useLLM } from '../../context/LLMContext'
import { useAiModifyHandler } from '../../hooks/useAiModifyHandler'
import { apiPost } from '../../services/api'
import { wsClient } from '../../services/websocket'

const EXAMPLE_PROMPTS = [
  'Dark broadcast package with amber accent colours, timing tower on the left, driver card bottom-right',
  'Minimalist white-on-black design with thin lines and monospace fonts, clean lower-thirds',
  'Neon cyberpunk theme with cyan and magenta highlights, glowing borders, digital readout fonts',
  'Retro F1 inspired design with red and white, bold sans-serif, classic timing board layout',
  'Premium dark gold broadcast package with subtle gradients and elegant serif typography',
  'Esports-style overlay with animated borders, team colour accents, and a bold HUD aesthetic',
]

const SECTIONS = [
  { id: 'intro', label: 'Intro' },
  { id: 'qualifying_results', label: 'Qualifying' },
  { id: 'race', label: 'Race' },
  { id: 'race_results', label: 'Results' },
]

/**
 * Wizard shown when creating a new overlay design.
 * Handles both AI-generated and manual (blank) creation paths.
 *
 * @param {function} onComplete      - called with (presetId, tab) on success
 * @param {function} onCancel        - called when the user dismisses the wizard
 * @param {function} onNoLlmSeen     - called when user dismisses the no-LLM explainer
 * @param {string|null} initialPresetId - if set, opens wizard in refine mode for an existing design
 */
export default function OverlayDesignWizard({
  onComplete,
  onCancel,
  onNoLlmSeen,
  initialPresetId = null,
}) {
  const { createPreset, getHtmlContent, updateHtmlContent, renderPreview, renderEditorPreview } = usePreset()
  const { activeProject } = useProject()
  const { showSuccess, showWarning, showInfo } = useToast()
  const { isAvailable } = useLLM()

  const [phase, setPhase] = useState(initialPresetId ? 'refine' : 'form') // form | generating | refine | applying | restarting
  const [presetId, setPresetId] = useState(initialPresetId)
  const [currentHtml, setCurrentHtml] = useState('')
  const [focusedSection, setFocusedSection] = useState('race')
  const [hasExplicitFocus, setHasExplicitFocus] = useState(false)
  const [singlePreviewMode, setSinglePreviewMode] = useState(false)
  const [previewBySection, setPreviewBySection] = useState({})
  const [previewCache, setPreviewCache] = useState({}) // { cacheKey: previewBySection }
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState(null)
  const [noLlmCreating, setNoLlmCreating] = useState(false)
  const [showDebugOverlay, setShowDebugOverlay] = useState(false)
  const [copyDebugStatus, setCopyDebugStatus] = useState('')
  const [aiUpdates, setAiUpdates] = useState([])
  const [aiCurrentMessage, setAiCurrentMessage] = useState('')
  const [gridSwitching, setGridSwitching] = useState(false)
  const applyRequestVersionRef = useRef(0)
  const currentAiRequestIdRef = useRef(null)

  const llmStatus = isAvailable() // true | false | null
  const llmAvailable = llmStatus === true

  const canSubmit = name.trim().length > 0

  const toErrorMessage = useCallback((err, fallback) => {
    if (!err) return fallback
    if (typeof err === 'string') return err
    if (typeof err?.message === 'string' && err.message.trim()) return err.message
    if (typeof err?.detail === 'string' && err.detail.trim()) return err.detail
    if (typeof err?.detail?.detail === 'string' && err.detail.detail.trim()) return err.detail.detail
    if (typeof err?.detail?.message === 'string' && err.detail.message.trim()) return err.detail.message
    return fallback
  }, [])

  const appendAiUpdate = useCallback((update) => {
    if (!update?.message) return

    setAiCurrentMessage(update.message)
    setAiUpdates((prev) => {
      const next = [...prev, {
        stage: update.stage || 'status',
        message: update.message,
      }]
      const deduped = []

      for (const entry of next) {
        const previous = deduped[deduped.length - 1]
        if (previous && previous.stage === entry.stage && previous.message === entry.message) {
          continue
        }
        deduped.push(entry)
      }

      return deduped.slice(-6)
    })
  }, [])

  const beginAiRequest = useCallback((requestId, initialMessage) => {
    currentAiRequestIdRef.current = requestId
    setAiUpdates([])
    setAiCurrentMessage('')
    appendAiUpdate({ stage: 'request_sent', message: initialMessage })
  }, [appendAiUpdate])

  const clearAiRequest = useCallback(() => {
    currentAiRequestIdRef.current = null
  }, [])

  const createAiRequestId = useCallback(() => {
    if (globalThis.crypto?.randomUUID) {
      return `overlay_${globalThis.crypto.randomUUID().slice(0, 8)}`
    }
    return `overlay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  }, [])
  
    // AI modify handler with shared approval workflow (all dependencies now defined)
    const aiModifyHandler = useAiModifyHandler(
      currentHtml,
      presetId,
      {
        section: focusedSection,
        scopeMode: 'all_sections',
        workspacePath: 'design',
        onHtmlChange: setCurrentHtml,
        onPendingChange: () => {}, // State managed by handler
        appendUpdate: appendAiUpdate,
        showSuccess,
        showWarning,
        showInfo,
        updateHtmlContent,
      },
    )

    useEffect(() => {
      if (!aiModifyHandler.hasPendingAiChange) {
        setGridSwitching(false)
        return
      }

      setGridSwitching(true)
      const timer = setTimeout(() => setGridSwitching(false), 260)
      return () => clearTimeout(timer)
    }, [aiModifyHandler.hasPendingAiChange, aiModifyHandler.showAiBefore])

  useEffect(() => {
    const handleStatus = (data) => {
      if (data?.source !== 'llm_overlay') return
      if (!data?.request_id || data.request_id !== currentAiRequestIdRef.current) return
      appendAiUpdate({ stage: data.stage, message: data.message })
    }

    const handleError = (data) => {
      if (data?.source !== 'llm_overlay') return
      if (!data?.request_id || data.request_id !== currentAiRequestIdRef.current) return
      appendAiUpdate({ stage: data.stage || 'failed', message: data.message || 'AI request failed' })
    }

    const unsubs = [
      wsClient.subscribe('overlay:ai_status', handleStatus),
      wsClient.subscribe('overlay:ai_completed', handleStatus),
      wsClient.subscribe('overlay:ai_error', handleError),
    ]

    return () => unsubs.forEach((unsubscribe) => unsubscribe())
  }, [appendAiUpdate])

  // ── Shared preset creation ──────────────────────────────────────────────

  const createBlankPreset = useCallback(async (overrideName = null) => {
    const result = await createPreset({
      name: overrideName || name.trim() || 'New Design',
      description: description.trim() || 'Overlay design',
      style: 'blank',
    })
    if (!result?.success) {
      throw new Error(result?.error || 'Failed to create design')
    }
    return result.preset?.id
  }, [name, description, createPreset])

  // Generate cache key from preset and HTML content
  const getCacheKey = (targetPresetId, htmlOverride) => {
    if (!htmlOverride) return `${targetPresetId}:preset`
    // Use HTML length + first 32 chars as cheap hash to disambiguate different HTML
    const htmlSig = `${htmlOverride.length}:${htmlOverride.slice(0, 32)}`
    return `${targetPresetId}:${htmlSig}`
  }

  const refreshSectionPreviews = useCallback(async (targetPresetId, htmlOverride = null) => {
    if (!targetPresetId) return

    // Check cache first — if hit, use cached previews instead of re-rendering
    const cacheKey = getCacheKey(targetPresetId, htmlOverride)
    if (previewCache[cacheKey]) {
      setPreviewBySection(prev => ({
        ...prev,
        ...previewCache[cacheKey],
      }))
      return
    }

    setPreviewBySection((prev) => {
      const next = { ...prev }
      for (const section of SECTIONS) {
        next[section.id] = { ...(next[section.id] || {}), loading: true, error: null }
      }
      return next
    })

    const getPreviewFrameData = (sectionId) => {
      if (sectionId === 'intro') {
        return {
          section: 'intro',
          series_name: 'IMSA SportsCar Championship',
          track_name: 'Daytona International Speedway',
          session_time: '00:00:12',
          current_lap: 0,
          total_laps: 0,
          flag: 'none',
          driver_name: 'Broadcast Intro',
          position: 0,
        }
      }

      if (sectionId === 'qualifying_results') {
        return {
          section: 'qualifying_results',
          series_name: 'IMSA SportsCar Championship',
          track_name: 'Daytona International Speedway',
          session_time: 'Qualifying Complete',
          current_lap: 0,
          total_laps: 0,
          flag: 'none',
          driver_name: 'Pole: Lewis Hamilton',
          position: 1,
        }
      }

      if (sectionId === 'race_results') {
        return {
          section: 'race_results',
          series_name: 'IMSA SportsCar Championship',
          track_name: 'Daytona International Speedway',
          session_time: 'Race Complete',
          current_lap: 20,
          total_laps: 20,
          flag: 'checkered',
          driver_name: 'Winner: Lewis Hamilton',
          position: 1,
        }
      }

      return {
        section: 'race',
        series_name: 'IMSA SportsCar Championship',
        track_name: 'Daytona International Speedway',
        session_time: '01:23:45',
        current_lap: 7,
        total_laps: 20,
        flag: 'green',
        driver_name: 'Max Verstappen',
        position: 3,
      }
    }

    const fetchPreviewSet = async () => {
      const entries = await Promise.all(SECTIONS.map(async (section) => {
        const frameData = getPreviewFrameData(section.id)
        const result = htmlOverride
          ? await renderEditorPreview(targetPresetId, htmlOverride, frameData, {
            projectId: activeProject?.id ?? null,
            renderScreenshot: true,
            includeRenderedHtml: true,
          })
          : await renderPreview(targetPresetId, section.id, {
            projectId: activeProject?.id ?? null,
            renderScreenshot: true,
            includeRenderedHtml: true,
            preferHtmlContent: true,
            includeDebug: true,
            frameData,
          })

        const imageSig = result?.png_base64
          ? `${result.png_base64.length}:${result.png_base64.slice(0, 24)}`
          : null

        const debug = {
          requestedSection: section.id,
          label: section.label,
          ok: Boolean(result?.success),
          error: result?.error || null,
          elapsedMs: result?.elapsed_ms ?? null,
          responseSection: result?.debug_render?.section || null,
          renderSource: htmlOverride
            ? 'editor_preview_html_override'
            : (result?.debug_render?.render_source || null),
          htmlLength: result?.debug_render?.html_length || null,
          imageSig,
          pass: 'html_content',
          backend: result?.debug_render || null,
        }

        console.debug('[OverlayWizard][preview-debug]', debug)

        return {
          sectionId: section.id,
          result,
          debug,
        }
      }))

      return entries
    }

    const entries = await fetchPreviewSet()

    const nextState = {}
    for (const entry of entries) {
      if (entry.result?.success && entry.result?.png_base64) {
        nextState[entry.sectionId] = {
          loading: false,
          error: null,
          image: `data:image/png;base64,${entry.result.png_base64}`,
          debug: entry.debug,
        }
      } else {
        nextState[entry.sectionId] = {
          loading: false,
          error: entry.result?.error || 'Preview failed',
          image: null,
          debug: entry.debug,
        }
      }
    }

    setPreviewBySection((prev) => ({
      ...prev,
      ...nextState,
    }))

    // Cache the results for instant before/after switching
    setPreviewCache(prev => ({
      ...prev,
      [cacheKey]: nextState,
    }))
  }, [renderPreview, renderEditorPreview])

  const buildDebugReport = useCallback(() => {
    const report = {
      generatedAt: new Date().toISOString(),
      presetId,
      phase,
      focusedSection,
      singlePreviewMode,
      sections: SECTIONS.map((section) => ({
        sectionId: section.id,
        label: section.label,
        ...(previewBySection?.[section.id]?.debug || {
          missing: true,
        }),
      })),
    }

    return JSON.stringify(report, null, 2)
  }, [presetId, phase, focusedSection, singlePreviewMode, previewBySection])

  useEffect(() => {
    if (!presetId) return
    if (!aiModifyHandler.hasPendingAiChange) return

    const htmlForMode = aiModifyHandler.previewHtmlForMode
    if (!htmlForMode) return

    refreshSectionPreviews(presetId, htmlForMode)
  }, [
    presetId,
    aiModifyHandler.hasPendingAiChange,
    aiModifyHandler.showAiBefore,
    aiModifyHandler.previewHtmlForMode,
    refreshSectionPreviews,
  ])

  const handleCopyDebugReport = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildDebugReport())
      setCopyDebugStatus('Copied')
      setTimeout(() => setCopyDebugStatus(''), 1400)
    } catch {
      setCopyDebugStatus('Copy failed')
      setTimeout(() => setCopyDebugStatus(''), 1800)
    }
  }, [buildDebugReport])

  useEffect(() => {
    let cancelled = false

    const hydrateExistingPreset = async () => {
      if (!initialPresetId) return
      setPresetId(initialPresetId)
      setPhase('refine')
      setError(null)
      // Clear cache when switching designs
      setPreviewCache({})

      const html = await getHtmlContent(initialPresetId)
      if (cancelled) return

      setCurrentHtml(html || '')
      await refreshSectionPreviews(initialPresetId, html || null)
    }

    hydrateExistingPreset()
    return () => {
      cancelled = true
    }
  }, [initialPresetId, getHtmlContent, refreshSectionPreviews])

  // ── Skip to manual Build ────────────────────────────────────────────────

  const handleSkip = useCallback(async () => {
    if (!canSubmit) return
    setError(null)
    try {
      const presetId = await createBlankPreset()
      onComplete(presetId, 'build')
    } catch (err) {
      setError(err.message)
    }
  }, [canSubmit, createBlankPreset, onComplete])

  // ── Generate with AI ────────────────────────────────────────────────────

  const handleGenerate = useCallback(async () => {
    if (!canSubmit) return
    setError(null)

    // Create the blank preset first — user has something even if AI fails
    let presetId
    try {
      presetId = await createBlankPreset()
    } catch (err) {
      setError(err.message)
      return
    }

    setPhase('generating')
    const requestId = createAiRequestId()
    beginAiRequest(requestId, 'Submitting full overlay generation request')

    try {
      await apiPost('/llm/overlay/generate-full', {
        prompt: description.trim() || name.trim(),
        preset_id: presetId,
        request_id: requestId,
      }, {
        timeoutMs: 90_000,
        retries: 0,
      })

      appendAiUpdate({ stage: 'loading_html', message: 'Loading generated HTML' })
      const html = await getHtmlContent(presetId)
      setPresetId(presetId)
      setCurrentHtml(html || '')
      setPreviewCache({}) // Clear cache for new preset
      appendAiUpdate({ stage: 'refreshing_previews', message: 'Refreshing section previews' })
      await refreshSectionPreviews(presetId)
      aiModifyHandler.setPrompt(description.trim() || name.trim())
      setPhase('refine')
      clearAiRequest()
      showSuccess('Initial generation complete')
    } catch (err) {
      clearAiRequest()
      const msg = toErrorMessage(
        err,
        'AI generation failed. Your blank design has been saved — you can build it manually.',
      )
      // Revert to form so user can retry or go manual
      setPhase('form')
      setError(msg)
      showWarning('AI generation failed — blank design saved')
      // Still open the blank preset on dismiss so they aren't left with nothing
    }
  }, [canSubmit, createBlankPreset, description, name, getHtmlContent, refreshSectionPreviews, showSuccess, showWarning, toErrorMessage, createAiRequestId, beginAiRequest, appendAiUpdate, clearAiRequest, aiModifyHandler])

  const handleModify = useCallback(async () => {
    if (!aiModifyHandler.prompt.trim() || !llmAvailable) return

    setError(null)
    setPhase('applying')
    const requestVersion = ++applyRequestVersionRef.current
    const requestId = createAiRequestId()
    beginAiRequest(requestId, 'Submitting AI modification request')

    try {
      await aiModifyHandler.handleModify()
      if (requestVersion !== applyRequestVersionRef.current) return
      
      appendAiUpdate({ stage: 'refreshing_previews', message: 'Refreshing section previews' })
      await refreshSectionPreviews(presetId)
      if (requestVersion !== applyRequestVersionRef.current) return
      
      setPhase('refine')
      clearAiRequest()
    } catch (err) {
      if (requestVersion !== applyRequestVersionRef.current) return
      setPhase('refine')
      clearAiRequest()
      setError(toErrorMessage(err, 'Failed to apply AI modification'))
    }
  }, [aiModifyHandler, llmAvailable, presetId, refreshSectionPreviews, appendAiUpdate, createAiRequestId, beginAiRequest, clearAiRequest, toErrorMessage])

  const handleCancelApplying = useCallback(() => {
    if (phase !== 'applying') return
    applyRequestVersionRef.current += 1
    setPhase('refine')
    appendAiUpdate({ stage: 'canceled', message: 'Canceled pending AI modification' })
    clearAiRequest()
    showInfo('Canceled pending AI modification')
  }, [phase, showInfo, appendAiUpdate, clearAiRequest])

  const handleAcceptAiChange = useCallback(async () => {
    await aiModifyHandler.handleAccept()
    // Clear cache for this preset so we get fresh renders if the user modifies again
    setPreviewCache(prev => {
      const next = { ...prev }
      // Remove all cache entries for this preset
      for (const key in next) {
        if (key.startsWith(`${presetId}:`)) {
          delete next[key]
        }
      }
      return next
    })
  }, [aiModifyHandler, presetId])

  const handleRejectAiChange = useCallback(async () => {
    const revertedHtml = aiModifyHandler.handleReject()
    if (presetId && revertedHtml) {
      await refreshSectionPreviews(presetId, revertedHtml)
    }
  }, [aiModifyHandler, presetId, refreshSectionPreviews])

  const handleStartOver = useCallback(async () => {
    if (!presetId || !aiModifyHandler.prompt.trim() || !llmAvailable) return

    setError(null)
    setPhase('restarting')
    const requestId = createAiRequestId()
    beginAiRequest(requestId, 'Submitting restart request')
    try {
      await apiPost('/llm/overlay/generate-full', {
        prompt: aiModifyHandler.prompt.trim(),
        preset_id: presetId,
        request_id: requestId,
      }, {
        timeoutMs: 90_000,
        retries: 0,
      })

      appendAiUpdate({ stage: 'loading_html', message: 'Loading regenerated HTML' })
      const html = await getHtmlContent(presetId)
      setCurrentHtml(html || '')
      setPreviewCache({}) // Clear cache when regenerating
      appendAiUpdate({ stage: 'refreshing_previews', message: 'Refreshing section previews' })
      await refreshSectionPreviews(presetId)
      setPhase('refine')
      clearAiRequest()
      showSuccess('Restart generated')
    } catch (err) {
      setPhase('refine')
      clearAiRequest()
      setError(toErrorMessage(err, 'Failed to restart generation'))
    }
  }, [presetId, aiModifyHandler, llmAvailable, getHtmlContent, refreshSectionPreviews, showSuccess, toErrorMessage, createAiRequestId, beginAiRequest, appendAiUpdate, clearAiRequest])

  const handleComplete = useCallback(async () => {
    if (!presetId) return
    if (currentHtml) {
      await updateHtmlContent(presetId, currentHtml)
    }
    onComplete(presetId, 'build')
  }, [presetId, currentHtml, updateHtmlContent, onComplete])

  const handleNoLlmContinue = useCallback(async () => {
    if (noLlmCreating) return
    setError(null)
    setNoLlmCreating(true)
    try {
      const nextPresetId = await createBlankPreset('New Design')
      onNoLlmSeen?.()
      onComplete(nextPresetId, 'build')
    } catch (err) {
      setError(err?.message || 'Failed to create design')
      setNoLlmCreating(false)
    }
  }, [noLlmCreating, createBlankPreset, onNoLlmSeen, onComplete])

  // ── Generating state ────────────────────────────────────────────────────

  if (phase === 'generating' || phase === 'restarting') {
    const label = phase === 'generating'
      ? 'Generating your overlay'
      : phase === 'restarting'
        ? 'Restarting from prompt'
        : 'Applying AI modifications'
    const statusItems = aiUpdates.length > 0
      ? aiUpdates
      : [{ stage: 'waiting', message: 'Waiting for backend status updates...' }]

    return (
      <div className="h-full flex flex-col items-center justify-center gap-6 px-8 text-center select-none">
        <div className="relative">
          <div className="w-16 h-16 rounded-full border-2 border-accent/20 flex items-center justify-center">
            <Loader2 className="w-8 h-8 text-accent animate-spin" />
          </div>
          <div className="absolute -inset-2 rounded-full border border-accent/10 animate-pulse" />
        </div>

        <div>
          <p className="text-sm font-semibold text-text-primary">{label}&hellip;</p>
          <p className="text-xs text-text-tertiary mt-1 max-w-xs">
            {aiCurrentMessage || 'Designing all four sections: intro, qualifying, race, and results.'}
          </p>
          <p className="text-xs text-text-tertiary mt-1 max-w-xs">
            This usually takes 15&ndash;30 seconds.
          </p>
        </div>

        <div className="w-full max-w-md rounded-xl border border-border bg-bg-secondary/30 p-4 text-left">
          <p className="text-[10px] uppercase tracking-[0.2em] text-text-tertiary">Backend status</p>
          <div className="mt-3 space-y-2">
            {statusItems.slice(-4).map((item, index) => (
              <div key={`${item.stage}-${index}`} className="flex items-start gap-2 text-xs text-text-secondary">
                <div className="mt-1 h-1.5 w-1.5 rounded-full bg-accent/80" />
                <span>{item.message}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          {['intro', 'qualifying', 'race', 'results'].map((section, i) => (
            <div
              key={section}
              className="flex flex-col items-center gap-1"
              style={{ animationDelay: `${i * 150}ms` }}
            >
              <div
                className="w-2 h-2 rounded-full bg-accent/50 animate-pulse"
                style={{ animationDelay: `${i * 200}ms` }}
              />
              <span className="text-[10px] text-text-tertiary capitalize">{section}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (!initialPresetId && llmStatus === false) {
    return (
      <div className="h-full overflow-auto p-4 md:p-6">
        <div className="mx-auto flex min-h-full w-full max-w-5xl items-center justify-center">
          <div className="w-full overflow-hidden rounded-2xl border border-border bg-bg-secondary/30 shadow-[0_18px_60px_rgba(0,0,0,0.24)] backdrop-blur-sm">
            <div className="grid grid-cols-1 lg:grid-cols-[1.05fr_0.95fr]">
              <div className="relative overflow-hidden border-b border-border bg-gradient-to-br from-bg-primary via-bg-secondary/80 to-bg-secondary/40 p-6 lg:border-b-0 lg:border-r">
                <div className="absolute inset-0 opacity-60 pointer-events-none">
                  <div className="absolute -top-16 left-10 h-44 w-44 rounded-full bg-accent/10 blur-3xl" />
                  <div className="absolute bottom-0 right-0 h-40 w-40 rounded-full bg-accent/5 blur-3xl" />
                </div>

                <div className="relative space-y-5">
                  <div className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-primary/50 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.22em] text-text-tertiary">
                    <Sparkles className="h-3.5 w-3.5 text-accent" />
                    AI Designer
                  </div>

                  <div className="space-y-2">
                    <h2 className="text-2xl font-semibold text-text-primary">New Overlay Design</h2>
                    <p className="max-w-md text-sm leading-relaxed text-text-secondary">
                      AI Designer needs an LLM provider before it can generate a four-section overlay package from a prompt.
                    </p>
                  </div>

                  <div className="rounded-xl border border-border bg-bg-primary/45 p-4">
                    <p className="text-xs font-medium text-text-primary">What you can do right now</p>
                    <div className="mt-3 space-y-2 text-xs text-text-secondary">
                      <div className="rounded-lg border border-border bg-bg-secondary/30 px-3 py-2">
                        Configure your AI provider in Settings, then come back for prompt-driven full design generation.
                      </div>
                      <div className="rounded-lg border border-border bg-bg-secondary/30 px-3 py-2">
                        Continue with a blank design now and build the layout manually in the editor.
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col bg-bg-primary/35">
                <div className="flex items-center justify-between border-b border-border px-5 py-4">
                  <div>
                    <p className="text-sm font-semibold text-text-primary">Manual start</p>
                    <p className="mt-0.5 text-xxs text-text-tertiary">Open a blank design and continue in Build.</p>
                  </div>
                  <button
                    onClick={onCancel}
                    className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
                    title="Cancel"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex-1 space-y-4 p-5">
                  <div className="rounded-xl border border-border bg-bg-secondary/30 p-4">
                    <p className="text-xs text-text-secondary leading-relaxed">
                      This creates a clean blank overlay shell so you can start placing elements, HTML, and styling immediately.
                    </p>
                  </div>

                  {error && (
                    <div className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
                      {error}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between gap-3 border-t border-border bg-bg-secondary/40 px-5 py-4">
                  <button
                    onClick={onCancel}
                    className="text-xs text-text-tertiary transition-colors hover:text-text-secondary"
                  >
                    Cancel
                  </button>

                  <button
                    onClick={handleNoLlmContinue}
                    disabled={noLlmCreating}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {noLlmCreating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
                    Continue to Manual Build
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'refine' || phase === 'applying') {
    return (
      <div className="h-full min-h-0 flex flex-col">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center px-4 py-2 border-b border-border shrink-0 gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">AI Designer</h2>
            <p className="text-xxs text-text-tertiary">
              Prompt-driven changes for all sections. Exit to Build when satisfied.
            </p>
          </div>
          <div className="relative flex items-center justify-center min-w-0">
            {singlePreviewMode && (
              <button
                onClick={() => {
                  setSinglePreviewMode(false)
                  setHasExplicitFocus(false)
                }}
                className="absolute right-full mr-2 h-7 min-w-[108px] shrink-0 whitespace-nowrap inline-flex items-center justify-center gap-1 px-2.5 rounded text-[10px] leading-none uppercase tracking-wider font-medium text-text-secondary hover:text-text-primary border border-border bg-bg-secondary/40 hover:bg-bg-hover/70 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back to Grid
              </button>
            )}

            <div className="flex h-7 items-center gap-1 p-0.5 rounded border border-border bg-bg-secondary/30">
              {SECTIONS.map((section) => {
                const isActive = hasExplicitFocus && focusedSection === section.id
                return (
                  <button
                    key={section.id}
                    onClick={() => {
                      setFocusedSection(section.id)
                      setHasExplicitFocus(true)
                      setSinglePreviewMode(true)
                    }}
                    className={`h-5 inline-flex items-center px-2.5 rounded text-[10px] leading-none uppercase tracking-wider transition-colors ${
                      isActive
                        ? 'bg-accent/20 text-accent border border-accent/30'
                        : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/70 border border-transparent'
                    }`}
                    title={`Focus ${section.label}`}
                  >
                    {section.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex items-center justify-end">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowDebugOverlay(true)}
                className="h-7 inline-flex items-center px-2 rounded text-[10px] uppercase tracking-wider border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover/70 transition-colors"
                title="Open full debug report"
              >
                Debug
              </button>

              <button
                onClick={onCancel}
                className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 px-1.5 py-1.5">
          {singlePreviewMode ? (
            (() => {
              const focused = SECTIONS.find((s) => s.id === focusedSection) || SECTIONS[2]
              const card = previewBySection[focused.id] || {}
              return (
                <div className={`relative h-full min-h-0 overflow-hidden bg-black/30 transition-all ${gridSwitching ? 'ring-1 ring-inset ring-accent/40' : ''}`}>
                  {aiModifyHandler.hasPendingAiChange && (
                    <div className={`absolute top-1 right-1 z-10 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-medium border ${
                      aiModifyHandler.showAiBefore
                        ? 'border-warning/50 bg-warning/20 text-warning'
                        : 'border-accent/50 bg-accent/20 text-accent'
                    }`}>
                      {aiModifyHandler.showAiBefore ? 'Before' : 'After'}
                    </div>
                  )}

                  {card.loading ? (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Loader2 className="w-5 h-5 animate-spin text-text-tertiary" />
                    </div>
                  ) : card.image ? (
                    <img src={card.image} alt={`${focused.label} preview`} className="w-full h-full object-contain" draggable={false} />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-xs text-text-tertiary">
                      {card.error || 'No preview'}
                    </div>
                  )}

                  {card.debug && (
                    <div className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-1 text-[9px] leading-tight text-white/90 font-mono">
                      <div>req:{card.debug.requestedSection}</div>
                      <div>res:{card.debug.responseSection || 'n/a'} src:{card.debug.renderSource || 'n/a'}</div>
                      <div>img:{card.debug.imageSig || 'none'}</div>
                    </div>
                  )}
                </div>
              )
            })()
          ) : (
            <div className={`h-full min-h-0 grid grid-cols-2 grid-rows-2 gap-1.5 transition-all ${gridSwitching ? 'opacity-85' : 'opacity-100'}`}>
              {SECTIONS.map((section) => {
                const isFocused = hasExplicitFocus && focusedSection === section.id
                const card = previewBySection[section.id] || {}

                return (
                  <button
                    key={section.id}
                    onClick={() => {
                      setFocusedSection(section.id)
                      setHasExplicitFocus(true)
                      setSinglePreviewMode(true)
                    }}
                    className={`h-full min-h-0 rounded-none overflow-hidden text-left transition-colors ${
                      isFocused
                        ? 'ring-1 ring-inset ring-accent bg-accent/5'
                        : 'bg-bg-secondary/30 hover:bg-bg-hover/70'
                    }`}
                  >
                    <div className="h-full min-h-0 flex flex-col">
                      <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-text-tertiary bg-bg-primary/55">
                        {section.label}
                      </div>
                      <div className="relative flex-1 min-h-0 overflow-hidden bg-black/30">
                        {aiModifyHandler.hasPendingAiChange && (
                          <div className={`absolute top-1 right-1 z-10 rounded px-1.5 py-0.5 text-[8px] uppercase tracking-wider font-medium border ${
                            aiModifyHandler.showAiBefore
                              ? 'border-warning/50 bg-warning/20 text-warning'
                              : 'border-accent/50 bg-accent/20 text-accent'
                          }`}>
                            {aiModifyHandler.showAiBefore ? 'Before' : 'After'}
                          </div>
                        )}

                        {card.loading ? (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <Loader2 className="w-4 h-4 animate-spin text-text-tertiary" />
                          </div>
                        ) : card.image ? (
                          <img src={card.image} alt={`${section.label} preview`} className="w-full h-full object-contain" draggable={false} />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-text-tertiary">
                            {card.error || 'No preview'}
                          </div>
                        )}

                        {card.debug && (
                          <div className="absolute bottom-1 left-1 rounded bg-black/70 px-1 py-0.5 text-[8px] leading-tight text-white/90 font-mono">
                            <div>{card.debug.renderSource || 'n/a'} | {card.debug.responseSection || 'n/a'}</div>
                            <div>{card.debug.imageSig || 'none'}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="shrink-0 px-4 py-3 border-t border-border bg-bg-secondary/40 space-y-2.5">
          <div>
            <label className="block text-xxs font-medium text-text-secondary mb-1.5 uppercase tracking-wider">
              Modify Prompt
              {hasExplicitFocus && (
                <span className="ml-2 normal-case text-text-tertiary font-normal">
                  Scope: all sections (focused: {SECTIONS.find((s) => s.id === focusedSection)?.label || 'Race'})
                </span>
              )}
              {!hasExplicitFocus && (
                <span className="ml-2 normal-case text-text-tertiary font-normal">
                  Scope: all sections
                </span>
              )}
            </label>
            {phase === 'applying' ? (
              <div className="w-full bg-bg-primary border border-border rounded px-3 py-2 min-h-[82px] flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs text-text-secondary">
                    <Loader2 className="w-4 h-4 text-accent animate-spin" />
                    <span>{aiCurrentMessage || 'Applying AI modifications...'}</span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {(aiUpdates.length > 0 ? aiUpdates : [{ stage: 'waiting', message: 'Waiting for backend status updates...' }]).slice(-3).map((item, index) => (
                      <div key={`${item.stage}-${index}`} className="text-[10px] text-text-tertiary">
                        {item.message}
                      </div>
                    ))}
                  </div>
                </div>
                <button
                  onClick={handleCancelApplying}
                  className="text-xs px-3 py-1.5 rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <textarea
                value={aiModifyHandler.prompt}
                onChange={(e) => aiModifyHandler.setPrompt(e.target.value)}
                placeholder="Describe what to change. Example: tighten spacing, darken backgrounds, and use condensed headings."
                rows={3}
                className="w-full bg-bg-primary border border-border rounded px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent resize-none"
              />
            )}
          </div>

          {error && (
            <div className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          {aiModifyHandler.hasPendingAiChange && (
            <div className="rounded border border-accent/30 bg-accent/5 px-3 py-2.5 space-y-2">
              <div className="text-xs text-accent font-medium">
                AI changes ready for review
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => aiModifyHandler.setShowAiBefore(true)}
                  className={`text-[11px] px-2 py-1 rounded border transition-colors ${
                    aiModifyHandler.showAiBefore
                      ? 'border-warning/60 bg-warning/20 text-warning'
                      : 'border-border bg-bg-primary text-text-secondary hover:bg-bg-hover'
                  }`}
                >
                  Preview Before
                </button>
                <button
                  onClick={() => aiModifyHandler.setShowAiBefore(false)}
                  className={`text-[11px] px-2 py-1 rounded border transition-colors ${
                    !aiModifyHandler.showAiBefore
                      ? 'border-accent/60 bg-accent/20 text-accent'
                      : 'border-border bg-bg-primary text-text-secondary hover:bg-bg-hover'
                  }`}
                >
                  Preview After
                </button>
                <button
                  onClick={handleAcceptAiChange}
                  className="text-[11px] px-2 py-1 rounded border border-success/50 bg-success/10 text-success hover:bg-success/20 transition-colors flex items-center gap-1"
                >
                  <Check className="w-3 h-3" />
                  Accept
                </button>
                <button
                  onClick={handleRejectAiChange}
                  className="text-[11px] px-2 py-1 rounded border border-danger/50 bg-danger/10 text-danger hover:bg-danger/20 transition-colors flex items-center gap-1"
                >
                  <X className="w-3 h-3" />
                  Reject
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <button
              onClick={onCancel}
              className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
            >
              Close
            </button>

            <div className="flex items-center gap-2">
              <button
                onClick={handleStartOver}
                disabled={!aiModifyHandler.prompt.trim() || !llmAvailable || phase === 'applying'}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title={llmAvailable ? 'Regenerate full design from prompt' : 'Configure LLM in Settings to use AI actions'}
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Start Over
              </button>

              <button
                onClick={handleModify}
                disabled={!aiModifyHandler.prompt.trim() || !llmAvailable || phase === 'applying'}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title={llmAvailable ? 'Apply AI modification to current design' : 'Configure LLM in Settings to use AI actions'}
              >
                <Sparkles className="w-3.5 h-3.5" />
                {phase === 'applying' ? 'Applying...' : 'Modify'}
              </button>

              <button
                onClick={handleComplete}
                className="flex items-center gap-1.5 text-xs px-4 py-2 rounded bg-success text-white hover:opacity-90 transition-colors font-medium"
                title="Open Build tab for detailed editing"
              >
                Complete
                <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>

        {showDebugOverlay && (
          <div className="absolute inset-0 z-30 bg-black/70 flex items-center justify-center p-4">
            <div className="w-full max-w-5xl max-h-[90vh] bg-bg-primary border border-border rounded shadow-xl flex flex-col min-h-0">
              <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border">
                <div>
                  <h3 className="text-xs font-semibold text-text-primary">Preview Debug Report</h3>
                  <p className="text-[10px] text-text-tertiary">All 4 grid cells + backend debug payload</p>
                </div>

                <div className="flex items-center gap-2">
                  {copyDebugStatus && (
                    <span className="text-[10px] text-text-tertiary">{copyDebugStatus}</span>
                  )}
                  <button
                    onClick={handleCopyDebugReport}
                    className="h-7 inline-flex items-center px-2.5 rounded text-[10px] uppercase tracking-wider border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover/70 transition-colors"
                  >
                    Copy Report
                  </button>
                  <button
                    onClick={() => setShowDebugOverlay(false)}
                    className="h-7 inline-flex items-center px-2 rounded text-[10px] uppercase tracking-wider border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover/70 transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-auto p-3">
                <pre className="text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all text-text-secondary">
                  {buildDebugReport()}
                </pre>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Form state ──────────────────────────────────────────────────────────

  return (
    <div className="h-full overflow-auto p-4 md:p-6">
      <div className="mx-auto flex min-h-full w-full max-w-6xl items-center justify-center">
        <div className="w-full overflow-hidden rounded-2xl border border-border bg-bg-secondary/30 shadow-[0_18px_60px_rgba(0,0,0,0.24)] backdrop-blur-sm">
          <div className="grid grid-cols-1 xl:grid-cols-[1.05fr_0.95fr]">
            <div className="relative overflow-hidden border-b border-border bg-gradient-to-br from-bg-primary via-bg-secondary/80 to-bg-secondary/40 p-6 lg:p-7 xl:border-b-0 xl:border-r">
              <div className="absolute inset-0 opacity-70 pointer-events-none">
                <div className="absolute -top-20 left-8 h-48 w-48 rounded-full bg-accent/10 blur-3xl" />
                <div className="absolute bottom-0 right-0 h-44 w-44 rounded-full bg-accent/5 blur-3xl" />
              </div>

              <div className="relative flex h-full flex-col gap-6">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-3">
                    <div className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-primary/50 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.22em] text-text-tertiary">
                      <Sparkles className="h-3.5 w-3.5 text-accent" />
                      New Overlay Design
                    </div>
                    <div>
                      <h2 className="text-2xl font-semibold text-text-primary">Build a full broadcast package from a prompt</h2>
                      <p className="mt-2 max-w-xl text-sm leading-relaxed text-text-secondary">
                        Describe the visual direction and AI Designer will generate a coordinated starting point for intro, qualifying, race, and results.
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={onCancel}
                    className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
                    title="Cancel"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-border bg-bg-primary/45 p-4">
                    <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-text-tertiary">Coverage</p>
                    <p className="mt-2 text-sm font-medium text-text-primary">4 linked sections</p>
                    <p className="mt-1 text-xs leading-relaxed text-text-secondary">Intro, qualifying, race, and results stay visually consistent from the first pass.</p>
                  </div>
                  <div className="rounded-xl border border-border bg-bg-primary/45 p-4">
                    <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-text-tertiary">Workflow</p>
                    <p className="mt-2 text-sm font-medium text-text-primary">Generate, refine, then build</p>
                    <p className="mt-1 text-xs leading-relaxed text-text-secondary">Use AI for direction, then jump into the editor for exact spacing, HTML, and polish.</p>
                  </div>
                  <div className="rounded-xl border border-border bg-bg-primary/45 p-4">
                    <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-text-tertiary">Fallback</p>
                    <p className="mt-2 text-sm font-medium text-text-primary">Manual build always available</p>
                    <p className="mt-1 text-xs leading-relaxed text-text-secondary">Skip the generation step any time and open a blank design in the Build workspace.</p>
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-bg-primary/45 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-text-primary">Example directions</p>
                    <span className="text-[10px] uppercase tracking-[0.2em] text-text-tertiary">Click to use</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {EXAMPLE_PROMPTS.map((example) => (
                      <button
                        key={example}
                        onClick={() => setDescription(example)}
                        className={`rounded-lg border px-2.5 py-1.5 text-left text-[10px] transition-colors ${
                          description === example
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-border text-text-tertiary hover:border-border/80 hover:bg-bg-hover hover:text-text-secondary'
                        }`}
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col bg-bg-primary/35">
              <div className="border-b border-border px-5 py-4">
                <p className="text-sm font-semibold text-text-primary">Design setup</p>
                <p className="mt-0.5 text-xxs text-text-tertiary">Give the design a name, then describe the visual system you want.</p>
              </div>

              <div className="flex-1 space-y-5 p-5 lg:p-6">
                <div>
                  <label className="mb-1.5 block text-xxs font-medium uppercase tracking-wider text-text-secondary">
                    Design Name <span className="text-danger">*</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Championship 2026"
                    className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
                    autoFocus
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-xxs font-medium uppercase tracking-wider text-text-secondary">
                    Style Description
                    {llmAvailable ? (
                      <span className="ml-2 normal-case font-normal text-accent">Used by AI generation</span>
                    ) : (
                      <span className="ml-2 normal-case font-normal text-text-tertiary">AI unavailable - configure LLM in Settings</span>
                    )}
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe the visual style you want..."
                    rows={7}
                    className="w-full resize-none rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>

                <div className="rounded-xl border border-border bg-bg-secondary/30 p-4">
                  <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-text-tertiary">Generation note</p>
                  <p className="mt-2 text-xs leading-relaxed text-text-secondary">
                    Strong prompts usually mention palette, typography, density, motion feel, and where key modules should live on screen.
                  </p>
                </div>

                {error && (
                  <div className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
                    {error}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-3 border-t border-border bg-bg-secondary/40 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <button
                  onClick={onCancel}
                  className="text-left text-xs text-text-tertiary transition-colors hover:text-text-secondary"
                >
                  Cancel
                </button>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <button
                    onClick={handleSkip}
                    disabled={!canSubmit}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                    title="Create a blank design and go straight to the HTML editor"
                  >
                    <Wrench className="h-3.5 w-3.5" />
                    Skip to Manual Build
                  </button>

                  <button
                    onClick={handleGenerate}
                    disabled={!canSubmit || !llmAvailable}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                    title={llmAvailable ? 'Generate a complete overlay with AI' : 'Configure LLM in Settings to use AI generation'}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Generate with AI
                    <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
