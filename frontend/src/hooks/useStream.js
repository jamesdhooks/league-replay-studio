import { useState, useEffect, useCallback } from 'react'
import { useLocalStorage } from './useLocalStorage'
import { apiPost, apiGet, apiDelete } from '../services/api'

/**
 * useStream — shared hook for the iRacing preview stream.
 *
 * Encapsulates ALL stream state: format/fps/quality settings (localStorage),
 * transient key/loaded/error/resetting, URL computation, window capture target,
 * and the stream-reset + window-picker handlers.
 *
 * Used by PreviewPlayer (analysis tab) and HighlightPreview (editing tab) so
 * both panels share settings and never duplicate this logic.
 */
export function useStream() {
  // ── Persistent settings ─────────────────────────────────────────────────
  const [streamFps,      setStreamFps]      = useLocalStorage('lrs:stream:fps',          15)
  const [streamFormat,   setStreamFormat]   = useLocalStorage('lrs:stream:format',       'mjpeg')
  const [mjpegQuality,   setMjpegQuality]   = useLocalStorage('lrs:stream:mjpegQuality', 85)
  const [mjpegMaxWidth,  setMjpegMaxWidth]  = useLocalStorage('lrs:stream:mjpegMaxWidth', 1280)
  const [h264Crf,        setH264Crf]        = useLocalStorage('lrs:stream:h264Crf',      23)
  const [h264MaxWidth,   setH264MaxWidth]   = useLocalStorage('lrs:stream:h264MaxWidth', 1280)
  const [streamHlsCrf,   setStreamHlsCrf]   = useLocalStorage('lrs:stream:hlsCrf',       23)

  // ── Transient state ─────────────────────────────────────────────────────
  const [streamKey,       setStreamKey]       = useState(0)
  const [streamLoaded,    setStreamLoaded]    = useState(false)
  const [streamError,     setStreamError]     = useState(null)
  const [streamResetting, setStreamResetting] = useState(false)

  // Reset loaded/error whenever the stream key changes (new stream started)
  useEffect(() => {
    setStreamLoaded(false)
    setStreamError(null)
  }, [streamKey])

  // ── Window capture target ───────────────────────────────────────────────
  const [captureTarget,   setCaptureTarget]   = useState({ mode: 'auto', hwnd: null })
  const [windowList,      setWindowList]      = useState([])
  const [loadingWindows,  setLoadingWindows]  = useState(false)

  const fetchWindows = useCallback(async () => {
    setLoadingWindows(true)
    try {
      const [windows, target] = await Promise.all([
        apiGet('/iracing/windows'),
        apiGet('/iracing/capture-target'),
      ])
      setWindowList(windows)
      setCaptureTarget(target)
    } catch {} finally {
      setLoadingWindows(false)
    }
  }, [])

  const selectWindow = useCallback(async (hwnd, onDone) => {
    try {
      await apiPost('/iracing/capture-target', { hwnd })
      setCaptureTarget({ mode: 'manual', hwnd })
      onDone?.()
    } catch {}
  }, [])

  const resetToAuto = useCallback(async (onDone) => {
    try {
      await apiDelete('/iracing/capture-target')
      setCaptureTarget({ mode: 'auto', hwnd: null })
      onDone?.()
    } catch {}
  }, [])

  // ── Stream reset ────────────────────────────────────────────────────────
  const handleStreamReset = useCallback(async () => {
    if (streamResetting) return
    setStreamResetting(true)
    setStreamLoaded(false)
    setStreamError(null)
    try {
      await apiPost('/iracing/stream/reset', {
        fps: streamFps,
        quality: mjpegQuality,
        max_width: mjpegMaxWidth,
      })
    } catch {
    } finally {
      setStreamKey(k => k + 1)
      setStreamResetting(false)
    }
  }, [streamResetting, streamFps, mjpegQuality, mjpegMaxWidth])

  // ── Derived URLs ────────────────────────────────────────────────────────
  const streamUrl       = `/api/iracing/stream?fps=${streamFps}&quality=${mjpegQuality}&max_width=${mjpegMaxWidth}&_k=${streamKey}`
  const h264Url         = `/api/iracing/stream/h264?fps=${streamFps}&crf=${h264Crf}&max_width=${h264MaxWidth}&_k=${streamKey}`
  const hlsUrl          = `/api/iracing/stream/hls/playlist.m3u8?fps=${streamFps}&crf=${streamHlsCrf}&max_width=${h264MaxWidth}&_k=${streamKey}`
  const activeStreamUrl = streamFormat === 'h264' ? h264Url : streamFormat === 'hls' ? hlsUrl : streamUrl

  return {
    // settings
    streamFps,      setStreamFps,
    streamFormat,   setStreamFormat,
    mjpegQuality,   setMjpegQuality,
    mjpegMaxWidth,  setMjpegMaxWidth,
    h264Crf,        setH264Crf,
    h264MaxWidth,   setH264MaxWidth,
    streamHlsCrf,   setStreamHlsCrf,
    // transient
    streamKey,      setStreamKey,
    streamLoaded,   setStreamLoaded,
    streamError,    setStreamError,
    streamResetting,
    // actions
    handleStreamReset,
    // URLs
    streamUrl, h264Url, hlsUrl, activeStreamUrl,
    // window picker
    captureTarget,
    windowList,
    loadingWindows,
    fetchWindows,
    selectWindow,
    resetToAuto,
  }
}
