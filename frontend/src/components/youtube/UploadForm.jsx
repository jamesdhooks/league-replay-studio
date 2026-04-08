import {
  Upload,
  ExternalLink,
  X,
  AlertTriangle,
  CheckCircle,
  Loader2,
} from 'lucide-react'

/**
 * UploadForm — video upload form with progress and history.
 *
 * Shows an active-upload progress bar (when uploading), the input form
 * (file path, title, description, tags, privacy), and a list of recent
 * upload jobs.
 */
function UploadForm({
  uploadForm,
  setUploadForm,
  activeUpload,
  uploadHistory,
  onUpload,
  onCancel,
  loading,
}) {
  const isUploading = activeUpload?.state === 'uploading'
  const isCompleted = activeUpload?.state === 'completed'
  const isError = activeUpload?.state === 'error'

  return (
    <div className="space-y-6 max-w-xl">
      {/* Active upload progress */}
      {activeUpload && (
        <div className={`p-4 rounded-lg border ${
          isCompleted ? 'border-green-500/30 bg-green-500/5' :
          isError ? 'border-red-500/30 bg-red-500/5' :
          'border-accent/30 bg-accent/5'
        }`}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              {isUploading && <Loader2 className="w-4 h-4 text-accent animate-spin" />}
              {isCompleted && <CheckCircle className="w-4 h-4 text-green-400" />}
              {isError && <AlertTriangle className="w-4 h-4 text-red-400" />}
              <span className="text-sm font-medium text-text-primary">{activeUpload.title}</span>
            </div>
            {isUploading && (
              <button
                onClick={onCancel}
                className="p-1 text-text-secondary hover:text-red-400 rounded transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {isUploading && (
            <>
              <div className="w-full h-2 bg-surface rounded-full overflow-hidden mb-2">
                <div
                  className="h-full bg-accent rounded-full transition-all duration-300"
                  style={{ width: `${activeUpload.progress}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-text-tertiary">
                <span>{activeUpload.progress.toFixed(1)}%</span>
                <span>{(activeUpload.speed_mbps ?? 0).toFixed(1)} MB/s</span>
                <span>ETA: {formatEta(activeUpload.eta_seconds ?? 0)}</span>
              </div>
            </>
          )}

          {isCompleted && activeUpload.video_url && (
            <a
              href={activeUpload.video_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-accent hover:underline mt-1"
            >
              View on YouTube <ExternalLink className="w-3 h-3" />
            </a>
          )}

          {isError && (
            <p className="text-sm text-red-400 mt-1">{activeUpload.error}</p>
          )}
        </div>
      )}

      {/* Upload form */}
      {!isUploading && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Video File</label>
            <input
              type="text"
              value={uploadForm.filePath}
              onChange={(e) => setUploadForm(f => ({ ...f, filePath: e.target.value }))}
              placeholder="Path to exported video file..."
              className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                         text-text-primary placeholder:text-text-disabled
                         focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Title</label>
            <input
              type="text"
              value={uploadForm.title}
              onChange={(e) => setUploadForm(f => ({ ...f, title: e.target.value }))}
              placeholder="Video title..."
              className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                         text-text-primary placeholder:text-text-disabled
                         focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Description</label>
            <textarea
              value={uploadForm.description}
              onChange={(e) => setUploadForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Video description..."
              rows={3}
              className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                         text-text-primary placeholder:text-text-disabled
                         focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none"
            />
          </div>
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium text-text-primary mb-1">Tags</label>
              <input
                type="text"
                value={uploadForm.tags}
                onChange={(e) => setUploadForm(f => ({ ...f, tags: e.target.value }))}
                placeholder="iracing, sim racing, highlights"
                className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                           text-text-primary placeholder:text-text-disabled
                           focus:outline-none focus:ring-2 focus:ring-accent/40"
              />
            </div>
            <div className="w-36">
              <label className="block text-sm font-medium text-text-primary mb-1">Privacy</label>
              <select
                value={uploadForm.privacy}
                onChange={(e) => setUploadForm(f => ({ ...f, privacy: e.target.value }))}
                className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                           text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40
                           appearance-none cursor-pointer"
              >
                <option value="public">Public</option>
                <option value="unlisted">Unlisted</option>
                <option value="private">Private</option>
              </select>
            </div>
          </div>
          <button
            onClick={onUpload}
            disabled={loading || !uploadForm.filePath || !uploadForm.title}
            className={`flex items-center justify-center gap-2 w-full py-2.5 rounded-lg text-sm
                       font-medium transition-colors ${
              loading || !uploadForm.filePath || !uploadForm.title
                ? 'bg-surface text-text-disabled cursor-not-allowed'
                : 'bg-red-600 hover:bg-red-700 text-white'
            }`}
          >
            <Upload className="w-4 h-4" />
            Upload to YouTube
          </button>
        </div>
      )}

      {/* Upload history */}
      {uploadHistory.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-text-primary mb-2">Recent Uploads</h4>
          <div className="space-y-2">
            {uploadHistory.map((job, i) => (
              <div
                key={job.job_id || i}
                className="flex items-center justify-between p-3 bg-surface rounded-lg"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {job.state === 'completed' ? (
                    <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                  )}
                  <span className="text-sm text-text-primary truncate">{job.title}</span>
                </div>
                {job.video_url && (
                  <a
                    href={job.video_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 p-1 text-text-secondary hover:text-accent"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0) return '—'
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}m ${secs}s`
}

export default UploadForm
