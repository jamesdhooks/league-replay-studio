/**
 * TrashBin — UI for viewing and managing invalidated clips.
 *
 * Shows clips that were invalidated due to script changes, driver/camera edits,
 * or manual recapture requests.  Supports restore and permanent delete.
 */

import { useEffect, useState } from 'react'
import { useScriptState } from '../../context/ScriptStateContext'
import {
  Trash2, RotateCcw, AlertTriangle, Clock, Film, ChevronDown, ChevronUp, X,
} from 'lucide-react'

function formatDate(epoch) {
  if (!epoch) return '—'
  return new Date(epoch * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

const REASON_LABELS = {
  script_changed:     'Script changed',
  segment_removed:    'Segment removed',
  recapture_requested:'Recapture requested',
  camera_changed:     'Camera changed',
  driver_changed:     'Driver changed',
  manual:             'Manually invalidated',
}

export default function TrashBin({ projectId }) {
  const { trash, fetchTrash, emptyTrash, restoreFromTrash, loading } = useScriptState()
  const [expanded, setExpanded] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  useEffect(() => {
    if (projectId) fetchTrash(projectId)
  }, [projectId, fetchTrash])

  if (!trash?.length) return null

  const handleEmpty = async () => {
    try {
      await emptyTrash(projectId)
      setShowConfirm(false)
    } catch {
      // handled in context
    }
  }

  const handleRestore = async (segId) => {
    try {
      await restoreFromTrash(projectId, segId)
    } catch {
      // handled
    }
  }

  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm hover:bg-amber-500/5 transition-colors"
      >
        <div className="flex items-center gap-2 text-amber-400">
          <Trash2 size={14} />
          <span className="font-medium">Trash Bin</span>
          <span className="text-xs bg-amber-500/20 px-1.5 py-0.5 rounded">
            {trash.length}
          </span>
        </div>
        {expanded ? <ChevronUp size={14} className="text-zinc-500" /> : <ChevronDown size={14} className="text-zinc-500" />}
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          {/* Actions */}
          <div className="flex justify-end gap-2">
            {!showConfirm ? (
              <button
                onClick={() => setShowConfirm(true)}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded 
                           bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
              >
                <Trash2 size={11} />
                Empty Trash
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-400">Permanently delete all?</span>
                <button
                  onClick={handleEmpty}
                  disabled={loading}
                  className="px-2 py-1 text-xs rounded bg-red-500/30 text-red-400 
                             hover:bg-red-500/40 transition-colors"
                >
                  Yes, Delete
                </button>
                <button
                  onClick={() => setShowConfirm(false)}
                  className="px-2 py-1 text-xs rounded bg-zinc-700 text-zinc-300"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {/* Clip list */}
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {trash.map((entry, i) => (
              <div key={entry.segment_id + i} className="flex items-center justify-between text-xs bg-zinc-800/50 rounded px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Film size={12} className="text-zinc-500 shrink-0" />
                  <div className="min-w-0">
                    <div className="font-mono text-zinc-300 truncate">{entry.segment_id}</div>
                    <div className="flex items-center gap-2 text-zinc-500">
                      <span>{REASON_LABELS[entry.reason] || entry.reason}</span>
                      <span>·</span>
                      <span>{formatDate(entry.invalidated_at)}</span>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleRestore(entry.segment_id)}
                  disabled={loading}
                  className="flex items-center gap-1 px-2 py-1 rounded 
                             bg-green-500/20 text-green-400 hover:bg-green-500/30 
                             transition-colors shrink-0 ml-2"
                  title="Restore clip"
                >
                  <RotateCcw size={11} />
                  Restore
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
