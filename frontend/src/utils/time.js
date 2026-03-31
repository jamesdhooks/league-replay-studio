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
