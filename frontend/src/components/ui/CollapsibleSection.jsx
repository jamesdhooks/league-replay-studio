import SectionCollapseHeader from './SectionCollapseHeader'

/**
 * CollapsibleSection — reusable collapsible header + content block.
 *
 * Completely self-styled. No className prop needed.
 * Renders: icon (left) → label (center) → right content → chevron (far right).
 *
 * @param {Object} props
 * @param {import('lucide-react').LucideIcon} [props.icon] - Lucide icon component for the section
 * @param {string} props.label - Section title (uppercase tracking)
 * @param {boolean} props.open - Whether the section content is visible
 * @param {() => void} props.onToggle - Callback to toggle open/closed
 * @param {string} [props.iconColor] - Tailwind color class for the icon (default: text-text-tertiary)
 * @param {React.ReactNode} [props.right] - Optional right-aligned content (badges, buttons, metrics)
 * @param {React.ReactNode} props.children - Section body (rendered when open)
 */
export default function CollapsibleSection({
  icon: Icon,
  label,
  open,
  onToggle,
  iconColor = 'text-text-tertiary',
  right,
  children,
}) {
  return (
    <div className="px-3 py-2 border-t border-border-subtle shrink-0">
      <SectionCollapseHeader
        open={open}
        onToggle={onToggle}
        icon={Icon}
        title={label}
        right={right}
        buttonClassName="px-0 py-0"
        iconClassName={iconColor}
        titleClassName="text-text-tertiary"
      />
      {open && <div className="pt-2">{children}</div>}
    </div>
  )
}
