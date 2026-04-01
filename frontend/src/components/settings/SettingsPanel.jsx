import { useState, useCallback } from 'react'
import {
  X,
  Settings,
  Film,
  Keyboard,
  Monitor,
  Cpu,
  RotateCcw,
  Sun,
  Moon,
  Laptop,
  Youtube,
} from 'lucide-react'
import { useSettings } from '../../context/SettingsContext'
import { useToast } from '../../context/ToastContext'
import YouTubeSettings from '../youtube/YouTubeSettings'

/**
 * Settings category definitions.
 */
const CATEGORIES = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'camera', label: 'Camera Defaults', icon: Film },
  { id: 'encoding', label: 'Encoding', icon: Cpu },
  { id: 'youtube', label: 'YouTube', icon: Youtube },
  { id: 'hotkeys', label: 'Hotkeys', icon: Keyboard },
  { id: 'pipeline', label: 'Pipeline', icon: Monitor },
]

/**
 * Full-screen settings panel with categorized sections.
 *
 * @param {Object} props
 * @param {() => void} props.onClose — Close the settings panel
 */
function SettingsPanel({ onClose }) {
  const { settings, updateSettings, resetSettings } = useSettings()
  const { showSuccess, showError, showWarning } = useToast()
  const [activeCategory, setActiveCategory] = useState('general')
  const [pendingChanges, setPendingChanges] = useState({})
  const [saving, setSaving] = useState(false)

  // Track unsaved changes locally before sending to backend
  const currentValue = useCallback((key) => {
    return key in pendingChanges ? pendingChanges[key] : settings?.[key]
  }, [pendingChanges, settings])

  const setField = useCallback((key, value) => {
    setPendingChanges(prev => ({ ...prev, [key]: value }))
  }, [])

  const hasChanges = Object.keys(pendingChanges).length > 0

  // ── Save all pending changes ──────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!hasChanges) return
    setSaving(true)
    try {
      await updateSettings(pendingChanges)
      setPendingChanges({})
      showSuccess('Settings saved')
    } catch (error) {
      showError(error.message || 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }, [hasChanges, pendingChanges, updateSettings, showSuccess, showError])

  // ── Reset to defaults ─────────────────────────────────────────────────
  const handleReset = useCallback(async () => {
    try {
      await resetSettings()
      setPendingChanges({})
      showWarning('Settings reset to defaults')
    } catch (error) {
      showError(error.message || 'Failed to reset settings')
    }
  }, [resetSettings, showWarning, showError])

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-sm text-text-tertiary">Loading settings...</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-accent" />
          <h2 className="text-base font-semibold text-text-primary">Settings</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary
                       hover:text-text-primary hover:bg-surface-hover rounded-md transition-colors"
            title="Reset all settings to defaults"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              hasChanges
                ? 'bg-accent hover:bg-accent-hover text-white'
                : 'bg-surface text-text-disabled cursor-not-allowed'
            }`}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-surface-hover transition-colors text-text-secondary
                       hover:text-text-primary"
            title="Close settings"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Category sidebar */}
        <nav className="w-48 border-r border-border py-2 shrink-0 overflow-y-auto">
          <ul className="space-y-0.5 px-2">
            {CATEGORIES.map(cat => (
              <li key={cat.id}>
                <button
                  onClick={() => setActiveCategory(cat.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm
                              transition-colors ${
                                activeCategory === cat.id
                                  ? 'bg-accent/10 text-accent'
                                  : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                              }`}
                >
                  <cat.icon className="w-4 h-4 shrink-0" />
                  <span>{cat.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* Settings content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeCategory === 'general' && (
            <GeneralSettings value={currentValue} onChange={setField} />
          )}
          {activeCategory === 'camera' && (
            <CameraSettings value={currentValue} onChange={setField} />
          )}
          {activeCategory === 'encoding' && (
            <EncodingSettings value={currentValue} onChange={setField} />
          )}
          {activeCategory === 'youtube' && (
            <YouTubeSettings value={currentValue} onChange={setField} />
          )}
          {activeCategory === 'hotkeys' && (
            <HotkeySettings value={currentValue} onChange={setField} />
          )}
          {activeCategory === 'pipeline' && (
            <PipelineSettings value={currentValue} onChange={setField} />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Category Sections ────────────────────────────────────────────────────────

function GeneralSettings({ value, onChange }) {
  return (
    <div className="space-y-6 max-w-xl">
      <SectionHeader title="General" description="Application-wide preferences and paths." />

      {/* Theme selector */}
      <SettingGroup label="Theme" description="Choose the application color scheme.">
        <ThemeSelector value={value('theme')} onChange={(v) => onChange('theme', v)} />
      </SettingGroup>

      {/* iRacing Replay Directory */}
      <SettingGroup label="iRacing Replay Directory" description="Path to your iRacing replay files (.rpy).">
        <TextInput
          value={value('iracing_replay_dir')}
          onChange={(v) => onChange('iracing_replay_dir', v)}
          placeholder="e.g., C:\Users\You\Documents\iRacing\replays"
        />
      </SettingGroup>

      {/* Default Project Directory */}
      <SettingGroup label="Default Project Directory" description="Where new projects are created by default.">
        <TextInput
          value={value('default_project_dir')}
          onChange={(v) => onChange('default_project_dir', v)}
          placeholder="Leave empty to use default data directory"
        />
      </SettingGroup>

      {/* Sidebar collapsed */}
      <SettingGroup label="Sidebar Collapsed" description="Start with the sidebar collapsed.">
        <Toggle
          checked={value('sidebar_collapsed')}
          onChange={(v) => onChange('sidebar_collapsed', v)}
        />
      </SettingGroup>
    </div>
  )
}

function CameraSettings({ value, onChange }) {
  return (
    <div className="space-y-6 max-w-xl">
      <SectionHeader
        title="Camera Defaults"
        description="Default camera settings for new projects. These can be overridden per-project."
      />

      <SettingGroup label="Capture Software" description="Default recording application.">
        <Select
          value={value('capture_software')}
          onChange={(v) => onChange('capture_software', v)}
          options={[
            { value: 'obs', label: 'OBS Studio' },
            { value: 'shadowplay', label: 'NVIDIA ShadowPlay' },
            { value: 'relive', label: 'AMD ReLive' },
            { value: 'manual', label: 'Manual Recording' },
          ]}
        />
      </SettingGroup>
    </div>
  )
}

function EncodingSettings({ value, onChange }) {
  return (
    <div className="space-y-6 max-w-xl">
      <SectionHeader
        title="Encoding"
        description="Default encoding presets and GPU preferences for video export."
      />

      <SettingGroup label="Encoding Preset" description="Default video encoding quality preset.">
        <Select
          value={value('encoding_preset')}
          onChange={(v) => onChange('encoding_preset', v)}
          options={[
            { value: 'youtube_1080p', label: 'YouTube 1080p (recommended)' },
            { value: 'youtube_1440p', label: 'YouTube 1440p' },
            { value: 'youtube_4k', label: 'YouTube 4K' },
            { value: 'twitter_1080p', label: 'Twitter/X 1080p' },
            { value: 'archive_high', label: 'Archive (High Quality)' },
            { value: 'archive_low', label: 'Archive (Low Quality)' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
      </SettingGroup>

      <SettingGroup label="Preferred GPU" description="GPU to use for hardware-accelerated encoding.">
        <Select
          value={value('preferred_gpu')}
          onChange={(v) => onChange('preferred_gpu', v)}
          options={[
            { value: 'auto', label: 'Auto-detect (recommended)' },
            { value: 'nvidia', label: 'NVIDIA (NVENC)' },
            { value: 'amd', label: 'AMD (AMF)' },
            { value: 'intel', label: 'Intel (QSV)' },
            { value: 'cpu', label: 'CPU (Software)' },
          ]}
        />
      </SettingGroup>
    </div>
  )
}

function HotkeySettings({ value, onChange }) {
  return (
    <div className="space-y-6 max-w-xl">
      <SectionHeader
        title="Hotkeys"
        description="Keyboard shortcuts for capture control."
      />

      <SettingGroup label="Start Capture Hotkey" description="Key to trigger recording start in capture software.">
        <TextInput
          value={value('capture_hotkey_start')}
          onChange={(v) => onChange('capture_hotkey_start', v)}
          placeholder="e.g., F9"
        />
      </SettingGroup>

      <SettingGroup label="Stop Capture Hotkey" description="Key to trigger recording stop in capture software.">
        <TextInput
          value={value('capture_hotkey_stop')}
          onChange={(v) => onChange('capture_hotkey_stop', v)}
          placeholder="e.g., F9"
        />
      </SettingGroup>
    </div>
  )
}

function PipelineSettings({ value, onChange }) {
  return (
    <div className="space-y-6 max-w-xl">
      <SectionHeader
        title="Pipeline"
        description="Default automation pipeline settings."
      />

      <SettingGroup label="YouTube Auto-Upload" description="Automatically upload exported videos to YouTube.">
        <Toggle
          checked={value('youtube_auto_upload')}
          onChange={(v) => onChange('youtube_auto_upload', v)}
        />
      </SettingGroup>

      <SettingGroup label="YouTube Default Privacy" description="Default privacy setting for uploaded videos.">
        <Select
          value={value('youtube_default_privacy')}
          onChange={(v) => onChange('youtube_default_privacy', v)}
          options={[
            { value: 'public', label: 'Public' },
            { value: 'unlisted', label: 'Unlisted' },
            { value: 'private', label: 'Private' },
          ]}
        />
      </SettingGroup>
    </div>
  )
}

// ── Reusable UI Components ───────────────────────────────────────────────────

function SectionHeader({ title, description }) {
  return (
    <div className="pb-2 border-b border-border">
      <h3 className="text-base font-semibold text-text-primary">{title}</h3>
      {description && (
        <p className="mt-1 text-sm text-text-tertiary">{description}</p>
      )}
    </div>
  )
}

function SettingGroup({ label, description, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-text-primary">{label}</label>
      {description && (
        <p className="text-xs text-text-tertiary">{description}</p>
      )}
      <div className="mt-1">{children}</div>
    </div>
  )
}

function TextInput({ value, onChange, placeholder }) {
  return (
    <input
      type="text"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                 text-text-primary placeholder:text-text-disabled
                 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
                 transition-colors"
    />
  )
}

function Select({ value, onChange, options }) {
  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                 text-text-primary
                 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
                 transition-colors appearance-none cursor-pointer"
    >
      {options.map(opt => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}

function Toggle({ checked, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-5 rounded-full transition-colors ${
        checked ? 'bg-accent' : 'bg-surface-active'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm
                    transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`}
      />
    </button>
  )
}

/**
 * Theme selector — three options: Dark, Light, System.
 */
function ThemeSelector({ value, onChange }) {
  const options = [
    { id: 'dark', label: 'Dark', icon: Moon },
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'system', label: 'System', icon: Laptop },
  ]

  return (
    <div className="flex gap-2">
      {options.map(opt => (
        <button
          key={opt.id}
          onClick={() => onChange(opt.id)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                      transition-colors border ${
                        value === opt.id
                          ? 'bg-accent/10 border-accent text-accent'
                          : 'bg-bg-primary border-border text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                      }`}
        >
          <opt.icon className="w-4 h-4" />
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export default SettingsPanel
