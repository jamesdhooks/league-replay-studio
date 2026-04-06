import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { apiGet, apiPost, apiDelete } from '../services/api'
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
  const [isScanning, setIsScanning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [events, setEvents] = useState([])
  const [eventSummary, setEventSummary] = useState(null)
  const [analysisStatus, setAnalysisStatus] = useState(null)
  const [error, setError] = useState(null)
  const [analysisLog, setAnalysisLog] = useState([])
  const [discoveredEvents, setDiscoveredEvents] = useState([])
  const activeProjectRef = useRef(null)
  const logIdRef = useRef(0)

  // ── WebSocket subscription for pipeline events ──────────────────────────
  useEffect(() => {
    const unsubscribe = wsClient.subscribeCategory('pipeline', (eventName, data) => {
      // Only process events for the currently tracked project
      if (activeProjectRef.current && data.project_id !== activeProjectRef.current) {
        return
      }

      // Handle discovered events (separate from pipeline category filtering)
      if (eventName === 'pipeline:event_discovered') {
        const id = ++logIdRef.current
        setDiscoveredEvents(prev => [...prev, {
          id,
          type: data.event_type,
          severity: data.severity,
          startTime: data.start_time,
          endTime: data.end_time,
          lap: data.lap,
          driverNames: data.driver_names || [],
          carIndices: data.drivers || [],
          carIdx: (data.drivers && data.drivers.length > 0) ? data.drivers[0] : null,
          detector: data.detector,
          ts: Date.now(),
        }])
        return
      }

      if (data.stage && !data.stage.startsWith('analysis')) {
        return
      }

      // Helper to append a log entry
      const appendLog = (desc, detail, level = 'info') => {
        const id = ++logIdRef.current
        setAnalysisLog(prev => [...prev, {
          id, level, ts: Date.now(),
          message: desc || '',
          detail: detail || '',
        }])
      }

      switch (eventName) {
        case 'pipeline:started':
          setIsAnalyzing(true)
          setIsScanning(true)  // always start in scan phase
          setError(null)
          setAnalysisLog([])
          setDiscoveredEvents([])
          logIdRef.current = 0
          appendLog(data.description || 'Starting analysis...', data.detail)
          setProgress({
            percent: 0,
            message: data.description || 'Starting analysis...',
            detail: data.detail || '',
            currentTime: 0,
            totalTicks: 0,
            phase: data.phase || 'full',
          })
          break

        case 'pipeline:step_completed':
          if (data.stage === 'analysis_detect') setIsScanning(false)
          appendLog(
            data.description || data.message || 'Analyzing...',
            data.detail || '',
            data.stage === 'analysis_detect' ? 'detect' : 'info',
          )
          setProgress(prev => ({
            ...prev,
            percent: data.progress_percent ?? prev?.percent ?? 0,
            message: data.message || data.description || 'Analyzing...',
            detail: data.detail || prev?.detail || '',
            currentTime: data.current_time ?? prev?.currentTime ?? 0,
            totalTicks: data.total_ticks ?? prev?.totalTicks ?? 0,
            currentLap: data.current_lap ?? prev?.currentLap,
            carCount: data.car_count ?? prev?.carCount,
          }))
          break

        case 'pipeline:completed': {
          const isScanPhase = data.phase === 'scan'
          setIsAnalyzing(false)
          setIsScanning(false)
          const completedMsg = isScanPhase
            ? data.description || `Telemetry collected — ${data.telemetry_rows ?? 0} samples`
            : data.description || `Analysis complete — ${data.events_detected ?? 0} events detected`
          appendLog(completedMsg, data.detail || '', 'success')
          setProgress({
            percent: 100,
            message: completedMsg,
            detail: data.detail || '',
            totalTicks: data.telemetry_rows ?? 0,
            eventsDetected: data.events_detected ?? 0,
            duration: data.duration_seconds ?? 0,
            phase: data.phase || 'full',
          })
          // Refresh status and events after completion
          if (data.project_id) {
            apiGet(`/projects/${data.project_id}/analysis/status`)
              .then(status => setAnalysisStatus(status))
              .catch(() => {})
            if (!isScanPhase) {
              apiGet(`/projects/${data.project_id}/events`)
                .then(result => setEvents(result.events || []))
                .catch(() => {})
              apiGet(`/projects/${data.project_id}/events/summary`)
                .then(result => setEventSummary(result))
                .catch(() => {})
            }
          }
          break
        }

        case 'pipeline:error':
          setIsAnalyzing(false)
          setIsScanning(false)
          appendLog(data.message || 'Analysis failed', '', 'error')
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
    setAnalysisLog([])
    setDiscoveredEvents([])
    logIdRef.current = 0
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

  // ── Start rescan (telemetry collection only, Pass 1) ─────────────────────
  const startRescan = useCallback(async (projectId) => {
    setError(null)
    setAnalysisLog([])
    setDiscoveredEvents([])
    logIdRef.current = 0
    activeProjectRef.current = projectId

    try {
      const result = await apiPost(`/projects/${projectId}/analyze/rescan`)
      setIsAnalyzing(true)
      setIsScanning(true)
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
      setIsScanning(false)
      setProgress(null)
      return result
    } catch (err) {
      // 404 means nothing was running — clear our stale state anyway
      setIsAnalyzing(false)
      setIsScanning(false)
      setProgress(null)
      setError(err.message)
      throw err
    }
  }, [])

  // ── Clear analysis ──────────────────────────────────────────────────────
  const clearAnalysis = useCallback(async (projectId) => {
    try {
      const result = await apiDelete(`/projects/${projectId}/analysis`)
      setIsAnalyzing(false)
      setProgress(null)
      setEvents([])
      setEventSummary(null)
      setAnalysisLog([])
      setDiscoveredEvents([])
      setAnalysisStatus(null)
      setError(null)
      logIdRef.current = 0
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
      } else {
        // Sync down stale in-memory running state
        setIsAnalyzing(false)
        setIsScanning(false)
      }
      return status
    } catch (err) {
      console.error('[Analysis] Status fetch error:', err)
      return null
    }
  }, [])

  // ── Fetch events ────────────────────────────────────────────────────────
  const fetchEvents = useCallback(async (projectId, options = {}) => {
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
  }, [])

  // ── Fetch event summary ─────────────────────────────────────────────────
  const fetchEventSummary = useCallback(async (projectId) => {
    try {
      const result = await apiGet(`/projects/${projectId}/events/summary`)
      setEventSummary(result)
      return result
    } catch (err) {
      console.error('[Analysis] Summary fetch error:', err)
      return null
    }
  }, [])

  // ── Load analysis log from persisted data ───────────────────────────────
  const loadAnalysisLog = useCallback((entries) => {
    if (!entries || entries.length === 0) return
    const mapped = entries
      .filter(entry => entry.event !== 'event_discovered')
      .map((entry, i) => ({
        id: i + 1,
        level: entry.event === 'completed' ? 'success'
             : entry.event === 'error' ? 'error'
             : entry.stage === 'analysis_detect' ? 'detect'
             : 'info',
        ts: (entry.ts || 0) * 1000,
        message: entry.description || entry.message || entry.event || '',
        detail: entry.detail || '',
      }))
    logIdRef.current = mapped.length
    setAnalysisLog(mapped)
  }, [])

  // ── Clear discovered events (used before re-detect) ────────────────────
  const clearDiscoveredEvents = useCallback(() => {
    setDiscoveredEvents([])
  }, [])

  // ── Context value ───────────────────────────────────────────────────────
  const value = useMemo(() => ({
    isAnalyzing,
    isScanning,
    progress,
    events,
    eventSummary,
    analysisStatus,
    error,
    analysisLog,
    discoveredEvents,
    hasTelemetry: analysisStatus?.has_telemetry ?? false,
    hasEvents: analysisStatus?.has_events ?? events.length > 0,
    startAnalysis,
    startRescan,
    cancelAnalysis,
    clearAnalysis,
    fetchAnalysisStatus,
    fetchEvents,
    fetchEventSummary,
    loadAnalysisLog,
    clearDiscoveredEvents,
  }), [
    isAnalyzing, isScanning, progress, events, eventSummary, analysisStatus, error,
    analysisLog, discoveredEvents,
    startAnalysis, startRescan, cancelAnalysis, clearAnalysis, fetchAnalysisStatus, fetchEvents, fetchEventSummary,
    loadAnalysisLog, clearDiscoveredEvents,
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
