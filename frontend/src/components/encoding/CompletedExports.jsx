import { useEffect, useCallback } from 'react'
import { useEncoding } from '../../context/EncodingContext'
import { useToast } from '../../context/ToastContext'
import { formatFileSize } from '../../utils/format'
import { formatTime } from '../../utils/time'
import {
  FileVideo, FolderOpen, Copy, Play, CheckCircle2, Clock, HardDrive,
  RefreshCw,
} from 'lucide-react'

/**
 * CompletedExports — File browser showing completed encoding outputs.
 *
 * Each export shows: file name, preset, size, elapsed time.
 * Actions: play (open), reveal in folder, copy path.
 */
export default function CompletedExports() {
  const { completedExports, fetchExports } = useEncoding()
  const { showSuccess } = useToast()

  useEffect(() => {
    fetchExports()
  }, [fetchExports])

  const handleCopyPath = useCallback((filePath) => {
    navigator.clipboard.writeText(filePath).then(() => {
      showSuccess('Path copied to clipboard')
    }).catch(() => {
      // Fallback — select text for manual copy
      const el = document.createElement('textarea')
      el.value = filePath
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      showSuccess('Path copied')
    })
  }, [showSuccess])

  if (!completedExports || completedExports.length === 0) {
    return (
      <div className="text-center py-6">
        <FileVideo className="w-8 h-8 text-text-disabled mx-auto mb-2" />
        <p className="text-xs text-text-tertiary">No completed exports yet</p>
        <p className="text-xxs text-text-disabled mt-1">
          Completed videos will appear here after encoding
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* Header with refresh */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-xxs text-text-tertiary">
          {completedExports.length} export{completedExports.length !== 1 ? 's' : ''}
        </span>
        <button
          onClick={fetchExports}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xxs text-text-tertiary
                     hover:text-text-primary hover:bg-bg-hover transition-colors"
        >
          <RefreshCw className="w-3 h-3" />
          Refresh
        </button>
      </div>

      {/* Export list */}
      {completedExports.map(exp => (
        <div
          key={exp.job_id}
          className="bg-bg-primary border border-border rounded-md p-3 space-y-2"
        >
          {/* File info */}
          <div className="flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-text-primary truncate" title={exp.file_name}>
                {exp.file_name}
              </div>
              <div className="flex items-center gap-2 text-xxs text-text-tertiary mt-0.5">
                {exp.preset?.name && (
                  <span>{exp.preset.name}</span>
                )}
                {exp.job_type && (
                  <>
                    <span className="text-text-disabled">·</span>
                    <span className="capitalize">{exp.job_type}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="flex items-center gap-3 text-xxs text-text-tertiary">
            {exp.file_size_bytes > 0 && (
              <span className="flex items-center gap-1">
                <HardDrive className="w-3 h-3" />
                {formatFileSize(exp.file_size_bytes)}
              </span>
            )}
            {exp.elapsed_seconds > 0 && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatTime(exp.elapsed_seconds)}
              </span>
            )}
            {!exp.file_exists && (
              <span className="text-warning">File not found</span>
            )}
          </div>

          {/* Actions */}
          {exp.file_exists && (
            <div className="flex items-center gap-1.5">
              <ExportAction
                icon={Play}
                label="Play"
                onClick={() => window.open(`file://${exp.output_file}`, '_blank')}
              />
              <ExportAction
                icon={FolderOpen}
                label="Reveal"
                onClick={() => window.open(`file://${exp.output_dir}`, '_blank')}
              />
              <ExportAction
                icon={Copy}
                label="Copy Path"
                onClick={() => handleCopyPath(exp.output_file)}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}


function ExportAction({ icon: Icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-2 py-1 rounded text-xxs font-medium
                 text-text-secondary hover:text-text-primary hover:bg-bg-hover
                 border border-border transition-colors"
      title={label}
    >
      <Icon className="w-3 h-3" />
      {label}
    </button>
  )
}
