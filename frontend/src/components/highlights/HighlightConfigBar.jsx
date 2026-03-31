import { useState } from 'react'
import { useHighlight } from '../../context/HighlightContext'
import {
  Save, Download, Trash2, GitCompare, ChevronDown,
  ToggleLeft, ToggleRight, FolderOpen,
} from 'lucide-react'

/**
 * HighlightConfigBar — Config toolbar for presets, A/B compare, and save/apply.
 *
 * Shows: preset selector, save preset, A/B toggle, apply button.
 */
export default function HighlightConfigBar({ projectId }) {
  const {
    presets, loadPreset, savePreset, deletePreset,
    abMode, activeConfig, startABCompare, stopABCompare, switchABConfig,
    applyHighlights, saveConfig,
  } = useHighlight()

  const [showPresetMenu, setShowPresetMenu] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [showSaveInput, setShowSaveInput] = useState(false)

  const handleSavePreset = async () => {
    if (!presetName.trim()) return
    try {
      await savePreset(presetName.trim())
      setPresetName('')
      setShowSaveInput(false)
    } catch {
      // Error logged in context
    }
  }

  const handleApply = async () => {
    try {
      await applyHighlights(projectId)
    } catch {
      // Error logged in context
    }
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-bg-tertiary shrink-0">
      {/* Preset selector */}
      <div className="relative">
        <button
          onClick={() => setShowPresetMenu(!showPresetMenu)}
          className="flex items-center gap-1 px-2 py-1 text-xxs text-text-secondary
                     bg-bg-primary border border-border rounded hover:border-accent transition-colors"
        >
          <FolderOpen className="w-3 h-3" />
          Presets
          <ChevronDown className="w-3 h-3" />
        </button>

        {showPresetMenu && (
          <div className="absolute top-full left-0 mt-1 z-50 min-w-[200px] bg-bg-secondary
                          border border-border rounded-lg shadow-lg py-1">
            {presets.length === 0 ? (
              <div className="px-3 py-2 text-xxs text-text-disabled">
                No saved presets
              </div>
            ) : (
              presets.map(preset => (
                <div
                  key={preset.name}
                  className="flex items-center gap-1 px-3 py-1.5 hover:bg-bg-hover"
                >
                  <button
                    onClick={() => { loadPreset(preset); setShowPresetMenu(false) }}
                    className="flex-1 text-left text-xxs text-text-primary truncate"
                  >
                    {preset.name}
                  </button>
                  <button
                    onClick={() => deletePreset(preset.name)}
                    className="p-0.5 text-text-disabled hover:text-danger transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))
            )}
            <div className="border-t border-border-subtle mt-1 pt-1 px-3 py-1">
              {showSaveInput ? (
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSavePreset()}
                    placeholder="Preset name..."
                    autoFocus
                    className="flex-1 px-1.5 py-0.5 text-xxs bg-bg-primary border border-border
                               rounded text-text-primary placeholder:text-text-disabled
                               focus:outline-none focus:border-accent"
                  />
                  <button
                    onClick={handleSavePreset}
                    className="p-0.5 text-accent hover:text-accent-hover"
                  >
                    <Save className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowSaveInput(true)}
                  className="flex items-center gap-1 text-xxs text-accent hover:text-accent-hover"
                >
                  <Save className="w-3 h-3" />
                  Save current as preset...
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-border" />

      {/* A/B compare */}
      {abMode ? (
        <div className="flex items-center gap-1">
          <button
            onClick={() => switchABConfig('A')}
            className={`px-2 py-0.5 text-xxs font-medium rounded transition-colors
              ${activeConfig === 'A'
                ? 'bg-accent text-white'
                : 'bg-bg-primary text-text-secondary hover:text-text-primary border border-border'
              }`}
          >
            A
          </button>
          <button
            onClick={() => switchABConfig('B')}
            className={`px-2 py-0.5 text-xxs font-medium rounded transition-colors
              ${activeConfig === 'B'
                ? 'bg-accent text-white'
                : 'bg-bg-primary text-text-secondary hover:text-text-primary border border-border'
              }`}
          >
            B
          </button>
          <button
            onClick={stopABCompare}
            className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
            title="Exit A/B compare"
          >
            <ToggleRight className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <button
          onClick={startABCompare}
          className="flex items-center gap-1 px-2 py-1 text-xxs text-text-secondary
                     hover:text-text-primary transition-colors"
          title="A/B Compare Mode"
        >
          <GitCompare className="w-3 h-3" />
          A/B
        </button>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Apply button */}
      <button
        onClick={handleApply}
        className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium
                   bg-accent hover:bg-accent-hover text-white rounded transition-colors"
      >
        <Download className="w-3.5 h-3.5" />
        Apply to Timeline
      </button>
    </div>
  )
}
