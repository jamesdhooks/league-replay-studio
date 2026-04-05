/**
 * Application-wide constants.
 */

export const APP_NAME = 'League Replay Studio'
export const APP_VERSION = '0.1.0'

/** Project workflow steps */
export const WORKFLOW_STEPS = [
  { id: 'analysis', label: 'Analysis', icon: 'bar-chart' },
  { id: 'editing', label: 'Editing', icon: 'scissors' },
  { id: 'overlay', label: 'Overlay', icon: 'layers' },
  { id: 'capture', label: 'Capture', icon: 'video' },
  { id: 'export', label: 'Export', icon: 'download' },
  { id: 'upload', label: 'Upload', icon: 'upload' },
]

/** Event type labels and colors */
export const EVENT_TYPES = {
  incident: { label: 'Incident', color: 'event-incident' },
  battle: { label: 'Battle', color: 'event-battle' },
  overtake: { label: 'Overtake', color: 'event-overtake' },
  pit_stop: { label: 'Pit Stop', color: 'event-pit' },
  fastest_lap: { label: 'Fastest Lap', color: 'event-fastest' },
  leader_change: { label: 'Leader Change', color: 'event-leader' },
  first_lap: { label: 'First Lap', color: 'event-firstlap' },
  last_lap: { label: 'Last Lap', color: 'event-lastlap' },
}

/** Default API base URL */
export const API_BASE = '/api'

/** WebSocket reconnection config */
export const WS_RECONNECT_BASE_DELAY = 1000
export const WS_RECONNECT_MAX_DELAY = 30000
