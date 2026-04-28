import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { usePreset } from '../../context/PresetContext'
import { useToast } from '../../context/ToastContext'
import { Upload, Trash2, Image, Copy, FolderTree, Globe2, RefreshCw, Link2, Unlink2, Loader2, CheckCircle2, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'

function parseAssetVariablesFromHtml(html) {
  if (typeof html !== 'string' || !html) return []
  const re = /frame\.assets\.([A-Za-z0-9_]+)/g
  const found = new Set()
  let match = re.exec(html)
  while (match) {
    if (match[1]) found.add(match[1])
    match = re.exec(html)
  }
  return Array.from(found).sort((a, b) => a.localeCompare(b))
}

/**
 * AssetManager — Upload and manage image assets for a preset.
 *
 * Assets are stored globally (not per-project) alongside the preset.
 * Images can be referenced in element templates via URL.
 */
export default function AssetManager({ presetId, projectId = null, isBuiltin, onClose, onAssetsChanged }) {
  const { listAssets, uploadAsset, deleteAsset, moveAssetScope, setAssetVariable, getHtmlContent } = usePreset()
  const { addToast } = useToast()
  const [assets, setAssets] = useState([])
  const [bindings, setBindings] = useState({ defaults: {}, overrides: {}, effective: {} })
  const [templateHtml, setTemplateHtml] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [busyAssetKey, setBusyAssetKey] = useState('')
  const [variableDrafts, setVariableDrafts] = useState({})
  const [mappingStatusByKey, setMappingStatusByKey] = useState({})
  const [newAssetKeys, setNewAssetKeys] = useState([])
  const [expandedGroups, setExpandedGroups] = useState({ new: true, global: true, project: true })
  const [expandedRows, setExpandedRows] = useState({})
  const fileInputRef = useRef(null)
  const initialAssetKeysRef = useRef(null)

  const hasProjectContext = Number.isInteger(projectId)

  const assetKey = useCallback((asset) => `${asset.scope}:${asset.filename}`, [])

  useEffect(() => {
    initialAssetKeysRef.current = null
    setNewAssetKeys([])
    setExpandedRows({})
  }, [presetId, projectId])

  useEffect(() => {
    let mounted = true
    const loadHtml = async () => {
      if (!presetId) {
        if (mounted) setTemplateHtml('')
        return
      }
      const html = await getHtmlContent(presetId)
      if (mounted) setTemplateHtml(html || '')
    }
    loadHtml()
    return () => { mounted = false }
  }, [presetId, getHtmlContent])

  const refresh = useCallback(async () => {
    const result = await listAssets(presetId, { projectId })
    const nextAssets = result.assets || []
    const keys = new Set(nextAssets.map((asset) => assetKey(asset)))
    if (!initialAssetKeysRef.current) {
      initialAssetKeysRef.current = new Set(keys)
      setNewAssetKeys([])
    } else {
      const newlyAddedKeys = Array.from(keys).filter((key) => !initialAssetKeysRef.current.has(key))
      if (newlyAddedKeys.length > 0) {
        setNewAssetKeys((prev) => Array.from(new Set([...prev, ...newlyAddedKeys])))
      }
    }
    setAssets(nextAssets)
    setBindings(result.bindings || { defaults: {}, overrides: {}, effective: {} })
  }, [presetId, projectId, listAssets, assetKey])

  useEffect(() => { refresh() }, [refresh])

  const handleUploadFiles = useCallback(async (incomingFiles) => {
    const fileList = Array.from(incomingFiles || [])
    if (!fileList.length) return

    let successCount = 0

    for (const file of fileList) {
      const result = await uploadAsset(presetId, file, {
        scope: 'global',
        projectId,
      })
      if (!result.success) {
        addToast(result.error || `Upload failed for ${file.name}`, 'error')
      } else {
        successCount += 1
        // Refresh after each successful upload so newly added assets appear immediately.
        await refresh()
      }
    }

    if (successCount > 0) {
      addToast(successCount > 1 ? `${successCount} assets uploaded` : 'Asset uploaded', 'success')
      if (typeof onAssetsChanged === 'function') onAssetsChanged('upload')
    }
  }, [presetId, uploadAsset, addToast, refresh, projectId, onAssetsChanged])

  const handleFileInput = useCallback(async (e) => {
    await handleUploadFiles(e.target.files)
    e.target.value = ''
  }, [handleUploadFiles])

  const handleDrop = useCallback(async (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    await handleUploadFiles(e.dataTransfer?.files)
  }, [handleUploadFiles])

  const handleDelete = useCallback(async (asset) => {
    if (!window.confirm(`Delete asset ${asset.filename}?`)) return
    const result = await deleteAsset(presetId, asset.filename, {
      scope: asset.scope,
      projectId,
    })
    if (result.success) {
      addToast('Asset deleted', 'success')
      refresh()
      if (typeof onAssetsChanged === 'function') onAssetsChanged('delete')
    } else {
      addToast(result.error || 'Delete failed', 'error')
    }
  }, [presetId, deleteAsset, addToast, refresh, projectId, onAssetsChanged])

  const handleScopeSwitch = useCallback(async (asset, targetScope) => {
    if (asset.scope === targetScope) return
    if (targetScope === 'project' && !hasProjectContext) {
      addToast('Open a project before moving assets to project-only scope', 'warning')
      return
    }
    const key = assetKey(asset)
    setBusyAssetKey(key)
    const result = await moveAssetScope(presetId, asset.filename, {
      sourceScope: asset.scope,
      targetScope,
      projectId,
    })
    setBusyAssetKey('')
    if (!result.success) {
      addToast(result.error || 'Failed to move asset', 'error')
      return
    }
    addToast('Asset scope updated', 'success')
    refresh()
    if (typeof onAssetsChanged === 'function') onAssetsChanged('scope')
  }, [assetKey, addToast, hasProjectContext, moveAssetScope, presetId, projectId, refresh, onAssetsChanged])

  const variableListsByAsset = useMemo(() => {
    const buildIndex = (group) => {
      const index = {}
      Object.entries(group || {}).forEach(([variableName, binding]) => {
        const filename = binding?.filename
        const scope = binding?.scope
        if (!filename || !scope) return
        const key = `${scope}:${filename}`
        if (!index[key]) index[key] = []
        index[key].push(variableName)
      })
      Object.keys(index).forEach((key) => index[key].sort())
      return index
    }
    return {
      defaults: buildIndex(bindings.defaults),
      overrides: buildIndex(bindings.overrides),
      effective: buildIndex(bindings.effective),
    }
  }, [bindings])

  const getInitialDraft = useCallback((asset, mode) => {
    const key = assetKey(asset)
    if (mode === 'override') {
      return variableListsByAsset.overrides[key]?.[0] || ''
    }
    return variableListsByAsset.defaults[key]?.[0] || ''
  }, [assetKey, variableListsByAsset])

  const getDraftValue = useCallback((asset, mode) => {
    const key = `${assetKey(asset)}:${mode}`
    return variableDrafts[key] ?? getInitialDraft(asset, mode)
  }, [assetKey, variableDrafts, getInitialDraft])

  const setDraftValue = useCallback((asset, mode, value) => {
    const key = `${assetKey(asset)}:${mode}`
    setVariableDrafts((prev) => ({ ...prev, [key]: value }))
    setMappingStatusByKey((prev) => {
      if (!prev[key]) return prev
      return { ...prev, [key]: { state: 'idle', message: '' } }
    })
  }, [assetKey])

  const getAssignedValue = useCallback((asset, mode) => {
    const key = assetKey(asset)
    if (mode === 'override') {
      return variableListsByAsset.overrides[key]?.[0] || ''
    }
    return variableListsByAsset.defaults[key]?.[0] || ''
  }, [assetKey, variableListsByAsset])

  const applyVariableMapping = useCallback(async (asset, mode, clear = false) => {
    const mappingScope = mode === 'override' ? 'project' : 'global'
    if (mappingScope === 'project' && !hasProjectContext) {
      addToast('Open a project to set project overrides', 'warning')
      return
    }

    const draftValue = getDraftValue(asset, mode).trim()
    const variableName = draftValue || getInitialDraft(asset, mode)
    if (!variableName) {
      addToast('Enter a variable name first', 'warning')
      return
    }

    const key = `${assetKey(asset)}:${mode}`
    setBusyAssetKey(key)
    setMappingStatusByKey((prev) => ({ ...prev, [key]: { state: 'saving', message: clear ? 'Clearing…' : 'Saving…' } }))
    const result = await setAssetVariable(presetId, variableName, {
      filename: clear ? null : asset.filename,
      scope: mappingScope,
      projectId,
      clear,
    })
    setBusyAssetKey('')

    if (!result.success) {
      setMappingStatusByKey((prev) => ({ ...prev, [key]: { state: 'error', message: result.error || 'Failed to save mapping' } }))
      addToast(result.error || 'Failed to save mapping', 'error')
      return
    }

    if (clear) {
      setVariableDrafts((prev) => ({ ...prev, [key]: '' }))
      setMappingStatusByKey((prev) => ({ ...prev, [key]: { state: 'saved', message: 'Cleared' } }))
      addToast('Variable mapping cleared', 'info')
    } else {
      setMappingStatusByKey((prev) => ({ ...prev, [key]: { state: 'saved', message: 'Saved' } }))
      addToast('Variable mapping saved', 'success')
    }
    refresh()
    if (typeof onAssetsChanged === 'function') onAssetsChanged('mapping')
  }, [addToast, assetKey, getDraftValue, getInitialDraft, hasProjectContext, presetId, projectId, refresh, setAssetVariable, onAssetsChanged])

  const copyUrl = useCallback((asset) => {
    const url = asset.url || `/api/presets/${presetId}/assets/${asset.filename}?scope=${asset.scope}`
    navigator.clipboard.writeText(url)
    addToast('URL copied to clipboard', 'info')
  }, [presetId, addToast])

  const htmlAssetVariables = useMemo(
    () => parseAssetVariablesFromHtml(templateHtml),
    [templateHtml],
  )
  const linkedAssetVariables = useMemo(
    () => Object.keys(bindings?.effective || {}).sort((a, b) => a.localeCompare(b)),
    [bindings],
  )
  const linkedSet = useMemo(() => new Set(linkedAssetVariables), [linkedAssetVariables])
  const unlinkedAssetVariables = useMemo(
    () => htmlAssetVariables.filter((name) => !linkedSet.has(name)),
    [htmlAssetVariables, linkedSet],
  )

  const newAssetKeySet = useMemo(() => new Set(newAssetKeys), [newAssetKeys])
  const newAssets = useMemo(
    () => assets.filter((asset) => newAssetKeySet.has(assetKey(asset))),
    [assets, newAssetKeySet, assetKey],
  )
  const nonNewAssets = useMemo(
    () => assets.filter((asset) => !newAssetKeySet.has(assetKey(asset))),
    [assets, newAssetKeySet, assetKey],
  )
  const globalAssets = useMemo(
    () => nonNewAssets.filter((asset) => asset.scope === 'global'),
    [nonNewAssets],
  )
  const projectAssets = useMemo(
    () => nonNewAssets.filter((asset) => asset.scope === 'project'),
    [nonNewAssets],
  )

  const toggleGroup = useCallback((group) => {
    setExpandedGroups((prev) => ({ ...prev, [group]: !prev[group] }))
  }, [])

  const toggleRow = useCallback((key) => {
    setExpandedRows((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg-secondary/50">
      <div className="flex shrink-0 items-center justify-between px-4 py-1.5 border-b border-border">
        <span className="text-xs font-medium text-text-secondary">Assets ({assets.length})</span>
        <button
          onClick={refresh}
          className="text-[10px] px-1.5 py-0.5 rounded bg-bg-primary border border-border hover:bg-bg-secondary text-text-secondary flex items-center gap-1"
          title="Refresh assets"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {!isBuiltin && (
          <div
            className={`mb-3 rounded-md border border-dashed transition-colors ${
              isDragging ? 'border-blue-400 bg-blue-500/10' : 'border-border bg-bg-primary/70'
            }`}
            onDragEnter={(e) => { e.preventDefault(); setIsDragging(true) }}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={(e) => { e.preventDefault(); setIsDragging(false) }}
            onDrop={handleDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileInput}
              className="hidden"
            />
            {/* Clickable drag-and-drop zone — only this area opens the picker */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center gap-2 px-3 py-2.5 hover:bg-blue-500/5 transition-colors rounded-md"
            >
              <Upload className="w-4 h-4 text-blue-400 flex-shrink-0" />
              <div className="text-left">
                <p className="text-[11px] font-semibold text-text-primary">Drag and drop assets here</p>
                <p className="text-[10px] text-text-tertiary">or click to browse images (uploads start as Global; change scope inline)</p>
              </div>
            </button>
          </div>
        )}

        {unlinkedAssetVariables.length > 0 && (
          <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="flex items-center justify-between gap-2 mb-1">
              <p className="text-[11px] font-semibold text-amber-200">Unlinked asset variables in template</p>
              <span className="text-[9px] px-1.5 py-0.5 rounded-full border border-amber-400/50 text-amber-200">
                {unlinkedAssetVariables.length}
              </span>
            </div>
            <p className="text-[10px] text-amber-100/85 mb-1.5">Use these names when mapping newly uploaded images.</p>
            <div className="space-y-1">
              {unlinkedAssetVariables.map((name) => {
                const token = `{{ frame.assets.${name} }}`
                return (
                  <div key={name} className="flex items-center gap-1 rounded border border-amber-500/25 bg-black/15 px-1.5 py-1">
                    <code className="text-[10px] font-mono text-amber-100 flex-1 truncate">{token}</code>
                    <button
                      onClick={() => { navigator.clipboard.writeText(name); addToast('Variable name copied', 'info') }}
                      className="p-0.5 rounded hover:bg-amber-500/20 text-amber-200 flex-shrink-0"
                      title="Copy variable name"
                    >
                      <Copy className="w-2.5 h-2.5" />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {assets.length === 0 ? (
          <div className="text-center text-text-tertiary text-[10px] py-3">
            No assets uploaded.{!isBuiltin && ' Upload images to use in templates.'}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {[
              { id: 'new', label: 'New', icon: Upload, assets: newAssets, badgeClass: 'text-blue-300 border-blue-500/50 bg-blue-500/10' },
              { id: 'global', label: 'Global assets', icon: Globe2, assets: globalAssets, badgeClass: 'text-blue-300 border-blue-500/50 bg-blue-500/10' },
              { id: 'project', label: 'Project assets', icon: FolderTree, assets: projectAssets, badgeClass: 'text-emerald-300 border-emerald-500/50 bg-emerald-500/10' },
            ].map((group) => {
              if (group.assets.length === 0) return null
              const GroupIcon = group.icon
              const open = expandedGroups[group.id]
              return (
                <div key={group.id} className="rounded border border-border bg-bg-primary/70 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.id)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-text-secondary hover:bg-bg-secondary/50"
                  >
                    {open ? <ChevronDown className="w-3 h-3 text-text-tertiary" /> : <ChevronRight className="w-3 h-3 text-text-tertiary" />}
                    <GroupIcon className="w-3.5 h-3.5" />
                    <span className="font-semibold text-text-primary">{group.label}</span>
                    <span className={`ml-auto text-[9px] px-1.5 py-0.5 rounded-full border ${group.badgeClass}`}>{group.assets.length}</span>
                  </button>

                  {open && (
                    <div className="space-y-2 p-2 border-t border-border/40">
                      {group.assets.map((asset) => {
                        const rowKey = assetKey(asset)
                        const isNew = newAssetKeySet.has(rowKey)
                        const isRowOpen = expandedRows[rowKey] ?? isNew
                        return (
              <div key={rowKey}
                className="rounded bg-bg-primary border border-border text-xs">
                {/* Image preview + header row */}
                <div className="flex items-start gap-2 p-2">
                  {asset.url ? (
                    <img
                      src={asset.url}
                      alt={asset.filename}
                      className="w-14 h-10 object-cover rounded border border-border bg-bg-secondary flex-shrink-0"
                      onError={(e) => { e.currentTarget.style.display = 'none' }}
                    />
                  ) : (
                    <Image className="w-4 h-4 text-text-tertiary flex-shrink-0 mt-1" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => toggleRow(rowKey)}
                        className="p-0.5 rounded hover:bg-bg-secondary text-text-tertiary"
                        title={isRowOpen ? 'Collapse details' : 'Expand details'}
                      >
                        {isRowOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      </button>
                      <span className="flex-1 truncate text-text-secondary text-[10px]">{asset.filename}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full border flex-shrink-0 ${asset.scope === 'global' ? 'border-blue-500/60 text-blue-300' : 'border-emerald-500/60 text-emerald-300'}`}>
                        {asset.scope === 'global' ? 'Global' : 'Project'}
                      </span>
                      {isNew && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full border border-blue-400/70 text-blue-300 bg-blue-500/10">
                          New
                        </span>
                      )}
                      <button onClick={() => copyUrl(asset)}
                        className="p-0.5 rounded hover:bg-bg-secondary text-text-tertiary flex-shrink-0" title="Copy URL">
                        <Copy className="w-3 h-3" />
                      </button>
                      {!isBuiltin && (
                        <button onClick={() => handleDelete(asset)}
                          className="p-0.5 rounded hover:bg-red-700/50 text-text-tertiary hover:text-red-400 flex-shrink-0" title="Delete">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    {/* Effective template tokens — prominently shown here */}
                    {variableListsByAsset.effective[assetKey(asset)]?.length > 0 && (
                      <div className="mt-1.5 space-y-1">
                        {variableListsByAsset.effective[assetKey(asset)].map((name) => {
                          const token = `{{ frame.assets.${name} }}`
                          return (
                            <div key={name} className="flex items-center gap-1 rounded border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5">
                              <code className="text-[10px] font-mono text-blue-300 flex-1 truncate">{token}</code>
                              <button
                                onClick={() => { navigator.clipboard.writeText(token); addToast('Token copied', 'info') }}
                                className="p-0.5 rounded hover:bg-blue-500/20 text-blue-400 flex-shrink-0"
                                title="Copy template token"
                              >
                                <Copy className="w-2.5 h-2.5" />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {!isBuiltin && isRowOpen && (
                  <div className="border-t border-border/50 p-2 space-y-2">
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-[160px_1fr] items-start">
                      <label className="text-[10px] text-text-tertiary">
                        Storage scope
                        <select
                          value={asset.scope}
                          disabled={busyAssetKey === assetKey(asset)}
                          onChange={(e) => handleScopeSwitch(asset, e.target.value)}
                          className="mt-1 w-full rounded border border-border bg-bg-secondary px-2 py-1 text-[11px] text-text-primary"
                        >
                          <option value="global">Global store</option>
                          <option value="project" disabled={!hasProjectContext}>Project-only store</option>
                        </select>
                      </label>

                      <div className="space-y-2">
                        {asset.scope === 'global' && (
                          <div className="rounded border border-border/70 p-2 bg-bg-secondary/50">
                            <div className="flex items-center gap-1 text-[10px] text-text-secondary mb-1">
                              <Globe2 className="w-3 h-3" /> Default variable mapping
                            </div>
                            {(() => {
                              const mode = 'default'
                              const draft = getDraftValue(asset, mode).trim()
                              const assigned = getAssignedValue(asset, mode)
                              const key = `${assetKey(asset)}:${mode}`
                              const status = mappingStatusByKey[key] || { state: 'idle', message: '' }
                              const hasChanges = draft.length > 0 && draft !== assigned
                              return (
                            <>
                            <div className="flex gap-1">
                              <input
                                value={getDraftValue(asset, mode)}
                                onChange={(e) => setDraftValue(asset, mode, e.target.value)}
                                placeholder="Enter variable name (e.g. logo_primary)"
                                className="flex-1 rounded border border-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary"
                              />
                              {hasChanges && (
                                <button
                                  onClick={() => applyVariableMapping(asset, mode, false)}
                                  className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-[10px]"
                                >
                                  {busyAssetKey === key ? <Loader2 className="w-3 h-3 inline mr-1 animate-spin" /> : <Link2 className="w-3 h-3 inline mr-1" />}Save
                                </button>
                              )}
                              <button
                                onClick={() => applyVariableMapping(asset, mode, true)}
                                disabled={!assigned}
                                className="px-2 py-1 rounded bg-bg-primary border border-border text-[10px] text-text-secondary"
                              >
                                <Unlink2 className="w-3 h-3 inline mr-1" />Clear
                              </button>
                            </div>
                            {status.state !== 'idle' && (
                              <div className={`mt-1 text-[10px] flex items-center gap-1 ${status.state === 'error' ? 'text-red-300' : 'text-text-tertiary'}`}>
                                {status.state === 'saving' && <Loader2 className="w-3 h-3 animate-spin" />}
                                {status.state === 'saved' && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
                                {status.state === 'error' && <AlertTriangle className="w-3 h-3" />}
                                <span>{status.message}</span>
                              </div>
                            )}
                            </>
                              )
                            })()}
                            {variableListsByAsset.defaults[assetKey(asset)]?.length > 0 && (
                              <p className="mt-1 text-[10px] text-text-tertiary">
                                Assigned: {variableListsByAsset.defaults[assetKey(asset)].join(', ')}
                              </p>
                            )}
                          </div>
                        )}

                        {hasProjectContext && (
                          <div className="rounded border border-border/70 p-2 bg-bg-secondary/50">
                            <div className="flex items-center gap-1 text-[10px] text-text-secondary mb-1">
                              <FolderTree className="w-3 h-3" /> Per-project override
                            </div>
                            {(() => {
                              const mode = 'override'
                              const draft = getDraftValue(asset, mode).trim()
                              const assigned = getAssignedValue(asset, mode)
                              const key = `${assetKey(asset)}:${mode}`
                              const status = mappingStatusByKey[key] || { state: 'idle', message: '' }
                              const hasChanges = draft.length > 0 && draft !== assigned
                              return (
                            <>
                            <div className="flex gap-1">
                              <input
                                value={getDraftValue(asset, mode)}
                                onChange={(e) => setDraftValue(asset, mode, e.target.value)}
                                placeholder="Enter variable name (e.g. logo_primary)"
                                className="flex-1 rounded border border-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary"
                              />
                              {hasChanges && (
                                <button
                                  onClick={() => applyVariableMapping(asset, mode, false)}
                                  className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px]"
                                >
                                  {busyAssetKey === key ? <Loader2 className="w-3 h-3 inline mr-1 animate-spin" /> : <Link2 className="w-3 h-3 inline mr-1" />}Save
                                </button>
                              )}
                              <button
                                onClick={() => applyVariableMapping(asset, mode, true)}
                                disabled={!assigned}
                                className="px-2 py-1 rounded bg-bg-primary border border-border text-[10px] text-text-secondary"
                              >
                                <Unlink2 className="w-3 h-3 inline mr-1" />Clear
                              </button>
                            </div>
                            {status.state !== 'idle' && (
                              <div className={`mt-1 text-[10px] flex items-center gap-1 ${status.state === 'error' ? 'text-red-300' : 'text-text-tertiary'}`}>
                                {status.state === 'saving' && <Loader2 className="w-3 h-3 animate-spin" />}
                                {status.state === 'saved' && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
                                {status.state === 'error' && <AlertTriangle className="w-3 h-3" />}
                                <span>{status.message}</span>
                              </div>
                            )}
                            </>
                              )
                            })()}
                            {variableListsByAsset.overrides[assetKey(asset)]?.length > 0 && (
                              <p className="mt-1 text-[10px] text-text-tertiary">
                                Overrides: {variableListsByAsset.overrides[assetKey(asset)].join(', ')}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
