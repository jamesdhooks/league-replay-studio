import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocalStorage } from '../../hooks/useLocalStorage'

/**
 * ResizableRowPane — generic top/bottom split with a draggable row divider.
 *
 * The `top` slot fills all available vertical space via flex-1.
 * The `bottom` slot has a persisted fixed height the user can resize by
 * dragging the 1px divider — identical visual style to HighlightPanel's
 * built-in timeline resize handle.
 *
 * Usage:
 *   <ResizableRowPane
 *     storageKey="lrs:overlay:timelineHeight"
 *     defaultBottomHeight={220}
 *     minBottom={80}
 *     top={<PreviewArea />}
 *     bottom={<TimelineStrip />}
 *   />
 */
export default function ResizableRowPane({
  storageKey,
  top,
  bottom,
  defaultBottomHeight = 160,
  minBottom = 80,
  maxBottom = 600,
  collapsed = false,
  collapsedBottomHeight = 64,
  containerClassName = 'flex flex-col flex-1 h-full min-h-0 overflow-hidden',
  topClassName = '',
  bottomClassName = 'overflow-hidden',
}) {
  const [bottomHeight, setBottomHeight] = useLocalStorage(storageKey, defaultBottomHeight)
  const [dragging, setDragging] = useState(false)
  const heightRef = useRef(bottomHeight)
  useEffect(() => { heightRef.current = bottomHeight }, [bottomHeight])

  const handleDragStart = useCallback((e) => {
    if (collapsed) return
    e.preventDefault()
    setDragging(true)
    const startY = e.clientY
    const startH = heightRef.current

    const onMove = (mv) => {
      const next = Math.max(minBottom, Math.min(maxBottom, startH - (mv.clientY - startY)))
      setBottomHeight(next)
    }

    const onUp = () => {
      setDragging(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [collapsed, minBottom, maxBottom, setBottomHeight])

  const effectiveBottomHeight = collapsed ? collapsedBottomHeight : bottomHeight
  const showBottomArea = effectiveBottomHeight > 0

  return (
    <div className={`${containerClassName}${dragging ? ' select-none' : ''}`}>
      {/* Top slot — fills remaining height */}
      <div className={`flex-1 min-h-0 overflow-hidden ${topClassName}`}>
        {top}
      </div>

      {showBottomArea && (
        <>
          {/* Drag handle — matches HighlightPanel timeline divider exactly */}
          <div
            className={`shrink-0 group/divider relative z-10 ${collapsed ? 'cursor-default' : 'cursor-row-resize'}`}
            style={{ height: 1, marginTop: -1 }}
            onMouseDown={collapsed ? undefined : handleDragStart}
          >
            <div className="absolute inset-x-0 -top-2 -bottom-2" />
            <div className="absolute inset-x-0 top-0 h-px bg-border transition-colors group-hover/divider:bg-accent group-active/divider:bg-accent" />
          </div>

          {/* Bottom slot — fixed height */}
          <div className={`shrink-0 ${bottomClassName}`} style={{ height: effectiveBottomHeight }}>
            {bottom}
          </div>
        </>
      )}
    </div>
  )
}
