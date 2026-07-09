import { useEffect, useRef, useCallback, useState } from 'react'
import { Loader2, Move } from 'lucide-react'
import IsolatedHtmlPreview from '../ui/IsolatedHtmlPreview'

/**
 * EditorPreview — Live preview display for the overlay editor.
 *
 * Shows the rendered overlay frame for the Build workspace.
 */
export default function EditorPreview({
  previewData,
  previewHtml,
  previewError,
  isRendering,
  resolution,
  elementPickerActive,
  onElementSelected,
  previewRenderMode = 'png',
  overlayVisible = true,
  previewZoom = 1,
  showStreamUnderlay = false,
  highlightSelector = null,
  highlightNonce = 0,
}) {
  const containerRef = useRef(null)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const node = containerRef.current
    if (!node) return undefined

    const measure = () => {
      const rect = node.getBoundingClientRect()
      setViewportSize({ width: Math.max(0, rect.width), height: Math.max(0, rect.height) })
    }

    const observer = new ResizeObserver(measure)
    observer.observe(node)
    measure()

    return () => observer.disconnect()
  }, [])

  const renderWidth = Number(resolution?.width) || 1920
  const renderHeight = Number(resolution?.height) || 1080
  const targetAspect = renderWidth > 0 && renderHeight > 0 ? renderWidth / renderHeight : (16 / 9)
  const availW = Number(viewportSize.width) || renderWidth
  const availH = Number(viewportSize.height) || renderHeight
  let frameWidth = availW
  let frameHeight = frameWidth / targetAspect
  if (frameHeight > availH) {
    frameHeight = availH
    frameWidth = frameHeight * targetAspect
  }

  const fitScale = Math.min(
    frameWidth / renderWidth,
    frameHeight / renderHeight,
  )
  const appliedScale = fitScale

  // ── Handle click on preview for element picking ──────────────────────────
  const handlePreviewClick = useCallback((e) => {
    if (!elementPickerActive || !onElementSelected) return

    const img = e.currentTarget
    const rect = img.getBoundingClientRect()
    const x = Math.round(((e.clientX - rect.left) / rect.width) * renderWidth)
    const y = Math.round(((e.clientY - rect.top) / rect.height) * renderHeight)
    onElementSelected({ x, y })
  }, [elementPickerActive, onElementSelected, renderHeight, renderWidth])

  return (
    <div className={`h-full min-h-0 flex flex-col ${showStreamUnderlay ? 'bg-transparent' : 'bg-bg-primary'}`}>
      <div
        ref={containerRef}
        className={`relative flex-1 min-h-0 flex items-center justify-center overflow-hidden ${showStreamUnderlay ? 'bg-transparent' : 'bg-[#0a0a0a]'}`}
      >
        {(overlayVisible && (previewRenderMode === 'png' ? previewData : previewHtml)) ? (
          <div
            className="relative border border-border/30 rounded overflow-hidden"
            style={{
              width: `${Math.max(1, frameWidth)}px`,
              height: `${Math.max(1, frameHeight)}px`,
            }}
          >
            {overlayVisible && previewRenderMode === 'png' && previewData ? (
              <img
                src={`data:image/png;base64,${previewData}`}
                alt="Overlay preview"
                onClick={handlePreviewClick}
                className={`${
                  elementPickerActive ? 'cursor-crosshair pointer-events-auto' : 'cursor-default pointer-events-none'
                } absolute inset-0 w-full h-full object-contain shadow-2xl`}
                style={{
                  transformOrigin: 'center center',
                  transform: `scale(${previewZoom})`,
                  imageRendering: previewZoom > 1 ? 'pixelated' : 'auto',
                }}
                draggable={false}
              />
            ) : (
              <IsolatedHtmlPreview
                html={previewHtml}
                highlightSelector={highlightSelector}
                highlightNonce={highlightNonce}
                zoom={previewZoom}
                className="absolute left-1/2 top-1/2 border-0 bg-transparent pointer-events-none"
                style={{
                  width: `${renderWidth}px`,
                  height: `${renderHeight}px`,
                  transformOrigin: 'center center',
                  transform: `translate(-50%, -50%) scale(${appliedScale})`,
                  background: 'transparent',
                }}
              />
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 text-text-tertiary">
            {isRendering ? (
              <>
                <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
                <span className="text-sm">Rendering overlay...</span>
              </>
            ) : previewError ? (
              <>
                <div className="w-24 h-14 rounded border-2 border-dashed border-danger/50 flex items-center justify-center">
                  <Move className="w-6 h-6 text-danger/60" />
                </div>
                <span className="text-sm text-danger">Preview render failed</span>
                <span className="text-xs text-text-tertiary max-w-md text-center">{previewError}</span>
              </>
            ) : !overlayVisible && showStreamUnderlay ? null : !overlayVisible ? (
              <>
                <div className="w-24 h-14 rounded border-2 border-dashed border-border flex items-center justify-center">
                  <Move className="w-6 h-6 text-text-tertiary/50" />
                </div>
                <span className="text-sm">Overlay hidden</span>
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
    </div>
  )
}
