import { useState, useEffect } from 'react'
import { X, FolderOpen, FileSearch, ChevronRight } from 'lucide-react'
import { useProject } from '../../context/ProjectContext'
import { useToast } from '../../context/ToastContext'
import { formatFileSize } from '../../utils/format'

/**
 * New Project Wizard — multi-step dialog for creating a new project.
 *
 * Steps:
 * 1. Project name
 * 2. Replay file selection (auto-discover .rpy or browse)
 * 3. Review & create
 *
 * @param {Object} props
 * @param {() => void} props.onClose
 * @param {(project: Object) => void} [props.onCreated]
 */
function NewProjectWizard({ onClose, onCreated }) {
  const { createProject, discoverReplays } = useProject()
  const { showSuccess, showError } = useToast()

  const [step, setStep] = useState(1)
  const [name, setName] = useState('')
  const [replayFile, setReplayFile] = useState('')
  const [trackName, setTrackName] = useState('')
  const [creating, setCreating] = useState(false)

  // Replay discovery
  const [discoveredFiles, setDiscoveredFiles] = useState([])
  const [discovering, setDiscovering] = useState(false)
  const [replaySearch, setReplaySearch] = useState('')
  const hasDiscovered = useState(false)

  // Discover replays on step 2
  useEffect(() => {
    if (step === 2 && !hasDiscovered[0] && !discovering) {
      setDiscovering(true)
      hasDiscovered[0] = true
      discoverReplays()
        .then(files => setDiscoveredFiles(files))
        .catch(() => setDiscoveredFiles([]))
        .finally(() => setDiscovering(false))
    }
  }, [step, discovering, discoverReplays, hasDiscovered])

  const filteredFiles = replaySearch
    ? discoveredFiles.filter(f =>
        f.name.toLowerCase().includes(replaySearch.toLowerCase()) ||
        f.directory.toLowerCase().includes(replaySearch.toLowerCase())
      )
    : discoveredFiles

  const handleCreate = async () => {
    setCreating(true)
    try {
      const project = await createProject({
        name: name.trim(),
        replay_file: replayFile,
        track_name: trackName,
        session_type: 'race',
      })
      showSuccess(`Project "${project.name}" created`)
      onCreated?.(project)
      onClose()
    } catch (err) {
      showError(err.message || 'Failed to create project')
    } finally {
      setCreating(false)
    }
  }

  const canProceed = () => {
    if (step === 1) return name.trim().length > 0
    if (step === 2) return true // Replay is optional
    return true
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-bg-tertiary border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4 animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <FolderOpen className="w-5 h-5 text-accent" />
            <h3 className="text-base font-semibold text-text-primary">New Project</h3>
            <span className="text-xxs text-text-tertiary ml-2">Step {step} of 3</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-surface-hover transition-colors"
          >
            <X className="w-4 h-4 text-text-tertiary" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 min-h-[240px]">
          {step === 1 && (
            <Step1_Name
              name={name}
              setName={setName}
              trackName={trackName}
              setTrackName={setTrackName}
            />
          )}
          {step === 2 && (
            <Step2_Replay
              replayFile={replayFile}
              setReplayFile={setReplayFile}
              discoveredFiles={filteredFiles}
              discovering={discovering}
              replaySearch={replaySearch}
              setReplaySearch={setReplaySearch}
            />
          )}
          {step === 3 && (
            <Step3_Review
              name={name}
              replayFile={replayFile}
              trackName={trackName}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border">
          <button
            onClick={step > 1 ? () => setStep(step - 1) : onClose}
            className="px-4 py-2 text-sm font-medium text-text-secondary
                       hover:text-text-primary hover:bg-surface-hover rounded-lg transition-colors"
          >
            {step > 1 ? 'Back' : 'Cancel'}
          </button>

          {step < 3 ? (
            <button
              onClick={() => setStep(step + 1)}
              disabled={!canProceed()}
              className="flex items-center gap-1 px-4 py-2 bg-accent hover:bg-accent-hover
                         text-white rounded-lg text-sm font-medium transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={handleCreate}
              disabled={creating || !name.trim()}
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg
                         text-sm font-medium transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? 'Creating...' : 'Create Project'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Step Components ──────────────────────────────────────────────────────────

function Step1_Name({ name, setName, trackName, setTrackName }) {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-text-primary mb-1.5">
          Project Name <span className="text-danger">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Daytona 500 Sprint Race"
          autoFocus
          className="w-full px-3 py-2 bg-bg-primary border border-border rounded-lg text-sm
                     text-text-primary placeholder:text-text-disabled
                     focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-text-primary mb-1.5">
          Track Name
        </label>
        <input
          type="text"
          value={trackName}
          onChange={(e) => setTrackName(e.target.value)}
          placeholder="e.g. Daytona International Speedway"
          className="w-full px-3 py-2 bg-bg-primary border border-border rounded-lg text-sm
                     text-text-primary placeholder:text-text-disabled
                     focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
        />
      </div>
    </div>
  )
}

function Step2_Replay({ replayFile, setReplayFile, discoveredFiles, discovering, replaySearch, setReplaySearch }) {

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-text-primary mb-1.5">
          Replay File <span className="text-text-tertiary">(optional)</span>
        </label>
        <input
          type="text"
          value={replayFile}
          onChange={(e) => setReplayFile(e.target.value)}
          placeholder="Path to .rpy file (or select below)"
          className="w-full px-3 py-2 bg-bg-primary border border-border rounded-lg text-sm
                     text-text-primary placeholder:text-text-disabled
                     focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
        />
      </div>

      {/* Discovered files */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <FileSearch className="w-4 h-4 text-text-tertiary" />
          <span className="text-xs text-text-secondary">
            {discovering ? 'Scanning for replay files...' : `${discoveredFiles.length} replay files found`}
          </span>
        </div>

        {discoveredFiles.length > 5 && (
          <input
            type="text"
            value={replaySearch}
            onChange={(e) => setReplaySearch(e.target.value)}
            placeholder="Search replays..."
            className="w-full px-3 py-1.5 mb-2 bg-bg-primary border border-border rounded-lg text-xs
                       text-text-primary placeholder:text-text-disabled
                       focus:outline-none focus:border-accent"
          />
        )}

        <div className="max-h-36 overflow-y-auto space-y-1 rounded-lg border border-border bg-bg-primary p-1">
          {discovering && (
            <div className="px-3 py-4 text-center text-xs text-text-tertiary">
              Scanning iRacing replays directory...
            </div>
          )}
          {!discovering && discoveredFiles.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-text-tertiary">
              No .rpy files found. Enter a path manually above.
            </div>
          )}
          {discoveredFiles.map((file, idx) => (
            <button
              key={idx}
              onClick={() => setReplayFile(file.path)}
              className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors ${
                replayFile === file.path
                  ? 'bg-accent/10 text-accent border border-accent/30'
                  : 'hover:bg-surface-hover text-text-secondary'
              }`}
            >
              <div className="font-medium truncate">{file.name}</div>
              <div className="text-xxs text-text-tertiary mt-0.5 flex items-center gap-2">
                <span>{formatFileSize(file.size_bytes)}</span>
                <span>·</span>
                <span>{new Date(file.modified_at).toLocaleDateString()}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function Step3_Review({ name, replayFile, trackName }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">
        Review your project settings and click <strong>Create Project</strong> to get started.
      </p>

      <div className="bg-bg-primary rounded-lg border border-border divide-y divide-border">
        <ReviewRow label="Project Name" value={name} />
        <ReviewRow label="Track" value={trackName || '—'} />
        <ReviewRow
          label="Replay File"
          value={replayFile ? replayFile.split(/[/\\]/).pop() : 'None selected'}
          muted={!replayFile}
        />
      </div>

      <p className="text-xxs text-text-tertiary">
        A project directory will be created automatically with subdirectories for captures,
        exports, previews, and overlays.
      </p>
    </div>
  )
}

function ReviewRow({ label, value, muted = false }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-xs text-text-tertiary">{label}</span>
      <span className={`text-xs font-medium ${muted ? 'text-text-disabled' : 'text-text-primary'} truncate max-w-[60%] text-right`}>
        {value}
      </span>
    </div>
  )
}

export default NewProjectWizard
