import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { apiGet, apiPost } from '../services/api'
import { wsClient } from '../services/websocket'

const AnalysisContext = createContext(null)

/**
 * AnalysisProvider — manages replay analysis state.
 *
 * Tracks analysis progress via WebSocket pipeline events,
 * provides methods to start/cancel/fetch analysis data,
 * and stores detected events.
 */
export function AnalysisProvider({ children }) {
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [progress, setProgress] = useState(null)
  const [events, setEvents] = useState([])
  const [eventSummary, setEventSummary] = useState(null)
  const [analysisStatus, setAnalysisStatus] = useState(null)
  const [error, setError] = useState(null)
  const activeProjectRef = useRef(null)

  // ── WebSocket subscription for pipeline events ──────────────────────────
  useEffect(() => {
    const unsubscribe = wsClient.subscribeCategory('pipeline', (eventName, data) => {
      // Only process events for the currently tracked project
      if (activeProjectRef.current && data.project_id !== activeProjectRef.current) {
        return
      }

      if (data.stage && !data.stage.startsWith('analysis')) {
        return
      }

      switch (eventName) {
        case 'pipeline:started':
          setIsAnalyzing(true)
          setError(null)
          setProgress({
            percent: 0,
            message: data.description || 'Starting analysis...',
            currentTime: 0,
            totalTicks: 0,
          })
          break

        case 'pipeline:step_completed':
          setProgress(prev => ({
            ...prev,
            percent: data.progress_percent ?? prev?.percent ?? 0,
            message: data.message || data.description || 'Analyzing...',
            currentTime: data.current_time ?? prev?.currentTime ?? 0,
            totalTicks: data.total_ticks ?? prev?.totalTicks ?? 0,
          }))
          break

        case 'pipeline:completed':
          setIsAnalyzing(false)
          setProgress({
            percent: 100,
            message: `Analysis complete — ${data.events_detected ?? 0} events detected`,
            totalTicks: data.telemetry_rows ?? 0,
            eventsDetected: data.events_detected ?? 0,
            duration: data.duration_seconds ?? 0,
          })
          // Refresh events after completion
          if (data.project_id) {
            _fetchEvents(data.project_id)
            _fetchSummary(data.project_id)
          }
          break

        case 'pipeline:error':
          setIsAnalyzing(false)
          setError(data.message || 'Analysis failed')
          setProgress(null)
          break

        default:
          break
      }
    })

    return unsubscribe
  }, [])

  // ── Start analysis ──────────────────────────────────────────────────────
  const startAnalysis = useCallback(async (projectId, options = {}) => {
    setError(null)
    setEvents([])
    setEventSummary(null)
    activeProjectRef.current = projectId

    try {
      const result = await apiPost(`/projects/${projectId}/analyze`, options)
      setIsAnalyzing(true)
      return result
    } catch (err) {
      setError(err.message)
      throw err
    }
  }, [])

  // ── Cancel analysis ─────────────────────────────────────────────────────
  const cancelAnalysis = useCallback(async (projectId) => {
    try {
      const result = await apiPost(`/projects/${projectId}/analyze/cancel`)
      setIsAnalyzing(false)
      setProgress(null)
      return result
    } catch (err) {
      setError(err.message)
      throw err
    }
  }, [])

  // ── Fetch analysis status ───────────────────────────────────────────────
  const fetchAnalysisStatus = useCallback(async (projectId) => {
    try {
      const status = await apiGet(`/projects/${projectId}/analysis/status`)
      setAnalysisStatus(status)
      if (status.status === 'running') {
        setIsAnalyzing(true)
        activeProjectRef.current = projectId
      }
      return status
    } catch (err) {
      console.error('[Analysis] Status fetch error:', err)
      return null
    }
  }, [])

  // ── Fetch events ────────────────────────────────────────────────────────
  const fetchEvents = useCallback(async (projectId, options = {}) => {
    return _fetchEvents(projectId, options)
  }, [])

  async function _fetchEvents(projectId, options = {}) {
    try {
      const params = new URLSearchParams()
      if (options.eventType) params.set('event_type', options.eventType)
      if (options.minSeverity) params.set('min_severity', options.minSeverity)
      if (options.skip) params.set('skip', options.skip)
      if (options.limit) params.set('limit', options.limit)
      const qs = params.toString()
      const result = await apiGet(`/projects/${projectId}/events${qs ? '?' + qs : ''}`)
      setEvents(result.events || [])
      return result
    } catch (err) {
      console.error('[Analysis] Events fetch error:', err)
      return { events: [], total: 0 }
    }
  }

  // ── Fetch event summary ─────────────────────────────────────────────────
  const fetchEventSummary = useCallback(async (projectId) => {
    return _fetchSummary(projectId)
  }, [])

  async function _fetchSummary(projectId) {
    try {
      const result = await apiGet(`/projects/${projectId}/events/summary`)
      setEventSummary(result)
      return result
    } catch (err) {
      console.error('[Analysis] Summary fetch error:', err)
      return null
    }
  }

  // ── Context value ───────────────────────────────────────────────────────
  const value = useMemo(() => ({
    isAnalyzing,
    progress,
    events,
    eventSummary,
    analysisStatus,
    error,
    startAnalysis,
    cancelAnalysis,
    fetchAnalysisStatus,
    fetchEvents,
    fetchEventSummary,
  }), [
    isAnalyzing, progress, events, eventSummary, analysisStatus, error,
    startAnalysis, cancelAnalysis, fetchAnalysisStatus, fetchEvents, fetchEventSummary,
  ])

  return (
    <AnalysisContext.Provider value={value}>
      {children}
    </AnalysisContext.Provider>
  )
}

/**
 * Hook to access analysis state and methods.
 */
export function useAnalysis() {
  const context = useContext(AnalysisContext)
  if (!context) {
    throw new Error('useAnalysis must be used within an AnalysisProvider')
  }
  return context
}
