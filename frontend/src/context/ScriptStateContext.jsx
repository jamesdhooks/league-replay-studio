/**
 * ScriptStateContext — manages script lock, per-segment capture state,
 * capture range, trash bin, and PiP configuration.
 *
 * Persists via the /api/script-state endpoints.
 */

import { createContext, useContext, useState, useCallback, useMemo } from 'react'
import { apiGet, apiPost, apiPut } from '../services/api'

const ScriptStateContext = createContext(null)

// ── Capture states ──────────────────────────────────────────────────────────
export const CAPTURE_STATES = {
  UNCAPTURED:  'uncaptured',
  CAPTURED:    'captured',
  INVALIDATED: 'invalidated',
  CAPTURING:   'capturing',
}

// ── Capture modes ───────────────────────────────────────────────────────────
export const CAPTURE_MODES = {
  ALL:              'all',
  UNCAPTURED_ONLY:  'uncaptured_only',
  SPECIFIC:         'specific_segments',
  TIME_RANGE:       'time_range',
}

export function ScriptStateProvider({ children }) {
  // ── State ──────────────────────────────────────────────────────────────
  const [scriptLocked, setScriptLocked] = useState(false)
  const [lockedAt, setLockedAt]         = useState(null)
  const [segments, setSegments]         = useState({})       // segment_id → {hash, capture_state, clip_path, ...}
  const [captureRange, setCaptureRange] = useState(null)     // {start, end} or null
  const [trash, setTrash]               = useState([])       // invalidated clip entries
  const [pipConfig, setPipConfig]       = useState({
    enabled: false,
    position: 'bottom-right',
    scale: 0.3,
    margin: 16,
    border: true,
    border_color: '#ffffff',
    border_width: 2,
    show_live_badge: true,
  })
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState(null)

  // ── Derived ────────────────────────────────────────────────────────────
  const summary = useMemo(() => {
    const vals = Object.values(segments)
    const total = vals.length
    const captured    = vals.filter(s => s.capture_state === CAPTURE_STATES.CAPTURED).length
    const uncaptured  = vals.filter(s => s.capture_state === CAPTURE_STATES.UNCAPTURED).length
    const invalidated = vals.filter(s => s.capture_state === CAPTURE_STATES.INVALIDATED).length
    const capturing   = vals.filter(s => s.capture_state === CAPTURE_STATES.CAPTURING).length
    return { total, captured, uncaptured, invalidated, capturing, complete: captured === total && total > 0 }
  }, [segments])

  // ── Helpers ────────────────────────────────────────────────────────────
  const _applyState = useCallback((state) => {
    setScriptLocked(state.script_locked ?? false)
    setLockedAt(state.locked_at ?? null)
    setSegments(state.segments ?? {})
    setCaptureRange(state.capture_range ?? null)
    setTrash(state.trash ?? [])
    if (state.pip_config) setPipConfig(state.pip_config)
  }, [])

  // ── API Actions ────────────────────────────────────────────────────────

  const fetchState = useCallback(async (projectId) => {
    try {
      setLoading(true)
      const state = await apiGet(`/script-state/${projectId}/state`)
      _applyState(state)
      return state
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setLoading(false)
    }
  }, [_applyState])

  const lockScript = useCallback(async (projectId, script) => {
    try {
      setLoading(true)
      const result = await apiPost(`/script-state/${projectId}/lock`, { script })
      if (result.state) _applyState(result.state)
      return result
    } catch (err) {
      setError(err.message)
      throw err
    } finally {
      setLoading(false)
    }
  }, [_applyState])

  const unlockScript = useCallback(async (projectId) => {
    try {
      setLoading(true)
      const result = await apiPost(`/script-state/${projectId}/unlock`)
      if (result.state) _applyState(result.state)
      return result
    } catch (err) {
      setError(err.message)
      throw err
    } finally {
      setLoading(false)
    }
  }, [_applyState])

  const compareScript = useCallback(async (projectId, newScript) => {
    try {
      setLoading(true)
      const result = await apiPost(`/script-state/${projectId}/compare`, { script: newScript })
      if (result.state) _applyState(result.state)
      return result
    } catch (err) {
      setError(err.message)
      throw err
    } finally {
      setLoading(false)
    }
  }, [_applyState])

  const setCaptureRangeApi = useCallback(async (projectId, start, end) => {
    try {
      const result = await apiPost(`/script-state/${projectId}/capture-range`, { start, end })
      setCaptureRange(result.capture_range ?? null)
      return result
    } catch (err) {
      setError(err.message)
      throw err
    }
  }, [])

  const invalidateSegment = useCallback(async (projectId, segmentId, reason = 'manual') => {
    try {
      await apiPost(`/script-state/${projectId}/invalidate`, { segment_id: segmentId, reason })
      // Refresh state
      await fetchState(projectId)
    } catch (err) {
      setError(err.message)
    }
  }, [fetchState])

  const markCaptured = useCallback(async (projectId, segmentId, clipPath) => {
    try {
      await apiPost(`/script-state/${projectId}/mark-captured`, { segment_id: segmentId, clip_path: clipPath })
      setSegments(prev => ({
        ...prev,
        [segmentId]: { ...prev[segmentId], capture_state: CAPTURE_STATES.CAPTURED, clip_path: clipPath },
      }))
    } catch (err) {
      setError(err.message)
    }
  }, [])

  // ── Trash ──────────────────────────────────────────────────────────────

  const fetchTrash = useCallback(async (projectId) => {
    try {
      const result = await apiGet(`/script-state/${projectId}/trash`)
      setTrash(result.trash ?? [])
      return result
    } catch (err) {
      setError(err.message)
      return null
    }
  }, [])

  const emptyTrash = useCallback(async (projectId) => {
    try {
      const result = await apiPost(`/script-state/${projectId}/trash/empty`)
      setTrash([])
      return result
    } catch (err) {
      setError(err.message)
      throw err
    }
  }, [])

  const restoreFromTrash = useCallback(async (projectId, segmentId) => {
    try {
      await apiPost(`/script-state/${projectId}/trash/restore`, { segment_id: segmentId })
      await fetchState(projectId)
    } catch (err) {
      setError(err.message)
      throw err
    }
  }, [fetchState])

  // ── PiP ────────────────────────────────────────────────────────────────

  const fetchPipConfig = useCallback(async (projectId) => {
    try {
      const config = await apiGet(`/script-state/${projectId}/pip-config`)
      setPipConfig(config)
      return config
    } catch (err) {
      setError(err.message)
      return null
    }
  }, [])

  const updatePipConfig = useCallback(async (projectId, updates) => {
    try {
      const config = await apiPut(`/script-state/${projectId}/pip-config`, updates)
      setPipConfig(config)
      return config
    } catch (err) {
      setError(err.message)
      throw err
    }
  }, [])

  // ── Filter ─────────────────────────────────────────────────────────────

  const filterSegments = useCallback(async (projectId, script, mode = 'all', opts = {}) => {
    try {
      const result = await apiPost(`/script-state/${projectId}/filter`, {
        script,
        mode,
        segment_ids: opts.segmentIds ?? null,
        time_range: opts.timeRange ?? null,
      })
      return result.segments ?? []
    } catch (err) {
      setError(err.message)
      return []
    }
  }, [])

  // ── Context value ──────────────────────────────────────────────────────
  const value = useMemo(() => ({
    // State
    scriptLocked, lockedAt, segments, captureRange, trash, pipConfig,
    summary, loading, error,
    // Actions
    fetchState, lockScript, unlockScript, compareScript,
    setCaptureRange: setCaptureRangeApi, invalidateSegment, markCaptured,
    fetchTrash, emptyTrash, restoreFromTrash,
    fetchPipConfig, updatePipConfig,
    filterSegments,
  }), [
    scriptLocked, lockedAt, segments, captureRange, trash, pipConfig,
    summary, loading, error,
    fetchState, lockScript, unlockScript, compareScript,
    setCaptureRangeApi, invalidateSegment, markCaptured,
    fetchTrash, emptyTrash, restoreFromTrash,
    fetchPipConfig, updatePipConfig,
    filterSegments,
  ])

  return (
    <ScriptStateContext.Provider value={value}>
      {children}
    </ScriptStateContext.Provider>
  )
}

export function useScriptState() {
  const ctx = useContext(ScriptStateContext)
  if (!ctx) throw new Error('useScriptState must be used within ScriptStateProvider')
  return ctx
}

export default ScriptStateContext
