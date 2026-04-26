import { useState, useCallback, useMemo } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Info,
  Save,
  X,
} from 'lucide-react'

/**
 * PresetEditor — Full preset configuration form.
 *
 * Organizes all EXECUTION_SPEC_FIELDS into collapsible sections:
 * Execution, Export, Highlight, Overlay, Capture, Upload, Error Handling, Advanced.
 */

// Field descriptions for tooltips
const FIELD_DESCRIPTIONS = {
  export_preset: 'Export encoding preset (e.g., "mp4-hq", "youtube-standard")',
  output_dir: 'Directory where exported videos will be saved',
  
  highlight_config: 'Auto-highlight rules: weights, target duration, min severity',
  
  overlay_preset_id: 'Global overlay design preset to apply',
  overlay_variables: 'Custom variables for overlay (colors, fonts, etc)',
  
  capture_mode: 'Capture strategy: "auto" (replay), "script" (predefined), "legacy"',
  
  youtube_privacy: 'Video privacy level when upload step runs: "private", "unlisted", "public"',
  
  failure_action: 'On step failure: "pause" (wait for user), "skip" (continue), "abort"',
  notify_on_completion: 'Notification method: "toast", "email", "webhook", "none"',
  
  non_interactive: 'Suppress all user-intervention prompts (headless mode)',
}

function FieldTooltip({ field }) {
  const desc = FIELD_DESCRIPTIONS[field]
  if (!desc) return null
  return (
    <div className="group relative">
      <Info className="w-3.5 h-3.5 text-text-tertiary hover:text-text-secondary cursor-help" />
      <div className="absolute bottom-full left-0 mb-2 w-48 p-2 bg-bg-primary border border-border rounded text-xxs text-text-tertiary pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50">
        {desc}
      </div>
    </div>
  )
}

function TextInput({ value, onChange, placeholder, disabled }) {
  return (
    <input
      type="text"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-xs text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
    />
  )
}

function Checkbox({ value, onChange, label, disabled }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={value || false}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="w-4 h-4 rounded border-border bg-bg-primary text-accent focus:ring-accent disabled:opacity-50"
      />
      <span className="text-xs text-text-secondary">{label}</span>
    </label>
  )
}

function Select({ value, onChange, options, disabled }) {
  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="w-full px-3 py-2 bg-bg-primary border border-border rounded-md text-xs text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
    >
      {options.map(({ label, value: v }) => (
        <option key={v} value={v}>{label}</option>
      ))}
    </select>
  )
}

function CollapsibleSection({ title, children, defaultOpen = false }) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 bg-bg-secondary hover:bg-bg-hover transition-colors"
      >
        <span className="text-sm font-medium text-text-primary">{title}</span>
        {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      {isOpen && (
        <div className="p-4 space-y-3 bg-bg-primary border-t border-border">
          {children}
        </div>
      )}
    </div>
  )
}

function FieldRow({ label, field, children }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-center gap-1.5">
        <label className="block text-xs font-medium text-text-secondary">{label}</label>
        <FieldTooltip field={field} />
      </div>
      <div className="flex-1 max-w-xs">
        {children}
      </div>
    </div>
  )
}

/**
 * PresetEditor — Full form for editing/creating presets.
 */
export default function PresetEditor({ preset, onSave, onCancel, isLoading = false }) {
  const [data, setData] = useState(preset || {
    name: '',
    description: '',
    export_preset: '',
    output_dir: '',
    highlight_config: {},
    overlay_preset_id: '',
    overlay_variables: {},
    capture_mode: 'auto',
    youtube_privacy: 'unlisted',
    failure_action: 'pause',
    notify_on_completion: 'toast',
    non_interactive: false,
  })

  const isNew = !preset?.id

  const handleChange = useCallback((key, value) => {
    setData(prev => ({ ...prev, [key]: value }))
  }, [])

  const handleSave = useCallback(() => {
    if (!data.name?.trim()) {
      alert('Preset name is required')
      return
    }
    onSave(data)
  }, [data, onSave])

  return (
    <div className="space-y-4 max-w-2xl">
      {/* Header */}
      <div className="space-y-3 pb-4 border-b border-border">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">Preset Name *</label>
          <TextInput
            value={data.name}
            onChange={(v) => handleChange('name', v)}
            placeholder="e.g., Quick Highlights, Full Pipeline"
            disabled={isLoading}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">Description</label>
          <TextInput
            value={data.description}
            onChange={(v) => handleChange('description', v)}
            placeholder="Explain what this preset is for..."
            disabled={isLoading}
          />
        </div>
      </div>

      {/* Export Section */}
      <CollapsibleSection title="Export">
        <FieldRow label="Export Preset" field="export_preset">
          <TextInput
            value={data.export_preset}
            onChange={(v) => handleChange('export_preset', v)}
            placeholder="e.g., mp4-hq, youtube-standard"
            disabled={isLoading}
          />
        </FieldRow>
        <FieldRow label="Output Directory" field="output_dir">
          <TextInput
            value={data.output_dir}
            onChange={(v) => handleChange('output_dir', v)}
            placeholder="Path to save exported videos"
            disabled={isLoading}
          />
        </FieldRow>
      </CollapsibleSection>

      {/* Capture Section */}
      <CollapsibleSection title="Capture">
        <FieldRow label="Capture Mode" field="capture_mode">
          <Select
            value={data.capture_mode}
            onChange={(v) => handleChange('capture_mode', v)}
            options={[
              { label: 'Auto (replay)', value: 'auto' },
              { label: 'Script (predefined)', value: 'script' },
              { label: 'Legacy', value: 'legacy' },
            ]}
            disabled={isLoading}
          />
        </FieldRow>
      </CollapsibleSection>

      {/* Overlay Section */}
      <CollapsibleSection title="Overlay">
        <FieldRow label="Overlay Preset" field="overlay_preset_id">
          <TextInput
            value={data.overlay_preset_id}
            onChange={(v) => handleChange('overlay_preset_id', v)}
            placeholder="Overlay design preset ID"
            disabled={isLoading}
          />
        </FieldRow>
        <div className="text-xxs text-text-tertiary bg-bg-secondary p-2 rounded border border-border">
          <strong>Overlay Variables:</strong> Advanced config stored as JSON. Leave empty to use preset defaults.
        </div>
      </CollapsibleSection>

      {/* Upload Section */}
      <CollapsibleSection title="Upload">
        <FieldRow label="Video Privacy" field="youtube_privacy">
          <Select
            value={data.youtube_privacy}
            onChange={(v) => handleChange('youtube_privacy', v)}
            options={[
              { label: 'Private', value: 'private' },
              { label: 'Unlisted', value: 'unlisted' },
              { label: 'Public', value: 'public' },
            ]}
            disabled={isLoading}
          />
        </FieldRow>
        <p className="text-xxs text-text-tertiary">
          Privacy level applied when the upload step runs (e.g. via <code>--upload</code> in the CLI).
        </p>
      </CollapsibleSection>

      {/* Error Handling Section */}
      <CollapsibleSection title="Error Handling">
        <FieldRow label="On Failure" field="failure_action">
          <Select
            value={data.failure_action}
            onChange={(v) => handleChange('failure_action', v)}
            options={[
              { label: 'Pause & wait', value: 'pause' },
              { label: 'Skip step', value: 'skip' },
              { label: 'Abort pipeline', value: 'abort' },
            ]}
            disabled={isLoading}
          />
        </FieldRow>
        <FieldRow label="Notifications" field="notify_on_completion">
          <Select
            value={data.notify_on_completion}
            onChange={(v) => handleChange('notify_on_completion', v)}
            options={[
              { label: 'Toast popup', value: 'toast' },
              { label: 'Email', value: 'email' },
              { label: 'Webhook', value: 'webhook' },
              { label: 'None', value: 'none' },
            ]}
            disabled={isLoading}
          />
        </FieldRow>
      </CollapsibleSection>

      {/* Advanced Section */}
      <CollapsibleSection title="Advanced">
        <FieldRow label="Non-interactive Mode" field="non_interactive">
          <Checkbox
            value={data.non_interactive}
            onChange={(v) => handleChange('non_interactive', v)}
            label="Headless/CLI mode (suppress prompts)"
            disabled={isLoading}
          />
        </FieldRow>
      </CollapsibleSection>

      {/* Buttons */}
      <div className="flex gap-2 pt-4 border-t border-border">
        <button
          onClick={handleSave}
          disabled={isLoading}
          className="flex items-center justify-center gap-2 flex-1 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {isNew ? 'Create Preset' : 'Save Changes'}
        </button>
        <button
          onClick={onCancel}
          disabled={isLoading}
          className="flex items-center justify-center gap-2 px-4 py-2 bg-bg-secondary hover:bg-bg-hover border border-border rounded-lg font-medium text-sm transition-colors disabled:opacity-50"
        >
          <X className="w-4 h-4" />
          Cancel
        </button>
      </div>
    </div>
  )
}
