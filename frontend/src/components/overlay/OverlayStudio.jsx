import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Layers, Plus, Copy, Trash2, Eye, PenSquare, Wrench, Database, PictureInPicture2, Monitor, Film, Palette, Code, Loader2, Sparkles, FolderOpen } from 'lucide-react'
import { usePreset } from '../../context/PresetContext'
import { useScriptState } from '../../context/ScriptStateContext'
import { useToast } from '../../context/ToastContext'
import { useLLM } from '../../context/LLMContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { OverlaySettingsProvider } from '../../context/OverlaySettingsContext'
import OverlayPreviewStep from './OverlayPreviewStep'
import OverlayDataInspector from './OverlayDataInspector'
import PresetDesigner from './PresetDesigner'
import OverlayEditor from './OverlayEditor'
import PipConfigurator from './PipConfigurator'
import ResizableSidebar from '../layout/ResizableSidebar'
import OverlayDesignWizard from './OverlayDesignWizard'
import ProjectFileBrowser from '../projects/ProjectFileBrowser'

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

function DesignThumbnail({ design }) {
  const style = design.style || 'custom'
  const meta = TEMPLATE_STYLE_META[style] || TEMPLATE_STYLE_META.custom

  return (
    <div className={`w-full rounded-lg border overflow-hidden ${meta.cardClass}`}>
      <div className={`relative h-16 ${meta.canvasClass}`}>
        {style === 'broadcast' && (
          <>
            <div className="absolute inset-x-0 top-0 h-3 bg-gradient-to-r from-sky-500 via-slate-100/70 to-sky-500" />
            <div className="absolute top-5 left-2 w-11 space-y-1">
              <div className="h-2 rounded-sm bg-white/85" />
              <div className="h-2 rounded-sm bg-white/70" />
              <div className="h-2 rounded-sm bg-white/55" />
            </div>
          </>
        )}
        {style === 'minimal' && (
          <>
            <div className="absolute inset-x-3 bottom-3 h-4 rounded-full bg-emerald-400/85" />
            <div className="absolute left-4 bottom-8 h-1.5 w-10 rounded-full bg-white/45" />
          </>
        )}
        {style === 'classic' && (
          <>
            <div className="absolute left-0 top-0 bottom-0 w-4 bg-amber-500/85" />
            <div className="absolute left-6 top-4 w-20 space-y-1">
              <div className="h-2 rounded-sm bg-amber-100/90" />
              <div className="h-2 rounded-sm bg-amber-100/75" />
            </div>
          </>
        )}
        {style === 'cinematic' && (
          <>
            <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-500/20 via-transparent to-amber-200/10" />
            <div className="absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-black/85 to-transparent" />
            <div className="absolute left-3 bottom-3 h-2 w-16 rounded-sm bg-white/85" />
          </>
        )}
        {style === 'blank' && (
          <div className="absolute inset-3 rounded border border-dashed border-white/20" />
        )}
        {!['broadcast', 'minimal', 'classic', 'cinematic', 'blank'].includes(style) && (
          <>
            <div className="absolute left-3 top-3 h-2 w-14 rounded-sm bg-indigo-300/70" />
            <div className="absolute left-3 top-7 h-2 w-20 rounded-sm bg-white/30" />
          </>
        )}

      </div>
    </div>
  )
}

export default function OverlayStudio({ projectId, script = [], scriptGeneratedAt = null, onScriptChange = null }) {
  return (
    <OverlaySettingsProvider>
      <OverlayStudioContent projectId={projectId} script={script} scriptGeneratedAt={scriptGeneratedAt} onScriptChange={onScriptChange} />
    </OverlaySettingsProvider>
  )
}

function OverlayStudioContent({ projectId, script = [], scriptGeneratedAt = null, onScriptChange = null }) {
  const {
    presets,
    selectedPresetId,
    setSelectedPresetId,
    fetchPresets,
    duplicatePreset,
    deletePreset,
  } = usePreset()
  const { addToast } = useToast()
  const { overlayUiConfig, fetchOverlayUiConfig, updateOverlayUiConfig } = useScriptState()
  const { isAvailable } = useLLM()
  const [noLlmExplainerSeen, setNoLlmExplainerSeen] = useLocalStorage('lrs:overlay:wizard:no-llm-seen', false)
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState('preview')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardPresetId, setWizardPresetId] = useState(null)
  const [creatingBlank, setCreatingBlank] = useState(false)
  const [selectionHydrated, setSelectionHydrated] = useState(false)
  const toolbarActionsRef = useRef(null)
  const selectionDebugSeqRef = useRef(0)
  const persistedSelectionAppliedRef = useRef(false)

  const debugSelection = (source, detail = {}) => {
    selectionDebugSeqRef.current += 1
    const availablePresetIds = presets.map((p) => p.id)
    // Keep this always-on for now to capture the rapid selection twitch reported by users.
    console.debug('[OverlaySelectionDebug]', {
      seq: selectionDebugSeqRef.current,
      source,
      projectId,
      selectedPresetId,
      persistedPresetId: overlayUiConfig?.selected_preset_id || null,
      presetsCount: availablePresetIds.length,
      presets: availablePresetIds,
      selectionHydrated,
      ...detail,
    })
  }

  const selectPresetWithDebug = useCallback((nextPresetId, source) => {
    const normalized = nextPresetId || null
    debugSelection('setSelectedPresetId', {
      source,
      nextPresetId: normalized,
      prevPresetId: selectedPresetId,
    })
    setSelectedPresetId(normalized)
  }, [selectedPresetId, setSelectedPresetId])

  useEffect(() => {
    debugSelection('fetchPresets:start')
    fetchPresets()
      .then((result) => {
        debugSelection('fetchPresets:done', { fetchedCount: Array.isArray(result) ? result.length : null })
      })
      .catch((err) => {
        debugSelection('fetchPresets:error', { error: err?.message || String(err) })
      })
  }, [fetchPresets])

  useEffect(() => {
    let cancelled = false
    persistedSelectionAppliedRef.current = false
    if (!projectId) {
      debugSelection('hydrate:skip-no-project')
      setSelectionHydrated(true)
      return undefined
    }

    debugSelection('hydrate:start')
    fetchOverlayUiConfig(projectId)
      .finally(() => {
        if (!cancelled) {
          debugSelection('hydrate:done')
          setSelectionHydrated(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [fetchOverlayUiConfig, projectId])

  useEffect(() => {
    if (!selectionHydrated) {
      debugSelection('persisted->local:skip-not-hydrated')
      return
    }

    if (persistedSelectionAppliedRef.current) {
      debugSelection('persisted->local:skip-already-applied')
      return
    }

    const persistedId = overlayUiConfig?.selected_preset_id || null
    if (!persistedId) {
      debugSelection('persisted->local:skip-empty')
      persistedSelectionAppliedRef.current = true
      return
    }

    // Local user selection is authoritative after hydrate; only apply persisted
    // selection on first sync when local is still empty.
    if (selectedPresetId) {
      debugSelection('persisted->local:skip-local-already-set', { persistedId })
      persistedSelectionAppliedRef.current = true
      return
    }

    if (!presets.some((p) => p.id === persistedId)) {
      debugSelection('persisted->local:skip-missing-in-presets', { persistedId })
      persistedSelectionAppliedRef.current = true
      return
    }

    debugSelection('persisted->local:apply', { persistedId })
    selectPresetWithDebug(persistedId, 'effect:persisted->local')
    persistedSelectionAppliedRef.current = true
  }, [overlayUiConfig?.selected_preset_id, presets, selectedPresetId, selectionHydrated, selectPresetWithDebug])

  useEffect(() => {
    if (!selectionHydrated) {
      debugSelection('default-selection:skip-not-hydrated')
      return
    }
    if (!selectedPresetId && presets.length > 0) {
      debugSelection('default-selection:apply-first', { firstPresetId: presets[0].id })
      selectPresetWithDebug(presets[0].id, 'effect:default-first-preset')
      return
    }
    debugSelection('default-selection:skip-has-selection-or-no-presets')
  }, [presets, selectedPresetId, selectionHydrated, selectPresetWithDebug])

  useEffect(() => {
    if (!selectionHydrated || !projectId) {
      debugSelection('local->persisted:skip-not-ready')
      return
    }
    const persistedId = overlayUiConfig?.selected_preset_id || null
    const normalizedSelected = selectedPresetId || null
    if (persistedId === normalizedSelected) {
      debugSelection('local->persisted:skip-already-synced', { persistedId })
      return
    }
    debugSelection('local->persisted:write', {
      fromPersisted: persistedId,
      toSelected: normalizedSelected,
    })
    updateOverlayUiConfig(projectId, { selected_preset_id: normalizedSelected })
      .then((nextConfig) => {
        debugSelection('local->persisted:done', {
          returnedPersisted: nextConfig?.selected_preset_id ?? null,
        })
      })
      .catch((err) => {
        debugSelection('local->persisted:error', { error: err?.message || String(err) })
      })
  }, [overlayUiConfig?.selected_preset_id, projectId, selectedPresetId, selectionHydrated, updateOverlayUiConfig])

  const selectedDesign = useMemo(
    () => presets.find(p => p.id === selectedPresetId) || null,
    [presets, selectedPresetId],
  )

  // When the wizard is open and the user selects a different design in the
  // sidebar, reload the wizard for the new design.
  useEffect(() => {
    if (!wizardOpen || !selectedPresetId) return
    if (selectedPresetId === wizardPresetId) return
    setWizardPresetId(selectedPresetId)
  }, [wizardOpen, selectedPresetId, wizardPresetId])

  const { createPreset } = usePreset()

  const handleWizardComplete = useCallback(async (presetId, tab) => {
    setWizardOpen(false)
    setWizardPresetId(null)
    await fetchPresets()
    selectPresetWithDebug(presetId, 'handleWizardComplete')
    setActiveWorkspaceTab(tab)
    addToast('Overlay design created', 'success')
  }, [fetchPresets, selectPresetWithDebug, addToast])

  // Routes "New Design" click based on LLM availability + whether the explainer has been seen
  const handleNewDesignClick = useCallback(async () => {
    const llmReady = isAvailable()

    // LLM available (or still loading — wizard handles the loading state) → open full wizard
    if (llmReady !== false) {
      setWizardPresetId(null)
      setWizardOpen(true)
      return
    }

    // LLM unavailable and explainer already seen → skip straight to blank preset
    if (noLlmExplainerSeen) {
      setCreatingBlank(true)
      const result = await createPreset({ name: 'New Design', description: 'Overlay design', style: 'blank' })
      setCreatingBlank(false)
      if (result?.success) {
        await fetchPresets()
        selectPresetWithDebug(result.preset?.id || null, 'handleNewDesignClick:createBlank')
        setActiveWorkspaceTab('build')
        addToast('Overlay design created', 'success')
      } else {
        addToast(result?.error || 'Failed to create design', 'error')
      }
      return
    }

    // LLM unavailable, first time → show wizard to display the explainer
    setWizardPresetId(null)
    setWizardOpen(true)
  }, [isAvailable, noLlmExplainerSeen, createPreset, fetchPresets, selectPresetWithDebug, addToast])

  const handleReturnToAiDesigner = useCallback(() => {
    if (!selectedPresetId) {
      addToast('Select a design first', 'warning')
      return
    }
    const llmReady = isAvailable()
    if (llmReady !== true) {
      addToast('Configure AI/LLM in Settings to use AI Designer', 'warning')
      return
    }
    setWizardPresetId(selectedPresetId)
    setWizardOpen(true)
  }, [selectedPresetId, isAvailable, addToast])

  const handleDuplicate = useCallback(async (presetId) => {
    const result = await duplicatePreset(presetId)
    if (!result?.success) addToast(result?.error || 'Failed to duplicate design', 'error')
  }, [duplicatePreset, addToast])

  const handleDelete = useCallback(async (presetId) => {
    if (!window.confirm('Delete this design? This cannot be undone.')) return
    const result = await deletePreset(presetId)
    if (!result?.success) {
      addToast(result?.error || 'Failed to delete design', 'error')
      return
    }
    if (selectedPresetId === presetId) {
      selectPresetWithDebug(null, 'handleDelete:clear-after-delete')
    }
  }, [deletePreset, selectedPresetId, selectPresetWithDebug, addToast])

  const designLibraryPane = (
    <div className="h-full min-h-0 flex flex-col bg-bg-secondary/20">
      <div className="px-4 py-3 border-b border-border bg-bg-secondary">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold">Overlay Studio</h2>
        </div>
        <p className="text-xxs text-text-tertiary mt-1">Select a design, then use tabs to preview, edit, or build.</p>
      </div>

      <div className="px-4 py-2 border-b border-border flex items-center gap-2">
        <button
          onClick={handleNewDesignClick}
          disabled={creatingBlank}
          className="flex items-center gap-1 text-xxs px-2 py-1 rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {creatingBlank ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Plus className="w-3 h-3" />
          )}
          New Design
        </button>
      </div>



      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {presets.map((preset) => {
          const selected = preset.id === selectedPresetId
          return (
            <div
              key={preset.id}
              onClick={() => selectPresetWithDebug(preset.id, 'design-card:onClick')}
              className={`rounded-lg border p-3 cursor-pointer transition-colors ${
                selected
                  ? 'border-accent ring-1 ring-accent/50 bg-accent/5'
                  : 'border-border bg-bg-primary/40 hover:bg-bg-primary/70'
              }`}
            >
              <DesignThumbnail design={preset} />
              <div className="mt-2 flex items-center gap-2">
                <span className="text-xs font-medium text-text-primary truncate flex-1">{preset.name}</span>
              </div>
              <p className="text-xxs text-text-tertiary mt-0.5 line-clamp-2">{preset.description || 'No description'}</p>

              <div className="mt-2 flex items-center gap-1">
                <button
                  onClick={(e) => { e.stopPropagation(); selectPresetWithDebug(preset.id, 'design-card:design-button'); setActiveWorkspaceTab('design') }}
                  className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-purple-700 hover:bg-purple-600 text-white"
                >
                  <PenSquare className="w-3 h-3" />
                  Design
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); selectPresetWithDebug(preset.id, 'design-card:build-button'); setActiveWorkspaceTab('build') }}
                  className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover"
                >
                  <Wrench className="w-3 h-3" />
                  Build
                </button>
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
      </div>
    </div>
  )

  const sidebarTabs = [
    {
      id: 'designs',
      label: 'Designs',
      icon: Layers,
      count: presets.length,
      content: designLibraryPane,
    },
    {
      id: 'files',
      label: 'Files',
      icon: FolderOpen,
      content: <ProjectFileBrowser projectId={projectId} />,
    },
  ]

  const rightPane = (
    <div className="h-full min-h-0 flex flex-col">
      {wizardOpen ? (
        <OverlayDesignWizard
          onComplete={handleWizardComplete}
          onCancel={() => {
            setWizardOpen(false)
            setWizardPresetId(null)
          }}
          onNoLlmSeen={() => setNoLlmExplainerSeen(true)}
          initialPresetId={wizardPresetId}
        />
      ) : (
        <>
          <div className="px-4 py-2 border-b border-border bg-bg-secondary flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto pr-2">
          {[
            { id: 'preview', label: 'Preview', icon: Eye },
            { id: 'design', label: 'Design', icon: PenSquare },
            { id: 'build', label: 'Build', icon: Wrench },
            { id: 'data', label: 'Data', icon: Database },
            { id: 'pip', label: 'PiP', icon: PictureInPicture2 },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveWorkspaceTab(tab.id)}
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

        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 overflow-hidden">
          {selectedDesign && (
            <button
              onClick={handleReturnToAiDesigner}
              disabled={isAvailable() !== true}
              className="shrink-0 inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xxs text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
              title={isAvailable() === true ? 'Return to AI Designer for this design' : 'Configure AI/LLM in Settings to use AI Designer'}
            >
              <Sparkles className="w-3 h-3" />
              AI Designer
            </button>
          )}
          {selectedDesign && (
            <span className="shrink-0 rounded-full border border-border bg-bg-primary/60 px-2 py-1 text-xxs font-medium text-text-secondary">
              Design: {selectedDesign.name}
            </span>
          )}
          <div ref={toolbarActionsRef} className="flex min-w-0 flex-1 items-center justify-end gap-2 flex-wrap" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeWorkspaceTab === 'preview' && (
          <OverlayPreviewStep
            script={script}
            projectId={projectId}
            selectedPresetId={selectedPresetId}
            scriptGeneratedAt={scriptGeneratedAt}
            onScriptChange={onScriptChange}
            toolbarActionsTarget={toolbarActionsRef.current}
          />
        )}
        {activeWorkspaceTab === 'design' && selectedPresetId && (
          <PresetDesigner
            key={selectedPresetId}
            presetId={selectedPresetId}
            onOpenBuild={() => setActiveWorkspaceTab('build')}
            toolbarActionsTarget={toolbarActionsRef.current}
          />
        )}
        {activeWorkspaceTab === 'design' && !selectedPresetId && (
          <div className="h-full flex items-center justify-center text-xs text-text-tertiary">Select a design to open Design.</div>
        )}
        {activeWorkspaceTab === 'build' && selectedPresetId && (
          <OverlayEditor
            key={selectedPresetId}
            designId={selectedPresetId}
            toolbarActionsTarget={toolbarActionsRef.current}
          />
        )}
        {activeWorkspaceTab === 'build' && !selectedPresetId && (
          <div className="h-full flex items-center justify-center text-xs text-text-tertiary">Select a design to open Build.</div>
        )}
        {activeWorkspaceTab === 'data' && <OverlayDataInspector />}
        {activeWorkspaceTab === 'pip' && <PipConfigurator projectId={projectId} />}
      </div>
        </>
      )}
    </div>
  )

  return (
    <div className="flex flex-1 w-full min-w-0 h-full min-h-0 bg-bg-primary text-text-primary overflow-hidden relative">
      <ResizableSidebar
        storageKey="lrs:overlay:studio:sidebar"
        defaultWidth={360}
        defaultTab="designs"
        tabs={sidebarTabs}
      />
      <div className="flex-1 min-h-0 overflow-hidden">
        {rightPane}
      </div>
    </div>
  )
}
