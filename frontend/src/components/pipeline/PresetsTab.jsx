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
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-bg-secondary text-text-secondary rounded-lg hover:bg-bg-hover hover:text-text-primary border border-border transition-colors text-xs font-medium"
        >
          <Settings className="w-3.5 h-3.5" />
          Create New Preset
        </button>
      )}

      {showCreateForm && (
        <div className="p-4 bg-bg-secondary rounded-lg border border-border space-y-3">
          <div>
            <label className="block text-xxs text-text-tertiary uppercase tracking-wider font-semibold mb-1">Name</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData(f => ({ ...f, name: e.target.value }))}
              className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-xs text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="My Preset"
            />
          </div>
          <div>
            <label className="block text-xxs text-text-tertiary uppercase tracking-wider font-semibold mb-1">Description</label>
            <input
              type="text"
              value={formData.description}
              onChange={(e) => setFormData(f => ({ ...f, description: e.target.value }))}
              className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-xs text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
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
                className="w-4 h-4 rounded border-border bg-bg-primary text-accent focus:ring-accent"
              />
              <span className="text-xs text-text-secondary">Upload to YouTube</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.auto_edit}
                onChange={(e) => setFormData(f => ({ ...f, auto_edit: e.target.checked }))}
                className="w-4 h-4 rounded border-border bg-bg-primary text-accent focus:ring-accent"
              />
              <span className="text-xs text-text-secondary">Auto-apply highlights</span>
            </label>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              className="flex-1 px-3 py-2 bg-accent hover:bg-accent-hover text-white rounded-md text-xs font-medium transition-colors"
            >
              Create
            </button>
            <button
              onClick={() => setShowCreateForm(false)}
              className="px-3 py-2 bg-bg-primary text-text-secondary hover:bg-bg-hover border border-border rounded-md text-xs font-medium transition-colors"
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
            className="p-3 bg-bg-secondary rounded-lg border border-border"
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs font-medium text-text-primary">{preset.name}</div>
                <p className="text-xxs text-text-tertiary mt-0.5">{preset.description}</p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {preset.upload_to_youtube && (
                    <span className="px-1.5 py-0.5 text-xxs bg-danger/10 text-danger border border-danger/20 rounded font-medium">
                      YouTube
                    </span>
                  )}
                  {preset.auto_edit && (
                    <span className="px-1.5 py-0.5 text-xxs bg-accent/10 text-accent border border-accent/20 rounded font-medium">
                      Auto-edit
                    </span>
                  )}
                  <span className="px-1.5 py-0.5 text-xxs bg-bg-primary text-text-tertiary border border-border rounded">
                    On fail: {preset.failure_action}
                  </span>
                </div>
              </div>
              <button
                onClick={() => handleDelete(preset.id)}
                className="p-1 text-text-tertiary hover:text-danger transition-colors"
              >
                <XCircle className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}

        {presets.length === 0 && !showCreateForm && (
          <div className="text-center py-8 text-text-tertiary text-xs">
            No presets yet. Create one to get started.
          </div>
        )}
      </div>
    </div>
  )
}

export default PresetsTab
