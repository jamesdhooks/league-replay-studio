import { useState, useCallback } from 'react'

/**
 * useAsyncAction — wraps an async operation with loading state tracking.
 *
 * @returns {{ isLoading: boolean, error: Error|null, execute: (fn: () => Promise) => Promise }}
 */
export function useAsyncAction() {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)

  const execute = useCallback(async (fn) => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await fn()
      return result
    } catch (err) {
      setError(err)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [])

  return { isLoading, error, execute }
}
