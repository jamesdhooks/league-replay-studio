import LogViewer from '../ui/LogViewer'
import { normalizeAnalysisLogEntries } from '../../utils/logEntries'

export default function LogTabContent({ isAnalyzing, progress, analysisLog }) {
  const entries = normalizeAnalysisLogEntries(analysisLog)

  return (
    <div className="h-full min-h-0 flex flex-col font-mono">
      {isAnalyzing && progress && (
        <div className="px-3 pt-2 pb-1.5 border-b border-border-subtle bg-bg-secondary shrink-0">
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
      <LogViewer
        title="Analysis Log"
        entries={entries}
        rawEntries={analysisLog}
        schema="league-replay-studio.analysis-log"
        emptyMessage="No log entries yet"
        loadingMessage="Initializing..."
        isLoading={isAnalyzing}
        maxHeightClass="max-h-none"
        className="flex-1 min-h-0 bg-transparent"
        bodyClassName="bg-transparent"
        headerClassName="bg-bg-secondary"
        showStep={false}
      />
    </div>
  )
}
