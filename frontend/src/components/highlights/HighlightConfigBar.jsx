import { useState } from 'react'
import { useHighlight } from '../../context/HighlightContext'
import { useToast } from '../../context/ToastContext'
import {
  Download, GitCompare,
  ToggleRight,
} from 'lucide-react'

/**
 * HighlightConfigBar — Compact toolbar for A/B compare and save/apply.
 * (Presets have moved to the inline PresetSelector in the tuning pane.)
 */
export default function HighlightConfigBar({ projectId }) {
  const {
    abMode, activeConfig, startABCompare, stopABCompare, switchABConfig,
    applyHighlights,
  } = useHighlight()
  const { addToast } = useToast()

  const handleApply = async () => {
    try {
      await applyHighlights(projectId)
      addToast('success', 'Highlights applied to timeline')
    } catch {
      addToast('error', 'Failed to apply highlights')
    }
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-bg-tertiary shrink-0">
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
