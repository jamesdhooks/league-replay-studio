import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

/**
 * Tooltip — portal-based tooltip that renders above all other content.
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children  - The trigger element to wrap
 * @param {string}          props.content   - Tooltip text content
 * @param {'top'|'bottom'|'left'|'right'} [props.position='top'] - Preferred position
 * @param {number}          [props.delay=300] - Delay before showing (ms)
 * @param {string}          [props.className] - Additional classes for the tooltip container
 */
export default function Tooltip({
  children,
  content,
  position = 'top',
  delay = 300,
  className = '',
}) {
  const [visible, setVisible] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0 })
  const triggerRef = useRef(null)
  const tooltipRef = useRef(null)
  const timerRef = useRef(null)

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    const tooltip = tooltipRef.current
    if (!trigger || !tooltip) return

    const rect = trigger.getBoundingClientRect()
    const tipRect = tooltip.getBoundingClientRect()
    const gap = 6

    let top = 0
    let left = 0

    switch (position) {
      case 'bottom':
        top = rect.bottom + gap
        left = rect.left + rect.width / 2 - tipRect.width / 2
        break
      case 'left':
        top = rect.top + rect.height / 2 - tipRect.height / 2
        left = rect.left - tipRect.width - gap
        break
      case 'right':
        top = rect.top + rect.height / 2 - tipRect.height / 2
        left = rect.right + gap
        break
      case 'top':
      default:
        top = rect.top - tipRect.height - gap
        left = rect.left + rect.width / 2 - tipRect.width / 2
        break
    }

    // Clamp to viewport
    const pad = 8
    left = Math.max(pad, Math.min(left, window.innerWidth - tipRect.width - pad))
    top = Math.max(pad, Math.min(top, window.innerHeight - tipRect.height - pad))

    setCoords({ top, left })
  }, [position])

  useEffect(() => {
    if (visible) updatePosition()
  }, [visible, updatePosition])

  const show = () => {
    timerRef.current = setTimeout(() => setVisible(true), delay)
  }

  const hide = () => {
    clearTimeout(timerRef.current)
    setVisible(false)
  }

  useEffect(() => () => clearTimeout(timerRef.current), [])

  if (!content) return children

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className="inline-flex"
      >
        {children}
      </span>
      {visible &&
        createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            style={{ top: coords.top, left: coords.left }}
            className={`fixed z-[9999] max-w-xs px-3 py-2 text-xs leading-relaxed
                       text-white bg-gray-900 rounded-lg shadow-lg
                       border border-white/10 pointer-events-none
                       animate-fade-in ${className}`}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  )
}
