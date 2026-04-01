import {
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  HelpCircle,
  Undo2,
  Redo2,
  Save,
  PlayCircle,
} from 'lucide-react'

/**
 * Top toolbar with app title, navigation, and action buttons.
 * Larger (64px), friendlier spacing, professional Clipchamp-inspired styling.
 *
 * @param {Object} props
 * @param {boolean} props.sidebarCollapsed
 * @param {() => void} props.onToggleSidebar
 * @param {string} [props.projectName] - Active project name (if any)
 * @param {() => void} [props.onOpenSettings] - Callback to open settings panel
 * @param {boolean} [props.canUndo] - Whether undo is available
 * @param {boolean} [props.canRedo] - Whether redo is available
 * @param {() => void} [props.onUndo] - Undo callback
 * @param {() => void} [props.onRedo] - Redo callback
 * @param {string} [props.undoDescription] - Description of next undo operation
 * @param {string} [props.redoDescription] - Description of next redo operation
 */
function Toolbar({
  sidebarCollapsed, onToggleSidebar, projectName, onOpenSettings,
  canUndo = false, canRedo = false, onUndo, onRedo,
  undoDescription, redoDescription,
}) {
  return (
    <header className="h-toolbar flex items-center px-4 bg-bg-secondary border-b border-border
                        select-none shrink-0">
      {/* Left section: sidebar toggle + app name */}
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleSidebar}
          className="p-2 rounded-xl hover:bg-surface-hover transition-all duration-150
                     text-text-secondary hover:text-text-primary cursor-pointer
                     active:scale-95"
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen className="w-5 h-5" />
          ) : (
            <PanelLeftClose className="w-5 h-5" />
          )}
        </button>

        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-accent/15
                          flex items-center justify-center border border-accent/10">
            <PlayCircle className="w-4.5 h-4.5 text-accent" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-base font-bold text-text-primary tracking-tight">
              League Replay Studio
            </span>
            <span className="text-xxs text-text-disabled font-mono bg-surface px-1.5 py-0.5 rounded">
              v0.1.0
            </span>
          </div>
        </div>
      </div>

      {/* Center section: project name (if any) */}
      <div className="flex-1 flex items-center justify-center">
        <span className="text-sm text-text-tertiary italic">
          {projectName || 'No project open'}
        </span>
      </div>

      {/* Right section: action buttons */}
      <div className="flex items-center gap-1">
        <ToolbarButton icon={Save} title="Save (Ctrl+S)" disabled />
        <ToolbarDivider />
        <ToolbarButton
          icon={Undo2}
          title={canUndo ? `Undo: ${undoDescription || 'last action'} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}
          disabled={!canUndo}
          onClick={onUndo}
        />
        <ToolbarButton
          icon={Redo2}
          title={canRedo ? `Redo: ${redoDescription || 'last action'} (Ctrl+Y)` : 'Redo (Ctrl+Y)'}
          disabled={!canRedo}
          onClick={onRedo}
        />
        <ToolbarDivider />
        <ToolbarButton icon={Settings} title="Settings" onClick={onOpenSettings} />
        <ToolbarButton icon={HelpCircle} title="Help" />
      </div>
    </header>
  )
}

/**
 * Individual toolbar icon button — larger (36px) with better hover state.
 */
function ToolbarButton({ icon: Icon, title, disabled = false, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`p-2 rounded-xl transition-all duration-150 cursor-pointer ${
        disabled
          ? 'text-text-disabled cursor-not-allowed opacity-40'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary active:scale-95'
      }`}
    >
      <Icon className="w-5 h-5" />
    </button>
  )
}

/**
 * Vertical divider between toolbar button groups.
 */
function ToolbarDivider() {
  return <div className="w-px h-6 bg-border mx-1.5" />
}

export default Toolbar
