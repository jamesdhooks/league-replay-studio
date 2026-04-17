import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Layers, Plus, Copy, Trash2, Code, Eye, PenSquare, Wrench, Database, PictureInPicture2, Monitor, Film, Palette, Link2 } from 'lucide-react'
import { usePreset } from '../../context/PresetContext'
import { useOverlay } from '../../context/OverlayContext'
import { useToast } from '../../context/ToastContext'
import OverlayPreviewStep from './OverlayPreviewStep'
import PresetDesigner from './PresetDesigner'
import OverlayEditor from './OverlayEditor'
import DataPluginsPanel from './DataPluginsPanel'
import PipConfigurator from './PipConfigurator'
import ResizableSplitPane from '../ui/ResizableSplitPane'

const TEMPLATE_STYLE_META = {
  broadcast: {
    label: 'Timing tower',
    cardClass: 'border-sky-500/30 bg-sky-500/5',
    badgeClass: 'border-sky-500/30 text-sky-300',
    canvasClass: 'bg-slate-950',
    icon: Monitor,
  },
  minimal: {
    label: 'Lower-third',
    cardClass: 'border-emerald-500/30 bg-emerald-500/5',
    badgeClass: 'border-emerald-500/30 text-emerald-300',
    canvasClass: 'bg-zinc-950',
    icon: Eye,
  },
  classic: {
    label: 'Race board',
    cardClass: 'border-amber-500/30 bg-amber-500/5',
    badgeClass: 'border-amber-500/30 text-amber-300',
    canvasClass: 'bg-stone-950',
    icon: Film,
  },
  cinematic: {
    label: 'Title card',
    cardClass: 'border-fuchsia-500/30 bg-fuchsia-500/5',
    badgeClass: 'border-fuchsia-500/30 text-fuchsia-300',
    canvasClass: 'bg-neutral-950',
    icon: Palette,
  },
  blank: {
    label: 'Starter',
    cardClass: 'border-slate-500/30 bg-slate-500/5',
    badgeClass: 'border-slate-500/30 text-slate-300',
    canvasClass: 'bg-slate-950',
    icon: Code,
  },
  custom: {
    label: 'Custom HTML',
    cardClass: 'border-indigo-500/30 bg-indigo-500/5',
    badgeClass: 'border-indigo-500/30 text-indigo-300',
    canvasClass: 'bg-slate-950',
    icon: Code,
  },
}

function resolveLinkedTemplateIdForDesign(design) {
  if (!design) return null
  if (design.template_id) return design.template_id

  // Backward-compatible default mapping for read-only built-in designs.
  const builtinPresetMap = {
    broadcast_preset: 'broadcast',
    minimal_preset: 'minimal',
  }
  return builtinPresetMap[design.id] || null
}

function TemplateThumbnail({ template }) {
  const meta = TEMPLATE_STYLE_META[template.style] || TEMPLATE_STYLE_META.custom
  const Icon = meta.icon

  return (
    <div className={`w-32 shrink-0 rounded-lg border overflow-hidden ${meta.cardClass}`}>
      <div className={`relative h-20 ${meta.canvasClass}`}>
        {template.style === 'broadcast' && (
          <>
            <div className="absolute inset-x-0 top-0 h-3 bg-gradient-to-r from-sky-500 via-slate-100/70 to-sky-500" />
            <div className="absolute top-5 left-2 w-11 space-y-1">
              <div className="h-2 rounded-sm bg-white/85" />
              <div className="h-2 rounded-sm bg-white/70" />
              <div className="h-2 rounded-sm bg-white/55" />
              <div className="h-2 rounded-sm bg-sky-400/80" />
            </div>
            <div className="absolute right-2 bottom-2 h-5 w-16 rounded-sm bg-slate-900/85 border border-white/10" />
          </>
        )}
        {template.style === 'minimal' && (
          <>
            <div className="absolute inset-x-3 bottom-3 h-4 rounded-full bg-emerald-400/85" />
            <div className="absolute left-4 bottom-8 h-1.5 w-10 rounded-full bg-white/45" />
          </>
        )}
        {template.style === 'classic' && (
          <>
            <div className="absolute left-0 top-0 bottom-0 w-4 bg-amber-500/85" />
            <div className="absolute left-6 top-4 w-20 space-y-1">
              <div className="h-2 rounded-sm bg-amber-100/90" />
              <div className="h-2 rounded-sm bg-amber-100/75" />
              <div className="h-2 rounded-sm bg-amber-100/55" />
            </div>
            <div className="absolute right-2 bottom-2 h-4 w-12 rounded-sm border border-amber-200/35 bg-black/45" />
          </>
        )}
        {template.style === 'cinematic' && (
          <>
            <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-500/20 via-transparent to-amber-200/10" />
            <div className="absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-black/85 to-transparent" />
            <div className="absolute left-3 bottom-3 h-2 w-16 rounded-sm bg-white/85" />
            <div className="absolute left-3 bottom-1.5 h-1.5 w-10 rounded-sm bg-white/45" />
          </>
        )}
        {template.style === 'blank' && (
          <div className="absolute inset-3 rounded border border-dashed border-white/20" />
        )}
        {!['broadcast', 'minimal', 'classic', 'cinematic', 'blank'].includes(template.style) && (
          <>
            <div className="absolute left-3 top-3 h-2 w-14 rounded-sm bg-indigo-300/70" />
            <div className="absolute left-3 top-7 h-2 w-20 rounded-sm bg-white/30" />
            <div className="absolute inset-x-3 bottom-3 h-5 rounded-sm border border-white/10 bg-white/5" />
          </>
        )}

        <div className="absolute right-2 top-2 flex items-center gap-1 rounded-full border border-black/20 bg-black/35 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-white/80">
          <Icon className="w-2.5 h-2.5" />
          {meta.label}
        </div>
      </div>
      <div className="border-t border-white/10 px-2 py-1.5 bg-black/20">
        <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${meta.badgeClass}`}>
          {template.style || 'custom'}
        </span>
      </div>
    </div>
  )
}

function TemplateLibraryCard({ template, onOpenEditor, onDuplicate, onDelete, isLinked = false, onLinkToDesign, designName }) {
  const isBuiltIn = Boolean(template.is_builtin)

  return (
    <div className={`rounded-lg border p-3 flex items-start gap-3 ${isLinked ? 'border-accent/60 bg-accent/10' : 'border-border bg-bg-secondary/30'}`}>
      <TemplateThumbnail template={template} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-text-primary truncate">{template.name}</span>
          {isLinked && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-accent/50 text-accent uppercase tracking-wider">Linked</span>
          )}
          {isBuiltIn && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-border text-text-tertiary uppercase tracking-wider">Built-in</span>
          )}
          {!isBuiltIn && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-border text-text-tertiary uppercase tracking-wider">Custom</span>
          )}
        </div>
        <p className="text-xxs text-text-tertiary mt-1">{template.description || 'No description'}</p>
        <div className="mt-2 flex items-center gap-2 flex-wrap text-[10px] text-text-tertiary">
          <span>{template.resolutions?.join(' / ') || '1080p / 1440p / 4k'}</span>
          <span className="text-text-quaternary">•</span>
          <span>{isBuiltIn ? 'Protected source template' : 'Editable source template'}</span>
        </div>
      </div>
      <div className="flex items-center gap-1 self-start">
        <button
          onClick={onOpenEditor}
          className="text-xxs px-2 py-1 rounded bg-accent text-white hover:bg-accent-hover"
        >
          Open Editor
        </button>
        <button
          onClick={onDuplicate}
          className="flex items-center gap-1 text-xxs px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover"
          title={isBuiltIn ? 'Duplicate to custom template' : 'Duplicate template'}
        >
          <Copy className="w-3.5 h-3.5" />
          {isBuiltIn ? 'Duplicate to Custom' : 'Duplicate'}
        </button>
        {onLinkToDesign && !isLinked && (
          <button
            onClick={onLinkToDesign}
            className="text-xxs px-2 py-1 rounded border border-accent/40 text-accent hover:bg-accent/10"
            title={designName ? `Use this template in ${designName}` : 'Use this template in selected design'}
          >
            Use in Design
          </button>
        )}
        {!isBuiltIn && (
          <button
            onClick={onDelete}
            className="p-1 rounded hover:bg-danger/10 text-text-tertiary hover:text-danger"
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

function BuildWorkspace({ selectedDesign, initialTemplateId = null }) {
  const {
    templates,
    fetchTemplates,
    createTemplate,
    duplicateTemplate,
    deleteTemplate,
  } = useOverlay()
  const { linkTemplateToPreset, duplicatePreset, setSelectedPresetId } = usePreset()
  const { addToast } = useToast()
  const [editingTemplateId, setEditingTemplateId] = useState(null)
  const [newTemplateName, setNewTemplateName] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [templateVisibilityMode, setTemplateVisibilityMode] = useState('linked_plus_custom')

  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  const handleCreate = useCallback(async () => {
    if (!newTemplateName.trim()) return
    const result = await createTemplate({
      name: newTemplateName.trim(),
      description: 'Template for advanced design customization',
      style: 'custom',
      html_content: '',
      resolutions: ['1080p', '1440p', '4k'],
    })
    if (result?.success) {
      setShowCreate(false)
      setNewTemplateName('')
      addToast('Template created', 'success')
    } else {
      addToast(result?.error || 'Failed to create template', 'error')
    }
  }, [newTemplateName, createTemplate, addToast])

  const handleDuplicate = useCallback(async (id) => {
    const result = await duplicateTemplate(id)
    if (!result?.success) addToast(result?.error || 'Failed to duplicate template', 'error')
  }, [duplicateTemplate, addToast])

  const handleDelete = useCallback(async (id) => {
    const result = await deleteTemplate(id)
    if (!result?.success) addToast(result?.error || 'Failed to delete template', 'error')
  }, [deleteTemplate, addToast])

  const builtInTemplates = useMemo(
    () => templates.filter((tpl) => tpl.is_builtin),
    [templates],
  )

  const customTemplates = useMemo(
    () => templates.filter((tpl) => !tpl.is_builtin),
    [templates],
  )

  const linkedTemplateId = resolveLinkedTemplateIdForDesign(selectedDesign)
  const linkedTemplate = useMemo(
    () => templates.find((tpl) => tpl.id === linkedTemplateId) || null,
    [templates, linkedTemplateId],
  )

  useEffect(() => {
    if (!initialTemplateId) return
    setEditingTemplateId(initialTemplateId)
  }, [initialTemplateId])

  const effectiveVisibilityMode = selectedDesign ? templateVisibilityMode : 'full_library'
  const showBuiltInSection = effectiveVisibilityMode === 'full_library'

  const visibleCustomTemplates = useMemo(() => {
    if (effectiveVisibilityMode === 'linked_only') return []
    if (effectiveVisibilityMode === 'linked_plus_custom') {
      return customTemplates.filter((tpl) => tpl.id !== linkedTemplateId)
    }
    return customTemplates
  }, [effectiveVisibilityMode, customTemplates, linkedTemplateId])

  const handleLinkTemplate = useCallback(async (templateId) => {
    if (!selectedDesign?.id) {
      addToast('Select a design first to link a template.', 'warning')
      return
    }

    let linkTargetId = selectedDesign.id

    // Built-in presets are read-only; duplicate before linking.
    if (selectedDesign.is_builtin) {
      const duplicated = await duplicatePreset(selectedDesign.id)
      if (!duplicated?.success || !duplicated?.preset?.id) {
        addToast(duplicated?.error || 'Failed to duplicate built-in design for linking', 'error')
        return
      }
      linkTargetId = duplicated.preset.id
      setSelectedPresetId(linkTargetId)
      addToast('Built-in design duplicated. Linking template to your custom copy.', 'info')
    }

    const result = await linkTemplateToPreset(linkTargetId, templateId)
    if (result?.success) {
      addToast('Template linked to design', 'success')
    } else {
      addToast(result?.error || 'Failed to link template to design', 'error')
    }
  }, [selectedDesign, duplicatePreset, setSelectedPresetId, linkTemplateToPreset, addToast])

  if (editingTemplateId) {
    return (
      <OverlayEditor
        templateId={editingTemplateId}
        onClose={() => setEditingTemplateId(null)}
      />
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg-primary">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-secondary">
        <div className="flex items-center gap-2 min-w-0">
          <Code className="w-4 h-4 text-accent" />
          <h3 className="text-sm font-semibold text-text-primary">Build Workspace</h3>
          <span className="text-xxs text-text-tertiary truncate">
            {selectedDesign
              ? `Editing templates for design: ${selectedDesign.name}`
              : 'Select a design to scope Build to that design'}
          </span>
          {linkedTemplate && (
            <button
              onClick={() => setEditingTemplateId(linkedTemplate.id)}
              className="text-xxs px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            >
              Open Linked Template
            </button>
          )}
        </div>
        <button
          onClick={() => setShowCreate(v => !v)}
          className="flex items-center gap-1 text-xxs px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover"
        >
          <Plus className="w-3 h-3" />
          New Template
        </button>
      </div>

      <div className="px-4 py-2 border-b border-border bg-bg-secondary/40 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTemplateVisibilityMode('linked_only')}
            disabled={!selectedDesign}
            className={`text-xxs px-2 py-1 rounded border transition-colors ${
              effectiveVisibilityMode === 'linked_only'
                ? 'border-accent text-accent bg-accent/10'
                : 'border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            Linked Only
          </button>
          <button
            onClick={() => setTemplateVisibilityMode('linked_plus_custom')}
            disabled={!selectedDesign}
            className={`text-xxs px-2 py-1 rounded border transition-colors ${
              effectiveVisibilityMode === 'linked_plus_custom'
                ? 'border-accent text-accent bg-accent/10'
                : 'border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            Linked + Custom
          </button>
          <button
            onClick={() => setTemplateVisibilityMode('full_library')}
            className={`text-xxs px-2 py-1 rounded border transition-colors ${
              effectiveVisibilityMode === 'full_library'
                ? 'border-accent text-accent bg-accent/10'
                : 'border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover'
            }`}
          >
            Full Library
          </button>
        </div>
        <span className="text-xxs text-text-tertiary">
          {effectiveVisibilityMode === 'linked_only' && 'Showing only the linked template'}
          {effectiveVisibilityMode === 'linked_plus_custom' && 'Showing linked template plus custom templates'}
          {effectiveVisibilityMode === 'full_library' && 'Showing all built-in and custom templates'}
        </span>
      </div>

      {showCreate && (
        <div className="px-4 py-3 border-b border-border bg-bg-secondary/40 flex items-center gap-2">
          <input
            type="text"
            value={newTemplateName}
            onChange={(e) => setNewTemplateName(e.target.value)}
            placeholder="Template name..."
            className="flex-1 bg-bg-primary border border-border rounded px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            onClick={handleCreate}
            disabled={!newTemplateName.trim()}
            className="text-xxs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
          >
            Create
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
        {selectedDesign && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-xs font-semibold text-text-primary uppercase tracking-wider">Linked Template</h4>
                <p className="text-xxs text-text-tertiary mt-0.5">This template is currently used by {selectedDesign.name}.</p>
              </div>
            </div>
            {linkedTemplate ? (
              <TemplateLibraryCard
                template={linkedTemplate}
                isLinked
                designName={selectedDesign.name}
                onOpenEditor={() => setEditingTemplateId(linkedTemplate.id)}
                onDuplicate={() => handleDuplicate(linkedTemplate.id)}
                onDelete={!linkedTemplate.is_builtin ? () => handleDelete(linkedTemplate.id) : undefined}
              />
            ) : (
              <div className="text-center text-xs text-text-tertiary py-6 border border-dashed border-border rounded-lg bg-bg-secondary/20">
                No template linked to this design yet. Choose one below with "Use in Design".
              </div>
            )}
          </div>
        )}

        {showBuiltInSection && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-xs font-semibold text-text-primary uppercase tracking-wider">Built-in HTML Templates</h4>
                <p className="text-xxs text-text-tertiary mt-0.5">Legacy HTML templates are preserved here and can still be opened in the editor.</p>
              </div>
              <span className="text-xxs text-text-tertiary">{builtInTemplates.length} templates</span>
            </div>
            <div className="grid grid-cols-1 gap-3">
              {builtInTemplates.map((tpl) => (
                <TemplateLibraryCard
                  key={tpl.id}
                  template={tpl}
                  isLinked={tpl.id === linkedTemplateId}
                  designName={selectedDesign?.name}
                  onOpenEditor={() => setEditingTemplateId(tpl.id)}
                  onDuplicate={() => handleDuplicate(tpl.id)}
                  onLinkToDesign={selectedDesign ? () => handleLinkTemplate(tpl.id) : undefined}
                />
              ))}
            </div>
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-xs font-semibold text-text-primary uppercase tracking-wider">Custom HTML Templates</h4>
              <p className="text-xxs text-text-tertiary mt-0.5">Your editable copies and custom HTML overlays live here.</p>
            </div>
            <span className="text-xxs text-text-tertiary">{visibleCustomTemplates.length} templates</span>
          </div>
          <div className="grid grid-cols-1 gap-3">
            {visibleCustomTemplates.map((tpl) => (
              <TemplateLibraryCard
                key={tpl.id}
                template={tpl}
                isLinked={tpl.id === linkedTemplateId}
                designName={selectedDesign?.name}
                onOpenEditor={() => setEditingTemplateId(tpl.id)}
                onDuplicate={() => handleDuplicate(tpl.id)}
                onDelete={() => handleDelete(tpl.id)}
                onLinkToDesign={selectedDesign ? () => handleLinkTemplate(tpl.id) : undefined}
              />
            ))}
            {effectiveVisibilityMode === 'linked_only' && (
              <div className="text-center text-xs text-text-tertiary py-6 border border-dashed border-border rounded-lg bg-bg-secondary/20">
                Linked-only mode hides the template library. Switch to Full Library to select a different template.
              </div>
            )}
            {effectiveVisibilityMode !== 'linked_only' && visibleCustomTemplates.length === 0 && (
              <div className="text-center text-xs text-text-tertiary py-8 border border-dashed border-border rounded-lg bg-bg-secondary/20">
                No custom templates yet. Duplicate a built-in template or create a new one to preserve HTML work.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function OverlayStudio({ projectId, script = [], scriptGeneratedAt = null, onScriptChange = null }) {
  const { templates, fetchTemplates } = useOverlay()
  const {
    presets,
    selectedPresetId,
    setSelectedPresetId,
    fetchPresets,
    createPreset,
    linkTemplateToPreset,
    duplicatePreset,
    deletePreset,
  } = usePreset()
  const { addToast } = useToast()
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState('preview')
  const [newDesignName, setNewDesignName] = useState('')
  const [showCreateDesign, setShowCreateDesign] = useState(false)
  const [buildInitialTemplateId, setBuildInitialTemplateId] = useState(null)
  const [designSearch, setDesignSearch] = useState('')
  const [activeDesignTags, setActiveDesignTags] = useState([])
  const [templatesLoaded, setTemplatesLoaded] = useState(false)

  // UX timing telemetry — tracks create→preview and design-edit session durations.
  // Only logs in dev mode; has no effect in production.
  const uxTimingRef = useRef({
    designCreatedAt: null,
    firstPreviewAfterCreateAt: null,
    designEditOpenedAt: null,
    designEditClosedAt: null,
  })

  // Wrap setActiveWorkspaceTab so we can record timing markers on tab transitions.
  const switchWorkspaceTab = useCallback((tab) => {
    const now = performance.now()
    const timing = uxTimingRef.current
    if (import.meta.env.DEV) {
      if (tab === 'design' && activeWorkspaceTab !== 'design') {
        timing.designEditOpenedAt = now
      } else if (tab !== 'design' && activeWorkspaceTab === 'design' && timing.designEditOpenedAt != null) {
        const elapsed = Math.round(now - timing.designEditOpenedAt)
        console.debug('[UX Timing] design-edit session closed after', elapsed, 'ms')
        timing.designEditClosedAt = now
        timing.designEditOpenedAt = null
      }
      if (tab === 'preview' && timing.designCreatedAt != null && timing.firstPreviewAfterCreateAt == null) {
        timing.firstPreviewAfterCreateAt = now
        const elapsed = Math.round(now - timing.designCreatedAt)
        console.debug('[UX Timing] create→preview elapsed', elapsed, 'ms')
      }
    }
    setActiveWorkspaceTab(tab)
  }, [activeWorkspaceTab])

  useEffect(() => {
    fetchPresets()
  }, [fetchPresets])

  useEffect(() => {
    let cancelled = false
    const loadTemplates = async () => {
      await fetchTemplates()
      if (!cancelled) setTemplatesLoaded(true)
    }
    loadTemplates()
    return () => {
      cancelled = true
    }
  }, [fetchTemplates])

  useEffect(() => {
    if (!selectedPresetId && presets.length > 0) {
      setSelectedPresetId(presets[0].id)
    }
  }, [presets, selectedPresetId, setSelectedPresetId])

  const selectedDesign = useMemo(
    () => presets.find(p => p.id === selectedPresetId) || null,
    [presets, selectedPresetId],
  )

  const templateIdSet = useMemo(
    () => new Set(templates.map((tpl) => tpl.id)),
    [templates],
  )

  const designHealth = useMemo(() => {
    const byId = {}
    const summary = { healthy: 0, warning: 0, error: 0 }

    const VIDEO_SECTIONS = ['intro', 'qualifying_results', 'race', 'race_results']

    presets.forEach((preset) => {
      const linkedTemplateId = resolveLinkedTemplateIdForDesign(preset)
      const issues = []

      // Template linkage checks
      if (!linkedTemplateId) {
        issues.push({
          level: 'warning',
          text: 'No template linked. Link a template before building output.',
        })
      } else if (templatesLoaded && !templateIdSet.has(linkedTemplateId)) {
        issues.push({
          level: 'error',
          text: `Linked template "${linkedTemplateId}" is missing from the library.`,
        })
      }

      // Description check
      if (!preset?.description?.trim()) {
        issues.push({
          level: 'warning',
          text: 'Add a short description so this design is easier to identify later.',
        })
      }

      // Sections completeness: warn if all sections have zero configured elements
      const sections = preset?.sections || {}
      const totalElements = VIDEO_SECTIONS.reduce((sum, sec) => {
        const arr = sections[sec]
        return sum + (Array.isArray(arr) ? arr.length : 0)
      }, 0)
      if (totalElements === 0) {
        issues.push({
          level: 'warning',
          text: 'No overlay elements configured. Open Design Suite to add content to sections.',
        })
      }

      // Variables completeness: warn if any variable has an empty value
      const variables = preset?.variables || {}
      const emptyVars = Object.entries(variables).filter(([, v]) => !v?.value?.toString().trim())
      if (emptyVars.length > 0) {
        issues.push({
          level: 'warning',
          text: `${emptyVars.length} variable${emptyVars.length > 1 ? 's have' : ' has'} no value set (${emptyVars.map(([k]) => k).join(', ')}).`,
        })
      }

      let level = 'healthy'
      if (issues.some((issue) => issue.level === 'error')) level = 'error'
      else if (issues.some((issue) => issue.level === 'warning')) level = 'warning'

      summary[level] += 1
      byId[preset.id] = { level, issues }
    })

    return { byId, summary }
  }, [presets, templateIdSet, templatesLoaded])

  const designFilterTags = useMemo(() => {
    const tags = ['linked', 'unlinked', 'built-in', 'custom']
    const templateTags = [...new Set(
      presets
        .map((preset) => resolveLinkedTemplateIdForDesign(preset))
        .filter(Boolean),
    )]
      .sort((a, b) => a.localeCompare(b))
      .map((templateId) => `template:${templateId}`)
    return [...tags, ...templateTags]
  }, [presets])

  const filteredPresets = useMemo(() => {
    const query = designSearch.trim().toLowerCase()
    return presets.filter((preset) => {
      const linkedTemplateId = resolveLinkedTemplateIdForDesign(preset)
      const searchable = [
        preset.id,
        preset.name,
        preset.description,
        linkedTemplateId,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      if (query && !searchable.includes(query)) return false

      if (!activeDesignTags.length) return true

      const presetTags = new Set([
        linkedTemplateId ? 'linked' : 'unlinked',
        preset.is_builtin ? 'built-in' : 'custom',
      ])
      if (linkedTemplateId) {
        presetTags.add(`template:${linkedTemplateId}`)
      }

      return activeDesignTags.every((tag) => presetTags.has(tag))
    })
  }, [presets, designSearch, activeDesignTags])

  const toggleDesignTag = useCallback((tag) => {
    setActiveDesignTags((prev) => {
      if (prev.includes(tag)) return prev.filter((t) => t !== tag)
      return [...prev, tag]
    })
  }, [])

  const handleCreateDesign = useCallback(async () => {
    if (!newDesignName.trim()) return
    const result = await createPreset({
      name: newDesignName.trim(),
      description: 'Overlay design',
      template_id: 'blank',
    })
    if (result?.success) {
      await fetchPresets()
      setSelectedPresetId(result.preset?.id || null)
      setShowCreateDesign(false)
      setNewDesignName('')
      addToast('Overlay design created', 'success')
      // UX timing: record creation time so we can measure create→preview elapsed later.
      if (import.meta.env.DEV) {
        uxTimingRef.current.designCreatedAt = performance.now()
        uxTimingRef.current.firstPreviewAfterCreateAt = null
      }
    } else {
      addToast(result?.error || 'Failed to create design', 'error')
    }
  }, [newDesignName, createPreset, fetchPresets, setSelectedPresetId, addToast])

  const handleDuplicate = useCallback(async (presetId) => {
    const result = await duplicatePreset(presetId)
    if (!result?.success) addToast(result?.error || 'Failed to duplicate design', 'error')
  }, [duplicatePreset, addToast])

  const handleDelete = useCallback(async (presetId) => {
    const result = await deletePreset(presetId)
    if (!result?.success) {
      addToast(result?.error || 'Failed to delete design', 'error')
      return
    }
    if (selectedPresetId === presetId) {
      setSelectedPresetId(null)
    }
  }, [deletePreset, selectedPresetId, setSelectedPresetId, addToast])

  const handleQuickLinkDefaultTemplate = useCallback(async (preset) => {
    if (!preset?.id) return

    let targetPresetId = preset.id
    if (preset.is_builtin) {
      const duplicated = await duplicatePreset(preset.id)
      if (!duplicated?.success || !duplicated?.preset?.id) {
        addToast(duplicated?.error || 'Failed to duplicate built-in design before linking', 'error')
        return
      }
      targetPresetId = duplicated.preset.id
      setSelectedPresetId(targetPresetId)
      addToast('Built-in design duplicated before linking.', 'info')
    }

    const result = await linkTemplateToPreset(targetPresetId, 'blank')
    if (result?.success) {
      setSelectedPresetId(targetPresetId)
      addToast('Design linked to Blank template', 'success')
    } else {
      addToast(result?.error || 'Failed to link design to template', 'error')
    }
  }, [duplicatePreset, linkTemplateToPreset, setSelectedPresetId, addToast])

  const leftPane = (
    <div className="h-full min-h-0 flex flex-col bg-bg-secondary/20">
      <div className="px-4 py-3 border-b border-border bg-bg-secondary">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold">Overlay Studio</h2>
        </div>
        <p className="text-xxs text-text-tertiary mt-1">Top-level selection is design-only. Templates are managed in Build.</p>
      </div>

      <div className="px-4 py-2 border-b border-border flex items-center gap-2">
        <button
          onClick={() => setShowCreateDesign(v => !v)}
          className="flex items-center gap-1 text-xxs px-2 py-1 rounded bg-accent text-white hover:bg-accent-hover"
        >
          <Plus className="w-3 h-3" />
          New Design
        </button>
      </div>

      <div className="px-4 py-2 border-b border-border bg-bg-secondary/40 space-y-2">
        <input
          type="text"
          value={designSearch}
          onChange={(e) => setDesignSearch(e.target.value)}
          placeholder="Search designs by name, id, description, or template..."
          className="w-full bg-bg-primary border border-border rounded px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xxs text-text-tertiary">
            {filteredPresets.length} of {presets.length} designs
          </span>
          {(designSearch.trim() || activeDesignTags.length > 0) && (
            <button
              onClick={() => {
                setDesignSearch('')
                setActiveDesignTags([])
              }}
              className="text-xxs px-2 py-0.5 rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            >
              Clear Filters
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {designFilterTags.map((tag) => {
            const active = activeDesignTags.includes(tag)
            return (
              <button
                key={tag}
                onClick={() => toggleDesignTag(tag)}
                className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                  active
                    ? 'border-accent text-accent bg-accent/10'
                    : 'border-border text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
                }`}
                title={`Filter by ${tag}`}
              >
                {tag}
              </button>
            )
          })}
        </div>
      </div>

      {presets.length > 0 && (
        <div className="px-4 py-2 border-b border-border bg-bg-secondary/20">
          <div className="flex items-center justify-between gap-2 text-xxs">
            <span className="text-text-tertiary">Design Health</span>
            <div className="flex items-center gap-1.5">
              <span className="px-1.5 py-0.5 rounded border border-emerald-500/35 text-emerald-300">
                Healthy {designHealth.summary.healthy}
              </span>
              <span className="px-1.5 py-0.5 rounded border border-amber-500/35 text-amber-300">
                Warnings {designHealth.summary.warning}
              </span>
              <span className="px-1.5 py-0.5 rounded border border-rose-500/35 text-rose-300">
                Errors {designHealth.summary.error}
              </span>
            </div>
          </div>
          {designHealth.summary.error > 0 && (
            <p className="mt-1 text-[10px] text-rose-300/90">
              Some designs reference templates that no longer exist. Open Build or use Link Now to repair.
            </p>
          )}
        </div>
      )}

      {showCreateDesign && (
        <div className="px-4 py-3 border-b border-border bg-bg-secondary/50 flex items-center gap-2">
          <input
            type="text"
            value={newDesignName}
            onChange={(e) => setNewDesignName(e.target.value)}
            placeholder="Design name..."
            className="flex-1 bg-bg-primary border border-border rounded px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            onClick={handleCreateDesign}
            disabled={!newDesignName.trim()}
            className="text-xxs px-3 py-1.5 rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
          >
            Create
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {filteredPresets.map((preset) => {
          const selected = preset.id === selectedPresetId
          const linkedTemplateId = resolveLinkedTemplateIdForDesign(preset)
          const health = designHealth.byId[preset.id] || { level: 'healthy', issues: [] }
          const healthBadgeClass = health.level === 'error'
            ? 'border-rose-500/40 text-rose-300'
            : health.level === 'warning'
              ? 'border-amber-500/40 text-amber-300'
              : 'border-emerald-500/40 text-emerald-300'
          const healthLabel = health.level === 'error'
            ? 'Error'
            : health.level === 'warning'
              ? 'Warning'
              : 'Healthy'
          return (
            <div
              key={preset.id}
              onClick={() => setSelectedPresetId(preset.id)}
              className={`rounded-lg border p-3 cursor-pointer transition-colors ${
                selected
                  ? 'border-accent ring-1 ring-accent/50 bg-accent/5'
                  : 'border-border bg-bg-primary/40 hover:bg-bg-primary/70'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-text-primary truncate flex-1">{preset.name}</span>
                {linkedTemplateId ? (
                  <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-accent/40 text-accent uppercase tracking-wider" title={`Linked template: ${linkedTemplateId}`}>
                    <Link2 className="w-3 h-3" />
                    Linked
                  </span>
                ) : (
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-border text-text-tertiary uppercase tracking-wider" title="No linked template">
                    Unlinked
                  </span>
                )}
                {preset.is_builtin && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-border text-text-tertiary uppercase tracking-wider">Built-in</span>
                )}
                <span className={`text-[10px] px-1.5 py-0.5 rounded border uppercase tracking-wider ${healthBadgeClass}`}>
                  {healthLabel}
                </span>
              </div>
              <p className="text-xxs text-text-tertiary mt-0.5 line-clamp-2">{preset.description || 'No description'}</p>
              <div className="mt-1 text-[10px] text-text-tertiary truncate">
                Template: <span className="text-text-secondary">{linkedTemplateId || 'none'}</span>
              </div>
              {health.issues.length > 0 && (
                <div className={`mt-1 text-[10px] ${health.level === 'error' ? 'text-rose-300' : 'text-amber-300'}`}>
                  {health.issues[0].text}
                </div>
              )}

              <div className="mt-2 flex items-center gap-1">
                <button
                  onClick={(e) => { e.stopPropagation(); setSelectedPresetId(preset.id); switchWorkspaceTab('design') }}
                  className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-purple-700 hover:bg-purple-600 text-white"
                >
                  <PenSquare className="w-3 h-3" />
                  Open Design
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setSelectedPresetId(preset.id); setBuildInitialTemplateId(null); switchWorkspaceTab('build') }}
                  className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover"
                >
                  <Wrench className="w-3 h-3" />
                  Open Build
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!linkedTemplateId) return
                    setSelectedPresetId(preset.id)
                    setBuildInitialTemplateId(linkedTemplateId)
                    switchWorkspaceTab('build')
                  }}
                  disabled={!linkedTemplateId}
                  className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed"
                  title={linkedTemplateId ? 'Open the linked template editor' : 'No linked template for this design'}
                >
                  <Code className="w-3 h-3" />
                  Open Linked Editor
                </button>
                {!linkedTemplateId && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleQuickLinkDefaultTemplate(preset)
                    }}
                    className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-accent/40 text-accent hover:bg-accent/10"
                    title="Link this design to the Blank template"
                  >
                    <Link2 className="w-3 h-3" />
                    Link Now
                  </button>
                )}
                {linkedTemplateId && templatesLoaded && !templateIdSet.has(linkedTemplateId) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setSelectedPresetId(preset.id)
                      setBuildInitialTemplateId(null)
                      switchWorkspaceTab('build')
                      addToast(`Template "${linkedTemplateId}" not found. Select a replacement template below.`, 'warning')
                    }}
                    className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-rose-500/40 text-rose-300 hover:bg-rose-500/10"
                    title="Open Build to relink this design to a valid template"
                  >
                    <Link2 className="w-3 h-3" />
                    Repair Link
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); handleDuplicate(preset.id) }}
                  className="p-1 rounded hover:bg-bg-hover text-text-tertiary"
                  title="Duplicate design"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
                {!preset.is_builtin && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(preset.id) }}
                    className="p-1 rounded hover:bg-danger/10 text-text-tertiary hover:text-danger"
                    title="Delete design"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          )
        })}
        {presets.length === 0 && (
          <div className="text-center text-xs text-text-tertiary py-10">No designs yet. Create your first overlay design.</div>
        )}
        {presets.length > 0 && filteredPresets.length === 0 && (
          <div className="text-center text-xs text-text-tertiary py-10 border border-dashed border-border rounded-lg bg-bg-secondary/20">
            No designs match the current search/tags.
          </div>
        )}
      </div>
    </div>
  )

  const rightPane = (
    <div className="h-full min-h-0 flex flex-col">
      <div className="px-4 py-2 border-b border-border bg-bg-secondary flex items-center justify-between">
        <div className="min-w-0 pr-3">
          {activeWorkspaceTab === 'build' ? (
            <div className="flex items-center gap-2">
              <Wrench className="w-3.5 h-3.5 text-accent" />
              <span className="text-xs font-semibold text-text-primary">Build</span>
            </div>
          ) : (
            <>
              <span className="text-xs text-text-tertiary">Design:</span>
              <span className="text-xs font-semibold text-text-primary ml-1 truncate">{selectedDesign?.name || 'None selected'}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {[
            { id: 'preview', label: 'Preview', icon: Eye },
            { id: 'design', label: 'Design', icon: PenSquare },
            { id: 'build', label: 'Build', icon: Wrench },
            { id: 'data', label: 'Data', icon: Database },
            { id: 'pip', label: 'PiP', icon: PictureInPicture2 },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => {
                if (tab.id === 'build') setBuildInitialTemplateId(null)
                switchWorkspaceTab(tab.id)
              }}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xxs border transition-colors ${
                activeWorkspaceTab === tab.id
                  ? 'border-accent text-accent bg-accent/10'
                  : 'border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover'
              }`}
            >
              <tab.icon className="w-3 h-3" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Symmetry spacer keeps the tab cluster visually centered. */}
        <div className="w-40 shrink-0" aria-hidden="true" />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeWorkspaceTab === 'preview' && (
          <OverlayPreviewStep
            script={script}
            projectId={projectId}
            selectedPresetId={selectedPresetId}
            scriptGeneratedAt={scriptGeneratedAt}
            onScriptChange={onScriptChange}
          />
        )}
        {activeWorkspaceTab === 'design' && selectedPresetId && (
          <PresetDesigner
            presetId={selectedPresetId}
            onClose={() => switchWorkspaceTab('preview')}
            onOpenBuild={() => switchWorkspaceTab('build')}
          />
        )}
        {activeWorkspaceTab === 'design' && !selectedPresetId && (
          <div className="h-full flex items-center justify-center text-xs text-text-tertiary">Select a design to open Design.</div>
        )}
        {activeWorkspaceTab === 'build' && (
          <BuildWorkspace
            selectedDesign={selectedDesign}
            initialTemplateId={buildInitialTemplateId}
          />
        )}
        {activeWorkspaceTab === 'data' && <DataPluginsPanel />}
        {activeWorkspaceTab === 'pip' && <PipConfigurator projectId={projectId} />}
      </div>
    </div>
  )

  return (
    <ResizableSplitPane
      storageKey="lrs:overlay:studioSplitWidth"
      defaultLeftWidth={360}
      minLeft={280}
      maxLeftPct={0.45}
      containerClassName="flex flex-1 w-full min-w-0 h-full min-h-0 bg-bg-primary text-text-primary overflow-hidden relative"
      leftClassName="h-full min-h-0 overflow-hidden"
      rightClassName="h-full min-h-0 overflow-hidden"
      left={leftPane}
      right={rightPane}
    />
  )
}
