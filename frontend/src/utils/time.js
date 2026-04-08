/**
 * Time formatting utilities.
 */

/**
 * Format seconds to MM:SS or HH:MM:SS.
 * @param {number} seconds
 * @returns {string}
 */
export function formatTime(seconds) {
  if (seconds == null || isNaN(seconds)) return '00:00'

  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * Format seconds to MM:SS.mmm (frame-accurate).
 * @param {number} seconds
 * @returns {string}
 */
export function formatTimePrecise(seconds) {
  if (seconds == null || isNaN(seconds)) return '00:00.000'

  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`
}

/**
 * Format seconds as a short duration string: "0s", "45s", "2:05".
 * Useful for compact display of event/clip durations.
 * @param {number} sec
 * @returns {string}
 */
export function formatDuration(sec) {
  if (!sec || sec <= 0) return '0s'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

/**
 * Format a timestamp as a relative time string ("just now", "5s ago", "3m ago", "1h ago").
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string}
 */
export function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}
