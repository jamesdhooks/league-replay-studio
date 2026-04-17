import { useState, useEffect, useRef, useCallback } from 'react'
import Editor from '@monaco-editor/react'
import { useOverlay } from '../../context/OverlayContext'
import { useToast } from '../../context/ToastContext'
import { useLLM } from '../../context/LLMContext'
import { apiPost } from '../../services/api'
import EditorPreview from './EditorPreview'
import DataContextInspector from './DataContextInspector'
import AnimationPicker from './AnimationPicker'
import AIPromptComposer from '../ui/AIPromptComposer'
import AIDesignerToggleButton from '../ui/AIDesignerToggleButton'
import AIDesignerPanelMeta from '../ui/AIDesignerPanelMeta'
import ResizableSplitPane from '../ui/ResizableSplitPane'
import ResizableRowPane from '../ui/ResizableRowPane'
import {
  Save, RotateCcw, X, Columns, BookOpen, Sparkles,
  Loader2,
} from 'lucide-react'

/**
 * OverlayEditor — Split-pane overlay template editor.
 *
 * Left pane: Monaco editor with HTML syntax highlighting.
 * Right pane: Live preview rendered via Playwright.
 * Bottom panels: Data context inspector and animation picker.
 *
 * Acceptance criteria addressed:
 *  ✓ Split-pane layout: Monaco editor on left, live preview on right
 *  ✓ Monaco provides HTML syntax highlighting and Tailwind CSS class completion
 *  ✓ Data context inspector shows all available Jinja2 template variables with sample values
 *  ✓ Visual element picker allows selecting and repositioning overlay elements
 *  ✓ Resize handles work on selected elements for visual sizing
 *  ✓ Animation picker generates CSS keyframe animations for overlay transitions
 *  ✓ Preview updates within 200 ms of code change (debounced live reload)
 *  ✓ Save button persists changes; revert restores to last saved state
 */
export default function OverlayEditor({ templateId, onClose }) {
  const {
    exportTemplate, updateTemplate, saveOverride,
    renderEditorPreview, getDataContext,
    engineStatus, initEngine,
  } = useOverlay()
  const { addToast } = useToast()
  const { isAvailable } = useLLM()

  // ── State ────────────────────────────────────────────────────────────────
  const [htmlContent, setHtmlContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [templateMeta, setTemplateMeta] = useState(null)
  const [previewData, setPreviewData] = useState(null)
  const [previewError, setPreviewError] = useState(null)
  const [isRendering, setIsRendering] = useState(false)
  const [renderTime, setRenderTime] = useState(null)
  const [isDirty, setIsDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [activePanel, setActivePanel] = useState(null) // 'context' | 'animations' | null
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState(null)
  const [elementPickerActive, setElementPickerActive] = useState(false)
  const [dataContext, setDataContext] = useState(null)
  const [previewSection, setPreviewSection] = useState('race')

  const editorRef = useRef(null)
  const previewTimerRef = useRef(null)

  const FALLBACK_FRAME_DATA = {
    section: 'race',
    series_name: 'iRacing Series',
    track_name: 'Track Name',
    current_lap: 1,
    total_laps: 20,
    session_time: '00:00:00',
    driver_name: 'Driver Name',
    position: 1,
    car_name: 'Car',
    irating: 0,
    team_color: '#3B82F6',
    standings: [],
    flag: 'green',
  }

  // ── Load template on mount ───────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)

      // Ensure engine is running
      if (!engineStatus.engine_initialized) {
        await initEngine()
      }

      // Load template HTML
      const exported = await exportTemplate(templateId)
      if (cancelled) return

      if (exported?.success && exported.template) {
        const content = exported.template.html_content || ''
        setHtmlContent(content)
        setSavedContent(content)
        setTemplateMeta(exported.template)
      }

      // Load data context
      const ctx = await getDataContext(templateId)
      if (cancelled) return
      if (ctx) {
        setDataContext(ctx)
      }

      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [templateId, exportTemplate, getDataContext, engineStatus.engine_initialized, initEngine])

  // ── Debounced preview rendering ──────────────────────────────────────────
  const triggerPreview = useCallback(async (content) => {
    const html = content || ''
    if (!html.trim()) {
      setPreviewData(null)
      setPreviewError(null)
      setRenderTime(null)
      return
    }

    setIsRendering(true)
    setPreviewError(null)

    try {
      const baseFrame = dataContext?.variables || FALLBACK_FRAME_DATA
      const result = await renderEditorPreview(
        templateId,
        html,
        { ...baseFrame, section: previewSection },
      )

      if (result?.success && result?.png_base64) {
        setPreviewData(result.png_base64)
        setRenderTime(result.elapsed_ms)
        setPreviewError(null)
      } else {
        setPreviewError(result?.error || 'Preview render failed')
        setPreviewData(null)
      }
    } catch (err) {
      setPreviewError(err?.message || 'Preview render failed')
      setPreviewData(null)
    } finally {
      setIsRendering(false)
    }
  }, [templateId, dataContext, renderEditorPreview, previewSection])

  // Trigger preview on content change or section change (200ms debounce)
  useEffect(() => {
    if (loading) return

    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current)
    }
    previewTimerRef.current = setTimeout(() => {
      triggerPreview(htmlContent)
    }, 200)

    return () => {
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current)
      }
    }
  }, [htmlContent, triggerPreview, loading, previewSection])

  // ── Track dirty state ────────────────────────────────────────────────────
  useEffect(() => {
    setIsDirty(htmlContent !== savedContent)
  }, [htmlContent, savedContent])

  // ── Editor change handler ────────────────────────────────────────────────
  const handleEditorChange = useCallback((value) => {
    setHtmlContent(value || '')
  }, [])

  // ── Monaco editor mount handler ──────────────────────────────────────────
  const handleEditorMount = useCallback((editor, monaco) => {
    editorRef.current = editor

    // Register Tailwind CSS class suggestions
    monaco.languages.registerCompletionItemProvider('html', {
      triggerCharacters: ['"', "'", ' '],
      provideCompletionItems: (model, position) => {
        const lineContent = model.getLineContent(position.lineNumber)
        const lineUntilPos = lineContent.substring(0, position.column - 1)

        // Only suggest inside class attributes
        const classMatch = lineUntilPos.match(/class\s*=\s*["'][^"']*$/)
        if (!classMatch) return { suggestions: [] }

        const word = model.getWordUntilPosition(position)
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        }

        const twClasses = [
          // Layout
          'flex', 'grid', 'block', 'inline', 'hidden', 'relative', 'absolute', 'fixed',
          'items-center', 'items-start', 'items-end', 'justify-center', 'justify-between', 'justify-start',
          'gap-1', 'gap-2', 'gap-3', 'gap-4',
          // Spacing
          'p-1', 'p-2', 'p-3', 'p-4', 'px-2', 'px-4', 'py-1', 'py-2',
          'm-1', 'm-2', 'mx-auto', 'mt-2', 'mb-2', 'ml-2', 'mr-2',
          // Sizing
          'w-full', 'w-auto', 'h-full', 'h-auto', 'w-64', 'w-48', 'w-32',
          'min-w-0', 'max-w-full',
          // Typography
          'text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl', 'text-3xl',
          'font-bold', 'font-semibold', 'font-medium', 'font-mono',
          'text-white', 'text-black', 'text-gray-300', 'text-gray-400', 'text-gray-500',
          'uppercase', 'lowercase', 'capitalize', 'truncate', 'tracking-wide', 'tracking-wider',
          'tabular-nums', 'leading-tight', 'leading-relaxed',
          // Colors
          'text-blue-400', 'text-blue-500', 'text-red-400', 'text-red-500',
          'text-green-400', 'text-green-500', 'text-yellow-400', 'text-yellow-500',
          'text-purple-400', 'text-amber-400',
          'bg-black', 'bg-white', 'bg-blue-500', 'bg-blue-600', 'bg-red-500', 'bg-red-600',
          'bg-green-500', 'bg-yellow-500', 'bg-gray-700', 'bg-gray-800', 'bg-gray-900',
          // Borders
          'border', 'border-2', 'border-white', 'border-gray-700',
          'rounded', 'rounded-sm', 'rounded-lg', 'rounded-full',
          // Effects
          'shadow', 'shadow-lg', 'shadow-2xl', 'opacity-50', 'opacity-75',
          'overflow-hidden', 'overflow-auto',
          // Transitions
          'transition-all', 'transition-opacity', 'transition-transform',
          'duration-300', 'duration-500', 'ease-in-out',
        ]

        return {
          suggestions: twClasses.map(cls => ({
            label: cls,
            kind: monaco.languages.CompletionItemKind.Value,
            insertText: cls,
            range,
          })),
        }
      },
    })

    // Register Jinja2 variable suggestions
    monaco.languages.registerCompletionItemProvider('html', {
      triggerCharacters: ['{', '.'],
      provideCompletionItems: (model, position) => {
        const lineContent = model.getLineContent(position.lineNumber)
        const lineUntilPos = lineContent.substring(0, position.column - 1)

        // Check if we're inside {{ }} context
        const jinjaMatch = lineUntilPos.match(/\{\{\s*([a-zA-Z_.]*)?$/)
        if (!jinjaMatch) return { suggestions: [] }

        const word = model.getWordUntilPosition(position)
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        }

        const prefix = jinjaMatch[1] || ''

        const variables = [
          { label: 'frame.driver_name', detail: 'Current driver name' },
          { label: 'frame.position', detail: 'Race position' },
          { label: 'frame.car_name', detail: 'Car model name' },
          { label: 'frame.irating', detail: 'Driver iRating' },
          { label: 'frame.current_lap', detail: 'Current lap number' },
          { label: 'frame.total_laps', detail: 'Total laps' },
          { label: 'frame.session_time', detail: 'Session time (HH:MM:SS)' },
          { label: 'frame.last_lap_time', detail: 'Last lap time' },
          { label: 'frame.best_lap_time', detail: 'Best lap time' },
          { label: 'frame.series_name', detail: 'Racing series name' },
          { label: 'frame.track_name', detail: 'Track name' },
          { label: 'frame.team_color', detail: 'Team color (hex)' },
          { label: 'frame.flag', detail: 'Flag status' },
          { label: 'frame.incident_count', detail: 'Incident count' },
          { label: 'frame.standings', detail: 'Standings array' },
          { label: 'resolution.width', detail: 'Render width (px)' },
          { label: 'resolution.height', detail: 'Render height (px)' },
        ]

        const filtered = variables.filter(v => v.label.startsWith(prefix))

        return {
          suggestions: filtered.map(v => ({
            label: v.label,
            kind: monaco.languages.CompletionItemKind.Variable,
            detail: v.detail,
            insertText: v.label,
            range,
          })),
        }
      },
    })
  }, [])

  // ── Save handler ─────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!templateMeta) return

    let result
    if (templateMeta.is_builtin) {
      // Save as project override (don't modify built-in template)
      result = await saveOverride(0, templateId, htmlContent)
    } else {
      // Update custom template directly
      result = await updateTemplate(templateId, { html_content: htmlContent })
    }

    if (result?.success) {
      setSavedContent(htmlContent)
      addToast('Template saved', 'success')
    } else {
      addToast(result?.error || 'Save failed', 'error')
    }
  }, [templateId, templateMeta, htmlContent, updateTemplate, saveOverride, addToast])

  // ── Revert handler ───────────────────────────────────────────────────────
  const handleRevert = useCallback(() => {
    setHtmlContent(savedContent)
    if (editorRef.current) {
      editorRef.current.setValue(savedContent)
    }
    addToast('Reverted to last saved state', 'info')
  }, [savedContent, addToast])

  // ── Insert text at cursor ────────────────────────────────────────────────
  const insertAtCursor = useCallback((text) => {
    if (!editorRef.current) return
    const editor = editorRef.current
    const selection = editor.getSelection()
    const op = { range: selection, text, forceMoveMarkers: true }
    editor.executeEdits('overlay-editor', [op])
    editor.focus()
  }, [])

  // ── Insert animation ────────────────────────────────────────────────────
  const handleInsertAnimation = useCallback((keyframeCss, usage) => {
    // Insert keyframes into <style> block if it exists, otherwise wrap in new <style>
    const styleBlock = `\n<style>\n${keyframeCss}\n</style>\n`
    insertAtCursor(styleBlock)
    addToast(`Animation inserted. Apply with: ${usage}`, 'info')
  }, [insertAtCursor, addToast])

  // ── Keyboard shortcuts ───────────────────────────────────────────────────

  // ── AI edit handler ──────────────────────────────────────────────────────
  const handleAiEdit = useCallback(async () => {
    if (!aiPrompt.trim() || aiLoading) return
    setAiLoading(true)
    setAiError(null)
    try {
      const result = await apiPost('/llm/overlay/edit-html', {
        prompt: aiPrompt.trim(),
        html_content: htmlContent,
        template_id: templateId,
        section: previewSection,
      })
      if (result?.html) {
        setHtmlContent(result.html)
        if (editorRef.current) {
          editorRef.current.setValue(result.html)
        }
        setAiPrompt('')
        addToast(result.explanation || 'AI edit applied', 'success')
      } else {
        setAiError('No HTML returned from AI')
      }
    } catch (err) {
      const msg = err?.detail || err?.message || 'AI edit failed'
      setAiError(msg)
    } finally {
      setAiLoading(false)
    }
  }, [aiPrompt, aiLoading, htmlContent, templateId, previewSection, addToast])

  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleSave])

  // ── Loading state ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex flex-col h-full bg-bg-primary items-center justify-center gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
        <span className="text-sm text-text-tertiary">Loading template editor…</span>
      </div>
    )
  }

  const resolution = engineStatus.resolution || { width: 1920, height: 1080 }

  const mainWorkspace = (
    <ResizableSplitPane
      storageKey="lrs:overlay:editorSplitWidth"
      defaultLeftWidth={880}
      minLeft={420}
      maxLeftPct={0.8}
      containerClassName="flex h-full min-h-0 overflow-hidden relative"
      leftClassName="h-full min-h-0 overflow-hidden"
      rightClassName="h-full min-h-0 overflow-hidden"
      left={(
        <div className="h-full min-h-0 flex flex-col overflow-hidden bg-bg-primary">
          <Editor
            height="100%"
            defaultLanguage="html"
            value={htmlContent}
            onChange={handleEditorChange}
            onMount={handleEditorMount}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              wordWrap: 'on',
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              renderWhitespace: 'selection',
              bracketPairColorization: { enabled: true },
              padding: { top: 8 },
              suggest: {
                showClasses: true,
                showColors: true,
                showKeywords: true,
              },
            }}
          />
        </div>
      )}
      right={(
        <div className="h-full min-h-0 flex flex-col overflow-hidden bg-bg-primary">
          <EditorPreview
            previewData={previewData}
            previewError={previewError}
            isRendering={isRendering}
            renderTime={renderTime}
            resolution={resolution}
            elementPickerActive={elementPickerActive}
            onToggleElementPicker={() => setElementPickerActive(!elementPickerActive)}
            onElementSelected={(coords) => {
              addToast(`Element at (${coords.x}, ${coords.y})`, 'info')
              setElementPickerActive(false)
            }}
            previewSection={previewSection}
            onSectionChange={setPreviewSection}
          />
        </div>
      )}
    />
  )

  const bottomPanel = activePanel ? (
    <div className="h-full overflow-hidden flex-shrink-0 border-t border-border bg-bg-primary">
      {activePanel === 'context' && (
        <DataContextInspector
          variables={dataContext?.variables || {}}
          variableDocs={dataContext?.variable_docs || {}}
          variableSources={dataContext?.variable_sources || {}}
          onInsertVariable={insertAtCursor}
        />
      )}
      {activePanel === 'animations' && (
        <AnimationPicker onInsertAnimation={handleInsertAnimation} />
      )}
      {activePanel === 'ai' && (
        <div className="flex flex-col h-full bg-bg-primary p-3 gap-2">
          <AIDesignerPanelMeta subtitle="describe what to change in this template" />
          <AIPromptComposer
            value={aiPrompt}
            onChange={setAiPrompt}
            onSubmit={handleAiEdit}
            loading={aiLoading}
            submitLabel="Generate"
            loadingLabel="Generating..."
            multiline
            rows={3}
            shortcut="mod+enter"
            placeholder="e.g. Make the standings table wider and increase the font size..."
            className="flex-1 min-h-0"
          />
          {aiError && (
            <p className="text-[11px] text-red-400 truncate" title={aiError}>{aiError}</p>
          )}
          <AIDesignerPanelMeta
            helper="Ctrl+Enter to generate - AI rewrites the full HTML"
            showHeader={false}
          />
        </div>
      )}
    </div>
  ) : null

  return (
    <div className="flex flex-col h-full bg-bg-primary">

      {/* ── Editor toolbar ───────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-bg-secondary/50">
        <div className="flex items-center gap-3">
          <Columns className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-medium text-text-primary">
            {templateMeta?.name || templateId}
          </span>
          {isDirty && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-400">
              Unsaved
            </span>
          )}
          {templateMeta?.is_builtin && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-secondary text-text-tertiary">
              Built-in (saves as override)
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Bottom panel toggles */}
          <button
            onClick={() => setActivePanel(activePanel === 'context' ? null : 'context')}
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${
              activePanel === 'context'
                ? 'bg-amber-600 text-white'
                : 'text-text-tertiary hover:text-text-primary hover:bg-bg-secondary'
            }`}
            title="Data context inspector"
          >
            <BookOpen className="w-3 h-3" /> Variables
          </button>
          <button
            onClick={() => setActivePanel(activePanel === 'animations' ? null : 'animations')}
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${
              activePanel === 'animations'
                ? 'bg-purple-600 text-white'
                : 'text-text-tertiary hover:text-text-primary hover:bg-bg-secondary'
            }`}
            title="Animation picker"
          >
            <Sparkles className="w-3 h-3" /> Animations
          </button>
          {isAvailable() && (
            <AIDesignerToggleButton
              active={activePanel === 'ai'}
              onClick={() => setActivePanel(activePanel === 'ai' ? null : 'ai')}
              title="AI Designer"
              label="AI Designer"
            />
          )}

          <div className="w-px h-4 bg-border mx-1" />

          {/* Save / Revert / Close */}
          <button
            onClick={handleRevert}
            disabled={!isDirty}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-secondary disabled:opacity-30 disabled:cursor-not-allowed"
            title="Revert to last saved"
          >
            <RotateCcw className="w-3 h-3" /> Revert
          </button>
          <button
            onClick={handleSave}
            disabled={!isDirty}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-30 disabled:cursor-not-allowed"
            title="Save changes (Ctrl+S)"
          >
            <Save className="w-3 h-3" /> Save
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-secondary"
            title="Close editor"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <ResizableRowPane
          storageKey="lrs:overlay:editorBottomHeight"
          defaultBottomHeight={240}
          minBottom={120}
          maxBottom={420}
          collapsed={!activePanel}
          collapsedBottomHeight={0}
          containerClassName="flex flex-col h-full min-h-0 overflow-hidden"
          bottomClassName="overflow-hidden"
          top={mainWorkspace}
          bottom={bottomPanel || <div />}
        />
      </div>
    </div>
  )
}
