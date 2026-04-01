import { useState, useCallback, useEffect } from 'react'
import {
  Youtube,
  Upload,
  RefreshCw,
  ExternalLink,
  Eye,
  ThumbsUp,
  MessageCircle,
  X,
  AlertTriangle,
  CheckCircle,
  Loader2,
  ChevronDown,
  Link2Off,
  Gauge,
} from 'lucide-react'
import { useYouTube } from '../../context/YouTubeContext'
import { useToast } from '../../context/ToastContext'

/**
 * YouTubePanel — YouTube channel integration UI.
 *
 * Shows connection status, upload controls with progress,
 * uploaded video browser, and quota usage.
 */
function YouTubePanel() {
  const {
    connectionStatus,
    isConnected,
    channel,
    disconnect,
    refreshConnection,
    activeUpload,
    uploadHistory,
    startUpload,
    cancelUpload,
    videos,
    videosNextPage,
    fetchVideos,
    quota,
    fetchQuota,
    loading,
  } = useYouTube()
  const { showSuccess, showError, showWarning } = useToast()

  const [activeTab, setActiveTab] = useState('upload')
  const [uploadForm, setUploadForm] = useState({
    filePath: '',
    title: '',
    description: '',
    tags: '',
    privacy: 'unlisted',
  })

  // Load videos when tab switches to browser
  useEffect(() => {
    if (activeTab === 'videos' && isConnected && videos.length === 0) {
      fetchVideos()
    }
  }, [activeTab, isConnected, videos.length, fetchVideos])

  // ── Upload ──────────────────────────────────────────────────────────────
  const handleUpload = useCallback(async () => {
    if (!uploadForm.filePath || !uploadForm.title) {
      showWarning('File path and title are required')
      return
    }
    try {
      await startUpload({
        filePath: uploadForm.filePath,
        title: uploadForm.title,
        description: uploadForm.description,
        tags: uploadForm.tags ? uploadForm.tags.split(',').map(t => t.trim()) : [],
        privacy: uploadForm.privacy,
      })
      showSuccess('Upload started')
    } catch (err) {
      showError(err.message || 'Upload failed')
    }
  }, [uploadForm, startUpload, showSuccess, showError, showWarning])

  const handleCancelUpload = useCallback(async () => {
    if (activeUpload?.job_id) {
      try {
        await cancelUpload(activeUpload.job_id)
        showWarning('Upload cancellation requested')
      } catch (err) {
        showError(err.message)
      }
    }
  }, [activeUpload, cancelUpload, showWarning, showError])

  const handleDisconnect = useCallback(async () => {
    try {
      await disconnect()
      showSuccess('YouTube disconnected')
    } catch (err) {
      showError(err.message)
    }
  }, [disconnect, showSuccess, showError])

  const handleRefresh = useCallback(async () => {
    try {
      await refreshConnection()
      showSuccess('Connection refreshed')
    } catch (err) {
      showError(err.message)
    }
  }, [refreshConnection, showSuccess, showError])

  if (!isConnected) {
    return <DisconnectedView state={connectionStatus.state} />
  }

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Youtube className="w-5 h-5 text-red-500" />
          <h2 className="text-base font-semibold text-text-primary">YouTube</h2>
          {channel && (
            <span className="text-xs text-text-tertiary">• {channel.title}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary
                       hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
            title="Refresh connection"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleDisconnect}
            className="flex items-center gap-1 px-2 py-1 text-xs text-red-400
                       hover:text-red-300 hover:bg-surface-hover rounded transition-colors"
            title="Disconnect"
          >
            <Link2Off className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border shrink-0">
        {[
          { id: 'upload', label: 'Upload' },
          { id: 'videos', label: 'Videos' },
          { id: 'quota', label: 'Quota' },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
              activeTab === tab.id
                ? 'border-accent text-accent'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'upload' && (
          <UploadTab
            uploadForm={uploadForm}
            setUploadForm={setUploadForm}
            activeUpload={activeUpload}
            uploadHistory={uploadHistory}
            onUpload={handleUpload}
            onCancel={handleCancelUpload}
            loading={loading}
          />
        )}
        {activeTab === 'videos' && (
          <VideosTab
            videos={videos}
            nextPage={videosNextPage}
            onLoadMore={() => fetchVideos(videosNextPage)}
          />
        )}
        {activeTab === 'quota' && (
          <QuotaTab quota={quota} onRefresh={fetchQuota} />
        )}
      </div>
    </div>
  )
}


// ── Disconnected View ───────────────────────────────────────────────────────

function DisconnectedView({ state }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
      <Youtube className="w-12 h-12 text-text-disabled" />
      <h3 className="text-lg font-semibold text-text-primary">YouTube Not Connected</h3>
      <p className="text-sm text-text-tertiary max-w-sm">
        Connect your YouTube channel in Settings → YouTube to enable
        video uploading and channel management.
      </p>
      {state === 'expired' && (
        <div className="flex items-center gap-2 text-yellow-400 text-sm">
          <AlertTriangle className="w-4 h-4" />
          <span>Token expired — reconnect in Settings</span>
        </div>
      )}
    </div>
  )
}


// ── Upload Tab ──────────────────────────────────────────────────────────────

function UploadTab({ uploadForm, setUploadForm, activeUpload, uploadHistory, onUpload, onCancel, loading }) {
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
                <span>{activeUpload.speed_mbps.toFixed(1)} MB/s</span>
                <span>ETA: {formatEta(activeUpload.eta_seconds)}</span>
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


// ── Videos Tab ──────────────────────────────────────────────────────────────

function VideosTab({ videos, nextPage, onLoadMore }) {
  if (videos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-center">
        <Youtube className="w-8 h-8 text-text-disabled mb-2" />
        <p className="text-sm text-text-tertiary">No uploaded videos found</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {videos.map(video => (
        <div
          key={video.video_id}
          className="flex gap-3 p-3 bg-surface rounded-lg hover:bg-surface-hover transition-colors"
        >
          {video.thumbnail && (
            <img
              src={video.thumbnail}
              alt=""
              className="w-32 h-18 rounded object-cover shrink-0"
            />
          )}
          <div className="flex-1 min-w-0">
            <a
              href={video.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-text-primary hover:text-accent line-clamp-2"
            >
              {video.title}
            </a>
            <div className="flex items-center gap-3 mt-1 text-xs text-text-tertiary">
              <span className="flex items-center gap-1">
                <Eye className="w-3 h-3" /> {formatCount(video.view_count)}
              </span>
              <span className="flex items-center gap-1">
                <ThumbsUp className="w-3 h-3" /> {formatCount(video.like_count)}
              </span>
              <span className="flex items-center gap-1">
                <MessageCircle className="w-3 h-3" /> {formatCount(video.comment_count)}
              </span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-medium ${
                video.privacy === 'public' ? 'bg-green-500/10 text-green-400' :
                video.privacy === 'unlisted' ? 'bg-yellow-500/10 text-yellow-400' :
                'bg-red-500/10 text-red-400'
              }`}>
                {video.privacy}
              </span>
            </div>
          </div>
        </div>
      ))}

      {nextPage && (
        <button
          onClick={onLoadMore}
          className="flex items-center justify-center gap-1 w-full py-2 text-sm text-text-secondary
                     hover:text-text-primary hover:bg-surface-hover rounded-lg transition-colors"
        >
          <ChevronDown className="w-4 h-4" />
          Load more
        </button>
      )}
    </div>
  )
}


// ── Quota Tab ───────────────────────────────────────────────────────────────

function QuotaTab({ quota, onRefresh }) {
  if (!quota) {
    return (
      <div className="flex items-center justify-center h-32">
        <span className="text-sm text-text-tertiary">Loading quota info...</span>
      </div>
    )
  }

  const percentage = quota.percentage || 0
  const isWarning = quota.warning

  return (
    <div className="space-y-6 max-w-md">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gauge className="w-5 h-5 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">Daily API Quota</h3>
        </div>
        <button
          onClick={onRefresh}
          className="p-1 text-text-secondary hover:text-text-primary rounded transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div>
        <div className="flex justify-between text-sm mb-1">
          <span className="text-text-secondary">
            {quota.used.toLocaleString()} / {quota.limit.toLocaleString()} units
          </span>
          <span className={isWarning ? 'text-yellow-400 font-medium' : 'text-text-tertiary'}>
            {percentage}%
          </span>
        </div>
        <div className="w-full h-3 bg-surface rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              isWarning ? 'bg-yellow-500' : 'bg-accent'
            }`}
            style={{ width: `${Math.min(percentage, 100)}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="p-3 bg-surface rounded-lg">
          <p className="text-xs text-text-tertiary">Remaining</p>
          <p className="text-lg font-semibold text-text-primary">
            {quota.remaining.toLocaleString()}
          </p>
        </div>
        <div className="p-3 bg-surface rounded-lg">
          <p className="text-xs text-text-tertiary">Uploads Left</p>
          <p className="text-lg font-semibold text-text-primary">
            {quota.uploads_remaining}
          </p>
        </div>
      </div>

      {isWarning && (
        <div className="flex items-center gap-2 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
          <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />
          <p className="text-sm text-yellow-400">
            Approaching daily quota limit. Consider waiting until tomorrow for more uploads.
          </p>
        </div>
      )}

      <p className="text-xs text-text-disabled">
        Date: {quota.date} • Quota resets daily at midnight Pacific Time.
      </p>
    </div>
  )
}


// ── Helpers ─────────────────────────────────────────────────────────────────

function formatEta(seconds) {
  if (!seconds || seconds <= 0) return '—'
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}m ${secs}s`
}

function formatCount(count) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return String(count)
}


export default YouTubePanel
