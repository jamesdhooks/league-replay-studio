import { useState, useEffect, useCallback, useRef } from 'react'
import { Circle, Square, RefreshCw, Trash2, Database, ChevronRight, Clock, Activity } from 'lucide-react'
import { collectionService } from '../../services/collectionService'

/**
 * Recording / status control panel — top section of CollectPage.
 */
function CollectionControl({ onStatusChange }) {
  const [status, setStatus] = useState(null)
  const [sessionName, setSessionName] = useState('')
  const [hz, setHz] = useState(4)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef(null)

  const fetchStatus = useCallback(async () => {
    try {
      const s = await collectionService.status()
      setStatus(s)
      onStatusChange?.({ ...s, hz })
    } catch {
      // backend offline — ignore
    }
  }, [onStatusChange, hz])

  // Poll status while collecting, otherwise poll lazily
  useEffect(() => {
    fetchStatus()
    pollRef.current = setInterval(fetchStatus, status?.collecting ? 1000 : 5000)
    return () => clearInterval(pollRef.current)
  }, [fetchStatus, status?.collecting])

  const handleStart = useCallback(async () => {
    setBusy(true)
    try {
      await collectionService.start(sessionName || null, hz)
      await fetchStatus()
    } catch (e) {
      console.error('Start failed', e)
    } finally {
      setBusy(false)
    }
  }, [sessionName, hz, fetchStatus])

  const handleStop = useCallback(async () => {
    setBusy(true)
    try {
      await collectionService.stop()
      await fetchStatus()
    } catch (e) {
      console.error('Stop failed', e)
    } finally {
      setBusy(false)
    }
  }, [fetchStatus])

  const isCollecting = status?.collecting === true

  return (
    <div className="bg-bg-secondary border border-border rounded-xl p-4 space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-accent" />
          <span className="text-sm font-semibold text-text-primary">Live Collection</span>
        </div>
        {/* Status badge */}
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium
          ${isCollecting
            ? 'bg-red-500/15 text-red-400 border border-red-500/25'
            : 'bg-surface border border-border text-text-disabled'
          }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${isCollecting ? 'bg-red-400 animate-pulse' : 'bg-text-disabled'}`} />
          {isCollecting ? 'Recording' : 'Idle'}
        </div>
      </div>

      {/* Config row — only visible when not recording */}
      {!isCollecting && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs text-text-tertiary">Label (optional)</label>
            <input
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder="e.g. barber_race_1"
              className="w-full px-2.5 py-1.5 bg-bg-primary border border-border rounded-lg
                         text-xs text-text-primary placeholder-text-disabled
                         focus:outline-none focus:border-accent transition-colors"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-text-tertiary">Sample rate</label>
            <select
              value={hz}
              onChange={(e) => setHz(Number(e.target.value))}
              className="w-full px-2.5 py-1.5 bg-bg-primary border border-border rounded-lg
                         text-xs text-text-primary focus:outline-none focus:border-accent transition-colors"
            >
              <option value={1}>1 Hz</option>
              <option value={2}>2 Hz</option>
              <option value={4}>4 Hz</option>
              <option value={10}>10 Hz</option>
              <option value={20}>20 Hz</option>
              <option value={60}>60 Hz</option>
            </select>
          </div>
        </div>
      )}

      {/* Live stats when recording */}
      {isCollecting && status && (
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Ticks" value={status.tick_count?.toLocaleString() ?? '0'} />
          <Stat label="Elapsed" value={formatDuration(status.elapsed_s)} />
          <Stat label="Rate" value={`${hz} Hz`} />
        </div>
      )}

      {/* Action button */}
      <button
        onClick={isCollecting ? handleStop : handleStart}
        disabled={busy}
        className={`w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium
                    transition-all duration-150 active:scale-[0.98]
                    ${isCollecting
                      ? 'bg-red-500/20 border border-red-500/30 text-red-400 hover:bg-red-500/30'
                      : 'bg-accent/20 border border-accent/30 text-accent hover:bg-accent/30'
                    }
                    ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        {isCollecting
          ? <><Square className="w-4 h-4" /> Stop Recording</>
          : <><Circle className="w-4 h-4 fill-current" /> Start Recording</>
        }
      </button>

      <p className="text-xxs text-text-disabled text-center leading-relaxed">
        Works with any iRacing session — live race or replay playback.
        Data is saved to <span className="font-mono text-text-tertiary">data/collections/</span>
      </p>
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div className="bg-bg-primary rounded-lg p-2 text-center">
      <div className="text-base font-bold text-text-primary font-mono">{value}</div>
      <div className="text-xxs text-text-tertiary mt-0.5">{label}</div>
    </div>
  )
}

function formatDuration(seconds) {
  if (!seconds) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * File browser — lists all collection files.
 */
function FileBrowser({ selectedFile, onSelect, refreshTrigger }) {
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { files: f } = await collectionService.listFiles()
      setFiles(f || [])
    } catch {
      setFiles([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load, refreshTrigger])

  const handleDelete = useCallback(async (e, filename) => {
    e.stopPropagation()
    if (!confirm(`Delete "${filename}"?`)) return
    try {
      await collectionService.deleteFile(filename)
      if (selectedFile?.filename === filename) onSelect(null)
      load()
    } catch {
      // ignore
    }
  }, [load, selectedFile, onSelect])

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
          Saved Collections
        </span>
        <button
          onClick={load}
          className="p-1 rounded-md text-text-disabled hover:text-text-secondary hover:bg-surface-hover transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {files.length === 0 && !loading && (
        <div className="text-xs text-text-disabled text-center py-6">
          No collections yet — start recording to create one.
        </div>
      )}

      {files.map((file) => {
        const isSelected = selectedFile?.filename === file.filename
        return (
          <button
            key={file.filename}
            onClick={() => onSelect(file)}
            className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all duration-100
              ${isSelected
                ? 'bg-accent/10 border-accent/30 text-text-primary'
                : 'bg-surface border-border/50 text-text-secondary hover:bg-surface-hover hover:text-text-primary'
              }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Database className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-accent' : 'text-text-disabled'}`} />
                <span className="text-xs font-medium truncate">{file.filename}</span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={(e) => handleDelete(e, file.filename)}
                  className="p-0.5 rounded text-text-disabled hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                  title="Delete"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
                <ChevronRight className={`w-3.5 h-3.5 transition-transform ${isSelected ? 'text-accent rotate-90' : 'text-text-disabled'}`} />
              </div>
            </div>
            <div className="flex items-center gap-3 mt-1 ml-5">
              {file.track_name && (
                <span className="text-xxs text-text-tertiary truncate">{file.track_name}</span>
              )}
              <span className="text-xxs text-text-disabled">{formatBytes(file.size_bytes)}</span>
              {file.tick_count_db != null && (
                <span className="text-xxs text-text-disabled">{file.tick_count_db?.toLocaleString()} ticks</span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}

export { CollectionControl, FileBrowser, formatBytes, formatDuration }
