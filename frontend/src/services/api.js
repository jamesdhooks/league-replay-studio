/**
 * API client for League Replay Studio backend.
 * All REST communication goes through this module.
 */

const API_BASE = '/api'

/**
 * Make a GET request.
 * @param {string} path - API path (e.g., '/system/health')
 * @returns {Promise<any>}
 */
export async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`)
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }))
    throw new Error(error.message || `GET ${path} failed: ${response.status}`)
  }
  return response.json()
}

/**
 * Make a POST request.
 * @param {string} path
 * @param {any} [body]
 * @returns {Promise<any>}
 */
export async function apiPost(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }))
    throw new Error(error.message || `POST ${path} failed: ${response.status}`)
  }
  return response.json()
}

/**
 * Make a PUT request.
 * @param {string} path
 * @param {any} body
 * @returns {Promise<any>}
 */
export async function apiPut(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }))
    throw new Error(error.message || `PUT ${path} failed: ${response.status}`)
  }
  return response.json()
}

/**
 * Make a DELETE request.
 * @param {string} path
 * @returns {Promise<any>}
 */
export async function apiDelete(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }))
    throw new Error(error.message || `DELETE ${path} failed: ${response.status}`)
  }
  return response.json()
}
