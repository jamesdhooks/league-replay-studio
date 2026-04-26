import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { usePreset } from '../../context/PresetContext'
import { useToast } from '../../context/ToastContext'
import { Upload, Trash2, Image, Copy, FolderTree, Globe2, RefreshCw, Link2, Unlink2 } from 'lucide-react'

/**
 * AssetManager — Upload and manage image assets for a preset.
 *
 * Assets are stored globally (not per-project) alongside the preset.
 * Images can be referenced in element templates via URL.
 */
export default function AssetManager({ presetId, projectId = null, isBuiltin, onClose }) {
  const { listAssets, uploadAsset, deleteAsset, moveAssetScope, setAssetVariable } = usePreset()
  const { addToast } = useToast()
  const [assets, setAssets] = useState([])
  const [bindings, setBindings] = useState({ defaults: {}, overrides: {}, effective: {} })
  const [uploadScope, setUploadScope] = useState('global')
  const [uploadVariableName, setUploadVariableName] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [busyAssetKey, setBusyAssetKey] = useState('')
  const [variableDrafts, setVariableDrafts] = useState({})
  const fileInputRef = useRef(null)

  const hasProjectContext = Number.isInteger(projectId)

  const assetKey = useCallback((asset) => `${asset.scope}:${asset.filename}`, [])

  const refresh = useCallback(async () => {
    const result = await listAssets(presetId, { projectId })
    setAssets(result.assets || [])
    setBindings(result.bindings || { defaults: {}, overrides: {}, effective: {} })
  }, [presetId, projectId, listAssets])

  useEffect(() => { refresh() }, [refresh])

  const handleUploadFiles = useCallback(async (incomingFiles) => {
    const fileList = Array.from(incomingFiles || [])
    if (!fileList.length) return
    if (uploadScope === 'project' && !hasProjectContext) {
      addToast('Open a project before uploading project-only assets', 'warning')
      return
    }

    for (const file of fileList) {
      const result = await uploadAsset(presetId, file, {
        scope: uploadScope,
        projectId,
        variableName: uploadVariableName.trim() || undefined,
      })
      if (!result.success) {
        addToast(result.error || `Upload failed for ${file.name}`, 'error')
      }
    }

    setUploadVariableName('')
    addToast(fileList.length > 1 ? 'Assets uploaded' : 'Asset uploaded', 'success')
    refresh()
  }, [presetId, uploadAsset, addToast, refresh, uploadScope, projectId, uploadVariableName, hasProjectContext])

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
    } else {
      addToast(result.error || 'Delete failed', 'error')
    }
  }, [presetId, deleteAsset, addToast, refresh, projectId])

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
  }, [assetKey, addToast, hasProjectContext, moveAssetScope, presetId, projectId, refresh])

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
  }, [assetKey])

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
    const result = await setAssetVariable(presetId, variableName, {
      filename: clear ? null : asset.filename,
      scope: mappingScope,
      projectId,
      clear,
    })
    setBusyAssetKey('')

    if (!result.success) {
      addToast(result.error || 'Failed to save mapping', 'error')
      return
    }

    if (clear) {
      setVariableDrafts((prev) => ({ ...prev, [key]: '' }))
      addToast('Variable mapping cleared', 'info')
    } else {
      addToast('Variable mapping saved', 'success')
    }
    refresh()
  }, [addToast, assetKey, getDraftValue, getInitialDraft, hasProjectContext, presetId, projectId, refresh, setAssetVariable])

  const copyUrl = useCallback((asset) => {
    const url = asset.url || `/api/presets/${presetId}/assets/${asset.filename}?scope=${asset.scope}`
    navigator.clipboard.writeText(url)
    addToast('URL copied to clipboard', 'info')
  }, [presetId, addToast])

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
              className="flex w-full items-center gap-2 px-3 py-2.5 hover:bg-blue-500/5 transition-colors rounded-t-md"
            >
              <Upload className="w-4 h-4 text-blue-400 flex-shrink-0" />
              <div className="text-left">
                <p className="text-[11px] font-semibold text-text-primary">Drag and drop assets here</p>
                <p className="text-[10px] text-text-tertiary">or click to browse images</p>
              </div>
            </button>
            {/* Config fields — separate from click target, no bubbling issues */}
            <div className="border-t border-border/50 px-3 py-2 space-y-2">
              <label className="block text-[10px] text-text-tertiary">
                Upload scope
                <select
                  value={uploadScope}
                  onChange={(e) => setUploadScope(e.target.value)}
                  className="mt-1 w-full rounded border border-border bg-bg-secondary px-2 py-1 text-[11px] text-text-primary"
                >
                  <option value="global">Global asset (all projects)</option>
                  <option value="project" disabled={!hasProjectContext}>Project-only asset</option>
                </select>
              </label>
              <label className="block text-[10px] text-text-tertiary">
                Variable name (optional — assign after upload)
                <input
                  value={uploadVariableName}
                  onChange={(e) => setUploadVariableName(e.target.value)}
                  placeholder="ex: logo_primary"
                  className="mt-1 w-full rounded border border-border bg-bg-secondary px-2 py-1 text-[11px] text-text-primary"
                />
              </label>
              {!hasProjectContext && (
                <p className="text-[10px] text-amber-400">Open a project to use project-only storage or project overrides.</p>
              )}
            </div>
          </div>
        )}

        {assets.length === 0 ? (
          <div className="text-center text-text-tertiary text-[10px] py-3">
            No assets uploaded.{!isBuiltin && ' Upload images to use in templates.'}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {assets.map(asset => (
              <div key={`${asset.scope}:${asset.filename}`}
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
                      <span className="flex-1 truncate text-text-secondary text-[10px]">{asset.filename}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full border flex-shrink-0 ${asset.scope === 'global' ? 'border-blue-500/60 text-blue-300' : 'border-emerald-500/60 text-emerald-300'}`}>
                        {asset.scope === 'global' ? 'Global' : 'Project'}
                      </span>
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

                {!isBuiltin && (
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
                            <div className="flex gap-1">
                              <input
                                value={getDraftValue(asset, 'default')}
                                onChange={(e) => setDraftValue(asset, 'default', e.target.value)}
                                placeholder="logo_primary"
                                className="flex-1 rounded border border-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary"
                              />
                              <button
                                onClick={() => applyVariableMapping(asset, 'default', false)}
                                className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-[10px]"
                              >
                                <Link2 className="w-3 h-3 inline mr-1" />Save
                              </button>
                              <button
                                onClick={() => applyVariableMapping(asset, 'default', true)}
                                className="px-2 py-1 rounded bg-bg-primary border border-border text-[10px] text-text-secondary"
                              >
                                <Unlink2 className="w-3 h-3 inline mr-1" />Clear
                              </button>
                            </div>
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
                            <div className="flex gap-1">
                              <input
                                value={getDraftValue(asset, 'override')}
                                onChange={(e) => setDraftValue(asset, 'override', e.target.value)}
                                placeholder="logo_primary"
                                className="flex-1 rounded border border-border bg-bg-primary px-2 py-1 text-[11px] text-text-primary"
                              />
                              <button
                                onClick={() => applyVariableMapping(asset, 'override', false)}
                                className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px]"
                              >
                                <Link2 className="w-3 h-3 inline mr-1" />Save
                              </button>
                              <button
                                onClick={() => applyVariableMapping(asset, 'override', true)}
                                className="px-2 py-1 rounded bg-bg-primary border border-border text-[10px] text-text-secondary"
                              >
                                <Unlink2 className="w-3 h-3 inline mr-1" />Clear
                              </button>
                            </div>
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
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
