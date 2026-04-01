import { useState, useCallback } from 'react'
import { useEncoding } from '../../context/EncodingContext'
import { useToast } from '../../context/ToastContext'
import {
  X, Save, Copy, Trash2, Plus, Settings2, Monitor, Film,
} from 'lucide-react'

/**
 * ExportPresetEditor — Modal/inline editor for creating, editing, and duplicating export presets.
 *
 * @param {Object} props
 * @param {Object|null} props.preset - Preset to edit (null = create new)
 * @param {Function} props.onClose - Close callback
 * @param {'create'|'edit'|'duplicate'} [props.mode='create'] - Editor mode
 */
export default function ExportPresetEditor({ preset, onClose, mode = 'create' }) {
  const { savePreset, deletePreset, fetchPresets } = useEncoding()
  const { showSuccess, showError } = useToast()

  const isNew = mode === 'create' || mode === 'duplicate'
  const title = mode === 'create' ? 'New Preset' : mode === 'duplicate' ? 'Duplicate Preset' : 'Edit Preset'

  const [form, setForm] = useState({
    id: isNew ? '' : (preset?.id || ''),
    name: mode === 'duplicate' ? `${preset?.name || ''} (Copy)` : (preset?.name || ''),
    description: preset?.description || '',
    resolution_width: preset?.resolution_width || 1920,
    resolution_height: preset?.resolution_height || 1080,
    fps: preset?.fps || 60,
    codec_family: preset?.codec_family || 'h264',
    video_bitrate_mbps: preset?.video_bitrate_mbps || 12,
    audio_bitrate_kbps: preset?.audio_bitrate_kbps || 192,
    quality_preset: preset?.quality_preset || 'medium',
  })
  const [saving, setSaving] = useState(false)

  const updateField = useCallback((field, value) => {
    setForm(prev => ({ ...prev, [field]: value }))
  }, [])

  const handleSave = useCallback(async () => {
    if (!form.name.trim()) {
      showError('Preset name is required')
      return
    }
    setSaving(true)
    try {
      const data = { ...form }
      if (isNew) delete data.id
      const result = await savePreset(data)
      if (result.success) {
        showSuccess(`Preset ${isNew ? 'created' : 'updated'}`)
        onClose()
      } else {
        showError(result.error || 'Failed to save preset')
      }
    } finally {
      setSaving(false)
    }
  }, [form, isNew, savePreset, showSuccess, showError, onClose])

  const handleDelete = useCallback(async () => {
    if (!preset?.id || preset?.is_builtin) return
    const result = await deletePreset(preset.id)
    if (result.success) {
      showSuccess('Preset deleted')
      onClose()
    } else {
      showError(result.error || 'Failed to delete')
    }
  }, [preset, deletePreset, showSuccess, showError, onClose])

  // Resolution presets
  const resPresets = [
    { label: '720p', w: 1280, h: 720 },
    { label: '1080p', w: 1920, h: 1080 },
    { label: '1440p', w: 2560, h: 1440 },
    { label: '4K', w: 3840, h: 2160 },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-bg-secondary border border-border rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          <Settings2 className="w-4 h-4 text-accent" />
          <h3 className="text-sm font-semibold text-text-primary flex-1">{title}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Name */}
          <Field label="Name">
            <input
              type="text"
              value={form.name}
              onChange={e => updateField('name', e.target.value)}
              placeholder="My Custom Preset"
              className="w-full bg-bg-primary border border-border rounded-md px-3 py-2
                         text-xs text-text-primary placeholder:text-text-disabled
                         focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </Field>

          {/* Description */}
          <Field label="Description">
            <input
              type="text"
              value={form.description}
              onChange={e => updateField('description', e.target.value)}
              placeholder="Optional description…"
              className="w-full bg-bg-primary border border-border rounded-md px-3 py-2
                         text-xs text-text-primary placeholder:text-text-disabled
                         focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </Field>

          {/* Resolution */}
          <Field label="Resolution">
            <div className="flex gap-2 mb-2">
              {resPresets.map(rp => (
                <button
                  key={rp.label}
                  onClick={() => { updateField('resolution_width', rp.w); updateField('resolution_height', rp.h) }}
                  className={`px-2 py-1 rounded text-xxs font-medium border transition-colors
                    ${form.resolution_width === rp.w && form.resolution_height === rp.h
                      ? 'border-accent/40 bg-accent/5 text-accent'
                      : 'border-border bg-bg-primary text-text-secondary hover:bg-bg-hover'
                    }`}
                >
                  {rp.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={form.resolution_width}
                onChange={e => updateField('resolution_width', parseInt(e.target.value) || 0)}
                className="w-24 bg-bg-primary border border-border rounded-md px-2 py-1.5 text-xs text-text-primary text-center focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <span className="text-xs text-text-tertiary">×</span>
              <input
                type="number"
                value={form.resolution_height}
                onChange={e => updateField('resolution_height', parseInt(e.target.value) || 0)}
                className="w-24 bg-bg-primary border border-border rounded-md px-2 py-1.5 text-xs text-text-primary text-center focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
          </Field>

          {/* Frame Rate */}
          <Field label="Frame Rate">
            <div className="flex gap-2">
              {[24, 30, 60].map(fps => (
                <button
                  key={fps}
                  onClick={() => updateField('fps', fps)}
                  className={`flex-1 px-2 py-1.5 rounded text-xs font-medium border transition-colors
                    ${form.fps === fps
                      ? 'border-accent/40 bg-accent/5 text-accent'
                      : 'border-border bg-bg-primary text-text-secondary hover:bg-bg-hover'
                    }`}
                >
                  {fps} fps
                </button>
              ))}
            </div>
          </Field>

          {/* Codec */}
          <Field label="Codec">
            <div className="flex gap-2">
              {[{ id: 'h264', label: 'H.264' }, { id: 'h265', label: 'H.265 (HEVC)' }].map(codec => (
                <button
                  key={codec.id}
                  onClick={() => updateField('codec_family', codec.id)}
                  className={`flex-1 px-2 py-1.5 rounded text-xs font-medium border transition-colors
                    ${form.codec_family === codec.id
                      ? 'border-accent/40 bg-accent/5 text-accent'
                      : 'border-border bg-bg-primary text-text-secondary hover:bg-bg-hover'
                    }`}
                >
                  {codec.label}
                </button>
              ))}
            </div>
          </Field>

          {/* Video Bitrate */}
          <Field label="Video Bitrate (Mbps)">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="1"
                max="80"
                step="0.5"
                value={form.video_bitrate_mbps}
                onChange={e => updateField('video_bitrate_mbps', parseFloat(e.target.value))}
                className="flex-1 accent-accent"
              />
              <span className="text-xs font-mono text-text-primary w-14 text-right">
                {form.video_bitrate_mbps} Mbps
              </span>
            </div>
          </Field>

          {/* Audio Bitrate */}
          <Field label="Audio Bitrate (kbps)">
            <div className="flex gap-2">
              {[128, 192, 256, 320].map(kbps => (
                <button
                  key={kbps}
                  onClick={() => updateField('audio_bitrate_kbps', kbps)}
                  className={`flex-1 px-2 py-1.5 rounded text-xs font-medium border transition-colors
                    ${form.audio_bitrate_kbps === kbps
                      ? 'border-accent/40 bg-accent/5 text-accent'
                      : 'border-border bg-bg-primary text-text-secondary hover:bg-bg-hover'
                    }`}
                >
                  {kbps}
                </button>
              ))}
            </div>
          </Field>

          {/* Quality Preset */}
          <Field label="Quality / Speed">
            <div className="flex gap-2">
              {['fast', 'medium', 'slow'].map(q => (
                <button
                  key={q}
                  onClick={() => updateField('quality_preset', q)}
                  className={`flex-1 px-2 py-1.5 rounded text-xs font-medium border transition-colors
                    ${form.quality_preset === q
                      ? 'border-accent/40 bg-accent/5 text-accent'
                      : 'border-border bg-bg-primary text-text-secondary hover:bg-bg-hover'
                    }`}
                >
                  <span className="capitalize">{q}</span>
                  <div className="text-xxs text-text-tertiary mt-0.5">
                    {q === 'fast' ? 'Lower quality' : q === 'slow' ? 'Best quality' : 'Balanced'}
                  </div>
                </button>
              ))}
            </div>
          </Field>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-border shrink-0">
          {mode === 'edit' && !preset?.is_builtin && (
            <button
              onClick={handleDelete}
              className="flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium
                         text-danger hover:bg-danger/10 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-md text-xs font-medium text-text-secondary
                       hover:bg-bg-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !form.name.trim()}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-medium transition-colors
              ${saving || !form.name.trim()
                ? 'bg-accent/50 text-white cursor-not-allowed'
                : 'bg-accent hover:bg-accent-hover text-white'
              }`}
          >
            <Save className="w-3.5 h-3.5" />
            {isNew ? 'Create' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}


function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xxs font-medium text-text-tertiary uppercase tracking-wider mb-1.5">
        {label}
      </label>
      {children}
    </div>
  )
}
