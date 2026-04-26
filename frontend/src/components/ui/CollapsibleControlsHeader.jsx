import { ChevronLeft } from 'lucide-react'

/**
 * CollapsibleControlsHeader — shared header for collapsible controls columns.
 *
 * Supports the collapsed rail trigger and expanded header row so Controls
 * columns use a single consistent implementation.
 */
export default function CollapsibleControlsHeader({
  collapsed,
  icon: Icon,
  title,
  onExpand,
  onCollapse,
  expandTitle,
  collapsedClassName = '',
  expandedWrapperClassName = '',
  expandedButtonClassName = '',
}) {
  if (collapsed) {
    return (
      <button
        onClick={onExpand}
        className={`shrink-0 w-9 border-r border-border bg-bg-secondary flex flex-col items-center py-2 gap-3 hover:bg-bg-primary/50 transition-colors cursor-pointer ${collapsedClassName}`.trim()}
        title={expandTitle || `Expand ${title}`}
      >
        {Icon && <Icon className="w-4 h-4 text-accent" />}
      </button>
    )
  }

  return (
    <div className={`border-b border-border shrink-0 ${expandedWrapperClassName}`.trim()}>
      <button
        onClick={onCollapse}
        className={`flex items-center gap-2 px-3 py-2 w-full text-left hover:bg-bg-primary/50 transition-colors ${expandedButtonClassName}`.trim()}
      >
        {Icon && <Icon className="w-4 h-4 text-accent" />}
        <h3 className="text-xs font-semibold text-text-primary uppercase tracking-wider flex-1 truncate">
          {title}
        </h3>
        <ChevronLeft className="w-3 h-3 text-text-tertiary" />
      </button>
    </div>
  )
}
