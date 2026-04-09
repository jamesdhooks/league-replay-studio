import { ChevronDown, ChevronRight } from 'lucide-react'

/**
 * CollapsibleSection — reusable collapsible header + content block.
 *
 * Used in Analysis Controls, Editing Controls, camera/driver panels, etc.
 * Renders a clickable header row with icon, label, optional right-side content,
 * and a chevron indicating open/closed state.
 *
 * @param {Object} props
 * @param {import('lucide-react').LucideIcon} [props.icon] - Lucide icon component for the section
 * @param {string} props.label - Section title (uppercase tracking)
 * @param {boolean} props.open - Whether the section content is visible
 * @param {() => void} props.onToggle - Callback to toggle open/closed
 * @param {string} [props.iconColor] - Tailwind color class for the icon (default: text-text-tertiary)
 * @param {React.ReactNode} [props.right] - Optional right-aligned content (badges, buttons)
 * @param {string} [props.className] - Extra classes on the wrapper div
 * @param {React.ReactNode} props.children - Section body (rendered when open)
 */
export default function CollapsibleSection({
  icon: Icon,
  label,
  open,
  onToggle,
  iconColor = 'text-text-tertiary',
  right,
  className = '',
  children,
}) {
  return (
    <div className={className}>
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 w-full text-left group/section"
      >
        {open
          ? <ChevronDown className="w-3 h-3 text-text-tertiary shrink-0" />
          : <ChevronRight className="w-3 h-3 text-text-tertiary shrink-0" />}
        {Icon && <Icon className={`w-3 h-3 shrink-0 ${iconColor}`} />}
        <h4 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider flex-1">
          {label}
        </h4>
        {right}
      </button>
      {open && children}
    </div>
  )
}
