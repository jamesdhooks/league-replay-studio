import { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { apiGet, apiPost } from '../services/api'
import { wsClient } from '../services/websocket'

const CaptureContext = createContext(null)

/**
 * CaptureProvider — manages video capture state.
 *
 * Tracks capture software detection, hotkey testing, recording progress,
 * and post-capture validation. Subscribes to capture:* WebSocket events.
 */
export function CaptureProvider({ children }) {
  // ── State ────────────────────────────────────────────────────────────────
  const [software, setSoftware] = useState([])        // detected capture software
  const [activeSoftware, setActiveSoftware] = useState(null)
  const [hotkeys, setHotkeys] = useState({ start: '', stop: '' })
  const [watchDir, setWatchDir] = useState(null)

  const [captureState, setCaptureState] = useState('idle')  // idle/testing/ready/capturing/validating/completed/error
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [filePath, setFilePath] = useState(null)
  const [fileSize, setFileSize] = useState(0)
  const [error, setError] = useState(null)
  const [testResult, setTestResult] = useState(null)
  const [loading, setLoading] = useState(false)

  // ── Detect software ─────────────────────────────────────────────────────
  const detectSoftware = useCallback(async () => {
    try {
      const data = await apiGet('/capture/software')
      setSoftware(data.software || [])
      setActiveSoftware(data.active_software)
      setHotkeys(data.hotkeys || { start: '', stop: '' })
      setWatchDir(data.watch_directory)
      return data
    } catch (err) {
      console.error('[Capture] Detection failed:', err)
      return null
    }
  }, [])

  // ── Fetch status ────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiGet('/capture/status')
      setCaptureState(data.state || 'idle')
      setElapsedSeconds(data.elapsed_seconds || 0)
      setFilePath(data.file_path)
      setFileSize(data.file_size_bytes || 0)
      setError(data.error)
      setTestResult(data.test_result)
      setWatchDir(data.watch_dir)
      return data
    } catch (err) {
      console.error('[Capture] Status fetch failed:', err)
      return null
    }
  }, [])

  // ── Test hotkey ─────────────────────────────────────────────────────────
  const testHotkey = useCallback(async () => {
    setLoading(true)
    setError(null)
    setCaptureState('testing')
    try {
      const result = await apiPost('/capture/test')
      setTestResult(result)
      setCaptureState(result.success ? 'ready' : 'error')
      if (!result.success && result.errors?.length) {
        setError(result.errors[0])
      }
      return result
    } catch (err) {
      setError(err.message)
      setCaptureState('error')
      return { success: false, error: err.message }
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Start capture ───────────────────────────────────────────────────────
  const startCapture = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await apiPost('/capture/start')
      setCaptureState('capturing')
      setElapsedSeconds(0)
      setFileSize(0)
      setFilePath(null)
      return result
    } catch (err) {
      setError(err.message)
      setCaptureState('error')
      return { success: false, error: err.message }
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Stop capture ────────────────────────────────────────────────────────
  const stopCapture = useCallback(async () => {
    setLoading(true)
    try {
      const result = await apiPost('/capture/stop')
      if (result.success) {
        setCaptureState('completed')
        setFilePath(result.file_path)
        setFileSize(result.size_bytes || 0)
        setElapsedSeconds(result.elapsed_seconds || 0)
      } else {
        setCaptureState('error')
        setError(result.error)
      }
      return result
    } catch (err) {
      setError(err.message)
      setCaptureState('error')
      return { success: false, error: err.message }
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Reset ───────────────────────────────────────────────────────────────
  const resetCapture = useCallback(async () => {
    try {
      await apiPost('/capture/reset')
      setCaptureState('idle')
      setElapsedSeconds(0)
      setFilePath(null)
      setFileSize(0)
      setError(null)
      setTestResult(null)
    } catch (err) {
      console.error('[Capture] Reset failed:', err)
    }
  }, [])

  // ── Script capture state ───────────────────────────────────────────────
  const [scriptCaptureRunning, setScriptCaptureRunning] = useState(false)
  const [scriptCaptureProgress, setScriptCaptureProgress] = useState(null)
  // { percentage, segment_id, section, message, segment_index, segment_total, strategy }
  const [scriptCaptureClips, setScriptCaptureClips] = useState([])
  const [scriptCompiledPath, setScriptCompiledPath] = useState(null)
  const [scriptCaptureError, setScriptCaptureError] = useState(null)
  const [scriptCaptureLog, setScriptCaptureLog] = useState([])
  const [scriptCaptureStrategies, setScriptCaptureStrategies] = useState([])
  const [scriptCurrentSegment, setScriptCurrentSegment] = useState(null)

  // ── Script capture actions ──────────────────────────────────────────────
  const startScriptCapture = useCallback(async (projectId, script, options = {}) => {
    setScriptCaptureRunning(true)
    setScriptCaptureProgress(null)
    setScriptCaptureClips([])
    setScriptCompiledPath(null)
    setScriptCaptureError(null)
    setScriptCaptureLog([])
    setScriptCaptureStrategies([])
    setScriptCurrentSegment(null)
    try {
      const result = await apiPost('/capture/script-capture', {
        project_id: projectId,
        script,
        clip_padding: options.clipPadding ?? 2.0,
        clip_padding_after: options.clipPaddingAfter ?? 5.0,
        output_filename: options.outputFilename ?? 'highlight_compiled.mp4',
        contiguous_gap_threshold: options.contiguousGapThreshold ?? 1.0,
      })
      return result
    } catch (err) {
      setScriptCaptureRunning(false)
      setScriptCaptureError(err.message)
      return { accepted: false, error: err.message }
    }
  }, [])

  const cancelScriptCapture = useCallback(async () => {
    try {
      await apiPost('/capture/script-capture/cancel')
    } catch (err) {
      console.error('[Capture] Script cancel error:', err)
    }
  }, [])
  // ── WebSocket subscriptions ─────────────────────────────────────────────
  useEffect(() => {
    const unsubs = [
      wsClient.subscribe('capture:started', (data) => {
        setCaptureState('capturing')
        setError(null)
      }),
      wsClient.subscribe('capture:stopped', (data) => {
        setCaptureState('completed')
        setFilePath(data.file_path || null)
        setFileSize(data.size_bytes || 0)
        setElapsedSeconds(data.elapsed_seconds || 0)
      }),
      wsClient.subscribe('capture:progress', (data) => {
        setElapsedSeconds(data.elapsed_seconds || 0)
        setFileSize(data.file_size_bytes || 0)
        if (data.file_path) setFilePath(data.file_path)
      }),
      wsClient.subscribe('capture:file_detected', (data) => {
        if (data.file_path) setFilePath(data.file_path)
      }),
      wsClient.subscribe('capture:hotkey_test', (data) => {
        setTestResult(data)
        setCaptureState(data.success ? 'ready' : 'error')
        if (!data.success && data.errors?.length) {
          setError(data.errors[0])
        }
      }),
      wsClient.subscribe('capture:validated', (data) => {
        // File validated
      }),
      wsClient.subscribe('capture:error', (data) => {
        setCaptureState('error')
        setError(data.error || 'Capture error')
      }),

      // Script capture events
      wsClient.subscribe('capture:script_started', (data) => {
        setScriptCaptureRunning(true)
        setScriptCaptureError(null)
        setScriptCaptureLog([])
        setScriptCaptureStrategies([])
        setScriptCurrentSegment(null)
        setScriptCaptureProgress({
          percentage: 0,
          message: 'Starting...',
          segment_index: 0,
          segment_total: data.total_segments || 0,
        })
      }),
      wsClient.subscribe('capture:script_progress', (data) => {
        const step = data.step
        if (step === 'strategy_computed') {
          setScriptCaptureStrategies(data.strategies || [])
          setScriptCaptureProgress(prev => ({
            ...prev,
            message: data.message || 'Strategy computed',
            strategies: data.strategies,
          }))
        } else if (step === 'log_entry') {
          setScriptCaptureLog(prev => [...prev, data.log_entry])
        } else if (step === 'capturing') {
          setScriptCurrentSegment({
            segment_id: data.segment_id,
            section: data.section,
            segment_type: data.segment_type,
            strategy: data.strategy,
          })
          setScriptCaptureProgress({
            percentage: data.percentage || 0,
            message: data.message || '',
            segment_id: data.segment_id,
            section: data.section,
            segment_index: data.segment_index || 0,
            segment_total: data.segment_total || 0,
            step: data.step,
            strategy: data.strategy,
          })
        } else {
          setScriptCaptureProgress(prev => ({
            ...prev,
            message: data.message || prev?.message || '',
            step: data.step,
          }))
        }
      }),
      wsClient.subscribe('capture:script_completed', (data) => {
        setScriptCaptureRunning(false)
        setScriptCaptureClips(data.clips || [])
        setScriptCompiledPath(data.compiled_path || null)
        setScriptCaptureStrategies(data.strategies || [])
        if (data.capture_log) {
          setScriptCaptureLog(data.capture_log)
        }
        setScriptCurrentSegment(null)
        setScriptCaptureProgress({
          percentage: 100,
          message: `Completed — ${data.total_clips} clips`,
          step: 'compile_complete',
        })
      }),
      wsClient.subscribe('capture:script_error', (data) => {
        setScriptCaptureRunning(false)
        setScriptCaptureError(data.error || 'Script capture failed')
        setScriptCurrentSegment(null)
      }),
    ]

    return () => unsubs.forEach(fn => fn())
  }, [])

  // ── Context value ───────────────────────────────────────────────────────
  const value = useMemo(() => ({
    // State
    software,
    activeSoftware,
    hotkeys,
    watchDir,
    captureState,
    elapsedSeconds,
    filePath,
    fileSize,
    error,
    testResult,
    loading,

    // Script capture
    scriptCaptureRunning,
    scriptCaptureProgress,
    scriptCaptureClips,
    scriptCompiledPath,
    scriptCaptureError,
    scriptCaptureLog,
    scriptCaptureStrategies,
    scriptCurrentSegment,

    // Actions
    detectSoftware,
    fetchStatus,
    testHotkey,
    startCapture,
    stopCapture,
    resetCapture,
    startScriptCapture,
    cancelScriptCapture,
  }), [
    software, activeSoftware, hotkeys, watchDir,
    captureState, elapsedSeconds, filePath, fileSize, error, testResult, loading,
    scriptCaptureRunning, scriptCaptureProgress, scriptCaptureClips, scriptCompiledPath, scriptCaptureError,
    scriptCaptureLog, scriptCaptureStrategies, scriptCurrentSegment,
    detectSoftware, fetchStatus, testHotkey, startCapture, stopCapture, resetCapture,
    startScriptCapture, cancelScriptCapture,
  ])

  return (
    <CaptureContext.Provider value={value}>
      {children}
    </CaptureContext.Provider>
  )
}

/**
 * Hook to access capture state and methods.
 */
export function useCapture() {
  const context = useContext(CaptureContext)
  if (!context) {
    throw new Error('useCapture must be used within a CaptureProvider')
  }
  return context
}
