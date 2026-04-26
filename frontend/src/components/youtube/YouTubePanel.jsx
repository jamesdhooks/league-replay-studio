import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useYouTube } from '../../context/YouTubeContext'
import { useToast } from '../../context/ToastContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import VideoBrowser from './VideoBrowser'
import QuotaDisplay from './QuotaDisplay'
import ResizableSidebar from '../layout/ResizableSidebar'
import CollapsibleControlsHeader from '../ui/CollapsibleControlsHeader'
import CollapsiblePanelHeader from '../ui/CollapsiblePanelHeader'
import ResizableRowPane from '../ui/ResizableRowPane'
import {
  Youtube,
  Upload,
  CheckCircle,
  AlertTriangle,
  Loader2,
  ExternalLink,
  X,
  Film,
  Clock,
  Gauge,
  List,
  Settings2,
  RefreshCw,
  Link2Off,
} from 'lucide-react'

function formatEta(seconds) {
  if (!seconds || seconds <= 0) return '—'
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}m ${secs}s`
}

/**
 * YouTubePanel — YouTube channel integration UI.
 *
 * Follows the same left-sidebar / controls / center / right-log layout
 * pattern as EncodingPanel and OverlayEditor.
 *
 * Not-connected: full-pane centered placeholder.
 * Connected: ResizableSidebar (videos) | Controls column (upload form) |
 *            Center split (active upload / stats) | Right split (history / quota).
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

  const [uploadForm, setUploadForm] = useState({
    filePath: '',
    title: '',
    description: '',
    tags: '',
    privacy: 'unlisted',
  })

  const [controlsCollapsed, setControlsCollapsed] = useLocalStorage('lrs:youtube:controls:collapsed', false)
  const [controlsWidth, setControlsWidth] = useLocalStorage('lrs:youtube:controls:width', 340)
  const [rightWidth, setRightWidth] = useLocalStorage('lrs:youtube:right:width', 300)
  const controlsWidthRef = useRef(controlsWidth)
  const rightWidthRef = useRef(rightWidth)

  useEffect(() => { controlsWidthRef.current = controlsWidth }, [controlsWidth])
  useEffect(() => { rightWidthRef.current = rightWidth }, [rightWidth])

  // Fetch quota on connect
  useEffect(() => {
    if (isConnected) fetchQuota()
  }, [isConnected, fetchQuota])

  // ── Handlers ────────────────────────────────────────────────────────────

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

  const startControlsResize = useCallback((e) => {
    const startX = e.clientX
    const startW = controlsWidthRef.current
    const onMove = (ev) => setControlsWidth(Math.min(520, Math.max(240, startW + (ev.clientX - startX))))
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [setControlsWidth])

  const startRightResize = useCallback((e) => {
    const startX = e.clientX
    const startW = rightWidthRef.current
    const onMove = (ev) => setRightWidth(Math.min(520, Math.max(240, startW - (ev.clientX - startX))))
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [setRightWidth])

  // ── Upload state flags ───────────────────────────────────────────────────

  const isUploading = activeUpload?.state === 'uploading'
  const isCompleted = activeUpload?.state === 'completed'
  const isError = activeUpload?.state === 'error'

  // ── Left sidebar tabs ────────────────────────────────────────────────────

  const sidebarTabs = useMemo(() => [
    {
      id: 'videos',
      label: 'Videos',
      icon: Film,
      content: (
        <div className="h-full overflow-y-auto p-3">
          <VideoBrowser
            videos={videos}
            nextPage={videosNextPage}
            onLoadMore={() => fetchVideos(videosNextPage)}
          />
        </div>
      ),
    },
  ], [videos, videosNextPage, fetchVideos])

  // ── Controls column content ──────────────────────────────────────────────

  const controlsContent = (
    <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
      {/* Connection status row */}
      <div className="flex items-center justify-between px-2.5 py-2 bg-bg-primary/50 rounded-md border border-border">
        <div className="flex items-center gap-2 min-w-0">
          <Youtube className="w-4 h-4 text-red-500 shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-text-primary truncate">
              {channel?.title || 'Connected'}
            </p>
            {connectionStatus?.state === 'expired' && (
              <p className="text-xxs text-yellow-400">Token expired</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={handleRefresh}
            className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
            title="Refresh connection"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleDisconnect}
            className="p-1.5 text-red-400 hover:text-red-300 hover:bg-bg-hover rounded transition-colors"
            title="Disconnect"
          >
            <Link2Off className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Upload form fields */}
      <div className="space-y-3">
        <div className="flex flex-col gap-1">
          <label className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">Video File</label>
          <input
            type="text"
            value={uploadForm.filePath}
            onChange={(e) => setUploadForm(f => ({ ...f, filePath: e.target.value }))}
            placeholder="Path to exported video file..."
            className="w-full px-2.5 py-1.5 text-xs bg-bg-primary border border-border rounded-md
                       text-text-primary placeholder:text-text-disabled
                       focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">Title</label>
          <input
            type="text"
            value={uploadForm.title}
            onChange={(e) => setUploadForm(f => ({ ...f, title: e.target.value }))}
            placeholder="Video title..."
            className="w-full px-2.5 py-1.5 text-xs bg-bg-primary border border-border rounded-md
                       text-text-primary placeholder:text-text-disabled
                       focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">Description</label>
          <textarea
            value={uploadForm.description}
            onChange={(e) => setUploadForm(f => ({ ...f, description: e.target.value }))}
            placeholder="Video description..."
            rows={3}
            className="w-full px-2.5 py-1.5 text-xs bg-bg-primary border border-border rounded-md
                       text-text-primary placeholder:text-text-disabled
                       focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">Tags</label>
          <input
            type="text"
            value={uploadForm.tags}
            onChange={(e) => setUploadForm(f => ({ ...f, tags: e.target.value }))}
            placeholder="iracing, sim racing, highlights"
            className="w-full px-2.5 py-1.5 text-xs bg-bg-primary border border-border rounded-md
                       text-text-primary placeholder:text-text-disabled
                       focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">Privacy</label>
          <select
            value={uploadForm.privacy}
            onChange={(e) => setUploadForm(f => ({ ...f, privacy: e.target.value }))}
            className="w-full px-2.5 py-1.5 text-xs bg-bg-primary border border-border rounded-md
                       text-text-primary focus:outline-none focus:ring-1 focus:ring-accent/40
                       appearance-none cursor-pointer"
          >
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
            <option value="private">Private</option>
          </select>
        </div>

        <button
          onClick={handleUpload}
          disabled={loading || isUploading || !uploadForm.filePath || !uploadForm.title}
          className={`flex items-center justify-center gap-2 w-full py-2 rounded-md text-xs font-medium transition-colors ${
            loading || isUploading || !uploadForm.filePath || !uploadForm.title
              ? 'bg-surface text-text-disabled cursor-not-allowed'
              : 'bg-red-600 hover:bg-red-700 text-white'
          }`}
        >
          {isUploading
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Upload className="w-3.5 h-3.5" />
          }
          {isUploading ? 'Uploading…' : 'Upload to YouTube'}
        </button>
      </div>
    </div>
  )

  // ── Not connected ────────────────────────────────────────────────────────

  if (!isConnected) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-primary">
        <div className="flex flex-col items-center gap-4 p-8 text-center max-w-sm">
          <Youtube className="w-12 h-12 text-text-disabled" />
          <h3 className="text-lg font-semibold text-text-primary">YouTube Not Connected</h3>
          <p className="text-sm text-text-tertiary">
            Connect your YouTube channel in{' '}
            <span className="text-text-secondary font-medium">Settings → YouTube</span>
            {' '}to enable video uploading and channel management.
          </p>
          {connectionStatus?.state === 'expired' && (
            <div className="flex items-center gap-2 text-yellow-400 text-sm">
              <AlertTriangle className="w-4 h-4" />
              <span>Token expired — reconnect in Settings</span>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Connected layout ─────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full w-full min-w-0 overflow-hidden min-h-0">
      <div className="flex-1 min-h-0 min-w-0 flex overflow-hidden bg-bg-primary">

        {/* Left sidebar: Videos */}
        <ResizableSidebar
          storageKey="lrs:youtube:workspace:sidebar"
          defaultWidth={300}
          defaultTab="videos"
          tabs={sidebarTabs}
        />

        {/* Controls column: Upload form */}
        {controlsCollapsed && (
          <CollapsibleControlsHeader
            collapsed
            icon={Settings2}
            title="Upload Controls"
            onExpand={() => setControlsCollapsed(false)}
            expandTitle="Expand Upload Controls"
          />
        )}

        {!controlsCollapsed && (
          <div
            className="shrink-0 border-r border-border bg-bg-secondary flex flex-col min-h-0"
            style={{ width: controlsWidth }}
          >
            <CollapsibleControlsHeader
              collapsed={false}
              icon={Settings2}
              title="Upload Controls"
              onCollapse={() => setControlsCollapsed(true)}
            />
            <div className="flex-1 min-h-0 overflow-hidden">
              {controlsContent}
            </div>
          </div>
        )}

        {!controlsCollapsed && (
          <div
            className="shrink-0 cursor-col-resize group/divider relative"
            style={{ width: 1, marginLeft: -1 }}
            onMouseDown={startControlsResize}
          >
            <div className="absolute inset-y-0 -left-2 -right-2 z-20" />
          </div>
        )}

        {/* Center: active upload progress + stats */}
        <div className="flex-1 min-h-0 min-w-0 overflow-hidden bg-bg-primary">
          <ResizableRowPane
            storageKey="lrs:youtube:workspace:split"
            defaultBottomHeight={180}
            minBottom={120}
            top={(
              <div className="flex flex-col h-full min-h-0">
                <div className="flex items-center border-b border-border bg-bg-secondary shrink-0">
                  <CollapsiblePanelHeader
                    open
                    icon={Upload}
                    title={isUploading ? 'Upload in Progress' : isCompleted ? 'Upload Complete' : 'Upload'}
                    className="flex-1"
                    status={
                      isUploading ? (
                        <span className="flex items-center gap-1 rounded-full bg-accent/10 border border-accent/30 px-2 py-0.5 text-xxs font-medium text-accent">
                          <Loader2 className="w-2.5 h-2.5 animate-spin" /> Uploading
                        </span>
                      ) : isCompleted ? (
                        <span className="flex items-center gap-1 rounded-full bg-success/10 border border-success/30 px-2 py-0.5 text-xxs font-medium text-success">
                          <CheckCircle className="w-2.5 h-2.5" /> Done
                        </span>
                      ) : isError ? (
                        <span className="flex items-center gap-1 rounded-full bg-danger/10 border border-danger/30 px-2 py-0.5 text-xxs font-medium text-danger">
                          <AlertTriangle className="w-2.5 h-2.5" /> Error
                        </span>
                      ) : null
                    }
                  />
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto bg-bg-primary">
                  {activeUpload ? (
                    <div className="p-4">
                      <div className={`p-4 rounded-lg border ${
                        isCompleted ? 'border-success/30 bg-success/5' :
                        isError ? 'border-danger/30 bg-danger/5' :
                        'border-accent/30 bg-accent/5'
                      }`}>
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2 min-w-0">
                            {isUploading && <Loader2 className="w-4 h-4 text-accent animate-spin shrink-0" />}
                            {isCompleted && <CheckCircle className="w-4 h-4 text-success shrink-0" />}
                            {isError && <AlertTriangle className="w-4 h-4 text-danger shrink-0" />}
                            <span className="text-sm font-medium text-text-primary truncate">
                              {activeUpload.title}
                            </span>
                          </div>
                          {isUploading && (
                            <button
                              onClick={handleCancelUpload}
                              className="p-1 text-text-secondary hover:text-danger rounded transition-colors shrink-0"
                              title="Cancel upload"
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
                            className="inline-flex items-center gap-1.5 mt-2 text-sm text-accent hover:underline"
                          >
                            View on YouTube <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}

                        {isError && (
                          <p className="text-sm text-danger mt-2">{activeUpload.error}</p>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center px-6 text-center bg-bg-secondary">
                      <div>
                        <Youtube className="w-8 h-8 mx-auto mb-2 text-text-tertiary" />
                        <p className="text-sm text-text-secondary font-medium">No active upload.</p>
                        <p className="text-xs text-text-tertiary mt-1">
                          Fill in the controls and click Upload to start.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            bottom={(
              <div className="h-full min-h-0 overflow-hidden flex flex-col">
                <div className="flex items-center border-b border-border bg-bg-secondary shrink-0">
                  <CollapsiblePanelHeader
                    open
                    icon={Clock}
                    title="Upload Stats"
                    className="flex-1"
                  />
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-3">
                  {activeUpload ? (
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { label: 'Progress', value: `${(activeUpload.progress ?? 0).toFixed(1)}%` },
                        { label: 'Speed', value: `${(activeUpload.speed_mbps ?? 0).toFixed(1)} MB/s` },
                        { label: 'ETA', value: formatEta(activeUpload.eta_seconds ?? 0) },
                        { label: 'Privacy', value: activeUpload.privacy || '—' },
                      ].map(({ label, value }) => (
                        <div key={label} className="p-2.5 bg-bg-secondary rounded-md border border-border">
                          <p className="text-xxs text-text-tertiary uppercase tracking-wider mb-0.5">{label}</p>
                          <p className="text-sm font-medium text-text-primary tabular-nums">{value}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-full text-xs text-text-tertiary">
                      No upload in progress
                    </div>
                  )}
                </div>
              </div>
            )}
          />
        </div>

        {/* Right resize handle */}
        <div
          className="shrink-0 cursor-col-resize group/divider relative"
          style={{ width: 1, marginLeft: -1 }}
          onMouseDown={startRightResize}
        >
          <div className="absolute inset-y-0 -left-2 -right-2 z-20" />
        </div>

        {/* Right sidebar: Upload history (top) + Quota (bottom) */}
        <div
          className="shrink-0 border-l border-border bg-bg-secondary min-h-0 flex flex-col"
          style={{ width: rightWidth }}
        >
          <ResizableRowPane
            storageKey="lrs:youtube:right:split"
            defaultBottomHeight={200}
            minBottom={120}
            maxBottom={420}
            top={(
              <div className="h-full min-h-0 overflow-hidden flex flex-col">
                <div className="flex items-center border-b border-border bg-bg-secondary shrink-0">
                  <CollapsiblePanelHeader
                    open
                    icon={List}
                    title="Upload History"
                    className="flex-1"
                  />
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-2">
                  {uploadHistory.length > 0 ? (
                    <div className="space-y-1.5">
                      {uploadHistory.map((job, i) => (
                        <div
                          key={job.job_id || i}
                          className={`flex items-center gap-2 px-2.5 py-2 rounded-md border ${
                            job.state === 'completed'
                              ? 'bg-success/5 border-success/25'
                              : 'bg-danger/5 border-danger/25'
                          }`}
                        >
                          {job.state === 'completed' ? (
                            <CheckCircle className="w-3.5 h-3.5 text-success shrink-0" />
                          ) : (
                            <AlertTriangle className="w-3.5 h-3.5 text-danger shrink-0" />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="text-xs text-text-secondary truncate">{job.title}</p>
                            <p className="text-xxs text-text-tertiary capitalize">{job.privacy || 'unlisted'}</p>
                          </div>
                          {job.video_url && (
                            <a
                              href={job.video_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="shrink-0 p-1 text-text-secondary hover:text-accent rounded transition-colors"
                              title="View on YouTube"
                            >
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-md border border-border bg-bg-primary px-3 py-4 text-xs text-text-tertiary text-center">
                      No upload history yet.
                    </div>
                  )}
                </div>
              </div>
            )}
            bottom={(
              <div className="h-full min-h-0 overflow-hidden flex flex-col">
                <div className="flex items-center border-b border-border bg-bg-secondary shrink-0">
                  <CollapsiblePanelHeader
                    open
                    icon={Gauge}
                    title="API Quota"
                    className="flex-1"
                  />
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-3">
                  <QuotaDisplay quota={quota} onRefresh={fetchQuota} />
                </div>
              </div>
            )}
          />
        </div>

      </div>
    </div>
  )
}

export default YouTubePanel
