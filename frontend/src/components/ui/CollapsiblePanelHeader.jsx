import { useId } from 'react'
import SectionCollapseHeader from './SectionCollapseHeader'
import { useLocalStorage } from '../../hooks/useLocalStorage'

/**
 * CollapsiblePanelHeader — section-level collapsible header (timeline/preview/log panels).
 *
 * This is intentionally separate from CollapsibleSection, which is for
 * in-column control subheaders.
 */
export default function CollapsiblePanelHeader({
  open: controlledOpen,
  onToggle,
  storageKey,
  defaultOpen = true,
  icon,
  title,
  subtitle = null,
  status = null,
  right = null,
  className = '',
  buttonClassName = '',
  iconClassName = 'text-accent',
  titleClassName = 'text-text-primary',
}) {
  const autoId = useId()
  const resolvedStorageKey = storageKey || `lrs:ui:panel-header:${autoId}`
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
    <SectionCollapseHeader
      open={open}
      onToggle={handleToggle}
      icon={icon}
      title={title}
      subtitle={subtitle}
      status={status}
      right={right}
      className={className}
      buttonClassName={buttonClassName}
      iconClassName={iconClassName}
      titleClassName={titleClassName}
    />
  )
}
