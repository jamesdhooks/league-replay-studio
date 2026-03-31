import { createContext, useContext, useState, useCallback, useMemo } from 'react'
import { apiGet, apiPost, apiPut, apiDelete } from '../services/api'

/**
 * @typedef {Object} Project
 * @property {number} id
 * @property {string} name
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string} track_name
 * @property {string} session_type
 * @property {number} num_drivers
 * @property {number} num_laps
 * @property {string} replay_file
 * @property {string} project_dir
 * @property {string} current_step
 */

const ProjectContext = createContext(null)

/**
 * Provides project state management — list, active project, CRUD operations.
 */
export function ProjectProvider({ children }) {
  const [projects, setProjects] = useState([])
  const [activeProject, setActiveProject] = useState(null)
  const [loading, setLoading] = useState(false)

  // ── Fetch all projects ──────────────────────────────────────────────────

  const fetchProjects = useCallback(async (params = {}) => {
    setLoading(true)
    try {
      const query = new URLSearchParams()
      if (params.search) query.set('search', params.search)
      if (params.track) query.set('track', params.track)
      if (params.step) query.set('step', params.step)
      if (params.sort_by) query.set('sort_by', params.sort_by)
      if (params.sort_dir) query.set('sort_dir', params.sort_dir)
      const qs = query.toString()
      const data = await apiGet(`/projects${qs ? `?${qs}` : ''}`)
      setProjects(data)
      return data
    } catch {
      setProjects([])
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Create project ──────────────────────────────────────────────────────

  const createProject = useCallback(async (projectData) => {
    const created = await apiPost('/projects', projectData)
    setProjects(prev => [created, ...prev])
    return created
  }, [])

  // ── Open / close project ────────────────────────────────────────────────

  const openProject = useCallback(async (projectId) => {
    const project = await apiGet(`/projects/${projectId}`)
    setActiveProject(project)
    return project
  }, [])

  const closeProject = useCallback(() => {
    setActiveProject(null)
  }, [])

  // ── Update project ──────────────────────────────────────────────────────

  const updateProject = useCallback(async (projectId, updates) => {
    const updated = await apiPut(`/projects/${projectId}`, updates)
    setProjects(prev => prev.map(p => p.id === projectId ? updated : p))
    if (activeProject?.id === projectId) {
      setActiveProject(updated)
    }
    return updated
  }, [activeProject])

  // ── Delete project ──────────────────────────────────────────────────────

  const deleteProject = useCallback(async (projectId, deleteFiles = false) => {
    await apiDelete(`/projects/${projectId}?delete_files=${deleteFiles}`)
    setProjects(prev => prev.filter(p => p.id !== projectId))
    if (activeProject?.id === projectId) {
      setActiveProject(null)
    }
  }, [activeProject])

  // ── Duplicate project ───────────────────────────────────────────────────

  const duplicateProject = useCallback(async (projectId) => {
    const duplicated = await apiPost(`/projects/${projectId}/duplicate`)
    setProjects(prev => [duplicated, ...prev])
    return duplicated
  }, [])

  // ── Step navigation ─────────────────────────────────────────────────────

  const getStepStatus = useCallback(async (projectId) => {
    return await apiGet(`/projects/${projectId}/step`)
  }, [])

  const setStep = useCallback(async (projectId, step) => {
    const updated = await apiPut(`/projects/${projectId}/step`, { step })
    if (activeProject?.id === projectId) {
      setActiveProject(updated)
    }
    setProjects(prev => prev.map(p => p.id === projectId ? updated : p))
    return updated
  }, [activeProject])

  const advanceStep = useCallback(async (projectId) => {
    const updated = await apiPut(`/projects/${projectId}/step`, { action: 'advance' })
    if (activeProject?.id === projectId) {
      setActiveProject(updated)
    }
    setProjects(prev => prev.map(p => p.id === projectId ? updated : p))
    return updated
  }, [activeProject])

  // ── File browser ────────────────────────────────────────────────────────

  const getProjectFiles = useCallback(async (projectId) => {
    return await apiGet(`/projects/${projectId}/files`)
  }, [])

  // ── Replay discovery ────────────────────────────────────────────────────

  const discoverReplays = useCallback(async (directory = '') => {
    const qs = directory ? `?directory=${encodeURIComponent(directory)}` : ''
    return await apiGet(`/replays/discover${qs}`)
  }, [])

  const value = useMemo(() => ({
    projects,
    activeProject,
    loading,
    fetchProjects,
    createProject,
    openProject,
    closeProject,
    updateProject,
    deleteProject,
    duplicateProject,
    getStepStatus,
    setStep,
    advanceStep,
    getProjectFiles,
    discoverReplays,
  }), [
    projects, activeProject, loading,
    fetchProjects, createProject, openProject, closeProject,
    updateProject, deleteProject, duplicateProject,
    getStepStatus, setStep, advanceStep,
    getProjectFiles, discoverReplays,
  ])

  return (
    <ProjectContext.Provider value={value}>
      {children}
    </ProjectContext.Provider>
  )
}

/**
 * Hook to access project state and operations.
 */
export function useProject() {
  const context = useContext(ProjectContext)
  if (!context) {
    throw new Error('useProject must be used within a ProjectProvider')
  }
  return context
}
