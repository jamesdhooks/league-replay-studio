import { useEffect, useRef } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck, Trash2, X } from 'lucide-react'

function fileName(path) {
  return String(path || '').split(/[\\/]/).pop() || 'Unknown clip'
}

export default function ClipValidationReportModal({ status, onClose, onRecover }) {
  const overlayRef = useRef(null)
  const closeRef = useRef(null)
  const report = status?.report
  const running = Boolean(status?.running)
  const failures = report?.failed || []
  const missingEvents = report?.missing_events || []
  const resetCount = report?.recovery?.reset_segment_ids?.length || 0
  const canRecover = Boolean(report?.validator_available && failures.some((failure) => failure.safe_to_delete))

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !running) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, running])

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  return (
    <div
      ref={overlayRef}
      onMouseDown={(event) => {
        if (event.target === overlayRef.current && !running) onClose()
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="clip-validation-report-title"
    >
      <section className="flex w-full max-w-2xl max-h-[min(760px,calc(100vh-2rem))] flex-col overflow-hidden border border-border bg-bg-tertiary shadow-float">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className={`flex h-9 w-9 shrink-0 items-center justify-center ${running ? 'bg-accent/10' : failures.length ? 'bg-danger/10' : missingEvents.length ? 'bg-warning/10' : 'bg-success/10'}`}>
              {running ? <Loader2 className="h-4 w-4 animate-spin text-accent" /> : failures.length ? <AlertTriangle className="h-4 w-4 text-danger" /> : missingEvents.length ? <AlertTriangle className="h-4 w-4 text-warning" /> : <ShieldCheck className="h-4 w-4 text-success" />}
            </div>
            <div className="min-w-0">
              <h2 id="clip-validation-report-title" className="text-sm font-semibold text-text-primary">{running ? 'Validating capture clips' : 'Clip validation report'}</h2>
              <p className="text-xxs text-text-tertiary">{running ? `${status?.checked || 0} of ${status?.total || 0} clips checked` : `${report?.passed || 0} passed of ${report?.checked || 0} checked${missingEvents.length ? ` · ${missingEvents.length} awaiting capture` : ''}`}</p>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            disabled={running}
            className="p-2 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-wait disabled:opacity-50"
            title="Close report"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto">
          {running && (
            <div className="border-b border-border px-5 py-4">
              <div className="h-1.5 overflow-hidden bg-bg-primary">
                <div className="h-full bg-accent transition-all duration-300" style={{ width: `${Math.max(0, Math.min(100, status?.percentage || 0))}%` }} />
              </div>
              <div className="mt-2 flex items-center justify-between text-xxs text-text-tertiary">
                <span className="truncate">{status?.message || 'Starting validation'}</span>
                <span className="ml-3 shrink-0 font-mono">{status?.percentage || 0}%</span>
              </div>
            </div>
          )}

          {running && (status?.logs || []).length > 0 && (
            <div className="divide-y divide-border">
              {(status.logs || []).slice(-4).map((entry) => (
                <div key={`${entry.timestamp}-${entry.message}`} className="flex items-center gap-2 px-5 py-2 text-xxs">
                  <span className={`h-1.5 w-1.5 shrink-0 ${entry.level === 'error' ? 'bg-danger' : entry.level === 'success' ? 'bg-success' : 'bg-accent'}`} />
                  <span className="truncate text-text-secondary">{entry.message}</span>
                </div>
              ))}
            </div>
          )}

          {!running && status?.error && (
            <div className="px-5 py-6 text-sm text-danger">{status.error}</div>
          )}

          {!running && (
            <>
          {report && report.validator_available === false && (
            <div className="border-b border-warning/30 bg-warning/10 px-5 py-3 text-xs text-warning">
              FFmpeg validation is unavailable, so no clips were eligible for recovery.
            </div>
          )}

          {!report && !status?.error && (
            <div className="px-5 py-8 text-center text-sm text-text-tertiary">No validation report is available. Run clip validation again.</div>
          )}

          {report?.checked === 0 && (
            <div className="px-5 py-8 text-center text-sm text-text-tertiary">No captured clips are currently linked to this project.</div>
          )}

          {report?.checked > 0 && failures.length === 0 && missingEvents.length === 0 && (
            <div className="flex items-center gap-2 px-5 py-8 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" />
              Every captured clip passed metadata and decode validation.
            </div>
          )}

          {failures.length > 0 && (
            <div className="divide-y divide-border">
              {failures.map((failure) => (
                <div key={failure.path} className="px-5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs text-text-primary" title={failure.path}>{fileName(failure.path)}</div>
                      <div className="mt-1 text-xxs text-text-tertiary">{(failure.segment_ids || []).join(', ') || 'No linked events'}</div>
                    </div>
                    <span className="shrink-0 text-xxs font-medium text-danger">Failed</span>
                  </div>
                  {(failure.errors || []).map((error) => (
                    <p key={error} className="mt-1.5 text-xxs leading-relaxed text-danger/90">{error}</p>
                  ))}
                </div>
              ))}
            </div>
          )}

          {missingEvents.length > 0 && (
            <div className="border-t border-warning/30">
              <div className="bg-warning/10 px-5 py-2 text-xxs font-medium text-warning">Events awaiting capture</div>
              <div className="divide-y divide-border">
                {missingEvents.map((event) => (
                  <div key={event.segment_id} className="flex items-start justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <div className="font-mono text-xs text-text-primary">{event.segment_id}</div>
                      <div className="mt-1 truncate text-xxs text-text-tertiary">{[event.section, event.event_type].filter(Boolean).join(' · ') || 'Script event'}</div>
                    </div>
                    <span className="shrink-0 text-xxs font-medium text-warning">Uncaptured</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {resetCount > 0 && (
            <div className="border-t border-success/30 bg-success/10 px-5 py-3 text-xs text-success">
              Reset {resetCount} event{resetCount === 1 ? '' : 's'} for recapture.
            </div>
          )}
            </>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <span className="min-w-0 truncate text-xxs text-text-disabled" title={report?.log_file_path || report?.recovery_log_file_path || ''}>
            {report?.log_file_path || report?.recovery_log_file_path ? 'Report saved' : ''}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={onClose} disabled={running} className="px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-50">Close</button>
            {!running && canRecover && resetCount === 0 && (
              <button
                type="button"
                onClick={onRecover}
                disabled={running}
                className="flex items-center gap-1.5 bg-danger px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-danger/80 disabled:cursor-wait disabled:opacity-60"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete & reset {failures.length} corrupt clip{failures.length === 1 ? '' : 's'}
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  )
}
