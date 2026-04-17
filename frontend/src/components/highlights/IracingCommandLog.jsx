import { useEffect, useRef, useState } from 'react'
import { Terminal, Trash2 } from 'lucide-react'
import SectionCollapseHeader from '../ui/SectionCollapseHeader'
import { wsClient } from '../../services/websocket'
import { apiDelete, apiGet } from '../../services/api'

const MAX_ENTRIES = 500

// Human-readable label + colour for each command type.
const CMD_META = {
  'play':      { label: 'Play',      color: 'text-green-400' },
  'pause':     { label: 'Pause',     color: 'text-yellow-400' },
  'speed':     { label: 'Speed',     color: 'text-blue-400' },
  'seek':      { label: 'Seek',      color: 'text-purple-400' },
  'seek-time': { label: 'Seek',      color: 'text-purple-400' },
  'camera':    { label: 'Camera',    color: 'text-orange-400' },
}

function formatParams(command, params) {
  if (!params || Object.keys(params).length === 0) return ''
  switch (command) {
    case 'play':
      return '1×'
    case 'pause':
      return ''
    case 'speed':
      return `${params.speed}×`
    case 'seek':
      return `frame ${params.frame}`
    case 'seek-time': {
      const s = params.session_time_ms != null ? (params.session_time_ms / 1000) : null
      if (s == null) return ''
      const m = Math.floor(s / 60)
      const sec = Math.floor(s % 60)
      return `${m}:${String(sec).padStart(2, '0')}`
    }
    case 'camera': {
      const g = params.group_num != null ? `#${params.group_num}` : ''
      const t = params.target || ''
      return [g, t].filter(Boolean).join(' → ')
    }
    default:
      return JSON.stringify(params)
  }
}

function fmtTime(ts) {
  const d = new Date(ts * 1000)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

export default function IracingCommandLog() {
  const [entries, setEntries] = useState([])
  const [collapsed, setCollapsed] = useState(false)
  const bottomRef = useRef(null)
  const containerRef = useRef(null)
  const seenSeqRef = useRef(new Set())

  const mergeEntries = (incoming) => {
    if (!Array.isArray(incoming) || incoming.length === 0) return
    setEntries(prev => {
      const next = [...prev]
      for (const item of incoming) {
        if (!item || item.seq == null) continue
        if (seenSeqRef.current.has(item.seq)) continue
        seenSeqRef.current.add(item.seq)
        next.push(item)
      }
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
    })
  }

  // Subscribe to live command events over WebSocket.
  useEffect(() => {
    const unsub = wsClient.subscribe('iracing:command', (data) => {
      mergeEntries([data])
    })
    return unsub
  }, [])

  // Fallback/bootstrapping path: fetch command history periodically so the
  // feed still populates even if websocket delivery drops.
  useEffect(() => {
    let cancelled = false

    const pull = async () => {
      try {
        const result = await apiGet('/iracing/replay/commands?limit=500')
        if (cancelled) return
        mergeEntries(result?.entries || [])
      } catch {
        // Non-fatal: websocket stream may still be active.
      }
    }

    pull()
    const interval = setInterval(pull, 1000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  // Auto-scroll to bottom when new entries arrive (only if already near bottom).
  useEffect(() => {
    if (collapsed) return
    const el = containerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [entries, collapsed])

  const lastEntry = entries[entries.length - 1]
  const meta = lastEntry ? (CMD_META[lastEntry.command] || { label: lastEntry.command, color: 'text-text-secondary' }) : null

  return (
    <div className="absolute bottom-2 right-2 z-30 flex flex-col items-end pointer-events-none">
      <div
        className="pointer-events-auto w-72 rounded-xl border border-border bg-bg-primary/90 backdrop-blur-sm shadow-float overflow-hidden"
        style={{ maxHeight: collapsed ? 'none' : '260px', display: 'flex', flexDirection: 'column' }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-1.5 border-b border-border bg-bg-secondary shrink-0"
        >
          <SectionCollapseHeader
            open={!collapsed}
            onToggle={() => setCollapsed(c => !c)}
            icon={Terminal}
            title="iRacing Commands"
            right={collapsed && lastEntry && meta ? (
              <span className={`text-xxs font-mono ${meta.color} truncate max-w-[120px]`}>
                {meta.label}{formatParams(lastEntry.command, lastEntry.params) ? ` ${formatParams(lastEntry.command, lastEntry.params)}` : ''}
              </span>
            ) : (
              <span className="text-xxs font-mono text-text-disabled tabular-nums">
                {entries.length}
              </span>
            )}
            className="flex-1"
            buttonClassName="px-3 py-2"
          />

          {/* Clear button (only when expanded) */}
          {!collapsed && entries.length > 0 && (
            <button
              onClick={async () => {
                setEntries([])
                seenSeqRef.current.clear()
                try {
                  await apiDelete('/iracing/replay/commands')
                } catch {
                  // Keep local clear behavior even if backend clear fails.
                }
              }}
              className="p-0.5 rounded hover:bg-bg-hover text-text-disabled hover:text-text-secondary transition-colors"
              title="Clear log"
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>

        {/* Log body */}
        {!collapsed && (
          <div
            ref={containerRef}
            className="flex-1 overflow-y-auto min-h-0 px-2 py-1.5 space-y-0.5"
          >
            {entries.length === 0 ? (
              <p className="text-xxs text-text-disabled text-center py-3">
                No commands sent yet
              </p>
            ) : (
              entries.map((e) => {
                const m = CMD_META[e.command] || { label: e.command, color: 'text-text-secondary' }
                const paramStr = formatParams(e.command, e.params)
                return (
                  <div key={e.seq} className="flex items-baseline gap-2 font-mono text-xxs leading-5">
                    <span className="text-text-disabled tabular-nums shrink-0 w-[52px]">{fmtTime(e.ts)}</span>
                    <span className={`shrink-0 font-semibold w-14 ${m.color}`}>{m.label}</span>
                    {paramStr && (
                      <span className="text-text-secondary truncate">{paramStr}</span>
                    )}
                  </div>
                )
              })
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  )
}
