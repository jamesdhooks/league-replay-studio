import { useState, useEffect, useCallback, useMemo } from 'react'
import { Search, ChevronDown, ChevronRight, Table2, Info } from 'lucide-react'
import { collectionService } from '../../services/collectionService'

// iRacing var type constants (from irsdk)
const TYPE_LABELS = {
  0: 'char',
  1: 'bool',
  2: 'int',
  3: 'bitmask',
  4: 'float',
  5: 'double',
}

/**
 * TelemetryExplorer — shows the variable catalog and tick data viewer
 * for a selected collection file.
 */
function TelemetryExplorer({ file }) {
  const [catalog, setCatalog] = useState(null)
  const [search, setSearch] = useState('')
  const [selectedVar, setSelectedVar] = useState(null)
  const [tickData, setTickData] = useState(null)
  const [tickOffset, setTickOffset] = useState(0)
  const [loadingTicks, setLoadingTicks] = useState(false)
  const [expandedGroup, setExpandedGroup] = useState(null)

  // Load catalog when file changes
  useEffect(() => {
    if (!file) { setCatalog(null); setSelectedVar(null); setTickData(null); return }
    collectionService.getCatalog(file.filename).then(({ catalog: c }) => {
      setCatalog(c || [])
    }).catch(() => setCatalog([]))
  }, [file])

  // Load ticks when selectedVar or offset changes
  useEffect(() => {
    if (!file || !selectedVar) { setTickData(null); return }
    setLoadingTicks(true)
    collectionService.getTicks(file.filename, {
      offset: tickOffset,
      limit: 100,
      vars: [selectedVar],
    }).then((d) => {
      setTickData(d)
    }).catch(() => setTickData(null))
      .finally(() => setLoadingTicks(false))
  }, [file, selectedVar, tickOffset])

  // Group variables by their prefix (e.g. "CarIdx*", "Session*", etc.)
  const groups = useMemo(() => {
    if (!catalog) return {}
    const filtered = search
      ? catalog.filter((v) =>
          v.name.toLowerCase().includes(search.toLowerCase()) ||
          v.desc?.toLowerCase().includes(search.toLowerCase())
        )
      : catalog

    return filtered.reduce((acc, v) => {
      // Group by first capitalised word run: "CarIdxSpeed" → "CarIdx"
      const match = v.name.match(/^([A-Z][a-z]*)([A-Z])/)
      const group = match ? match[1] : 'Other'
      if (!acc[group]) acc[group] = []
      acc[group].push(v)
      return acc
    }, {})
  }, [catalog, search])

  const groupNames = useMemo(() => Object.keys(groups).sort(), [groups])
  const totalVars = catalog?.length ?? 0

  if (!file) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-disabled">
        <Info className="w-8 h-8 opacity-40" />
        <p className="text-sm">Select a collection file to explore its telemetry</p>
      </div>
    )
  }

  if (!catalog) {
    return (
      <div className="flex items-center justify-center h-full text-text-disabled text-sm">
        Loading catalog…
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* File info header */}
      <div className="shrink-0 px-4 pt-4 pb-3 border-b border-border">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-bold text-text-primary truncate">{file.filename}</h2>
          <span className="text-xxs text-text-disabled ml-2 shrink-0">{totalVars} variables</span>
        </div>
        <div className="flex flex-wrap gap-3 mt-1.5">
          {file.track_name && <Badge label="Track" value={file.track_name} />}
          {file.session_type && <Badge label="Type" value={file.session_type} />}
          {file.sample_hz && <Badge label="Hz" value={`${file.sample_hz} Hz`} />}
          {file.tick_count_db != null && <Badge label="Ticks" value={file.tick_count_db?.toLocaleString()} />}
          {file.started_at && <Badge label="Recorded" value={new Date(file.started_at).toLocaleString()} />}
        </div>
      </div>

      {/* Main split: left = catalog, right = tick viewer */}
      <div className="flex flex-1 overflow-hidden">

        {/* Variable catalog panel */}
        <div className="w-60 shrink-0 flex flex-col border-r border-border overflow-hidden">
          {/* Search */}
          <div className="p-2 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-disabled" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search variables…"
                className="w-full pl-7 pr-2 py-1.5 bg-bg-primary border border-border rounded-md
                           text-xs text-text-primary placeholder-text-disabled
                           focus:outline-none focus:border-accent transition-colors"
              />
            </div>
          </div>

          {/* Groups + variables */}
          <div className="flex-1 overflow-y-auto">
            {groupNames.length === 0 && (
              <p className="text-xxs text-text-disabled text-center py-4">No variables match</p>
            )}
            {groupNames.map((gName) => (
              <div key={gName}>
                <button
                  onClick={() => setExpandedGroup(expandedGroup === gName ? null : gName)}
                  className="w-full flex items-center justify-between px-3 py-1.5
                             text-xxs font-semibold text-text-tertiary uppercase tracking-wider
                             hover:bg-surface-hover transition-colors"
                >
                  <span>{gName}</span>
                  <div className="flex items-center gap-1">
                    <span className="text-text-disabled font-normal normal-case">{groups[gName].length}</span>
                    {expandedGroup === gName
                      ? <ChevronDown className="w-3 h-3" />
                      : <ChevronRight className="w-3 h-3" />
                    }
                  </div>
                </button>
                {expandedGroup === gName && groups[gName].map((v) => (
                  <button
                    key={v.name}
                    onClick={() => { setSelectedVar(v.name); setTickOffset(0) }}
                    className={`w-full text-left px-3 py-1.5 text-xs transition-colors
                      ${selectedVar === v.name
                        ? 'bg-accent/10 text-accent'
                        : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                      }`}
                  >
                    <div className="truncate font-medium">{v.name}</div>
                    {v.desc && (
                      <div className="truncate text-xxs text-text-disabled mt-0.5">{v.desc}</div>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Tick data panel */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {!selectedVar ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-text-disabled">
              <Table2 className="w-6 h-6 opacity-40" />
              <p className="text-xs">Select a variable to view tick data</p>
            </div>
          ) : (
            <>
              {/* Variable info bar */}
              <div className="shrink-0 px-4 py-2 border-b border-border bg-bg-secondary">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-bold text-text-primary">{selectedVar}</span>
                    {catalog.find((v) => v.name === selectedVar)?.desc && (
                      <span className="text-xs text-text-tertiary ml-2">
                        {catalog.find((v) => v.name === selectedVar).desc}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xxs text-text-disabled">
                    {catalog.find((v) => v.name === selectedVar)?.unit && (
                      <span className="bg-surface px-1.5 py-0.5 rounded font-mono">
                        {catalog.find((v) => v.name === selectedVar).unit}
                      </span>
                    )}
                    <span className="bg-surface px-1.5 py-0.5 rounded font-mono">
                      {TYPE_LABELS[catalog.find((v) => v.name === selectedVar)?.var_type] ?? 'unknown'}
                    </span>
                    {catalog.find(v => v.name === selectedVar)?.count > 1 && (
                      <span className="bg-surface px-1.5 py-0.5 rounded font-mono">
                        [{catalog.find(v => v.name === selectedVar).count}]
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Tick table */}
              <div className="flex-1 overflow-auto">
                {loadingTicks ? (
                  <div className="flex items-center justify-center h-32 text-text-disabled text-xs">
                    Loading ticks…
                  </div>
                ) : tickData ? (
                  <table className="w-full text-xs border-collapse">
                    <thead className="sticky top-0 bg-bg-secondary z-10">
                      <tr>
                        <Th>#</Th>
                        <Th>Session Time (s)</Th>
                        <Th>State</Th>
                        <Th>Frame</Th>
                        <Th className="w-full">Value</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {tickData.ticks.map((tick) => {
                        const val = tick.data[selectedVar]
                        return (
                          <tr key={tick.id} className="border-b border-border/30 hover:bg-surface-hover/50">
                            <Td mono>{tick.id}</Td>
                            <Td mono>{tick.session_time?.toFixed(3) ?? '—'}</Td>
                            <Td>{SESSION_STATE_LABELS[tick.session_state] ?? tick.session_state}</Td>
                            <Td mono>{tick.replay_frame}</Td>
                            <Td mono className="max-w-0 truncate">
                              <ValueCell value={val} />
                            </Td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                ) : null}
              </div>

              {/* Pagination */}
              {tickData && (
                <div className="shrink-0 flex items-center justify-between px-4 py-2 border-t border-border text-xs text-text-disabled">
                  <span>
                    {tickData.offset + 1}–{Math.min(tickData.offset + tickData.ticks.length, tickData.total)} of {tickData.total?.toLocaleString()} ticks
                  </span>
                  <div className="flex gap-2">
                    <PagBtn onClick={() => setTickOffset(0)} disabled={tickOffset === 0}>«</PagBtn>
                    <PagBtn onClick={() => setTickOffset(Math.max(0, tickOffset - 100))} disabled={tickOffset === 0}>‹</PagBtn>
                    <PagBtn
                      onClick={() => setTickOffset(tickOffset + 100)}
                      disabled={tickOffset + 100 >= tickData.total}
                    >›</PagBtn>
                    <PagBtn
                      onClick={() => setTickOffset(Math.max(0, tickData.total - 100))}
                      disabled={tickOffset + 100 >= tickData.total}
                    >»</PagBtn>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const SESSION_STATE_LABELS = {
  0: 'Invalid', 1: 'GetInCar', 2: 'Warmup',
  3: 'Parade', 4: 'Racing', 5: 'Checkered', 6: 'Cooldown',
}

function Badge({ label, value }) {
  return (
    <div className="flex items-center gap-1 text-xxs">
      <span className="text-text-disabled">{label}:</span>
      <span className="text-text-secondary font-medium">{value}</span>
    </div>
  )
}

function Th({ children, className = '' }) {
  return (
    <th className={`px-3 py-2 text-left text-xxs font-semibold text-text-tertiary uppercase tracking-wider
                    border-b border-border ${className}`}>
      {children}
    </th>
  )
}

function Td({ children, mono = false, className = '' }) {
  return (
    <td className={`px-3 py-1.5 text-text-secondary ${mono ? 'font-mono' : ''} ${className}`}>
      {children}
    </td>
  )
}

function PagBtn({ children, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-2 py-0.5 rounded border text-xs transition-colors
        ${disabled
          ? 'border-border text-text-disabled cursor-not-allowed opacity-40'
          : 'border-border text-text-secondary hover:bg-surface-hover hover:text-text-primary cursor-pointer'
        }`}
    >
      {children}
    </button>
  )
}

function ValueCell({ value }) {
  if (value === null || value === undefined) return <span className="text-text-disabled">—</span>
  if (Array.isArray(value)) {
    const preview = value.slice(0, 8).map((v) =>
      typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(4)) : String(v)
    ).join(', ')
    return (
      <span title={JSON.stringify(value)}>
        [{preview}{value.length > 8 ? `, … (${value.length})` : ''}]
      </span>
    )
  }
  if (typeof value === 'number') {
    return <span>{Number.isInteger(value) ? value : value.toFixed(5)}</span>
  }
  return <span>{String(value)}</span>
}

export default TelemetryExplorer
