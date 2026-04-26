import { Trash2 } from 'lucide-react'
import UnifiedLogList from '../ui/UnifiedLogList'
import { normalizeAnalysisLogEntries } from '../../utils/logEntries'

export default function LogTabContent({ isAnalyzing, progress, analysisLog, onClearLog }) {
  const entries = normalizeAnalysisLogEntries(analysisLog)

  return (
    <div className="font-mono">
      {analysisLog.length > 0 && !isAnalyzing && (
        <div className="flex justify-end px-2 pt-1.5 pb-1 border-b border-border-subtle sticky top-0 bg-bg-secondary z-10">
          <button
            onClick={onClearLog}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-xxs text-text-disabled hover:text-danger hover:bg-danger/10 transition-colors"
            title="Clear log"
          >
            <Trash2 size={10} />
            Clear
          </button>
        </div>
      )}
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
      <UnifiedLogList
        entries={entries}
        emptyMessage="No log entries yet"
        loadingMessage="Initializing..."
        isLoading={isAnalyzing}
        maxHeightClass="max-h-none"
        className="bg-transparent"
        showStep={false}
      />
    </div>
  )
}
