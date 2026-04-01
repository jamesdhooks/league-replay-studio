import { useState, useEffect, useCallback } from 'react'
import { useOverlay } from '../../context/OverlayContext'
import { useToast } from '../../context/ToastContext'
import {
  Layers, Plus, Copy, Trash2, Download, Upload,
  Monitor, Film, Palette, Eye, ChevronRight, Settings,
  Play, Square, Loader2, Check, AlertCircle,
} from 'lucide-react'

/**
 * OverlayPanel — Template library browser and management UI.
 *
 * Displays built-in and custom overlay templates with preview cards,
 * resolution selector, template CRUD actions, and batch render status.
 */
export default function OverlayPanel() {
  const {
    templates, selectedTemplateId, engineStatus, batchProgress,
    loading, error,
    setSelectedTemplateId, initEngine, fetchTemplates,
    createTemplate, deleteTemplate, duplicateTemplate, exportTemplate,
    setResolution,
  } = useOverlay()
  const { addToast } = useToast()

  const [resolution, setLocalResolution] = useState('1080p')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newTemplateName, setNewTemplateName] = useState('')
  const [newTemplateDesc, setNewTemplateDesc] = useState('')
  const [filter, setFilter] = useState('all') // 'all' | 'builtin' | 'custom'

  // ── Load templates on mount ──────────────────────────────────────────────
  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  // ── Filtered templates ───────────────────────────────────────────────────
  const filteredTemplates = templates.filter(t => {
    if (filter === 'builtin') return t.is_builtin
    if (filter === 'custom') return !t.is_builtin
    return true
  })

  // ── Style icons ──────────────────────────────────────────────────────────
  const styleIcon = (style) => {
    switch (style) {
      case 'broadcast': return <Monitor className="w-5 h-5" />
      case 'minimal': return <Eye className="w-5 h-5" />
      case 'classic': return <Film className="w-5 h-5" />
      case 'cinematic': return <Palette className="w-5 h-5" />
      default: return <Layers className="w-5 h-5" />
    }
  }

  // ── Style colors ─────────────────────────────────────────────────────────
  const styleColor = (style) => {
    switch (style) {
      case 'broadcast': return 'border-blue-500/40 bg-blue-500/5'
      case 'minimal': return 'border-emerald-500/40 bg-emerald-500/5'
      case 'classic': return 'border-amber-500/40 bg-amber-500/5'
      case 'cinematic': return 'border-purple-500/40 bg-purple-500/5'
      default: return 'border-gray-500/40 bg-gray-500/5'
    }
  }

  // ── Handle create ────────────────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    if (!newTemplateName.trim()) return
    const result = await createTemplate({
      name: newTemplateName.trim(),
      description: newTemplateDesc.trim(),
      style: 'custom',
      html_content: '',
      resolutions: ['1080p', '1440p', '4k'],
    })
    if (result.success) {
      addToast('Template created', 'success')
      setShowCreateForm(false)
      setNewTemplateName('')
      setNewTemplateDesc('')
    } else {
      addToast(result.error || 'Failed to create template', 'error')
    }
  }, [newTemplateName, newTemplateDesc, createTemplate, addToast])

  // ── Handle duplicate ─────────────────────────────────────────────────────
  const handleDuplicate = useCallback(async (templateId) => {
    const result = await duplicateTemplate(templateId)
    if (result.success) {
      addToast('Template duplicated', 'success')
    } else {
      addToast(result.error || 'Failed to duplicate', 'error')
    }
  }, [duplicateTemplate, addToast])

  // ── Handle delete ────────────────────────────────────────────────────────
  const handleDelete = useCallback(async (templateId) => {
    const result = await deleteTemplate(templateId)
    if (result.success) {
      addToast('Template deleted', 'success')
    } else {
      addToast(result.error || 'Cannot delete built-in template', 'error')
    }
  }, [deleteTemplate, addToast])

  // ── Handle export ────────────────────────────────────────────────────────
  const handleExport = useCallback(async (templateId) => {
    const result = await exportTemplate(templateId)
    if (result.success) {
      // Create downloadable JSON
      const blob = new Blob([JSON.stringify(result.template, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `overlay-${templateId}.json`
      a.click()
      URL.revokeObjectURL(url)
      addToast('Template exported', 'success')
    } else {
      addToast('Export failed', 'error')
    }
  }, [exportTemplate, addToast])

  // ── Handle resolution change ─────────────────────────────────────────────
  const handleResolutionChange = useCallback(async (res) => {
    setLocalResolution(res)
    await setResolution(res)
  }, [setResolution])

  // ── Handle engine init ───────────────────────────────────────────────────
  const handleInitEngine = useCallback(async () => {
    const result = await initEngine(resolution)
    if (result.success) {
      addToast('Overlay engine initialized', 'success')
    } else {
      addToast(result.error || 'Engine init failed', 'error')
    }
  }, [initEngine, resolution, addToast])

  return (
    <div className="flex flex-col h-full bg-gray-900 text-gray-100">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5 text-blue-400" />
          <h2 className="text-sm font-semibold">Overlay Templates</h2>
          <span className="text-xs text-gray-500">({templates.length})</span>
        </div>

        {/* Engine status indicator */}
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${
            engineStatus.engine_initialized ? 'bg-green-400' : 'bg-gray-500'
          }`} />
          <span className="text-xs text-gray-400">
            {engineStatus.engine_initialized ? 'Engine Ready' : 'Engine Off'}
          </span>
          {!engineStatus.engine_initialized && (
            <button
              onClick={handleInitEngine}
              disabled={loading}
              className="text-xs px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Start'}
            </button>
          )}
        </div>
      </div>

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800">
        {/* Filter tabs */}
        <div className="flex items-center gap-1 text-xs">
          {['all', 'builtin', 'custom'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-1 rounded capitalize ${
                filter === f
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-700'
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Resolution selector */}
        <select
          value={resolution}
          onChange={e => handleResolutionChange(e.target.value)}
          className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300"
        >
          <option value="1080p">1080p</option>
          <option value="1440p">1440p</option>
          <option value="4k">4K</option>
        </select>

        {/* New template button */}
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300"
        >
          <Plus className="w-3 h-3" /> New
        </button>
      </div>

      {/* ── Create form ─────────────────────────────────────────────────── */}
      {showCreateForm && (
        <div className="px-4 py-3 border-b border-gray-800 bg-gray-800/50">
          <input
            type="text"
            value={newTemplateName}
            onChange={e => setNewTemplateName(e.target.value)}
            placeholder="Template name..."
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white mb-2 focus:border-blue-500 focus:outline-none"
          />
          <input
            type="text"
            value={newTemplateDesc}
            onChange={e => setNewTemplateDesc(e.target.value)}
            placeholder="Description (optional)..."
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white mb-2 focus:border-blue-500 focus:outline-none"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={!newTemplateName.trim()}
              className="text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
            >
              Create
            </button>
            <button
              onClick={() => setShowCreateForm(false)}
              className="text-xs px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Batch render progress ───────────────────────────────────────── */}
      {batchProgress && batchProgress.state === 'rendering' && (
        <div className="px-4 py-2 border-b border-gray-800 bg-gray-800/30">
          <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
            <span className="flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              Batch rendering...
            </span>
            <span className="tabular-nums">
              {batchProgress.rendered_frames}/{batchProgress.total_frames} frames ({batchProgress.percentage}%)
            </span>
          </div>
          <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${batchProgress.percentage}%` }}
            />
          </div>
        </div>
      )}

      {/* ── Error banner ────────────────────────────────────────────────── */}
      {error && (
        <div className="px-4 py-2 border-b border-red-800/50 bg-red-900/20 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <span className="text-xs text-red-300">{error}</span>
        </div>
      )}

      {/* ── Template grid ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-1 gap-3">
          {filteredTemplates.map(template => (
            <div
              key={template.id}
              onClick={() => setSelectedTemplateId(template.id)}
              className={`group relative rounded-lg border cursor-pointer transition-all ${
                selectedTemplateId === template.id
                  ? 'border-blue-500 ring-1 ring-blue-500/50 bg-blue-500/10'
                  : `${styleColor(template.style)} hover:border-gray-500`
              }`}
            >
              <div className="flex items-start gap-3 p-3">
                {/* Icon */}
                <div className={`flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${
                  selectedTemplateId === template.id ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-800 text-gray-400'
                }`}>
                  {styleIcon(template.style)}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white truncate">
                      {template.name}
                    </span>
                    {template.is_builtin && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400 uppercase tracking-wider">
                        Built-in
                      </span>
                    )}
                    <span className="text-[10px] text-gray-600">v{template.version}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                    {template.description}
                  </p>
                  <div className="flex items-center gap-1 mt-1.5">
                    {(template.resolutions || []).map(res => (
                      <span key={res} className="text-[10px] px-1 py-0.5 rounded bg-gray-800 text-gray-500">
                        {res}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={e => { e.stopPropagation(); handleDuplicate(template.id) }}
                    className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white"
                    title="Duplicate"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); handleExport(template.id) }}
                    className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white"
                    title="Export"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                  {!template.is_builtin && (
                    <button
                      onClick={e => { e.stopPropagation(); handleDelete(template.id) }}
                      className="p-1 rounded hover:bg-red-700/50 text-gray-400 hover:text-red-400"
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Selection indicator */}
              {selectedTemplateId === template.id && (
                <div className="absolute right-3 top-3">
                  <Check className="w-4 h-4 text-blue-400" />
                </div>
              )}
            </div>
          ))}

          {filteredTemplates.length === 0 && (
            <div className="text-center text-gray-500 text-sm py-8">
              {filter === 'custom'
                ? 'No custom templates yet. Create or duplicate one to get started.'
                : 'No templates found.'
              }
            </div>
          )}
        </div>
      </div>

      {/* ── Selected template summary ───────────────────────────────────── */}
      {selectedTemplateId && (
        <div className="px-4 py-2 border-t border-gray-700 bg-gray-800/50 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <ChevronRight className="w-3 h-3" />
            <span>Selected: <span className="text-white font-medium">
              {templates.find(t => t.id === selectedTemplateId)?.name || selectedTemplateId}
            </span></span>
          </div>
          <div className="flex items-center gap-1 text-xs text-gray-500">
            <Settings className="w-3 h-3" />
            {resolution}
          </div>
        </div>
      )}
    </div>
  )
}
