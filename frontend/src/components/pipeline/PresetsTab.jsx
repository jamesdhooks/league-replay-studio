import { useState, useCallback } from 'react'
import {
  Plus,
  Edit2,
  Trash2,
} from 'lucide-react'
import PresetEditor from './PresetEditor'

/**
 * PresetsTab — Pipeline presets management with full editor.
 */
function PresetsTab({
  presets,
  createPreset,
  updatePreset,
  deletePreset,
  showSuccess,
  showError,
}) {
  const [editingPresetId, setEditingPresetId] = useState(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const handleCreate = useCallback(async (data) => {
    setIsLoading(true)
    try {
      await createPreset(data)
      showSuccess('Preset created successfully')
      setShowCreateForm(false)
    } catch (err) {
      showError(err.message || 'Failed to create preset')
    } finally {
      setIsLoading(false)
    }
  }, [createPreset, showSuccess, showError])

  const handleUpdate = useCallback(async (data) => {
    setIsLoading(true)
    try {
      await updatePreset(editingPresetId, data)
      showSuccess('Preset updated successfully')
      setEditingPresetId(null)
    } catch (err) {
      showError(err.message || 'Failed to update preset')
    } finally {
      setIsLoading(false)
    }
  }, [editingPresetId, updatePreset, showSuccess, showError])

  const handleDelete = useCallback(async (presetId) => {
    if (!confirm('Are you sure you want to delete this preset?')) return
    setIsLoading(true)
    try {
      await deletePreset(presetId)
      showSuccess('Preset deleted')
    } catch (err) {
      showError(err.message || 'Failed to delete preset')
    } finally {
      setIsLoading(false)
    }
  }, [deletePreset, showSuccess, showError])

  const editingPreset = presets.find(p => p.id === editingPresetId)

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary">Presets</h3>
        {!showCreateForm && !editingPresetId && (
          <button
            onClick={() => setShowCreateForm(true)}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium text-xs transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            New Preset
          </button>
        )}
      </div>

      {/* Create form */}
      {showCreateForm && (
        <div className="p-4 bg-bg-secondary border border-border rounded-lg">
          <PresetEditor
            preset={null}
            onSave={handleCreate}
            onCancel={() => setShowCreateForm(false)}
            isLoading={isLoading}
          />
        </div>
      )}

      {/* Edit form */}
      {editingPreset && (
        <div className="p-4 bg-bg-secondary border border-border rounded-lg">
          <PresetEditor
            preset={editingPreset}
            onSave={handleUpdate}
            onCancel={() => setEditingPresetId(null)}
            isLoading={isLoading}
          />
        </div>
      )}

      {/* Presets list */}
      {!showCreateForm && !editingPresetId && (
        <div className="space-y-2">
          {presets.length === 0 ? (
            <div className="text-center py-8 text-text-tertiary text-xs">
              No presets yet. Create one to get started.
            </div>
          ) : (
            presets.map(preset => (
              <PresetCard
                key={preset.id}
                preset={preset}
                onEdit={() => setEditingPresetId(preset.id)}
                onDelete={() => handleDelete(preset.id)}
                disabled={isLoading}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function PresetCard({ preset, onEdit, onDelete, disabled }) {
  // Build tag list from config highlights
  const tags = []
  if (preset.capture_mode && preset.capture_mode !== 'auto') tags.push(preset.capture_mode)
  if (preset.export_preset) tags.push(preset.export_preset)
  if (preset.non_interactive) tags.push('Headless')
  if (preset.failure_action && preset.failure_action !== 'pause') tags.push(preset.failure_action)
  if (preset.youtube_privacy && preset.youtube_privacy !== 'unlisted') tags.push(preset.youtube_privacy)

  return (
    <div className="p-3 bg-bg-primary border border-border rounded-lg hover:bg-bg-secondary transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h4 className="text-xs font-semibold text-text-primary">{preset.name}</h4>
          {preset.description && (
            <p className="text-xxs text-text-tertiary mt-0.5">{preset.description}</p>
          )}
          <div className="flex flex-wrap gap-1 mt-2">
            {tags.map(tag => (
              <span key={tag} className="px-1.5 py-0.5 text-xxs bg-accent/10 text-accent border border-accent/20 rounded font-medium">
                {tag}
              </span>
            ))}
          </div>
        </div>
        <div className="flex gap-1">
          <button
            onClick={onEdit}
            disabled={disabled}
            className="p-1.5 text-text-tertiary hover:text-accent transition-colors disabled:opacity-50"
            title="Edit preset"
          >
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onDelete}
            disabled={disabled}
            className="p-1.5 text-text-tertiary hover:text-danger transition-colors disabled:opacity-50"
            title="Delete preset"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

export default PresetsTab
