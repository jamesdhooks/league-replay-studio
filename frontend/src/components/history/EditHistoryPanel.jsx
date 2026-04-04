import { useUndoRedo } from '../../context/UndoRedoContext'
import { History, Undo2, Redo2, Trash2 } from 'lucide-react'

/**
 * EditHistoryPanel — shows a scrollable list of recent editing operations.
 *
 * Current action is highlighted. Undone actions are dimmed.
 * Clicking an entry doesn't navigate (history is linear).
 */
export default function EditHistoryPanel() {
  const { history, currentIndex, undo, redo, canUndo, canRedo, clearHistory } = useUndoRedo()

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-secondary shrink-0">
        <History size={14} className="text-text-tertiary" />
        <h3 className="text-xs font-semibold text-text-primary uppercase tracking-wider flex-1">
          Edit History
        </h3>
        <span className="text-xxs text-text-disabled">
          {history.length > 0 ? `${currentIndex + 1}/${history.length}` : '—'}
        </span>
      </div>

      {/* Undo/Redo quick buttons */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border-subtle shrink-0">
        <button
          onClick={undo}
          disabled={!canUndo}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xxs transition-colors
            ${canUndo
              ? 'text-text-primary hover:bg-bg-hover'
              : 'text-text-disabled cursor-not-allowed'
            }`}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={12} />
          Undo
        </button>
        <button
          onClick={redo}
          disabled={!canRedo}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xxs transition-colors
            ${canRedo
              ? 'text-text-primary hover:bg-bg-hover'
              : 'text-text-disabled cursor-not-allowed'
            }`}
          title="Redo (Ctrl+Y)"
        >
          <Redo2 size={12} />
          Redo
        </button>
        <div className="flex-1" />
        {history.length > 0 && (
          <button
            onClick={clearHistory}
            className="flex items-center gap-1 px-2 py-1 rounded text-xxs text-text-tertiary
                       hover:text-danger hover:bg-danger/10 transition-colors"
            title="Clear history"
          >
            <Trash2 size={10} />
          </button>
        )}
      </div>

      {/* History list */}
      <div className="flex-1 overflow-y-auto">
        {history.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-tertiary p-4 gap-2">
            <History size={20} className="opacity-30" />
            <p className="text-xxs text-center">
              No editing actions yet.
            </p>
          </div>
        ) : (
          <div className="py-1">
            {/* Show in reverse order — most recent at top */}
            {[...history].reverse().map((action) => {
              const isCurrent = action.isCurrent
              const isUndone = action.isUndone
              return (
                <div
                  key={action.index}
                  className={`flex items-start gap-2 px-3 py-1.5 text-xxs transition-colors
                    ${isCurrent
                      ? 'bg-accent/10 border-l-2 border-accent'
                      : isUndone
                        ? 'opacity-40 border-l-2 border-transparent'
                        : 'border-l-2 border-transparent hover:bg-bg-hover'
                    }`}
                >
                  <ActionIcon type={action.type} />
                  <div className="flex-1 min-w-0">
                    <div className={`truncate ${isCurrent ? 'text-accent font-medium' : isUndone ? 'text-text-disabled' : 'text-text-secondary'}`}>
                      {action.description}
                    </div>
                    <div className="text-text-disabled text-[9px]">
                      {formatTimeAgo(action.timestamp)}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}


/**
 * Small icon for each action type.
 */
function ActionIcon({ type }) {
  const baseClass = 'w-3.5 h-3.5 rounded-sm mt-0.5 shrink-0 flex items-center justify-center text-[8px] font-bold'

  switch (type) {
    case 'event_update':
      return <div className={`${baseClass} bg-accent/20 text-accent`}>U</div>
    case 'event_delete':
      return <div className={`${baseClass} bg-danger/20 text-danger`}>D</div>
    case 'event_split':
      return <div className={`${baseClass} bg-warning/20 text-warning`}>S</div>
    case 'weight_change':
      return <div className={`${baseClass} bg-success/20 text-success`}>W</div>
    case 'override_toggle':
    case 'override_change':
      return <div className={`${baseClass} bg-info/20 text-info`}>O</div>
    case 'auto_balance':
      return <div className={`${baseClass} bg-success/20 text-success`}>B</div>
    default:
      return <div className={`${baseClass} bg-surface-hover text-text-tertiary`}>?</div>
  }
}


/**
 * Format a timestamp as "Xs ago", "Xm ago", etc.
 */
function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}
