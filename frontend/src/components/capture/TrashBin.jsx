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
    <div className="rounded-lg border border-warning/20 bg-warning/5">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 text-xs hover:bg-warning/5 transition-colors"
      >
        <div className="flex items-center gap-2 text-warning">
          <Trash2 className="w-3.5 h-3.5" />
          <span className="font-medium">Trash Bin</span>
          <span className="text-xxs bg-warning/10 px-1.5 py-0.5 rounded border border-warning/20">
            {trash.length}
          </span>
        </div>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-text-tertiary" /> : <ChevronDown className="w-3.5 h-3.5 text-text-tertiary" />}
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          {/* Actions */}
          <div className="flex justify-end gap-2">
            {!showConfirm ? (
              <button
                onClick={() => setShowConfirm(true)}
                className="flex items-center gap-1 px-2 py-1 text-xxs font-medium rounded
                           bg-danger/10 text-danger border border-danger/20 hover:bg-danger/20 transition-colors"
              >
                <Trash2 className="w-3 h-3" />
                Empty Trash
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xxs text-danger">Permanently delete all?</span>
                <button
                  onClick={handleEmpty}
                  disabled={loading}
                  className="px-2 py-1 text-xxs font-medium rounded bg-danger/20 text-danger border border-danger/30
                             hover:bg-danger/30 transition-colors"
                >
                  Yes, Delete
                </button>
                <button
                  onClick={() => setShowConfirm(false)}
                  className="px-2 py-1 text-xxs font-medium rounded bg-bg-secondary text-text-secondary border border-border transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {/* Clip list */}
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {trash.map((entry, i) => (
              <div key={entry.segment_id + i} className="flex items-center justify-between text-xxs bg-bg-secondary/50 rounded px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Film className="w-3 h-3 text-text-disabled shrink-0" />
                  <div className="min-w-0">
                    <div className="font-mono text-text-secondary truncate">{entry.segment_id}</div>
                    <div className="flex items-center gap-2 text-text-disabled">
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
                             bg-success/10 text-success border border-success/20 hover:bg-success/20
                             transition-colors shrink-0 ml-2 text-xxs font-medium"
                  title="Restore clip"
                >
                  <RotateCcw className="w-3 h-3" />
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
