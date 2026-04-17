import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocalStorage } from '../../hooks/useLocalStorage'

/**
 * ResizableSplitPane — generic left/right split with persisted left width.
 * maxLeftPct (0–1) caps the left pane as a fraction of the container width.
 */
export default function ResizableSplitPane({
  storageKey,
  left,
  right,
  defaultLeftWidth = 520,
  minLeft = 280,
  maxLeft = Infinity,
  maxLeftPct = 1,
  containerClassName = 'flex flex-1 overflow-hidden relative',
  leftClassName = '',
  rightClassName = '',
}) {
  const [leftWidth, setLeftWidth] = useLocalStorage(storageKey, defaultLeftWidth)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef(false)
  const containerRef = useRef(null)
  const [containerWidth, setContainerWidth] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const effectiveMax = Math.min(
    maxLeft,
    containerWidth > 0 ? Math.floor(containerWidth * maxLeftPct) : maxLeft,
  )

  const handleDragStart = useCallback((e) => {
    dragRef.current = true
    setDragging(true)
    const startX = e.clientX
    const startWidth = leftWidth
    const containerEl = containerRef.current
    const cw = containerEl ? containerEl.getBoundingClientRect().width : 0
    const dynMax = Math.min(maxLeft, cw > 0 ? Math.floor(cw * maxLeftPct) : maxLeft)

    const onMove = (moveEvt) => {
      const nextWidth = startWidth + (moveEvt.clientX - startX)
      setLeftWidth(Math.min(dynMax, Math.max(minLeft, nextWidth)))
    }

    const onUp = () => {
      dragRef.current = false
      setDragging(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [leftWidth, maxLeft, minLeft, setLeftWidth])

  return (
    <div ref={containerRef} className={`${containerClassName}${dragging ? ' select-none' : ''}`}>
      <div className={`shrink-0 ${leftClassName}`} style={{ width: Math.min(effectiveMax, Math.max(minLeft, leftWidth)) }}>
        {left}
      </div>
      <div
        onMouseDown={handleDragStart}
        className="relative shrink-0 cursor-col-resize group/divider z-10"
        style={{ width: 1 }}
      >
        <div className="absolute inset-y-0 -left-2 -right-2" />
        <div className="absolute inset-y-0 right-0 w-px bg-border transition-colors group-hover/divider:bg-accent group-active/divider:bg-accent" />
      </div>
      <div className={`min-w-0 flex-1 ${rightClassName}`}>
        {right}
      </div>
    </div>
  )
}
