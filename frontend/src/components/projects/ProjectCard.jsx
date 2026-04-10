import { Calendar, Users, Flag, MoreVertical, Copy, Trash2, Play } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import StepIndicator from './StepIndicator'

/**
 * Project card for the project library.
 * Supports both grid and list view modes.
 *
 * @param {Object} props
 * @param {Object} props.project
 * @param {'grid' | 'list'} props.viewMode
 * @param {(id: number) => void} props.onOpen
 * @param {(id: number) => void} props.onDuplicate
 * @param {(id: number) => void} props.onDelete
 */
function ProjectCard({ project, viewMode = 'grid', onOpen, onDuplicate, onDelete, replayActive = false }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

  const formattedDate = project.created_at
    ? new Date(project.created_at).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
      })
    : ''

  if (viewMode === 'list') {
    return (
      <div
        className={`flex items-center gap-4 px-4 py-3 bg-surface hover:bg-surface-hover
                   border rounded-lg cursor-pointer transition-all duration-200 group
                   shadow-card hover:shadow-card-hover ${
                     replayActive
                       ? 'border-accent shadow-glow-sm'
                       : 'border-border hover:border-border-strong'
                   }`}
        onClick={() => onOpen(project.id)}
      >
        {/* Replay active badge */}
        {replayActive && (
          <div className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-md
                          bg-accent/15 text-accent text-xxs font-medium">
            <Play className="w-2.5 h-2.5 fill-current" />
            Live
          </div>
        )}

        {/* Name + track */}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-text-primary truncate">
            {project.name}
          </h3>
          <p className="text-xxs text-text-tertiary truncate mt-0.5">
            {project.track_name || 'No track'} · {formattedDate}
          </p>
        </div>

        {/* Step indicator */}
        <div className="shrink-0">
          <StepIndicator currentStep={project.current_step} compact />
        </div>

        {/* Drivers */}
        {project.num_drivers > 0 && (
          <div className="flex items-center gap-1 text-xxs text-text-tertiary shrink-0">
            <Users className="w-3 h-3" />
            <span>{project.num_drivers}</span>
          </div>
        )}

        {/* Actions menu */}
        <div className="relative shrink-0" ref={menuRef}>
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen) }}
            className="p-1 rounded-md hover:bg-bg-secondary transition-colors
                       opacity-0 group-hover:opacity-100"
          >
            <MoreVertical className="w-4 h-4 text-text-tertiary" />
          </button>
          {menuOpen && (
            <ContextMenu
              onDuplicate={() => { setMenuOpen(false); onDuplicate(project.id) }}
              onDelete={() => { setMenuOpen(false); onDelete(project.id) }}
            />
          )}
        </div>
      </div>
    )
  }

  // Grid view
  return (
    <div
      className={`flex flex-col bg-surface hover:bg-surface-hover border
                 rounded-xl cursor-pointer transition-all duration-200 group overflow-hidden
                 shadow-card hover:shadow-card-hover ${
                   replayActive
                     ? 'border-accent shadow-glow-sm'
                     : 'border-border hover:border-border-strong'
                 }`}
      onClick={() => onOpen(project.id)}
    >
      {/* Thumbnail area */}
      <div className="h-28 bg-bg-tertiary flex items-center justify-center relative overflow-hidden">
        {/* Subtle gradient band at top */}
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-gradient-from via-gradient-via to-gradient-to opacity-60" />
        <Flag className="w-8 h-8 text-text-disabled" />

        {/* Replay-active badge */}
        {replayActive && (
          <div className="absolute top-2 left-2 flex items-center gap-1 px-1.5 py-0.5 rounded-md
                          bg-accent/90 text-white text-xxs font-semibold shadow-sm">
            <Play className="w-2.5 h-2.5 fill-current" />
            Replay Playing
          </div>
        )}
        {/* Context menu button */}
        <div className="absolute top-2 right-2" ref={menuRef}>
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen) }}
            className="p-1 rounded-md bg-bg-primary/60 hover:bg-bg-primary/80 transition-colors
                       opacity-0 group-hover:opacity-100"
          >
            <MoreVertical className="w-3.5 h-3.5 text-text-secondary" />
          </button>
          {menuOpen && (
            <ContextMenu
              onDuplicate={() => { setMenuOpen(false); onDuplicate(project.id) }}
              onDelete={() => { setMenuOpen(false); onDelete(project.id) }}
            />
          )}
        </div>
      </div>

      {/* Card body */}
      <div className="p-3 space-y-2">
        <h3 className="text-sm font-medium text-text-primary truncate">
          {project.name}
        </h3>

        {/* Meta info */}
        <div className="flex items-center gap-3 text-xxs text-text-tertiary">
          {project.track_name && (
            <span className="truncate">{project.track_name}</span>
          )}
          {formattedDate && (
            <span className="flex items-center gap-1 shrink-0">
              <Calendar className="w-3 h-3" />
              {formattedDate}
            </span>
          )}
        </div>

        {/* Step indicator */}
        <StepIndicator currentStep={project.current_step} compact />

        {/* Bottom meta */}
        <div className="flex items-center gap-3 text-xxs text-text-tertiary pt-1">
          {project.num_drivers > 0 && (
            <span className="flex items-center gap-1">
              <Users className="w-3 h-3" />
              {project.num_drivers} drivers
            </span>
          )}
          {project.session_type && (
            <span className="capitalize">{project.session_type}</span>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Context menu for project actions.
 */
function ContextMenu({ onDuplicate, onDelete }) {
  return (
    <div
      className="absolute right-0 top-full mt-1 z-20 w-40 bg-bg-tertiary border border-border
                    rounded-lg shadow-xl py-1 animate-fade-in"
      onClick={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
    >
      <button
        onClick={onDuplicate}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-text-secondary
                   hover:bg-surface-hover hover:text-text-primary transition-colors"
      >
        <Copy className="w-3.5 h-3.5" />
        Duplicate
      </button>
      <button
        onClick={onDelete}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-danger
                   hover:bg-danger/10 transition-colors"
      >
        <Trash2 className="w-3.5 h-3.5" />
        Delete
      </button>
    </div>
  )
}

export default ProjectCard
