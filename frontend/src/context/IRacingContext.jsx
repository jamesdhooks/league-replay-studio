import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import { wsClient } from '../services/websocket'
import { apiGet } from '../services/api'

/**
 * @typedef {Object} Driver
 * @property {number} car_idx
 * @property {string} car_number
 * @property {string} user_name
 * @property {number} car_class_id
 * @property {string} car_class_name
 * @property {boolean} is_spectator
 * @property {number} iracing_cust_id
 */

/**
 * @typedef {Object} CameraGroup
 * @property {number} group_num
 * @property {string} group_name
 */

/**
 * @typedef {Object} SessionData
 * @property {string} track_name
 * @property {string} session_type
 * @property {number} avg_lap_time
 * @property {Driver[]} drivers
 * @property {CameraGroup[]} cameras
 */

const IRacingContext = createContext(null)

/**
 * Provides live iRacing connection state and session data to the component tree.
 *
 * Connects to:
 *   - WebSocket events: iracing:connected, iracing:disconnected, iracing:session_info
 *   - REST: GET /api/iracing/status (initial hydration on mount)
 */
export function IRacingProvider({ children }) {
  const [isConnected, setIsConnected] = useState(false)
  const [subsessionId, setSubsessionId] = useState(0)
  /** @type {[SessionData, Function]} */
  const [sessionData, setSessionData] = useState({
    track_name: '',
    session_type: '',
    avg_lap_time: 0,
    drivers: [],
    cameras: [],
  })

  // ── Initial hydration from REST ──────────────────────────────────────────
  useEffect(() => {
    apiGet('/iracing/status')
      .then((status) => {
        setIsConnected(status.connected)
        if (status.connected) {
          // Fetch full session data if connected
          return apiGet('/iracing/session')
        }
      })
      .then((session) => {
        if (session) {
          setSessionData({
            track_name: session.track_name || '',
            session_type: session.session_type || '',
            avg_lap_time: session.avg_lap_time || 0,
            drivers: session.drivers || [],
            cameras: session.cameras || [],
          })
        }
      })
      .catch(() => {
        // Backend not yet ready — ignore, WebSocket events will update state
      })
  }, [])

  // ── WebSocket event subscriptions ─────────────────────────────────────────
  useEffect(() => {
    const handleConnected = () => {
      setIsConnected(true)
      // Fetch full session data now that iRacing is live
      apiGet('/iracing/session')
        .then((session) => {
          setSessionData({
            track_name: session.track_name || '',
            session_type: session.session_type || '',
            avg_lap_time: session.avg_lap_time || 0,
            drivers: session.drivers || [],
            cameras: session.cameras || [],
          })
        })
        .catch(() => {})
    }

    const handleDisconnected = () => {
      setIsConnected(false)
      setSubsessionId(0)
      setSessionData({
        track_name: '',
        session_type: '',
        avg_lap_time: 0,
        drivers: [],
        cameras: [],
      })
    }

    const handleSessionInfo = (data) => {
      setSubsessionId(data.subsession_id || 0)
      setSessionData({
        track_name: data.track_name || '',
        session_type: data.session_type || '',
        avg_lap_time: data.avg_lap_time || 0,
        drivers: data.drivers || [],
        cameras: data.cameras || [],
      })
    }

    wsClient.subscribe('iracing:connected', handleConnected)
    wsClient.subscribe('iracing:disconnected', handleDisconnected)
    wsClient.subscribe('iracing:session_info', handleSessionInfo)

    return () => {
      wsClient.unsubscribe('iracing:connected', handleConnected)
      wsClient.unsubscribe('iracing:disconnected', handleDisconnected)
      wsClient.unsubscribe('iracing:session_info', handleSessionInfo)
    }
  }, [])

  const value = useMemo(
    () => ({ isConnected, sessionData, subsessionId }),
    [isConnected, sessionData, subsessionId]
  )

  return (
    <IRacingContext.Provider value={value}>
      {children}
    </IRacingContext.Provider>
  )
}

/**
 * Hook to access iRacing connection state and session data.
 *
 * @returns {{ isConnected: boolean, sessionData: SessionData }}
 */
export function useIRacing() {
  const context = useContext(IRacingContext)
  if (!context) {
    throw new Error('useIRacing must be used within an IRacingProvider')
  }
  return context
}
