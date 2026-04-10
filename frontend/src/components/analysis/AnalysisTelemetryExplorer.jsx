import { useState, useEffect, useCallback, useMemo } from 'react'
import { Search, ChevronDown, ChevronRight, Table2, X, Database, User } from 'lucide-react'
import { apiGet } from '../../services/api'

const SESSION_STATE_LABELS = {
  0: 'Invalid', 1: 'GetInCar', 2: 'Warmup',
  3: 'Parade', 4: 'Racing', 5: 'Checkered', 6: 'Cooldown',
}
const SURFACE_LABELS = {
  0: 'Off-track', 1: 'Pit lane', 2: 'Pit apron', 3: 'On track',
}

/**
 * AnalysisTelemetryExplorer — browse the project's race_ticks + car_states DB.
 * Catalog shows Session/Flags columns (race_ticks) and Per Car columns (car_states).
 * When a Per Car column is selected a driver picker appears.
 */
export default function AnalysisTelemetryExplorer({ projectId, analysisStatus, onClose }) {
  const [catalog, setCatalog]               = useState(null)
  const [cars, setCars]                     = useState([])
  const [search, setSearch]                 = useState('')
  const [selectedCol, setSelectedCol]       = useState(null)
  const [selectedMeta, setSelectedMeta]     = useState(null)
  const [selectedCarIdx, setSelectedCarIdx] = useState(null)
  const [tickData, setTickData]             = useState(null)
  const [tickOffset, setTickOffset]         = useState(0)
  const [loadingTicks, setLoadingTicks]     = useState(false)
  const [expandedGroup, setExpandedGroup]   = useState(null)

  // Load catalog + car list on mount
  useEffect(() => {
    if (!projectId) return
    Promise.all([
      apiGet(`/projects/${projectId}/analysis/ticks/catalog`),
      apiGet(`/projects/${projectId}/analysis/cars`),
    ]).then(([catRes, carRes]) => {
      const c = catRes.catalog || []
      setCatalog(c)
      setCars(carRes.cars || [])
      if (c.length) setExpandedGroup(c[0].group)
    }).catch(() => { setCatalog([]); setCars([]) })
  }, [projectId])

  // Auto-select first car when switching to a Per Car column
  useEffect(() => {
    if (selectedMeta?.table === 'car_states' && selectedCarIdx === null && cars.length > 0) {
      setSelectedCarIdx(cars[0].car_idx)
    }
  }, [selectedMeta, selectedCarIdx, cars])

  // Fetch ticks when selection changes
  const fetchTicks = useCallback(() => {
    if (!projectId || !selectedCol) { setTickData(null); return }
    const isCarCol = selectedMeta?.table === 'car_states'
    if (isCarCol && selectedCarIdx === null) { setTickData(null); return }

    setLoadingTicks(true)
    const params = new URLSearchParams({
      col:    selectedCol,
      table:  isCarCol ? 'car_states' : 'race_ticks',
      offset: tickOffset,
      limit:  100,
    })
    if (isCarCol) params.set('car_idx', selectedCarIdx)

    apiGet(`/projects/${projectId}/analysis/ticks?${params}`)
      .then((d) => setTickData(d))
      .catch(() => setTickData(null))
      .finally(() => setLoadingTicks(false))
  }, [projectId, selectedCol, selectedMeta, selectedCarIdx, tickOffset])

  useEffect(() => { fetchTicks() }, [fetchTicks])

  const handleSelectCol = useCallback((colName, meta) => {
    setSelectedCol(colName)
    setSelectedMeta(meta)
    setTickOffset(0)
    if (meta?.table !== selectedMeta?.table) setSelectedCarIdx(null)
  }, [selectedMeta])

  // Group variables
  const groups = useMemo(() => {
    if (!catalog) return {}
    const filtered = search
      ? catalog.filter((v) =>
          v.name.toLowerCase().includes(search.toLowerCase()) ||
          v.desc?.toLowerCase().includes(search.toLowerCase())
        )
      : catalog
    return filtered.reduce((acc, v) => {
      const g = v.group || 'Other'
      if (!acc[g]) acc[g] = []
      acc[g].push(v)
      return acc
    }, {})
  }, [catalog, search])

  const groupNames = useMemo(() => {
    const order = ['Session', 'Flags', 'Per Car']
    return Object.keys(groups).sort((a, b) => {
      const ai = order.indexOf(a), bi = order.indexOf(b)
      if (ai === -1 && bi === -1) return a.localeCompare(b)
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
  }, [groups])

  const totalVars    = catalog?.length ?? 0
  const isCarColumn  = selectedMeta?.table === 'car_states'
  const selectedCar  = cars.find((c) => c.car_idx === selectedCarIdx)

  const sizeLabel = analysisStatus?.db_size_bytes >= 1_048_576
    ? `${(analysisStatus.db_size_bytes / 1_048_576).toFixed(1)} MB`
    : analysisStatus?.db_size_bytes > 0
      ? `${Math.round(analysisStatus.db_size_bytes / 1024)} KB`
      : null

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg-primary">

      {/* Header */}
      <div className="shrink-0 px-4 pt-3 pb-3 border-b border-border flex items-center gap-3">
        <Database className="w-4 h-4 text-accent shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3">
            <h2 className="text-sm font-bold text-text-primary">Telemetry Explorer</h2>
            <span className="text-xxs text-text-disabled shrink-0">{totalVars} columns</span>
          </div>
          <div className="flex flex-wrap gap-3 mt-0.5">
            {analysisStatus?.total_ticks != null && (
              <Badge label="Ticks" value={analysisStatus.total_ticks.toLocaleString()} />
            )}
            {cars.length > 0 && <Badge label="Cars" value={cars.length} />}
            {sizeLabel && <Badge label="Size" value={sizeLabel} />}
          </div>
        </div>
        <button
          onClick={onClose}
          title="Close explorer"
          className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md
                     text-text-disabled hover:text-text-primary hover:bg-surface-hover transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Body */}
      {!catalog ? (
        <div className="flex items-center justify-center flex-1 text-text-disabled text-sm">
          Loading catalog…
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">

          {/* Variable catalog panel */}
          <div className="w-56 shrink-0 flex flex-col border-r border-border overflow-hidden">
            {/* Search */}
            <div className="p-2 border-b border-border">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-disabled" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter columns…"
                  className="w-full pl-7 pr-2 py-1.5 bg-bg-primary border border-border rounded-md
                             text-xs text-text-primary placeholder-text-disabled
                             focus:outline-none focus:border-accent transition-colors"
                />
              </div>
            </div>

            {/* Groups */}
            <div className="flex-1 overflow-y-auto">
              {groupNames.length === 0 && (
                <p className="text-xxs text-text-disabled text-center py-4">No columns match</p>
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
                      onClick={() => handleSelectCol(v.name, v)}
                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors
                        ${selectedCol === v.name
                          ? 'bg-accent/10 text-accent'
                          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                        }`}
                    >
                      <div className="truncate font-medium font-mono">{v.name}</div>
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
            {!selectedCol ? (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-text-disabled">
                <Table2 className="w-6 h-6 opacity-40" />
                <p className="text-xs">Select a column to view tick data</p>
              </div>
            ) : (
              <>
                {/* Column info + driver picker */}
                <div className="shrink-0 px-4 py-2 border-b border-border bg-bg-secondary flex items-center gap-4 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-bold text-text-primary font-mono">{selectedCol}</span>
                    {selectedMeta?.desc && (
                      <span className="text-xs text-text-tertiary ml-2">{selectedMeta.desc}</span>
                    )}
                    {isCarColumn && selectedCar && tickData && (
                      <span className="text-xxs text-text-disabled ml-2">
                        · {tickData.total?.toLocaleString()} rows
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {selectedMeta?.unit && (
                      <span className="bg-surface px-1.5 py-0.5 rounded font-mono text-xxs text-text-disabled">
                        {selectedMeta.unit}
                      </span>
                    )}
                    {/* Driver picker — only shown for Per Car columns */}
                    {isCarColumn && cars.length > 0 && (
                      <div className="flex items-center gap-1.5">
                        <User size={12} className="text-text-disabled shrink-0" />
                        <select
                          value={selectedCarIdx ?? ''}
                          onChange={(e) => { setSelectedCarIdx(Number(e.target.value)); setTickOffset(0) }}
                          className="text-xs bg-bg-primary border border-border rounded px-1.5 py-0.5
                                     text-text-primary focus:outline-none focus:border-accent"
                        >
                          {cars.map((car) => (
                            <option key={car.car_idx} value={car.car_idx}>
                              #{car.car_number} {car.user_name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                </div>

                {/* Table */}
                <div className="flex-1 overflow-auto">
                  {loadingTicks ? (
                    <div className="flex items-center justify-center h-32 text-text-disabled text-xs">
                      Loading ticks…
                    </div>
                  ) : tickData?.ticks?.length ? (
                    <table className="w-full text-xs border-collapse">
                      <thead className="sticky top-0 bg-bg-secondary z-10">
                        <tr>
                          <Th>Tick</Th>
                          <Th>Session Time (s)</Th>
                          <Th>State</Th>
                          <Th>Frame</Th>
                          <Th className="w-full">{selectedCol}</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {tickData.ticks.map((tick) => (
                          <tr key={`${tick.id}-${selectedCarIdx ?? ''}`} className="border-b border-border/30 hover:bg-surface-hover/50">
                            <Td mono>{tick.id}</Td>
                            <Td mono>{tick.session_time?.toFixed(3) ?? '—'}</Td>
                            <Td>{SESSION_STATE_LABELS[tick.session_state] ?? tick.session_state}</Td>
                            <Td mono>{tick.replay_frame}</Td>
                            <Td mono className="max-w-0 truncate">
                              <ValueCell value={tick.value} col={selectedCol} />
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="flex items-center justify-center h-32 text-text-disabled text-xs">
                      No tick data
                    </div>
                  )}
                </div>

                {/* Pagination */}
                {tickData && (
                  <div className="shrink-0 flex items-center justify-between px-4 py-2 border-t border-border text-xs text-text-disabled">
                    <span>
                      {tickOffset + 1}–{Math.min(tickOffset + (tickData.ticks?.length ?? 0), tickData.total)} of {tickData.total?.toLocaleString()}
                    </span>
                    <div className="flex gap-2">
                      <PagBtn onClick={() => setTickOffset(0)} disabled={tickOffset === 0}>«</PagBtn>
                      <PagBtn onClick={() => setTickOffset(Math.max(0, tickOffset - 100))} disabled={tickOffset === 0}>‹</PagBtn>
                      <PagBtn
                        onClick={() => setTickOffset(tickOffset + 100)}
                        disabled={tickOffset + (tickData.ticks?.length ?? 0) >= tickData.total}
                      >›</PagBtn>
                      <PagBtn
                        onClick={() => setTickOffset(Math.max(0, tickData.total - 100))}
                        disabled={tickOffset + (tickData.ticks?.length ?? 0) >= tickData.total}
                      >»</PagBtn>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

        </div>
      )}
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

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

function ValueCell({ value, col }) {
  if (value === null || value === undefined) return <span className="text-text-disabled">—</span>
  if (col === 'surface') return <span>{SURFACE_LABELS[value] ?? value}</span>
  if (col === 'speed_ms' && typeof value === 'number') return <span>{(value * 3.6).toFixed(1)} km/h</span>
  if (col === 'lap_pct' && typeof value === 'number')  return <span>{(value * 100).toFixed(2)}%</span>
  if ((col === 'best_lap_time' || col === 'est_time') && value === -1) return <span className="text-text-disabled">—</span>
  if (typeof value === 'number') return <span>{Number.isInteger(value) ? String(value) : value.toFixed(4)}</span>
  return <span>{String(value)}</span>
}

function PagBtn({ children, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-2 py-0.5 rounded border border-border text-xs disabled:opacity-30
                 hover:bg-surface-hover transition-colors disabled:cursor-not-allowed"
    >
      {children}
    </button>
  )
}
