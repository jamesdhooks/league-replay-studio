import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { Plus, Trash2, Copy, Link2, AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import { usePreset } from '../../context/PresetContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { HexColorPicker } from 'react-colorful'

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const RGB_COLOR_PATTERN = /^rgba?\(([^)]+)\)$/i

function clampColorChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function rgbToHex(r, g, b) {
  const toHex = (n) => clampColorChannel(n).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function hexToRgb(value) {
  const normalized = normalizeHexColor(value)
  if (!normalized) return null
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  }
}

function parseRgbString(value) {
  if (typeof value !== 'string') return null
  const match = value.trim().match(RGB_COLOR_PATTERN)
  if (!match) return null
  const channels = match[1].split(',').map((part) => Number.parseFloat(part.trim()))
  if (channels.length < 3 || channels.slice(0, 3).some((n) => Number.isNaN(n))) return null
  return {
    r: clampColorChannel(channels[0]),
    g: clampColorChannel(channels[1]),
    b: clampColorChannel(channels[2]),
  }
}

function parseColorToRgb(value) {
  return hexToRgb(value) || parseRgbString(value)
}

function normalizeHexColor(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!HEX_COLOR_PATTERN.test(trimmed)) return null
  if (trimmed.length === 4) {
    const r = trimmed[1]
    const g = trimmed[2]
    const b = trimmed[3]
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  return trimmed.toLowerCase()
}

/**
 * VariableEditor — edit preset CSS variables with usage diagnostics.
 */
function normalizeVariables(input) {
  const source = input || {}
  const normalized = {}
  Object.keys(source).forEach((key) => {
    const val = source[key]
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      normalized[key] = {
        value: String(val.value ?? ''),
        type: String(val.type ?? 'text'),
        label: String(val.label ?? key),
      }
      return
    }
    normalized[key] = {
      value: String(val ?? ''),
      type: 'text',
      label: key,
    }
  })
  return normalized
}

function stableKeyFromVariables(input) {
  const normalized = normalizeVariables(input)
  const sorted = {}
  Object.keys(normalized).sort().forEach((name) => {
    sorted[name] = normalized[name]
  })
  return JSON.stringify(sorted)
}

function parseCssVariableRefs(text) {
  const refs = new Set()
  if (!text) return refs
  const re = /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,[^)]+)?\)/g
  let match = re.exec(text)
  while (match) {
    refs.add(match[1])
    match = re.exec(text)
  }
  return refs
}

function parseAssetVariableRefs(text) {
  const refs = new Set()
  if (!text) return refs
  const re = /frame\.assets\.([A-Za-z0-9_]+)/g
  let match = re.exec(text)
  while (match) {
    refs.add(match[1])
    match = re.exec(text)
  }
  return refs
}

function parseFrameVariableRefs(text) {
  const refs = new Set()
  if (!text) return refs
  // Matches {{ frame.X }}, {{- frame.X }}, {{ frame.X | filter }}, loop body etc.
  const re = /\{\{-?\s*frame\.([a-zA-Z0-9_]+)/g
  let match = re.exec(text)
  while (match) {
    const name = match[1]
    // assets handled separately by the asset section
    if (name !== 'assets') refs.add(name)
    match = re.exec(text)
  }
  return refs
}

function joinSets(...sets) {
  const output = new Set()
  sets.forEach((set) => {
    ;(set || new Set()).forEach((value) => output.add(value))
  })
  return output
}

function setDiff(left, right) {
  return new Set(Array.from(left).filter((value) => !right.has(value)))
}

function setIntersect(left, right) {
  return new Set(Array.from(left).filter((value) => right.has(value)))
}

function renderTag(tag) {
  return (
    <span key={tag} className="rounded border border-border bg-bg-primary px-1.5 py-0.5 text-[9px] text-text-tertiary uppercase tracking-wider">
      {tag}
    </span>
  )
}

function ListPanel({ title, items, tone = 'muted', emptyLabel = 'None', itemRenderer = null }) {
  const toneClass = {
    ok: 'text-emerald-300 border-emerald-500/20 bg-emerald-500/5',
    warn: 'text-amber-300 border-amber-500/20 bg-amber-500/5',
    muted: 'text-text-secondary border-border bg-bg-primary/50',
  }[tone] || 'text-text-secondary border-border bg-bg-primary/50'

  return (
    <div className={`rounded border p-2 ${toneClass}`}>
      <div className="text-[10px] font-semibold mb-1.5">{title} ({items.length})</div>
      {items.length === 0 ? (
        <p className="text-[10px] text-text-tertiary">{emptyLabel}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((item) => itemRenderer ? itemRenderer(item) : (
            <code key={item} className="text-[10px] font-mono break-all">{item}</code>
          ))}
        </div>
      )}
    </div>
  )
}

export default function VariableEditor({
  preset,
  activeSection,
  activeSectionElements = [],
  projectId = null,
  onUpdate,
}) {
  const { listAssets, getHtmlContent, getDataContext } = usePreset()

  const [variables, setVariables] = useState(() => normalizeVariables(preset?.variables || {}))
  const [swatches, setSwatches] = useLocalStorage('lrs:overlay:color-swatches', [
    '#ffffff', '#000000', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
  ])
  const [activePickerVar, setActivePickerVar] = useState(null)
  const [saveState, setSaveState] = useState('idle') // idle | pending | saving | saved | error
  const [saveError, setSaveError] = useState('')
  const [savedAt, setSavedAt] = useState(null)
  const [rawHtmlContent, setRawHtmlContent] = useState('')
  const [effectiveBindings, setEffectiveBindings] = useState({})
  const [bindingsLoading, setBindingsLoading] = useState(false)
  const [dataContext, setDataContext] = useState(null)

  const hydratingRef = useRef(false)
  const lastPersistedKeyRef = useRef(stableKeyFromVariables(preset?.variables || {}))
  const lastHydratedPresetIdRef = useRef(preset?.id || null)

  const handleValueChange = useCallback((name, newValue) => {
    const updated = {
      ...variables,
      [name]: { ...variables[name], value: newValue },
    }
    setVariables(updated)
    setSaveState('pending')
    setSaveError('')
  }, [variables])

  const handleLabelChange = useCallback((name, newLabel) => {
    const updated = {
      ...variables,
      [name]: { ...variables[name], label: newLabel },
    }
    setVariables(updated)
    setSaveState('pending')
    setSaveError('')
  }, [variables])

  const handleAddVariable = useCallback(() => {
    const name = `--custom-${Date.now()}`
    const updated = {
      ...variables,
      [name]: { value: '#ffffff', type: 'color', label: 'Custom Variable' },
    }
    setVariables(updated)
    setSaveState('pending')
    setSaveError('')
  }, [variables])

  const handleRemoveVariable = useCallback((name) => {
    if (!window.confirm(`Delete variable ${name}?`)) return
    const updated = { ...variables }
    delete updated[name]
    setVariables(updated)
    setSaveState('pending')
    setSaveError('')
  }, [variables])

  const persistSwatch = useCallback((color) => {
    const normalized = normalizeHexColor(color)
    if (!normalized) return
    setSwatches((prev) => {
      const list = Array.isArray(prev) ? prev : []
      const deduped = [normalized, ...list.filter(c => c !== normalized)]
      return deduped.slice(0, 36)
    })
  }, [setSwatches])

  const removeSwatch = useCallback((color) => {
    setSwatches((prev) => {
      const list = Array.isArray(prev) ? prev : []
      return list.filter(c => c !== color)
    })
  }, [setSwatches])

  const refreshBindings = useCallback(async () => {
    if (!preset?.id) return
    setBindingsLoading(true)
    const result = await listAssets(preset.id, { projectId })
    setEffectiveBindings(result?.bindings?.effective || {})
    setBindingsLoading(false)
  }, [listAssets, preset?.id, projectId])

  useEffect(() => {
    let mounted = true
    const loadHtml = async () => {
      if (!preset?.id) {
        if (mounted) setRawHtmlContent('')
        return
      }
      const html = await getHtmlContent(preset.id)
      if (mounted) setRawHtmlContent(html || '')
    }
    loadHtml()
    return () => { mounted = false }
  }, [preset?.id, getHtmlContent])

  useEffect(() => {
    let mounted = true
    const loadDataContext = async () => {
      if (!preset?.id) {
        if (mounted) setDataContext(null)
        return
      }
      const ctx = await getDataContext(preset.id, { projectId })
      if (mounted) setDataContext(ctx || null)
    }
    loadDataContext()
    return () => { mounted = false }
  }, [preset?.id, projectId, getDataContext])

  useEffect(() => {
    refreshBindings()
  }, [refreshBindings])

  useEffect(() => {
    if (!preset?.id) return
    const nextKey = stableKeyFromVariables(preset.variables || {})
    const shouldHydrate = lastHydratedPresetIdRef.current !== preset.id || nextKey !== lastPersistedKeyRef.current
    if (!shouldHydrate) return

    hydratingRef.current = true
    setVariables(normalizeVariables(preset.variables || {}))
    lastPersistedKeyRef.current = nextKey
    lastHydratedPresetIdRef.current = preset.id
    setSaveState('idle')
    setSaveError('')
    setSavedAt(null)
  }, [preset?.id, preset?.variables])

  useEffect(() => {
    if (hydratingRef.current) {
      hydratingRef.current = false
      return undefined
    }
    if (!preset?.id) return undefined

    const nextKey = stableKeyFromVariables(variables)
    if (nextKey === lastPersistedKeyRef.current) return undefined

    setSaveState('pending')
    const timeoutId = window.setTimeout(async () => {
      setSaveState('saving')
      setSaveError('')
      try {
        const result = await onUpdate(variables)
        if (result && result.success === false) {
          setSaveState('error')
          setSaveError(result.error || 'Failed to save variables')
          return
        }
        lastPersistedKeyRef.current = stableKeyFromVariables(variables)
        setSaveState('saved')
        setSavedAt(Date.now())
      } catch (err) {
        setSaveState('error')
        setSaveError(err?.message || 'Failed to save variables')
      }
    }, 500)

    return () => window.clearTimeout(timeoutId)
  }, [variables, onUpdate, preset?.id])

  const sectionTemplateText = useMemo(() => {
    return (activeSectionElements || [])
      .map((element) => element?.template || '')
      .join('\n')
  }, [activeSectionElements])

  const cssFromSection = useMemo(() => parseCssVariableRefs(sectionTemplateText), [sectionTemplateText])
  const cssFromHtml = useMemo(() => parseCssVariableRefs(rawHtmlContent), [rawHtmlContent])
  const cssUsed = useMemo(() => joinSets(cssFromSection, cssFromHtml), [cssFromSection, cssFromHtml])

  const assetFromSection = useMemo(() => parseAssetVariableRefs(sectionTemplateText), [sectionTemplateText])
  const assetFromHtml = useMemo(() => parseAssetVariableRefs(rawHtmlContent), [rawHtmlContent])
  const assetUsed = useMemo(() => joinSets(assetFromSection, assetFromHtml), [assetFromSection, assetFromHtml])

  const definedCssVars = useMemo(() => new Set(Object.keys(variables)), [variables])
  const linkedCss = useMemo(() => setIntersect(cssUsed, definedCssVars), [cssUsed, definedCssVars])
  const unlinkedCss = useMemo(() => setDiff(cssUsed, definedCssVars), [cssUsed, definedCssVars])
  const definedUnusedCss = useMemo(() => setDiff(definedCssVars, cssUsed), [definedCssVars, cssUsed])

  const effectiveAssetNames = useMemo(() => new Set(Object.keys(effectiveBindings || {})), [effectiveBindings])
  const linkedAssets = useMemo(() => setIntersect(assetUsed, effectiveAssetNames), [assetUsed, effectiveAssetNames])
  const unlinkedAssets = useMemo(() => setDiff(assetUsed, effectiveAssetNames), [assetUsed, effectiveAssetNames])

  const cssUsageSources = useMemo(() => {
    const map = {}
    cssUsed.forEach((name) => {
      map[name] = []
      if (cssFromSection.has(name)) map[name].push('section')
      if (cssFromHtml.has(name)) map[name].push('html')
    })
    return map
  }, [cssUsed, cssFromSection, cssFromHtml])

  const assetUsageSources = useMemo(() => {
    const map = {}
    assetUsed.forEach((name) => {
      map[name] = []
      if (assetFromSection.has(name)) map[name].push('section')
      if (assetFromHtml.has(name)) map[name].push('html')
    })
    return map
  }, [assetUsed, assetFromSection, assetFromHtml])

  // ── Frame template variable diagnostics ─────────────────────────────
  const frameFromSection = useMemo(() => parseFrameVariableRefs(sectionTemplateText), [sectionTemplateText])
  const frameFromHtml = useMemo(() => parseFrameVariableRefs(rawHtmlContent), [rawHtmlContent])
  const frameVarsUsed = useMemo(() => joinSets(frameFromSection, frameFromHtml), [frameFromSection, frameFromHtml])

  const availableFrameVarNames = useMemo(
    () => new Set(Object.keys(dataContext?.variables || {})),
    [dataContext]
  )

  const linkedFrameVars = useMemo(
    () => setIntersect(frameVarsUsed, availableFrameVarNames),
    [frameVarsUsed, availableFrameVarNames]
  )
  const unlinkedFrameVars = useMemo(
    () => setDiff(frameVarsUsed, availableFrameVarNames),
    [frameVarsUsed, availableFrameVarNames]
  )
  const unusedFrameVars = useMemo(
    () => setDiff(availableFrameVarNames, frameVarsUsed),
    [availableFrameVarNames, frameVarsUsed]
  )

  const frameVarSources = useMemo(() => {
    const map = {}
    frameVarsUsed.forEach((name) => {
      map[name] = []
      if (frameFromSection.has(name)) map[name].push('section')
      if (frameFromHtml.has(name)) map[name].push('html')
    })
    return map
  }, [frameVarsUsed, frameFromSection, frameFromHtml])

  const SOURCE_GROUP_COLORS = {
    telemetry: 'text-blue-400',
    computed: 'text-amber-400',
    plugin: 'text-emerald-400',
  }

  const saveStateLabel = useMemo(() => {
    if (saveState === 'saving') return 'Saving variables...'
    if (saveState === 'pending') return 'Changes queued'
    if (saveState === 'saved') return `Saved${savedAt ? ` at ${new Date(savedAt).toLocaleTimeString()}` : ''}`
    if (saveState === 'error') return saveError || 'Save failed'
    return 'Idle'
  }, [saveState, saveError, savedAt])

  const saveStateIcon = saveState === 'saving'
    ? <Loader2 className="w-3 h-3 animate-spin" />
    : saveState === 'error'
      ? <AlertTriangle className="w-3 h-3" />
      : saveState === 'saved'
        ? <CheckCircle2 className="w-3 h-3" />
        : <Link2 className="w-3 h-3" />

  const copyText = useCallback(async (text) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Ignore clipboard errors silently in compact utility actions.
    }
  }, [])

  const effectiveAssetList = useMemo(() => {
    return Object.entries(effectiveBindings || {})
      .map(([name, binding]) => ({
        name,
        scope: binding?.scope || 'global',
        filename: binding?.filename || '',
        url: binding?.url || '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [effectiveBindings])

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg-secondary/50">
      <div className="flex shrink-0 items-center justify-between px-4 py-1.5 border-b border-border">
        <div className="flex flex-col">
          <span className="text-xs font-medium text-text-secondary">CSS Variables</span>
          <span className="text-[10px] text-text-tertiary">
            Active section: {activeSection || 'race'} • Parsed from section + html
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={handleAddVariable}
            className="text-[10px] px-1.5 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-0.5">
            <Plus className="w-3 h-3" /> Add
          </button>
        </div>
      </div>
      <div className="shrink-0 px-3 py-2 border-b border-border/60 bg-bg-primary/40">
        <div className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[10px] ${saveState === 'error' ? 'text-amber-300 bg-amber-500/10 border border-amber-500/25' : 'text-text-secondary bg-bg-secondary border border-border'}`}>
          {saveStateIcon}
          <span>{saveStateLabel}</span>
          {saveState === 'error' && (
            <button
              onClick={() => {
                setSaveState('pending')
                setSaveError('')
                setVariables((prev) => ({ ...prev }))
              }}
              className="inline-flex items-center gap-1 rounded border border-amber-500/40 px-1.5 py-0.5 text-[9px] hover:bg-amber-500/20"
            >
              <RefreshCw className="w-2.5 h-2.5" /> Retry
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
        {Object.entries(variables).map(([name, meta]) => {
          const val = typeof meta === 'object' ? meta : { value: meta, type: 'text', label: name }
          const parsedRgb = parseColorToRgb(val.value)
          const isColor = val.type === 'color' || parsedRgb != null
          const currentRgb = parsedRgb || { r: 255, g: 255, b: 255 }
          const pickerColor = rgbToHex(currentRgb.r, currentRgb.g, currentRgb.b)
          const pickerOpen = activePickerVar === name
          return (
            <div key={name} className="flex items-center gap-2 text-xs">
              <code className="text-[10px] text-text-tertiary truncate w-36" title={name}>{name}</code>
              <input
                type="text"
                value={val.label || ''}
                onChange={e => handleLabelChange(name, e.target.value)}
                className="bg-bg-primary border border-border rounded px-1.5 py-0.5 text-[10px] text-text-primary w-28 focus:border-blue-500 focus:outline-none disabled:opacity-50"
                placeholder="Label"
              />
              <div className="flex items-center gap-1 flex-1 relative">
                {isColor && (
                  <>
                    <button
                      type="button"
                      onClick={() => setActivePickerVar(prev => prev === name ? null : name)}
                      className="w-5 h-5 rounded border border-border shrink-0"
                      title={pickerOpen ? 'Close color picker' : 'Open color picker'}
                      style={{ backgroundColor: pickerColor }}
                    />
                    {pickerOpen && (
                      <div className="absolute left-0 top-7 z-20 w-72 rounded border border-border bg-bg-primary p-2 shadow-xl space-y-2">
                        <HexColorPicker color={pickerColor} onChange={(color) => handleValueChange(name, color)} />
                        <div className="grid grid-cols-[44px_1fr] items-center gap-2 text-[10px]">
                          <span className="text-text-tertiary">HEX</span>
                          <input
                            type="text"
                            value={pickerColor}
                            onChange={(e) => {
                              const next = normalizeHexColor(e.target.value)
                              if (next) handleValueChange(name, next)
                            }}
                            className="bg-bg-secondary border border-border rounded px-1.5 py-1 text-[10px] text-text-primary font-mono focus:border-blue-500 focus:outline-none"
                          />
                        </div>
                        <div className="grid grid-cols-[44px_1fr] items-center gap-2 text-[10px]">
                          <span className="text-text-tertiary">RGB</span>
                          <div className="grid grid-cols-3 gap-1">
                            {['r', 'g', 'b'].map((channel) => (
                              <input
                                key={`${name}-${channel}`}
                                type="number"
                                min={0}
                                max={255}
                                value={currentRgb[channel]}
                                onChange={(e) => {
                                  const parsed = Number.parseInt(e.target.value, 10)
                                  const nextValue = Number.isNaN(parsed)
                                    ? currentRgb[channel]
                                    : clampColorChannel(parsed)
                                  const nextRgb = {
                                    ...currentRgb,
                                    [channel]: nextValue,
                                  }
                                  handleValueChange(name, rgbToHex(nextRgb.r, nextRgb.g, nextRgb.b))
                                }}
                                className="bg-bg-secondary border border-border rounded px-1 py-1 text-[10px] text-text-primary font-mono focus:border-blue-500 focus:outline-none"
                              />
                            ))}
                          </div>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => persistSwatch(pickerColor)}
                            className="text-[10px] px-2 py-1 rounded border border-border hover:bg-bg-secondary text-text-secondary"
                          >
                            Save to swatches
                          </button>
                          <button
                            type="button"
                            onClick={() => setActivePickerVar(null)}
                            className="text-[10px] px-2 py-1 rounded border border-border hover:bg-bg-secondary text-text-secondary"
                          >
                            Done
                          </button>
                        </div>
                        <div className="space-y-1">
                          <div className="text-[10px] text-text-tertiary">Swatches</div>
                          <div className="flex flex-wrap gap-1.5">
                            {(Array.isArray(swatches) ? swatches : []).map((swatch) => (
                              <div key={`${name}-${swatch}`} className="relative group">
                                <button
                                  type="button"
                                  onClick={() => handleValueChange(name, swatch)}
                                  className="w-5 h-5 rounded border border-border"
                                  style={{ backgroundColor: swatch }}
                                  title={`Apply ${swatch}`}
                                />
                                <button
                                  type="button"
                                  onClick={() => removeSwatch(swatch)}
                                  className="absolute -top-1 -right-1 hidden group-hover:flex items-center justify-center w-3.5 h-3.5 rounded-full border border-border bg-bg-primary text-[9px] leading-none text-text-secondary"
                                  title="Remove swatch"
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
                <input
                  type="text"
                  value={val.value || ''}
                  onChange={e => handleValueChange(name, e.target.value)}
                  className="flex-1 bg-bg-primary border border-border rounded px-1.5 py-0.5 text-[10px] text-text-primary font-mono focus:border-blue-500 focus:outline-none disabled:opacity-50"
                />
              </div>
              <button onClick={() => handleRemoveVariable(name)}
                className="p-0.5 rounded hover:bg-red-700/50 text-text-tertiary hover:text-red-400">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          )
        })}

        <div className="pt-2 border-t border-border/60 mt-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-text-secondary">Asset Variable Reference</span>
            {bindingsLoading && <Loader2 className="w-3 h-3 animate-spin text-text-tertiary" />}
          </div>
          {effectiveAssetList.length === 0 ? (
            <p className="text-[10px] text-text-tertiary">No effective asset variables yet.</p>
          ) : (
            <div className="space-y-1">
              {effectiveAssetList.map((asset) => {
                const token = `{{ frame.assets.${asset.name} }}`
                return (
                  <div key={asset.name} className="rounded border border-border bg-bg-primary/60 p-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <code className="text-[10px] text-text-primary font-mono truncate">{token}</code>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => copyText(token)}
                          className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[9px] text-text-secondary hover:bg-bg-secondary"
                          title="Copy token"
                        >
                          <Copy className="w-2.5 h-2.5" /> Token
                        </button>
                        {asset.url && (
                          <button
                            onClick={() => copyText(asset.url)}
                            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[9px] text-text-secondary hover:bg-bg-secondary"
                            title="Copy resolved URL"
                          >
                            <Copy className="w-2.5 h-2.5" /> URL
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="mt-1 text-[9px] text-text-tertiary">
                      {asset.scope} • {asset.filename || 'unbound'}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="pt-2 border-t border-border/60 mt-3 space-y-2">
          <span className="text-[11px] font-semibold text-text-secondary">Frame Template Variables</span>
          <p className="text-[9px] text-text-tertiary leading-relaxed">
            Variables parsed from <code className="text-accent">{'{{ frame.X }}'}</code> in section templates and HTML.
          </p>
          <div className="grid grid-cols-1 gap-2">
            <ListPanel
              title="Used & Available"
              tone="ok"
              items={Array.from(linkedFrameVars).sort()}
              emptyLabel={frameVarsUsed.size === 0 ? 'No frame variables found in templates' : 'None linked'}
              itemRenderer={(name) => {
                const src = dataContext?.variable_sources?.[name] || 'telemetry'
                const groupColor = SOURCE_GROUP_COLORS[src] || 'text-blue-400'
                const doc = dataContext?.variable_docs?.[`frame.${name}`] || dataContext?.variable_docs?.[name] || ''
                const rawVal = dataContext?.variables?.[name]
                const isArray = Array.isArray(rawVal)
                const isObj = rawVal && typeof rawVal === 'object' && !isArray
                const displayVal = rawVal === undefined ? '' : isArray ? `Array[${rawVal.length}]` : isObj ? '{...}' : JSON.stringify(rawVal)
                return (
                  <div key={name} className="flex items-start gap-2" title={doc}>
                    <code className={`text-[10px] font-mono whitespace-nowrap flex-shrink-0 ${groupColor}`}>{name}</code>
                    <span className="text-[10px] text-text-tertiary truncate flex-1 font-mono">{displayVal}</span>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {(frameVarSources[name] || []).map(renderTag)}
                    </div>
                  </div>
                )
              }}
            />
            <ListPanel
              title="Used but Missing"
              tone="warn"
              items={Array.from(unlinkedFrameVars).sort()}
              emptyLabel="None"
              itemRenderer={(name) => (
                <div key={name} className="flex items-center justify-between gap-2">
                  <code className="text-[10px] font-mono break-all text-amber-300">{name}</code>
                  <div className="flex items-center gap-1">{(frameVarSources[name] || []).map(renderTag)}</div>
                </div>
              )}
            />
            <ListPanel
              title="Defined but Unused"
              tone="muted"
              items={Array.from(unusedFrameVars).sort()}
              emptyLabel="None"
              itemRenderer={(name) => {
                const src = dataContext?.variable_sources?.[name] || 'telemetry'
                const groupColor = SOURCE_GROUP_COLORS[src] || 'text-text-tertiary'
                const rawVal = dataContext?.variables?.[name]
                const isArray = Array.isArray(rawVal)
                const isObj = rawVal && typeof rawVal === 'object' && !isArray
                const displayVal = rawVal === undefined ? '' : isArray ? `Array[${rawVal.length}]` : isObj ? '{...}' : JSON.stringify(rawVal)
                return (
                  <div key={name} className="flex items-start gap-2 opacity-50">
                    <code className={`text-[10px] font-mono whitespace-nowrap flex-shrink-0 ${groupColor}`}>{name}</code>
                    <span className="text-[10px] text-text-disabled truncate flex-1 font-mono">{displayVal}</span>
                  </div>
                )
              }}
            />
          </div>
        </div>

        <div className="pt-2 border-t border-border/60 mt-3 space-y-2">
          <span className="text-[11px] font-semibold text-text-secondary">CSS Variable Diagnostics</span>
          <div className="grid grid-cols-1 gap-2">
            <ListPanel
              title="Used and Linked CSS Variables"
              tone="ok"
              items={Array.from(linkedCss).sort()}
              itemRenderer={(name) => (
                <div key={name} className="flex items-center justify-between gap-2">
                  <code className="text-[10px] font-mono break-all">{name}</code>
                  <div className="flex items-center gap-1">{(cssUsageSources[name] || []).map(renderTag)}</div>
                </div>
              )}
            />
            <ListPanel
              title="Unlinked CSS Variables"
              tone="warn"
              items={Array.from(unlinkedCss).sort()}
              itemRenderer={(name) => (
                <div key={name} className="flex items-center justify-between gap-2">
                  <code className="text-[10px] font-mono break-all">{name}</code>
                  <div className="flex items-center gap-1">{(cssUsageSources[name] || []).map(renderTag)}</div>
                </div>
              )}
            />
            <ListPanel
              title="Used and Linked Asset Variables"
              tone="ok"
              items={Array.from(linkedAssets).sort()}
              itemRenderer={(name) => (
                <div key={name} className="flex items-center justify-between gap-2">
                  <code className="text-[10px] font-mono break-all">frame.assets.{name}</code>
                  <div className="flex items-center gap-1">{(assetUsageSources[name] || []).map(renderTag)}</div>
                </div>
              )}
            />
            <ListPanel
              title="Unlinked Asset Variables"
              tone="warn"
              items={Array.from(unlinkedAssets).sort()}
              itemRenderer={(name) => (
                <div key={name} className="flex items-center justify-between gap-2">
                  <code className="text-[10px] font-mono break-all">frame.assets.{name}</code>
                  <div className="flex items-center gap-1">{(assetUsageSources[name] || []).map(renderTag)}</div>
                </div>
              )}
            />
            <ListPanel
              title="Defined but Unused CSS Variables"
              tone="muted"
              items={Array.from(definedUnusedCss).sort()}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
