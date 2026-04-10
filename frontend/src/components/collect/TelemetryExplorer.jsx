import { useState, useEffect, useMemo } from 'react'
import { Search, ChevronDown, ChevronRight, Table2, Info } from 'lucide-react'
import { collectionService } from '../../services/collectionService'

// iRacing var type constants (from irsdk)
const TYPE_LABELS = { 0: 'char', 1: 'bool', 2: 'int', 3: 'bitmask', 4: 'float', 5: 'double' }
const TYPE_ABBREV  = { 0: 'str',  1: 'bool', 2: 'int', 3: 'bits',    4: 'f32',   5: 'f64' }
const TYPE_COLORS  = {
  0: 'text-purple-400',
  1: 'text-green-400',
  2: 'text-slate-400',
  3: 'text-orange-400',
  4: 'text-blue-400',
  5: 'text-cyan-400',
}

// Ordered prefix rules — first match wins.
// Eliminates single-word orphan groups from the fallback camelCase heuristic.
const GROUP_RULES = [
  [/^CarIdx/,                                                           'CarIdx'],
  [/^(CarClass|PlayerCar|Car)/,                                         'Car'],
  // iRacing diagnostics / network (match before generic fallback catches them)
  [/^(Chan[A-Z]|CpuUsage|GpuUsage|Mem[A-Z]|FrameRate|VidCap|DisplayUnits|Voltage|Driver)/,  'Performance'],
  // Shock/susp before generic 4-corner rule
  [/^(LF|RF|LR|RR)Shock/,                                              'Shock/Susp'],
  // All 4-corner tyre data + front/rear/left/right tyre-set counts
  [/^(LF|RF|LR|RR|FrontTire|RearTire|LeftTire|RightTire)/,             'Tyres'],
  [/^(Tire|WheelSpeed)/,                                                'Tyres'],
  [/^Brake/,                                                            'Brakes'],
  // dc* in-car controls + push-to-pass + P2P prefix
  [/^(dc[A-Z]|PushTo|P2P)/,                                            'Controls'],
  // Engine + hybrid manual buttons + handbrake
  [/^(Throttle|Clutch|Gear|Shift|RPM|Fuel|Oil|Mani|Water|Engine|Manual|Handbrake)/, 'Engine'],
  [/^(Speed|Vel|Lat|Lon|Yaw|Pitch|Roll|Vert|Accel|Steer)/,             'Motion'],
  // Weather/environment + solar + relative humidity
  [/^(Air|Weather|Wind|Fog|Skies|Precip|Track|Solar|Relative)/,        'Environment'],
  [/^(Lap|BestLap|LapBest|LastLap)/,                                   'Lap'],
  // Session + driver-change + Is*/Ok* state bools + misc screen state
  [/^(Session|Race|Quali|RaceLaps|DCDriver|DCLap|Is[A-Z]|Ok[A-Z]|Enter|Load[A-Z]|OnPit)/, 'Session'],
  // Pit: service settings, dp* pitstop knobs, fast repair, pace mode
  [/^(Pit|dp[A-Z]|FastRepair|PaceMode)/,                               'Pit'],
  [/^(Cam|Radio|Replay|Broadcast)/,                                     'System'],
  [/^Player/,                                                           'Car'],
  [/^P\d+/,                                                             'Results'],
]

function getVarGroup(name) {
  for (const [re, group] of GROUP_RULES) {
    if (re.test(name)) return group
  }
  // Fallback: camelCase prefix of 3+ chars, else 'Other'
  const m = name.match(/^([A-Z][a-z]{2,})(?=[A-Z0-9]|$)/)
  return m ? m[1] : 'Other'
}

const GROUP_ORDER = [
  'Motion', 'Engine', 'Brakes', 'Controls', 'Tyres', 'Shock/Susp',
  'Lap', 'Session', 'Car', 'CarIdx', 'Pit', 'Environment', 'Results', 'System', 'Performance', 'Other',
]

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
  const [arrayIndex, setArrayIndex] = useState(0)

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
    setArrayIndex(0)  // reset to element 0 whenever a new var is chosen
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
      const group = getVarGroup(v.name)
      if (!acc[group]) acc[group] = []
      acc[group].push(v)
      return acc
    }, {})
  }, [catalog, search])

  const groupNames = useMemo(() => {
    return Object.keys(groups).sort((a, b) => {
      const ai = GROUP_ORDER.indexOf(a), bi = GROUP_ORDER.indexOf(b)
      if (ai === -1 && bi === -1) return a.localeCompare(b)
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
  }, [groups])

  const selectedVarMeta = useMemo(
    () => catalog?.find((v) => v.name === selectedVar) ?? null,
    [catalog, selectedVar],
  )

  // Live statistics computed from the currently loaded tick window
  const tickStats = useMemo(() => {
    if (!tickData || !selectedVar) return null
    const values = []
    for (const tick of tickData.ticks) {
      const v = tick.data?.[selectedVar]
      if (v === null || v === undefined) continue
      const n = Array.isArray(v) ? v[arrayIndex] : v
      if (typeof n === 'number') values.push(n)
    }
    if (!values.length) return null
    const min = Math.min(...values)
    const max = Math.max(...values)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    return { min, max, mean, n: values.length }
  }, [tickData, selectedVar, arrayIndex])

  // Auto-expand the group that contains the newly selected variable
  useEffect(() => {
    if (!selectedVar || !catalog) return
    const meta = catalog.find((v) => v.name === selectedVar)
    if (meta) setExpandedGroup(getVarGroup(meta.name))
  }, [selectedVar, catalog])

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
          {file.tick_count_db !== null && file.tick_count_db !== undefined && <Badge label="Ticks" value={file.tick_count_db?.toLocaleString()} />}
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
                    className={`w-full text-left px-3 py-1.5 transition-colors
                      ${selectedVar === v.name
                        ? 'bg-accent/10 text-accent'
                        : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                      }`}
                  >
                    {/* Name row + type badge */}
                    <div className="flex items-center justify-between gap-1 min-w-0">
                      <span className="truncate text-xs font-medium">{v.name}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        {v.count > 1 && (
                          <span className="text-xxs font-mono text-orange-400/80">×{v.count}</span>
                        )}
                        <span className={`text-xxs font-mono ${TYPE_COLORS[v.var_type] ?? 'text-text-disabled'}`}>
                          {TYPE_ABBREV[v.var_type] ?? '?'}
                        </span>
                      </div>
                    </div>
                    {/* Unit */}
                    {v.unit && (
                      <div className="text-xxs text-text-disabled font-mono mt-0.5 truncate">{v.unit}</div>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Tick data panel */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {!selectedVar ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-text-disabled">
              <Table2 className="w-6 h-6 opacity-40" />
              <p className="text-xs">Select a variable to view tick data</p>
            </div>
          ) : (
            <>
              {/* Variable info bar */}
              <div className="shrink-0 px-4 py-2.5 border-b border-border bg-bg-secondary">
                {/* Name + description */}
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <div className="min-w-0">
                    <span className="text-sm font-bold text-text-primary">{selectedVar}</span>
                    {selectedVarMeta?.desc && (
                      <p className="text-xxs text-text-tertiary mt-0.5 leading-snug">{selectedVarMeta.desc}</p>
                    )}
                  </div>
                  {/* Type + unit pills */}
                  <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                    {selectedVarMeta?.unit && (
                      <span className="bg-surface px-1.5 py-0.5 rounded text-xxs font-mono text-text-secondary">
                        {selectedVarMeta.unit}
                      </span>
                    )}
                    <span className={`bg-surface px-1.5 py-0.5 rounded text-xxs font-mono
                      ${TYPE_COLORS[selectedVarMeta?.var_type] ?? 'text-text-disabled'}`}>
                      {TYPE_LABELS[selectedVarMeta?.var_type] ?? 'unknown'}
                    </span>
                    {selectedVarMeta?.count > 1 && (
                      <span className="bg-surface px-1.5 py-0.5 rounded text-xxs font-mono text-orange-400">
                        ×{selectedVarMeta.count}
                      </span>
                    )}
                  </div>
                </div>

                {/* Array index picker (for per-car / oversampled vars) */}
                {selectedVarMeta?.count > 1 && (
                  <div className="flex items-center gap-2 mt-1 mb-1">
                    <span className="text-xxs text-text-disabled">
                      {selectedVarMeta.count === 64 ? 'Car index:' : 'Element:'}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setArrayIndex((i) => Math.max(0, i - 1))}
                        disabled={arrayIndex === 0}
                        className="w-5 h-5 flex items-center justify-center rounded border border-border
                                   text-text-secondary hover:bg-surface-hover disabled:opacity-30 text-xs"
                      >‹</button>
                      <input
                        type="number"
                        min={0}
                        max={selectedVarMeta.count - 1}
                        value={arrayIndex}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10)
                          if (!isNaN(v)) setArrayIndex(Math.min(selectedVarMeta.count - 1, Math.max(0, v)))
                        }}
                        className="w-12 px-1.5 py-0.5 text-xs font-mono text-center
                                   bg-bg-primary border border-border rounded focus:outline-none focus:border-accent"
                      />
                      <button
                        onClick={() => setArrayIndex((i) => Math.min(selectedVarMeta.count - 1, i + 1))}
                        disabled={arrayIndex >= selectedVarMeta.count - 1}
                        className="w-5 h-5 flex items-center justify-center rounded border border-border
                                   text-text-secondary hover:bg-surface-hover disabled:opacity-30 text-xs"
                      >›</button>
                      <span className="text-xxs text-text-disabled">of {selectedVarMeta.count}</span>
                    </div>
                  </div>
                )}

                {/* Live min / max / mean from this tick window */}
                {tickStats && (
                  <div className="flex items-center gap-3 mt-1 text-xxs font-mono">
                    <span className="text-text-disabled">
                      min <span className="text-blue-400">{fmt(tickStats.min)}</span>
                    </span>
                    <span className="text-text-disabled">
                      max <span className="text-blue-400">{fmt(tickStats.max)}</span>
                    </span>
                    <span className="text-text-disabled">
                      avg <span className="text-cyan-400">{fmt(tickStats.mean)}</span>
                    </span>
                    <span className="text-text-disabled/50">{tickStats.n} samples</span>
                  </div>
                )}
              </div>

              {/* Tick table */}
              <div className="flex-1 min-h-0 overflow-auto">
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
                        <Th className="w-full">
                          {selectedVarMeta?.count > 1 ? `Value [${arrayIndex}]` : 'Value'}
                        </Th>
                      </tr>
                    </thead>
                    <tbody>
                      {tickData.ticks.map((tick) => {
                        return (
                          <tr key={tick.id} className="border-b border-border/30 hover:bg-surface-hover/50">
                            <Td mono>{tick.id}</Td>
                            <Td mono>{tick.session_time?.toFixed(3) ?? '—'}</Td>
                            <Td>{SESSION_STATE_LABELS[tick.session_state] ?? tick.session_state}</Td>
                            <Td mono>{tick.replay_frame}</Td>
                            <Td mono className="max-w-0 truncate">
                              <ValueCell value={tick.data[selectedVar]} highlightIndex={arrayIndex} />
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

/** Format a number compactly for the stats bar. */
function fmt(v) {
  if (v === null || v === undefined) return '—'
  if (!Number.isFinite(v)) return String(v)
  if (Number.isInteger(v)) return v.toLocaleString()
  const abs = Math.abs(v)
  return abs >= 10000 ? v.toFixed(0) : abs >= 100 ? v.toFixed(2) : abs >= 1 ? v.toFixed(3) : v.toFixed(5)
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

function ValueCell({ value, highlightIndex = 0 }) {
  if (value === null || value === undefined) return <span className="text-text-disabled">—</span>
  if (Array.isArray(value)) {
    const focused = value[highlightIndex]
    const focusedStr = typeof focused === 'number'
      ? fmt(focused)
      : focused === null || focused === undefined ? '—' : String(focused)
    const preview = value.slice(0, 8).map((v, i) => {
      const s = typeof v === 'number' ? fmt(v) : String(v ?? '—')
      return i === highlightIndex
        ? <strong key={i} className="text-accent">{s}</strong>
        : <span key={i} className="text-text-disabled/60">{s}</span>
    })
    const interleaved = preview.flatMap((el, i) => i < preview.length - 1 ? [el, <span key={`c${i}`} className="text-text-disabled/30">, </span>] : [el])
    return (
      <span title={JSON.stringify(value)} className="flex items-baseline gap-1.5">
        <span className="text-accent font-bold">{focusedStr}</span>
        <span className="text-xxs text-text-disabled/50">
          [{interleaved}{value.length > 8 ? <span key="ell">, …{value.length - 8} more</span> : null}]
        </span>
      </span>
    )
  }
  if (typeof value === 'boolean' || value === true || value === false) {
    return <span className={value ? 'text-green-400' : 'text-text-disabled'}>{value ? 'true' : 'false'}</span>
  }
  if (typeof value === 'number') {
    return <span>{fmt(value)}</span>
  }
  return <span>{String(value)}</span>
}

export default TelemetryExplorer
