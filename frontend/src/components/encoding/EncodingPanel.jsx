import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useEncoding } from '../../context/EncodingContext'
import { useComposition } from '../../context/CompositionContext'
import { useToast } from '../../context/ToastContext'
import { apiGet, apiPost } from '../../services/api'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { formatFileSize } from '../../utils/format'
import { formatTime } from '../../utils/time'
import ExportPresetEditor from './ExportPresetEditor'
import EncodingDashboard from './EncodingDashboard'
import CompletedExports from './CompletedExports'
import GPUStatus from './GPUStatus'
import PresetSelector from './PresetSelector'
import JobQueue from './JobQueue'
import ResizableSidebar from '../layout/ResizableSidebar'
import CollapsibleControlsHeader from '../ui/CollapsibleControlsHeader'
import CollapsibleSection from '../ui/CollapsibleSection'
import CollapsiblePanelHeader from '../ui/CollapsiblePanelHeader'
import ResizableRowPane from '../ui/ResizableRowPane'
import ProjectFileBrowser from '../projects/ProjectFileBrowser'
import {
  Cpu, Play, Square, CheckCircle2, XCircle, AlertTriangle,
  Settings2, Film, Power, FolderOpen, Link2, List, FileVideo, HardDrive,
  Loader2, MonitorPlay, Terminal,
} from 'lucide-react'

const VIDEO_FILE_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v'])

function toAbsoluteProjectPath(projectDir, relPath) {
  if (!projectDir || !relPath) return null
  if (/^[a-zA-Z]:[\\/]/.test(relPath) || relPath.startsWith('/')) return relPath
  return `${projectDir.replace(/[\\/]+$/, '')}/${relPath.replace(/^[\\/]+/, '')}`
}

function getNewestCompositionFile(files, projectDir) {
  if (!Array.isArray(files) || !files.length) return null

  const videoFiles = files.filter(file => VIDEO_FILE_EXTENSIONS.has((file.extension || '').toLowerCase()))
  const composedFiles = videoFiles.filter(file => /^composed_/i.test(file.name || ''))
  const candidates = composedFiles.length ? composedFiles : videoFiles

  if (!candidates.length) return null

  const newest = [...candidates].sort((left, right) => {
    const leftTime = Date.parse(left.modified_at || '') || 0
    const rightTime = Date.parse(right.modified_at || '') || 0
    return rightTime - leftTime
  })[0]

  return toAbsoluteProjectPath(projectDir, newest.path)
}

/**
 * EncodingPanel — GPU-accelerated video encoding UI.
 *
 * Shows: GPU detection, export preset selection, encoding start/cancel controls,
 * real-time progress (FPS, percentage, ETA), and completed job history.
 *
 * Source video auto-populates from the last completed Compose job output.
 *
 * @param {Object} props
 * @param {number} props.projectId - Active project ID
 */
export default function EncodingPanel({ projectId }) {
  const {
    gpuInfo, presets, activeJobs, queuedJobs, recentJobs, completedExports, autoShutdown,
    loading, error,
    detectGpus, refreshGpus, fetchPresets, fetchExports, startEncoding, cancelJob, fetchStatus,
    toggleAutoShutdown,
  } = useEncoding()
  const { recentJobs: composeRecentJobs, fetchStatus: fetchCompositionStatus } = useComposition()
  const { showSuccess, showError } = useToast()

  const [selectedPresetId, setSelectedPresetId] = useState('1080p')
  const [inputFile, setInputFile] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [projectDir, setProjectDir] = useState('')
  const [compositionOptions, setCompositionOptions] = useState([])
  const [persistedComposeOutput, setPersistedComposeOutput] = useState(null)
  const [selectedPreviewOutputFile, setSelectedPreviewOutputFile] = useState('')
  const [presetEditor, setPresetEditor] = useState(null) // { mode, preset }
  const [controlsCollapsed, setControlsCollapsed] = useLocalStorage('lrs:encode:controls:collapsed', false)
  const [controlsWidth, setControlsWidth] = useLocalStorage('lrs:encode:controls:width', 360)
  const [exportsWidth, setExportsWidth] = useLocalStorage('lrs:encode:exports:width', 380)
  const [progressCollapsed, setProgressCollapsed] = useLocalStorage('lrs:encode:progress:collapsed', false)
  const [encoderLogCollapsed, setEncoderLogCollapsed] = useLocalStorage('lrs:encode:log:collapsed', false)
  const controlsWidthRef = useRef(controlsWidth)
  const exportsWidthRef = useRef(exportsWidth)

  useEffect(() => { controlsWidthRef.current = controlsWidth }, [controlsWidth])
  useEffect(() => { exportsWidthRef.current = exportsWidth }, [exportsWidth])

  const recentComposeJobOutput = useMemo(() => {
    if (!Array.isArray(composeRecentJobs)) return null

    return composeRecentJobs.find(
      j => j.output_file && (projectId == null || j.project_id === projectId),
    )?.output_file || null
  }, [composeRecentJobs, projectId])

  const resolvedComposeOutput = persistedComposeOutput || recentComposeJobOutput

  const encodedOutputDir = useMemo(() => {
    if (!projectDir) return ''
    return `${projectDir.replace(/[\\/]+$/, '')}/Encoded`
  }, [projectDir])

  useEffect(() => {
    let cancelled = false

    async function loadPersistedComposeOutput() {
      if (!projectId) {
        setPersistedComposeOutput(null)
        setProjectDir('')
        setCompositionOptions([])
        return
      }

      try {
        const project = await apiGet(`/projects/${projectId}`)
        let resolvedOutput = project?.last_composition_output || null
        const nextProjectDir = project?.project_dir || ''

        const filesView = await apiGet(`/projects/${projectId}/files`)
        const composeCategory = Array.isArray(filesView?.categories)
          ? filesView.categories.find(category => category.name === 'compose')
          : null
        const composeFiles = Array.isArray(composeCategory?.files) ? composeCategory.files : []
        const nextOptions = composeFiles
          .filter(file => VIDEO_FILE_EXTENSIONS.has((file.extension || '').toLowerCase()))
          .sort((left, right) => (Date.parse(right.modified_at || '') || 0) - (Date.parse(left.modified_at || '') || 0))
          .map(file => ({
            value: toAbsoluteProjectPath(filesView?.project_dir || nextProjectDir, file.path),
            label: file.name,
            modifiedAt: file.modified_at || '',
          }))

        if (!resolvedOutput) {
          resolvedOutput = getNewestCompositionFile(composeFiles, filesView?.project_dir || nextProjectDir)
        }

        const resolvedInOptions = resolvedOutput && nextOptions.some(option => option.value === resolvedOutput)
        const mergedOptions = resolvedOutput && !resolvedInOptions
          ? [{ value: resolvedOutput, label: resolvedOutput.split(/[\\/]/).pop() || resolvedOutput, modifiedAt: '' }, ...nextOptions]
          : nextOptions

        if (!cancelled) {
          setProjectDir(nextProjectDir)
          setCompositionOptions(mergedOptions)
          setPersistedComposeOutput(resolvedOutput || null)
        }
      } catch {
        if (!cancelled) {
          setProjectDir('')
          setCompositionOptions([])
          setPersistedComposeOutput(null)
        }
      }
    }

    loadPersistedComposeOutput()

    return () => {
      cancelled = true
    }
  }, [projectId, composeRecentJobs.length])

  // Prime inputFile from last compose output when it becomes available
  // but only if user hasn't manually overridden it.
  const [inputFileManuallySet, setInputFileManuallySet] = useState(false)
  useEffect(() => {
    if (!inputFileManuallySet && resolvedComposeOutput) {
      setInputFile(resolvedComposeOutput)
    }
  }, [resolvedComposeOutput, inputFileManuallySet])

  useEffect(() => {
    if (encodedOutputDir) {
      setOutputDir(encodedOutputDir)
    }
  }, [encodedOutputDir])

  // Detect GPUs, presets, composition status, and existing exports on mount
  useEffect(() => {
    detectGpus()
    fetchPresets()
    fetchStatus()
    fetchCompositionStatus()
    fetchExports()
  }, [detectGpus, fetchPresets, fetchStatus, fetchCompositionStatus, fetchExports])

  const selectedPreset = useMemo(
    () => presets.find(p => p.id === selectedPresetId) || presets[0],
    [presets, selectedPresetId],
  )

  // Active job for this project
  const projectActiveJob = useMemo(
    () => activeJobs.find(j => j.project_id === projectId),
    [activeJobs, projectId],
  )

  const projectRecentJobs = useMemo(
    () => recentJobs.filter(j => (projectId == null || j.project_id === projectId)),
    [recentJobs, projectId],
  )

  const projectCompletedExports = useMemo(
    () => (completedExports || []).filter(exp => (projectId == null || exp.project_id === projectId)),
    [completedExports, projectId],
  )

  const latestCompletedJob = useMemo(
    () => projectRecentJobs.find(j => j.state === 'completed' && j.output_file),
    [projectRecentJobs],
  )

  const latestLoggedJob = useMemo(
    () => projectRecentJobs.find(j => Array.isArray(j.log_entries) && j.log_entries.length > 0) || null,
    [projectRecentJobs],
  )

  const previewOutputFile = selectedPreviewOutputFile
    || projectCompletedExports[0]?.output_file
    || projectActiveJob?.output_file
    || latestCompletedJob?.output_file
    || null
  const previewJob = projectActiveJob || latestCompletedJob || null
  const logJob = projectActiveJob || latestLoggedJob || previewJob || null
  const previewSrc = useMemo(
    () => toVideoSrc(previewOutputFile, projectId, projectDir),
    [previewOutputFile, projectId, projectDir],
  )

  // Auto-select the newest export for preview ONLY when there is no manual
  // selection already. This lets the Play button override without being
  // immediately clobbered on the next render.
  useEffect(() => {
    const newest = projectCompletedExports[0]?.output_file
    if (newest && !selectedPreviewOutputFile) {
      setSelectedPreviewOutputFile(newest)
    }
  }, [projectCompletedExports, selectedPreviewOutputFile])

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleStart = useCallback(async () => {
    if (!inputFile) {
      showError('Select a source video to encode')
      return
    }
    const result = await startEncoding({
      projectId,
      inputFile,
      outputDir: outputDir || encodedOutputDir,
      presetId: selectedPresetId,
      jobType: 'full',
    })
    if (result.success) {
      showSuccess('Encoding job started')
    } else {
      showError(result.error || 'Failed to start encoding')
    }
  }, [projectId, inputFile, outputDir, encodedOutputDir, selectedPresetId, startEncoding, showSuccess, showError])

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

  const handleAutoShutdown = useCallback(async () => {
    await toggleAutoShutdown(!autoShutdown)
  }, [toggleAutoShutdown, autoShutdown])

  const handlePreviewExport = useCallback((exp) => {
    if (!exp?.output_file) return
    setSelectedPreviewOutputFile(exp.output_file)
  }, [])

  const handleRevealExport = useCallback(async (exp) => {
    if (!projectId) return
    const relPath = toProjectRelativePath(exp?.output_file || '', projectDir)
    if (!relPath) {
      showError('Cannot determine file location')
      return
    }
    try {
      await apiPost(`/projects/${projectId}/open-directory`, { path: relPath })
      showSuccess('Opened in file explorer')
    } catch {
      showError('Failed to reveal export')
    }
  }, [projectId, projectDir, showError, showSuccess])

  const startControlsResize = useCallback((e) => {
    const startX = e.clientX
    const startWidth = controlsWidthRef.current

    const onMove = (moveEvt) => {
      const next = startWidth + (moveEvt.clientX - startX)
      setControlsWidth(Math.min(520, Math.max(280, next)))
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [setControlsWidth])

  const startExportsResize = useCallback((e) => {
    const startX = e.clientX
    const startWidth = exportsWidthRef.current

    const onMove = (moveEvt) => {
      const next = startWidth - (moveEvt.clientX - startX)
      setExportsWidth(Math.min(560, Math.max(300, next)))
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [setExportsWidth])

  const queueSidebarContent = (
    <div className="h-full overflow-y-auto p-3 space-y-3">
      <JobQueue
        activeJobs={activeJobs}
        queuedJobs={queuedJobs}
        projectId={projectId}
        onCancel={handleCancel}
      />

      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5 text-text-tertiary" />
          <h3 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">Recent Jobs</h3>
        </div>
        {projectRecentJobs.length > 0 ? (
          <div className="space-y-1.5">
            {projectRecentJobs.slice(0, 10).map((job) => (
              <div
                key={job.job_id}
                className={`flex items-center gap-2 px-2.5 py-2 rounded-md border ${job.state === 'completed' ? 'bg-success/5 border-success/25' : 'bg-danger/5 border-danger/25'}`}
              >
                {job.state === 'completed' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
                ) : (
                  <XCircle className="w-3.5 h-3.5 text-danger shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-text-secondary truncate">{job.preset?.name || 'Encode'} · {job.job_type || 'full'}</p>
                  <p className="text-xxs text-text-tertiary truncate">
                    {job.output_size_bytes > 0 ? formatFileSize(job.output_size_bytes) : 'No file yet'}
                    {job.elapsed_seconds > 0 ? ` · ${formatTime(job.elapsed_seconds)}` : ''}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-border bg-bg-primary px-3 py-4 text-xs text-text-tertiary">
            No project encoding jobs yet.
          </div>
        )}
      </div>
    </div>
  )

  const sidebarTabs = useMemo(() => ([
    {
      id: 'queue',
      label: 'Queue',
      icon: List,
      count: queuedJobs.length + Math.max(0, activeJobs.length - (projectActiveJob ? 1 : 0)),
      content: queueSidebarContent,
    },
    {
      id: 'files',
      label: 'Files',
      icon: FolderOpen,
      content: <ProjectFileBrowser projectId={projectId} />,
    },
  ]), [projectId, queuedJobs.length, activeJobs.length, projectActiveJob, queueSidebarContent])

  const statusBadge = projectActiveJob
    ? { label: 'Encoding', className: 'text-accent bg-accent/8 border-accent/35' }
    : error
      ? { label: 'Error', className: 'text-danger bg-danger/8 border-danger/35' }
      : { label: 'Ready', className: 'text-success bg-success/8 border-success/35' }

  const primaryAction = projectActiveJob
    ? {
      label: 'Cancel',
      icon: Square,
      onClick: () => handleCancel(projectActiveJob.job_id),
      disabled: loading,
      className: 'bg-danger/12 text-danger border-danger/30 hover:bg-danger/18',
    }
    : {
      label: 'Start Encoding',
      icon: Play,
      onClick: handleStart,
      disabled: loading || !gpuInfo?.ffmpeg_available || !inputFile,
      className: 'bg-accent/12 text-accent border-accent/30 hover:bg-accent/18',
    }

  const PrimaryActionIcon = primaryAction.icon

  const controlsContent = (
    <div className="h-full overflow-y-auto bg-bg-secondary space-y-0">
      <div className="border-t border-border-subtle px-2 py-2">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center justify-center rounded-md border px-3 py-2.5 text-sm font-semibold whitespace-nowrap ${statusBadge.className}`}>
            {statusBadge.label}
          </span>
          <button
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled}
            className={`flex-1 inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${primaryAction.className}`}
          >
            <PrimaryActionIcon className="w-4 h-4" />
            {primaryAction.label}
          </button>
        </div>
      </div>

      <CollapsibleSection icon={FileVideo} label="Source Video" storageKey="lrs:encode:controls:source" defaultOpen>
        <select
          value={inputFile}
          onChange={(e) => {
            setInputFile(e.target.value)
            setInputFileManuallySet(true)
          }}
          className="w-full bg-bg-primary border border-border rounded-md px-3 py-2 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent font-mono"
          disabled={compositionOptions.length === 0}
        >
          <option value="">{compositionOptions.length ? 'Select composed video…' : 'No composed videos found'}</option>
          {compositionOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="text-xxs text-text-tertiary mt-1 flex items-center gap-1">
          <Link2 className="w-3 h-3 shrink-0" />
          Choose from videos in the project compositions folder.
        </p>
      </CollapsibleSection>

      <CollapsibleSection icon={HardDrive} label="Encoded Output Folder" storageKey="lrs:encode:controls:output" defaultOpen>
        <input
          type="text"
          value={outputDir}
          readOnly
          placeholder="Project Encoded folder"
          className="w-full bg-bg-primary border border-border rounded-md px-3 py-2 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:ring-1 focus:ring-accent font-mono"
        />
        <p className="text-xxs text-text-tertiary mt-1">
          Encodes are written to the dedicated project Encoded folder, not the compositions folder.
        </p>
      </CollapsibleSection>

      <CollapsibleSection icon={Settings2} label="Export Preset" storageKey="lrs:encode:controls:preset" defaultOpen>
        <PresetSelector
          presets={presets}
          selectedPresetId={selectedPresetId}
          selectedPreset={selectedPreset}
          onSelect={setSelectedPresetId}
          onEdit={(mode, preset) => setPresetEditor({ mode, preset })}
          onCreate={() => setPresetEditor({ mode: 'create', preset: null })}
        />
      </CollapsibleSection>

      <CollapsibleSection icon={Cpu} label="GPU Encoder" storageKey="lrs:encode:controls:gpu" defaultOpen>
        <GPUStatus gpuInfo={gpuInfo} onRefresh={handleRefreshGpus} />
      </CollapsibleSection>

      <CollapsibleSection icon={Power} label="Automation" storageKey="lrs:encode:controls:automation" defaultOpen>
        <div className="flex items-center justify-between px-3 py-2 bg-bg-primary border border-border rounded-md">
          <div>
            <div className="text-xs text-text-secondary">Auto-shutdown</div>
            <div className="text-xxs text-text-tertiary">Shut down when all jobs complete</div>
          </div>
          <button
            onClick={handleAutoShutdown}
            className={`relative w-9 h-5 rounded-full transition-colors ${autoShutdown ? 'bg-accent' : 'bg-bg-hover border border-border'}`}
            role="switch"
            aria-checked={autoShutdown}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${autoShutdown ? 'translate-x-4' : 'translate-x-0.5'}`}
            />
          </button>
        </div>
      </CollapsibleSection>

      {!gpuInfo?.ffmpeg_available && (
        <div className="flex items-start gap-2 px-3 py-2 bg-warning/5 border border-warning/30 rounded-md">
          <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
          <p className="text-xxs text-warning">
            FFmpeg is not installed. Install FFmpeg to encode videos.
          </p>
        </div>
      )}

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
  )

  return (
    <div className="flex flex-col h-full w-full min-w-0 overflow-hidden min-h-0">
      <div className="flex-1 min-h-0 min-w-0 flex overflow-hidden bg-bg-primary">
        <ResizableSidebar
          storageKey="lrs:encode:workspace:sidebar"
          defaultWidth={400}
          defaultTab="files"
          tabs={sidebarTabs}
        />

        {controlsCollapsed && (
          <CollapsibleControlsHeader
            collapsed
            icon={Settings2}
            title="Encoder Controls"
            onExpand={() => setControlsCollapsed(false)}
            expandTitle="Expand Encoder Controls"
          />
        )}

        {!controlsCollapsed && (
          <div
            className="shrink-0 border-r border-border bg-bg-secondary flex flex-col min-h-0"
            style={{ width: controlsWidth }}
          >
            <CollapsibleControlsHeader
              collapsed={false}
              icon={Settings2}
              title="Encoder Controls"
              onCollapse={() => setControlsCollapsed(true)}
            />
            <div className="flex-1 min-h-0 overflow-hidden">
              {controlsContent}
            </div>
          </div>
        )}

        {!controlsCollapsed && (
          <div
            className="shrink-0 cursor-col-resize group/divider relative"
            style={{ width: 1, marginLeft: -1 }}
            onMouseDown={startControlsResize}
          >
            <div className="absolute inset-y-0 -left-2 -right-2 z-20" />
          </div>
        )}

        <div className="flex-1 min-h-0 min-w-0 overflow-hidden bg-bg-primary">
          <ResizableRowPane
            storageKey="lrs:encode:workspace:split"
            defaultBottomHeight={260}
            minBottom={150}
            top={(
              <div className="flex flex-col h-full min-h-0">
                <div className="flex items-center border-b border-border bg-bg-secondary shrink-0">
                  <CollapsiblePanelHeader
                    open
                    icon={MonitorPlay}
                    title={projectActiveJob ? 'Encoding Preview (Pending)' : 'Encoding Preview'}
                    className="flex-1"
                    status={projectActiveJob ? <EncodingBadge state="encoding" /> : <EncodingBadge state="idle" />}
                  />
                </div>
                <div className="flex-1 min-h-0 overflow-hidden bg-black/30">
                  {previewSrc ? (
                    <video
                      key={previewSrc}
                      src={previewSrc}
                      controls
                      preload="metadata"
                      className="h-full w-full bg-black object-contain"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center px-6 text-center bg-bg-secondary">
                      <div>
                        {projectActiveJob ? (
                          <>
                            <Loader2 className="w-5 h-5 mx-auto mb-2 text-accent animate-spin" />
                            <p className="text-sm text-text-secondary font-medium">Preview is pending while encoder writes output.</p>
                            <p className="text-xs text-text-tertiary mt-1">The player will appear as soon as an output file is available.</p>
                          </>
                        ) : (
                          <>
                            <MonitorPlay className="w-5 h-5 mx-auto mb-2 text-text-tertiary" />
                            <p className="text-sm text-text-secondary font-medium">No preview file available yet.</p>
                            <p className="text-xs text-text-tertiary mt-1">Run an encode to generate output, then review it here.</p>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            bottom={(
              <div className="h-full min-h-0 overflow-hidden flex flex-col">
                <div className="flex items-center border-b border-border bg-bg-secondary shrink-0">
                  <CollapsiblePanelHeader
                    open={!progressCollapsed}
                    onToggle={() => setProgressCollapsed((prev) => !prev)}
                    icon={Film}
                    title="Encoding Progress"
                    subtitle={previewOutputFile ? (previewOutputFile.split(/[\\/]/).pop() || 'Preview ready') : 'Waiting for job'}
                    className="flex-1"
                    status={<StepBadge step={(projectActiveJob || latestCompletedJob)?.current_step || (projectActiveJob || latestCompletedJob)?.progress?.current_step || 'idle'} />}
                  />
                </div>

                {!progressCollapsed && (
                  <div className="flex-1 min-h-0 overflow-y-auto bg-bg-primary">
                    {(projectActiveJob || latestCompletedJob) ? (
                      <div className="space-y-3 p-3">
                        <EncodingDashboard job={projectActiveJob || latestCompletedJob} gpuInfo={gpuInfo} />
                        {projectActiveJob ? (
                          <button
                            onClick={() => handleCancel(projectActiveJob.job_id)}
                            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-medium bg-danger hover:bg-danger/90 text-white transition-colors"
                          >
                            <Square className="w-3.5 h-3.5" />
                            Cancel Encoding
                          </button>
                        ) : (
                          <div className="flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-medium border border-success/40 text-success bg-success/8">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Encoding complete
                            {latestCompletedJob?.preset?.name ? ` · ${latestCompletedJob.preset.name}` : ''}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="w-full h-full bg-bg-secondary flex items-center justify-center px-6 text-center">
                        <div>
                          <p className="text-sm text-text-secondary font-medium">No encode currently running for this project.</p>
                          <p className="text-xs text-text-tertiary mt-1">Start an encode from the controls column to view live metrics here.</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          />
        </div>

        <div
          className="shrink-0 cursor-col-resize group/divider relative"
          style={{ width: 1, marginLeft: -1 }}
          onMouseDown={startExportsResize}
        >
          <div className="absolute inset-y-0 -left-2 -right-2 z-20" />
        </div>

        <div className="shrink-0 border-l border-border bg-bg-secondary min-h-0 flex flex-col" style={{ width: exportsWidth }}>
          <ResizableRowPane
            storageKey="lrs:encode:right:split"
            defaultBottomHeight={240}
            minBottom={130}
            maxBottom={520}
            top={(
              <div className="h-full min-h-0 overflow-hidden flex flex-col">
                <div className="flex items-center border-b border-border bg-bg-secondary shrink-0">
                  <CollapsiblePanelHeader
                    open
                    icon={FolderOpen}
                    title="Completed Exports"
                    className="flex-1"
                  />
                </div>
                <div className="flex-1 min-h-0 overflow-hidden p-2">
                  <CompletedExports
                    projectId={projectId}
                    selectedOutputFile={selectedPreviewOutputFile}
                    onPlay={handlePreviewExport}
                    onReveal={handleRevealExport}
                  />
                </div>
              </div>
            )}
            bottom={(
              <div className="h-full min-h-0 overflow-hidden flex flex-col">
                <div className="flex items-center border-b border-border bg-bg-secondary shrink-0">
                  <CollapsiblePanelHeader
                    open={!encoderLogCollapsed}
                    onToggle={() => setEncoderLogCollapsed((prev) => !prev)}
                    icon={Terminal}
                    title="Encoder Log"
                    subtitle={logJob?.job_id ? `Job ${logJob.job_id}` : 'Waiting for encoder activity'}
                    className="flex-1"
                  />
                </div>
                {!encoderLogCollapsed && (
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <EncoderLogPanel job={logJob} />
                  </div>
                )}
              </div>
            )}
          />
        </div>
      </div>

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

function toProjectRelativePath(path, projectDir) {
  if (!path || typeof path !== 'string') return null

  const normalized = path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized) return null
  if (normalized.includes('..')) return null

  // Best: strip the known projectDir prefix to get a clean relative path.
  if (projectDir) {
    const base = projectDir.trim().replace(/\\/g, '/').replace(/\/*$/, '') + '/'
    if (normalized.toLowerCase().startsWith(base.toLowerCase())) {
      const rel = normalized.slice(base.length)
      if (rel) return rel
    }
  }

  // Fallback: find the first well-known subfolder name in the path.
  const projectRoots = new Set(['captures', 'clips', 'preview', 'exports', 'encoded', 'compositions', 'overlays', 'logs', 'replay'])
  const parts = normalized.split('/').filter(Boolean)
  const rootIndex = parts.findIndex((part) => projectRoots.has(String(part).toLowerCase()))
  if (rootIndex >= 0) {
    return parts.slice(rootIndex).join('/')
  }

  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//')) {
    return null
  }

  return normalized
}

function toVideoSrc(path, projectId, projectDir) {
  if (!path || typeof path !== 'string') return null
  if (/^(https?:|data:|blob:)/i.test(path)) return path
  if (path.startsWith('/api/projects/')) return path

  const candidatePath = path.startsWith('/') ? path.replace(/^\/+/, '') : path
  if (path.startsWith('/') && (path.startsWith('//') || path.startsWith('/api/'))) return null

  const relPath = toProjectRelativePath(candidatePath, projectDir)
  if (!relPath || !projectId) return null

  return `/api/projects/${projectId}/files/serve?path=${encodeURIComponent(relPath)}`
}

function toStepLabel(step) {
  if (!step) return 'idle'
  return String(step).replace(/_/g, ' ')
}

function StepBadge({ step }) {
  const normalized = String(step || 'idle').toLowerCase()
  const isError = normalized.includes('error')
  const isDone = normalized === 'completed'
  const isBusy = !isError && !isDone && normalized !== 'idle'
  const cls = isError
    ? 'text-danger bg-danger/8 border-danger/35'
    : isDone
      ? 'text-success bg-success/8 border-success/35'
      : isBusy
        ? 'text-accent bg-accent/8 border-accent/35'
        : 'text-text-tertiary bg-bg-primary border-border'

  return (
    <span className={`px-2 py-0.5 rounded-full text-xxs font-medium border ${cls}`}>
      Step: {toStepLabel(step)}
    </span>
  )
}

function EncoderLogPanel({ job }) {
  const entries = Array.isArray(job?.log_entries) ? job.log_entries : []

  if (!entries.length) {
    return (
      <div className="h-full flex items-center justify-center px-4 text-center text-xs text-text-tertiary bg-bg-primary">
        No encoder logs yet. Start an encoding job to stream detailed activity here.
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto font-mono bg-bg-primary">
      {entries.map((entry, idx) => {
        const level = String(entry.level || 'info').toLowerCase()
        const levelClass = level === 'error'
          ? 'text-danger'
          : level === 'command'
            ? 'text-accent'
            : level === 'success'
              ? 'text-success'
              : level === 'ffmpeg'
                ? 'text-warning'
                : 'text-text-secondary'

        return (
          <div key={`${entry.ts || 0}-${idx}`} className="px-3 py-2 border-b border-border-subtle/40">
            <div className="flex items-center gap-2 text-xxs">
              <span className="text-text-disabled">
                {entry.ts ? new Date(entry.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--:--'}
              </span>
              <span className={`uppercase tracking-wide ${levelClass}`}>{level}</span>
              <span className="text-text-primary truncate">{entry.message || ''}</span>
            </div>
            {entry.detail && (
              <pre className="mt-1 whitespace-pre-wrap break-words text-xxs text-text-tertiary">{entry.detail}</pre>
            )}
          </div>
        )
      })}
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

