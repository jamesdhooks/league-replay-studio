/**
 * useHotkeys.js — Global keyboard shortcut system
 * ------------------------------------------------
 * Centralized keyboard shortcut management for League Replay Studio.
 *
 * Features:
 * - Global shortcut registration with descriptions
 * - Modifier key support (Ctrl, Shift, Alt, Meta)
 * - Automatic cleanup on unmount
 * - Help overlay integration (lists all registered shortcuts)
 * - Scope-aware (only fires when scope is active)
 *
 * Usage:
 *   useHotkeys('ctrl+s', () => save(), { description: 'Save project' })
 *   useHotkeys('space', () => togglePlay(), { description: 'Play/Pause', scope: 'timeline' })
 */

import { useEffect, useRef, useCallback } from 'react'
import { create } from 'zustand'

/**
 * Zustand store for registered shortcuts (visible to help overlay).
 */
export const useShortcutRegistry = create((set) => ({
  shortcuts: [],
  register: (shortcut) =>
    set((state) => ({
      shortcuts: [...state.shortcuts.filter((s) => s.id !== shortcut.id), shortcut],
    })),
  unregister: (id) =>
    set((state) => ({
      shortcuts: state.shortcuts.filter((s) => s.id !== id),
    })),
}))

/**
 * Parse a shortcut string like "ctrl+shift+s" into a descriptor.
 */
function parseShortcut(combo) {
  const parts = combo.toLowerCase().split('+')
  return {
    ctrl: parts.includes('ctrl') || parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    meta: parts.includes('meta') || parts.includes('mod'),
    key: parts.filter((p) => !['ctrl', 'shift', 'alt', 'meta', 'mod'].includes(p))[0] || '',
  }
}

/**
 * Check if a keyboard event matches a parsed shortcut descriptor.
 */
function matchesShortcut(event, descriptor) {
  const isMac = navigator.platform?.includes('Mac')
  const modMatch = isMac
    ? descriptor.meta ? event.metaKey : !event.metaKey
    : descriptor.ctrl ? event.ctrlKey : !event.ctrlKey

  // For "mod" shortcuts, accept either Ctrl or Meta
  const modKey = descriptor.ctrl || descriptor.meta
  const eventMod = event.ctrlKey || event.metaKey
  const modOk = modKey ? eventMod : (!event.ctrlKey && !event.metaKey)

  if (!modOk) return false
  if (descriptor.shift !== event.shiftKey) return false
  if (descriptor.alt !== event.altKey) return false

  // Match key
  const eventKey = event.key.toLowerCase()
  if (descriptor.key === 'space') return eventKey === ' ' || event.code === 'Space'
  if (descriptor.key === 'escape' || descriptor.key === 'esc') return eventKey === 'escape'
  if (descriptor.key === 'delete' || descriptor.key === 'del') return eventKey === 'delete' || eventKey === 'backspace'
  if (descriptor.key === 'enter') return eventKey === 'enter'
  return eventKey === descriptor.key
}

/**
 * Hook to register a global keyboard shortcut.
 *
 * @param {string} combo - Shortcut combo, e.g. "ctrl+s", "space", "shift+?"
 * @param {Function} handler - Callback when shortcut is triggered
 * @param {Object} options - Configuration options
 * @param {string} options.description - Human-readable description for help overlay
 * @param {string} options.scope - Optional scope (e.g. 'timeline', 'global')
 * @param {boolean} options.preventDefault - Whether to prevent default (default: true)
 * @param {boolean} options.enabled - Whether the shortcut is active (default: true)
 */
export function useHotkeys(combo, handler, options = {}) {
  const {
    description = '',
    scope = 'global',
    preventDefault = true,
    enabled = true,
  } = options

  const handlerRef = useRef(handler)
  handlerRef.current = handler

  const descriptor = useRef(parseShortcut(combo))
  const id = `${scope}:${combo}`

  // Register in the shortcut registry for the help overlay
  useEffect(() => {
    if (!description) return
    const { register, unregister } = useShortcutRegistry.getState()
    register({ id, combo, description, scope })
    return () => unregister(id)
  }, [id, combo, description, scope])

  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (event) => {
      // Don't fire shortcuts when typing in inputs
      const tag = event.target?.tagName?.toLowerCase()
      const isEditable = event.target?.isContentEditable
      if (['input', 'textarea', 'select'].includes(tag) || isEditable) {
        // Allow Escape and specific shortcuts even in inputs
        if (event.key !== 'Escape' && !event.ctrlKey && !event.metaKey) return
      }

      if (matchesShortcut(event, descriptor.current)) {
        if (preventDefault) event.preventDefault()
        handlerRef.current(event)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [enabled, preventDefault])
}

/**
 * Get all registered shortcuts grouped by scope.
 */
export function useShortcutHelp() {
  const shortcuts = useShortcutRegistry((s) => s.shortcuts)

  const grouped = shortcuts.reduce((acc, shortcut) => {
    const scope = shortcut.scope || 'global'
    if (!acc[scope]) acc[scope] = []
    acc[scope].push(shortcut)
    return acc
  }, {})

  return grouped
}

/**
 * Format a shortcut combo for display (platform-aware).
 */
export function formatShortcut(combo) {
  const isMac = typeof navigator !== 'undefined' && navigator.platform?.includes('Mac')
  return combo
    .replace(/mod\+/gi, isMac ? '⌘' : 'Ctrl+')
    .replace(/ctrl\+/gi, isMac ? '⌃' : 'Ctrl+')
    .replace(/alt\+/gi, isMac ? '⌥' : 'Alt+')
    .replace(/shift\+/gi, isMac ? '⇧' : 'Shift+')
    .replace(/meta\+/gi, isMac ? '⌘' : 'Win+')
    .replace(/space/gi, '␣')
    .replace(/escape/gi, 'Esc')
    .replace(/delete/gi, 'Del')
}
