import { useEffect, useRef } from 'react'
import Hls from 'hls.js'

/**
 * H264StreamPlayer — MSE-based H.264 fMP4 live stream player.
 */
export function H264StreamPlayer({ src, className, onLoad, onError }) {
  const videoRef = useRef(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return
    if (!window.MediaSource) {
      onError?.(new Error('MediaSource not supported in this browser'))
      return
    }

    const controller = new AbortController()
    const queue = []
    let sb = null
    let ms = null

    const CODEC = [
      'video/mp4; codecs="avc1.640028"',
      'video/mp4; codecs="avc1.4D4028"',
      'video/mp4; codecs="avc1.42E028"',
    ].find(c => MediaSource.isTypeSupported(c)) ?? 'video/mp4; codecs="avc1.42E028"'

    ms = new MediaSource()
    const blobUrl = URL.createObjectURL(ms)
    video.src = blobUrl

    const flush = () => {
      if (!sb || sb.updating || !queue.length) return
      try { sb.appendBuffer(queue.shift()) } catch {}
    }

    ms.addEventListener('sourceopen', async () => {
      if (controller.signal.aborted) return
      try {
        sb = ms.addSourceBuffer(CODEC)
        sb.mode = 'sequence'
        let played = false
        sb.addEventListener('updateend', () => {
          if (!played && sb && sb.buffered.length > 0) {
            played = true
            video.play().catch(() => {})
            onLoad?.()
          }
          if (sb && sb.buffered.length > 0 && !sb.updating) {
            const t = video.currentTime
            const s = sb.buffered.start(0)
            if (t - s > 8) {
              try { sb.remove(s, Math.max(s + 0.1, t - 4)) } catch {}
              return
            }
          }
          flush()
        })

        const resp = await fetch(src, { signal: controller.signal })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const reader = resp.body.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            queue.push(value)
            flush()
          }
        } catch (e) {
          if (e?.name !== 'AbortError') throw e
        } finally {
          reader.cancel()
        }
      } catch (e) {
        if (e?.name !== 'AbortError' && !controller.signal.aborted) onError?.(e)
      }
    })

    return () => {
      controller.abort()
      try { video.pause() } catch {}
      video.removeAttribute('src')
      video.load()
      try {
        if (ms && ms.readyState === 'open') {
          if (sb) ms.removeSourceBuffer(sb)
          ms.endOfStream()
        }
      } catch {}
      try { URL.revokeObjectURL(blobUrl) } catch {}
      sb = null
      ms = null
    }
  }, [src])

  return (
    <video
      ref={videoRef}
      className={className}
      style={{ pointerEvents: 'none' }}
      autoPlay muted playsInline
    />
  )
}

/**
 * HlsStreamPlayer — HLS live stream player.
 */
export function HlsStreamPlayer({ src, className, onLoad, onError }) {
  const videoRef = useRef(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return
    let alive = true

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src
      const handleLoadedMetadata = () => { if (alive) { video.play().catch(() => {}); onLoad?.() } }
      const handleError = () => { if (alive) onError?.(new Error('HLS stream error')) }
      video.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true })
      video.addEventListener('error', handleError, { once: true })
      return () => {
        alive = false
        video.removeEventListener('loadedmetadata', handleLoadedMetadata)
        video.removeEventListener('error', handleError)
        video.removeAttribute('src')
        video.load()
      }
    }

    if (!Hls.isSupported()) {
      onError?.(new Error('HLS is not supported in this browser'))
      return
    }

    const hls = new Hls({
      lowLatencyMode: false,
      maxBufferLength: 4,
      maxMaxBufferLength: 8,
    })
    hls.loadSource(src)
    hls.attachMedia(video)
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (!alive) return
      video.play().catch(() => {})
      onLoad?.()
    })
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal && alive) onError?.(new Error(data.details || 'HLS playback error'))
    })

    return () => {
      alive = false
      hls.destroy()
      video.removeAttribute('src')
      video.load()
      fetch('/api/iracing/stream/hls/stop', { method: 'POST' }).catch(() => {})
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  return (
    <video
      ref={videoRef}
      className={className}
      style={{ pointerEvents: 'none' }}
      autoPlay muted playsInline
    />
  )
}
