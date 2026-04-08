import { apiPost } from '../../../services/api'
import { FolderOpen } from 'lucide-react'

export function BrowseInput({ value, onChange, placeholder, browseTitle }) {
  const handleBrowse = async () => {
    try {
      const result = await apiPost('/system/browse', {
        mode: 'folder',
        title: browseTitle || 'Select Folder',
        initial_dir: value || '',
      })
      if (result.path) onChange(result.path)
    } catch { /* dialog cancelled or failed */ }
  }

  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                   text-text-primary placeholder:text-text-disabled
                   focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
                   transition-colors"
      />
      <button
        type="button"
        onClick={handleBrowse}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-bg-primary
                   text-text-secondary hover:text-text-primary hover:bg-surface-hover text-sm transition-colors"
      >
        <FolderOpen className="w-4 h-4" />
        Browse
      </button>
    </div>
  )
}
