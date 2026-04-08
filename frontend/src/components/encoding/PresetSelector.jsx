import { ChevronDown, Plus, Copy, Edit3 } from 'lucide-react'

/**
 * PresetSelector — export preset dropdown, detail view, and management buttons.
 *
 * @param {Object}   props
 * @param {Array}    props.presets          - list of available presets
 * @param {string}   props.selectedPresetId - currently selected preset id
 * @param {Object|null} props.selectedPreset - resolved preset object
 * @param {Function} props.onSelect         - (presetId) => void
 * @param {Function} props.onDuplicate      - (presetId) => void  — quick-duplicate
 * @param {Function} props.onEdit           - (mode, preset) => void  — open editor
 * @param {Function} props.onCreate         - () => void  — open editor in create mode
 */
export default function PresetSelector({
  presets, selectedPresetId, selectedPreset,
  onSelect, onDuplicate, onEdit, onCreate,
}) {
  return (
    <div className="space-y-2">
      <div className="relative">
        <select
          value={selectedPresetId}
          onChange={e => onSelect(e.target.value)}
          className="w-full appearance-none bg-bg-primary border border-border rounded-md
                     px-3 py-2 pr-8 text-xs text-text-primary cursor-pointer
                     focus:outline-none focus:ring-1 focus:ring-accent"
        >
          {presets.map(p => (
            <option key={p.id} value={p.id}>{p.name}{p.is_builtin === false ? ' ✦' : ''}</option>
          ))}
        </select>
        <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary pointer-events-none" />
      </div>

      {selectedPreset && (
        <div className="bg-bg-primary border border-border rounded-md p-2.5 space-y-1">
          {selectedPreset.description && (
            <p className="text-xxs text-text-tertiary">{selectedPreset.description}</p>
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xxs">
            <span className="text-text-tertiary">Resolution</span>
            <span className="text-text-secondary">{selectedPreset.resolution_width}×{selectedPreset.resolution_height}</span>
            <span className="text-text-tertiary">Frame Rate</span>
            <span className="text-text-secondary">{selectedPreset.fps} fps</span>
            <span className="text-text-tertiary">Video Bitrate</span>
            <span className="text-text-secondary">{selectedPreset.video_bitrate_mbps} Mbps</span>
            <span className="text-text-tertiary">Audio Bitrate</span>
            <span className="text-text-secondary">{selectedPreset.audio_bitrate_kbps} kbps</span>
            <span className="text-text-tertiary">Codec</span>
            <span className="text-text-secondary">{selectedPreset.codec_family?.toUpperCase()}</span>
            <span className="text-text-tertiary">Quality</span>
            <span className="text-text-secondary capitalize">{selectedPreset.quality_preset}</span>
          </div>
        </div>
      )}

      {/* Preset management buttons */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={onCreate}
          className="flex items-center gap-1 px-2 py-1 rounded text-xxs font-medium
                     text-text-secondary hover:text-text-primary hover:bg-bg-hover
                     border border-border transition-colors"
          title="Create new preset"
        >
          <Plus className="w-3 h-3" />
          New
        </button>
        {selectedPreset && (
          <>
            <button
              onClick={() => onEdit(
                selectedPreset.is_builtin !== false ? 'duplicate' : 'edit',
                selectedPreset,
              )}
              className="flex items-center gap-1 px-2 py-1 rounded text-xxs font-medium
                         text-text-secondary hover:text-text-primary hover:bg-bg-hover
                         border border-border transition-colors"
              title={selectedPreset.is_builtin !== false ? 'Duplicate preset' : 'Edit preset'}
            >
              {selectedPreset.is_builtin !== false ? (
                <><Copy className="w-3 h-3" />Duplicate</>
              ) : (
                <><Edit3 className="w-3 h-3" />Edit</>
              )}
            </button>
            {selectedPreset.is_builtin !== false && (
              <button
                onClick={() => onDuplicate(selectedPreset.id)}
                className="flex items-center gap-1 px-2 py-1 rounded text-xxs font-medium
                           text-text-secondary hover:text-text-primary hover:bg-bg-hover
                           border border-border transition-colors"
                title="Quick duplicate"
              >
                <Copy className="w-3 h-3" />
                Duplicate
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
