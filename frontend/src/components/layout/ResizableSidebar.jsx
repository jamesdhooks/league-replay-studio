import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react'
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
export default forwardRef(function ResizableSidebar({
  tabs,
  storageKey,
  defaultWidth = 384,
  defaultTab,
  headerContent,
}, ref) {
  const firstTab = defaultTab || tabs[0]?.id || ''

  const [activeTab, setActiveTab] = useLocalStorage(`${storageKey}:tab`, firstTab)
  const [width, setWidth] = useLocalStorage(`${storageKey}:width`, defaultWidth)
  const [collapsed, setCollapsed] = useLocalStorage(`${storageKey}:collapsed`, false)
  const [overlay, setOverlay] = useState(false)
  const [overlayAnchor, setOverlayAnchor] = useState(null)
  const isDragging = useRef(false)
  const [dragging, setDragging] = useState(false)
  const collapsedRailRef = useRef(null)

  const updateOverlayAnchor = useCallback(() => {
    const rail = collapsedRailRef.current
    if (!rail) return
    const rect = rail.getBoundingClientRect()
    setOverlayAnchor({
      left: rect.right,
      top: rect.top,
      height: rect.height,
    })
  }, [])

  useEffect(() => {
    if (!overlay) return undefined
    const refresh = () => updateOverlayAnchor()
    window.addEventListener('resize', refresh)
    window.addEventListener('scroll', refresh, true)
    refresh()
    return () => {
      window.removeEventListener('resize', refresh)
      window.removeEventListener('scroll', refresh, true)
    }
  }, [overlay, updateOverlayAnchor])

  useImperativeHandle(ref, () => ({
    switchTab: (tabId) => {
      setActiveTab(tabId)
      if (collapsed) {
        updateOverlayAnchor()
        setOverlay(true)
      }
    },
  }), [collapsed, setActiveTab, updateOverlayAnchor])

  const handleDragStart = useCallback((e) => {
    isDragging.current = true
    setDragging(true)
    const startX = e.clientX
    const startWidth = width

    const onMove = (moveEvt) => {
      const newWidth = startWidth + (moveEvt.clientX - startX)
      if (newWidth < 150) {
        setCollapsed(true)
        setWidth(defaultWidth)
        isDragging.current = false
        setDragging(false)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      } else {
        setWidth(Math.min(600, Math.max(200, newWidth)))
      }
    }

    const onUp = () => {
      isDragging.current = false
      setDragging(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [width, setCollapsed, setWidth, defaultWidth])

  const openOverlayTab = (tabId) => {
    setActiveTab(tabId)
    updateOverlayAnchor()
    setOverlay(true)
  }

  const activeContent = tabs.find(t => t.id === activeTab)?.content ?? tabs[0]?.content

  // ── Collapsed: narrow icon bar ──────────────────────────────────────
  if (collapsed) {
    return (
      <>
        <div ref={collapsedRailRef} className="w-10 flex flex-col items-center py-2 gap-2 border-r border-border bg-bg-secondary shrink-0 select-none">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => openOverlayTab(id)}
              title={label}
              className="p-1.5 rounded-md hover:bg-surface-hover text-accent/80 hover:text-accent transition-colors"
            >
              <Icon size={16} />
            </button>
          ))}
          <button
            onClick={() => setCollapsed(false)}
            title="Expand sidebar"
            className="p-1.5 rounded-md hover:bg-surface-hover text-accent/80 hover:text-accent transition-colors"
          >
            <ChevronRight size={16} />
          </button>
        </div>

        {/* Overlay panel */}
        {overlay && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOverlay(false)} />
            <div
              className="fixed z-40 w-96 bg-bg-secondary border-r border-border shadow-xl flex flex-col overflow-hidden"
              style={{
                left: overlayAnchor?.left ?? 40,
                top: overlayAnchor?.top ?? 0,
                height: overlayAnchor?.height ?? window.innerHeight,
              }}
            >
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
                            <Icon size={13} className={activeTab === id ? 'text-accent' : 'text-accent/70'} />
                    {label}{count != null ? ` (${count})` : ''}
                  </button>
                ))}
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
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
      className={`flex flex-col overflow-hidden bg-bg-primary/50 shrink-0 relative${dragging ? ' select-none' : ''}`}
      style={{ width }}
    >
      {/* Optional header content above tabs */}
      {headerContent}

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
            <Icon size={13} className={activeTab === id ? 'text-accent' : 'text-accent/70'} />
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
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeContent}
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={handleDragStart}
        className="absolute top-0 bottom-0 right-0 cursor-col-resize group/divider z-30"
        style={{ width: 1, marginRight: -1 }}
      >
        <div className="absolute inset-y-0 -left-2 -right-2" />
        <div className="absolute inset-y-0 right-0 w-px bg-border transition-colors group-hover/divider:bg-accent group-active/divider:bg-accent" />
        <div className="absolute inset-y-0 right-0 w-[2px] bg-violet-400/90 opacity-0 transition-opacity group-hover/divider:opacity-100 group-active/divider:opacity-100" />
      </div>
    </div>
  )
})
