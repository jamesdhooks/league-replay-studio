/* global DOMParser */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import Editor from '@monaco-editor/react'
import { usePreset } from '../../context/PresetContext'
import { useOverlay } from '../../context/OverlayContext'
import { useProject } from '../../context/ProjectContext'
import { useOverlaySettings } from '../../context/OverlaySettingsContext'
import { useToast } from '../../context/ToastContext'
import { useLLM } from '../../context/LLMContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { apiPost } from '../../services/api'
import EditorPreview from './EditorPreview'
import DataContextInspector from './DataContextInspector'
import AnimationPicker from './AnimationPicker'
import AIPromptComposer from '../ui/AIPromptComposer'
import ResizableSplitPane from '../ui/ResizableSplitPane'
import PreviewPlayer from '../analysis/PreviewPlayer'
import OverlayWorkspaceTopbar from './OverlayWorkspaceTopbar'
import IracingCommandLog from '../highlights/IracingCommandLog'
import { wsClient } from '../../services/websocket'
import {
  Save, RotateCcw, BookOpen, Sparkles,
  Loader2,
  Film, Award, Flag, Monitor, Bug, RefreshCw, Eye, EyeOff, ZoomIn, ZoomOut, Maximize2, MousePointer2, Copy, ChevronRight, ChevronLeft, Bot, Terminal, AlertTriangle, History,
} from 'lucide-react'

const HTML_ELEMENT_SCAN_LIMIT = 120
const AI_HISTORY_MAX_TURNS = 80
const AI_ARCHIVED_CHAT_LIMIT = 24
const AI_INTRO_MESSAGE = {
  id: 'intro',
  role: 'assistant',
  content: 'Describe the overlay changes you want and I will update the template HTML.',
}
function toDisplayText(value, fallback = '') {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value == null) return fallback
  if (typeof value === 'object') {
    if (typeof value.error === 'string') return value.error
    if (typeof value.message === 'string') return value.message
    if (typeof value.timeout !== 'undefined') return `Timeout: ${value.timeout}`
    try {
      return JSON.stringify(value)
    } catch {
      return fallback
    }
  }
  return String(value)
}

function normalizeAiConversationEntry(entry, idx = 0) {
  const touchedSections = Array.isArray(entry?.touchedSections)
    ? entry.touchedSections
      .map((section) => toDisplayText(section, '').trim())
      .filter(Boolean)
    : []

  return {
    ...entry,
    id: toDisplayText(entry?.id, `msg-${Date.now()}-${idx}`),
    role: entry?.role === 'user' ? 'user' : 'assistant',
    content: toDisplayText(entry?.content, ''),
    section: toDisplayText(entry?.section, ''),
    scopeMode: toDisplayText(entry?.scopeMode, ''),
    changeSummary: toDisplayText(entry?.changeSummary, ''),
    diffPreview: toDisplayText(entry?.diffPreview, ''),
    touchedSections,
    hasDiff: Boolean(entry?.hasDiff),
    createdAt: Number(entry?.createdAt) || Date.now(),
  }
}

function formatAiErrorMessage(err) {
  const raw = err?.detail ?? err?.message ?? err
  if (typeof raw === 'string') return raw
  if (raw == null) return 'AI edit failed'
  if (typeof raw === 'object') {
    if (typeof raw.error === 'string') return raw.error
    if (typeof raw.message === 'string') return raw.message
    if (typeof raw.timeout !== 'undefined') return 'AI edit timed out. Please try again.'
    try {
      return JSON.stringify(raw)
    } catch {
      return 'AI edit failed'
    }
  }
  return String(raw)
}

function createDiffPreview(beforeText = '', afterText = '', maxLines = 80) {
  const beforeLines = String(beforeText || '').split('\n')
  const afterLines = String(afterText || '').split('\n')
  const max = Math.max(beforeLines.length, afterLines.length)
  const rows = []
  for (let i = 0; i < max; i += 1) {
    const b = beforeLines[i] ?? ''
    const a = afterLines[i] ?? ''
    if (b === a) continue
    if (b) rows.push(`- ${i + 1}: ${b}`)
    if (a) rows.push(`+ ${i + 1}: ${a}`)
    if (rows.length >= maxLines) break
  }
  if (rows.length === 0) return 'No textual changes detected.'
  return rows.slice(0, maxLines).join('\n')
}

function buildDiffChunks(beforeText = '', afterText = '') {
  const beforeLines = String(beforeText || '').split('\n')
  const afterLines = String(afterText || '').split('\n')
  const max = Math.max(beforeLines.length, afterLines.length)
  const chunks = []
  let i = 0
  let seq = 1

  while (i < max) {
    const beforeLine = beforeLines[i] ?? null
    const afterLine = afterLines[i] ?? null
    if (beforeLine === afterLine) {
      i += 1
      continue
    }

    const start = i
    const chunkBefore = []
    const chunkAfter = []
    while (i < max && (beforeLines[i] ?? null) !== (afterLines[i] ?? null)) {
      if (i < beforeLines.length) chunkBefore.push(beforeLines[i])
      if (i < afterLines.length) chunkAfter.push(afterLines[i])
      i += 1
    }

    chunks.push({
      id: `chunk-${seq++}`,
      start,
      beforeLines: chunkBefore,
      afterLines: chunkAfter,
      active: true,
    })
  }

  return chunks
}

function composeHtmlFromChunks(baseHtml = '', chunks = []) {
  const result = String(baseHtml || '').split('\n')
  let offset = 0
  const ordered = [...chunks].sort((a, b) => a.start - b.start)

  ordered.forEach((chunk) => {
    if (!chunk?.active) return
    const beforeCount = Array.isArray(chunk.beforeLines) ? chunk.beforeLines.length : 0
    const afterLines = Array.isArray(chunk.afterLines) ? chunk.afterLines : []
    const start = Math.max(0, Number(chunk.start || 0) + offset)
    result.splice(start, beforeCount, ...afterLines)
    offset += afterLines.length - beforeCount
  })

  return result.join('\n')
}

function sanitizePreviewHtmlForInlineRender(html, renderWidth = 1920, renderHeight = 1080) {
  if (!html || typeof html !== 'string') return ''

  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')

    doc.querySelectorAll('iframe,object,embed,frame,frameset,base,meta[http-equiv="refresh"]').forEach((n) => n.remove())

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

    doc.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase()
        if (name.startsWith('on')) {
          el.removeAttribute(attr.name)
          return
        }
        if ((name === 'src' || name === 'href' || name === 'xlink:href') && /^\s*javascript:/i.test(attr.value)) {
          el.removeAttribute(attr.name)
        }
      })
    })

    const safeW = Math.max(1, Number(renderWidth) || 1920)
    const safeH = Math.max(1, Number(renderHeight) || 1080)
    const baseStyle = doc.createElement('style')
    baseStyle.id = 'lrs-iframe-base'
    baseStyle.textContent = `:root,html,body{margin:0;padding:0;width:${safeW}px;height:${safeH}px;background:transparent!important;background-color:transparent!important;overflow:hidden;}body>*{box-sizing:border-box;}`
    doc.head.prepend(baseStyle)

    return '<!DOCTYPE html>' + doc.documentElement.outerHTML
  } catch {
    return ''
  }
}

function buildHtmlElementIndex(html = '') {
  if (!html || typeof html !== 'string') return []

  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    const all = Array.from(doc.body?.querySelectorAll('*') || [])
    const filtered = all
      .filter((node) => !['script', 'style', 'meta', 'link', 'head', 'html', 'body'].includes(node.tagName.toLowerCase()))
      .slice(0, HTML_ELEMENT_SCAN_LIMIT)

    const classCounts = new Map()
    return filtered.map((node, idx) => {
      const tag = node.tagName.toLowerCase()
      const id = (node.getAttribute('id') || '').trim()
      const classAttr = (node.getAttribute('class') || '').trim()
      const firstClass = classAttr ? classAttr.split(/\s+/).find(Boolean) || '' : ''
      const keyBase = id ? `#${id}` : firstClass ? `.${firstClass}` : `${tag}-${idx + 1}`
      const nextCount = (classCounts.get(keyBase) || 0) + 1
      classCounts.set(keyBase, nextCount)
      const key = nextCount > 1 ? `${keyBase}-${nextCount}` : keyBase
      const label = id ? `${tag}#${id}` : firstClass ? `${tag}.${firstClass}` : `${tag} (${idx + 1})`
      const searchTerm = id
        ? `id="${id}"`
        : classAttr
          ? `class="${classAttr}`
          : `<${tag}`
      const selector = id
        ? `#${id.replace(/"/g, '\\"')}`
        : firstClass
          ? `.${firstClass.replace(/"/g, '\\"')}`
          : tag

      return { key, label, selector, searchTerm }
    })
  } catch {
    return []
  }
}

/**
 * OverlayEditor — Split-pane overlay template editor.
 *
 * Left pane: Monaco editor with HTML syntax highlighting.
 * Right pane: Live preview rendered via Playwright.
 * Collapsible right sidebar: Data context inspector, animation picker, AI designer.
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
export default function OverlayEditor({ designId }) {
  const {
    getHtmlRecord, updateHtmlContent,
    listRevisions, restoreRevision,
    renderEditorPreview, getDataContext,
    selectedPreset,
    activeSection,
    setActiveSection,
  } = usePreset()
  const { engineStatus, initEngine } = useOverlay()
  const { activeProject } = useProject()
  const {
    previewRenderMode,
    setPreviewRenderMode,
    overlayVisible,
    setOverlayVisible,
    previewZoom,
    setPreviewZoom,
    showLiveStreamUnderlay,
    setShowLiveStreamUnderlay,
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
  const { isAvailable } = useLLM()

  // ── State ────────────────────────────────────────────────────────────────
  const [htmlContent, setHtmlContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [savedSha256, setSavedSha256] = useState('')
  const [designMeta, setDesignMeta] = useState(null)
  const [previewData, setPreviewData] = useState(null)
  const [previewHtml, setPreviewHtml] = useState(null)
  const [previewResolution, setPreviewResolution] = useState({ width: 1920, height: 1080 })
  const [previewError, setPreviewError] = useState(null)
  const [isRendering, setIsRendering] = useState(false)
  const [renderTime, setRenderTime] = useState(null)
  const [isDirty, setIsDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [rightSidebarActiveTab, setRightSidebarActiveTab] = useLocalStorage('lrs:overlay:editorRightSidebarTab', 'context')
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useLocalStorage('lrs:overlay:editorRightSidebarCollapsed', false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState(null)
  const [aiScopeMode, setAiScopeMode] = useState('section') // section | all_sections
  const [aiOpenDiffId, setAiOpenDiffId] = useState(null)
  const [aiConversation, setAiConversation] = useLocalStorage(`lrs:overlay:build:aiHistory:${designId}`, [AI_INTRO_MESSAGE])
  const [aiArchivedChats, setAiArchivedChats] = useLocalStorage(`lrs:overlay:build:aiArchivedHistory:${designId}`, [])
  const [aiSelectedArchiveId, setAiSelectedArchiveId] = useState('')
  const [aiActiveTurnId, setAiActiveTurnId] = useState(null)
  const [aiPreviewMode, setAiPreviewMode] = useState('after') // before | after
  const [aiShowDetails, setAiShowDetails] = useState(false)
  const [elementPickerActive, setElementPickerActive] = useState(false)
  const [dataContext, setDataContext] = useState(null)
  const [previewHighlightSelector, setPreviewHighlightSelector] = useState(null)
  const [previewHighlightNonce, setPreviewHighlightNonce] = useState(0)
  const previewSection = activeSection
  const setPreviewSection = setActiveSection
  const [commandFeedCount, setCommandFeedCount] = useState(0)
  const [lastCommandLabel, setLastCommandLabel] = useState(null)
  const [rightSidebarWidth, setRightSidebarWidth] = useLocalStorage('lrs:overlay:editorRightSidebarWidth', 380)
  const [isRightSidebarDragging, setIsRightSidebarDragging] = useState(false)
  const [revisions, setRevisions] = useState([])
  const [revisionsLoading, setRevisionsLoading] = useState(false)
  const [externalConflict, setExternalConflict] = useState(null)
  const [externalDiffPreview, setExternalDiffPreview] = useState('')

  const editorRef = useRef(null)
  const previewTimerRef = useRef(null)
  const aiSnapshotsRef = useRef({})
  const aiConversationRef = useRef(null)
  const isDirtyRef = useRef(false)

  const htmlElementIndex = useMemo(() => buildHtmlElementIndex(htmlContent), [htmlContent])

  const appendAiConversation = useCallback((entry) => {
    setAiConversation((prev) => {
      const safeEntry = normalizeAiConversationEntry(entry)
      const next = [...(Array.isArray(prev) ? prev : []), safeEntry]
      return next.slice(-AI_HISTORY_MAX_TURNS)
    })
  }, [setAiConversation])

  useEffect(() => {
    setAiConversation((prev) => {
      if (!Array.isArray(prev)) {
        return [AI_INTRO_MESSAGE]
      }
      return prev.slice(-AI_HISTORY_MAX_TURNS).map((entry, idx) => normalizeAiConversationEntry(entry, idx))
    })
  }, [setAiConversation, designId])

  useEffect(() => {
    const container = aiConversationRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [aiConversation, aiLoading])
  const handleRightSidebarDragStart = useCallback((e) => {
    e.preventDefault()
    setIsRightSidebarDragging(true)

    const startX = e.clientX
    const startWidth = rightSidebarWidth

    const onMove = (moveEvt) => {
      const nextWidth = startWidth - (moveEvt.clientX - startX)
      setRightSidebarWidth(Math.min(640, Math.max(280, nextWidth)))
    }

    const onUp = () => {
      setIsRightSidebarDragging(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [rightSidebarWidth, setRightSidebarWidth])

  useEffect(() => {
    const unsub = wsClient.subscribe('iracing:command', (data) => {
      setCommandFeedCount((prev) => prev + 1)
      setLastCommandLabel(data?.command || null)
    })
    return unsub
  }, [])

  const refreshRevisions = useCallback(async () => {
    if (!designId) return
    setRevisionsLoading(true)
    try {
      const result = await listRevisions(designId)
      setRevisions(Array.isArray(result?.revisions) ? result.revisions : [])
    } finally {
      setRevisionsLoading(false)
    }
  }, [designId, listRevisions])

  const applyHtmlRecordToEditor = useCallback((record) => {
    if (record?.html_content == null) return
    setHtmlContent(record.html_content)
    setSavedContent(record.html_content)
    setSavedSha256(record.sha256 || '')
    setExternalConflict(null)
    setExternalDiffPreview('')
    if (editorRef.current) {
      editorRef.current.setValue(record.html_content)
    }
  }, [])

  useEffect(() => {
    const unsub = wsClient.subscribe('overlay:template_updated', async (data) => {
      if (!data || data.preset_id !== designId || data.source !== 'mcp') return

      if (isDirtyRef.current) {
        setExternalConflict(data)
        setExternalDiffPreview('')
        addToast('Codex updated this overlay. Your unsaved edits are still in the editor.', 'warning')
        return
      }

      const record = await getHtmlRecord(designId)
      if (record?.html_content != null) {
        applyHtmlRecordToEditor(record)
        refreshRevisions()
        addToast('Codex overlay update loaded', 'success')
      }
    })
    return unsub
  }, [addToast, applyHtmlRecordToEditor, designId, getHtmlRecord, refreshRevisions])

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

  // ── Load design HTML on mount ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)

      // Ensure engine is running
      if (!engineStatus.engine_initialized) {
        await initEngine()
      }

      // Load design HTML content
      const htmlRecord = await getHtmlRecord(designId)
      if (cancelled) return

      if (htmlRecord?.html_content != null) {
        setHtmlContent(htmlRecord.html_content)
        setSavedContent(htmlRecord.html_content)
        setSavedSha256(htmlRecord.sha256 || '')
        setDesignMeta(selectedPreset)
      }

      // Load data context
      const ctx = await getDataContext(designId, { projectId: activeProject?.id ?? null })
      if (cancelled) return
      if (ctx) {
        setDataContext(ctx)
      }

      setLoading(false)
      refreshRevisions()
    }

    load()
    return () => { cancelled = true }
  }, [activeProject?.id, designId, getHtmlRecord, getDataContext, engineStatus.engine_initialized, initEngine, selectedPreset, refreshRevisions])

  useEffect(() => {
    aiSnapshotsRef.current = {}
    setAiOpenDiffId(null)
    setAiActiveTurnId(null)
    setAiPreviewMode('after')
    setAiShowDetails(false)
    setAiSelectedArchiveId('')
  }, [designId])

  const archiveCurrentChat = useCallback(() => {
    const normalized = Array.isArray(aiConversation)
      ? aiConversation.map((entry, idx) => normalizeAiConversationEntry(entry, idx))
      : []
    const meaningful = normalized.filter((msg) => msg.id !== 'intro')
    if (meaningful.length === 0) return

    const firstUserPrompt = meaningful.find((msg) => msg.role === 'user')?.content || ''
    const firstUserTurn = meaningful.find((msg) => msg.role === 'user')
    const lastTurnWithScope = [...meaningful].reverse().find((msg) => msg.scopeMode)
    const title = toDisplayText(firstUserPrompt, 'AI chat').trim() || 'AI chat'
    const truncatedTitle = title.length > 64 ? `${title.slice(0, 64)}...` : title
    const chatId = `chat-${Date.now()}`
    const turnCount = meaningful.filter((msg) => msg.role === 'user').length
    const section = toDisplayText(firstUserTurn?.section, previewSection || 'race') || 'race'
    const scopeMode = toDisplayText(lastTurnWithScope?.scopeMode, aiScopeMode || 'section') || 'section'

    setAiArchivedChats((prev) => {
      const next = [{
        id: chatId,
        title: truncatedTitle,
        createdAt: Date.now(),
        section,
        scopeMode,
        turnCount,
        messages: normalized,
      }, ...(Array.isArray(prev) ? prev : [])]
      return next.slice(0, AI_ARCHIVED_CHAT_LIMIT)
    })
  }, [aiConversation, setAiArchivedChats, previewSection, aiScopeMode])

  const handleStartNewAiChat = useCallback(() => {
    archiveCurrentChat()
    setAiConversation([AI_INTRO_MESSAGE])
    aiSnapshotsRef.current = {}
    setAiOpenDiffId(null)
    setAiActiveTurnId(null)
    setAiPreviewMode('after')
    setAiShowDetails(false)
    setAiSelectedArchiveId('')
    setAiError(null)
    addToast('Started a new AI chat', 'info')
  }, [addToast, archiveCurrentChat, setAiConversation])

  const handleLoadArchivedChat = useCallback((chatId) => {
    setAiSelectedArchiveId(chatId)
    if (!chatId) return
    const source = (Array.isArray(aiArchivedChats) ? aiArchivedChats : []).find((chat) => chat.id === chatId)
    if (!source || !Array.isArray(source.messages)) return

    const normalized = source.messages.map((entry, idx) => normalizeAiConversationEntry(entry, idx))
    setAiConversation(normalized.length > 0 ? normalized : [AI_INTRO_MESSAGE])
    aiSnapshotsRef.current = {}
    setAiOpenDiffId(null)
    setAiActiveTurnId(null)
    setAiPreviewMode('after')
    setAiShowDetails(false)
    setAiError(null)
    addToast(`Loaded chat: ${source.title || 'AI chat'}`, 'info')
  }, [addToast, aiArchivedChats, setAiConversation])

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
        designId,
        html,
        { ...baseFrame, section: previewSection },
        {
          projectId: activeProject?.id ?? null,
          includeRenderedHtml: previewRenderMode === 'html',
          renderScreenshot: previewRenderMode !== 'html',
        },
      )

      const renderWidth = Number(result?.width) || 1920
      const renderHeight = Number(result?.height) || 1080
      setPreviewResolution({ width: renderWidth, height: renderHeight })

      if (result?.success && previewRenderMode === 'html' && result?.rendered_html) {
        const safeHtml = sanitizePreviewHtmlForInlineRender(result.rendered_html, renderWidth, renderHeight)
        if (safeHtml) {
          setPreviewHtml(safeHtml)
          setPreviewData(null)
          setRenderTime(result.elapsed_ms)
          setPreviewError(null)
        } else {
          setPreviewHtml(null)
          setPreviewData(null)
          setPreviewError('HTML preview was blocked by safeguards')
        }
      } else if (result?.success && previewRenderMode !== 'html' && result?.png_base64) {
        setPreviewData(result.png_base64)
        setPreviewHtml(null)
        setRenderTime(result.elapsed_ms)
        setPreviewError(null)
      } else {
        setPreviewHtml(null)
        setPreviewData(null)
        setPreviewError(result?.error || 'Preview render failed')
      }
    } catch (err) {
      setPreviewHtml(null)
      setPreviewError(err?.message || 'Preview render failed')
      setPreviewData(null)
    } finally {
      setIsRendering(false)
    }
  }, [designId, dataContext, previewRenderMode, renderEditorPreview, previewSection])

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
  }, [htmlContent, triggerPreview, loading, previewSection, previewRenderMode])

  // ── Track dirty state ────────────────────────────────────────────────────
  useEffect(() => {
    const dirty = htmlContent !== savedContent
    setIsDirty(dirty)
    isDirtyRef.current = dirty
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
    if (!designMeta) return

    const result = await updateHtmlContent(designId, htmlContent, {
      expectedSha256: savedSha256 || null,
      source: 'ui',
      author: 'user',
      summary: 'Build editor save',
    })

    if (result?.success) {
      setSavedContent(htmlContent)
      setSavedSha256(result.sha256 || '')
      setExternalConflict(null)
      setExternalDiffPreview('')
      refreshRevisions()
      if (aiActiveTurnId && aiSnapshotsRef.current[aiActiveTurnId]) {
        setAiActiveTurnId(null)
        setAiPreviewMode('after')
        addToast('AI preview accepted and design saved', 'success')
      } else {
        addToast('Design saved', 'success')
      }
    } else {
      const staleMessage = result?.status === 409
        ? 'Save blocked because the overlay changed externally. Review the conflict before saving.'
        : (result?.error || 'Save failed')
      addToast(staleMessage, 'error')
    }
  }, [designId, designMeta, htmlContent, savedSha256, updateHtmlContent, addToast, aiActiveTurnId, refreshRevisions])

  // ── Revert handler ───────────────────────────────────────────────────────
  const handleRevert = useCallback(() => {
    setHtmlContent(savedContent)
    if (editorRef.current) {
      editorRef.current.setValue(savedContent)
    }
    addToast('Reverted to last saved state', 'info')
  }, [savedContent, addToast])

  const handleReloadExternalUpdate = useCallback(async () => {
    const record = await getHtmlRecord(designId)
    if (record?.html_content != null) {
      applyHtmlRecordToEditor(record)
      refreshRevisions()
      addToast('Loaded external overlay update', 'success')
    }
  }, [addToast, applyHtmlRecordToEditor, designId, getHtmlRecord, refreshRevisions])

  const handleKeepLocalEdits = useCallback(() => {
    setExternalConflict(null)
    setExternalDiffPreview('')
    addToast('Keeping local editor changes', 'info')
  }, [addToast])

  const handleCompareExternalUpdate = useCallback(async () => {
    const record = await getHtmlRecord(designId)
    if (record?.html_content == null) return
    setExternalDiffPreview(createDiffPreview(htmlContent, record.html_content, 80))
  }, [designId, getHtmlRecord, htmlContent])

  const handleRestoreRevision = useCallback(async (revision) => {
    if (!revision?.revision_id) return
    const result = await restoreRevision(designId, revision.revision_id, {
      expectedSha256: savedSha256 || null,
      source: 'ui',
      author: 'user',
      summary: `Restore ${revision.revision_id}`,
    })
    if (!result?.success) {
      addToast(result?.status === 409 ? 'Restore blocked because the overlay changed externally.' : (result?.error || 'Restore failed'), 'error')
      return
    }
    const record = await getHtmlRecord(designId)
    if (record?.html_content != null) {
      applyHtmlRecordToEditor(record)
    }
    refreshRevisions()
    addToast('Revision restored', 'success')
  }, [addToast, applyHtmlRecordToEditor, designId, getHtmlRecord, refreshRevisions, restoreRevision, savedSha256])

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

  const handleFocusHtmlElement = useCallback((item) => {
    if (!item || !editorRef.current) return
    const editor = editorRef.current
    const model = editor.getModel()
    if (!model) return

    const matches = model.findMatches(item.searchTerm, true, false, false, null, true)
    if (matches.length > 0) {
      const range = matches[0].range
      editor.revealLineInCenter(range.startLineNumber)
      editor.setSelection(range)
      editor.focus()
    }

    setPreviewHighlightSelector(item.selector)
    setPreviewHighlightNonce((prev) => prev + 1)
    if (previewRenderMode !== 'html') {
      addToast('Element highlight is available in HTML mode.', 'info')
    }
  }, [addToast, previewRenderMode])

  const handleSetAiPreviewMode = useCallback((turnId, mode) => {
    if (!turnId) return
    const snapshot = aiSnapshotsRef.current[turnId]
    if (!snapshot?.previousHtml) return

    if (mode === 'before') {
      setHtmlContent(snapshot.previousHtml)
      if (editorRef.current) {
        editorRef.current.setValue(snapshot.previousHtml)
      }
      setAiActiveTurnId(turnId)
      setAiPreviewMode('before')
      return
    }

    const afterHtml = composeHtmlFromChunks(snapshot.previousHtml, snapshot.chunks)
    setHtmlContent(afterHtml)
    if (editorRef.current) {
      editorRef.current.setValue(afterHtml)
    }
    setAiActiveTurnId(turnId)
    setAiPreviewMode('after')
  }, [])

  const handleRevertAiTurn = useCallback((entry) => {
    const turnId = entry?.id || aiActiveTurnId
    if (!turnId) return
    const snapshot = aiSnapshotsRef.current[turnId]
    if (!snapshot?.previousHtml) return
    setHtmlContent(snapshot.previousHtml)
    if (editorRef.current) {
      editorRef.current.setValue(snapshot.previousHtml)
    }
    setAiActiveTurnId(null)
    setAiPreviewMode('after')
    addToast('Reverted latest AI change', 'success')
  }, [addToast, aiActiveTurnId])

  const handleFocusTouchedSection = useCallback((section) => {
    if (!section || section === previewSection) return
    setPreviewSection(section)
    addToast(`Switched to ${section}`, 'info')
  }, [addToast, previewSection, setPreviewSection])

  const handleSetChunkActive = useCallback((turnId, chunkId, active) => {
    if (!turnId || !chunkId) return
    const snapshot = aiSnapshotsRef.current[turnId]
    if (!snapshot?.previousHtml || !Array.isArray(snapshot.chunks)) return

    snapshot.chunks = snapshot.chunks.map((chunk) => (
      chunk.id === chunkId ? { ...chunk, active } : chunk
    ))

    if (aiActiveTurnId === turnId) {
      if (aiPreviewMode === 'before') {
        setHtmlContent(snapshot.previousHtml)
        if (editorRef.current) {
          editorRef.current.setValue(snapshot.previousHtml)
        }
        return
      }
      const recomposed = composeHtmlFromChunks(snapshot.previousHtml, snapshot.chunks)
      setHtmlContent(recomposed)
      if (editorRef.current) {
        editorRef.current.setValue(recomposed)
      }
    }
  }, [aiActiveTurnId, aiPreviewMode])

  // ── AI edit handler ──────────────────────────────────────────────────────
  const handleAiEdit = useCallback(async () => {
    if (!aiPrompt.trim() || aiLoading) return
    const userPrompt = aiPrompt.trim()
    const requestId = `ai-${Date.now()}`
    const previousHtml = htmlContent

    setAiLoading(true)
    setAiError(null)
    setAiSelectedArchiveId('')
    appendAiConversation({
      id: `${requestId}-user`,
      role: 'user',
      content: userPrompt,
      section: previewSection,
      scopeMode: aiScopeMode,
      createdAt: Date.now(),
    })

    try {
      const result = await apiPost('/llm/overlay/edit-html', {
        prompt: userPrompt,
        html_content: htmlContent,
        template_id: designId,
        section: previewSection,
        scope_mode: aiScopeMode,
        workspace_path: 'build',
      }, {
        timeoutMs: 120000,
        retries: 0,
      })

      if (result?.html) {
        const nextHtml = result.html
        const touchedSections = Array.isArray(result?.touched_sections)
          ? result.touched_sections
          : [previewSection]
        setHtmlContent(nextHtml)
        if (editorRef.current) {
          editorRef.current.setValue(nextHtml)
        }
        setAiPrompt('')

        const explanation = result.explanation || 'Applied AI changes to preview. Save to keep them.'
        const assistantId = `${requestId}-assistant`
        aiSnapshotsRef.current[assistantId] = {
          previousHtml,
          nextHtml,
          chunks: buildDiffChunks(previousHtml, nextHtml),
        }
        appendAiConversation({
          id: assistantId,
          role: 'assistant',
          content: explanation,
          section: previewSection,
          scopeMode: aiScopeMode,
          touchedSections,
          diffPreview: createDiffPreview(previousHtml, nextHtml),
          changeSummary: result?.change_summary || '',
          hasDiff: true,
          createdAt: Date.now(),
        })
        setAiActiveTurnId(assistantId)
        setAiPreviewMode('after')
        setAiOpenDiffId(assistantId)
        setAiShowDetails(false)
        addToast('AI update applied. Save to commit or Revert to undo.', 'success')
      } else {
        setAiError('No HTML returned from AI')
        appendAiConversation({
          id: `${requestId}-assistant-error`,
          role: 'assistant',
          content: 'I could not generate updated HTML for that request.',
          section: previewSection,
          scopeMode: aiScopeMode,
          createdAt: Date.now(),
        })
      }
    } catch (err) {
      const msg = formatAiErrorMessage(err)
      setAiError(msg)
      appendAiConversation({
        id: `${requestId}-assistant-error`,
        role: 'assistant',
        content: msg,
        section: previewSection,
        scopeMode: aiScopeMode,
        createdAt: Date.now(),
      })
    } finally {
      setAiLoading(false)
    }
  }, [aiPrompt, aiLoading, htmlContent, designId, previewSection, aiScopeMode, addToast, appendAiConversation])

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

  const resolution = previewResolution?.width > 0 && previewResolution?.height > 0
    ? previewResolution
    : (engineStatus.resolution || { width: 1920, height: 1080 })
  const safePreviewError = toDisplayText(previewError, '')

  const handleCopyDebugPanel = useCallback(async () => {
    const baseFrame = dataContext?.variables || FALLBACK_FRAME_DATA
    const payload = {
      panel: 'build-debug',
      designId,
      section: previewSection,
      render: {
        isRendering,
        ms: renderTime,
        error: previewError,
        mode: previewRenderMode,
      },
      frameSummary: {
        driver_name: baseFrame.driver_name ?? null,
        position: baseFrame.position ?? null,
        current_lap: baseFrame.current_lap ?? 0,
        flag: baseFrame.flag ?? '',
        standings_count: Array.isArray(baseFrame.standings) ? baseFrame.standings.length : 0,
        session_time: baseFrame.session_time ?? '',
        dataSource: dataContext?.variables ? 'editor-context' : 'fallback',
      },
      visibility: {
        overlayVisible,
        streamUnderlay: showLiveStreamUnderlay,
      },
      commands: {
        count: commandFeedCount,
        lastLabel: lastCommandLabel,
      },
      ai: {
        scopeMode: aiScopeMode,
      },
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      showSuccess('Build debug copied')
    } catch {
      showError('Failed to copy build debug')
    }
  }, [aiScopeMode, commandFeedCount, dataContext?.variables, designId, isRendering, lastCommandLabel, overlayVisible, previewError, previewRenderMode, previewSection, renderTime, showError, showLiveStreamUnderlay, showSuccess])

  // ── Loading state ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex flex-col h-full bg-bg-primary items-center justify-center gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
        <span className="text-sm text-text-tertiary">Loading design editor…</span>
      </div>
    )
  }

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
          {externalConflict && (
            <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold text-amber-200">External overlay update available</div>
                  <div className="truncate text-[10px] text-amber-100/80">
                    {toDisplayText(externalConflict.summary, 'Codex edited this design')} · {toDisplayText(externalConflict.sha256, '').slice(0, 10)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={handleReloadExternalUpdate}
                    className="rounded border border-amber-400/40 bg-amber-500/15 px-2 py-1 text-[10px] font-medium text-amber-100 hover:bg-amber-500/25"
                  >
                    Reload
                  </button>
                  <button
                    type="button"
                    onClick={handleKeepLocalEdits}
                    className="rounded border border-border px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  >
                    Keep Mine
                  </button>
                  <button
                    type="button"
                    onClick={handleCompareExternalUpdate}
                    className="rounded border border-border px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  >
                    Compare
                  </button>
                </div>
              </div>
              {externalDiffPreview && (
                <pre className="mt-2 max-h-32 overflow-auto rounded border border-amber-500/20 bg-black/40 p-2 text-[10px] leading-4 text-amber-100 whitespace-pre-wrap">
                  {externalDiffPreview}
                </pre>
              )}
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-hidden">
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
          <div className="shrink-0 border-t border-border bg-bg-secondary/40 px-2 py-1.5">
            <div className="mb-1 flex items-center justify-between text-[10px] text-text-tertiary">
              <span className="uppercase tracking-wide">View Elements</span>
              <span>{htmlElementIndex.length}</span>
            </div>
            <div className="flex max-h-20 flex-wrap gap-1 overflow-y-auto pr-1">
              {htmlElementIndex.length > 0 ? htmlElementIndex.map((item) => (
                <button
                  key={item.key}
                  onClick={() => handleFocusHtmlElement(item)}
                  className="rounded border border-border bg-bg-primary px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                  title={`Focus ${item.label}`}
                >
                  {item.label}
                </button>
              )) : (
                <span className="text-[10px] text-text-disabled">No detectable elements in the current markup.</span>
              )}
            </div>
          </div>
        </div>
      )}
      right={(
        <div className="h-full min-h-0 flex flex-col overflow-hidden bg-bg-primary relative">
          {activeProject && !activeProject.subsession_id && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-900/70 border border-amber-600/40 text-amber-300 text-[10px] pointer-events-none">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              No iRacing session linked — showing sample data
            </div>
          )}
          {showLiveStreamUnderlay && (
            <div className="absolute inset-0 z-0">
              <PreviewPlayer className="w-full h-full object-contain" />
            </div>
          )}
          <div className={showLiveStreamUnderlay ? 'relative z-10 h-full' : 'h-full'}>
            <EditorPreview
              previewData={previewData}
              previewHtml={previewHtml}
              previewError={safePreviewError}
              isRendering={isRendering}
              resolution={resolution}
              elementPickerActive={elementPickerActive}
              onElementSelected={(coords) => {
                addToast(`Element at (${coords.x}, ${coords.y})`, 'info')
                setElementPickerActive(false)
              }}
              previewRenderMode={previewRenderMode}
              overlayVisible={overlayVisible}
              previewZoom={previewZoom}
              showStreamUnderlay={showLiveStreamUnderlay}
              highlightSelector={previewHighlightSelector}
              highlightNonce={previewHighlightNonce}
            />

            {debugEnabled && (
              <div className="absolute left-3 bottom-3 z-20 w-80 max-w-[calc(100%-1.5rem)] rounded-lg border border-amber-500/30 bg-black/75 text-[10px] font-mono text-amber-100 shadow-xl backdrop-blur-sm">
                <div className="px-2 py-1 border-b border-amber-500/20 flex items-center justify-between">
                  <span className="font-semibold">Build Debug</span>
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
                    <span className="text-amber-300/80">{designId}</span>
                  </div>
                </div>
                <div className="px-2 py-1.5 space-y-1.5 leading-4">
                  <div className="grid grid-cols-[120px_1fr] gap-1">
                    <span className="text-amber-300/80">Section</span>
                    <span>{previewSection}</span>
                    <span className="text-amber-300/80">Rendering</span>
                    <span>{String(isRendering)}</span>
                    <span className="text-amber-300/80">Render ms</span>
                    <span>{renderTime == null ? 'n/a' : String(renderTime)}</span>
                    <span className="text-amber-300/80">Preview error</span>
                    <span>{safePreviewError || 'none'}</span>
                    <span className="text-amber-300/80">Commands</span>
                    <span>{commandFeedCount}{lastCommandLabel ? ` (${lastCommandLabel})` : ''}</span>
                  </div>
                </div>
              </div>
            )}

            {showEventOverlay && <IracingCommandLog />}
          </div>
        </div>
      )}
    />
  )

  const rightSidebarTabs = [
    { id: 'context', label: 'Variables', icon: BookOpen },
    { id: 'animations', label: 'Animations', icon: Sparkles },
    { id: 'history', label: 'History', icon: History },
    { id: 'ai', label: 'AI Designer', icon: Bot },
  ]

  const activeRightSidebarTab = rightSidebarTabs.find((tab) => tab.id === rightSidebarActiveTab) || rightSidebarTabs[0]
  const activeAiSnapshot = aiActiveTurnId ? aiSnapshotsRef.current[aiActiveTurnId] : null
  const aiOpenDiffMessage = aiOpenDiffId
    ? aiConversation
      .map((entry, index) => normalizeAiConversationEntry(entry, index))
      .find((entry) => entry.id === aiOpenDiffId)
    : null

  const rightSidebarContent = rightSidebarActiveTab === 'context' ? (
    <DataContextInspector
      variables={dataContext?.variables || {}}
      variableDocs={dataContext?.variable_docs || {}}
      variableSources={dataContext?.variable_sources || {}}
      templateId={designId}
      projectId={activeProject?.id ?? null}
      onInsertVariable={insertAtCursor}
    />
  ) : rightSidebarActiveTab === 'animations' ? (
    <AnimationPicker onInsertAnimation={handleInsertAnimation} />
  ) : rightSidebarActiveTab === 'history' ? (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <div className="shrink-0 border-b border-border bg-bg-secondary/40 p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-xs font-semibold text-text-secondary">Revision History</div>
            <div className="text-[10px] text-text-tertiary">{revisions.length} rollback points</div>
          </div>
          <button
            type="button"
            onClick={refreshRevisions}
            className="rounded border border-border p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
            title="Refresh revision history"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${revisionsLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {revisions.length === 0 && (
          <div className="rounded border border-border bg-bg-secondary/40 p-3 text-xs text-text-tertiary">
            No revisions yet. Saves and Codex edits will appear here.
          </div>
        )}
        {revisions.map((revision) => (
          <div key={revision.revision_id} className="rounded border border-border bg-bg-secondary/40 p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[11px] font-medium text-text-secondary">
                  {toDisplayText(revision.summary, 'Overlay save') || 'Overlay save'}
                </div>
                <div className="mt-0.5 text-[10px] text-text-tertiary">
                  {new Date(revision.created_at).toLocaleString()} · {toDisplayText(revision.source, 'ui')} · {toDisplayText(revision.author, 'user')}
                </div>
                <div className="mt-1 font-mono text-[10px] text-text-disabled">
                  {toDisplayText(revision.base_sha256, '').slice(0, 10)} → {toDisplayText(revision.result_sha256, '').slice(0, 10)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleRestoreRevision(revision)}
                className="shrink-0 rounded border border-border px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              >
                Restore
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  ) : (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <div className="shrink-0 border-b border-border bg-bg-secondary/40 p-2 space-y-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleStartNewAiChat}
            className="rounded border border-border px-2 py-1 text-[11px] text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
            title="Start a new AI chat"
          >
            New chat
          </button>
          <select
            value={aiSelectedArchiveId}
            onChange={(e) => handleLoadArchivedChat(e.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-bg-primary px-2 py-1 text-[11px] text-text-secondary"
            title="Load chat history"
          >
            <option value="">Chat history</option>
            {(Array.isArray(aiArchivedChats) ? aiArchivedChats : []).map((chat) => (
              <option key={`archive-${chat.id}`} value={chat.id}>
                {new Date(chat.createdAt).toLocaleTimeString()} - [{toDisplayText(chat.section, 'race')}] [{toDisplayText(chat.scopeMode, 'section')}] [{String(Number(chat.turnCount) || 0)}t] {toDisplayText(chat.title, 'AI chat').slice(0, 42)}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            onClick={() => setAiScopeMode('section')}
            className={`rounded border px-2 py-1 text-[10px] uppercase tracking-wide transition-colors ${
              aiScopeMode === 'section'
                ? 'border-blue-500/60 bg-blue-600/20 text-blue-100'
                : 'border-border bg-bg-primary text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
            }`}
          >
            This section
          </button>
          <button
            type="button"
            onClick={() => setAiScopeMode('all_sections')}
            className={`rounded border px-2 py-1 text-[10px] uppercase tracking-wide transition-colors ${
              aiScopeMode === 'all_sections'
                ? 'border-purple-500/60 bg-purple-600/20 text-purple-100'
                : 'border-border bg-bg-primary text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
            }`}
          >
            Modify all
          </button>
          <button
            type="button"
            onClick={() => setAiShowDetails((prev) => !prev)}
            className="rounded border border-border px-2 py-1 text-[10px] uppercase tracking-wide text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
          >
            {aiShowDetails ? 'Hide details' : 'Details'}
          </button>
        </div>

        {aiShowDetails && (
          <div className="rounded border border-border bg-bg-primary/60 p-2 space-y-2">
            <div className="text-[10px] uppercase tracking-wide text-text-tertiary">Turn details</div>
            <select
              value={aiOpenDiffId || ''}
              onChange={(e) => setAiOpenDiffId(e.target.value || null)}
              className="w-full rounded border border-border bg-bg-primary px-2 py-1 text-[11px] text-text-secondary"
            >
              <option value="">Select AI turn</option>
              {aiConversation
                .map((entry, index) => normalizeAiConversationEntry(entry, index))
                .filter((entry) => entry.role === 'assistant' && entry.hasDiff)
                .map((entry) => (
                  <option
                    key={`history-${entry.id}`}
                    value={entry.id}
                    title={toDisplayText(entry.changeSummary || entry.content, '')}
                  >
                    {new Date(entry.createdAt).toLocaleTimeString()} - {toDisplayText(entry.changeSummary || entry.content, 'AI turn').slice(0, 64)}
                  </option>
                ))}
            </select>
            {aiOpenDiffMessage?.diffPreview && (
              <pre className="max-h-36 overflow-auto rounded border border-border bg-black/40 p-2 text-[10px] leading-4 text-amber-100 whitespace-pre-wrap">
                {toDisplayText(aiOpenDiffMessage.diffPreview, '')}
              </pre>
            )}
            {Array.isArray(aiSnapshotsRef.current[aiOpenDiffId]?.chunks) && aiSnapshotsRef.current[aiOpenDiffId].chunks.length > 0 && (
              <div className="space-y-1">
                {aiSnapshotsRef.current[aiOpenDiffId].chunks.map((chunk) => (
                  <div key={`${aiOpenDiffId}-${chunk.id}`} className="flex items-center justify-between rounded border border-border bg-bg-primary/50 px-2 py-1">
                    <div className="text-[10px] text-text-tertiary">
                      {chunk.id} · line {chunk.start + 1}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleSetChunkActive(aiOpenDiffId, chunk.id, true)}
                        className={`rounded border px-1.5 py-0.5 text-[10px] ${chunk.active ? 'border-green-500/50 text-green-300' : 'border-border text-text-tertiary hover:text-text-primary'}`}
                      >
                        Apply
                      </button>
                      <button
                        onClick={() => handleSetChunkActive(aiOpenDiffId, chunk.id, false)}
                        className={`rounded border px-1.5 py-0.5 text-[10px] ${!chunk.active ? 'border-amber-500/50 text-amber-300' : 'border-border text-text-tertiary hover:text-text-primary'}`}
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div ref={aiConversationRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {aiConversation.map((rawMessage, idx) => {
          const message = normalizeAiConversationEntry(rawMessage, idx)
          return (
          <div key={message.id || `${message.role}-${idx}`} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[95%] rounded-lg px-3 py-2 text-xs leading-relaxed border ${
              message.role === 'user'
                ? 'bg-blue-600/20 border-blue-500/40 text-blue-100'
                : 'bg-bg-secondary border-border text-text-secondary'
            }`}>
              {toDisplayText(message.content, '')}
              {message.role === 'assistant' && Array.isArray(message.touchedSections) && message.touchedSections.length > 0 && (
                <div className="mt-2">
                  <div className="mb-1 text-[10px] text-text-tertiary">Touched sections</div>
                  <div className="flex flex-wrap gap-1">
                    {message.touchedSections.map((section) => (
                      <button
                        key={`${message.id}-${section}`}
                        onClick={() => handleFocusTouchedSection(section)}
                        className="rounded border border-border bg-bg-primary px-1.5 py-0.5 text-[10px] text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
                      >
                        {section}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {message.role === 'assistant' && message.changeSummary && (
                <div className="mt-1 text-[10px] text-text-tertiary">{toDisplayText(message.changeSummary, '')}</div>
              )}
              {message.role === 'assistant' && message.hasDiff && (
                <div className="mt-2 flex items-center gap-1.5">
                  <button
                    onClick={() => {
                      setAiOpenDiffId(message.id)
                      setAiShowDetails(true)
                    }}
                    className="rounded border border-border px-2 py-0.5 text-[10px] text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
                  >
                    Open details
                  </button>
                </div>
              )}
            </div>
          </div>
          )
        })}
      </div>
      <div className="shrink-0 border-t border-border p-3 bg-bg-secondary/40 space-y-2.5">
        {activeAiSnapshot && (
          <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-2.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] uppercase tracking-wide text-blue-200">AI preview active</div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => handleSetAiPreviewMode(aiActiveTurnId, 'before')}
                className={`rounded border px-2 py-1 text-[11px] transition-colors ${aiPreviewMode === 'before' ? 'border-amber-500/60 bg-amber-500/15 text-amber-100' : 'border-border text-text-tertiary hover:bg-bg-hover hover:text-text-primary'}`}
              >
                Preview Before
              </button>
              <button
                type="button"
                onClick={() => handleSetAiPreviewMode(aiActiveTurnId, 'after')}
                className={`rounded border px-2 py-1 text-[11px] transition-colors ${aiPreviewMode === 'after' ? 'border-blue-500/60 bg-blue-500/20 text-blue-100' : 'border-border text-text-tertiary hover:bg-bg-hover hover:text-text-primary'}`}
              >
                Preview After
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleSave}
                className="inline-flex items-center justify-center gap-1.5 rounded border border-green-500/80 bg-green-500 px-2 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-green-400"
              >
                <Save className="h-3.5 w-3.5" />
                Accept change
              </button>
              <button
                type="button"
                onClick={() => handleRevertAiTurn({ id: aiActiveTurnId })}
                className="rounded border border-red-500/50 bg-red-600/15 px-2 py-1 text-[11px] text-red-100 transition-colors hover:bg-red-600/25"
              >
                Reject change
              </button>
            </div>
            <div className="flex items-center justify-between text-[10px] text-blue-200/90">
              <span>{aiPreviewMode === 'before' ? 'Previewing before state' : 'Previewing AI result'} · Accept keeps this working version until topbar Save.</span>
              <span>Tip: Ctrl/Cmd+S</span>
            </div>
          </div>
        )}

        <AIPromptComposer
          value={aiPrompt}
          onChange={setAiPrompt}
          onSubmit={handleAiEdit}
          loading={aiLoading}
          submitLabel="Send"
          loadingLabel="Applying..."
          multiline
          rows={4}
          shortcut="mod+enter"
          placeholder={aiScopeMode === 'all_sections'
            ? 'Describe global changes across all sections (colors, typography, spacing)...'
            : `Describe changes for ${previewSection}...`}
          className="min-h-0"
        />
        {aiError && (
          <p className="text-[11px] text-red-400 truncate" title={toDisplayText(aiError, '')}>{toDisplayText(aiError, '')}</p>
        )}
      </div>
    </div>
  )

  const rightSidebarPanel = rightSidebarCollapsed ? (
    <div className="w-10 h-full flex flex-col items-center py-2 gap-2 border-l border-border bg-bg-secondary shrink-0 select-none">
      {rightSidebarTabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => {
            setRightSidebarActiveTab(id)
            setRightSidebarCollapsed(false)
          }}
          title={label}
          className="p-1.5 rounded-md hover:bg-surface-hover text-text-tertiary hover:text-text-secondary transition-colors"
        >
          <Icon size={16} />
        </button>
      ))}
      <button
        onClick={() => setRightSidebarCollapsed(false)}
        title="Expand sidebar"
        className="mt-auto p-1.5 rounded-md hover:bg-surface-hover text-text-tertiary hover:text-text-secondary transition-colors"
      >
        <ChevronLeft size={16} />
      </button>
    </div>
  ) : (
    <aside
      className={`h-full shrink-0 border-l border-border bg-bg-primary flex flex-col relative${isRightSidebarDragging ? ' select-none' : ''}`}
      style={{ width: rightSidebarWidth }}
    >
      <div
        onMouseDown={handleRightSidebarDragStart}
        className="absolute top-0 bottom-0 left-0 cursor-col-resize group/divider z-20"
        style={{ width: 1, marginLeft: -1 }}
      >
        <div className="absolute inset-y-0 -left-2 -right-2" />
        <div className="absolute inset-y-0 left-0 w-px bg-border transition-colors group-hover/divider:bg-accent group-active/divider:bg-accent" />
      </div>

      <div className="flex shrink-0 border-b border-border">
        {rightSidebarTabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setRightSidebarActiveTab(id)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium
                       transition-colors border-b-2
                       ${activeRightSidebarTab.id === id
                         ? 'border-accent text-accent bg-accent/5'
                         : 'border-transparent text-text-tertiary hover:text-text-secondary'
                       }`}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
        <button
          onClick={() => setRightSidebarCollapsed(true)}
          title="Collapse sidebar"
          className="px-2 py-2 text-text-tertiary hover:text-text-secondary transition-colors"
        >
          <ChevronRight size={13} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {rightSidebarContent}
      </div>
    </aside>
  )

  const previewTabs = [
    { id: 'intro', label: 'Intro', icon: Film, activeIconClass: 'text-blue-400', count: designMeta?.sections?.intro?.length || 0 },
    { id: 'qualifying_results', label: 'Qualifying', icon: Award, activeIconClass: 'text-amber-400', count: designMeta?.sections?.qualifying_results?.length || 0 },
    { id: 'race', label: 'Race', icon: Flag, activeIconClass: 'text-emerald-400', count: designMeta?.sections?.race?.length || 0 },
    { id: 'race_results', label: 'Results', icon: Monitor, activeIconClass: 'text-purple-400', count: designMeta?.sections?.race_results?.length || 0 },
  ]

  const topbarContextControls = (
    <>
      <span className="text-xs font-medium text-text-secondary">Preview</span>
      {renderTime != null && (
        <span className={`text-[10px] px-1.5 py-0.5 rounded tabular-nums ${
          renderTime < 200 ? 'bg-green-900/30 text-green-400' : 'bg-yellow-900/30 text-yellow-400'
        }`}>
          {renderTime}ms
        </span>
      )}
      <button
        onClick={() => setElementPickerActive((prev) => !prev)}
        className={`p-1 rounded text-xs border transition-colors ${
          elementPickerActive
            ? 'border-blue-500/40 bg-blue-600 text-white'
            : 'border-border text-text-tertiary hover:text-text-primary hover:bg-bg-hover'
        }`}
        title="Element picker — click on preview to select elements"
      >
        <MousePointer2 className="w-3.5 h-3.5" />
      </button>
      {isDirty && (
        <span className="rounded-full bg-amber-900/30 px-2 py-1 text-xxs font-medium text-amber-400">
          Unsaved
        </span>
      )}
      <button
        onClick={handleRevert}
        disabled={!isDirty}
        className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xxs font-medium text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
        title="Revert to last saved"
      >
        <RotateCcw className="w-3.5 h-3.5" />
        Revert
      </button>
      <button
        onClick={handleSave}
        disabled={!isDirty}
        className="flex items-center gap-1.5 rounded-md bg-blue-600 px-2 py-1 text-xxs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-30"
        title="Save changes (Ctrl+S)"
      >
        <Save className="w-3.5 h-3.5" />
        Save
      </button>
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
          onClick={() => setShowLiveStreamUnderlay((prev) => !prev)}
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
          title="Toggle build preview debugging"
          aria-label={debugEnabled ? 'Disable build preview debugging' : 'Enable build preview debugging'}
        >
          <Bug className="w-3.5 h-3.5" />
        </button>
      </div>
    </>
  )

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      <OverlayWorkspaceTopbar
        tabs={previewTabs}
        activeTab={previewSection}
        onTabChange={setPreviewSection}
        contextControls={topbarContextControls}
        commonControls={topbarCommonControls}
      />

      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="flex h-full min-h-0 overflow-hidden">
          <div className="flex-1 min-w-0 h-full min-h-0 overflow-hidden">
            {mainWorkspace}
          </div>
          {rightSidebarPanel}
        </div>
      </div>
    </div>
  )
}
