import { useRef, memo } from 'react'
import {
  Loader2, CheckCircle2, XCircle, Square, RefreshCw, SlidersHorizontal,
  Trash2, ChevronRight, Eye, Users,
} from 'lucide-react'
import Tooltip from '../ui/Tooltip'

/**
 * AnalysisRightPanel — right column showing analysis phases, cameras, and drivers.
 * Includes a drag-resize divider on the left edge.
 */
export default memo(function AnalysisRightPanel({
  // Analysis state
  isAnalyzing, isScanning, progress, error,
  hasTelemetry, hasEventsLocal, eventSummary, analysisStatus,
  isConnected, isRedetecting,
  // Replay state
  replayState,
  // Data
  cameraGroups, drivers,
  // Layout
  rightPanelWidth, setRightPanelWidth, isPortrait,
  // Handlers
  handleCancel, handleRescan, handleReanalyze, handleClear,
  handleSwitchCamera, handleSwitchDriver,
  advanceStep, activeProjectId,
}) {
  const rightDragRef = useRef(null)

  if (!(isAnalyzing || hasEventsLocal || isConnected)) return null

  // Portrait: simplified stacked panel
  if (isPortrait) {
    return (
      <div className="flex flex-col gap-2 flex-1 overflow-y-auto p-2">
        <div className="rounded-xl border border-border bg-bg-secondary shadow-sm p-3 shrink-0">
          <span className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">Analysis</span>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Drag-resize divider */}
      <div
        ref={rightDragRef}
        className="shrink-0 cursor-col-resize group/divider relative"
        style={{ width: 1, marginLeft: -1 }}
        onMouseDown={(e) => {
          e.preventDefault()
          const startX = e.clientX
          const startW = rightPanelWidth
          const onMove = (mv) => {
            const delta = startX - mv.clientX
            setRightPanelWidth(Math.max(200, Math.min(600, startW + delta)))
          }
          const onUp = () => {
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('mouseup', onUp)
          }
          document.addEventListener('mousemove', onMove)
          document.addEventListener('mouseup', onUp)
        }}
      >
        <div className="absolute inset-y-0 -left-2 -right-2 z-20" />
        <div className="absolute inset-y-0 left-0 w-px bg-border transition-colors group-hover/divider:bg-accent group-active/divider:bg-accent" />
      </div>

      {/* Right panel */}
      <div className="flex flex-col gap-0 shrink-0 overflow-y-auto bg-bg-secondary"
           style={{ width: rightPanelWidth }}>

        {/* Analysis section */}
        <div className="p-3 border-b border-border shrink-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">Analysis</span>
            <div className="flex items-center gap-1">
              {hasEventsLocal && (
                <Tooltip content="Clear all analysis data" position="bottom" delay={300}>
                  <button
                    onClick={handleClear}
                    className="flex items-center justify-center w-5 h-5 rounded hover:bg-danger/10
                               text-text-disabled hover:text-danger transition-colors"
                  >
                    <Trash2 size={11} />
                  </button>
                </Tooltip>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2">
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
                      return parts.join(' · ') || null
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
        </div>

        {/* Cameras section */}
        {isConnected && (
          <div className="border-b border-border overflow-hidden flex flex-col"
               style={{ maxHeight: '40%' }}>
            <div className="shrink-0 px-3 py-2 border-b border-border flex items-center gap-1.5 min-w-0">
              <Eye size={11} className="text-text-secondary shrink-0" />
              <span className="text-xxs font-medium text-text-primary shrink-0">Cameras</span>
              {replayState?.cam_group_num != null && cameraGroups.find(c => c.group_num === replayState.cam_group_num) && (
                <span className="text-xxs text-accent truncate ml-auto">
                  {cameraGroups.find(c => c.group_num === replayState.cam_group_num)?.group_name}
                </span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              {cameraGroups.map(cam => (
                <button key={cam.group_num}
                  onClick={() => handleSwitchCamera(cam.group_num)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xxs
                             hover:bg-bg-hover transition-colors border-b border-border-subtle/30
                             ${replayState?.cam_group_num === cam.group_num
                               ? 'bg-accent/10 text-accent font-medium'
                               : 'text-text-secondary'}`}>
                  <Eye size={10} className={replayState?.cam_group_num === cam.group_num ? 'text-accent' : 'text-text-disabled'} />
                  <span className="truncate">{cam.group_name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Drivers section */}
        {isConnected && (
          <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            <div className="shrink-0 px-3 py-2 border-b border-border flex items-center gap-1.5 min-w-0">
              <Users size={11} className="text-text-secondary shrink-0" />
              <span className="text-xxs font-medium text-text-primary shrink-0">Drivers</span>
              {replayState?.cam_car_idx != null && drivers.find(d => d.car_idx === replayState.cam_car_idx) && (
                <span className="text-xxs text-accent truncate ml-auto">
                  {drivers.find(d => d.car_idx === replayState.cam_car_idx)?.user_name}
                </span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              {drivers.filter(d => !d.is_spectator).map(d => (
                <button key={d.car_idx}
                  onClick={() => handleSwitchDriver(d.car_idx)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xxs
                             hover:bg-bg-hover transition-colors border-b border-border-subtle/30
                             ${replayState?.cam_car_idx === d.car_idx
                               ? 'bg-accent/10 text-accent font-medium'
                               : 'text-text-secondary'}`}>
                  <span className="font-mono shrink-0 w-5 text-right">#{d.car_number}</span>
                  <span className="truncate">{d.user_name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
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
      className={`flex items-center gap-1 px-2 py-0.5 text-xxs font-medium rounded
                  transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed
                  ${primaryDanger
                    ? 'text-danger bg-danger/10 hover:bg-danger/20'
                    : 'text-text-tertiary bg-bg-hover border border-border-subtle hover:text-text-primary hover:border-border'}`}
    >
      {primaryDanger
        ? <Square size={9} />
        : primaryIcon}
      {primaryDanger ? 'Stop' : primaryLabel}
    </button>
  )

  return (
    <div className={`flex flex-col gap-1.5 px-3 py-2.5 rounded-lg border transition-colors
      ${active
        ? 'bg-accent/5 border-accent/20'
        : done
          ? 'bg-success/5 border-success/30'
          : 'bg-surface border-border-subtle'}`}
    >
      <div className="flex items-center gap-2">
        <div className="shrink-0">
          {active
            ? <Loader2 size={12} className="text-accent animate-spin" />
            : done
              ? <CheckCircle2 size={12} className="text-success" />
              : <span className="block w-2 h-2 rounded-full border border-border" />}
        </div>
        <span className="text-xxs font-semibold text-text-primary flex-1">
          {title}
        </span>
        {primaryTooltip
          ? <Tooltip content={primaryTooltip} position="bottom" delay={300}>{btn}</Tooltip>
          : btn}
      </div>
      {detail && !active && (
        <span className="text-xxs text-text-disabled leading-relaxed pl-[20px]">{detail}</span>
      )}
      {active && progressMsg && (
        <span className="text-xxs text-text-secondary leading-relaxed pl-[20px]">{progressMsg}</span>
      )}
      {active && progressPct != null && (
        <div className="pl-[20px]">
          <div className="h-0.5 bg-surface rounded-full overflow-hidden">
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
