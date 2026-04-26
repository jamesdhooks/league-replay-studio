import { createContext, useCallback, useContext, useMemo, useState } from 'react'

const SharedPreviewSurfaceContext = createContext(null)

function shallowEqualObject(left, right) {
  if (left === right) return true
  if (!left || !right) return false

  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false

  return leftKeys.every((key) => left[key] === right[key])
}

/**
 * SharedPreviewSurfaceProvider
 *
 * Tracks preview target slots and which slot is currently active.
 * A single shared preview host uses this registry to render one persistent
 * preview surface into the active slot area.
 */
export function SharedPreviewSurfaceProvider({ children }) {
  const [targets, setTargets] = useState({})
  const [activeTargetId, setActiveTargetId] = useState(null)
  const [fallbackTarget, setFallbackTarget] = useState(null)

  const registerTarget = useCallback((id, element) => {
    if (!id || !element) return
    setTargets((prev) => {
      const current = prev[id]
      if (current?.element === element) return prev
      return {
        ...prev,
        [id]: {
          ...(current || {}),
          element,
        },
      }
    })
  }, [])

  const unregisterTarget = useCallback((id) => {
    if (!id) return
    setTargets((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setActiveTargetId((prev) => (prev === id ? null : prev))
  }, [])

  const updateTargetProps = useCallback((id, props) => {
    if (!id) return
    setTargets((prev) => {
      const current = prev[id] || {}
      if (shallowEqualObject(current.props, props)) return prev
      return {
        ...prev,
        [id]: {
          ...current,
          props,
        },
      }
    })
  }, [])

  const activateTarget = useCallback((id) => {
    if (!id) return
    setActiveTargetId((prev) => (prev === id ? prev : id))
  }, [])

  const deactivateTarget = useCallback((id) => {
    if (!id) return
    setActiveTargetId((prev) => (prev === id ? null : prev))
  }, [])

  const registerFallbackTarget = useCallback((element) => {
    if (!element) return
    setFallbackTarget({ element })
  }, [])

  const unregisterFallbackTarget = useCallback((element) => {
    if (!element) return
    setFallbackTarget((prev) => {
      if (!prev?.element) return null
      return prev.element === element ? null : prev
    })
  }, [])

  const activeTarget = activeTargetId ? targets[activeTargetId] || null : null

  const value = useMemo(() => ({
    registerTarget,
    unregisterTarget,
    updateTargetProps,
    activateTarget,
    deactivateTarget,
    registerFallbackTarget,
    unregisterFallbackTarget,
    activeTarget,
    fallbackTarget,
  }), [
    registerTarget,
    unregisterTarget,
    updateTargetProps,
    activateTarget,
    deactivateTarget,
    registerFallbackTarget,
    unregisterFallbackTarget,
    activeTarget,
    fallbackTarget,
  ])

  return (
    <SharedPreviewSurfaceContext.Provider value={value}>
      {children}
    </SharedPreviewSurfaceContext.Provider>
  )
}

export function useSharedPreviewSurface() {
  const context = useContext(SharedPreviewSurfaceContext)
  if (!context) {
    throw new Error('useSharedPreviewSurface must be used within a SharedPreviewSurfaceProvider')
  }
  return context
}
