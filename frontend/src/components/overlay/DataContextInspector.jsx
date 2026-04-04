import { useState, useCallback } from 'react'
import { BookOpen, Copy, ChevronDown, ChevronRight, Search } from 'lucide-react'

/**
 * DataContextInspector — Shows available Jinja2 template variables with sample values.
 *
 * Displays a searchable tree of template variables that users can click
 * to copy the Jinja2 expression (e.g., {{ frame.driver_name }}).
 */
export default function DataContextInspector({ variables, variableDocs, onInsertVariable }) {
  const [search, setSearch] = useState('')
  const [expandedSections, setExpandedSections] = useState({ frame: true, resolution: false })
  const [copiedKey, setCopiedKey] = useState(null)

  // ── Group variables by top-level key ─────────────────────────────────────
  const groups = {
    frame: variables || {},
    resolution: { width: 1920, height: 1080 },
  }

  // ── Toggle section ───────────────────────────────────────────────────────
  const toggleSection = useCallback((section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }))
  }, [])

  // ── Copy variable expression ─────────────────────────────────────────────
  const copyVariable = useCallback((key) => {
    const expression = `{{ ${key} }}`
    navigator.clipboard.writeText(expression).catch(() => {})
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1500)

    if (onInsertVariable) {
      onInsertVariable(expression)
    }
  }, [onInsertVariable])

  // ── Render a variable entry ──────────────────────────────────────────────
  const renderEntry = (prefix, key, value) => {
    const fullKey = `${prefix}.${key}`
    const docKey = `${prefix}.${key}`
    const doc = variableDocs?.[docKey] || ''
    const matchesSearch = !search || fullKey.toLowerCase().includes(search.toLowerCase()) || doc.toLowerCase().includes(search.toLowerCase())

    if (!matchesSearch) return null

    const isArray = Array.isArray(value)
    const isObject = value && typeof value === 'object' && !isArray
    const displayValue = isArray
      ? `Array[${value.length}]`
      : isObject
        ? '{...}'
        : JSON.stringify(value)

    return (
      <div
        key={fullKey}
        onClick={() => copyVariable(fullKey)}
        className="group flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-bg-secondary/80 transition-colors"
        title={doc || `Click to copy {{ ${fullKey} }}`}
      >
        <code className="text-[11px] text-blue-400 font-mono whitespace-nowrap flex-shrink-0">
          {key}
        </code>
        <span className="text-[10px] text-text-tertiary truncate flex-1 font-mono">
          {displayValue}
        </span>
        <span className={`text-[10px] transition-opacity flex-shrink-0 ${
          copiedKey === fullKey ? 'text-green-400 opacity-100' : 'text-text-tertiary opacity-0 group-hover:opacity-100'
        }`}>
          {copiedKey === fullKey ? 'Copied!' : <Copy className="w-3 h-3" />}
        </span>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-bg-primary border-t border-border">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <BookOpen className="w-4 h-4 text-amber-400" />
        <span className="text-xs font-medium text-text-secondary">Data Context</span>
      </div>

      {/* ── Search ──────────────────────────────────────────────────────── */}
      <div className="px-3 py-2 border-b border-border">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-tertiary" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search variables..."
            className="w-full bg-bg-secondary border border-border rounded pl-6 pr-2 py-1 text-xs text-text-primary focus:border-blue-500 focus:outline-none"
          />
        </div>
      </div>

      {/* ── Variable tree ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {Object.entries(groups).map(([section, data]) => {
          const entries = typeof data === 'object' && data !== null ? Object.entries(data) : []
          const isExpanded = expandedSections[section]

          return (
            <div key={section}>
              {/* Section header */}
              <button
                onClick={() => toggleSection(section)}
                className="w-full flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-secondary/50"
              >
                {isExpanded ? (
                  <ChevronDown className="w-3 h-3 text-text-tertiary" />
                ) : (
                  <ChevronRight className="w-3 h-3 text-text-tertiary" />
                )}
                <span className="font-mono text-purple-400">{section}</span>
                <span className="text-text-tertiary ml-1">({entries.length})</span>
              </button>

              {/* Section entries */}
              {isExpanded && (
                <div className="pl-3 pr-1 pb-1">
                  {entries.map(([key, value]) => renderEntry(section, key, value))}
                  {entries.length === 0 && (
                    <div className="px-2 py-1 text-[10px] text-text-tertiary italic">
                      No variables available
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ── Help text ───────────────────────────────────────────────────── */}
      <div className="px-3 py-2 border-t border-border">
        <p className="text-[10px] text-text-tertiary leading-relaxed">
          Click a variable to copy its Jinja2 expression.
          Use <code className="text-blue-400">{'{{ frame.variable }}'}</code> in your template.
        </p>
      </div>
    </div>
  )
}
