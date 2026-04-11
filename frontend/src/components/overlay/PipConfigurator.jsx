/**
 * PipConfigurator — Picture-in-Picture overlay configuration.
 *
 * Allows configuring PiP position, size, border style, and "LIVE" badge.
 * Used in the Overlay phase to set up how PiP segments will be rendered.
 */

import { useEffect, useState, useCallback } from 'react'
import { useScriptState } from '../../context/ScriptStateContext'
import {
  PictureInPicture2, Move, Maximize2, Palette, Tag, Eye, EyeOff,
} from 'lucide-react'

const POSITIONS = [
  { id: 'top-left',     label: 'Top Left',     x: 'left-1', y: 'top-1' },
  { id: 'top-right',    label: 'Top Right',    x: 'right-1', y: 'top-1' },
  { id: 'bottom-left',  label: 'Bottom Left',  x: 'left-1', y: 'bottom-1' },
  { id: 'bottom-right', label: 'Bottom Right', x: 'right-1', y: 'bottom-1' },
]

export default function PipConfigurator({ projectId }) {
  const { pipConfig, fetchPipConfig, updatePipConfig, loading } = useScriptState()
  const [localConfig, setLocalConfig] = useState(pipConfig)

  useEffect(() => {
    if (projectId) fetchPipConfig(projectId)
  }, [projectId, fetchPipConfig])

  useEffect(() => {
    setLocalConfig(pipConfig)
  }, [pipConfig])

  const handleChange = useCallback(async (key, value) => {
    const updated = { ...localConfig, [key]: value }
    setLocalConfig(updated)
    try {
      await updatePipConfig(projectId, { [key]: value })
    } catch {
      // revert on error
      setLocalConfig(pipConfig)
    }
  }, [localConfig, pipConfig, projectId, updatePipConfig])

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PictureInPicture2 size={16} className="text-blue-400" />
          <span className="text-sm font-semibold text-zinc-200">Picture-in-Picture</span>
        </div>
        <button
          onClick={() => handleChange('enabled', !localConfig.enabled)}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors
            ${localConfig.enabled
              ? 'bg-green-500/20 text-green-400'
              : 'bg-zinc-700 text-zinc-400'
            }`}
        >
          {localConfig.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
          {localConfig.enabled ? 'Enabled' : 'Disabled'}
        </button>
      </div>

      {!localConfig.enabled && (
        <p className="text-xs text-zinc-500">
          Enable PiP to overlay a secondary driver perspective on applicable segments.
          PiP segments are created when two high-scoring events overlap in the timeline.
        </p>
      )}

      {localConfig.enabled && (
        <>
          {/* Position selector */}
          <div className="space-y-2">
            <label className="flex items-center gap-1 text-xs text-zinc-500">
              <Move size={12} />
              Position
            </label>
            <div className="grid grid-cols-2 gap-2 w-32">
              {POSITIONS.map(pos => (
                <button
                  key={pos.id}
                  onClick={() => handleChange('position', pos.id)}
                  className={`relative h-12 rounded border transition-colors
                    ${localConfig.position === pos.id
                      ? 'border-blue-400 bg-blue-500/10'
                      : 'border-zinc-700 bg-zinc-800 hover:border-zinc-600'
                    }`}
                  title={pos.label}
                >
                  {/* Miniature PiP indicator */}
                  <div className={`absolute ${pos.y} ${pos.x} w-5 h-3 rounded-sm
                    ${localConfig.position === pos.id ? 'bg-blue-400' : 'bg-zinc-500'}`}
                  />
                </button>
              ))}
            </div>
          </div>

          {/* Scale slider */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1 text-xs text-zinc-500">
                <Maximize2 size={12} />
                Size
              </label>
              <span className="text-xs text-zinc-400 tabular-nums">
                {Math.round(localConfig.scale * 100)}%
              </span>
            </div>
            <input
              type="range"
              min="10" max="50" step="5"
              value={localConfig.scale * 100}
              onChange={e => handleChange('scale', parseInt(e.target.value, 10) / 100)}
              className="w-full accent-blue-500 h-1"
            />
            <div className="flex justify-between text-xs text-zinc-600">
              <span>10%</span><span>50%</span>
            </div>
          </div>

          {/* Margin */}
          <div className="space-y-1">
            <label className="text-xs text-zinc-500">Margin (px)</label>
            <input
              type="number"
              min="0" max="64" step="4"
              value={localConfig.margin}
              onChange={e => handleChange('margin', parseInt(e.target.value, 10))}
              className="w-20 px-2 py-1 text-xs rounded bg-zinc-800 border border-zinc-700 text-zinc-300"
            />
          </div>

          {/* Border */}
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={localConfig.border}
                onChange={e => handleChange('border', e.target.checked)}
                className="rounded border-zinc-600"
              />
              Border
            </label>
            {localConfig.border && (
              <>
                <div className="flex items-center gap-1">
                  <Palette size={12} className="text-zinc-500" />
                  <input
                    type="color"
                    value={localConfig.border_color}
                    onChange={e => handleChange('border_color', e.target.value)}
                    className="w-6 h-6 rounded cursor-pointer border-0"
                  />
                </div>
                <input
                  type="number"
                  min="1" max="8"
                  value={localConfig.border_width}
                  onChange={e => handleChange('border_width', parseInt(e.target.value, 10))}
                  className="w-14 px-2 py-1 text-xs rounded bg-zinc-800 border border-zinc-700 text-zinc-300"
                  title="Border width"
                />
              </>
            )}
          </div>

          {/* LIVE badge */}
          <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
            <input
              type="checkbox"
              checked={localConfig.show_live_badge}
              onChange={e => handleChange('show_live_badge', e.target.checked)}
              className="rounded border-zinc-600"
            />
            <Tag size={12} className="text-red-400" />
            Show &ldquo;LIVE&rdquo; badge on PiP
          </label>

          {/* Preview box */}
          <div className="space-y-1">
            <span className="text-xs text-zinc-500">Preview</span>
            <div className="relative w-full aspect-video bg-zinc-900 rounded border border-zinc-700 overflow-hidden">
              {/* Main area */}
              <div className="absolute inset-0 flex items-center justify-center text-zinc-700 text-xs">
                Main Camera
              </div>
              {/* PiP window */}
              {(() => {
                const scale = localConfig.scale
                const margin = `${localConfig.margin}px`
                const posStyle = {
                  'top-left':     { top: margin, left: margin },
                  'top-right':    { top: margin, right: margin },
                  'bottom-left':  { bottom: margin, left: margin },
                  'bottom-right': { bottom: margin, right: margin },
                }[localConfig.position] || { bottom: margin, right: margin }

                return (
                  <div
                    className="absolute bg-zinc-800 rounded overflow-hidden"
                    style={{
                      ...posStyle,
                      width: `${scale * 100}%`,
                      aspectRatio: '16/9',
                      border: localConfig.border
                        ? `${localConfig.border_width}px solid ${localConfig.border_color}`
                        : 'none',
                    }}
                  >
                    <div className="w-full h-full flex items-center justify-center text-zinc-600 text-xs">
                      PiP
                    </div>
                    {localConfig.show_live_badge && (
                      <div className="absolute top-1 left-1 px-1 py-0.5 bg-red-600 text-white text-[9px] font-bold rounded">
                        LIVE
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
