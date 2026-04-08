import { useState, useCallback } from 'react'
import {
  Settings,
  XCircle,
} from 'lucide-react'

/**
 * PresetsTab — Pipeline presets management.
 */
function PresetsTab({
  presets,
  createPreset,
  updatePreset,
  deletePreset,
  showSuccess,
  showError,
}) {
  const [editingPreset, setEditingPreset] = useState(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    skip_capture: false,
    skip_analysis: false,
    auto_edit: true,
    upload_to_youtube: false,
    youtube_privacy: 'unlisted',
    failure_action: 'pause',
    notify_on_completion: 'toast',
  })

  const handleCreate = useCallback(async () => {
    if (!formData.name) {
      showError('Name is required')
      return
    }
    try {
      await createPreset(formData)
      showSuccess('Preset created')
      setShowCreateForm(false)
      setFormData({
        name: '',
        description: '',
        skip_capture: false,
        skip_analysis: false,
        auto_edit: true,
        upload_to_youtube: false,
        youtube_privacy: 'unlisted',
        failure_action: 'pause',
        notify_on_completion: 'toast',
      })
    } catch (err) {
      showError(err.message || 'Failed to create preset')
    }
  }, [formData, createPreset, showSuccess, showError])

  const handleDelete = useCallback(async (presetId) => {
    if (!confirm('Delete this preset?')) return
    try {
      await deletePreset(presetId)
      showSuccess('Preset deleted')
    } catch (err) {
      showError(err.message || 'Failed to delete preset')
    }
  }, [deletePreset, showSuccess, showError])

  return (
    <div className="space-y-4">
      {/* Create new */}
      {!showCreateForm && (
        <button
          onClick={() => setShowCreateForm(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-slate-700 text-slate-300 rounded-lg hover:bg-slate-600 hover:text-white transition-colors"
        >
          <Settings className="w-4 h-4" />
          Create New Preset
        </button>
      )}

      {showCreateForm && (
        <div className="p-4 bg-slate-800 rounded-lg border border-slate-600 space-y-3">
          <div>
            <label className="block text-sm text-slate-300 mb-1">Name</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData(f => ({ ...f, name: e.target.value }))}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white focus:border-blue-500"
              placeholder="My Preset"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">Description</label>
            <input
              type="text"
              value={formData.description}
              onChange={(e) => setFormData(f => ({ ...f, description: e.target.value }))}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white focus:border-blue-500"
              placeholder="Describe this preset..."
            />
          </div>
          {/* Quick toggles */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.upload_to_youtube}
                onChange={(e) => setFormData(f => ({ ...f, upload_to_youtube: e.target.checked }))}
                className="w-4 h-4 rounded border-slate-500 bg-slate-700"
              />
              <span className="text-sm text-slate-300">Upload to YouTube</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.auto_edit}
                onChange={(e) => setFormData(f => ({ ...f, auto_edit: e.target.checked }))}
                className="w-4 h-4 rounded border-slate-500 bg-slate-700"
              />
              <span className="text-sm text-slate-300">Auto-apply highlights</span>
            </label>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              className="flex-1 px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-500"
            >
              Create
            </button>
            <button
              onClick={() => setShowCreateForm(false)}
              className="px-3 py-2 bg-slate-600 text-white rounded hover:bg-slate-500"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Preset list */}
      <div className="space-y-2">
        {presets.map(preset => (
          <div
            key={preset.id}
            className="p-3 bg-slate-800 rounded-lg border border-slate-700"
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="font-medium text-white">{preset.name}</div>
                <p className="text-sm text-slate-400">{preset.description}</p>
                <div className="flex flex-wrap gap-2 mt-2">
                  {preset.upload_to_youtube && (
                    <span className="px-2 py-0.5 text-xs bg-red-900/30 text-red-300 rounded">
                      YouTube
                    </span>
                  )}
                  {preset.auto_edit && (
                    <span className="px-2 py-0.5 text-xs bg-blue-900/30 text-blue-300 rounded">
                      Auto-edit
                    </span>
                  )}
                  <span className="px-2 py-0.5 text-xs bg-slate-700 text-slate-300 rounded">
                    On fail: {preset.failure_action}
                  </span>
                </div>
              </div>
              <button
                onClick={() => handleDelete(preset.id)}
                className="p-1 text-slate-400 hover:text-red-400"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}

        {presets.length === 0 && !showCreateForm && (
          <div className="text-center py-8 text-slate-500">
            No presets yet. Create one to get started.
          </div>
        )}
      </div>
    </div>
  )
}

export default PresetsTab
