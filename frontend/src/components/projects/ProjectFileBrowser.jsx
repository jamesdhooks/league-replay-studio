import { useState, useEffect, useCallback } from 'react'
import { ChevronRight, ChevronDown, File, Folder, RefreshCw } from 'lucide-react'
import { useProject } from '../../context/ProjectContext'
import { formatFileSize } from '../../utils/format'

/**
 * Project file browser — shows the project directory tree organized by category.
 *
 * @param {Object} props
 * @param {number} props.projectId
 */
function ProjectFileBrowser({ projectId }) {
  const { getProjectFiles } = useProject()
  const [fileData, setFileData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [expandedCategories, setExpandedCategories] = useState({})

  const loadFiles = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getProjectFiles(projectId)
      setFileData(data)
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

  const toggleCategory = (name) => {
    setExpandedCategories(prev => ({ ...prev, [name]: !prev[name] }))
  }

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
        <span className="text-xs font-medium text-text-secondary">Project Files</span>
        <div className="flex items-center gap-2">
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
                  category.files.map((file, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2 px-3 py-1 hover:bg-surface-hover
                                 rounded-md transition-colors group"
                    >
                      <File className="w-3 h-3 text-text-tertiary shrink-0" />
                      <span className="text-xxs text-text-secondary truncate flex-1">
                        {file.name}
                      </span>
                      <span className="text-xxs text-text-disabled shrink-0">
                        {formatFileSize(file.size_bytes)}
                      </span>
                    </div>
                  ))
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
