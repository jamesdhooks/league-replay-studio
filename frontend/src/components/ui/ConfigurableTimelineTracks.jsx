import { useMemo } from 'react'

/**
 * ConfigurableTimelineTracks — shared shell for timeline-style multi-row tracks.
 *
 * Provides a standard left gutter, scrollable track canvas, and optional playhead.
 * Track row rendering can be done via:
 * 1) `rows` config objects (recommended), or
 * 2) raw `children` for bespoke layouts.
 */
export default function ConfigurableTimelineTracks({
  gutterWidth = 52,
  gutterRows = [],
  rows = null,
  canvasHeight,
  contentWidth,
  containerClassName = 'flex-1 flex min-h-0 overflow-hidden bg-bg-secondary',
  gutterClassName = 'shrink-0 flex flex-col border-r border-border bg-bg-primary select-none z-10',
  scrollClassName = 'flex-1 overflow-x-hidden overflow-y-hidden',
  scrollRef,
  canvasRef,
  onScroll,
  children,
  playheadX = null,
  onPlayheadMouseDown,
  playheadTitle = 'Drag to scrub timeline position',
  playheadClassName = 'bg-red-500',
  playheadDraggingClassName = 'bg-red-400',
  isPlayheadDragging = false,
  showPlayheadDot = true,
}) {
  const rowsWithOffsets = useMemo(() => {
    if (!Array.isArray(rows) || rows.length === 0) return []
    let top = 0
    return rows.map((row) => {
      const currentTop = top
      top += row.height || 0
      return {
        ...row,
        top: currentTop,
      }
    })
  }, [rows])

  const effectiveGutterRows = useMemo(() => {
    if (Array.isArray(gutterRows) && gutterRows.length > 0) return gutterRows
    if (rowsWithOffsets.length === 0) return []
    return rowsWithOffsets.map((row) => ({
      key: row.key,
      label: row.label,
      height: row.height,
      className: row.gutterClassName,
      labelClassName: row.labelClassName,
    }))
  }, [gutterRows, rowsWithOffsets])

  const hasRowRenderers = useMemo(
    () => rowsWithOffsets.some((row) => typeof row.render === 'function'),
    [rowsWithOffsets]
  )

  return (
    <div className={containerClassName}>
      {gutterWidth > 0 && (
        <div className={gutterClassName} style={{ width: gutterWidth }}>
          {effectiveGutterRows.map((row) => (
            <div
              key={row.key}
              className={row.className || 'border-b border-border-subtle flex items-center justify-end pr-2'}
              style={{ height: row.height }}
            >
              {row.label && (
                <span className={row.labelClassName || 'text-[10px] text-text-disabled uppercase tracking-wider'}>
                  {row.label}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <div ref={scrollRef} className={scrollClassName} onScroll={onScroll}>
        <div ref={canvasRef} className="relative" style={{ width: contentWidth, height: canvasHeight }}>
          {hasRowRenderers
            ? rowsWithOffsets.map((row) => {
              if (typeof row.render !== 'function') return null
              return row.render({ top: row.top, height: row.height, row })
            })
            : children}

          {playheadX != null && (
            <div
              className="absolute top-0 bottom-0 z-40 cursor-ew-resize"
              style={{ left: playheadX }}
              onMouseDown={onPlayheadMouseDown}
              title={playheadTitle}
            >
              <div className={`w-px h-full ${isPlayheadDragging ? playheadDraggingClassName : playheadClassName}`} />
              {showPlayheadDot && (
                <div className={`absolute -top-1 -left-1 w-2 h-2 rounded-full ${isPlayheadDragging ? playheadDraggingClassName : playheadClassName}`} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
