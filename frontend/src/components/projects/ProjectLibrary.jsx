import { useState, useEffect, useCallback } from 'react'
import {
  Plus,
  Search,
  LayoutGrid,
  List,
  SlidersHorizontal,
} from 'lucide-react'
import { useProject } from '../../context/ProjectContext'
import { useToast } from '../../context/ToastContext'
import { useModal } from '../../context/ModalContext'
import { useIRacing } from '../../context/IRacingContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { apiGet } from '../../services/api'
import ProjectCard from './ProjectCard'
import NewProjectWizard from './NewProjectWizard'

/**
 * Project library — grid/list view with search, filter, and CRUD actions.
 *
 * @param {Object} props
 * @param {(project: Object) => void} props.onOpenProject - Callback when a project is opened
 */
function ProjectLibrary({ onOpenProject }) {
  const {
    projects,
    loading,
    fetchProjects,
    openProject,
    deleteProject,
    duplicateProject,
  } = useProject()
  const { showSuccess, showError } = useToast()
  const { openModal } = useModal()
  const { isConnected, subsessionId } = useIRacing()

  const [viewMode, setViewMode] = useLocalStorage('project_view_mode', 'grid')
  const [search, setSearch] = useState('')
  const [filterStep, setFilterStep] = useState('')
  const [filterTrack, setFilterTrack] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)
  // Set of project IDs whose saved session fingerprint matches the live iRacing session
  const [replayMatchIds, setReplayMatchIds] = useState(new Set())
  const [replayPlaying, setReplayPlaying] = useState(false)

  // Load projects on mount and when filters change
  useEffect(() => {
    fetchProjects({ search, step: filterStep, track: filterTrack })
  }, [fetchProjects, search, filterStep, filterTrack])

  // Poll for the project whose replay is currently loaded in iRacing (every 5 s)
  useEffect(() => {
    if (!isConnected) {
      setReplayMatchIds(new Set())
      setReplayPlaying(false)
      return
    }
    const poll = () => {
      apiGet('/iracing/matching-projects')
        .then(data => {
          setReplayMatchIds(new Set(data.matching_project_ids || []))
          setReplayPlaying(!!data.replay_playing)
        })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [isConnected, subsessionId])

  const handleOpen = useCallback(async (projectId) => {
    try {
      const project = await openProject(projectId)
      onOpenProject?.(project)
    } catch (err) {
      showError('Failed to open project')
    }
  }, [openProject, onOpenProject, showError])

  const handleDuplicate = useCallback(async (projectId) => {
    try {
      const dup = await duplicateProject(projectId)
      showSuccess(`Project duplicated as "${dup.name}"`)
    } catch {
      showError('Failed to duplicate project')
    }
  }, [duplicateProject, showSuccess, showError])

  const handleDelete = useCallback((projectId) => {
    const project = projects.find(p => p.id === projectId)
    openModal('delete-project', 'confirm', {
      title: 'Delete Project',
      message: `Are you sure you want to delete "${project?.name || 'this project'}"?\n\nThe project files on disk will not be deleted.`,
      confirmText: 'Delete',
      danger: true,
      onConfirm: async () => {
        try {
          await deleteProject(projectId, false)
          showSuccess('Project deleted')
        } catch {
          showError('Failed to delete project')
        }
      },
    })
  }, [projects, openModal, deleteProject, showSuccess, showError])

  const handleCreated = useCallback((project) => {
    onOpenProject?.(project)
  }, [onOpenProject])

  // Extract unique track names for filter dropdown
  const uniqueTracks = [...new Set(projects.map(p => p.track_name).filter(Boolean))].sort()

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        {/* Search */}
        <div className="flex-1 relative">
          <Search className="w-3.5 h-3.5 text-text-tertiary absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects..."
            className="w-full pl-9 pr-3 py-1.5 bg-bg-primary border border-border rounded-lg text-sm
                       text-text-primary placeholder:text-text-disabled
                       focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
          />
        </div>

        {/* Filter toggle */}
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`p-1.5 rounded-md transition-colors ${
            showFilters || filterStep || filterTrack
              ? 'bg-accent/10 text-accent'
              : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
          }`}
          title="Filters"
        >
          <SlidersHorizontal className="w-4 h-4" />
        </button>

        {/* View mode toggle */}
        <div className="flex items-center border border-border rounded-md overflow-hidden">
          <button
            onClick={() => setViewMode('grid')}
            className={`p-1.5 transition-colors ${
              viewMode === 'grid' ? 'bg-surface text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
            }`}
            title="Grid view"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`p-1.5 transition-colors ${
              viewMode === 'list' ? 'bg-surface text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
            }`}
            title="List view"
          >
            <List className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* New project button */}
        <button
          onClick={() => setWizardOpen(true)}
          className="flex items-center gap-1.5 px-3.5 py-1.5 bg-gradient-to-r from-gradient-from to-gradient-to
                     hover:from-gradient-via hover:to-gradient-from
                     text-white rounded-lg text-sm font-semibold transition-all duration-200
                     shadow-glow-sm hover:shadow-glow"
        >
          <Plus className="w-4 h-4" />
          New Project
        </button>
      </div>

      {/* Filter bar */}
      {showFilters && (
        <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-bg-secondary shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xxs text-text-tertiary">Step:</span>
            <select
              value={filterStep}
              onChange={(e) => setFilterStep(e.target.value)}
              className="px-2 py-1 bg-bg-primary border border-border rounded-md text-xs
                         text-text-primary focus:outline-none focus:border-accent"
            >
              <option value="">All</option>
              <option value="setup">Setup</option>
              <option value="capture">Capture</option>
              <option value="analysis">Analysis</option>
              <option value="editing">Editing</option>
              <option value="export">Export</option>
              <option value="upload">Upload</option>
            </select>
          </div>

          {uniqueTracks.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xxs text-text-tertiary">Track:</span>
              <select
                value={filterTrack}
                onChange={(e) => setFilterTrack(e.target.value)}
                className="px-2 py-1 bg-bg-primary border border-border rounded-md text-xs
                           text-text-primary focus:outline-none focus:border-accent"
              >
                <option value="">All</option>
                {uniqueTracks.map(track => (
                  <option key={track} value={track}>{track}</option>
                ))}
              </select>
            </div>
          )}

          {(filterStep || filterTrack) && (
            <button
              onClick={() => { setFilterStep(''); setFilterTrack('') }}
              className="text-xxs text-accent hover:text-accent-hover transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Project grid/list */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading && projects.length === 0 ? (
          <div className="text-center py-12 text-sm text-text-tertiary">
            Loading projects...
          </div>
        ) : projects.length === 0 ? (
          <EmptyState onNewProject={() => setWizardOpen(true)} />
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {projects.map(project => (
              <ProjectCard
                key={project.id}
                project={project}
                viewMode="grid"
                onOpen={handleOpen}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
                replayActive={replayMatchIds.has(project.id) && replayPlaying}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {projects.map(project => (
              <ProjectCard
                key={project.id}
                project={project}
                viewMode="list"
                onOpen={handleOpen}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
                replayActive={replayMatchIds.has(project.id) && replayPlaying}
              />
            ))}
          </div>
        )}
      </div>

      {/* New Project Wizard */}
      {wizardOpen && (
        <NewProjectWizard
          onClose={() => setWizardOpen(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  )
}

/**
 * Empty state shown when no projects exist.
 */
function EmptyState({ onNewProject }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 space-y-5">
      <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-gradient-from via-gradient-via to-gradient-to
                      flex items-center justify-center shadow-glow">
        <svg
          className="w-10 h-10 text-white"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z"
          />
        </svg>
      </div>
      <h2 className="text-2xl font-extrabold text-gradient">
        League Replay Studio
      </h2>
      <p className="text-sm text-text-secondary max-w-md text-center leading-relaxed">
        Professional iRacing replay editor. Create a new project or open an existing one to get started.
      </p>
      <button
        onClick={onNewProject}
        className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-gradient-from to-gradient-to
                   hover:from-gradient-via hover:to-gradient-from
                   text-white rounded-xl text-sm font-semibold transition-all duration-200
                   shadow-glow-sm hover:shadow-glow mt-2"
      >
        <Plus className="w-4 h-4" />
        Create Your First Project
      </button>
    </div>
  )
}

export default ProjectLibrary
