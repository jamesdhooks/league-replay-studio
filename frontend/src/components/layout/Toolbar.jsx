import {
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  HelpCircle,
  Undo2,
  Redo2,
  Save,
} from 'lucide-react'

/**
 * Top toolbar with app title, navigation, and action buttons.
 *
 * @param {Object} props
 * @param {boolean} props.sidebarCollapsed
 * @param {() => void} props.onToggleSidebar
 * @param {string} [props.projectName] - Active project name (if any)
 */
function Toolbar({ sidebarCollapsed, onToggleSidebar, projectName }) {
  return (
    <header className="h-toolbar flex items-center px-3 bg-bg-secondary border-b border-border
                        select-none shrink-0">
      {/* Left section: sidebar toggle + app name */}
      <div className="flex items-center gap-2">
        <button
          onClick={onToggleSidebar}
          className="p-1.5 rounded-md hover:bg-surface-hover transition-colors text-text-secondary
                     hover:text-text-primary"
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen className="w-4 h-4" />
          ) : (
            <PanelLeftClose className="w-4 h-4" />
          )}
        </button>

        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">
            League Replay Studio
          </span>
          <span className="text-xxs text-text-tertiary font-mono">
            v0.1.0
          </span>
        </div>
      </div>

      {/* Center section: project name (if any) */}
      <div className="flex-1 flex items-center justify-center">
        <span className="text-sm text-text-tertiary">
          {projectName || 'No project open'}
        </span>
      </div>

      {/* Right section: action buttons */}
      <div className="flex items-center gap-1">
        <ToolbarButton icon={Save} title="Save (Ctrl+S)" disabled />
        <ToolbarDivider />
        <ToolbarButton icon={Undo2} title="Undo (Ctrl+Z)" disabled />
        <ToolbarButton icon={Redo2} title="Redo (Ctrl+Y)" disabled />
        <ToolbarDivider />
        <ToolbarButton icon={Settings} title="Settings" />
        <ToolbarButton icon={HelpCircle} title="Help" />
      </div>
    </header>
  )
}

/**
 * Individual toolbar icon button.
 */
function ToolbarButton({ icon: Icon, title, disabled = false, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`p-1.5 rounded-md transition-colors ${
        disabled
          ? 'text-text-disabled cursor-not-allowed'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
      }`}
    >
      <Icon className="w-4 h-4" />
    </button>
  )
}

/**
 * Vertical divider between toolbar button groups.
 */
function ToolbarDivider() {
  return <div className="w-px h-5 bg-border mx-1" />
}

export default Toolbar
