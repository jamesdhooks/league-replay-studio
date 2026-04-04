import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Move, Layers, Code, Eye, EyeOff,
  Info,
} from 'lucide-react'

/**
 * ElementEditor — Edit properties of a single overlay element.
 *
 * Properties:
 *   - Name
 *   - Position (x%, y%, w%, h%)
 *   - Z-index
 *   - Visibility
 *   - Template HTML (Jinja2 code editor)
 *
 * Template guidance section shows available variables and syntax examples.
 */
export default function ElementEditor({ element, isBuiltin, onUpdate, onRefreshPreview }) {
  const [name, setName] = useState(element.name)
  const [position, setPosition] = useState(element.position)
  const [zIndex, setZIndex] = useState(element.z_index)
  const [template, setTemplate] = useState(element.template)
  const [showGuide, setShowGuide] = useState(false)
  const saveTimeoutRef = useRef(null)

  // Sync when element changes
  useEffect(() => {
    setName(element.name)
    setPosition(element.position)
    setZIndex(element.z_index)
    setTemplate(element.template)
  }, [element.id, element.name, element.position, element.z_index, element.template])

  const handleSave = useCallback((field, value) => {
    if (isBuiltin) return
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(async () => {
      await onUpdate({ [field]: value })
    }, 500)
  }, [isBuiltin, onUpdate])

  const handlePositionChange = useCallback((axis, val) => {
    const newPos = { ...position, [axis]: parseFloat(val) || 0 }
    setPosition(newPos)
    handleSave('position', newPos)
  }, [position, handleSave])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Layers className="w-3.5 h-3.5 text-blue-400" />
          <span className="text-xs font-medium">Element Properties</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* Name */}
        <div>
          <label className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider">Name</label>
          <input
            type="text"
            value={name}
            onChange={e => { setName(e.target.value); handleSave('name', e.target.value) }}
            disabled={isBuiltin}
            className="w-full mt-1 bg-bg-secondary border border-border rounded px-2 py-1 text-xs text-text-primary focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        {/* Position */}
        <div>
          <label className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider flex items-center gap-1">
            <Move className="w-3 h-3" /> Position (%)
          </label>
          <div className="grid grid-cols-2 gap-2 mt-1">
            {[
              { key: 'x', label: 'Left' },
              { key: 'y', label: 'Top' },
              { key: 'w', label: 'Width' },
              { key: 'h', label: 'Height' },
            ].map(({ key, label }) => (
              <div key={key}>
                <span className="text-[9px] text-text-tertiary">{label}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={position[key] || 0}
                  onChange={e => handlePositionChange(key, e.target.value)}
                  disabled={isBuiltin}
                  className="w-full bg-bg-secondary border border-border rounded px-2 py-0.5 text-xs text-text-primary focus:border-blue-500 focus:outline-none disabled:opacity-50 tabular-nums"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Z-Index */}
        <div>
          <label className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider">Z-Index</label>
          <input
            type="number"
            min={0}
            max={100}
            value={zIndex}
            onChange={e => { const v = parseInt(e.target.value) || 0; setZIndex(v); handleSave('z_index', v) }}
            disabled={isBuiltin}
            className="w-full mt-1 bg-bg-secondary border border-border rounded px-2 py-1 text-xs text-text-primary focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        {/* Template HTML */}
        <div>
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider flex items-center gap-1">
              <Code className="w-3 h-3" /> Template HTML
            </label>
            <button onClick={() => setShowGuide(!showGuide)}
              className="text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-0.5">
              <Info className="w-3 h-3" />
              {showGuide ? 'Hide' : 'Guide'}
            </button>
          </div>

          {/* Template guide */}
          {showGuide && (
            <div className="mt-1 p-2 rounded bg-bg-secondary border border-border text-[10px] text-text-tertiary space-y-1.5">
              <p className="font-medium text-text-secondary">Available Variables:</p>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                <code className="text-blue-400">{'{{ frame.driver_name }}'}</code>
                <span>Focused driver</span>
                <code className="text-blue-400">{'{{ frame.position }}'}</code>
                <span>Race position</span>
                <code className="text-blue-400">{'{{ frame.current_lap }}'}</code>
                <span>Current lap</span>
                <code className="text-blue-400">{'{{ frame.total_laps }}'}</code>
                <span>Total laps</span>
                <code className="text-blue-400">{'{{ frame.flag }}'}</code>
                <span>Flag status</span>
                <code className="text-blue-400">{'{{ frame.team_color }}'}</code>
                <span>Team color</span>
                <code className="text-blue-400">{'{{ frame.standings }}'}</code>
                <span>All drivers</span>
              </div>
              <p className="font-medium text-text-secondary mt-2">Position:</p>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                <code className="text-green-400">{'{{pos.x}}, {{pos.y}}'}</code>
                <span>Left, Top (%)</span>
                <code className="text-green-400">{'{{pos.w}}, {{pos.h}}'}</code>
                <span>Width, Height (%)</span>
              </div>
              <p className="font-medium text-text-secondary mt-2">Loops:</p>
              <code className="text-amber-400 block">{'{% for entry in frame.standings %}'}</code>
              <code className="text-amber-400 block pl-2">{'{{ entry.driver_name }} P{{ entry.position }}'}</code>
              <code className="text-amber-400 block">{'{% endfor %}'}</code>
              <p className="font-medium text-text-secondary mt-2">Conditionals:</p>
              <code className="text-amber-400 block">{'{% if entry.is_player %}'}</code>
              <code className="text-amber-400 block pl-2">{'highlight this row'}</code>
              <code className="text-amber-400 block">{'{% endif %}'}</code>
              <p className="font-medium text-text-secondary mt-2">CSS Variables:</p>
              <code className="text-purple-400 block">{'var(--color-primary, #fff)'}</code>
              <code className="text-purple-400 block">{'var(--font-primary, sans-serif)'}</code>
            </div>
          )}

          <textarea
            value={template}
            onChange={e => { setTemplate(e.target.value); handleSave('template', e.target.value) }}
            disabled={isBuiltin}
            rows={12}
            spellCheck={false}
            className="w-full mt-1 bg-bg-secondary border border-border rounded px-2 py-1.5 text-xs text-text-primary font-mono focus:border-blue-500 focus:outline-none disabled:opacity-50 resize-y"
            placeholder="Enter Jinja2 HTML template..."
          />
        </div>
      </div>
    </div>
  )
}
