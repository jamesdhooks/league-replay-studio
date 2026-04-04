import { useState, useCallback } from 'react'

/**
 * Hook for persisting state in localStorage.
 *
 * @param {string} key - localStorage key
 * @param {*} defaultValue - default value if key not found
 * @returns {[*, Function]} - [value, setValue]
 */
export function useLocalStorage(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key)
      return stored !== null ? JSON.parse(stored) : defaultValue
    } catch {
      return defaultValue
    }
  })

  const setStoredValue = useCallback((newValue) => {
    setValue(prev => {
      const resolved = typeof newValue === 'function' ? newValue(prev) : newValue
      try {
        localStorage.setItem(key, JSON.stringify(resolved))
      } catch {
        // localStorage might be full or disabled
      }
      return resolved
    })
  }, [key])

  return [value, setStoredValue]
}
