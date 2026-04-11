import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { usePreview } from '../../context/PreviewContext'
import { useToast } from '../../context/ToastContext'
import { formatTime } from '../../utils/time'
import {
  Play, Pause, SkipBack, SkipForward, Maximize2,
  Film, Monitor, Columns2, Sparkles, Gauge,
  Loader2, CheckCircle2, XCircle, AlertTriangle,
  RefreshCw, Square, Clock, Eye,
} from 'lucide-react'
import IracingCommandLog from '../highlights/IracingCommandLog'

/**
 * PreviewPanel — Video preview player with tiered playback.
 *
 * Shows: proxy video player, sprite sheet scrubbing, playback controls,
 * speed selection, preview mode tabs, and generation progress.
 *
 * @param {Object} props
 * @param {number} props.projectId - Active project ID
 * @param {string} [props.inputFile] - Source video file path
 * @param {string} [props.previewDir] - Preview assets directory
 */
export default function PreviewPanel({ projectId, inputFile, previewDir }) {
  const {
    activeJob, initPreview, fetchStatus, cancelPreview,
    playing, playbackSpeed, previewMode, currentTime,
    play, pause, togglePlay, seek, setCurrentTime, cycleSpeed,
    setPreviewMode, setActiveProjectId, setPlaybackSpeed,
    getProxyUrl, getAudioUrl, spritesIndex,
    fetchSpritesIndex, loading,
  } = usePreview()
  const { showSuccess, showError } = useToast()

  const videoRef = useRef(null)
  const [duration, setDuration] = useState(0)
  const [videoReady, setVideoReady] = useState(false)
  const [hoveredTime, setHoveredTime] = useState(null)

  // Set active project
  useEffect(() => {
    setActiveProjectId(projectId)
    fetchStatus(projectId)
    return () => setActiveProjectId(null)
  }, [projectId, setActiveProjectId, fetchStatus])

  // Fetch sprites when available
  useEffect(() => {
    if (activeJob?.sprites_ready) {
      fetchSpritesIndex(projectId)
    }
  }, [activeJob?.sprites_ready, projectId, fetchSpritesIndex])

  // Sync video element with playback state
  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoReady) return

    if (playing) {
      video.play().catch(() => {})
    } else {
      video.pause()
    }
  }, [playing, videoReady])

  // Sync playback speed
  useEffect(() => {
    const video = videoRef.current
    if (video) video.playbackRate = playbackSpeed
  }, [playbackSpeed])

  // Track current time from video
  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current
    if (video) {
      setCurrentTime(video.currentTime)
    }
  }, [setCurrentTime])

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current
    if (video) {
      setDuration(video.duration)
      setVideoReady(true)
    }
  }, [])

  const handleVideoEnded = useCallback(() => {
    pause()
  }, [pause])

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleInit = useCallback(async () => {
    if (!inputFile) {
      showError('No video file available for preview')
      return
    }
    const dir = previewDir || inputFile.replace(/[/\\][^/\\]+$/, '') + '/preview'
    const result = await initPreview({
      projectId,
      inputFile,
      previewDir: dir,
    })
    if (result.success) {
      showSuccess('Preview generation started')
    } else {
      showError(result.error || 'Failed to start preview')
    }
  }, [projectId, inputFile, previewDir, initPreview, showSuccess, showError])

  const handleCancel = useCallback(async () => {
    const result = await cancelPreview(projectId)
    if (result.success) {
      showSuccess('Preview generation cancelled')
    }
  }, [projectId, cancelPreview, showSuccess])

  const handleSeek = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const targetDuration = activeJob?.video_info?.duration || duration
    const time = pct * targetDuration
    seek(time)
    if (videoRef.current) {
      videoRef.current.currentTime = time
    }
  }, [duration, activeJob, seek])

  const handleScrubHover = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const targetDuration = activeJob?.video_info?.duration || duration
    setHoveredTime(pct * targetDuration)
  }, [duration, activeJob])

  const handleScrubLeave = useCallback(() => {
    setHoveredTime(null)
  }, [])

  const handleSkipBack = useCallback(() => {
    const time = Math.max(0, currentTime - 5)
    seek(time)
    if (videoRef.current) videoRef.current.currentTime = time
  }, [currentTime, seek])

  const handleSkipForward = useCallback(() => {
    const targetDuration = activeJob?.video_info?.duration || duration
    const time = Math.min(targetDuration, currentTime + 5)
    seek(time)
    if (videoRef.current) videoRef.current.currentTime = time
  }, [currentTime, duration, activeJob, seek])

  // ── State-based rendering ─────────────────────────────────────────────

  const isGenerating = activeJob && ['indexing', 'sprites', 'proxy', 'audio'].includes(activeJob.state)
  const isReady = activeJob?.state === 'ready'
  const hasProxy = activeJob?.proxy_ready
  const hasError = activeJob?.state === 'error'
  const totalDuration = activeJob?.video_info?.duration || duration || 0
  const progressPct = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0

  const proxyUrl = hasProxy ? getProxyUrl(projectId) : null

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg-primary">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bg-secondary shrink-0">
        <Eye className="w-4 h-4 text-accent" />
        <h3 className="text-xs font-semibold text-text-primary uppercase tracking-wider">Preview</h3>
        <div className="flex-1" />

        {/* Preview mode tabs */}
        <div className="flex items-center gap-0.5 bg-bg-primary rounded-md p-0.5 border border-border">
          <ModeButton mode="full" label="Full" icon={Film} active={previewMode} onClick={setPreviewMode} />
          <ModeButton mode="highlight" label="Highlight" icon={Sparkles} active={previewMode} onClick={setPreviewMode} />
          <ModeButton mode="source" label="Source" icon={Monitor} active={previewMode} onClick={setPreviewMode} />
          <ModeButton mode="split" label="Split" icon={Columns2} active={previewMode} onClick={setPreviewMode} />
        </div>
      </div>

      {/* Video area */}
      <div className="flex-1 flex items-center justify-center bg-black min-h-0 relative overflow-hidden">
        {proxyUrl ? (
          <video
            ref={videoRef}
            src={proxyUrl}
            className="max-w-full max-h-full object-contain"
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onEnded={handleVideoEnded}
            preload="auto"
          />
        ) : isGenerating ? (
          <GeneratingOverlay job={activeJob} />
        ) : hasError ? (
          <ErrorOverlay error={activeJob?.error} onRetry={handleInit} />
        ) : (
          <InitOverlay onInit={handleInit} loading={loading} hasInputFile={!!inputFile} />
        )}

        {/* iRacing command log — bottom-right overlay */}
        <IracingCommandLog />
      </div>

      {/* Progress / scrub bar */}
      <div
        className="h-6 bg-bg-secondary border-t border-b border-border cursor-pointer relative shrink-0"
        onClick={handleSeek}
        onMouseMove={handleScrubHover}
        onMouseLeave={handleScrubLeave}
      >
        {/* Sprite thumbnail on hover */}
        {hoveredTime != null && spritesIndex && (
          <SpriteTooltip
            time={hoveredTime}
            spritesIndex={spritesIndex}
            projectId={projectId}
          />
        )}

        {/* Generation progress bar */}
        {isGenerating && (
          <div
            className="absolute inset-y-0 left-0 bg-accent/20 transition-all duration-300"
            style={{ width: `${activeJob?.progress || 0}%` }}
          />
        )}

        {/* Playback progress */}
        <div
          className="absolute inset-y-0 left-0 bg-accent/30"
          style={{ width: `${progressPct}%` }}
        />

        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-accent"
          style={{ left: `${progressPct}%` }}
        />

        {/* Time display */}
        <div className="absolute inset-0 flex items-center justify-between px-2 pointer-events-none">
          <span className="text-xxs font-mono text-text-tertiary">
            {formatTime(currentTime)}
          </span>
          <span className="text-xxs font-mono text-text-tertiary">
            {formatTime(totalDuration)}
          </span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border bg-bg-secondary shrink-0">
        {/* Transport controls */}
        <div className="flex items-center gap-1">
          <ControlButton icon={SkipBack} onClick={handleSkipBack} title="Back 5s" />
          <ControlButton
            icon={playing ? Pause : Play}
            onClick={togglePlay}
            title={playing ? 'Pause' : 'Play'}
            accent
          />
          <ControlButton icon={SkipForward} onClick={handleSkipForward} title="Forward 5s" />
        </div>

        {/* Speed */}
        <button
          onClick={cycleSpeed}
          className="flex items-center gap-1 px-2 py-1 rounded text-xxs font-mono
                     text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          title="Playback speed"
        >
          <Gauge className="w-3 h-3" />
          {playbackSpeed}×
        </button>

        <div className="flex-1" />

        {/* Tier status badges */}
        <div className="flex items-center gap-1.5">
          <TierBadge label="KF" ready={activeJob?.keyframe_ready} />
          <TierBadge label="Sprites" ready={activeJob?.sprites_ready} />
          <TierBadge label="Audio" ready={activeJob?.audio_ready} />
          <TierBadge label="Proxy" ready={activeJob?.proxy_ready} />
        </div>

        {/* Generation controls */}
        {!activeJob || activeJob.state === 'idle' ? (
          <button
            onClick={handleInit}
            disabled={loading || !inputFile}
            className="flex items-center gap-1 px-2 py-1 rounded text-xxs font-medium
                       bg-accent text-white hover:bg-accent-hover transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className="w-3 h-3" />
            Generate
          </button>
        ) : isGenerating ? (
          <button
            onClick={handleCancel}
            className="flex items-center gap-1 px-2 py-1 rounded text-xxs font-medium
                       bg-danger/10 text-danger hover:bg-danger/20 transition-colors"
          >
            <Square className="w-3 h-3" />
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  )
}


// ── Helper components ──────────────────────────────────────────────────────

function ModeButton({ mode, label, icon: Icon, active, onClick }) {
  const isActive = active === mode
  return (
    <button
      onClick={() => onClick(mode)}
      className={`flex items-center gap-1 px-2 py-1 rounded text-xxs font-medium transition-colors
        ${isActive
          ? 'bg-accent/10 text-accent'
          : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
        }`}
      title={label}
    >
      <Icon className="w-3 h-3" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}


function ControlButton({ icon: Icon, onClick, title, accent = false }) {
  return (
    <button
      onClick={onClick}
      className={`p-1.5 rounded transition-colors
        ${accent
          ? 'bg-accent/10 text-accent hover:bg-accent/20'
          : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
        }`}
      title={title}
    >
      <Icon className="w-4 h-4" />
    </button>
  )
}


function TierBadge({ label, ready }) {
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-xxs font-medium
        ${ready
          ? 'bg-success/10 text-success'
          : 'bg-bg-primary text-text-disabled border border-border'
        }`}
      title={`${label}: ${ready ? 'Ready' : 'Pending'}`}
    >
      {label}
    </span>
  )
}


function GeneratingOverlay({ job }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 text-center p-8">
      <Loader2 className="w-8 h-8 text-accent animate-spin" />
      <div>
        <p className="text-sm font-medium text-text-primary">
          Generating Preview…
        </p>
        <p className="text-xs text-text-secondary mt-1">
          {job.current_tier === 'keyframes' && 'Building keyframe index…'}
          {job.current_tier === 'sprites' && 'Creating sprite sheet thumbnails…'}
          {job.current_tier === 'audio' && 'Extracting audio track…'}
          {job.current_tier === 'proxy' && 'Transcoding proxy video…'}
        </p>
        <div className="mt-3 w-48 h-1.5 bg-bg-secondary rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-300"
            style={{ width: `${job.progress || 0}%` }}
          />
        </div>
        <p className="text-xxs text-text-tertiary mt-1">
          {(job.progress || 0).toFixed(0)}%
          {job.elapsed > 0 && ` · ${formatTime(job.elapsed)}`}
        </p>
      </div>
    </div>
  )
}


function ErrorOverlay({ error, onRetry }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 text-center p-8">
      <XCircle className="w-8 h-8 text-danger" />
      <div>
        <p className="text-sm font-medium text-danger">Preview Error</p>
        <p className="text-xs text-text-secondary mt-1">{error}</p>
      </div>
      <button
        onClick={onRetry}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium
                   bg-bg-secondary text-text-primary hover:bg-bg-hover border border-border transition-colors"
      >
        <RefreshCw className="w-3.5 h-3.5" />
        Retry
      </button>
    </div>
  )
}


function InitOverlay({ onInit, loading, hasInputFile }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 text-center p-8">
      <Film className="w-8 h-8 text-text-tertiary" />
      <div>
        <p className="text-sm font-medium text-text-primary">
          No Preview Available
        </p>
        <p className="text-xs text-text-secondary mt-1">
          {hasInputFile
            ? 'Generate a preview to enable video playback and timeline scrubbing.'
            : 'Capture or import a video file first.'}
        </p>
      </div>
      {hasInputFile && (
        <button
          onClick={onInit}
          disabled={loading}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium
                     bg-accent text-white hover:bg-accent-hover transition-colors
                     disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Play className="w-3.5 h-3.5" />
          )}
          Generate Preview
        </button>
      )}
    </div>
  )
}


function SpriteTooltip({ time, spritesIndex, projectId }) {
  if (!spritesIndex?.sheets || spritesIndex.sheets.length === 0) return null

  const interval = spritesIndex.interval || 1
  const thumbIdx = Math.floor(time / interval)
  const cols = spritesIndex.cols || 10

  // Find the right sheet
  let sheetIdx = 0
  let thumbsPerSheet = 0
  for (let i = 0; i < spritesIndex.sheets.length; i++) {
    const sheet = spritesIndex.sheets[i]
    thumbsPerSheet = sheet.cols * sheet.rows
    if (thumbIdx < (i + 1) * thumbsPerSheet) {
      sheetIdx = i
      break
    }
  }

  const sheet = spritesIndex.sheets[sheetIdx]
  if (!sheet) return null

  const localIdx = thumbIdx - sheetIdx * (sheet.cols * sheet.rows)
  const col = localIdx % sheet.cols
  const row = Math.floor(localIdx / sheet.cols)
  const tw = sheet.thumb_width || 160
  const th = sheet.thumb_height || 90

  const bgX = -(col * tw)
  const bgY = -(row * th)

  return (
    <div
      className="absolute bottom-full mb-2 pointer-events-none z-50"
      style={{
        left: `${(time / (spritesIndex.sheets.reduce((a, s) => a + s.count, 0) * interval)) * 100}%`,
        transform: 'translateX(-50%)',
      }}
    >
      <div className="bg-bg-primary border border-border rounded shadow-lg overflow-hidden">
        <div
          style={{
            width: tw,
            height: th,
            backgroundImage: `url(/api/preview/sprite/${projectId}/${sheetIdx})`,
            backgroundPosition: `${bgX}px ${bgY}px`,
            backgroundSize: `${sheet.cols * tw}px ${sheet.rows * th}px`,
          }}
        />
        <div className="text-xxs text-text-tertiary text-center py-0.5 font-mono">
          {formatTime(time)}
        </div>
      </div>
    </div>
  )
}
