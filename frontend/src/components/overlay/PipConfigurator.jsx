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
  Loader2, AlertTriangle, RefreshCw,
} from 'lucide-react'

const POSITIONS = [
  { id: 'top-left',     label: 'Top Left',     x: 'left-1', y: 'top-1' },
  { id: 'top-right',    label: 'Top Right',    x: 'right-1', y: 'top-1' },
  { id: 'bottom-left',  label: 'Bottom Left',  x: 'left-1', y: 'bottom-1' },
  { id: 'bottom-right', label: 'Bottom Right', x: 'right-1', y: 'bottom-1' },
]

const DEFAULT_PIP_CONFIG = {
  enabled: false,
  position: 'bottom-right',
  scale: 0.25,
  margin: 12,
  border: true,
  border_color: '#ffffff',
  border_width: 2,
  show_live_badge: true,
}

export default function PipConfigurator({ projectId }) {
  const { pipConfig, fetchPipConfig, updatePipConfig, loading } = useScriptState()
  const [localConfig, setLocalConfig] = useState(DEFAULT_PIP_CONFIG)
  const [configReady, setConfigReady] = useState(false)
  const [savingKey, setSavingKey] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [lastFailedChange, setLastFailedChange] = useState(null)

  useEffect(() => {
    let cancelled = false
    if (!projectId) {
      setConfigReady(false)
      return () => {
        cancelled = true
      }
    }

    setConfigReady(false)
    Promise.resolve(fetchPipConfig(projectId)).finally(() => {
      if (!cancelled) setConfigReady(true)
    })

    return () => {
      cancelled = true
    }
  }, [projectId, fetchPipConfig])

  useEffect(() => {
    if (savingKey) return
    setLocalConfig({
      ...DEFAULT_PIP_CONFIG,
      ...(pipConfig || {}),
    })
  }, [pipConfig, savingKey])

  const handleChange = useCallback(async (key, value) => {
    if (!projectId || !configReady) return

    const updated = { ...(localConfig || DEFAULT_PIP_CONFIG), [key]: value }
    setLocalConfig(updated)
    setSavingKey(key)
    setSaveError(null)
    try {
      await updatePipConfig(projectId, { [key]: value })
      setLastFailedChange(null)
    } catch (err) {
      const message = err?.message || 'Failed to save PiP config'
      setSaveError(message)
      setLastFailedChange({ key, value })
      // revert on error
      setLocalConfig({
        ...DEFAULT_PIP_CONFIG,
        ...(pipConfig || {}),
      })
    } finally {
      setSavingKey(null)
    }
  }, [localConfig, pipConfig, projectId, updatePipConfig, configReady])

  if ((loading && !pipConfig) || (projectId && !configReady)) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center gap-2 text-xs text-text-tertiary">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading PiP settings...
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto p-4 md:p-6">
      <div className="mx-auto w-full max-w-5xl space-y-4">
        {/* Header */}
        <div className="rounded-xl border border-border bg-bg-secondary/40 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PictureInPicture2 className="w-4 h-4 text-accent" />
            <span className="text-sm font-semibold text-text-primary">Picture-in-Picture</span>
            <span className="text-xxs text-text-tertiary hidden sm:inline">Overlay a secondary camera for overlap moments</span>
          </div>
          <div className="flex items-center gap-2">
            {saveError && (
              <span className="inline-flex items-center gap-1 px-2 py-1 text-xxs rounded border border-red-500/30 bg-red-500/10 text-red-300">
                <AlertTriangle className="w-3 h-3" />
                Save failed
              </span>
            )}
            <button
              onClick={() => handleChange('enabled', !localConfig.enabled)}
              disabled={!configReady || savingKey === 'enabled'}
              className={`flex items-center gap-1 px-2 py-1 text-xxs font-medium rounded transition-colors
                ${localConfig.enabled
                  ? 'bg-success/10 text-success border border-success/30'
                  : 'bg-bg-secondary text-text-tertiary border border-border'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {savingKey === 'enabled'
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : localConfig.enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
              {savingKey === 'enabled' ? 'Saving…' : localConfig.enabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>
        </div>

        {saveError && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 justify-between">
              <div className="flex items-center gap-2 text-xs text-red-200">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span className="font-medium">Could not save PiP setting</span>
              </div>
              {lastFailedChange && (
                <button
                  type="button"
                  onClick={() => handleChange(lastFailedChange.key, lastFailedChange.value)}
                  disabled={Boolean(savingKey)}
                  className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-red-400/40 text-red-100 hover:bg-red-500/20 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${savingKey ? 'animate-spin' : ''}`} />
                  Retry
                </button>
              )}
            </div>
            <p className="mt-2 text-[11px] text-red-100/90 break-words">{saveError}</p>
          </div>
        )}

        {!localConfig.enabled && (
          <div className="rounded-xl border border-border bg-bg-secondary/20 p-4 text-xs text-text-tertiary">
            Enable PiP to overlay a secondary driver perspective on applicable segments. PiP segments are generated when high-scoring events overlap in the timeline.
          </div>
        )}

        {localConfig.enabled && (
          <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-4">
            <div className="rounded-xl border border-border bg-bg-secondary/30 p-4 space-y-4">
              {/* Position selector */}
              <div className="space-y-2">
                <label className="flex items-center gap-1 text-xxs text-text-tertiary uppercase tracking-wider font-semibold">
                  <Move className="w-3 h-3" />
                  Position
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {POSITIONS.map(pos => (
                    <button
                      key={pos.id}
                      onClick={() => handleChange('position', pos.id)}
                      className={`relative h-14 rounded border transition-colors
                        ${localConfig.position === pos.id
                          ? 'border-accent bg-accent/10'
                          : 'border-border bg-bg-secondary hover:border-text-tertiary'
                        }`}
                      title={pos.label}
                    >
                      <div className={`absolute ${pos.y} ${pos.x} w-6 h-3.5 rounded-sm
                        ${localConfig.position === pos.id ? 'bg-accent' : 'bg-text-disabled'}`}
                      />
                      <div className="absolute bottom-1 left-1 right-1 text-[9px] text-text-tertiary truncate">{pos.label}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Scale slider */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-1 text-xxs text-text-tertiary uppercase tracking-wider font-semibold">
                    <Maximize2 className="w-3 h-3" />
                    Size
                  </label>
                  <span className="text-xs font-mono text-text-primary tabular-nums">
                    {Math.round(localConfig.scale * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="10" max="50" step="5"
                  value={localConfig.scale * 100}
                  onChange={e => handleChange('scale', parseInt(e.target.value, 10) / 100)}
                  className="w-full h-1.5 bg-bg-primary rounded-full appearance-none cursor-pointer
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:cursor-pointer"
                />
                <div className="flex justify-between text-xxs text-text-disabled">
                  <span>10%</span><span>50%</span>
                </div>
              </div>

              {/* Margin */}
              <div className="space-y-1">
                <label className="text-xxs text-text-tertiary uppercase tracking-wider font-semibold">Margin (px)</label>
                <input
                  type="number"
                  min="0" max="64" step="4"
                  value={localConfig.margin}
                  onChange={e => handleChange('margin', parseInt(e.target.value, 10) || 0)}
                  className="w-24 px-2 py-1 text-xs rounded bg-bg-primary border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>

              {/* Border */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={localConfig.border}
                    onChange={e => handleChange('border', e.target.checked)}
                    className="rounded border-border"
                  />
                  Border
                </label>
                {localConfig.border && (
                  <div className="flex items-center gap-3 pl-5">
                    <div className="flex items-center gap-1">
                      <Palette className="w-3 h-3 text-text-tertiary" />
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
                      onChange={e => handleChange('border_width', parseInt(e.target.value, 10) || 1)}
                      className="w-14 px-2 py-1 text-xs rounded bg-bg-primary border border-border text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                      title="Border width"
                    />
                  </div>
                )}
              </div>

              {/* LIVE badge */}
              <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={localConfig.show_live_badge}
                  onChange={e => handleChange('show_live_badge', e.target.checked)}
                  className="rounded border-border"
                />
                <Tag className="w-3 h-3 text-danger" />
                Show “LIVE” badge on PiP
              </label>
            </div>

            {/* Preview box */}
            <div className="rounded-xl border border-border bg-bg-secondary/20 p-4">
              <span className="text-xxs text-text-tertiary uppercase tracking-wider font-semibold block mb-2">Preview</span>
              <div className="relative w-full aspect-video bg-bg-primary rounded border border-border overflow-hidden">
                <div className="absolute inset-0 flex items-center justify-center text-text-disabled text-xxs">
                  Main Camera
                </div>
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
                      className="absolute bg-bg-secondary rounded overflow-hidden"
                      style={{
                        ...posStyle,
                        width: `${scale * 100}%`,
                        aspectRatio: '16/9',
                        border: localConfig.border
                          ? `${localConfig.border_width}px solid ${localConfig.border_color}`
                          : 'none',
                      }}
                    >
                      <div className="w-full h-full flex items-center justify-center text-text-disabled text-xxs">
                        PiP
                      </div>
                      {localConfig.show_live_badge && (
                        <div className="absolute top-1 left-1 px-1 py-0.5 bg-danger text-white text-[9px] font-bold rounded">
                          LIVE
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
