import { useEffect, useMemo, useState } from 'react'
import { useCapture } from '../../context/CaptureContext'
import { useScriptState } from '../../context/ScriptStateContext'
import { useToast } from '../../context/ToastContext'
import { formatFileSize } from '../../utils/format'
import { formatTime } from '../../utils/time'
import {
  Video, Play, Square, RotateCcw, CheckCircle2, XCircle,
  AlertTriangle, Monitor, Keyboard, FolderOpen, Clock,
  HardDrive, Zap, RefreshCw, FileVideo,
} from 'lucide-react'
import ClipsPanel from './ClipsPanel'
import ScriptLockBanner from './ScriptLockBanner'
import CaptureRangeSelector from './CaptureRangeSelector'
import TrashBin from './TrashBin'

/**
 * CapturePanel — Video capture orchestration UI.
 *
 * Shows: software detection, hotkey configuration status, test button,
 * capture start/stop controls, real-time progress, and post-capture validation.
 *
 * @param {Object} props
 * @param {number} props.projectId - Active project ID
 */
export default function CapturePanel({ projectId, script, totalDuration }) {
  const {
    software, activeSoftware, hotkeys, watchDir,
    captureState, elapsedSeconds, filePath, fileSize, error, testResult, loading,
    detectSoftware, testHotkey, startCapture, stopCapture, resetCapture,
  } = useCapture()
  const { scriptLocked, fetchState } = useScriptState()
  const { showSuccess, showError } = useToast()
  const [captureMode, setCaptureMode] = useState('all')
  const [selectedSegmentIds, setSelectedSegmentIds] = useState([])
  const [captureTimeRange, setCaptureTimeRange] = useState(null)

  // Load script state on mount
  useEffect(() => {
    if (projectId) fetchState(projectId)
  }, [projectId, fetchState])

  // Detect software on mount
  useEffect(() => {
    detectSoftware()
  }, [detectSoftware])

  // Find the active software info
  const activeSoftwareInfo = useMemo(
    () => software.find(s => s.id === activeSoftware),
    [software, activeSoftware],
  )

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleTest = async () => {
    const result = await testHotkey()
    if (result.success) {
      showSuccess('Hotkey test passed — recording detected')
    } else {
      showError(result.errors?.[0] || result.error || 'Hotkey test failed')
    }
  }

  const handleStart = async () => {
    const result = await startCapture()
    if (result.success) {
      showSuccess('Capture started')
    } else {
      showError(result.error || 'Failed to start capture')
    }
  }

  const handleStop = async () => {
    const result = await stopCapture()
    if (result.success) {
      showSuccess('Capture completed — file validated')
    } else {
      showError(result.error || 'Capture stopped with errors')
    }
  }

  const handleReset = async () => {
    await resetCapture()
  }

  const handleRefresh = async () => {
    await detectSoftware()
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-bg-secondary shrink-0">
        <Video className="w-5 h-5 text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">Video Capture</h2>
        <div className="flex-1" />
        <StateBadge state={captureState} />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* ── PRIMARY CAPTURE ACTION (most visible) ──────────────── */}
        <div className="bg-bg-secondary border border-border rounded-lg p-4">
          {captureState === 'capturing' ? (
            <div className="space-y-3">
              <div className="flex items-center justify-center gap-2">
                <div className="w-3 h-3 rounded-full bg-danger animate-pulse" />
                <span className="text-base font-semibold text-danger">Recording in Progress</span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <MetricBox icon={Clock} label="Elapsed" value={formatTime(elapsedSeconds)} />
                <MetricBox icon={HardDrive} label="File Size" value={formatFileSize(fileSize)} />
              </div>

              {filePath && (
                <div className="text-xxs text-text-tertiary font-mono truncate text-center" title={filePath}>
                  <FileVideo className="w-3 h-3 inline mr-1" />
                  {filePath.split(/[/\\]/).pop()}
                </div>
              )}

              <button
                onClick={handleStop}
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm
                  font-semibold bg-danger hover:bg-danger/90 text-white transition-colors"
              >
                <Square className="w-4 h-4" />
                Stop Capture
              </button>
            </div>
          ) : captureState === 'completed' ? (
            <div className="space-y-3">
              <div className="flex items-center justify-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-success" />
                <span className="text-base font-semibold text-success">Capture Complete</span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <MetricBox icon={Clock} label="Duration" value={formatTime(elapsedSeconds)} />
                <MetricBox icon={HardDrive} label="File Size" value={formatFileSize(fileSize)} />
              </div>

              {filePath && (
                <div className="text-xxs text-text-tertiary font-mono truncate text-center" title={filePath}>
                  <FileVideo className="w-3 h-3 inline mr-1" />
                  {filePath.split(/[/\\]/).pop()}
                </div>
              )}

              <button
                onClick={handleReset}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm
                  font-medium bg-bg-primary text-text-primary hover:bg-bg-hover border border-border transition-colors"
              >
                <RotateCcw className="w-4 h-4" />
                Reset & Capture Again
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <button
                onClick={handleStart}
                disabled={loading || captureState === 'testing'}
                className={`w-full flex items-center justify-center gap-2 px-4 py-4 rounded-lg text-base
                  font-semibold transition-colors
                  ${loading
                    ? 'bg-accent/50 text-white cursor-wait'
                    : 'bg-accent hover:bg-accent-hover text-white shadow-lg shadow-accent/20'
                  }`}
              >
                <Play className="w-5 h-5" />
                Start Capture
              </button>

              {activeSoftwareInfo && !activeSoftwareInfo.running && (
                <div className="flex items-start gap-2 px-3 py-2 bg-warning/5 border border-warning/30 rounded-md">
                  <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
                  <p className="text-xxs text-warning">
                    {activeSoftwareInfo.label} is not running. Start it before capturing.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Error Display ─────────────────────────────────────────── */}
        {error && captureState === 'error' && (
          <div className="flex items-start gap-2 px-3 py-2.5 bg-danger/5 border border-danger/30 rounded-md">
            <XCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
            <div>
              <p className="text-xs text-danger font-medium">Error</p>
              <p className="text-xxs text-danger/80 mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {/* ── Script Lock Banner ─────────────────────────────────── */}
        <ScriptLockBanner
          projectId={projectId}
          script={script}
          onLock={() => fetchState(projectId)}
          onUnlock={() => fetchState(projectId)}
        />

        {/* ── Capture Range / Mode Selector ──────────────────────── */}
        {scriptLocked && script?.length > 0 && (
          <div className="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
            <CaptureRangeSelector
              projectId={projectId}
              script={script}
              totalDuration={totalDuration || 0}
              onModeChange={setCaptureMode}
              onRangeChange={setCaptureTimeRange}
              selectedSegmentIds={selectedSegmentIds}
              onSegmentIdsChange={setSelectedSegmentIds}
            />
          </div>
        )}

        {/* ── Script Capture Clips ──────────────────────────────────── */}
        <ClipsPanel projectId={projectId} />

        {/* ── Trash Bin ─────────────────────────────────────────────── */}
        <TrashBin projectId={projectId} />

        <Section icon={Monitor} title="Capture Software">
          <div className="space-y-2">
            {software.length > 0 ? (
              software.map(sw => (
                <div
                  key={sw.id}
                  className={`flex items-center gap-3 px-3 py-2 rounded-md border transition-colors
                    ${sw.id === activeSoftware
                      ? 'border-accent/40 bg-accent/5'
                      : 'border-border-subtle bg-bg-primary'
                    }`}
                >
                  {sw.running ? (
                    <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-text-disabled shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-text-primary">{sw.label}</div>
                    <div className="text-xxs text-text-tertiary">
                      {sw.running ? 'Running' : 'Not detected'}
                      {sw.id === activeSoftware && ' · Active'}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-xs text-text-tertiary italic">
                No capture software detected. Install OBS Studio, NVIDIA ShadowPlay, or AMD ReLive.
              </div>
            )}
            <button
              onClick={handleRefresh}
              className="flex items-center gap-1.5 px-2 py-1 rounded text-xxs text-text-secondary
                         hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              Refresh
            </button>
          </div>
        </Section>

        {/* ── Hotkey Configuration ──────────────────────────────────── */}
        <Section icon={Keyboard} title="Hotkey Configuration">
          <div className="space-y-2">
            <KeyDisplay label="Start Recording" value={hotkeys.start} />
            <KeyDisplay label="Stop Recording" value={hotkeys.stop || hotkeys.start || '(same as start)'} />
            <p className="text-xxs text-text-tertiary">
              Configure hotkeys in Settings → Capture tab.
            </p>
          </div>
        </Section>

        {/* ── Watch Directory ───────────────────────────────────────── */}
        <Section icon={FolderOpen} title="Output Directory">
          <div className="text-xs text-text-secondary font-mono truncate" title={watchDir || 'Not configured'}>
            {watchDir || 'Not configured — set in Settings'}
          </div>
        </Section>

        {/* ── Hotkey Test ───────────────────────────────────────────── */}
        {captureState !== 'capturing' && (
          <Section icon={Zap} title="Hotkey Validation">
            <div className="space-y-2">
              <p className="text-xxs text-text-tertiary">
                Test sends the start hotkey, checks for a new recording file, then sends stop.
                Make sure your capture software is running first.
              </p>
              <button
                onClick={handleTest}
                disabled={loading || captureState === 'testing'}
                className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs
                  font-medium transition-colors
                  ${loading || captureState === 'testing'
                    ? 'bg-bg-primary text-text-disabled cursor-wait border border-border'
                    : 'bg-bg-primary text-text-primary hover:bg-bg-hover border border-border'
                  }`}
              >
                <Zap className="w-3.5 h-3.5" />
                {captureState === 'testing' ? 'Testing…' : 'Test Hotkey'}
              </button>

              {testResult && (
                <TestResultDisplay result={testResult} />
              )}
            </div>
          </Section>
        )}

      </div>
    </div>
  )
}


// ── Helper components ──────────────────────────────────────────────────────

function Section({ icon: Icon, title, children }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-text-tertiary" />
        <h3 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">{title}</h3>
      </div>
      {children}
    </div>
  )
}


function StateBadge({ state }) {
  const config = {
    idle: { label: 'Idle', color: 'text-text-tertiary bg-bg-primary border-border' },
    testing: { label: 'Testing…', color: 'text-warning bg-warning/5 border-warning/30' },
    ready: { label: 'Ready', color: 'text-success bg-success/5 border-success/30' },
    capturing: { label: 'Recording', color: 'text-danger bg-danger/5 border-danger/30' },
    validating: { label: 'Validating…', color: 'text-accent bg-accent/5 border-accent/30' },
    completed: { label: 'Completed', color: 'text-success bg-success/5 border-success/30' },
    error: { label: 'Error', color: 'text-danger bg-danger/5 border-danger/30' },
  }
  const { label, color } = config[state] || config.idle

  return (
    <span className={`px-2 py-0.5 rounded-full text-xxs font-medium border ${color}`}>
      {label}
    </span>
  )
}


function KeyDisplay({ label, value }) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5 bg-bg-primary border border-border rounded">
      <span className="text-xxs text-text-tertiary">{label}</span>
      <kbd className="px-1.5 py-0.5 bg-bg-secondary border border-border rounded text-xxs font-mono text-text-primary">
        {value || 'Not set'}
      </kbd>
    </div>
  )
}


function MetricBox({ icon: Icon, label, value }) {
  return (
    <div className="bg-bg-secondary rounded px-2.5 py-1.5">
      <div className="flex items-center gap-1 mb-0.5">
        <Icon className="w-3 h-3 text-text-disabled" />
        <span className="text-xxs text-text-tertiary">{label}</span>
      </div>
      <span className="text-sm font-mono text-text-primary">{value}</span>
    </div>
  )
}


function TestResultDisplay({ result }) {
  if (!result) return null

  return (
    <div className={`rounded-md border p-2.5 space-y-1
      ${result.success
        ? 'bg-success/5 border-success/30'
        : 'bg-danger/5 border-danger/30'
      }`}
    >
      <div className="flex items-center gap-1.5">
        {result.success ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-success" />
        ) : (
          <XCircle className="w-3.5 h-3.5 text-danger" />
        )}
        <span className={`text-xs font-medium ${result.success ? 'text-success' : 'text-danger'}`}>
          {result.success ? 'Test Passed' : 'Test Failed'}
        </span>
      </div>

      {result.software_running !== undefined && (
        <div className="text-xxs text-text-tertiary">
          Software: {result.software_running ? '✓ Running' : '✗ Not running'}
        </div>
      )}

      {result.file_detected !== undefined && (
        <div className="text-xxs text-text-tertiary">
          Recording file: {result.file_detected ? '✓ Detected' : '✗ Not detected'}
        </div>
      )}

      {result.detected_file && (
        <div className="text-xxs text-text-tertiary font-mono">
          File: {result.detected_file}
        </div>
      )}

      {result.note && (
        <div className="text-xxs text-text-tertiary italic">{result.note}</div>
      )}

      {result.errors?.map((err, i) => (
        <div key={i} className="text-xxs text-danger">{err}</div>
      ))}
    </div>
  )
}
