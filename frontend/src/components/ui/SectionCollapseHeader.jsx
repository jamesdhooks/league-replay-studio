import { ChevronDown, ChevronRight } from 'lucide-react'

/**
 * SectionCollapseHeader — shared collapse-toggle header following app convention.
 */
export default function SectionCollapseHeader({
  open,
  onToggle,
  icon: Icon,
  title,
  subtitle = null,
  status = null,
  right = null,
  className = '',
  buttonClassName = '',
  iconClassName = 'text-accent',
  titleClassName = 'text-text-primary',
}) {
  return (
    <div className={`shrink-0 ${className}`}>
      <div className={`w-full flex items-center gap-2 min-w-0 ${buttonClassName}`}>
        <button
          type="button"
          onClick={onToggle}
          className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-primary/40 transition-colors"
        >
          {open
            ? <ChevronDown className="w-3 h-3 text-text-tertiary shrink-0" />
            : <ChevronRight className="w-3 h-3 text-text-tertiary shrink-0" />}
          {Icon && <Icon className={`w-3.5 h-3.5 shrink-0 ${iconClassName}`} />}
          <span className={`text-xs font-semibold uppercase tracking-wider whitespace-nowrap ${titleClassName}`}>
            {title}
          </span>
          {subtitle && (
            <span className="text-xs text-text-disabled truncate">
              {subtitle}
            </span>
          )}
          {status}
          <div className="flex-1" />
        </button>
        {right && <div className="px-1.5">{right}</div>}
      </div>
    </div>
  )
}
