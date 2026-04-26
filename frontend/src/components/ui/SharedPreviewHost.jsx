import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { LivePreviewSurface } from '../analysis/PreviewPlayer'
import { useSharedPreviewSurface } from '../../context/SharedPreviewSurfaceContext'

const TARGET_HANDOFF_DELAY_MS = 180

/**
 * SharedPreviewHost
 *
 * Renders a single persistent preview surface and positions it over the
 * currently active target slot.
 */
export default function SharedPreviewHost() {
  const { activeTarget, fallbackTarget } = useSharedPreviewSurface()
  const [rect, setRect] = useState(null)
  const [latchedProps, setLatchedProps] = useState(null)
  const [resolvedTarget, setResolvedTarget] = useState(null)

  useEffect(() => {
    let timeoutId = null

    if (activeTarget?.element) {
      setResolvedTarget(activeTarget)
    } else {
      timeoutId = setTimeout(() => {
        if (fallbackTarget?.element) {
          setResolvedTarget(fallbackTarget)
        } else {
          setResolvedTarget(null)
        }
      }, TARGET_HANDOFF_DELAY_MS)
    }

    return () => {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [activeTarget, fallbackTarget])

  const targetElement = resolvedTarget?.element || null
  const targetProps = resolvedTarget?.props || null

  useEffect(() => {
    // Keep the last valid props only while a target is active; clear when
    // no target props are present so stale preview streams do not render in
    // the fallback floating slot on unrelated screens (for example Compose).
    setLatchedProps(targetProps || null)
  }, [targetProps])

  useLayoutEffect(() => {
    if (!targetElement) {
      setRect(null)
      return undefined
    }

    const updateRect = () => {
      if (!targetElement?.isConnected) {
        setRect(null)
        return
      }
      const next = targetElement.getBoundingClientRect()
      if (next.width <= 0 || next.height <= 0) {
        setRect(null)
        return
      }
      setRect({
        top: next.top,
        left: next.left,
        width: next.width,
        height: next.height,
      })
    }

    updateRect()

    const observer = new ResizeObserver(updateRect)
    observer.observe(targetElement)

    window.addEventListener('resize', updateRect)
    window.addEventListener('scroll', updateRect, true)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateRect)
      window.removeEventListener('scroll', updateRect, true)
    }
  }, [targetElement])

  const layout = useMemo(() => {
    if (!rect) {
      return {
        host: { top: -10000, left: -10000, width: 1, height: 1, opacity: 0 },
        preview: { top: 0, left: 0, width: 1, height: 1 },
      }
    }

    const targetAspect = Math.max(0.2, Number(latchedProps?.aspectRatio) || (16 / 9))
    const availableWidth = Math.max(1, rect.width)
    const availableHeight = Math.max(1, rect.height)

    // Fit preview to aspect ratio inside the slot.
    let fittedWidth = availableWidth
    let fittedHeight = fittedWidth / targetAspect

    if (fittedHeight > availableHeight) {
      fittedHeight = availableHeight
      fittedWidth = fittedHeight * targetAspect
    }

    // Explicitly calculate the centered position so there is no dependency
    // on flex alignment resolving correctly inside the fixed host.
    const previewTop = Math.round((availableHeight - fittedHeight) / 2)
    const previewLeft = Math.round((availableWidth - fittedWidth) / 2)

    return {
      host: {
        top: rect.top,
        left: rect.left,
        width: availableWidth,
        height: availableHeight,
        opacity: 1,
      },
      preview: {
        top: previewTop,
        left: previewLeft,
        width: Math.round(fittedWidth),
        height: Math.round(fittedHeight),
      },
    }
  }, [rect, latchedProps?.aspectRatio])

  if (!latchedProps) return null

  const { host, preview } = layout

  return (
    <div
      className="fixed z-30 pointer-events-none"
      style={host}
      aria-hidden="true"
    >
      {/* Preview — rendered first (below overlay in z-stack) */}
      <div
        className="absolute pointer-events-auto"
        style={preview}
      >
        <LivePreviewSurface {...latchedProps} />
      </div>
      {/* Overlay content — rendered after preview so it sits on top naturally */}
      {latchedProps.overlayContent}
    </div>
  )
}
