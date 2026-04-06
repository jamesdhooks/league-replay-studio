import { createContext, useContext, useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { apiGet, apiPut, apiPost, apiDelete } from '../services/api'
import { useAnalysis } from './AnalysisContext'
import { useUndoRedo } from './UndoRedoContext'

const TimelineContext = createContext(null)

/**
 * Track definitions for the multi-track timeline.
 * Each track displays a different category of data.
 */
export const TRACKS = [
  { id: 'camera',   label: 'Camera',   height: 36 },
  { id: 'events',   label: 'Events',   height: 48 },
  { id: 'overlays', label: 'Overlays', height: 36 },
  { id: 'cuts',     label: 'Cuts',     height: 28 },
  { id: 'audio',    label: 'Audio',    height: 28 },
]

/** Total height of all track headers + gaps */
export const TRACK_HEADER_WIDTH = 72

/** Event type color map (hex values matching tailwind event-* tokens) */
export const EVENT_COLORS = {
  incident:      '#ef4444',
  battle:        '#f97316',
  overtake:      '#3b82f6',
  pit_stop:      '#8b5cf6',
  fastest_lap:   '#22c55e',
  leader_change: '#eab308',
  first_lap:     '#06b6d4',
  last_lap:      '#ec4899',
  crash:         '#ef4444',
  spinout:       '#f97316',
  contact:       '#3b82f6',
  close_call:    '#22c55e',
  undercut:      '#8b5cf6',
  overcut:       '#8b5cf6',
  pit_battle:    '#f97316',
}

/**
 * TimelineProvider — manages timeline state.
 *
 * Provides zoom/scroll, playhead position, track configuration,
 * event selection, in/out points, and shuttle controls.
 */
export function TimelineProvider({ children }) {
  // ── Zoom / Scroll state ─────────────────────────────────────────────────
  // pixelsPerSecond controls zoom level: low = overview, high = frame-detail
  const [pixelsPerSecond, setPixelsPerSecond] = useState(5)   // 1px = 0.2s initially
  const [scrollLeft, setScrollLeft] = useState(0)             // horizontal scroll offset in px
  const [raceDuration, setRaceDuration] = useState(0)         // total race time in seconds
  const [totalFrames, setTotalFrames] = useState(0)           // total replay frames

  // ── Active project tracking ─────────────────────────────────────────────
  const [activeProjectId, setActiveProjectId] = useState(null)

  // ── Playhead ────────────────────────────────────────────────────────────
  const [playheadTime, setPlayheadTime] = useState(0)         // seconds
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)          // -2, -1, 0, 1, 2, 4, 8, 16
  const playIntervalRef = useRef(null)

  // ── Selection ───────────────────────────────────────────────────────────
  const [selectedEventId, setSelectedEventId] = useState(null)

  // ── In/Out points ──────────────────────────────────────────────────────
  const [inPoint, setInPoint] = useState(null)                 // seconds or null
  const [outPoint, setOutPoint] = useState(null)               // seconds or null

  // ── Context menu ───────────────────────────────────────────────────────
  const [contextMenu, setContextMenu] = useState(null)         // { x, y, eventId, time }

  // ── Get analysis events ────────────────────────────────────────────────
  const { events, fetchEvents } = useAnalysis()
  const { pushAction } = useUndoRedo()

  // Helper: fetch a single event snapshot for undo tracking
  const getEventSnapshot = useCallback((eventId) => {
    const evt = events.find(e => e.id === eventId)
    if (!evt) return null
    return { ...evt }
  }, [events])

  // ── Load race duration ─────────────────────────────────────────────────
  const loadRaceDuration = useCallback(async (projectId) => {
    try {
      const result = await apiGet(`/projects/${projectId}/analysis/race-duration`)
      setRaceDuration(result.duration_seconds || 0)
      setTotalFrames(result.total_frames || 0)
    } catch (err) {
      console.error('[Timeline] Failed to load race duration:', err)
    }
  }, [])

  // ── Zoom ───────────────────────────────────────────────────────────────
  const zoomIn = useCallback(() => {
    setPixelsPerSecond(prev => Math.min(prev * 1.5, 60))  // max ~1px per frame at 60fps
  }, [])

  const zoomOut = useCallback(() => {
    setPixelsPerSecond(prev => Math.max(prev / 1.5, 0.2)) // min: very zoomed out
  }, [])

  const zoomToFit = useCallback(() => {
    // Will be calculated based on container width by the canvas component
    if (raceDuration > 0) {
      setPixelsPerSecond(1) // sensible default; canvas overrides on mount
    }
  }, [raceDuration])

  const handleZoomWheel = useCallback((deltaY, mouseX, containerWidth) => {
    setPixelsPerSecond(prev => {
      const factor = deltaY < 0 ? 1.15 : 1 / 1.15
      const next = Math.max(0.2, Math.min(60, prev * factor))

      // Keep the time under the mouse cursor stable
      const timeAtMouse = (scrollLeft + mouseX) / prev
      const newScrollLeft = timeAtMouse * next - mouseX
      setScrollLeft(Math.max(0, newScrollLeft))

      return next
    })
  }, [scrollLeft])

  // ── Pan ────────────────────────────────────────────────────────────────
  const panBy = useCallback((deltaX) => {
    setScrollLeft(prev => Math.max(0, prev + deltaX))
  }, [])

  // ── Playhead ──────────────────────────────────────────────────────────
  const seekTo = useCallback((timeSeconds) => {
    setPlayheadTime(Math.max(0, Math.min(timeSeconds, raceDuration)))
  }, [raceDuration])

  // ── Shuttle controls (J/K/L) ──────────────────────────────────────────
  const shuttleReverse = useCallback(() => {
    setPlaybackRate(prev => {
      if (prev > 0) return -1
      return Math.max(-16, prev * 2)
    })
    setIsPlaying(true)
  }, [])

  const shuttleStop = useCallback(() => {
    setIsPlaying(false)
    setPlaybackRate(1)
  }, [])

  const shuttleForward = useCallback(() => {
    setPlaybackRate(prev => {
      if (prev < 0) return 1
      return Math.min(16, prev * 2)
    })
    setIsPlaying(true)
  }, [])

  // ── Playback timer ────────────────────────────────────────────────────
  useEffect(() => {
    if (isPlaying && playbackRate !== 0) {
      const interval = 1000 / 30 // 30 fps update rate
      playIntervalRef.current = setInterval(() => {
        setPlayheadTime(prev => {
          const next = prev + (playbackRate * interval / 1000)
          if (next >= raceDuration) {
            setIsPlaying(false)
            return raceDuration
          }
          if (next <= 0) {
            setIsPlaying(false)
            return 0
          }
          return next
        })
      }, interval)
    }
    return () => {
      if (playIntervalRef.current) {
        clearInterval(playIntervalRef.current)
        playIntervalRef.current = null
      }
    }
  }, [isPlaying, playbackRate, raceDuration])

  // ── In/Out points ─────────────────────────────────────────────────────
  const setInPointAtPlayhead = useCallback(() => {
    setInPoint(playheadTime)
  }, [playheadTime])

  const setOutPointAtPlayhead = useCallback(() => {
    setOutPoint(playheadTime)
  }, [playheadTime])

  const clearInOutPoints = useCallback(() => {
    setInPoint(null)
    setOutPoint(null)
  }, [])

  // ── Event editing (with undo/redo tracking) ────────────────────────────

  // Raw update (no undo tracking, used by undo/redo callbacks)
  const _rawUpdateEvent = useCallback(async (projectId, eventId, updates) => {
    const result = await apiPut(`/projects/${projectId}/events/${eventId}`, updates)
    await fetchEvents(projectId, { limit: 1000 })
    return result
  }, [fetchEvents])

  const updateEvent = useCallback(async (projectId, eventId, updates) => {
    try {
      // Capture previous state for undo
      const oldEvent = getEventSnapshot(eventId)
      if (!oldEvent) throw new Error('Event not found locally')

      const oldValues = {}
      for (const key of Object.keys(updates)) {
        oldValues[key] = oldEvent[key]
      }

      const result = await _rawUpdateEvent(projectId, eventId, updates)

      // Build description
      const fields = Object.keys(updates)
      const desc = fields.length === 1 && fields[0] === 'severity'
        ? `Changed severity ${oldValues.severity} → ${updates.severity}`
        : fields.length === 1 && fields[0] === 'event_type'
          ? `Changed type to ${updates.event_type}`
          : `Updated event #${eventId}`

      pushAction({
        type: 'event_update',
        description: desc,
        undo: async () => { await _rawUpdateEvent(projectId, eventId, oldValues) },
        redo: async () => { await _rawUpdateEvent(projectId, eventId, updates) },
      })

      return result
    } catch (err) {
      console.error('[Timeline] Event update error:', err)
      throw err
    }
  }, [fetchEvents, getEventSnapshot, pushAction, _rawUpdateEvent])

  const deleteEvent = useCallback(async (projectId, eventId) => {
    try {
      // Capture full event state before deleting
      const oldEvent = getEventSnapshot(eventId)
      if (!oldEvent) throw new Error('Event not found locally')

      const result = await apiDelete(`/projects/${projectId}/events/${eventId}`)
      setSelectedEventId(null)
      await fetchEvents(projectId, { limit: 1000 })

      // Track the recreated event ID for redo
      let recreatedId = null

      pushAction({
        type: 'event_delete',
        description: `Deleted ${oldEvent.event_type} event`,
        undo: async () => {
          // Re-create the event via POST endpoint
          const created = await apiPost(`/projects/${projectId}/events`, {
            event_type: oldEvent.event_type,
            start_time_seconds: oldEvent.start_time_seconds,
            end_time_seconds: oldEvent.end_time_seconds,
            start_frame: oldEvent.start_frame,
            end_frame: oldEvent.end_frame,
            lap_number: oldEvent.lap_number || 0,
            severity: oldEvent.severity,
            involved_drivers: oldEvent.involved_drivers || [],
            position: oldEvent.position || 0,
            included_in_highlight: !!oldEvent.included_in_highlight,
            metadata: oldEvent.metadata || {},
          })
          recreatedId = created.id
          await fetchEvents(projectId, { limit: 1000 })
        },
        redo: async () => {
          // Delete the recreated event by its stored ID
          if (recreatedId) {
            await apiDelete(`/projects/${projectId}/events/${recreatedId}`)
            recreatedId = null
          }
          setSelectedEventId(null)
          await fetchEvents(projectId, { limit: 1000 })
        },
      })

      return result
    } catch (err) {
      console.error('[Timeline] Event delete error:', err)
      throw err
    }
  }, [fetchEvents, getEventSnapshot, pushAction])

  const splitEvent = useCallback(async (projectId, eventId, splitTime) => {
    try {
      // Capture original event before split
      const oldEvent = getEventSnapshot(eventId)
      if (!oldEvent) throw new Error('Event not found locally')

      const result = await apiPost(`/projects/${projectId}/events/${eventId}/split`, {
        split_time: splitTime,
      })
      await fetchEvents(projectId, { limit: 1000 })

      const newEventId = result.new_id

      pushAction({
        type: 'event_split',
        description: `Split ${oldEvent.event_type} event`,
        undo: async () => {
          // Delete the new event and restore original end time
          await apiDelete(`/projects/${projectId}/events/${newEventId}`)
          await apiPut(`/projects/${projectId}/events/${eventId}`, {
            end_time_seconds: oldEvent.end_time_seconds,
            end_frame: oldEvent.end_frame,
          })
          await fetchEvents(projectId, { limit: 1000 })
        },
        redo: async () => {
          await apiPost(`/projects/${projectId}/events/${eventId}/split`, {
            split_time: splitTime,
          })
          await fetchEvents(projectId, { limit: 1000 })
        },
      })

      return result
    } catch (err) {
      console.error('[Timeline] Event split error:', err)
      throw err
    }
  }, [fetchEvents, getEventSnapshot, pushAction])

  // ── Context menu ──────────────────────────────────────────────────────
  const openContextMenu = useCallback((x, y, eventId, time) => {
    setContextMenu({ x, y, eventId, time })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  const handleKeyDown = useCallback((e) => {
    // Don't capture when typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return

    switch (e.key.toLowerCase()) {
      case 'j':
        e.preventDefault()
        shuttleReverse()
        break
      case 'k':
        e.preventDefault()
        shuttleStop()
        break
      case 'l':
        e.preventDefault()
        shuttleForward()
        break
      case 'i':
        e.preventDefault()
        setInPointAtPlayhead()
        break
      case 'o':
        e.preventDefault()
        setOutPointAtPlayhead()
        break
      case ' ':
        e.preventDefault()
        setIsPlaying(prev => !prev)
        break
      default:
        break
    }
  }, [shuttleReverse, shuttleStop, shuttleForward, setInPointAtPlayhead, setOutPointAtPlayhead])

  // ── Context value ─────────────────────────────────────────────────────
  const value = useMemo(() => ({
    // Zoom & scroll
    pixelsPerSecond,
    scrollLeft,
    raceDuration,
    totalFrames,
    setPixelsPerSecond,
    setScrollLeft,
    loadRaceDuration,
    zoomIn,
    zoomOut,
    zoomToFit,
    handleZoomWheel,
    panBy,

    // Playhead
    playheadTime,
    isPlaying,
    playbackRate,
    seekTo,
    setIsPlaying,

    // Shuttle
    shuttleReverse,
    shuttleStop,
    shuttleForward,

    // Selection
    selectedEventId,
    setSelectedEventId,

    // In/Out points
    inPoint,
    outPoint,
    setInPointAtPlayhead,
    setOutPointAtPlayhead,
    clearInOutPoints,

    // Context menu
    contextMenu,
    openContextMenu,
    closeContextMenu,

    // Event editing
    updateEvent,
    deleteEvent,
    splitEvent,

    // Active project
    activeProjectId,
    setActiveProjectId,

    // Keyboard
    handleKeyDown,

    // Events (from AnalysisContext)
    events,
  }), [
    pixelsPerSecond, scrollLeft, raceDuration, totalFrames, loadRaceDuration,
    zoomIn, zoomOut, zoomToFit, handleZoomWheel, panBy,
    playheadTime, isPlaying, playbackRate, seekTo,
    shuttleReverse, shuttleStop, shuttleForward,
    selectedEventId, inPoint, outPoint,
    setInPointAtPlayhead, setOutPointAtPlayhead, clearInOutPoints,
    contextMenu, openContextMenu, closeContextMenu,
    updateEvent, deleteEvent, splitEvent, activeProjectId, handleKeyDown, events,
  ])

  return (
    <TimelineContext.Provider value={value}>
      {children}
    </TimelineContext.Provider>
  )
}

/**
 * Hook to access timeline state and methods.
 */
export function useTimeline() {
  const context = useContext(TimelineContext)
  if (!context) {
    throw new Error('useTimeline must be used within a TimelineProvider')
  }
  return context
}
