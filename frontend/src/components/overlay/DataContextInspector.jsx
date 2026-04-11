import { useState, useCallback, useMemo } from 'react'
import {
  BookOpen, Copy, ChevronDown, ChevronRight, Search,
  Activity, Cpu, Plug, Monitor,
} from 'lucide-react'

/**
 * Variable source grouping — maps source IDs from VARIABLE_SOURCES
 * to display metadata.
 */
const SOURCE_GROUPS = {
  telemetry: { label: 'Telemetry', icon: Activity, color: 'text-blue-400', badge: 'bg-blue-500/15 text-blue-400' },
  computed:  { label: 'Computed',  icon: Cpu,      color: 'text-amber-400', badge: 'bg-amber-500/15 text-amber-400' },
  plugin:    { label: '3rd Party', icon: Plug,     color: 'text-emerald-400', badge: 'bg-emerald-500/15 text-emerald-400' },
}

/**
 * DataContextInspector — Shows available Jinja2 template variables with sample
 * values, grouped by data source (Telemetry / Computed / 3rd Party Plugin).
 *
 * Displays a searchable tree of template variables that users can click
 * to copy the Jinja2 expression (e.g., {{ frame.driver_name }}).
 */
export default function DataContextInspector({ variables, variableDocs, variableSources, onInsertVariable }) {
  const [search, setSearch] = useState('')
  const [expandedSections, setExpandedSections] = useState({
    telemetry: true, computed: true, plugin: true, resolution: false,
  })
  const [copiedKey, setCopiedKey] = useState(null)

  // ── Group variables by source ──────────────────────────────────────────
  const groupedVars = useMemo(() => {
    const groups = { telemetry: {}, computed: {}, plugin: {} }
    const src = variableSources || {}
    const vars = variables || {}

    for (const [key, value] of Object.entries(vars)) {
      const source = src[key] || 'telemetry'
      if (groups[source]) {
        groups[source][key] = value
      } else {
        groups.telemetry[key] = value
      }
    }
    // Always include resolution as a separate group
    groups.resolution = { width: 1920, height: 1080 }
    return groups
  }, [variables, variableSources])

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
    if (onInsertVariable) onInsertVariable(expression)
  }, [onInsertVariable])

  // ── Render a single variable entry ───────────────────────────────────────
  const renderEntry = (prefix, key, value, source) => {
    const fullKey = `${prefix}.${key}`
    const doc = variableDocs?.[fullKey] || ''
    const matchesSearch = !search
      || fullKey.toLowerCase().includes(search.toLowerCase())
      || doc.toLowerCase().includes(search.toLowerCase())
      || key.toLowerCase().includes(search.toLowerCase())

    if (!matchesSearch) return null

    const isArray = Array.isArray(value)
    const isObject = value && typeof value === 'object' && !isArray
    const displayValue = isArray
      ? `Array[${value.length}]`
      : isObject ? '{...}'
      : value === null ? 'null'
      : JSON.stringify(value)

    const sg = SOURCE_GROUPS[source]

    return (
      <div
        key={fullKey}
        onClick={() => copyVariable(fullKey)}
        className="group flex items-start gap-2 px-2 py-1 rounded cursor-pointer hover:bg-bg-secondary/80 transition-colors"
        title={doc || `Click to copy {{ ${fullKey} }}`}
      >
        <code className={`text-[11px] font-mono whitespace-nowrap flex-shrink-0 ${sg?.color || 'text-blue-400'}`}>
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

  // ── Count matching entries per group ──────────────────────────────────────
  const sectionOrder = ['telemetry', 'computed', 'plugin', 'resolution']

  return (
    <div className="flex flex-col h-full bg-bg-primary border-t border-border">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <BookOpen className="w-4 h-4 text-amber-400" />
        <span className="text-xs font-medium text-text-secondary">Variable Reference</span>
        <span className="text-[10px] text-text-disabled ml-auto">
          {Object.keys(variables || {}).length} vars
        </span>
      </div>

      {/* ── Search ──────────────────────────────────────────────────────── */}
      <div className="px-3 py-1.5 border-b border-border">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-tertiary" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search variables..."
            className="w-full bg-bg-secondary border border-border rounded pl-6 pr-2 py-1 text-xxs text-text-primary focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      {/* ── Variable tree grouped by source ──────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {sectionOrder.map(section => {
          const data = groupedVars[section] || {}
          const entries = typeof data === 'object' && data !== null ? Object.entries(data) : []
          const isExpanded = expandedSections[section]
          const sg = SOURCE_GROUPS[section]
          const SectionIcon = sg?.icon || Monitor

          // Count visible entries for the badge
          const visibleCount = search
            ? entries.filter(([key]) => {
                const fullKey = section === 'resolution' ? `resolution.${key}` : `frame.${key}`
                const doc = variableDocs?.[fullKey] || ''
                return fullKey.toLowerCase().includes(search.toLowerCase())
                  || doc.toLowerCase().includes(search.toLowerCase())
                  || key.toLowerCase().includes(search.toLowerCase())
              }).length
            : entries.length

          if (visibleCount === 0 && search) return null

          return (
            <div key={section}>
              {/* Section header */}
              <button
                onClick={() => toggleSection(section)}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xxs font-medium text-text-secondary hover:bg-bg-secondary/50"
              >
                {isExpanded
                  ? <ChevronDown className="w-3 h-3 text-text-tertiary" />
                  : <ChevronRight className="w-3 h-3 text-text-tertiary" />
                }
                <SectionIcon className={`w-3 h-3 ${sg?.color || 'text-text-tertiary'}`} />
                <span className={sg?.color || 'text-purple-400'}>
                  {sg?.label || section}
                </span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full ml-1 ${sg?.badge || 'bg-bg-secondary text-text-tertiary'}`}>
                  {visibleCount}
                </span>
              </button>

              {/* Section entries */}
              {isExpanded && (
                <div className="pl-3 pr-1 pb-1">
                  {entries.map(([key, value]) =>
                    renderEntry(section === 'resolution' ? 'resolution' : 'frame', key, value, section)
                  )}
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
      <div className="px-3 py-1.5 border-t border-border">
        <p className="text-[10px] text-text-tertiary leading-relaxed">
          Click a variable to copy its Jinja2 expression.
          Use <code className="text-accent">{'{{ frame.variable }}'}</code> in your template HTML.
        </p>
      </div>
    </div>
  )
}
