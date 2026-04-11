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
    [CAPTURE_STATES.CAPTURED]:    { color: 'text-success',  bg: 'bg-success/10',  icon: CheckCircle2, label: 'Captured' },
    [CAPTURE_STATES.UNCAPTURED]:  { color: 'text-text-tertiary', bg: 'bg-bg-secondary', icon: Circle, label: 'Uncaptured' },
    [CAPTURE_STATES.INVALIDATED]: { color: 'text-warning',  bg: 'bg-warning/10',  icon: AlertTriangle, label: 'Invalidated' },
    [CAPTURE_STATES.CAPTURING]:   { color: 'text-accent',   bg: 'bg-accent/10',   icon: Loader2,      label: 'Capturing' },
  }
  const c = config[state] || config[CAPTURE_STATES.UNCAPTURED]
  const Icon = c.icon
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xxs font-medium ${c.bg} ${c.color}`}>
      <Icon className={`w-3 h-3 ${state === CAPTURE_STATES.CAPTURING ? 'animate-spin' : ''}`} />
      {c.label}
    </span>
  )
}

function ProgressBar({ captured, total }) {
  const pct = total > 0 ? (captured / total) * 100 : 0
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-2 bg-bg-primary rounded-full overflow-hidden border border-border">
        <div
          className="h-full bg-success rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xxs text-text-tertiary tabular-nums whitespace-nowrap">
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
      <div className="rounded-lg border border-success/30 bg-success/5 p-4 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-success" />
            <span className="text-xs font-semibold text-success uppercase tracking-wider">Script Locked</span>
            <span className="text-xxs text-text-tertiary">
              Only camera/driver switches can be edited
            </span>
          </div>
          <button
            onClick={() => setShowUnlockConfirm(true)}
            disabled={loading}
            className="px-3 py-1 text-xxs font-medium rounded bg-warning/10 text-warning border border-warning/30
                       hover:bg-warning/20 transition-colors"
          >
            <Unlock className="w-3 h-3 inline mr-1" />
            Unlock
          </button>
        </div>

        {/* Capture Progress */}
        <ProgressBar captured={summary.captured} total={summary.total} />

        {/* Segment details toggle */}
        <button
          onClick={() => setShowSegments(!showSegments)}
          className="flex items-center gap-1 text-xxs text-text-tertiary hover:text-text-secondary transition-colors"
        >
          {showSegments ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {showSegments ? 'Hide' : 'Show'} segment details ({summary.total} segments)
        </button>

        {showSegments && (
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {Object.entries(segments).map(([segId, info]) => (
              <div key={segId} className="flex items-center justify-between text-xxs px-2 py-1 rounded bg-bg-secondary/50">
                <span className="font-mono text-text-tertiary truncate max-w-[200px]">{segId}</span>
                <div className="flex items-center gap-2">
                  <span className="text-text-disabled">{info.section}</span>
                  <SegmentStateBadge state={info.capture_state} />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Trash bin indicator */}
        {trash.length > 0 && (
          <div className="flex items-center justify-between text-xxs text-warning bg-warning/5 border border-warning/20 rounded px-3 py-2">
            <div className="flex items-center gap-1">
              <Trash2 className="w-3 h-3" />
              <span>{trash.length} invalidated clip{trash.length !== 1 ? 's' : ''} in trash</span>
            </div>
            <button
              onClick={handleEmptyTrash}
              className="text-danger hover:text-danger/80 transition-colors font-medium"
            >
              Empty Trash
            </button>
          </div>
        )}

        {/* Unlock confirmation dialog */}
        {showUnlockConfirm && (
          <div className="rounded border border-warning/30 bg-warning/5 p-3 space-y-2">
            <div className="flex items-center gap-2 text-xs text-warning">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span className="font-medium">Unlock Script?</span>
            </div>
            <p className="text-xxs text-text-tertiary">
              Unlocking allows script regeneration. If events change, their captures will be
              invalidated and moved to trash. Unchanged segments retain their clips.
            </p>
            {compareResult && (
              <div className="grid grid-cols-3 gap-2 text-xxs">
                <div className="text-center p-2 rounded bg-success/5 border border-success/20 text-success">
                  <div className="font-bold text-lg">{compareResult.retained}</div>
                  <div>Retained</div>
                </div>
                <div className="text-center p-2 rounded bg-warning/5 border border-warning/20 text-warning">
                  <div className="font-bold text-lg">{compareResult.invalidated}</div>
                  <div>Invalidated</div>
                </div>
                <div className="text-center p-2 rounded bg-accent/5 border border-accent/20 text-accent">
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
                  className="px-3 py-1 text-xxs font-medium rounded bg-accent/10 text-accent border border-accent/30
                             hover:bg-accent/20 transition-colors"
                >
                  <RotateCcw className="w-3 h-3 inline mr-1" />
                  Preview Impact
                </button>
              )}
              <button
                onClick={handleUnlock}
                disabled={loading}
                className="px-3 py-1 text-xxs font-medium rounded bg-warning/10 text-warning border border-warning/30
                           hover:bg-warning/20 transition-colors"
              >
                Confirm Unlock
              </button>
              <button
                onClick={() => { setShowUnlockConfirm(false); setCompareResult(null) }}
                className="px-3 py-1 text-xxs font-medium rounded bg-bg-secondary text-text-secondary border border-border
                           hover:bg-bg-hover transition-colors"
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
    <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Unlock className="w-4 h-4 text-warning" />
          <span className="text-xs font-semibold text-warning uppercase tracking-wider">Script Unlocked</span>
          <span className="text-xxs text-text-tertiary">
            Lock the script to begin capture
          </span>
        </div>
        <button
          onClick={handleLock}
          disabled={loading || !script?.length}
          className="px-3 py-1 text-xxs font-medium rounded bg-success/10 text-success border border-success/30
                     hover:bg-success/20 transition-colors disabled:opacity-50"
        >
          <Lock className="w-3 h-3 inline mr-1" />
          Lock Script
        </button>
      </div>
      {!script?.length && (
        <p className="text-xxs text-text-tertiary">
          Generate a video script in the Editing phase first.
        </p>
      )}
    </div>
  )
}

export { SegmentStateBadge, ProgressBar }
