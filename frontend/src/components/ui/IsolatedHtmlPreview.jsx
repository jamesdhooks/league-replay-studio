import { useEffect, useRef } from 'react'

/**
 * IsolatedHtmlPreview
 * Renders HTML inside a Shadow DOM root to isolate styles from the app shell
 * while preserving transparent compositing like inline rendering.
 */
export default function IsolatedHtmlPreview({ html, className = '', style = {} }) {
  const hostRef = useRef(null)
  const shadowRef = useRef(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    if (!shadowRef.current) {
      shadowRef.current = host.attachShadow({ mode: 'open' })
    }

    const shadow = shadowRef.current
    shadow.innerHTML = html || ''
  }, [html])

  return (
    <div
      ref={hostRef}
      className={className}
      style={{
        ...style,
        background: 'transparent',
      }}
    />
  )
}
