import { useState, memo } from 'react'
import {
  Loader2, AlertCircle, WifiOff, Eye, EyeOff, RefreshCw, Settings, Monitor, AlertTriangle, XCircle, BarChart3,
} from 'lucide-react'
import { H264StreamPlayer, HlsStreamPlayer } from './StreamPlayers'
import { EVENT_CONFIG, severityColorCard } from './analysisConstants'

/**
 * PreviewPlayer — the 16:9 preview stream area with overlays, badges,
 * quality settings dropdown, window picker, and particle event cards.
 */
export default memo(function PreviewPlayer({
  isConnected, isAnalyzing, isPlaying,
  streamFormat, streamKey, activeStreamUrl, streamUrl,
  streamLoaded, setStreamLoaded, streamError, setStreamError,
  streamResetting, handleStreamReset,
  streamVisible, setStreamVisible,
  sessionMatch,
  feedEvents,
  // Stream quality
  showQualitySettings, setShowQualitySettings,
  streamFps, setStreamFps,
  mjpegQuality, setMjpegQuality, mjpegMaxWidth, setMjpegMaxWidth,
  h264Crf, setH264Crf,
  streamHlsCrf, setStreamHlsCrf,
  setStreamKey,
  setStreamFormat,
  // Window picker
  showWindowPicker, setShowWindowPicker,
  captureTarget, windowList, loadingWindows,
  fetchWindows, selectWindow, resetToAuto,
  // Click handler
  onPlayPause,
  isPortrait,
}) {
  return (
    <div className={`flex items-center justify-center min-w-0 ${isPortrait ? 'shrink-0' : 'flex-1 min-h-0'}`}>
      <div className={`relative overflow-hidden bg-black ${isPortrait ? 'hidden' : ''}`}
           style={{ aspectRatio: '16/9', width: '100%', maxHeight: '100%', cursor: isConnected && !isAnalyzing ? 'pointer' : 'default' }}
           onClick={isConnected && !isAnalyzing ? onPlayPause : undefined}
           title={isAnalyzing ? 'Playback disabled during analysis' : isConnected ? (isPlaying ? 'Click to pause' : 'Click to play') : undefined}>
        {isConnected ? (
          <>
            {streamFormat === 'hls' ? (
              <HlsStreamPlayer
                key={streamKey}
                src={activeStreamUrl}
                className="w-full h-full object-cover"
                onLoad={() => setStreamLoaded(true)}
                onError={(err) => setStreamError(err?.message || 'HLS stream error')}
              />
            ) : streamFormat === 'h264' ? (
              <H264StreamPlayer
                key={streamKey}
                src={activeStreamUrl}
                className="w-full h-full object-cover"
                onLoad={() => setStreamLoaded(true)}
                onError={(err) => setStreamError(err?.message || 'H.264 stream error')}
              />
            ) : (
              <img
                key={streamKey}
                src={streamUrl}
                alt="iRacing replay"
                className="w-full h-full object-cover"
                onError={() => setStreamError('MJPEG stream failed to load')}
                onLoad={(e) => { e.target.style.opacity = '1'; setStreamLoaded(true) }}
              />
            )}
            {/* Error overlay */}
            {streamError && !streamResetting && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm gap-3">
                <AlertCircle size={32} className="text-danger" />
                <span className="text-xs text-white/80 font-medium">Stream Disconnected</span>
                <span className="text-xxs text-white/50 max-w-[200px] text-center">{streamError}</span>
                <button onClick={handleStreamReset}
                  className="mt-1 px-3 py-1 rounded-md text-xxs bg-accent/20 text-accent hover:bg-accent/30 border border-accent/30 transition-colors">
                  Retry
                </button>
              </div>
            )}
            {/* Loading overlay */}
            {(streamResetting || (!streamLoaded && !streamError)) && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm gap-3">
                <Loader2 size={32} className="text-accent animate-spin" />
                <span className="text-xs text-white/60">
                  {streamResetting ? 'Resetting stream…' : 'Connecting to stream…'}
                </span>
              </div>
            )}
            {/* Live badge */}
            {isAnalyzing && (
              <div className="absolute top-3 left-3 flex items-center gap-1.5 px-2 py-1 bg-black/70 backdrop-blur-sm rounded-md text-xxs text-white/90">
                <span className="w-1.5 h-1.5 rounded-full bg-danger animate-pulse" />
                LIVE
              </div>
            )}
            {/* Session match badge */}
            {!isAnalyzing && sessionMatch &&
             sessionMatch.status !== 'no_fingerprint' &&
             sessionMatch.status !== 'not_connected' &&
             sessionMatch.status !== 'match' && (
              <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
                <div className="flex items-center gap-2 px-5 py-3 bg-black/80 backdrop-blur-md rounded-xl border border-white/15 shadow-elevated pointer-events-auto"
                     title={sessionMatch.details}>
                  {sessionMatch.status === 'partial' ? (
                    <>
                      <AlertTriangle size={18} className="text-warning" />
                      <div className="flex flex-col">
                        <span className="text-warning text-sm font-bold">Partial Match</span>
                        <span className="text-white/50 text-xxs">Replay may not match this session</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <XCircle size={18} className="text-danger" />
                      <div className="flex flex-col">
                        <span className="text-danger text-sm font-bold">Wrong Replay</span>
                        <span className="text-white/50 text-xxs">Load the correct replay for this session</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <WifiOff size={32} className="text-text-disabled" />
            <span className="text-xs text-text-disabled font-medium">iRacing Not Running</span>
            <span className="text-xxs text-text-disabled text-center max-w-[220px]">
              Launch iRacing and load a replay to see the preview stream
            </span>
          </div>
        )}

        {/* Stream hidden overlay */}
        {!streamVisible && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-bg-secondary z-30 gap-3 pointer-events-none">
            <EyeOff size={28} className="text-text-disabled" />
            <span className="text-xs text-text-disabled font-medium">Preview hidden</span>
          </div>
        )}

        {/* Top-right controls */}
        <div className="absolute top-3 right-3 flex items-center gap-1.5 z-40" onClick={e => e.stopPropagation()}>
          <button onClick={() => setStreamVisible(v => !v)} title={streamVisible ? 'Hide preview' : 'Show preview'}
            className="flex items-center justify-center h-7 px-2 rounded-md text-xxs bg-black/70 backdrop-blur-sm text-white/70 hover:text-white border border-white/10 transition-colors">
            {streamVisible ? <Eye size={11} /> : <EyeOff size={11} />}
          </button>
          <button onClick={handleStreamReset} disabled={streamResetting} title={streamResetting ? 'Resetting…' : 'Hard-reset preview stream'}
            className="flex items-center justify-center h-7 px-2 rounded-md text-xxs bg-black/70 backdrop-blur-sm border border-white/10 transition-colors disabled:opacity-50 text-white/70 hover:text-white">
            <RefreshCw size={11} className={streamResetting ? 'animate-spin' : ''} />
          </button>
          <button onClick={() => setShowQualitySettings(prev => !prev)} title="Stream quality settings"
            className="flex items-center justify-center h-7 px-2 rounded-md text-xxs bg-black/70 backdrop-blur-sm text-white/70 hover:text-white border border-white/10 transition-colors">
            <Settings size={11} />
          </button>
          <button onClick={() => { setShowWindowPicker(prev => !prev); if (!showWindowPicker) fetchWindows() }}
            title={captureTarget.mode === 'manual' ? 'Manual capture target' : 'Auto-detecting iRacing'}
            className={`flex items-center gap-1 h-7 px-2 rounded-md text-xxs transition-colors
              ${captureTarget.mode === 'manual'
                ? 'bg-accent/20 text-accent border border-accent/30'
                : 'bg-black/70 backdrop-blur-sm text-white/70 hover:text-white border border-white/10'}`}>
            <Monitor size={11} />
            <span>{captureTarget.mode === 'manual' ? 'Manual' : 'Auto'}</span>
          </button>
        </div>

        {/* Quality settings dropdown */}
        {showQualitySettings && (
          <QualitySettingsDropdown
            streamFormat={streamFormat} setStreamFormat={setStreamFormat}
            streamFps={streamFps} setStreamFps={setStreamFps}
            mjpegQuality={mjpegQuality} setMjpegQuality={setMjpegQuality}
            mjpegMaxWidth={mjpegMaxWidth} setMjpegMaxWidth={setMjpegMaxWidth}
            h264Crf={h264Crf} setH264Crf={setH264Crf}
            streamHlsCrf={streamHlsCrf} setStreamHlsCrf={setStreamHlsCrf}
            setStreamKey={setStreamKey}
            setShowQualitySettings={setShowQualitySettings}
          />
        )}

        {/* Window picker dropdown */}
        {showWindowPicker && (
          <WindowPickerDropdown
            captureTarget={captureTarget} windowList={windowList}
            loadingWindows={loadingWindows} selectWindow={selectWindow}
            resetToAuto={resetToAuto}
          />
        )}

        {/* Particle event cards */}
        {feedEvents.length > 0 && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex flex-col-reverse items-center gap-1.5 pointer-events-none"
               style={{ maxHeight: 'calc(100% - 80px)' }}>
            {feedEvents.slice(-5).reverse().map((ev, i) => {
              const cfg = EVENT_CONFIG[ev.type] || {}
              const Icon = cfg.icon || BarChart3
              const names = ev.driverNames || []
              const ageOpacity = [1, 0.9, 0.7, 0.5, 0.3][i] ?? 0.3
              return (
                <div key={ev.id} onClick={e => e.stopPropagation()}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/80 backdrop-blur-md border border-white/15 text-xs animate-slide-up pointer-events-auto shadow-elevated"
                  style={{ opacity: ageOpacity }}>
                  <div className={`w-6 h-6 rounded-md flex items-center justify-center ${cfg.bg || 'bg-white/10'}`}>
                    <Icon size={13} className={cfg.color || 'text-white'} />
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="text-white font-semibold text-xs leading-tight">{cfg.label || ev.type}</span>
                    {names.length > 0 && (
                      <span className="text-white/60 truncate text-xxs max-w-[120px]">{names.join(' vs ')}</span>
                    )}
                  </div>
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center font-bold text-xxs ${severityColorCard(ev.severity)}`}>
                    {ev.severity}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
})


function QualitySettingsDropdown({
  streamFormat, setStreamFormat,
  streamFps, setStreamFps,
  mjpegQuality, setMjpegQuality, mjpegMaxWidth, setMjpegMaxWidth,
  h264Crf, setH264Crf,
  streamHlsCrf, setStreamHlsCrf,
  setStreamKey, setShowQualitySettings,
}) {
  return (
    <div className="absolute top-10 right-3 w-56 bg-bg-secondary border border-border rounded-lg shadow-xl z-20 animate-fade-in p-3"
         onClick={e => e.stopPropagation()}>
      <span className="text-xxs font-medium text-text-primary block mb-2">Stream Quality</span>
      <div className="flex items-center justify-between text-xxs text-text-secondary mb-2">
        <span className="font-medium">Format</span>
        <div className="flex rounded overflow-hidden border border-border">
          {['mjpeg', 'h264', 'hls'].map(fmt => (
            <button key={fmt}
              onClick={() => {
                if (fmt === streamFormat) return
                fetch('/api/iracing/stream/hls/stop', { method: 'POST' }).catch(() => {})
                setStreamFormat(fmt)
                setStreamKey(k => k + 1)
                setShowQualitySettings(false)
              }}
              className={`px-2 py-0.5 text-xxs transition-colors ${
                streamFormat === fmt ? 'bg-accent text-white' : 'bg-surface text-text-secondary hover:bg-bg-hover'
              }`}>
              {fmt === 'mjpeg' ? 'MJPEG' : fmt === 'h264' ? 'H.264' : 'HLS'}
            </button>
          ))}
        </div>
      </div>
      <div className="border-t border-border mb-2" />
      <div className="space-y-2">
        <label className="flex items-center justify-between text-xxs text-text-secondary">
          <span>FPS</span>
          <select value={streamFps} onChange={e => { setStreamFps(+e.target.value); setStreamKey(k => k + 1) }}
            className="bg-surface border border-border rounded px-1.5 py-0.5 text-xxs text-text-primary">
            {[5, 10, 15, 20, 30].map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        {streamFormat === 'h264' ? (
          <label className="flex items-center justify-between text-xxs text-text-secondary">
            <span>Quality (CRF)</span>
            <select value={h264Crf} onChange={e => { setH264Crf(+e.target.value); setStreamKey(k => k + 1) }}
              className="bg-surface border border-border rounded px-1.5 py-0.5 text-xxs text-text-primary">
              <option value={18}>Visually lossless (18)</option>
              <option value={23}>High (23)</option>
              <option value={28}>Medium (28)</option>
              <option value={33}>Low (33)</option>
            </select>
          </label>
        ) : streamFormat === 'hls' ? (
          <label className="flex items-center justify-between text-xxs text-text-secondary">
            <span>Quality (CRF)</span>
            <select value={streamHlsCrf} onChange={e => { setStreamHlsCrf(+e.target.value); setStreamKey(k => k + 1) }}
              className="bg-surface border border-border rounded px-1.5 py-0.5 text-xxs text-text-primary">
              <option value={18}>Visually lossless (18)</option>
              <option value={23}>High (23)</option>
              <option value={28}>Medium (28)</option>
              <option value={33}>Low (33)</option>
            </select>
          </label>
        ) : (
          <>
            <label className="flex items-center justify-between text-xxs text-text-secondary">
              <span>JPEG quality</span>
              <select value={mjpegQuality} onChange={e => { setMjpegQuality(+e.target.value); setStreamKey(k => k + 1) }}
                className="bg-surface border border-border rounded px-1.5 py-0.5 text-xxs text-text-primary">
                {[40, 55, 70, 85, 95, 100].map(v => (
                  <option key={v} value={v}>{v === 40 ? 'Low' : v === 55 ? 'Medium' : v === 70 ? 'High' : v === 85 ? 'Ultra' : v === 95 ? 'Max' : 'Lossless'} ({v})</option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between text-xxs text-text-secondary">
              <span>Max width</span>
              <select value={mjpegMaxWidth} onChange={e => { setMjpegMaxWidth(+e.target.value); setStreamKey(k => k + 1) }}
                className="bg-surface border border-border rounded px-1.5 py-0.5 text-xxs text-text-primary">
                {[640, 960, 1280, 1920, 2560, 3840].map(v => (
                  <option key={v} value={v}>{v}px{v === 3840 ? ' (4K)' : ''}</option>
                ))}
              </select>
            </label>
          </>
        )}
        {streamFormat === 'hls' && (
          <p className="text-xxs text-text-disabled leading-relaxed pt-0.5">
            HLS buffers ~1–3 s for smooth H.264 quality.
          </p>
        )}
      </div>
    </div>
  )
}


function WindowPickerDropdown({ captureTarget, windowList, loadingWindows, selectWindow, resetToAuto }) {
  return (
    <div className="absolute top-10 right-3 w-72 max-h-52 overflow-y-auto bg-bg-secondary border border-border rounded-lg shadow-xl z-20 animate-fade-in"
         onClick={e => e.stopPropagation()}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xxs font-medium text-text-primary">Capture Target</span>
        <button onClick={resetToAuto}
          className={`text-xxs px-2 py-0.5 rounded transition-colors ${
            captureTarget.mode === 'auto' ? 'text-accent bg-accent/10' : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
          }`}>
          Auto-detect
        </button>
      </div>
      {loadingWindows ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 size={14} className="animate-spin text-text-disabled" />
        </div>
      ) : windowList.length === 0 ? (
        <div className="px-3 py-3 text-xxs text-text-disabled text-center">No visible windows found</div>
      ) : (
        [...windowList].sort((a, b) => (b.is_iracing ? 1 : 0) - (a.is_iracing ? 1 : 0)).map((win, idx, sorted) => (
          <div key={win.hwnd}>
            {idx > 0 && !win.is_iracing && sorted[idx - 1]?.is_iracing && (
              <div className="px-3 py-1 text-xxs text-text-disabled border-b border-border bg-bg-secondary/50">Other Windows</div>
            )}
            <button onClick={() => selectWindow(win.hwnd)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xxs hover:bg-bg-hover transition-colors border-b border-border-subtle/30 last:border-0
                ${captureTarget.hwnd === win.hwnd ? 'bg-accent/10 text-accent' : 'text-text-secondary'}`}>
              <Monitor size={11} className={win.is_iracing ? 'text-accent' : 'text-text-disabled'} />
              <span className="truncate flex-1">{win.title}</span>
              {win.is_iracing && <span className="shrink-0 text-accent text-xxs font-medium">iRacing</span>}
            </button>
          </div>
        ))
      )}
    </div>
  )
}
