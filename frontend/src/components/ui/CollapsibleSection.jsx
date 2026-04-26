import { useId } from 'react'
import SectionCollapseHeader from './SectionCollapseHeader'
import { useLocalStorage } from '../../hooks/useLocalStorage'

/**
 * CollapsibleSection — reusable collapsible header + content block.
 *
 * Completely self-styled. No className prop needed.
 * Renders: icon (left) → label (center) → right content → chevron (far right).
 *
 * @param {Object} props
 * @param {import('lucide-react').LucideIcon} [props.icon] - Lucide icon component for the section
 * @param {string} props.label - Section title (uppercase tracking)
 * @param {boolean} [props.open] - Controlled open state
 * @param {() => void} [props.onToggle] - Controlled toggle callback
 * @param {string} [props.storageKey] - Optional localStorage key for persisted open state
 * @param {boolean} [props.defaultOpen=true] - Initial open state for persisted/uncontrolled mode
 * @param {string} [props.iconColor] - Tailwind color class for the icon (default: text-text-tertiary)
 * @param {React.ReactNode} [props.right] - Optional right-aligned content (badges, buttons, metrics)
 * @param {React.ReactNode} props.children - Section body (rendered when open)
 */
export default function CollapsibleSection({
  icon: Icon,
  label,
  open: controlledOpen,
  onToggle,
  storageKey,
  defaultOpen = true,
  iconColor = 'text-text-tertiary',
  right,
  children,
}) {
  const autoId = useId()
  const resolvedStorageKey = storageKey || `lrs:ui:collapsible:${autoId}`
  const [storedOpen, setStoredOpen] = useLocalStorage(resolvedStorageKey, defaultOpen)
  const isControlled = typeof controlledOpen === 'boolean'
  const open = isControlled ? controlledOpen : storedOpen

  const handleToggle = () => {
    if (isControlled) {
      onToggle?.()
      return
    }
    setStoredOpen((prev) => !prev)
    onToggle?.()
  }

  return (
    <div className="border-t border-border-subtle shrink-0">
      <SectionCollapseHeader
        open={open}
        onToggle={handleToggle}
        icon={Icon}
        title={label}
        right={right}
        buttonClassName="px-0 py-0"
        iconClassName={iconColor}
        titleClassName="text-text-tertiary"
      />
      {open && <div className="px-2 pb-1.5">{children}</div>}
    </div>
  )
}
