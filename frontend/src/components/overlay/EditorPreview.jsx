import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, ZoomIn, ZoomOut, Maximize2, Move, MousePointer2 } from 'lucide-react'

/**
 * EditorPreview — Live preview display for the overlay editor.
 *
 * Shows the rendered overlay frame with:
 *  - Render timing metrics
 *  - Zoom controls
 *  - Element picker mode toggle (visual selection)
 *  - Resize handles on selected elements
 */
export default function EditorPreview({
  previewData,
  isRendering,
  renderTime,
  resolution,
  elementPickerActive,
  onToggleElementPicker,
  onElementSelected,
}) {
  const [zoom, setZoom] = useState(0.5)
  const containerRef = useRef(null)

  // ── Zoom controls ────────────────────────────────────────────────────────
  const zoomIn = useCallback(() => setZoom(z => Math.min(z + 0.1, 2)), [])
  const zoomOut = useCallback(() => setZoom(z => Math.max(z - 0.1, 0.1)), [])
  const zoomFit = useCallback(() => {
    if (containerRef.current && resolution) {
      const container = containerRef.current.getBoundingClientRect()
      const scaleW = (container.width - 32) / resolution.width
      const scaleH = (container.height - 32) / resolution.height
      setZoom(Math.min(scaleW, scaleH, 1))
    }
  }, [resolution])

  // Auto-fit on mount and when resolution changes
  useEffect(() => {
    const timer = setTimeout(zoomFit, 100)
    return () => clearTimeout(timer)
  }, [zoomFit])

  // ── Handle click on preview for element picking ──────────────────────────
  const handlePreviewClick = useCallback((e) => {
    if (!elementPickerActive || !onElementSelected) return

    const img = e.currentTarget
    const rect = img.getBoundingClientRect()
    const x = Math.round(((e.clientX - rect.left) / rect.width) * (resolution?.width || 1920))
    const y = Math.round(((e.clientY - rect.top) / rect.height) * (resolution?.height || 1080))
    onElementSelected({ x, y })
  }, [elementPickerActive, onElementSelected, resolution])

  return (
    <div className="flex flex-col h-full bg-bg-primary">

      {/* ── Preview toolbar ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-bg-secondary/50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-secondary">Preview</span>

          {/* Render timing */}
          {renderTime != null && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded tabular-nums ${
              renderTime < 200 ? 'bg-green-900/30 text-green-400' : 'bg-yellow-900/30 text-yellow-400'
            }`}>
              {renderTime}ms
            </span>
          )}

          {isRendering && (
            <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Element picker toggle */}
          <button
            onClick={onToggleElementPicker}
            className={`p-1 rounded text-xs ${
              elementPickerActive
                ? 'bg-blue-600 text-white'
                : 'text-text-tertiary hover:text-text-primary hover:bg-bg-secondary'
            }`}
            title="Element picker — click on preview to select elements"
          >
            <MousePointer2 className="w-3.5 h-3.5" />
          </button>

          {/* Zoom controls */}
          <button onClick={zoomOut} className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-secondary" title="Zoom out">
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="text-[10px] text-text-tertiary tabular-nums w-8 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button onClick={zoomIn} className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-secondary" title="Zoom in">
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button onClick={zoomFit} className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-secondary" title="Fit to view">
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Preview canvas ───────────────────────────────────────────────── */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto flex items-center justify-center p-4"
        style={{ background: 'repeating-conic-gradient(#1a1a2e 0% 25%, #12121e 0% 50%) 0 0 / 20px 20px' }}
      >
        {previewData ? (
          <img
            src={`data:image/png;base64,${previewData}`}
            alt="Overlay preview"
            onClick={handlePreviewClick}
            className={`shadow-2xl border border-border/30 ${
              elementPickerActive ? 'cursor-crosshair' : 'cursor-default'
            }`}
            style={{
              width: (resolution?.width || 1920) * zoom,
              height: (resolution?.height || 1080) * zoom,
              imageRendering: zoom > 1 ? 'pixelated' : 'auto',
            }}
            draggable={false}
          />
        ) : (
          <div className="flex flex-col items-center gap-3 text-text-tertiary">
            {isRendering ? (
              <>
                <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
                <span className="text-sm">Rendering preview…</span>
              </>
            ) : (
              <>
                <div className="w-24 h-14 rounded border-2 border-dashed border-border flex items-center justify-center">
                  <Move className="w-6 h-6 text-text-tertiary/50" />
                </div>
                <span className="text-sm">Edit the template to see a live preview</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Resolution info ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border text-[10px] text-text-tertiary">
        <span>{resolution?.width || 1920} × {resolution?.height || 1080}</span>
        {previewData && (
          <span>{Math.round((previewData.length * 3) / 4 / 1024)} KB</span>
        )}
      </div>
    </div>
  )
}
