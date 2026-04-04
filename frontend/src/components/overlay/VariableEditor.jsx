import { useState, useCallback } from 'react'
import { X, Plus, Trash2 } from 'lucide-react'

/**
 * VariableEditor — Edit custom CSS variables for a preset.
 *
 * Shows a list of CSS custom properties with name, value, type, and label.
 * Variables can be colors (#hex), fonts, or text values.
 */
export default function VariableEditor({ preset, onUpdate, onClose }) {
  const [variables, setVariables] = useState(preset.variables || {})

  const handleValueChange = useCallback((name, newValue) => {
    const updated = {
      ...variables,
      [name]: { ...variables[name], value: newValue },
    }
    setVariables(updated)
    onUpdate(updated)
  }, [variables, onUpdate])

  const handleLabelChange = useCallback((name, newLabel) => {
    const updated = {
      ...variables,
      [name]: { ...variables[name], label: newLabel },
    }
    setVariables(updated)
    onUpdate(updated)
  }, [variables, onUpdate])

  const handleAddVariable = useCallback(() => {
    const name = `--custom-${Date.now()}`
    const updated = {
      ...variables,
      [name]: { value: '#ffffff', type: 'color', label: 'Custom Variable' },
    }
    setVariables(updated)
    onUpdate(updated)
  }, [variables, onUpdate])

  const handleRemoveVariable = useCallback((name) => {
    const updated = { ...variables }
    delete updated[name]
    setVariables(updated)
    onUpdate(updated)
  }, [variables, onUpdate])

  return (
    <div className="border-t border-border bg-bg-secondary/50 max-h-48">
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-border">
        <span className="text-xs font-medium text-text-secondary">CSS Variables</span>
        <div className="flex items-center gap-1">
          {!preset.is_builtin && (
            <button onClick={handleAddVariable}
              className="text-[10px] px-1.5 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-0.5">
              <Plus className="w-3 h-3" /> Add
            </button>
          )}
          <button onClick={onClose} className="p-0.5 rounded hover:bg-bg-secondary text-text-tertiary">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="overflow-y-auto max-h-32 p-2 space-y-1">
        {Object.entries(variables).map(([name, meta]) => {
          const val = typeof meta === 'object' ? meta : { value: meta, type: 'text', label: name }
          const isColor = val.type === 'color' || (val.value && val.value.startsWith('#'))
          return (
            <div key={name} className="flex items-center gap-2 text-xs">
              <code className="text-[10px] text-text-tertiary truncate w-36" title={name}>{name}</code>
              <input
                type="text"
                value={val.label || ''}
                onChange={e => handleLabelChange(name, e.target.value)}
                disabled={preset.is_builtin}
                className="bg-bg-primary border border-border rounded px-1.5 py-0.5 text-[10px] text-text-primary w-28 focus:border-blue-500 focus:outline-none disabled:opacity-50"
                placeholder="Label"
              />
              <div className="flex items-center gap-1 flex-1">
                {isColor && (
                  <input
                    type="color"
                    value={val.value || '#ffffff'}
                    onChange={e => handleValueChange(name, e.target.value)}
                    disabled={preset.is_builtin}
                    className="w-5 h-5 rounded cursor-pointer border border-border"
                  />
                )}
                <input
                  type="text"
                  value={val.value || ''}
                  onChange={e => handleValueChange(name, e.target.value)}
                  disabled={preset.is_builtin}
                  className="flex-1 bg-bg-primary border border-border rounded px-1.5 py-0.5 text-[10px] text-text-primary font-mono focus:border-blue-500 focus:outline-none disabled:opacity-50"
                />
              </div>
              {!preset.is_builtin && (
                <button onClick={() => handleRemoveVariable(name)}
                  className="p-0.5 rounded hover:bg-red-700/50 text-text-tertiary hover:text-red-400">
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
