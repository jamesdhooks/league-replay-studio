import { useState, useEffect, useCallback } from 'react'
import { useOverlay } from '../../context/OverlayContext'
import { usePreset } from '../../context/PresetContext'
import { useToast } from '../../context/ToastContext'
import OverlayEditor from './OverlayEditor'
import PresetDesigner from './PresetDesigner'
import {
  Layers, Plus, Copy, Trash2, Download, Upload,
  Monitor, Film, Palette, Eye, ChevronRight, Settings,
  Play, Square, Loader2, Check, AlertCircle, Code,
  Settings2,
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
  const { presets, fetchPresets: fetchPresetsCtx } = usePreset()
  const { addToast } = useToast()

  const [resolution, setLocalResolution] = useState('1080p')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newTemplateName, setNewTemplateName] = useState('')
  const [newTemplateDesc, setNewTemplateDesc] = useState('')
  const [filter, setFilter] = useState('all') // 'all' | 'builtin' | 'custom'
  const [editingTemplateId, setEditingTemplateId] = useState(null)
  const [designerPresetId, setDesignerPresetId] = useState(null)

  // ── Load templates and presets on mount ──────────────────────────────────
  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  useEffect(() => {
    fetchPresetsCtx()
  }, [fetchPresetsCtx])

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

  // ── If editing a template, show the editor ────────────────────────────────
  if (editingTemplateId) {
    return (
      <OverlayEditor
        templateId={editingTemplateId}
        onClose={() => setEditingTemplateId(null)}
      />
    )
  }

  // ── If designing a preset, show the designer ──────────────────────────────
  if (designerPresetId) {
    return (
      <PresetDesigner
        presetId={designerPresetId}
        onClose={() => setDesignerPresetId(null)}
      />
    )
  }

  return (
    <div className="flex flex-col h-full bg-bg-primary text-text-primary">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-secondary shrink-0">
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">Overlays</h2>
        </div>

        {/* Engine status indicator */}
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${
            engineStatus.engine_initialized ? 'bg-success' : 'bg-text-disabled'
          }`} />
          <span className="text-xxs text-text-tertiary">
            {engineStatus.engine_initialized ? 'Engine Ready' : 'Engine Off'}
          </span>
          {!engineStatus.engine_initialized && (
            <button
              onClick={handleInitEngine}
              disabled={loading}
              className="text-xxs px-2 py-0.5 rounded bg-accent hover:bg-accent-hover text-white disabled:opacity-50 font-medium"
            >
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Start'}
            </button>
          )}
        </div>
      </div>

      {/* ── Tab bar: Templates / Presets ──────────────────────────────── */}
      <div className="flex border-b border-border shrink-0">
        <button
          onClick={() => setFilter('all')}
          className={`flex-1 px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
            filter !== 'presets'
              ? 'border-accent text-accent'
              : 'border-transparent text-text-secondary hover:text-text-primary'
          }`}
        >
          Templates
          <span className="ml-1 text-xxs text-text-disabled">({templates.length})</span>
        </button>
        <button
          onClick={() => setFilter('presets')}
          className={`flex-1 px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
            filter === 'presets'
              ? 'border-accent text-accent'
              : 'border-transparent text-text-secondary hover:text-text-primary'
          }`}
        >
          <Settings2 className="w-3 h-3 inline mr-1" />
          Presets
          <span className="ml-1 text-xxs text-text-disabled">({presets.length})</span>
        </button>
      </div>

      {/* ── Toolbar (templates view only) ────────────────────────────── */}
      {filter !== 'presets' && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
          {/* Sub-filter tabs */}
          <div className="flex items-center gap-1 text-xxs">
            {['all', 'builtin', 'custom'].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2 py-1 rounded capitalize ${
                  filter === f
                    ? 'bg-accent text-white'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-secondary'
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
            className="text-xxs bg-bg-secondary border border-border rounded px-2 py-1 text-text-secondary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="1080p">1080p</option>
            <option value="1440p">1440p</option>
            <option value="4k">4K</option>
          </select>

          {/* New template button */}
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="flex items-center gap-1 text-xxs px-2 py-1 rounded bg-bg-secondary hover:bg-bg-hover text-text-secondary border border-border"
          >
            <Plus className="w-3 h-3" /> New
          </button>
        </div>
      )}

      {/* ── Create form ─────────────────────────────────────────────────── */}
      {showCreateForm && filter !== 'presets' && (
        <div className="px-4 py-3 border-b border-border bg-bg-secondary/50 shrink-0">
          <input
            type="text"
            value={newTemplateName}
            onChange={e => setNewTemplateName(e.target.value)}
            placeholder="Template name..."
            className="w-full bg-bg-primary border border-border rounded px-3 py-1.5 text-xs text-text-primary mb-2 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <input
            type="text"
            value={newTemplateDesc}
            onChange={e => setNewTemplateDesc(e.target.value)}
            placeholder="Description (optional)..."
            className="w-full bg-bg-primary border border-border rounded px-3 py-1.5 text-xs text-text-primary mb-2 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={!newTemplateName.trim()}
              className="text-xxs px-3 py-1 rounded bg-accent hover:bg-accent-hover text-white disabled:opacity-50 font-medium"
            >
              Create
            </button>
            <button
              onClick={() => setShowCreateForm(false)}
              className="text-xxs px-3 py-1 rounded bg-bg-secondary hover:bg-bg-hover text-text-secondary border border-border"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Batch render progress ───────────────────────────────────────── */}
      {batchProgress && batchProgress.state === 'rendering' && (
        <div className="px-4 py-2 border-b border-border bg-bg-secondary/30 shrink-0">
          <div className="flex items-center justify-between text-xxs text-text-tertiary mb-1">
            <span className="flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              Batch rendering…
            </span>
            <span className="tabular-nums font-mono">
              {batchProgress.rendered_frames}/{batchProgress.total_frames} frames ({batchProgress.percentage}%)
            </span>
          </div>
          <div className="w-full h-1.5 bg-bg-primary rounded-full overflow-hidden border border-border">
            <div
              className="h-full bg-accent transition-all duration-300"
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

      {/* ── Main Content ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-4">

        {/* ── Presets View ──────────────────────────────────────────────── */}
        {filter === 'presets' && (
          <div className="space-y-2">
            {presets.length > 0 ? (
              presets.map(preset => (
                <div
                  key={preset.id}
                  className="group flex items-center justify-between px-3 py-2.5 rounded-lg border border-border hover:border-accent/40 bg-bg-secondary/30 hover:bg-accent/5 transition-all"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-bg-primary text-text-tertiary">
                      <Layers className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-text-primary truncate">{preset.name}</span>
                        {preset.is_builtin && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-secondary text-text-tertiary uppercase tracking-wider border border-border flex-shrink-0">
                            Built-in
                          </span>
                        )}
                      </div>
                      <p className="text-xxs text-text-tertiary mt-0.5">
                        {preset.description || `${Object.keys(preset.sections || {}).length} sections configured`}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setDesignerPresetId(preset.id)}
                    className="flex items-center gap-1 text-xxs px-2.5 py-1 rounded bg-accent hover:bg-accent-hover text-white opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 font-medium"
                  >
                    <Settings2 className="w-3 h-3" /> Design
                  </button>
                </div>
              ))
            ) : (
              <div className="text-center text-text-tertiary text-xs py-8">
                No presets available. Presets control how overlay templates render per-section.
              </div>
            )}
          </div>
        )}

        {/* ── Templates View ────────────────────────────────────────────── */}
        {filter !== 'presets' && (
          <div className="grid grid-cols-1 gap-3">
          {filteredTemplates.map(template => (
            <div
              key={template.id}
              onClick={() => setSelectedTemplateId(template.id)}
              className={`group relative rounded-lg border cursor-pointer transition-all ${
                selectedTemplateId === template.id
                  ? 'border-accent ring-1 ring-accent/50 bg-accent/5'
                  : `${styleColor(template.style)} hover:border-text-tertiary`
              }`}
            >
              <div className="flex items-start gap-3 p-3">
                {/* Icon */}
                <div className={`flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${
                  selectedTemplateId === template.id ? 'bg-accent/10 text-accent' : 'bg-bg-secondary text-text-tertiary'
                }`}>
                  {styleIcon(template.style)}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-text-primary truncate">
                      {template.name}
                    </span>
                    {template.is_builtin && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-secondary text-text-tertiary uppercase tracking-wider border border-border">
                        Built-in
                      </span>
                    )}
                    <span className="text-[10px] text-text-disabled">v{template.version}</span>
                  </div>
                  <p className="text-xxs text-text-tertiary mt-0.5 line-clamp-2">
                    {template.description}
                  </p>
                  <div className="flex items-center gap-1 mt-1.5">
                    {(template.resolutions || []).map(res => (
                      <span key={res} className="text-[10px] px-1 py-0.5 rounded bg-bg-secondary text-text-tertiary border border-border">
                        {res}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={e => { e.stopPropagation(); setEditingTemplateId(template.id) }}
                    className="p-1 rounded hover:bg-accent/20 text-text-tertiary hover:text-accent"
                    title="Edit template"
                  >
                    <Code className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); handleDuplicate(template.id) }}
                    className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary"
                    title="Duplicate"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); handleExport(template.id) }}
                    className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary"
                    title="Export"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                  {!template.is_builtin && (
                    <button
                      onClick={e => { e.stopPropagation(); handleDelete(template.id) }}
                      className="p-1 rounded hover:bg-danger/10 text-text-tertiary hover:text-danger"
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
                  <Check className="w-4 h-4 text-accent" />
                </div>
              )}
            </div>
          ))}

          {filteredTemplates.length === 0 && (
            <div className="text-center text-text-tertiary text-xs py-8">
              {filter === 'custom'
                ? 'No custom templates yet. Create or duplicate one to get started.'
                : 'No templates found.'
              }
            </div>
          )}
        </div>
        )}
      </div>

      {/* ── Selected template footer ───────────────────────────────────── */}
      {selectedTemplateId && filter !== 'presets' && (
        <div className="px-4 py-2 border-t border-border bg-bg-secondary shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xxs text-text-tertiary">
            <Check className="w-3 h-3 text-accent" />
            <span>Active: <span className="text-text-primary font-medium">
              {templates.find(t => t.id === selectedTemplateId)?.name || selectedTemplateId}
            </span></span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setEditingTemplateId(selectedTemplateId)}
              className="flex items-center gap-1 text-xxs px-2 py-0.5 rounded bg-accent hover:bg-accent-hover text-white font-medium"
            >
              <Code className="w-3 h-3" /> Edit Code
            </button>
            <div className="flex items-center gap-1 text-xxs text-text-disabled">
              <Settings className="w-3 h-3" />
              {resolution}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
