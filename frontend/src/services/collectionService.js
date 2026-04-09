/**
 * collectionService.js
 * --------------------
 * API client for the live telemetry collection feature.
 */

const BASE = '/api/collection'

async function _json(res) {
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(detail?.detail || res.statusText)
  }
  return res.json()
}

export const collectionService = {
  /** Start a new collection session. */
  start: (name = null, hz = 4) =>
    fetch(`${BASE}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, hz }),
    }).then(_json),

  /** Stop the active collection session. */
  stop: () =>
    fetch(`${BASE}/stop`, { method: 'POST' }).then(_json),

  /** Get current collection status. */
  status: () =>
    fetch(`${BASE}/status`).then(_json),

  /** List all saved collection files. */
  listFiles: () =>
    fetch(`${BASE}/files`).then(_json),

  /** Get metadata for one file. */
  getFileInfo: (filename) =>
    fetch(`${BASE}/files/${encodeURIComponent(filename)}`).then(_json),

  /** Get the variable catalog for a file. */
  getCatalog: (filename) =>
    fetch(`${BASE}/files/${encodeURIComponent(filename)}/catalog`).then(_json),

  /** Get paginated tick data, optionally filtered to specific variables. */
  getTicks: (filename, { offset = 0, limit = 200, vars = null } = {}) => {
    const params = new URLSearchParams({ offset, limit })
    if (vars && vars.length) params.set('vars', vars.join(','))
    return fetch(
      `${BASE}/files/${encodeURIComponent(filename)}/ticks?${params}`
    ).then(_json)
  },

  /** Delete a collection file. */
  deleteFile: (filename) =>
    fetch(`${BASE}/files/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
    }).then(_json),
}
