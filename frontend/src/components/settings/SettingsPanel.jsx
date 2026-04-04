import { useState, useCallback, useEffect } from 'react'
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
  Wand2,
  FolderOpen,
  Sparkles,
  Eye,
  EyeOff,
} from 'lucide-react'
import { useSettings } from '../../context/SettingsContext'
import { useToast } from '../../context/ToastContext'
import { apiGet, apiPost } from '../../services/api'
import YouTubeSettings from '../youtube/YouTubeSettings'
import SetupWizard from '../wizard/SetupWizard'

/**
 * Settings category definitions.
 */
const CATEGORIES = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'camera', label: 'Camera Defaults', icon: Film },
  { id: 'encoding', label: 'Encoding', icon: Cpu },
  { id: 'ai', label: 'AI / LLM', icon: Sparkles },
  { id: 'youtube', label: 'YouTube', icon: Youtube },
  { id: 'hotkeys', label: 'Hotkeys', icon: Keyboard },
  { id: 'pipeline', label: 'Pipeline', icon: Monitor },
  { id: 'wizard', label: 'Setup Wizard', icon: Wand2 },
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
          {activeCategory === 'ai' && (
            <AISettings value={currentValue} onChange={setField} />
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
          {activeCategory === 'wizard' && (
            <WizardSettings />
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
        <BrowseInput
          value={value('iracing_replay_dir')}
          onChange={(v) => onChange('iracing_replay_dir', v)}
          placeholder="e.g., C:\Users\You\Documents\iRacing\replays"
          browseTitle="Select iRacing Replay Directory"
        />
      </SettingGroup>

      {/* Default Project Directory */}
      <SettingGroup label="Default Project Directory" description="Where new projects are created by default.">
        <BrowseInput
          value={value('default_project_dir')}
          onChange={(v) => onChange('default_project_dir', v)}
          placeholder="Leave empty to use default data directory"
          browseTitle="Select Default Project Directory"
        />
      </SettingGroup>
    </div>
  )
}

function CameraSettings({ value, onChange }) {
  const [caps, setCaps] = useState(null)

  useEffect(() => {
    apiGet('/iracing/stream/capabilities')
      .then(data => setCaps(data))
      .catch(() => setCaps(null))
  }, [])

  const captureSoftAvail = caps?.capture ?? {}

  return (
    <div className="space-y-6 max-w-xl">
      <SectionHeader
        title="Camera Defaults"
        description="Default camera settings for new projects. These can be overridden per-project."
      />

      <SettingGroup label="Capture Software" description="Default recording application used to record the iRacing window.">
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
        {caps && (
          <div className="mt-2 flex flex-wrap gap-2">
            <CapBadge label="OBS" available={captureSoftAvail.obs?.available} desc={captureSoftAvail.obs?.reason} />
            <CapBadge label="ShadowPlay" available={captureSoftAvail.shadowplay?.available} desc={captureSoftAvail.shadowplay?.reason} />
            <CapBadge label="ReLive" available={captureSoftAvail.relive?.available} desc={captureSoftAvail.relive?.reason} />
          </div>
        )}
      </SettingGroup>
    </div>
  )
}

function EncodingSettings({ value, onChange }) {
  const [caps, setCaps] = useState(null)
  const [capsLoading, setCapsLoading] = useState(false)

  useEffect(() => {
    setCapsLoading(true)
    apiGet('/iracing/stream/capabilities')
      .then(data => setCaps(data))
      .catch(() => setCaps(null))
      .finally(() => setCapsLoading(false))
  }, [])

  const previewBackend = value('preview_backend') || 'auto'
  const showNativeSettings = previewBackend === 'native' || previewBackend === 'auto'
  const previewAvail = caps?.preview ?? {}

  return (
    <div className="space-y-6 max-w-xl">
      <SectionHeader
        title="Encoding"
        description="Default encoding presets, GPU preferences, and live preview capture settings."
      />

      {/* ── Live Preview Engine ───────────────────────────────────── */}
      <SectionSubHeader title="Live Preview Engine" />

      <SettingGroup
        label="Preview Backend"
        description="Method used to capture the iRacing window for the live preview feed. Native C++ gives the lowest latency."
      >
        <Select
          value={previewBackend}
          onChange={(v) => onChange('preview_backend', v)}
          options={[
            { value: 'auto', label: 'Auto-detect (recommended)' },
            { value: 'native', label: 'Native C++ (DXGI — best performance)' },
            { value: 'dxcam', label: 'dxcam (Python DXGI)' },
            { value: 'printwindow', label: 'PrintWindow (GDI — legacy fallback)' },
          ]}
        />
        {capsLoading && (
          <p className="mt-2 text-xs text-text-tertiary">Checking availability…</p>
        )}
        {!capsLoading && caps && (
          <div className="mt-2 flex flex-wrap gap-2">
            <CapBadge
              label="Native C++"
              available={previewAvail.native?.available}
              desc={previewAvail.native?.reason}
            />
            <CapBadge
              label="dxcam"
              available={previewAvail.dxcam?.available}
              desc={previewAvail.dxcam?.reason}
            />
            <CapBadge
              label="PrintWindow"
              available={previewAvail.printwindow?.available}
              desc={previewAvail.printwindow?.reason}
            />
          </div>
        )}
      </SettingGroup>

      {showNativeSettings && (
        <>
          <SettingGroup
            label="Native — Output Index"
            description="Which GPU output to capture from (0 = primary monitor). Only used by the Native C++ backend."
          >
            <Select
              value={String(value('native_output_index') ?? 0)}
              onChange={(v) => onChange('native_output_index', parseInt(v, 10))}
              options={[
                { value: '0', label: '0 — Primary monitor' },
                { value: '1', label: '1' },
                { value: '2', label: '2' },
                { value: '3', label: '3' },
                { value: '4', label: '4' },
                { value: '5', label: '5' },
                { value: '6', label: '6' },
                { value: '7', label: '7' },
              ]}
            />
          </SettingGroup>

          <SettingGroup
            label="Native — FPS Cap"
            description="Maximum capture frame rate for the Native backend (0 = match display refresh rate)."
          >
            <NumberInput
              value={value('native_capture_fps') ?? 0}
              onChange={(v) => onChange('native_capture_fps', v)}
              min={0}
              max={240}
              placeholder="0 (match display)"
            />
          </SettingGroup>
        </>
      )}

      {/* ── Video Encoding ────────────────────────────────────────── */}
      <SectionSubHeader title="Video Encoding" />

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
        description="Keyboard shortcuts for capture control. Click the input and press the desired key."
      />

      <SettingGroup label="Start Capture Hotkey" description="Key to trigger recording start in capture software.">
        <HotkeyCaptureSettings
          value={value('capture_hotkey_start')}
          onChange={(v) => onChange('capture_hotkey_start', v)}
        />
      </SettingGroup>

      <SettingGroup label="Stop Capture Hotkey" description="Key to trigger recording stop in capture software.">
        <HotkeyCaptureSettings
          value={value('capture_hotkey_stop')}
          onChange={(v) => onChange('capture_hotkey_stop', v)}
        />
      </SettingGroup>
    </div>
  )
}

// ── AI / LLM Settings ────────────────────────────────────────────────────────

const LLM_PROVIDERS = [
  { value: 'none', label: 'Disabled' },
  { value: 'openai', label: 'OpenAI (GPT-4o, GPT-4o-mini)' },
  { value: 'anthropic', label: 'Anthropic (Claude 3.5 Sonnet, Haiku)' },
  { value: 'google', label: 'Google (Gemini 1.5 Pro, Flash)' },
  { value: 'custom', label: 'Custom (OpenAI-compatible endpoint)' },
]

const LLM_MODEL_SUGGESTIONS = {
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o (recommended)' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini (faster, cheaper)' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  ],
  anthropic: [
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (recommended)' },
    { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (faster, cheaper)' },
  ],
  google: [
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro (recommended)' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (faster, cheaper)' },
  ],
  custom: [],
  none: [],
}

function AISettings({ value, onChange }) {
  const provider = value('llm_provider') || 'none'
  const isEnabled = provider !== 'none'
  const modelSuggestions = LLM_MODEL_SUGGESTIONS[provider] || []
  const [showKey, setShowKey] = useState(false)

  const handleProviderChange = (newProvider) => {
    onChange('llm_provider', newProvider)
    onChange('llm_enabled', newProvider !== 'none')
    // Set default model for the selected provider
    const defaults = LLM_MODEL_SUGGESTIONS[newProvider] || []
    if (defaults.length > 0) {
      onChange('llm_model', defaults[0].value)
    }
  }

  return (
    <div className="space-y-6 max-w-xl">
      <SectionHeader
        title="AI / LLM"
        description="Configure AI-powered features: editorial highlight refinement, natural language overlay design, and more."
      />

      <SettingGroup label="AI Provider" description="Select your preferred AI provider. An API key is required.">
        <Select
          value={provider}
          onChange={handleProviderChange}
          options={LLM_PROVIDERS}
        />
      </SettingGroup>

      {isEnabled && (
        <>
          <SettingGroup label="API Key" description="Your API key for the selected provider. Keys are stored locally and never shared.">
            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={value('llm_api_key') || ''}
                onChange={(e) => onChange('llm_api_key', e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                className="flex-1 px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                           text-text-primary placeholder:text-text-disabled
                           focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
                           transition-colors font-mono"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-bg-primary
                           text-text-secondary hover:text-text-primary hover:bg-surface-hover text-sm transition-colors"
                title={showKey ? 'Hide API key' : 'Show API key'}
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </SettingGroup>

          <SettingGroup label="Model" description="AI model to use. Larger models are more capable but slower and more expensive.">
            {modelSuggestions.length > 0 ? (
              <Select
                value={value('llm_model') || ''}
                onChange={(v) => onChange('llm_model', v)}
                options={modelSuggestions}
              />
            ) : (
              <TextInput
                value={value('llm_model') || ''}
                onChange={(v) => onChange('llm_model', v)}
                placeholder="Enter model name"
              />
            )}
          </SettingGroup>

          {provider === 'custom' && (
            <SettingGroup label="Custom API Endpoint" description="OpenAI-compatible API base URL (e.g. http://localhost:11434/v1).">
              <TextInput
                value={value('llm_custom_endpoint') || ''}
                onChange={(v) => onChange('llm_custom_endpoint', v)}
                placeholder="http://localhost:11434/v1"
              />
            </SettingGroup>
          )}

          <SettingGroup label="Temperature" description="Controls creativity vs. determinism. Lower = more consistent, higher = more creative.">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="0"
                max="100"
                value={Math.round((value('llm_temperature') || 0.3) * 100)}
                onChange={(e) => onChange('llm_temperature', parseInt(e.target.value, 10) / 100)}
                className="flex-1 accent-accent"
              />
              <span className="text-sm font-mono text-text-secondary w-10 text-right">
                {(value('llm_temperature') || 0.3).toFixed(2)}
              </span>
            </div>
          </SettingGroup>

          <SectionSubHeader title="AI Capabilities" />
          <div className="space-y-2 text-sm text-text-secondary">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-accent" />
              <span><strong>Overlay Design</strong> — Generate and modify overlay elements with natural language</span>
            </div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-accent" />
              <span><strong>Editorial</strong> — AI-refined narrative flow, transitions, and notes for highlights</span>
            </div>
          </div>
        </>
      )}
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

function SectionSubHeader({ title }) {
  return (
    <h4 className="text-xs font-semibold text-text-tertiary uppercase tracking-widest pt-2">
      {title}
    </h4>
  )
}

function CapBadge({ label, available, desc }) {
  return (
    <span
      title={desc || ''}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${
        available
          ? 'bg-green-500/10 text-green-400 border-green-500/25'
          : 'bg-surface text-text-disabled border-border'
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
          available ? 'bg-green-400' : 'bg-text-disabled'
        }`}
      />
      {label}
    </span>
  )
}

function NumberInput({ value, onChange, min, max, placeholder }) {
  return (
    <input
      type="number"
      value={value ?? ''}
      onChange={(e) => {
        const v = parseInt(e.target.value, 10)
        if (!isNaN(v) && v >= min && v <= max) onChange(v)
        else if (e.target.value === '') onChange(min)
      }}
      min={min}
      max={max}
      placeholder={placeholder}
      className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                 text-text-primary placeholder:text-text-disabled
                 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
                 transition-colors"
    />
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

function BrowseInput({ value, onChange, placeholder, browseTitle }) {
  const handleBrowse = async () => {
    try {
      const result = await apiPost('/system/browse', {
        mode: 'folder',
        title: browseTitle || 'Select Folder',
        initial_dir: value || '',
      })
      if (result.path) onChange(result.path)
    } catch { /* dialog cancelled or failed */ }
  }

  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                   text-text-primary placeholder:text-text-disabled
                   focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
                   transition-colors"
      />
      <button
        type="button"
        onClick={handleBrowse}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-bg-primary
                   text-text-secondary hover:text-text-primary hover:bg-surface-hover text-sm transition-colors"
      >
        <FolderOpen className="w-4 h-4" />
        Browse
      </button>
    </div>
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

function HotkeyCaptureSettings({ value, onChange }) {
  const [capturing, setCapturing] = useState(false)

  const handleKeyDown = (e) => {
    e.preventDefault()
    e.stopPropagation()

    const parts = []
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    if (e.metaKey) parts.push('Meta')

    const key = e.key
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return

    const keyName = key.length === 1 ? key.toUpperCase() : key
    parts.push(keyName)

    onChange(parts.join('+'))
    setCapturing(false)
  }

  return (
    <button
      type="button"
      onKeyDown={capturing ? handleKeyDown : undefined}
      onClick={() => setCapturing(true)}
      onBlur={() => setCapturing(false)}
      className={`w-full px-3 py-2 rounded-lg border text-sm text-left transition-colors focus:outline-none ${
        capturing
          ? 'bg-accent/10 border-accent text-accent ring-2 ring-accent/30'
          : 'bg-bg-primary border-border text-text-primary hover:border-accent/50'
      }`}
    >
      {capturing ? 'Press a key...' : value || 'Click to set hotkey'}
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

// ── Wizard Settings ──────────────────────────────────────────────────────────

function WizardSettings() {
  const { updateSettings } = useSettings()
  const { showSuccess } = useToast()
  const [showWizard, setShowWizard] = useState(false)

  const handleComplete = async (collectedSettings) => {
    try {
      await fetch('/api/wizard/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: collectedSettings }),
      })
      await updateSettings({ ...collectedSettings, wizard_completed: true })
      showSuccess('Setup wizard completed and settings saved.')
    } catch {
      // Non-fatal
    }
    setShowWizard(false)
  }

  const handleSkip = () => {
    setShowWizard(false)
  }

  return (
    <div className="space-y-6 max-w-xl">
      <SectionHeader
        title="Setup Wizard"
        description="Re-run the guided setup wizard to reconfigure your installation."
      />
      <button
        onClick={() => setShowWizard(true)}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm hover:bg-accent/90 transition-colors"
      >
        <Wand2 className="w-4 h-4" />
        Launch Setup Wizard
      </button>
      {showWizard && (
        <SetupWizard onComplete={handleComplete} onSkip={handleSkip} />
      )}
    </div>
  )
}
