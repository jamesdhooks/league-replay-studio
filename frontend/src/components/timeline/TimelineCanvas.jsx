import { useRef, useEffect, useCallback, useState } from 'react'
import { useTimeline, TRACKS, TRACK_HEADER_WIDTH, EVENT_COLORS } from '../../context/TimelineContext'

/** Height of the time ruler at top */
const RULER_HEIGHT = 24
/** Gap between tracks */
const TRACK_GAP = 1
/** Minimum drag distance to start drag (pixels) */
const DRAG_THRESHOLD = 3
/** Edge grab zone for resizing events (pixels) */
const EDGE_ZONE = 6

/**
 * TimelineCanvas — HTML5 Canvas-based multi-track timeline renderer.
 *
 * Draws:
 *  - Time ruler with ticks and labels
 *  - Track backgrounds with labels
 *  - Color-coded event blocks on the Events track
 *  - Playhead cursor
 *  - In/out point markers
 *  - Selection highlight
 *
 * Handles:
 *  - Mouse scroll → zoom
 *  - Middle-drag → pan
 *  - Click → seek playhead / select event
 *  - Drag event edges → resize
 *  - Right-click → context menu
 */
export default function TimelineCanvas() {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const [canvasWidth, setCanvasWidth] = useState(800)
  const [canvasHeight, setCanvasHeight] = useState(200)

  const {
    pixelsPerSecond, scrollLeft, raceDuration,
    handleZoomWheel, panBy, seekTo,
    playheadTime, events, selectedEventId, setSelectedEventId,
    inPoint, outPoint,
    openContextMenu, updateEvent, activeProjectId,
  } = useTimeline()

  // ── Interaction state (refs to avoid re-renders during drag) ───────────
  const dragRef = useRef({
    isDragging: false,
    type: null,         // 'pan' | 'playhead' | 'edge-start' | 'edge-end'
    startX: 0,
    startScrollLeft: 0,
    eventId: null,
    originalTime: 0,
  })

  // ── Track layout calculation ──────────────────────────────────────────
  const getTrackLayout = useCallback(() => {
    let y = RULER_HEIGHT
    return TRACKS.map(track => {
      const layout = { ...track, y, contentY: y }
      y += track.height + TRACK_GAP
      return layout
    })
  }, [])

  // ── Resize observer ───────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setCanvasWidth(Math.floor(width))
        setCanvasHeight(Math.floor(height))
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // ── Time ↔ Pixel conversions ──────────────────────────────────────────
  const timeToX = useCallback((timeSeconds) => {
    return TRACK_HEADER_WIDTH + (timeSeconds * pixelsPerSecond) - scrollLeft
  }, [pixelsPerSecond, scrollLeft])

  const xToTime = useCallback((x) => {
    return (x - TRACK_HEADER_WIDTH + scrollLeft) / pixelsPerSecond
  }, [pixelsPerSecond, scrollLeft])

  // ── Hit-test: find event at coordinates ───────────────────────────────
  const hitTestEvent = useCallback((x, y) => {
    const tracks = getTrackLayout()
    const eventsTrack = tracks.find(t => t.id === 'events')
    if (!eventsTrack) return null

    // Check if y is within the events track
    if (y < eventsTrack.y || y > eventsTrack.y + eventsTrack.height) return null

    // Check each event
    for (const evt of events) {
      const ex = timeToX(evt.start_time_seconds)
      const ew = (evt.end_time_seconds - evt.start_time_seconds) * pixelsPerSecond
      if (x >= ex && x <= ex + ew) {
        // Determine if near edge
        const isLeftEdge = x - ex < EDGE_ZONE
        const isRightEdge = (ex + ew) - x < EDGE_ZONE
        return { event: evt, edge: isLeftEdge ? 'start' : isRightEdge ? 'end' : null }
      }
    }
    return null
  }, [events, getTrackLayout, timeToX, pixelsPerSecond])

  // ── Canvas rendering ──────────────────────────────────────────────────
  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    canvas.width = canvasWidth * dpr
    canvas.height = canvasHeight * dpr
    ctx.scale(dpr, dpr)

    // Read theme colors from CSS custom properties
    const style = getComputedStyle(document.documentElement)
    const getColor = (name) => {
      const rgb = style.getPropertyValue(`--color-${name}`).trim()
      return rgb ? `rgb(${rgb})` : '#333'
    }
    const getColorAlpha = (name, alpha) => {
      const rgb = style.getPropertyValue(`--color-${name}`).trim()
      return rgb ? `rgba(${rgb}, ${alpha})` : `rgba(50,50,50,${alpha})`
    }

    const bgPrimary = getColor('bg-primary')
    const bgSecondary = getColor('bg-secondary')
    const bgTertiary = getColor('bg-tertiary')
    const borderColor = getColor('border')
    const borderSubtle = getColor('border-subtle')
    const textPrimary = getColor('text-primary')
    const textSecondary = getColor('text-secondary')
    const textTertiary = getColor('text-tertiary')
    const accentColor = getColor('accent')

    // ── Clear ──
    ctx.fillStyle = bgPrimary
    ctx.fillRect(0, 0, canvasWidth, canvasHeight)

    const tracks = getTrackLayout()
    const contentWidth = canvasWidth - TRACK_HEADER_WIDTH

    // ── Time ruler ──
    ctx.fillStyle = bgSecondary
    ctx.fillRect(0, 0, canvasWidth, RULER_HEIGHT)
    ctx.strokeStyle = borderColor
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, RULER_HEIGHT - 0.5)
    ctx.lineTo(canvasWidth, RULER_HEIGHT - 0.5)
    ctx.stroke()

    // Ruler ticks
    if (raceDuration > 0) {
      // Calculate tick interval based on zoom
      const minTickSpacing = 80 // minimum pixels between labels
      let tickInterval = 1
      const intervals = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
      for (const iv of intervals) {
        if (iv * pixelsPerSecond >= minTickSpacing) {
          tickInterval = iv
          break
        }
      }

      const startTime = Math.max(0, Math.floor(scrollLeft / pixelsPerSecond / tickInterval) * tickInterval)
      const endTime = Math.min(raceDuration, (scrollLeft + contentWidth) / pixelsPerSecond + tickInterval)

      ctx.font = '10px Inter, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'

      for (let t = startTime; t <= endTime; t += tickInterval) {
        const x = timeToX(t)
        if (x < TRACK_HEADER_WIDTH || x > canvasWidth) continue

        // Major tick
        ctx.strokeStyle = borderColor
        ctx.beginPath()
        ctx.moveTo(x + 0.5, RULER_HEIGHT - 8)
        ctx.lineTo(x + 0.5, RULER_HEIGHT)
        ctx.stroke()

        // Label
        const mins = Math.floor(t / 60)
        const secs = Math.floor(t % 60)
        const label = `${mins}:${String(secs).padStart(2, '0')}`
        ctx.fillStyle = textSecondary
        ctx.fillText(label, x, RULER_HEIGHT / 2)

        // Minor ticks (subdivide)
        const minorInterval = tickInterval / 4
        if (minorInterval * pixelsPerSecond >= 8) {
          for (let mt = t + minorInterval; mt < t + tickInterval && mt <= endTime; mt += minorInterval) {
            const mx = timeToX(mt)
            if (mx < TRACK_HEADER_WIDTH || mx > canvasWidth) continue
            ctx.strokeStyle = borderSubtle
            ctx.beginPath()
            ctx.moveTo(mx + 0.5, RULER_HEIGHT - 4)
            ctx.lineTo(mx + 0.5, RULER_HEIGHT)
            ctx.stroke()
          }
        }
      }
    }

    // ── Track backgrounds and labels ──
    ctx.font = '10px Inter, system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'

    for (const track of tracks) {
      // Track background
      ctx.fillStyle = track.id === 'events' ? bgTertiary : bgSecondary
      ctx.fillRect(TRACK_HEADER_WIDTH, track.y, contentWidth, track.height)

      // Track header
      ctx.fillStyle = bgSecondary
      ctx.fillRect(0, track.y, TRACK_HEADER_WIDTH, track.height)

      // Header border
      ctx.strokeStyle = borderColor
      ctx.beginPath()
      ctx.moveTo(TRACK_HEADER_WIDTH - 0.5, track.y)
      ctx.lineTo(TRACK_HEADER_WIDTH - 0.5, track.y + track.height)
      ctx.stroke()

      // Track label
      ctx.fillStyle = textTertiary
      ctx.fillText(track.label, TRACK_HEADER_WIDTH - 8, track.y + track.height / 2)

      // Bottom border
      ctx.strokeStyle = borderSubtle
      ctx.beginPath()
      ctx.moveTo(0, track.y + track.height + 0.5)
      ctx.lineTo(canvasWidth, track.y + track.height + 0.5)
      ctx.stroke()
    }

    // ── Event blocks (on Events track) ──
    const eventsTrack = tracks.find(t => t.id === 'events')
    if (eventsTrack && events.length > 0) {
      const padding = 3
      const blockY = eventsTrack.y + padding
      const blockH = eventsTrack.height - padding * 2

      for (const evt of events) {
        const ex = timeToX(evt.start_time_seconds)
        const ew = Math.max(2, (evt.end_time_seconds - evt.start_time_seconds) * pixelsPerSecond)

        // Skip events off-screen
        if (ex + ew < TRACK_HEADER_WIDTH || ex > canvasWidth) continue

        // Clip to content area
        const clipX = Math.max(TRACK_HEADER_WIDTH, ex)
        const clipW = Math.min(ex + ew, canvasWidth) - clipX
        if (clipW <= 0) continue

        const color = EVENT_COLORS[evt.event_type] || '#666'
        const isSelected = evt.id === selectedEventId

        // Event block
        ctx.fillStyle = color
        ctx.globalAlpha = isSelected ? 1.0 : 0.75
        const radius = 3
        roundRect(ctx, clipX, blockY, clipW, blockH, radius)
        ctx.fill()

        // Selected highlight
        if (isSelected) {
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 2
          roundRect(ctx, clipX, blockY, clipW, blockH, radius)
          ctx.stroke()
          ctx.lineWidth = 1
        }

        ctx.globalAlpha = 1.0

        // Event label (if wide enough)
        if (clipW > 40) {
          const EVENT_LABELS = {
            incident: 'INC', battle: 'BTL', overtake: 'OVT', pit_stop: 'PIT',
            fastest_lap: 'FL', leader_change: 'LC', first_lap: '1st', last_lap: 'Last',
          }
          ctx.font = 'bold 9px Inter, system-ui, sans-serif'
          ctx.textAlign = 'left'
          ctx.textBaseline = 'middle'
          ctx.fillStyle = '#fff'
          ctx.fillText(
            EVENT_LABELS[evt.event_type] || evt.event_type.substring(0, 3).toUpperCase(),
            clipX + 4,
            blockY + blockH / 2
          )
        }
      }
    }

    // ── In/Out point markers ──
    if (inPoint !== null) {
      const ix = timeToX(inPoint)
      if (ix >= TRACK_HEADER_WIDTH && ix <= canvasWidth) {
        ctx.strokeStyle = '#22c55e'
        ctx.lineWidth = 2
        ctx.setLineDash([4, 2])
        ctx.beginPath()
        ctx.moveTo(ix, RULER_HEIGHT)
        ctx.lineTo(ix, canvasHeight)
        ctx.stroke()
        ctx.setLineDash([])

        // Label
        ctx.fillStyle = '#22c55e'
        ctx.font = 'bold 9px Inter, system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('IN', ix, RULER_HEIGHT + 8)
      }
    }

    if (outPoint !== null) {
      const ox = timeToX(outPoint)
      if (ox >= TRACK_HEADER_WIDTH && ox <= canvasWidth) {
        ctx.strokeStyle = '#ef4444'
        ctx.lineWidth = 2
        ctx.setLineDash([4, 2])
        ctx.beginPath()
        ctx.moveTo(ox, RULER_HEIGHT)
        ctx.lineTo(ox, canvasHeight)
        ctx.stroke()
        ctx.setLineDash([])

        ctx.fillStyle = '#ef4444'
        ctx.font = 'bold 9px Inter, system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('OUT', ox, RULER_HEIGHT + 8)
      }
    }

    // ── Playhead cursor ──
    const phX = timeToX(playheadTime)
    if (phX >= TRACK_HEADER_WIDTH && phX <= canvasWidth) {
      // Line
      ctx.strokeStyle = accentColor
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(phX, 0)
      ctx.lineTo(phX, canvasHeight)
      ctx.stroke()

      // Triangle head on ruler
      ctx.fillStyle = accentColor
      ctx.beginPath()
      ctx.moveTo(phX - 5, 0)
      ctx.lineTo(phX + 5, 0)
      ctx.lineTo(phX, 8)
      ctx.closePath()
      ctx.fill()
    }
  }, [
    canvasWidth, canvasHeight, pixelsPerSecond, scrollLeft, raceDuration,
    events, playheadTime, selectedEventId, inPoint, outPoint,
    timeToX, getTrackLayout,
  ])

  // ── Render on state change ────────────────────────────────────────────
  useEffect(() => {
    requestAnimationFrame(render)
  }, [render])

  // ── Mouse event handlers ──────────────────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    // Middle button → pan
    if (e.button === 1) {
      e.preventDefault()
      dragRef.current = {
        isDragging: true,
        type: 'pan',
        startX: e.clientX,
        startScrollLeft: scrollLeft,
        eventId: null,
        originalTime: 0,
      }
      return
    }

    // Right button → context menu
    if (e.button === 2) {
      return // handled by onContextMenu
    }

    // Left button
    if (e.button === 0) {
      // Check for event hit
      const hit = hitTestEvent(x, y)
      if (hit) {
        setSelectedEventId(hit.event.id)
        if (hit.edge) {
          // Start edge drag
          dragRef.current = {
            isDragging: true,
            type: hit.edge === 'start' ? 'edge-start' : 'edge-end',
            startX: x,
            startScrollLeft: scrollLeft,
            eventId: hit.event.id,
            originalTime: hit.edge === 'start'
              ? hit.event.start_time_seconds
              : hit.event.end_time_seconds,
          }
          return
        }
      } else {
        setSelectedEventId(null)
      }

      // Click on ruler or empty area → seek playhead
      if (x >= TRACK_HEADER_WIDTH) {
        const time = xToTime(x)
        seekTo(time)
        dragRef.current = {
          isDragging: true,
          type: 'playhead',
          startX: x,
          startScrollLeft: scrollLeft,
          eventId: null,
          originalTime: time,
        }
      }
    }
  }, [scrollLeft, hitTestEvent, setSelectedEventId, seekTo, xToTime])

  const handleMouseMove = useCallback((e) => {
    const drag = dragRef.current
    if (!drag.isDragging) {
      // Update cursor for edge detection
      const rect = canvasRef.current.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const hit = hitTestEvent(x, y)
      if (hit && hit.edge) {
        canvasRef.current.style.cursor = 'col-resize'
      } else if (hit) {
        canvasRef.current.style.cursor = 'pointer'
      } else {
        canvasRef.current.style.cursor = 'default'
      }
      return
    }

    if (drag.type === 'pan') {
      const deltaX = drag.startX - e.clientX
      panBy(deltaX - (scrollLeft - drag.startScrollLeft))
    } else if (drag.type === 'playhead') {
      const rect = canvasRef.current.getBoundingClientRect()
      const x = e.clientX - rect.left
      seekTo(xToTime(x))
    } else if (drag.type === 'edge-start' || drag.type === 'edge-end') {
      const rect = canvasRef.current.getBoundingClientRect()
      const x = e.clientX - rect.left
      const newTime = Math.max(0, xToTime(x))

      // Find the event and update its time locally for visual feedback
      // (actual API call happens on mouseup)
      const evt = events.find(e => e.id === drag.eventId)
      if (evt) {
        if (drag.type === 'edge-start') {
          evt.start_time_seconds = Math.min(newTime, evt.end_time_seconds - 0.1)
        } else {
          evt.end_time_seconds = Math.max(newTime, evt.start_time_seconds + 0.1)
        }
        requestAnimationFrame(render)
      }
    }
  }, [hitTestEvent, panBy, scrollLeft, seekTo, xToTime, events, render])

  const handleMouseUp = useCallback((e) => {
    const drag = dragRef.current
    if (drag.isDragging && (drag.type === 'edge-start' || drag.type === 'edge-end')) {
      // Commit the edge drag to the API
      const evt = events.find(ev => ev.id === drag.eventId)
      if (evt) {
        const rect = canvasRef.current.getBoundingClientRect()
        const x = e.clientX - rect.left
        const newTime = Math.max(0, xToTime(x))
        const updates = drag.type === 'edge-start'
          ? { start_time_seconds: Math.min(newTime, evt.end_time_seconds - 0.1) }
          : { end_time_seconds: Math.max(newTime, evt.start_time_seconds + 0.1) }

        // Get project ID from the event list URL pattern
        // We'll call updateEvent from the Timeline parent since we need project ID
        if (activeProjectId) {
          updateEvent(activeProjectId, drag.eventId, updates)
        }
      }
    }
    dragRef.current = { isDragging: false, type: null, startX: 0, startScrollLeft: 0, eventId: null, originalTime: 0 }
  }, [events, xToTime, updateEvent])

  // ── Wheel → zoom ─────────────────────────────────────────────────────
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const rect = canvasRef.current.getBoundingClientRect()
    const mouseX = e.clientX - rect.left - TRACK_HEADER_WIDTH
    handleZoomWheel(e.deltaY, mouseX, canvasWidth - TRACK_HEADER_WIDTH)
  }, [handleZoomWheel, canvasWidth])

  // ── Context menu (right-click) ────────────────────────────────────────
  const handleContextMenu = useCallback((e) => {
    e.preventDefault()
    const rect = canvasRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const time = xToTime(x)

    const hit = hitTestEvent(x, y)
    openContextMenu(e.clientX, e.clientY, hit?.event?.id || null, time)
  }, [xToTime, hitTestEvent, openContextMenu])

  // ── Prevent default middle-click scroll ───────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const prevent = (e) => { if (e.button === 1) e.preventDefault() }
    canvas.addEventListener('mousedown', prevent, { passive: false })
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      canvas.removeEventListener('mousedown', prevent)
      canvas.removeEventListener('wheel', handleWheel)
    }
  }, [handleWheel])

  return (
    <div ref={containerRef} className="flex-1 relative overflow-hidden">
      <canvas
        ref={canvasRef}
        width={canvasWidth}
        height={canvasHeight}
        style={{ width: canvasWidth, height: canvasHeight }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onContextMenu={handleContextMenu}
        className="block"
      />
    </div>
  )
}

/** Helper: draw a rounded rectangle path */
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
