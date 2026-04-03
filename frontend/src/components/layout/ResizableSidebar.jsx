import { useState, useRef, useCallback } from 'react'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * ResizableSidebar — Shared left sidebar with tabbed content,
 * drag-resize, collapse to icon bar, and overlay popup.
 *
 * @param {Object} props
 * @param {{ id: string, label: string, icon: import('lucide-react').LucideIcon, content: React.ReactNode, count?: number }[]} props.tabs
 * @param {string}  props.storageKey    - localStorage key prefix (e.g. 'lrs:analysis:sidebar')
 * @param {number}  [props.defaultWidth=384]
 * @param {string}  [props.defaultTab]  - initial active tab id (defaults to first tab)
 */
export default function ResizableSidebar({
  tabs,
  storageKey,
  defaultWidth = 384,
  defaultTab,
}) {
  const firstTab = defaultTab || tabs[0]?.id || ''

  const [activeTab, setActiveTab] = useLocalStorage(`${storageKey}:tab`, firstTab)
  const [width, setWidth] = useLocalStorage(`${storageKey}:width`, defaultWidth)
  const [collapsed, setCollapsed] = useLocalStorage(`${storageKey}:collapsed`, false)
  const [overlay, setOverlay] = useState(false)
  const isDragging = useRef(false)

  const handleDragStart = useCallback((e) => {
    isDragging.current = true
    const startX = e.clientX
    const startWidth = width

    const onMove = (moveEvt) => {
      const newWidth = startWidth + (moveEvt.clientX - startX)
      if (newWidth < 150) {
        setCollapsed(true)
        setWidth(defaultWidth)
        isDragging.current = false
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      } else {
        setWidth(Math.min(600, Math.max(200, newWidth)))
      }
    }

    const onUp = () => {
      isDragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [width, setCollapsed, setWidth, defaultWidth])

  const openOverlayTab = (tabId) => {
    setActiveTab(tabId)
    setOverlay(true)
  }

  const activeContent = tabs.find(t => t.id === activeTab)?.content ?? tabs[0]?.content

  // ── Collapsed: narrow icon bar ──────────────────────────────────────
  if (collapsed) {
    return (
      <>
        <div className="w-10 flex flex-col items-center py-2 gap-2 border-r border-border bg-bg-secondary shrink-0 select-none">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => openOverlayTab(id)}
              title={label}
              className="p-1.5 rounded-md hover:bg-surface-hover text-text-tertiary hover:text-text-secondary transition-colors"
            >
              <Icon size={16} />
            </button>
          ))}
          <button
            onClick={() => setCollapsed(false)}
            title="Expand sidebar"
            className="mt-auto p-1.5 rounded-md hover:bg-surface-hover text-text-tertiary hover:text-text-secondary transition-colors"
          >
            <ChevronRight size={16} />
          </button>
        </div>

        {/* Overlay panel */}
        {overlay && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOverlay(false)} />
            <div className="absolute left-10 top-0 bottom-0 z-40 w-96 bg-bg-secondary border-r border-border shadow-xl flex flex-col overflow-hidden">
              {/* Overlay tab bar */}
              <div className="flex shrink-0 border-b border-border">
                {tabs.map(({ id, label, icon: Icon, count }) => (
                  <button
                    key={id}
                    onClick={() => setActiveTab(id)}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium
                               transition-colors border-b-2
                               ${activeTab === id
                                 ? 'border-accent text-accent bg-accent/5'
                                 : 'border-transparent text-text-tertiary hover:text-text-secondary'
                               }`}
                  >
                    <Icon size={13} />
                    {label}{count != null ? ` (${count})` : ''}
                  </button>
                ))}
              </div>
              <div className="flex-1 overflow-y-auto">
                {activeContent}
              </div>
            </div>
          </>
        )}
      </>
    )
  }

  // ── Expanded: full sidebar with resize handle ───────────────────────
  return (
    <div
      className="flex flex-col overflow-hidden border-r border-border bg-bg-primary/50 shrink-0 relative select-none"
      style={{ width }}
    >
      {/* Tab bar */}
      <div className="flex shrink-0 border-b border-border">
        {tabs.map(({ id, label, icon: Icon, count }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium
                       transition-colors border-b-2
                       ${activeTab === id
                         ? 'border-accent text-accent bg-accent/5'
                         : 'border-transparent text-text-tertiary hover:text-text-secondary'
                       }`}
          >
            <Icon size={13} />
            {label}{count != null ? ` (${count})` : ''}
          </button>
        ))}
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse sidebar"
          className="px-2 py-2 text-text-tertiary hover:text-text-secondary transition-colors"
        >
          <ChevronLeft size={13} />
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeContent}
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={handleDragStart}
        className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/40 transition-colors z-10"
      />
    </div>
  )
}
