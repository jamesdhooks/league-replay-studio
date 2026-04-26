/**
 * ScriptLockBanner — Clear visual feedback when the script is locked / unlocked.
 *
 * When locked: shows a green "SCRIPT LOCKED" banner with lock icon, 
 * capture progress summary, and unlock button.
 * When unlocked: shows an amber "SCRIPT UNLOCKED" banner with lock button.
 */

import { useMemo, useState } from 'react'
import { useScriptState, CAPTURE_STATES } from '../../context/ScriptStateContext'
import {
  Lock, Unlock, AlertTriangle, CheckCircle2, Circle, Loader2,
  Trash2, RotateCcw, Clock, Camera, Repeat, ArrowRight,
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

const SECTION_META = {
  intro: { label: 'Intro', pill: 'bg-purple-500/20 text-purple-300 border-purple-500/30', fill: 'bg-purple-500/18' },
  qualifying_results: { label: 'Qualifying', pill: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30', fill: 'bg-cyan-500/18' },
  race: { label: 'Race', pill: 'bg-green-500/20 text-green-300 border-green-500/30', fill: 'bg-green-500/18' },
  race_results: { label: 'Results', pill: 'bg-amber-500/20 text-amber-300 border-amber-500/30', fill: 'bg-amber-500/18' },
}

function SegmentLogFeed({ entries, isExecuting, isCurrent, isCaptured }) {
  if (!entries?.length) {
    if (!isExecuting) {
      return <div className="text-[10px] text-text-disabled">No capture activity</div>
    }

    if (isCurrent) {
      return <div className="text-[10px] text-text-disabled">Capture activity will appear here</div>
    }

    if (isCaptured) {
      return <div className="text-[10px] text-text-disabled">Capture complete</div>
    }

    return <div className="text-[10px] text-text-disabled">Awaiting segment turn</div>
  }

  return (
    <div className="space-y-1">
      {entries.slice(-4).reverse().map((entry, index) => (
        <div key={`${entry.timestamp || index}-${entry.action || 'entry'}`} className="text-[10px] leading-4 text-text-secondary">
          <span className="text-text-disabled mr-1">{entry.action || 'info'}:</span>
          <span>{entry.detail}</span>
        </div>
      ))}
    </div>
  )
}

function SegmentCard({ segment, currentSegmentId, captureLog, isExecuting }) {
  const segId = segment.segment_id || segment.id
  const state = segment.capture_state
  const logs = useMemo(
    () => (captureLog || []).filter((entry) => entry.segment_id === segId),
    [captureLog, segId],
  )
  const isCurrent = isExecuting && (segId === currentSegmentId || state === CAPTURE_STATES.CAPTURING)
  const isCaptured = state === CAPTURE_STATES.CAPTURED
  const isInvalidated = state === CAPTURE_STATES.INVALIDATED
  const meta = SECTION_META[segment.section] || SECTION_META.race

  const progressPct = useMemo(() => {
    if (isCaptured) return 100
    if (isInvalidated) return 100
    let pct = isCurrent ? 4 : 0

    const phases = [
      {
        match: (entry) => entry.action === 'seek' && String(entry.detail || '').includes('Priming replay'),
        pct: 8,
      },
      {
        match: (entry) => entry.action === 'seek' && String(entry.detail || '').includes('validated'),
        pct: 22,
      },
      {
        match: (entry) => entry.action === 'seek' && String(entry.detail || '').includes('Pausing replay after seek'),
        pct: 28,
      },
      {
        match: (entry) => entry.action === 'camera',
        pct: 40,
      },
      {
        match: (entry) => entry.action === 'record_start',
        pct: 56,
      },
      {
        match: (entry) => entry.action === 'info' && String(entry.detail || '').includes('Replay resumed at 1×'),
        pct: 62,
      },
      {
        match: (entry) => entry.action === 'info' && String(entry.detail || '').includes('duration'),
        pct: 72,
      },
      {
        match: (entry) => entry.action === 'camera_schedule',
        pct: 80,
      },
      {
        match: (entry) => entry.action === 'info' && String(entry.detail || '').includes('post-padding'),
        pct: 86,
      },
      {
        match: (entry) => entry.action === 'record_stop',
        pct: 92,
      },
      {
        match: (entry) => entry.action === 'validate' && String(entry.detail || '').toLowerCase().includes('verified'),
        pct: 100,
      },
      {
        match: (entry) => entry.action === 'validate',
        pct: 96,
      },
    ]

    for (const entry of logs) {
      for (const phase of phases) {
        if (phase.match(entry)) {
          pct = Math.max(pct, phase.pct)
          break
        }
      }
      if (entry.success === false) pct = Math.max(pct, 100)
    }
    return pct
  }, [isCaptured, isCurrent, isInvalidated, logs])

  const borderClass = isCaptured
    ? 'border-border bg-bg-secondary/50'
    : isInvalidated
      ? 'border-warning/30 bg-warning/5'
      : isCurrent
        ? 'border-accent/40 bg-accent/5 ring-1 ring-accent/20'
        : 'border-border bg-bg-secondary/40'

  const metaTextClass = isCaptured ? 'text-text-secondary' : 'text-text-disabled'
  const fillClass = isCaptured ? 'bg-success/5' : isInvalidated ? 'bg-warning/15' : meta.fill

  return (
    <div className={`relative overflow-hidden rounded-lg border ${borderClass}`}>
      <div className={`absolute inset-y-0 left-0 ${fillClass}`} style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }} />
      <div className="relative grid grid-cols-[minmax(0,1fr)_150px] gap-3 px-3 py-2.5 min-w-0">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-2 min-w-0">
            {isCurrent ? (
              <Loader2 className="w-3.5 h-3.5 text-accent animate-spin shrink-0" />
            ) : isCaptured ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
            ) : isInvalidated ? (
              <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
            ) : (
              <Circle className="w-3.5 h-3.5 text-text-disabled shrink-0" />
            )}
            <span className="text-xs font-medium text-text-primary truncate">{segId}</span>
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border shrink-0 ${meta.pill}`}>{meta.label}</span>
          </div>
          <div className={`flex items-center gap-2 flex-wrap text-[10px] ${metaTextClass}`}>
            <span>{segment.event_type || segment.type || 'segment'}</span>
            <span>·</span>
            <span>{Math.round(segment.duration || 0)}s</span>
            {segment.strategy === 'continue' ? (
              <span className="inline-flex items-center gap-0.5 text-accent/70"><ArrowRight className="w-2.5 h-2.5" /> cont.</span>
            ) : (
              <span className="inline-flex items-center gap-0.5"><Camera className="w-2.5 h-2.5" /> new rec.</span>
            )}
            {segment.has_camera_schedule && (
              <span className="inline-flex items-center gap-0.5"><Repeat className="w-2.5 h-2.5" /> sched.</span>
            )}
          </div>
        </div>
        <div className="min-w-0 border-l border-border/60 pl-3">
          <SegmentLogFeed entries={logs} isExecuting={isExecuting} isCurrent={isCurrent} isCaptured={isCaptured} />
        </div>
      </div>
    </div>
  )
}

export default function ScriptLockBanner({ projectId, script, onLock, onUnlock, strategies = [], currentSegmentId = null, captureLog = [], isExecuting = false }) {
  const {
    scriptLocked, segments, summary, trash,
    lockScript, unlockScript, compareScript,
    emptyTrash, loading,
  } = useScriptState()

  const [showUnlockConfirm, setShowUnlockConfirm] = useState(false)
  const [compareResult, setCompareResult] = useState(null)
  const activeCurrentSegmentId = isExecuting ? currentSegmentId : null

  const segmentCards = useMemo(() => {
    if (Array.isArray(strategies) && strategies.length > 0) {
      return strategies
        .filter((strategy) => {
          const type = String(strategy?.type || '').toLowerCase()
          return type !== 'transition' && type !== 'bridge'
        })
        .map((strategy) => ({
        ...strategy,
        id: strategy.segment_id,
        capture_state: segments?.[strategy.segment_id]?.capture_state ?? CAPTURE_STATES.UNCAPTURED,
        }))
    }

    return Object.entries(segments || {}).map(([segId, info]) => ({
      id: segId,
      segment_id: segId,
      section: info.section,
      event_type: info.event_type,
      type: info.segment_type,
      duration: info.duration_seconds,
      capture_state: info.capture_state,
    }))
  }, [segments, strategies])
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

  const handleToggleLockState = () => {
    if (loading) return
    if (scriptLocked) {
      if (isExecuting) return
      setShowUnlockConfirm(true)
      return
    }
    handleLock()
  }

  // ── Locked State ────────────────────────────────────────────────────────
  if (scriptLocked) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-text-primary uppercase tracking-wider">Script</span>
            <span className="text-xxs text-text-tertiary">Only camera and driver switches can be edited</span>
          </div>
          <button
            type="button"
            onClick={handleToggleLockState}
            disabled={loading || isExecuting}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xxs font-medium bg-success/10 text-success border border-success/30 hover:bg-success/15 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            title={isExecuting ? 'Cannot unlock while capture is running' : 'Toggle script lock'}
          >
            <Lock className="w-3 h-3" /> Locked
          </button>
        </div>

        <ProgressBar captured={summary.captured} total={summary.total} />

        <div className="space-y-2 mt-2 mb-2">
          {segmentCards.map((segment) => (
            <SegmentCard
              key={segment.segment_id || segment.id}
              segment={segment}
              currentSegmentId={activeCurrentSegmentId}
              captureLog={captureLog}
              isExecuting={isExecuting}
            />
          ))}
        </div>

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
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-text-primary uppercase tracking-wider">Script</span>
          <span className="text-xxs text-text-tertiary">Lock the script to begin capture</span>
        </div>
        <button
          type="button"
          onClick={handleToggleLockState}
          disabled={loading || !script?.length}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xxs font-medium bg-warning/10 text-warning border border-warning/30 hover:bg-warning/15 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={script?.length ? 'Toggle script lock' : 'Generate a script first'}
        >
          <Unlock className="w-3 h-3" /> Unlocked
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
