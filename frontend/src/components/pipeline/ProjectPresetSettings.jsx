import { useState, useCallback, useEffect } from 'react'
import { apiGet, apiPut } from '../../services/api'
import {
  Settings,
  Save,
  X,
  AlertCircle,
} from 'lucide-react'
import PresetEditor from './PresetEditor'

/**
 * ProjectPresetSettings — Manage per-project preset selection and overrides.
 *
 * Shows active preset, current project-level overrides, and allows:
 * - Switching which preset applies to this project
 * - Editing project-level overrides (patches applied on top of preset)
 */

export default function ProjectPresetSettings({ projectId, presets, onClose, showSuccess, showError }) {
  const [projectSettings, setProjectSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showOverrideEditor, setShowOverrideEditor] = useState(false)
  const [selectedPresetId, setSelectedPresetId] = useState(null)
  const [overrides, setOverrides] = useState({})

  // Fetch project settings on mount
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const data = await apiGet(`/pipeline/projects/${projectId}/control-state`)
        setProjectSettings(data)
        setSelectedPresetId(data.preset_id || '')
        setOverrides(data.overrides || {})
      } catch (err) {
        showError('Failed to load project settings')
        console.error(err)
      } finally {
        setLoading(false)
      }
    }
    fetchSettings()
  }, [projectId, showError])

  const handleChangePreset = useCallback(async (presetId) => {
    setLoading(true)
    try {
      // Autosave the currently resolved envelope before switching preset base.
      if (projectSettings) {
        await apiPut(`/pipeline/projects/${projectId}/control-state`, {
          schema_version: projectSettings.schema_version || 1,
          preset_id: projectSettings.preset_id || '',
          overrides: projectSettings.overrides || {},
          controls: projectSettings.controls || {},
        })
      }

      const result = await apiPut(`/pipeline/projects/${projectId}/control-state`, {
        schema_version: projectSettings?.schema_version || 1,
        preset_id: presetId,
        overrides: overrides,
        controls: projectSettings?.controls || {},
      })
      setProjectSettings(result)
      setSelectedPresetId(result.preset_id || '')
      setOverrides(result.overrides || {})
      showSuccess(`Switched to preset: ${presets.find(p => p.id === presetId)?.name || 'Default'}`)
    } catch (err) {
      showError('Failed to switch preset')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [projectId, projectSettings, overrides, presets, showSuccess, showError])

  const handleSaveOverrides = useCallback(async (newOverrides) => {
    setLoading(true)
    try {
      const result = await apiPut(`/pipeline/projects/${projectId}/control-state`, {
        schema_version: projectSettings?.schema_version || 1,
        preset_id: selectedPresetId,
        overrides: newOverrides,
        controls: projectSettings?.controls || {},
      })
      setProjectSettings(result)
      setOverrides(result.overrides || {})
      setShowOverrideEditor(false)
      showSuccess('Project overrides saved')
    } catch (err) {
      showError('Failed to save overrides')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [projectId, selectedPresetId, projectSettings, showSuccess, showError])

  const activePreset = presets.find(p => p.id === selectedPresetId)
  const overrideCount = Object.keys(overrides).length

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-border">
        <h3 className="text-sm font-semibold text-text-primary">Pipeline Preset Configuration</h3>
        <button
          onClick={onClose}
          className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <p className="text-xs text-text-tertiary">Loading settings...</p>
        </div>
      ) : (
        <>
          {/* Active Preset Badge */}
          <div className="p-3 bg-accent/10 border border-accent/20 rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xxs font-medium text-text-tertiary uppercase tracking-wider mb-1">Active Preset</p>
                <p className="text-sm font-semibold text-accent">{activePreset?.name || 'None'}</p>
                {activePreset?.description && (
                  <p className="text-xs text-text-tertiary mt-1">{activePreset.description}</p>
                )}
              </div>
              {overrideCount > 0 && (
                <div className="px-2 py-1 bg-warning/20 border border-warning/30 rounded text-xxs font-medium text-warning">
                  {overrideCount} override{overrideCount !== 1 ? 's' : ''}
                </div>
              )}
            </div>
          </div>

          {/* Preset Selector */}
          <div className="space-y-2">
            <label className="block text-xs font-medium text-text-secondary">Switch Preset</label>
            <div className="space-y-1.5">
              {presets.map(preset => (
                <button
                  key={preset.id}
                  onClick={() => handleChangePreset(preset.id)}
                  disabled={loading}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all ${
                    selectedPresetId === preset.id
                      ? 'border-accent bg-accent/10 ring-1 ring-accent/20'
                      : 'border-border bg-bg-primary hover:bg-bg-hover'
                  } disabled:opacity-50`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <p className="text-xs font-medium text-text-primary">{preset.name}</p>
                      <p className="text-xxs text-text-tertiary mt-0.5">{preset.description}</p>
                    </div>
                    {selectedPresetId === preset.id && (
                      <div className="px-1.5 py-0.5 bg-accent text-white rounded text-xxs font-medium">
                        Active
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Current Overrides */}
          {overrideCount > 0 && (
            <div className="p-3 bg-bg-secondary border border-border rounded-lg space-y-2">
              <div className="flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 text-warning" />
                <p className="text-xs font-medium text-text-secondary">Project Overrides</p>
              </div>
              <div className="space-y-1 text-xxs text-text-tertiary">
                {Object.entries(overrides).map(([key, value]) => (
                  <div key={key} className="flex items-start gap-2">
                    <span className="font-mono text-text-secondary">{key}:</span>
                    <span className="truncate">
                      {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Edit Overrides Button */}
          {!showOverrideEditor && (
            <button
              onClick={() => setShowOverrideEditor(true)}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-bg-secondary hover:bg-bg-hover border border-border rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
            >
              <Settings className="w-4 h-4" />
              {overrideCount > 0 ? 'Edit Project Overrides' : 'Add Project Overrides'}
            </button>
          )}

          {/* Override Editor Modal */}
          {showOverrideEditor && (
            <div className="space-y-3 p-4 bg-bg-secondary border border-border rounded-lg">
              <OverrideEditor
                currentOverrides={overrides}
                onSave={handleSaveOverrides}
                onCancel={() => setShowOverrideEditor(false)}
                isLoading={loading}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * OverrideEditor — Edit per-project overrides (partial form).
 *
 * Shows only the most common override fields for quick customization.
 * Users can override without editing the full global preset.
 */
function OverrideEditor({ currentOverrides, onSave, onCancel, isLoading }) {
  const [data, setData] = useState(currentOverrides || {})

  const handleChange = (key, value) => {
    setData(prev => {
      const next = { ...prev }
      if (value === false || value === '' || value === null) {
        delete next[key]
      } else {
        next[key] = value
      }
      return next
    })
  }

  const handleSave = () => {
    onSave(data)
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-tertiary">Override individual settings for this project. Leave empty to use preset defaults.</p>

      <div className="space-y-3 bg-bg-primary p-3 rounded-lg border border-border">
        {/* Common overrides */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer mb-1">
            <input
              type="checkbox"
              checked={!!data.upload_to_youtube}
              onChange={(e) => handleChange('upload_to_youtube', e.target.checked || undefined)}
              disabled={isLoading}
              className="w-4 h-4 rounded border-border bg-bg-primary text-accent focus:ring-accent"
            />
            <span className="text-xs text-text-secondary">Upload to YouTube</span>
          </label>
          {data.upload_to_youtube && (
            <div className="ml-6 space-y-1">
              <label className="block text-xxs text-text-tertiary">Privacy level</label>
              <select
                value={data.youtube_privacy || 'unlisted'}
                onChange={(e) => handleChange('youtube_privacy', e.target.value)}
                disabled={isLoading}
                className="w-full px-2 py-1 bg-bg-secondary border border-border rounded text-xs focus:border-accent focus:outline-none"
              >
                <option value="private">Private</option>
                <option value="unlisted">Unlisted</option>
                <option value="public">Public</option>
              </select>
            </div>
          )}
        </div>

        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={!!data.auto_edit}
              onChange={(e) => handleChange('auto_edit', e.target.checked || undefined)}
              disabled={isLoading}
              className="w-4 h-4 rounded border-border bg-bg-primary text-accent focus:ring-accent"
            />
            <span className="text-xs text-text-secondary">Auto-apply Highlights</span>
          </label>
        </div>

        <div>
          <label className="block text-xxs text-text-tertiary mb-1">Output Directory</label>
          <input
            type="text"
            value={data.output_dir || ''}
            onChange={(e) => handleChange('output_dir', e.target.value || undefined)}
            disabled={isLoading}
            placeholder="Leave empty to use preset default"
            className="w-full px-2 py-1 bg-bg-secondary border border-border rounded text-xs focus:border-accent focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-xxs text-text-tertiary mb-1">Export Preset</label>
          <input
            type="text"
            value={data.export_preset || ''}
            onChange={(e) => handleChange('export_preset', e.target.value || undefined)}
            disabled={isLoading}
            placeholder="e.g., mp4-hq"
            className="w-full px-2 py-1 bg-bg-secondary border border-border rounded text-xs focus:border-accent focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-xxs text-text-tertiary mb-1">Failure Action</label>
          <select
            value={data.failure_action || ''}
            onChange={(e) => handleChange('failure_action', e.target.value || undefined)}
            disabled={isLoading}
            className="w-full px-2 py-1 bg-bg-secondary border border-border rounded text-xs focus:border-accent focus:outline-none"
          >
            <option value="">Use preset default</option>
            <option value="pause">Pause on failure</option>
            <option value="skip">Skip step</option>
            <option value="abort">Abort pipeline</option>
          </select>
        </div>
      </div>

      {/* Buttons */}
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={isLoading}
          className="flex items-center justify-center gap-1.5 flex-1 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white rounded font-medium text-xs transition-colors disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" />
          Save
        </button>
        <button
          onClick={onCancel}
          disabled={isLoading}
          className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-bg-primary hover:bg-bg-secondary border border-border rounded font-medium text-xs transition-colors disabled:opacity-50"
        >
          <X className="w-3.5 h-3.5" />
          Cancel
        </button>
      </div>
    </div>
  )
}
