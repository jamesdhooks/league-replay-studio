import { Loader2, CheckCircle2, XCircle, Zap } from 'lucide-react'

export default function LogTabContent({ isAnalyzing, progress, analysisLog }) {
  return (
    <div className="font-mono">
      {isAnalyzing && progress && (
        <div className="px-3 pt-2 pb-1.5 border-b border-border-subtle sticky top-0 bg-bg-secondary z-10">
          <div className="h-1 bg-bg-tertiary rounded-full overflow-hidden">
            <div
              className="h-full bg-accent/70 rounded-full transition-all duration-500"
              style={{ width: `${progress.percent ?? 0}%` }}
            />
          </div>
          <span className="text-xxs text-text-disabled mt-1 block truncate">
            {progress.message || 'Analyzing...'}
          </span>
        </div>
      )}
      {analysisLog.length === 0 && !isAnalyzing && (
        <div className="flex items-center justify-center py-8 text-text-disabled text-xs">
          No log entries yet
        </div>
      )}
      {analysisLog.length === 0 && isAnalyzing && (
        <div className="flex items-center gap-2 px-3 py-4 text-text-disabled text-xxs">
          <Loader2 size={11} className="animate-spin shrink-0" />
          <span>Initializing...</span>
        </div>
      )}
      {[...analysisLog].reverse().map(entry => (
        <div
          key={entry.id}
          className="flex gap-2 px-3 py-1.5 text-xxs border-b border-border-subtle/30 animate-fade-in"
        >
          <span className="shrink-0 select-none mt-0.5">
            {entry.level === 'success' ? (
              <CheckCircle2 size={11} className="text-success" />
            ) : entry.level === 'error' ? (
              <XCircle size={11} className="text-danger" />
            ) : entry.level === 'detect' ? (
              <Zap size={11} className="text-warning" />
            ) : (
              <span className="text-text-disabled">›</span>
            )}
          </span>
          <div className="flex-1 min-w-0">
            <span className="text-text-disabled font-mono mr-1.5">
              {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
            <span className="text-text-secondary">{entry.message}</span>
            {entry.detail && (
              <span className="text-text-disabled ml-1">— {entry.detail}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
