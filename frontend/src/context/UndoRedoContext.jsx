import { createContext, useContext, useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useProject } from './ProjectContext'

const UndoRedoContext = createContext(null)

/**
 * UndoRedoProvider — manages unlimited undo/redo history.
 *
 * Uses a command pattern: each tracked operation pushes an action
 * object with `undo()` and `redo()` callbacks.  Session-scoped —
 * history resets when the active project changes.
 *
 * Keyboard shortcuts (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z) are
 * registered at the document level.
 */
export function UndoRedoProvider({ children }) {
  // ── History stack ──────────────────────────────────────────────────────
  // history[0..currentIndex] are committed actions.
  // history[currentIndex+1..] are redoable (undone) actions.
  const [history, setHistory] = useState([])
  const [currentIndex, setCurrentIndex] = useState(-1)

  // Track active project to reset on change
  const { activeProject } = useProject()
  const prevProjectRef = useRef(activeProject?.id)

  // Reset history when the project changes
  useEffect(() => {
    const pid = activeProject?.id ?? null
    if (pid !== prevProjectRef.current) {
      prevProjectRef.current = pid
      setHistory([])
      setCurrentIndex(-1)
    }
  }, [activeProject])

  // Keep refs for stable callbacks that avoid stale closures
  const historyRef = useRef(history)
  const indexRef = useRef(currentIndex)
  historyRef.current = history
  indexRef.current = currentIndex

  // ── Push a new action ──────────────────────────────────────────────────
  const pushAction = useCallback((action) => {
    // action: { type, description, undo: async fn, redo: async fn }
    const idx = indexRef.current
    setHistory(prev => {
      const trimmed = prev.slice(0, idx + 1)
      return [...trimmed, { ...action, timestamp: Date.now() }]
    })
    setCurrentIndex(idx + 1)
  }, [])

  // ── Undo ───────────────────────────────────────────────────────────────
  const undo = useCallback(async () => {
    const idx = indexRef.current
    const h = historyRef.current
    if (idx < 0) return
    const action = h[idx]
    if (!action) return
    try {
      await action.undo()
      setCurrentIndex(idx - 1)
    } catch (err) {
      console.error('[UndoRedo] Undo failed:', err)
    }
  }, [])

  // ── Redo ───────────────────────────────────────────────────────────────
  const redo = useCallback(async () => {
    const idx = indexRef.current
    const h = historyRef.current
    if (idx >= h.length - 1) return
    const action = h[idx + 1]
    if (!action) return
    try {
      await action.redo()
      setCurrentIndex(idx + 1)
    } catch (err) {
      console.error('[UndoRedo] Redo failed:', err)
    }
  }, [])

  // ── State flags ────────────────────────────────────────────────────────
  const canUndo = currentIndex >= 0
  const canRedo = currentIndex < history.length - 1

  // ── Clear history ──────────────────────────────────────────────────────
  const clearHistory = useCallback(() => {
    setHistory([])
    setCurrentIndex(-1)
  }, [])

  // ── Visible history entries ────────────────────────────────────────────
  const visibleHistory = useMemo(() => {
    return history.map((action, idx) => ({
      ...action,
      index: idx,
      isCurrent: idx === currentIndex,
      isUndone: idx > currentIndex,
    }))
  }, [history, currentIndex])

  // ── Keyboard shortcuts ─────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't capture when typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return

      const isCtrl = e.ctrlKey || e.metaKey

      // Ctrl+Z → Undo
      if (isCtrl && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
        return
      }

      // Ctrl+Y or Ctrl+Shift+Z → Redo
      if (isCtrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey) || (e.key === 'Z' && e.shiftKey))) {
        e.preventDefault()
        redo()
        return
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [undo, redo])

  // ── Context value ──────────────────────────────────────────────────────
  const value = useMemo(() => ({
    pushAction,
    undo,
    redo,
    canUndo,
    canRedo,
    clearHistory,
    history: visibleHistory,
    currentIndex,
  }), [pushAction, undo, redo, canUndo, canRedo, clearHistory, visibleHistory, currentIndex])

  return (
    <UndoRedoContext.Provider value={value}>
      {children}
    </UndoRedoContext.Provider>
  )
}

/**
 * Hook to access undo/redo state and methods.
 */
export function useUndoRedo() {
  const context = useContext(UndoRedoContext)
  if (!context) {
    throw new Error('useUndoRedo must be used within an UndoRedoProvider')
  }
  return context
}
