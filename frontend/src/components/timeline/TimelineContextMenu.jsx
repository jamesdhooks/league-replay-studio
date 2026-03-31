import { useEffect, useRef } from 'react'
import { useTimeline } from '../../context/TimelineContext'
import { Scissors, Trash2, Camera, MapPin, ToggleLeft, ToggleRight } from 'lucide-react'

/**
 * TimelineContextMenu — right-click context menu for timeline events.
 *
 * Shows: Split, Delete, Change Camera, Add Marker, Toggle Highlight.
 * Positions near the cursor and auto-closes on click-outside.
 */
export default function TimelineContextMenu({ projectId }) {
  const menuRef = useRef(null)
  const {
    contextMenu, closeContextMenu,
    splitEvent, deleteEvent, updateEvent,
    playheadTime, events,
  } = useTimeline()

  // Close on outside click
  useEffect(() => {
    if (!contextMenu) return
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        closeContextMenu()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [contextMenu, closeContextMenu])

  // Close on Escape
  useEffect(() => {
    if (!contextMenu) return
    const handler = (e) => {
      if (e.key === 'Escape') closeContextMenu()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [contextMenu, closeContextMenu])

  if (!contextMenu) return null

  const { x, y, eventId, time } = contextMenu
  const targetEvent = eventId ? events.find(e => e.id === eventId) : null

  const handleSplit = async () => {
    if (!targetEvent) return
    closeContextMenu()
    try {
      await splitEvent(projectId, eventId, playheadTime)
    } catch {
      // Error handled in context
    }
  }

  const handleDelete = async () => {
    if (!targetEvent) return
    closeContextMenu()
    try {
      await deleteEvent(projectId, eventId)
    } catch {
      // Error handled in context
    }
  }

  const handleToggleHighlight = async () => {
    if (!targetEvent) return
    closeContextMenu()
    try {
      await updateEvent(projectId, eventId, {
        included_in_highlight: !targetEvent.included_in_highlight,
      })
    } catch {
      // Error handled in context
    }
  }

  // Determine menu items based on whether an event was right-clicked
  const items = []

  if (targetEvent) {
    const canSplit = playheadTime > targetEvent.start_time_seconds &&
                     playheadTime < targetEvent.end_time_seconds

    if (canSplit) {
      items.push({
        icon: Scissors,
        label: 'Split at Playhead',
        onClick: handleSplit,
      })
    }

    items.push({
      icon: targetEvent.included_in_highlight ? ToggleRight : ToggleLeft,
      label: targetEvent.included_in_highlight ? 'Exclude from Highlight' : 'Include in Highlight',
      onClick: handleToggleHighlight,
    })

    items.push({ divider: true })

    items.push({
      icon: Trash2,
      label: 'Delete Event',
      onClick: handleDelete,
      danger: true,
    })
  } else {
    items.push({
      icon: MapPin,
      label: 'Add Marker (coming soon)',
      onClick: closeContextMenu,
      disabled: true,
    })
    items.push({
      icon: Camera,
      label: 'Change Camera (coming soon)',
      onClick: closeContextMenu,
      disabled: true,
    })
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] bg-bg-secondary border border-border rounded-lg shadow-lg
                 py-1 animate-fade-in"
      style={{ left: x, top: y }}
    >
      {items.map((item, idx) => {
        if (item.divider) {
          return <div key={idx} className="my-1 border-t border-border-subtle" />
        }
        const Icon = item.icon
        return (
          <button
            key={idx}
            onClick={item.onClick}
            disabled={item.disabled}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors
              ${item.disabled
                ? 'text-text-disabled cursor-not-allowed'
                : item.danger
                  ? 'text-danger hover:bg-danger/10'
                  : 'text-text-primary hover:bg-bg-hover'
              }`}
          >
            <Icon size={14} className={item.danger ? 'text-danger' : 'text-text-secondary'} />
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
