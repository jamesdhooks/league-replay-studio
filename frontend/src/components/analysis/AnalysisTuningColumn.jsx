import { useState, useRef, useEffect, useCallback, memo } from 'react'
import {
  Loader2, CheckCircle2, XCircle, Square, RefreshCw, SlidersHorizontal,
  Trash2, ChevronRight, Activity, Sliders,
} from 'lucide-react'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { useProject } from '../../context/ProjectContext'
import TuningPanel from './TuningPanel'
import Tooltip from '../ui/Tooltip'
import CollapsibleSection from '../ui/CollapsibleSection'

/**
 * AnalysisTuningColumn â€” resizable/collapsible column for detection tuning
 * and analysis phase controls. Mirrors HighlightPanel's "Replay Tuning" pattern.
 */
export default memo(function AnalysisTuningColumn({
  // Tuning state
  tuningParams, updateTuning,
  // Analysis state
  isAnalyzing, isScanning, progress, error,
  hasTelemetry, hasEventsLocal, eventSummary, analysisStatus,
  isConnected, isRedetecting,
  // Handlers
  handleCancel, handleRescan, handleReanalyze, handleClear,
  advanceStep, activeProjectId,
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [phasesOpen, setPhasesOpen] = useState(true)
  const [tuningOpen, setTuningOpen] = useState(true)
  const [width, setWidth] = useLocalStorage('lrs:analysis:tuningWidth', 280)
  const widthRef = useRef(width)
  useEffect(() => { widthRef.current = width }, [width])

  const startResize = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = widthRef.current
    const onMove = (mv) => {
      const w = Math.max(220, Math.min(400, startW + mv.clientX - startX))
      setWidth(w)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [setWidth])

  /* ---- collapsed = full-height icon bar ---- */
  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="shrink-0 w-9 border-r border-border bg-bg-secondary flex flex-col items-center py-2 gap-3
                   hover:bg-bg-primary/50 transition-colors cursor-pointer"
        title="Expand Analysis Controls"
      >
        <SlidersHorizontal className="w-4 h-4 text-accent" />
      </button>
    )
  }

  return (
    <>
      {/* Tuning column */}
      <div
        className="shrink-0 border-r border-border bg-bg-secondary flex flex-col min-h-0 overflow-hidden"
        style={{ width }}
      >
        {/* Header â€” click to collapse */}
        <button
          onClick={() => setCollapsed(true)}
          className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 w-full text-left hover:bg-bg-primary/50 transition-colors"
        >
          <SlidersHorizontal className="w-4 h-4 text-accent" />
          <h3 className="text-xs font-semibold text-text-primary uppercase tracking-wider flex-1">
            Analysis Controls
          </h3>
          <ChevronRight className="w-3 h-3 text-text-tertiary" />
        </button>

        {/* Analysis phases */}
        <div className="p-3 border-b border-border-subtle shrink-0">
          <CollapsibleSection
            icon={Activity}
            label="Phases"
            iconColor="text-accent"
            open={phasesOpen}
            onToggle={() => setPhasesOpen(v => !v)}
            right={hasEventsLocal ? (
              <Tooltip content="Clear all analysis data" position="bottom" delay={300}>
                <button
                  onClick={(e) => { e.stopPropagation(); handleClear() }}
                  className="flex items-center justify-center w-5 h-5 rounded hover:bg-danger/10
                             text-text-disabled hover:text-danger transition-colors"
                >
                  <Trash2 size={11} />
                </button>
              </Tooltip>
            ) : null}
          >
            <div className="flex flex-col gap-2 mt-2">
              <PhaseCard
                  title="Telemetry"
                  active={isAnalyzing && isScanning}
                  done={hasTelemetry || hasEventsLocal}
                  detail={
                    hasTelemetry || hasEventsLocal
                      ? (() => {
                          const parts = []
                          if (analysisStatus?.total_ticks) parts.push(`${(analysisStatus.total_ticks / 1000).toFixed(1)}k`)
                          if (analysisStatus?.db_size_bytes >= 1_048_576) parts.push(`${(analysisStatus.db_size_bytes / 1_048_576).toFixed(1)} MB`)
                          else if (analysisStatus?.db_size_bytes > 0) parts.push(`${Math.round(analysisStatus.db_size_bytes / 1024)} KB`)
                          return parts.join(' Â· ') || null
                        })()
                      : null
                  }
                  progressMsg={isScanning ? (progress?.message || null) : null}
                  progressPct={isScanning ? Math.min(100, (progress?.percent || 0) / 50 * 100) : null}
                  primaryLabel={hasTelemetry || hasEventsLocal ? 'Re-collect' : 'Collect'}
                  primaryIcon={isAnalyzing && isScanning ? null : <RefreshCw size={11} />}
                  onPrimary={isAnalyzing && isScanning ? handleCancel : handleRescan}
                  primaryDanger={isAnalyzing && isScanning}
                  primaryDisabled={!isAnalyzing && !isConnected}
                  primaryTooltip={!isConnected && !(isAnalyzing && isScanning) ? 'iRacing must be running' : null}
                />
                <PhaseCard
                  title="Events"
                  active={isAnalyzing && !isScanning}
                  done={hasEventsLocal}
                  detail={
                    hasEventsLocal && eventSummary?.total_events > 0
                      ? `${eventSummary.total_events} events`
                      : null
                  }
                  progressMsg={!isScanning && isAnalyzing ? (progress?.message || null) : null}
                  progressPct={!isScanning && isAnalyzing ? Math.min(100, Math.max(0, ((progress?.percent || 55) - 55) / 40 * 100)) : null}
                  primaryLabel={hasEventsLocal ? 'Re-analyze' : 'Analyze'}
                  primaryIcon={isAnalyzing && !isScanning ? null : isRedetecting ? <Loader2 size={11} className="animate-spin" /> : <SlidersHorizontal size={11} />}
                  onPrimary={isAnalyzing && !isScanning ? handleCancel : handleReanalyze}
                  primaryDanger={isAnalyzing && !isScanning}
                  primaryDisabled={isRedetecting || (!isAnalyzing && !hasTelemetry && !hasEventsLocal)}
                  primaryTooltip={!hasTelemetry && !hasEventsLocal && !isAnalyzing ? 'Collect telemetry first' : null}
                />
              </div>
              {error && (
                <div className="flex items-start gap-1.5 mt-2 pt-2 border-t border-danger/20">
                  <XCircle size={10} className="text-danger shrink-0 mt-0.5" />
                  <span className="text-xxs text-danger leading-tight">{error}</span>
                </div>
              )}
              {hasEventsLocal && (
                <div className="mt-2 pt-2 border-t border-border-subtle">
                  <button
                    onClick={() => advanceStep(activeProjectId)}
                    className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xxs font-semibold
                               text-white bg-gradient-to-r from-gradient-from to-gradient-to
                               rounded-lg hover:from-gradient-via hover:to-gradient-from
                               transition-all duration-200 shadow-glow-sm justify-center"
                  >
                    Go To Editing
                    <ChevronRight size={11} />
                  </button>
                </div>
              )}
          </CollapsibleSection>
        </div>

        {/* Detection tuning */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <CollapsibleSection
            icon={Sliders}
            label="Detection Tuning"
            iconColor="text-accent"
            open={tuningOpen}
            onToggle={() => setTuningOpen(v => !v)}
            className="mb-2"
          >
            <div className="mt-2">
              <TuningPanel params={tuningParams} onChange={updateTuning} />
            </div>
          </CollapsibleSection>
        </div>
      </div>

      {/* Resize handle */}
      <div
        className="shrink-0 cursor-col-resize group/divider relative"
        style={{ width: 1, marginLeft: -1 }}
        onMouseDown={startResize}
      >
        <div className="absolute inset-y-0 -left-2 -right-2 z-20" />
        <div className="absolute inset-y-0 left-0 w-px bg-border transition-colors group-hover/divider:bg-accent group-active/divider:bg-accent" />
      </div>
    </>
  )
})


/**
 * PhaseCard — combined status + action for a single analysis phase.
 */
function PhaseCard({
  title, active, done,
  detail, progressMsg, progressPct,
  primaryLabel, primaryIcon, onPrimary,
  primaryDanger, primaryDisabled, primaryTooltip,
}) {
  const btn = (
    <button
      onClick={onPrimary}
      disabled={primaryDisabled}
      className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md
                  transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed
                  ${primaryDanger
                    ? 'text-danger bg-danger/10 hover:bg-danger/20'
                    : 'text-text-secondary bg-bg-hover border border-border-subtle hover:text-text-primary hover:border-border'}`}
    >
      {primaryDanger
        ? <Square size={10} />
        : primaryIcon}
      {primaryDanger ? 'Stop' : primaryLabel}
    </button>
  )

  return (
    <div className={`flex flex-col gap-2 px-3 py-3 rounded-lg border transition-colors
      ${active
        ? 'bg-accent/5 border-accent/30 shadow-sm'
        : done
          ? 'bg-success/5 border-success/30'
          : 'bg-surface border-border-subtle'}`}
    >
      {/* Title row */}
      <div className="flex items-center gap-2.5">
        <div className="shrink-0">
          {active
            ? <Loader2 size={14} className="text-accent animate-spin" />
            : done
              ? <CheckCircle2 size={14} className="text-success" />
              : <span className="block w-3 h-3 rounded-full border-2 border-border" />}
        </div>
        <span className={`text-xs font-semibold flex-1 ${active ? 'text-accent' : done ? 'text-success' : 'text-text-primary'}`}>
          {title}
        </span>
        {primaryTooltip
          ? <Tooltip content={primaryTooltip} position="bottom" delay={300}>{btn}</Tooltip>
          : btn}
      </div>

      {/* Detail / status info */}
      {detail && !active && (
        <span className="text-xxs text-text-tertiary leading-relaxed pl-[22px]">{detail}</span>
      )}

      {/* Progress message */}
      {active && progressMsg && (
        <span className="text-xxs text-text-secondary leading-relaxed pl-[22px] font-medium">{progressMsg}</span>
      )}

      {/* Progress bar */}
      {active && progressPct !== null && progressPct !== undefined && (
        <div className="pl-[22px]">
          <div className="h-1 bg-surface rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
