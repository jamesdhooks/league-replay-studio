import { useState, useCallback, useEffect } from 'react'
import { useYouTube } from '../../context/YouTubeContext'
import { useToast } from '../../context/ToastContext'
import ConnectionStatus from './ConnectionStatus'
import UploadForm from './UploadForm'
import VideoBrowser from './VideoBrowser'
import QuotaDisplay from './QuotaDisplay'

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
    return (
      <ConnectionStatus
        channel={channel}
        isConnected={isConnected}
        connectionStatus={connectionStatus}
        onDisconnect={handleDisconnect}
        onRefresh={handleRefresh}
      />
    )
  }

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Header */}
      <ConnectionStatus
        channel={channel}
        isConnected={isConnected}
        connectionStatus={connectionStatus}
        onDisconnect={handleDisconnect}
        onRefresh={handleRefresh}
      />

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
          <UploadForm
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
          <VideoBrowser
            videos={videos}
            nextPage={videosNextPage}
            onLoadMore={() => fetchVideos(videosNextPage)}
          />
        )}
        {activeTab === 'quota' && (
          <QuotaDisplay quota={quota} onRefresh={fetchQuota} />
        )}
      </div>
    </div>
  )
}


export default YouTubePanel
