import { useEffect, useState, useMemo, useCallback } from 'react'
import { useEncoding } from '../../context/EncodingContext'
import { useToast } from '../../context/ToastContext'
import { formatFileSize } from '../../utils/format'
import { formatTime } from '../../utils/time'
import ExportPresetEditor from './ExportPresetEditor'
import EncodingDashboard from './EncodingDashboard'
import CompletedExports from './CompletedExports'
import GPUStatus from './GPUStatus'
import PresetSelector from './PresetSelector'
import JobQueue from './JobQueue'
import {
  Cpu, Play, Square, CheckCircle2, XCircle, AlertTriangle,
  Settings2, Clock, HardDrive, FileVideo, RefreshCw, Layers,
  Zap, ChevronDown, Trash2, Plus, Film, Copy, Edit3, Power,
  FolderOpen,
} from 'lucide-react'

/**
 * EncodingPanel — GPU-accelerated video encoding UI.
 *
 * Shows: GPU detection, export preset selection, encoding start/cancel controls,
 * real-time progress (FPS, percentage, ETA), and completed job history.
 *
 * @param {Object} props
 * @param {number} props.projectId - Active project ID
 */
export default function EncodingPanel({ projectId }) {
  const {
    gpuInfo, presets, activeJobs, queuedJobs, recentJobs, autoShutdown,
    loading, error,
    detectGpus, refreshGpus, fetchPresets, startEncoding, cancelJob, fetchStatus,
    duplicatePreset, toggleAutoShutdown,
  } = useEncoding()
  const { showSuccess, showError } = useToast()

  const [selectedPresetId, setSelectedPresetId] = useState('youtube_1080p60')
  const [jobType, setJobType] = useState('full')
  const [inputFile, setInputFile] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [presetEditor, setPresetEditor] = useState(null) // { mode, preset }

  // Detect GPUs and fetch presets on mount
  useEffect(() => {
    detectGpus()
    fetchPresets()
    fetchStatus()
  }, [detectGpus, fetchPresets, fetchStatus])

  const selectedPreset = useMemo(
    () => presets.find(p => p.id === selectedPresetId) || presets[0],
    [presets, selectedPresetId],
  )

  // Active job for this project
  const projectActiveJob = useMemo(
    () => activeJobs.find(j => j.project_id === projectId),
    [activeJobs, projectId],
  )

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleStart = useCallback(async () => {
    if (!inputFile) {
      showError('Select a video file to encode')
      return
    }
    const result = await startEncoding({
      projectId,
      inputFile,
      outputDir: outputDir || inputFile.replace(/[/\\][^/\\]+$/, ''),
      presetId: selectedPresetId,
      jobType,
    })
    if (result.success) {
      showSuccess('Encoding job started')
    } else {
      showError(result.error || 'Failed to start encoding')
    }
  }, [projectId, inputFile, outputDir, selectedPresetId, jobType, startEncoding, showSuccess, showError])

  const handleCancel = useCallback(async (jobId) => {
    const result = await cancelJob(jobId)
    if (result.success) {
      showSuccess('Encoding cancelled')
    } else {
      showError(result.error || 'Failed to cancel')
    }
  }, [cancelJob, showSuccess, showError])

  const handleRefreshGpus = useCallback(async () => {
    await refreshGpus()
    showSuccess('GPU detection refreshed')
  }, [refreshGpus, showSuccess])

  const handleDuplicate = useCallback(async (presetId) => {
    const result = await duplicatePreset(presetId)
    if (result.success) {
      showSuccess('Preset duplicated')
    } else {
      showError(result.error || 'Failed to duplicate')
    }
  }, [duplicatePreset, showSuccess, showError])

  const handleAutoShutdown = useCallback(async () => {
    await toggleAutoShutdown(!autoShutdown)
  }, [toggleAutoShutdown, autoShutdown])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-bg-secondary shrink-0">
        <Film className="w-5 h-5 text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">Export & Encode</h2>
        <div className="flex-1" />
        {projectActiveJob && <EncodingBadge state="encoding" />}
        {!projectActiveJob && activeJobs.length > 0 && <EncodingBadge state="busy" />}
        {!projectActiveJob && activeJobs.length === 0 && <EncodingBadge state="idle" />}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* ── GPU Detection ───────────────────────────────────────── */}
        <Section icon={Cpu} title="GPU Encoder">
          <GPUStatus gpuInfo={gpuInfo} onRefresh={handleRefreshGpus} />
        </Section>

        {/* ── Export Preset ────────────────────────────────────────── */}
        <Section icon={Settings2} title="Export Preset">
          <PresetSelector
            presets={presets}
            selectedPresetId={selectedPresetId}
            selectedPreset={selectedPreset}
            onSelect={setSelectedPresetId}
            onDuplicate={handleDuplicate}
            onEdit={(mode, preset) => setPresetEditor({ mode, preset })}
            onCreate={() => setPresetEditor({ mode: 'create', preset: null })}
          />
        </Section>

        {/* ── Output Type ─────────────────────────────────────────── */}
        <Section icon={Layers} title="Output Type">
          <div className="flex gap-2">
            <TypeButton
              active={jobType === 'full'}
              label="Full Race"
              onClick={() => setJobType('full')}
            />
            <TypeButton
              active={jobType === 'highlight'}
              label="Highlight Reel"
              onClick={() => setJobType('highlight')}
            />
          </div>
        </Section>

        {/* ── Input File ──────────────────────────────────────────── */}
        <Section icon={FileVideo} title="Source Video">
          <input
            type="text"
            value={inputFile}
            onChange={e => setInputFile(e.target.value)}
            placeholder="Path to source video file…"
            className="w-full bg-bg-primary border border-border rounded-md px-3 py-2
                       text-xs text-text-primary placeholder:text-text-disabled
                       focus:outline-none focus:ring-1 focus:ring-accent font-mono"
          />
          <p className="text-xxs text-text-tertiary mt-1">
            Enter the path to the captured video file from the Capture step.
          </p>
        </Section>

        {/* ── Active Encoding — Dashboard ─────────────────────────── */}
        {projectActiveJob && (
          <Section icon={Film} title="Encoding Dashboard">
            <EncodingDashboard job={projectActiveJob} gpuInfo={gpuInfo} />
            {/* Cancel button */}
            <button
              onClick={() => handleCancel(projectActiveJob.job_id)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs
                font-medium bg-danger hover:bg-danger/90 text-white transition-colors mt-2"
            >
              <Square className="w-3.5 h-3.5" />
              Cancel Encoding
            </button>
          </Section>
        )}

        {/* ── Start / Queue ───────────────────────────────────────── */}
        {!projectActiveJob && (
          <Section icon={Play} title="Encode">
            <button
              onClick={handleStart}
              disabled={loading || !gpuInfo?.ffmpeg_available || !inputFile}
              className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-md text-xs
                font-medium transition-colors
                ${loading || !gpuInfo?.ffmpeg_available || !inputFile
                  ? 'bg-accent/50 text-white cursor-not-allowed'
                  : 'bg-accent hover:bg-accent-hover text-white'
                }`}
            >
              <Play className="w-3.5 h-3.5" />
              Start Encoding
            </button>

            {!gpuInfo?.ffmpeg_available && (
              <div className="flex items-start gap-2 px-3 py-2 bg-warning/5 border border-warning/30 rounded-md mt-2">
                <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
                <p className="text-xxs text-warning">
                  FFmpeg is not installed. Install FFmpeg to encode videos.
                </p>
              </div>
            )}

            {/* Auto-shutdown toggle */}
            <div className="flex items-center justify-between px-3 py-2 bg-bg-primary border border-border rounded-md mt-2">
              <div className="flex items-center gap-2">
                <Power className="w-3.5 h-3.5 text-text-tertiary" />
                <div>
                  <div className="text-xs text-text-secondary">Auto-shutdown</div>
                  <div className="text-xxs text-text-tertiary">Shut down when all jobs complete</div>
                </div>
              </div>
              <button
                onClick={handleAutoShutdown}
                className={`relative w-9 h-5 rounded-full transition-colors ${
                  autoShutdown ? 'bg-accent' : 'bg-bg-hover border border-border'
                }`}
                role="switch"
                aria-checked={autoShutdown}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                    autoShutdown ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          </Section>
        )}

        {/* ── Queue + Other Active Jobs ─────────────────────────── */}
        <JobQueue
          activeJobs={activeJobs}
          queuedJobs={queuedJobs}
          projectId={projectId}
          onCancel={handleCancel}
        />

        {/* ── Recent Jobs ─────────────────────────────────────────── */}
        {recentJobs.length > 0 && (
          <Section icon={CheckCircle2} title="Recent">
            <div className="space-y-1.5">
              {recentJobs.slice(0, 5).map(job => (
                <div
                  key={job.job_id}
                  className={`flex items-center gap-2 px-3 py-2 rounded-md border
                    ${job.state === 'completed'
                      ? 'bg-success/5 border-success/30'
                      : 'bg-danger/5 border-danger/30'
                    }`}
                >
                  {job.state === 'completed' ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-danger shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-text-secondary truncate">
                      {job.preset?.name || 'Encode'} · {job.job_type || 'full'}
                    </div>
                    {job.output_size_bytes > 0 && (
                      <div className="text-xxs text-text-tertiary">
                        {formatFileSize(job.output_size_bytes)}
                        {job.elapsed_seconds > 0 && ` · ${formatTime(job.elapsed_seconds)}`}
                      </div>
                    )}
                    {job.error && (
                      <div className="text-xxs text-danger truncate">{job.error}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ── Completed Exports ─────────────────────────────────────── */}
        <Section icon={FolderOpen} title="Completed Exports">
          <CompletedExports />
        </Section>

        {/* ── Error Display ──────────────────────────────────────── */}
        {error && !projectActiveJob && (
          <div className="flex items-start gap-2 px-3 py-2.5 bg-danger/5 border border-danger/30 rounded-md">
            <XCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
            <div>
              <p className="text-xs text-danger font-medium">Error</p>
              <p className="text-xxs text-danger/80 mt-0.5">{error}</p>
            </div>
          </div>
        )}

      </div>

      {/* Preset Editor Modal */}
      {presetEditor && (
        <ExportPresetEditor
          preset={presetEditor.preset}
          mode={presetEditor.mode}
          onClose={() => setPresetEditor(null)}
        />
      )}
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


function EncodingBadge({ state }) {
  const config = {
    idle: { label: 'Ready', color: 'text-text-tertiary bg-bg-primary border-border' },
    encoding: { label: 'Encoding…', color: 'text-accent bg-accent/5 border-accent/30' },
    busy: { label: 'Busy', color: 'text-warning bg-warning/5 border-warning/30' },
  }
  const { label, color } = config[state] || config.idle

  return (
    <span className={`px-2 py-0.5 rounded-full text-xxs font-medium border ${color}`}>
      {label}
    </span>
  )
}


function TypeButton({ active, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-3 py-2 rounded-md text-xs font-medium border transition-colors
        ${active
          ? 'border-accent/40 bg-accent/5 text-accent'
          : 'border-border bg-bg-primary text-text-secondary hover:bg-bg-hover'
        }`}
    >
      {label}
    </button>
  )
}
