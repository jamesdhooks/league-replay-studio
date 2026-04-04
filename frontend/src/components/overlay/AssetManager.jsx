import { useState, useEffect, useCallback } from 'react'
import { usePreset } from '../../context/PresetContext'
import { useToast } from '../../context/ToastContext'
import { X, Upload, Trash2, Image, Copy } from 'lucide-react'

/**
 * AssetManager — Upload and manage image assets for a preset.
 *
 * Assets are stored globally (not per-project) alongside the preset.
 * Images can be referenced in element templates via URL.
 */
export default function AssetManager({ presetId, isBuiltin, onClose }) {
  const { listAssets, uploadAsset, deleteAsset } = usePreset()
  const { addToast } = useToast()
  const [assets, setAssets] = useState([])

  const refresh = useCallback(async () => {
    const result = await listAssets(presetId)
    setAssets(result.assets || [])
  }, [presetId, listAssets])

  useEffect(() => { refresh() }, [refresh])

  const handleUpload = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const result = await uploadAsset(presetId, file)
    if (result.success) {
      addToast('Asset uploaded', 'success')
      refresh()
    } else {
      addToast(result.error || 'Upload failed', 'error')
    }
    e.target.value = ''
  }, [presetId, uploadAsset, addToast, refresh])

  const handleDelete = useCallback(async (filename) => {
    const result = await deleteAsset(presetId, filename)
    if (result.success) {
      addToast('Asset deleted', 'success')
      refresh()
    }
  }, [presetId, deleteAsset, addToast, refresh])

  const copyUrl = useCallback((filename) => {
    const url = `/api/presets/${presetId}/assets/${filename}`
    navigator.clipboard.writeText(url)
    addToast('URL copied to clipboard', 'info')
  }, [presetId, addToast])

  return (
    <div className="border-t border-border bg-bg-secondary/50 max-h-48">
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-border">
        <span className="text-xs font-medium text-text-secondary">Assets ({assets.length})</span>
        <div className="flex items-center gap-1">
          {!isBuiltin && (
            <label className="text-[10px] px-1.5 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-0.5 cursor-pointer">
              <Upload className="w-3 h-3" /> Upload
              <input type="file" accept="image/*" onChange={handleUpload} className="hidden" />
            </label>
          )}
          <button onClick={onClose} className="p-0.5 rounded hover:bg-bg-secondary text-text-tertiary">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="overflow-y-auto max-h-32 p-2">
        {assets.length === 0 ? (
          <div className="text-center text-text-tertiary text-[10px] py-3">
            No assets uploaded.{!isBuiltin && ' Upload images to use in templates.'}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {assets.map(asset => (
              <div key={asset.filename}
                className="flex items-center gap-2 p-1.5 rounded bg-bg-primary border border-border text-xs">
                <Image className="w-4 h-4 text-text-tertiary flex-shrink-0" />
                <span className="flex-1 truncate text-text-secondary text-[10px]">{asset.filename}</span>
                <button onClick={() => copyUrl(asset.filename)}
                  className="p-0.5 rounded hover:bg-bg-secondary text-text-tertiary" title="Copy URL">
                  <Copy className="w-3 h-3" />
                </button>
                {!isBuiltin && (
                  <button onClick={() => handleDelete(asset.filename)}
                    className="p-0.5 rounded hover:bg-red-700/50 text-text-tertiary hover:text-red-400" title="Delete">
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
