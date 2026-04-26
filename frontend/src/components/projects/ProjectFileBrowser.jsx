import { useState, useEffect, useCallback } from 'react'
import { ChevronRight, ChevronDown, File, Folder, RefreshCw, Flag, Film, Eye, Upload, Layers, FileText, FileCode, CheckSquare, Square, Trash2, X, ArrowUp, ArrowDown, FolderOpen } from 'lucide-react'
import { useProject } from '../../context/ProjectContext'
import { useModal } from '../../context/ModalContext'
import { useToast } from '../../context/ToastContext'
import { wsClient } from '../../services/websocket'
import { formatFileSize } from '../../utils/format'
import FileViewerModal from '../ui/FileViewer'

const CATEGORY_ICONS = {
  root: FileCode,
  replay: Flag,
  captures: Film,
  compose: Film,
  preview: Eye,
  exports: Upload,
  overlays: Layers,
  logs: FileText,
}

function formatSimpleDate(value) {
  if (!value) return '--/-- --:--:--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--/-- --:--:--'
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Project file browser — shows the project directory tree organized by category.
 *
 * @param {Object} props
 * @param {number} props.projectId
 */
function ProjectFileBrowser({ projectId }) {
  const { getProjectFiles, deleteProjectFiles, openProjectDirectory } = useProject()
  const { openContentModal, openModal } = useModal()
  const { showSuccess, showError } = useToast()
  const [fileData, setFileData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [expandedCategories, setExpandedCategories] = useState({})
  const [expandedFolders, setExpandedFolders] = useState({})
  const [selectMode, setSelectMode] = useState(false)
  const [selectedPaths, setSelectedPaths] = useState(() => new Set())
  const [dateSortDirection, setDateSortDirection] = useState('desc')

  const loadFiles = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getProjectFiles(projectId)
      setFileData(data)
      setSelectedPaths(new Set())
      setExpandedFolders({})
      // Auto-expand categories with files
      const expanded = {}
      for (const cat of data.categories || []) {
        expanded[cat.name] = cat.file_count > 0
      }
      setExpandedCategories(expanded)
    } catch {
      setFileData(null)
    } finally {
      setLoading(false)
    }
  }, [projectId, getProjectFiles])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  useEffect(() => {
    let refreshTimer = null
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        loadFiles().catch(() => {})
      }, 250)
    }

    const unsubs = [
      wsClient.subscribe('composition:completed', scheduleRefresh),
      wsClient.subscribe('capture:script_completed', scheduleRefresh),
      wsClient.subscribe('encoding:completed', scheduleRefresh),
      wsClient.subscribe('overlay:render_completed', scheduleRefresh),
      wsClient.subscribe('automation:completed', scheduleRefresh),
      wsClient.subscribe('project:files_changed', (data) => {
        if (Number(data?.project_id) === Number(projectId)) {
          scheduleRefresh()
        }
      }),
    ]

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      unsubs.forEach(fn => fn())
    }
  }, [loadFiles, projectId])

  const toggleCategory = (name) => {
    setExpandedCategories(prev => ({ ...prev, [name]: !prev[name] }))
  }

  const toggleFolder = useCallback((folderPath) => {
    setExpandedFolders(prev => ({
      ...prev,
      [folderPath]: !(prev[folderPath] ?? true),
    }))
  }, [])

  const toggleSelectMode = useCallback(() => {
    setSelectMode(prev => {
      if (prev) setSelectedPaths(new Set())
      return !prev
    })
  }, [])

  const toggleFileSelection = useCallback((relPath) => {
    setSelectedPaths(prev => {
      const next = new Set(prev)
      if (next.has(relPath)) next.delete(relPath)
      else next.add(relPath)
      return next
    })
  }, [])

  const deleteSelected = useCallback(() => {
    const paths = Array.from(selectedPaths)
    if (!paths.length) return

    openModal('delete-project-files', 'confirm', {
      title: 'Delete Selected Files',
      message: `Delete ${paths.length} selected file${paths.length === 1 ? '' : 's'}? This action cannot be undone.`,
      confirmText: 'Delete Files',
      danger: true,
      onConfirm: async () => {
        try {
          const result = await deleteProjectFiles(projectId, paths)
          await loadFiles()
          setSelectMode(false)

          const deleted = Number(result?.deleted_count || 0)
          const failed = Number(result?.failed_count || 0)
          if (deleted > 0) {
            showSuccess(`Deleted ${deleted} file${deleted === 1 ? '' : 's'}`)
          }
          if (failed > 0) {
            showError(`${failed} file${failed === 1 ? '' : 's'} could not be deleted`)
          }
        } catch {
          showError('Failed to delete selected files')
        }
      },
    })
  }, [deleteProjectFiles, loadFiles, openModal, projectId, selectedPaths, showError, showSuccess])

  const handleOpenExplorer = useCallback(async () => {
    try {
      await openProjectDirectory(projectId)
    } catch {
      showError('Failed to open project directory')
    }
  }, [openProjectDirectory, projectId, showError])

  const toggleDateSort = useCallback(() => {
    setDateSortDirection(prev => (prev === 'desc' ? 'asc' : 'desc'))
  }, [])

  const sortFilesByDate = useCallback((files) => {
    const sorted = [...files]
    sorted.sort((a, b) => {
      const aTs = Date.parse(a.modified_at || '')
      const bTs = Date.parse(b.modified_at || '')
      const aSafe = Number.isNaN(aTs) ? 0 : aTs
      const bSafe = Number.isNaN(bTs) ? 0 : bTs
      if (aSafe !== bSafe) {
        return dateSortDirection === 'desc' ? bSafe - aSafe : aSafe - bSafe
      }
      return String(a.name || '').localeCompare(String(b.name || ''))
    })
    return sorted
  }, [dateSortDirection])

  const normalizePath = useCallback((value) => String(value || '').replace(/\\/g, '/'), [])

  const buildFileTree = useCallback((files, stripFirst = false) => {
    const root = { folders: new Map(), files: [] }

    for (const file of files) {
      const relPath = normalizePath(file.path)
      let parts = relPath.split('/').filter(Boolean)
      if (parts.length === 0) continue
      // Skip the top-level category folder (e.g. "captures/", "compositions/") so
      // the browser shows only the contents, not the redundant root directory row.
      if (stripFirst && parts.length > 1) parts = parts.slice(1)

      const leafName = parts.pop() || file.name
      let node = root
      let currentPath = ''

      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part
        if (!node.folders.has(part)) {
          node.folders.set(part, { name: part, path: currentPath, folders: new Map(), files: [] })
        }
        node = node.folders.get(part)
      }

      node.files.push({ ...file, _displayName: leafName })
    }

    return root
  }, [normalizePath])

  const renderTree = useCallback((node, depth = 0) => {
    const folderEntries = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))
    const fileEntries = sortFilesByDate(node.files)
    const indent = 12 + depth * 14

    return (
      <>
        {folderEntries.map((folder) => {
          const expanded = expandedFolders[folder.path] ?? true
          return (
            <div key={`folder-${folder.path}`}>
              <button
                onClick={() => toggleFolder(folder.path)}
                className="w-full flex items-center gap-2 py-1 hover:bg-surface-hover rounded-md transition-colors text-left"
                style={{ paddingLeft: `${indent}px`, paddingRight: '12px' }}
              >
                {expanded ? (
                  <ChevronDown className="w-3 h-3 text-text-tertiary shrink-0" />
                ) : (
                  <ChevronRight className="w-3 h-3 text-text-tertiary shrink-0" />
                )}
                <Folder className="w-3 h-3 text-text-tertiary shrink-0" />
                <span className="text-xxs text-text-secondary truncate flex-1">{folder.name}</span>
              </button>
              {expanded && renderTree(folder, depth + 1)}
            </div>
          )
        })}

        {fileEntries.map((file, idx) => (
          <button
            key={`file-${file.path}-${idx}`}
            onClick={() => {
              if (selectMode) {
                toggleFileSelection(file.path)
                return
              }
              openContentModal({
                title: file.name,
                wide: true,
                content: <FileViewerModal file={file} projectId={projectId} />,
              })
            }}
            className="w-full flex items-center gap-2 py-1 hover:bg-surface-hover rounded-md transition-colors group text-left cursor-pointer"
            style={{ paddingLeft: `${indent}px`, paddingRight: '12px' }}
          >
            {selectMode ? (
              selectedPaths.has(file.path)
                ? <CheckSquare className="w-3 h-3 text-accent shrink-0" />
                : <Square className="w-3 h-3 text-text-tertiary shrink-0" />
            ) : null}
            <File className="w-3 h-3 text-text-tertiary shrink-0" />
            <span className="text-xxs text-text-secondary truncate flex-1 group-hover:text-text-primary transition-colors pr-2">
              {file._displayName || file.name}
            </span>
            <span className="text-xxs text-text-disabled shrink-0 w-16 text-right">
              {formatFileSize(file.size_bytes)}
            </span>
            <span className="text-xxs text-text-disabled shrink-0 w-28 text-right tabular-nums">
              {formatSimpleDate(file.modified_at)}
            </span>
          </button>
        ))}
      </>
    )
  }, [expandedFolders, openContentModal, projectId, selectMode, selectedPaths, sortFilesByDate, toggleFileSelection, toggleFolder])

  if (loading && !fileData) {
    return (
      <div className="p-4 text-center text-xs text-text-tertiary">
        Loading project files...
      </div>
    )
  }

  if (!fileData) {
    return (
      <div className="p-4 text-center text-xs text-text-tertiary">
        Unable to load project files.
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-secondary">Project Files</span>
          {selectMode && (
            <span className="text-xxs text-accent">
              {selectedPaths.size} selected
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleOpenExplorer}
            className="p-1 rounded-md hover:bg-surface-hover text-text-tertiary transition-colors"
            title="Open project folder in Explorer"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={toggleSelectMode}
            className={`p-1 rounded-md transition-colors ${
              selectMode ? 'bg-accent/10 text-accent' : 'hover:bg-surface-hover text-text-tertiary'
            }`}
            title={selectMode ? 'Exit select mode' : 'Select files'}
          >
            {selectMode ? <X className="w-3.5 h-3.5" /> : <CheckSquare className="w-3.5 h-3.5" />}
          </button>
          {selectMode && (
            <button
              onClick={deleteSelected}
              disabled={selectedPaths.size === 0}
              className="p-1 rounded-md hover:bg-danger/10 text-danger disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Delete selected files"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <span className="text-xxs text-text-tertiary">
            {formatFileSize(fileData.total_size)}
          </span>
          <button
            onClick={loadFiles}
            className="p-1 rounded-md hover:bg-surface-hover transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-3 h-3 text-text-tertiary ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {fileData.categories.map((category) => (
          <div key={category.name}>
            {/* Category header */}
            <button
              onClick={() => toggleCategory(category.name)}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 hover:bg-surface-hover
                         transition-colors text-left"
            >
              {expandedCategories[category.name] ? (
                <ChevronDown className="w-3 h-3 text-text-tertiary shrink-0" />
              ) : (
                <ChevronRight className="w-3 h-3 text-text-tertiary shrink-0" />
              )}
              {(() => {
                const CatIcon = CATEGORY_ICONS[category.name] || Folder
                return <CatIcon className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
              })()}
              <span className="text-xs text-text-primary flex-1">
                {category.label}
              </span>
              {category.file_count > 0 && (
                <span className="text-xxs text-text-tertiary">
                  {category.file_count} file{category.file_count !== 1 ? 's' : ''}
                </span>
              )}
            </button>

            {/* Files list */}
            {expandedCategories[category.name] && (
              <div className="ml-4">
                {category.files.length === 0 ? (
                  <div className="px-3 py-1.5 text-xxs text-text-disabled italic">
                    No files yet
                  </div>
                ) : (
                  <>
                    <div className="px-3 py-1 text-xxs text-text-tertiary uppercase tracking-wide border-b border-border/60 mb-1 flex items-center gap-2">
                      <span className="flex-1">Name</span>
                      <span className="w-16 text-right">Size</span>
                      <button
                        onClick={toggleDateSort}
                        className="w-28 text-right hover:text-text-primary transition-colors inline-flex items-center justify-end gap-1"
                        title={`Sort by date (${dateSortDirection === 'desc' ? 'newest first' : 'oldest first'})`}
                      >
                        <span>Date</span>
                        {dateSortDirection === 'desc'
                          ? <ArrowDown className="w-3 h-3" />
                          : <ArrowUp className="w-3 h-3" />}
                      </button>
                    </div>
                    {renderTree(buildFileTree(category.files, true), 0)}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default ProjectFileBrowser
