import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Move, Layers, Eye, EyeOff,
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
  const saveTimeoutRef = useRef(null)
  const initialPositionRef = useRef(element.position || { x: 0, y: 0, w: 100, h: 100 })

  // Sync when element changes
  useEffect(() => {
    setName(element.name)
    setPosition(element.position)
    setZIndex(element.z_index)
    initialPositionRef.current = element.position || { x: 0, y: 0, w: 100, h: 100 }
  }, [element.id, element.name, element.position, element.z_index])

  const handleSave = useCallback((field, value) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(async () => {
      await onUpdate({ [field]: value })
    }, 500)
  }, [onUpdate])

  const handlePositionChange = useCallback((axis, val) => {
    const newPos = { ...position, [axis]: parseFloat(val) || 0 }
    setPosition(newPos)
    handleSave('position', newPos)
  }, [position, handleSave])

  const handleResetPosition = useCallback(() => {
    const resetPos = {
      x: Number(initialPositionRef.current?.x ?? 0),
      y: Number(initialPositionRef.current?.y ?? 0),
      w: Number(initialPositionRef.current?.w ?? 100),
      h: Number(initialPositionRef.current?.h ?? 100),
    }
    setPosition(resetPos)
    handleSave('position', resetPos)
  }, [handleSave])

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
            className="w-full mt-1 bg-bg-secondary border border-border rounded px-2 py-1 text-xs text-text-primary focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        {/* Position */}
        <div>
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider flex items-center gap-1">
              <Move className="w-3 h-3" /> Position (%)
            </label>
            <button
              type="button"
              onClick={handleResetPosition}
              className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-tertiary hover:bg-bg-secondary hover:text-text-primary"
              title="Reset position values"
            >
              Reset
            </button>
          </div>
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
            className="w-full mt-1 bg-bg-secondary border border-border rounded px-2 py-1 text-xs text-text-primary focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        <div className="rounded border border-border bg-bg-secondary/40 p-2 text-[10px] text-text-tertiary">
          Template HTML is edited in the Build tab. Element Properties here control placement, z-index, and visibility.
        </div>
      </div>
    </div>
  )
}
