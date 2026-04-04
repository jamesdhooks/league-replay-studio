/**
 * API client for League Replay Studio backend.
 * All REST communication goes through this module.
 *
 * Features:
 * - Retry with exponential backoff (configurable)
 * - Request timeout (default 15 s)
 * - Structured error objects with status code
 */

const API_BASE = '/api'
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_RETRIES = 2
const RETRY_BASE_DELAY_MS = 500

// Status codes that are safe to retry on
const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504])

/**
 * Custom API error with status code and parsed detail.
 */
export class ApiError extends Error {
  constructor(message, status, detail) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

/**
 * Internal fetch wrapper with timeout + retry.
 */
async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (response.ok) {
        // Handle 204 No Content
        if (response.status === 204) return null
        return await response.json()
      }

      // Parse error body
      const error = await response.json().catch(() => ({
        message: response.statusText,
      }))

      // Retry on transient errors if attempts remain
      if (attempt < retries && RETRYABLE_STATUS.has(response.status)) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }

      throw new ApiError(
        error.message || error.detail || `${options.method || 'GET'} ${url} failed: ${response.status}`,
        response.status,
        error,
      )
    } catch (err) {
      clearTimeout(timeout)

      if (err instanceof ApiError) throw err

      // AbortController timeout
      if (err.name === 'AbortError') {
        if (attempt < retries) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        throw new ApiError(`Request timed out: ${url}`, 0, { timeout: true })
      }

      // Network error — retry
      if (attempt < retries) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }

      throw new ApiError(
        err.message || `Network error: ${url}`,
        0,
        { network: true },
      )
    }
  }
}

/**
 * Make a GET request.
 * @param {string} path - API path (e.g., '/system/health')
 * @returns {Promise<any>}
 */
export async function apiGet(path) {
  return fetchWithRetry(`${API_BASE}${path}`)
}

/**
 * Make a POST request.
 * @param {string} path
 * @param {any} [body]
 * @returns {Promise<any>}
 */
export async function apiPost(path, body) {
  return fetchWithRetry(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  })
}

/**
 * Make a PUT request.
 * @param {string} path
 * @param {any} body
 * @returns {Promise<any>}
 */
export async function apiPut(path, body) {
  return fetchWithRetry(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Make a DELETE request.
 * @param {string} path
 * @returns {Promise<any>}
 */
export async function apiDelete(path) {
  return fetchWithRetry(`${API_BASE}${path}`, {
    method: 'DELETE',
  })
}
