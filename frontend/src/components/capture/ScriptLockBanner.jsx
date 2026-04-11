/**
 * ScriptLockBanner — Clear visual feedback when the script is locked / unlocked.
 *
 * When locked: shows a green "SCRIPT LOCKED" banner with lock icon, 
 * capture progress summary, and unlock button.
 * When unlocked: shows an amber "SCRIPT UNLOCKED" banner with lock button.
 */

import { useState } from 'react'
import { useScriptState, CAPTURE_STATES } from '../../context/ScriptStateContext'
import {
  Lock, Unlock, AlertTriangle, CheckCircle2, Circle, Loader2,
  Trash2, RotateCcw, ChevronDown, ChevronUp,
} from 'lucide-react'

// ── Helpers ─────────────────────────────────────────────────────────────────

function SegmentStateBadge({ state }) {
  const config = {
    [CAPTURE_STATES.CAPTURED]:    { color: 'text-green-400',  bg: 'bg-green-500/20',  icon: CheckCircle2, label: 'Captured' },
    [CAPTURE_STATES.UNCAPTURED]:  { color: 'text-zinc-400',   bg: 'bg-zinc-500/20',   icon: Circle,       label: 'Uncaptured' },
    [CAPTURE_STATES.INVALIDATED]: { color: 'text-amber-400',  bg: 'bg-amber-500/20',  icon: AlertTriangle, label: 'Invalidated' },
    [CAPTURE_STATES.CAPTURING]:   { color: 'text-blue-400',   bg: 'bg-blue-500/20',   icon: Loader2,      label: 'Capturing' },
  }
  const c = config[state] || config[CAPTURE_STATES.UNCAPTURED]
  const Icon = c.icon
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${c.bg} ${c.color}`}>
      <Icon size={12} className={state === CAPTURE_STATES.CAPTURING ? 'animate-spin' : ''} />
      {c.label}
    </span>
  )
}

function ProgressBar({ captured, total }) {
  const pct = total > 0 ? (captured / total) * 100 : 0
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-2 bg-zinc-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-green-500 rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-zinc-400 tabular-nums whitespace-nowrap">
        {captured}/{total} ({Math.round(pct)}%)
      </span>
    </div>
  )
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function ScriptLockBanner({ projectId, script, onLock, onUnlock }) {
  const {
    scriptLocked, segments, summary, trash,
    lockScript, unlockScript, compareScript,
    emptyTrash, loading,
  } = useScriptState()

  const [showUnlockConfirm, setShowUnlockConfirm] = useState(false)
  const [compareResult, setCompareResult] = useState(null)
  const [showSegments, setShowSegments] = useState(false)

  const handleLock = async () => {
    if (!script?.length) return
    try {
      await lockScript(projectId, script)
      onLock?.()
    } catch {
      // Error handled in context
    }
  }

  const handleUnlock = async () => {
    try {
      await unlockScript(projectId)
      setShowUnlockConfirm(false)
      setCompareResult(null)
      onUnlock?.()
    } catch {
      // Error handled in context
    }
  }

  const handleCompare = async () => {
    if (!script?.length) return
    try {
      const result = await compareScript(projectId, script)
      setCompareResult(result)
    } catch {
      // Error handled in context
    }
  }

  const handleEmptyTrash = async () => {
    try {
      await emptyTrash(projectId)
    } catch {
      // handled
    }
  }

  // ── Locked State ────────────────────────────────────────────────────────
  if (scriptLocked) {
    return (
      <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-4 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock size={16} className="text-green-400" />
            <span className="text-sm font-semibold text-green-400">SCRIPT LOCKED</span>
            <span className="text-xs text-zinc-500">
              Only camera/driver switches can be edited
            </span>
          </div>
          <button
            onClick={() => setShowUnlockConfirm(true)}
            disabled={loading}
            className="px-3 py-1 text-xs rounded bg-amber-500/20 text-amber-400 
                       hover:bg-amber-500/30 transition-colors"
          >
            <Unlock size={12} className="inline mr-1" />
            Unlock
          </button>
        </div>

        {/* Capture Progress */}
        <ProgressBar captured={summary.captured} total={summary.total} />

        {/* Segment details toggle */}
        <button
          onClick={() => setShowSegments(!showSegments)}
          className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          {showSegments ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {showSegments ? 'Hide' : 'Show'} segment details ({summary.total} segments)
        </button>

        {showSegments && (
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {Object.entries(segments).map(([segId, info]) => (
              <div key={segId} className="flex items-center justify-between text-xs px-2 py-1 rounded bg-zinc-800/50">
                <span className="font-mono text-zinc-400 truncate max-w-[200px]">{segId}</span>
                <div className="flex items-center gap-2">
                  <span className="text-zinc-500">{info.section}</span>
                  <SegmentStateBadge state={info.capture_state} />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Trash bin indicator */}
        {trash.length > 0 && (
          <div className="flex items-center justify-between text-xs text-amber-400 bg-amber-500/10 rounded px-3 py-2">
            <div className="flex items-center gap-1">
              <Trash2 size={12} />
              <span>{trash.length} invalidated clip{trash.length !== 1 ? 's' : ''} in trash</span>
            </div>
            <button
              onClick={handleEmptyTrash}
              className="text-red-400 hover:text-red-300 transition-colors"
            >
              Empty Trash
            </button>
          </div>
        )}

        {/* Unlock confirmation dialog */}
        {showUnlockConfirm && (
          <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm text-amber-400">
              <AlertTriangle size={14} />
              <span className="font-medium">Unlock Script?</span>
            </div>
            <p className="text-xs text-zinc-400">
              Unlocking allows script regeneration. If events change, their captures will be
              invalidated and moved to trash. Unchanged segments retain their clips.
            </p>
            {compareResult && (
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="text-center p-2 rounded bg-green-500/10 text-green-400">
                  <div className="font-bold text-lg">{compareResult.retained}</div>
                  <div>Retained</div>
                </div>
                <div className="text-center p-2 rounded bg-amber-500/10 text-amber-400">
                  <div className="font-bold text-lg">{compareResult.invalidated}</div>
                  <div>Invalidated</div>
                </div>
                <div className="text-center p-2 rounded bg-blue-500/10 text-blue-400">
                  <div className="font-bold text-lg">{compareResult.new}</div>
                  <div>New</div>
                </div>
              </div>
            )}
            <div className="flex gap-2">
              {!compareResult && (
                <button
                  onClick={handleCompare}
                  disabled={loading}
                  className="px-3 py-1 text-xs rounded bg-blue-500/20 text-blue-400 
                             hover:bg-blue-500/30 transition-colors"
                >
                  <RotateCcw size={12} className="inline mr-1" />
                  Preview Impact
                </button>
              )}
              <button
                onClick={handleUnlock}
                disabled={loading}
                className="px-3 py-1 text-xs rounded bg-amber-500/20 text-amber-400 
                           hover:bg-amber-500/30 transition-colors"
              >
                Confirm Unlock
              </button>
              <button
                onClick={() => { setShowUnlockConfirm(false); setCompareResult(null) }}
                className="px-3 py-1 text-xs rounded bg-zinc-700 text-zinc-300 
                           hover:bg-zinc-600 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Unlocked State ──────────────────────────────────────────────────────
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Unlock size={16} className="text-amber-400" />
          <span className="text-sm font-semibold text-amber-400">SCRIPT UNLOCKED</span>
          <span className="text-xs text-zinc-500">
            Lock the script to begin capture
          </span>
        </div>
        <button
          onClick={handleLock}
          disabled={loading || !script?.length}
          className="px-3 py-1 text-xs rounded bg-green-500/20 text-green-400 
                     hover:bg-green-500/30 transition-colors disabled:opacity-50"
        >
          <Lock size={12} className="inline mr-1" />
          Lock Script
        </button>
      </div>
      {!script?.length && (
        <p className="text-xs text-zinc-500">
          Generate a video script in the Editing phase first.
        </p>
      )}
    </div>
  )
}

export { SegmentStateBadge, ProgressBar }
