/**
 * WebSocket client for real-time communication with the backend.
 *
 * Provides auto-reconnect with exponential backoff and
 * an event subscription pattern.
 */

const WS_URL = `ws://${window.location.host}/ws`

class WebSocketClient {
  constructor() {
    this._ws = null
    this._listeners = new Map()
    this._reconnectAttempts = 0
    this._maxReconnectDelay = 30000
    this._shouldReconnect = true
    this._connected = false
    this._connectListeners = new Set()
  }

  /**
   * Connect to the WebSocket server.
   */
  connect() {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return

    try {
      this._ws = new WebSocket(WS_URL)

      this._ws.onopen = () => {
        this._connected = true
        this._reconnectAttempts = 0
        console.log('[WebSocket] Connected')
        this._connectListeners.forEach(fn => fn(true))
      }

      this._ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          const eventName = data.event
          if (eventName && this._listeners.has(eventName)) {
            this._listeners.get(eventName).forEach(fn => fn(data.data))
          }
        } catch (err) {
          console.error('[WebSocket] Parse error:', err)
        }
      }

      this._ws.onclose = () => {
        this._connected = false
        console.log('[WebSocket] Disconnected')
        this._connectListeners.forEach(fn => fn(false))
        if (this._shouldReconnect) {
          this._scheduleReconnect()
        }
      }

      this._ws.onerror = (err) => {
        console.error('[WebSocket] Error:', err)
      }
    } catch (err) {
      console.error('[WebSocket] Connection failed:', err)
      if (this._shouldReconnect) {
        this._scheduleReconnect()
      }
    }
  }

  /**
   * Disconnect and stop reconnection attempts.
   */
  disconnect() {
    this._shouldReconnect = false
    if (this._ws) {
      this._ws.close()
      this._ws = null
    }
  }

  /**
   * Send a message to the backend.
   * @param {string} event - Event name
   * @param {any} [data] - Event data
   */
  send(event, data = {}) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ event, data }))
    }
  }

  /**
   * Subscribe to a specific event.
   * @param {string} event - Event name (e.g., 'iracing:connected')
   * @param {Function} callback
   */
  subscribe(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set())
    }
    this._listeners.get(event).add(callback)
  }

  /**
   * Unsubscribe from a specific event.
   * @param {string} event
   * @param {Function} callback
   */
  unsubscribe(event, callback) {
    if (this._listeners.has(event)) {
      this._listeners.get(event).delete(callback)
    }
  }

  /**
   * Listen for connection state changes.
   * @param {Function} callback - receives boolean (true=connected)
   */
  onConnectionChange(callback) {
    this._connectListeners.add(callback)
    return () => this._connectListeners.delete(callback)
  }

  /**
   * Whether the WebSocket is currently connected.
   */
  get isConnected() {
    return this._connected
  }

  _scheduleReconnect() {
    const delay = Math.min(
      1000 * Math.pow(2, this._reconnectAttempts),
      this._maxReconnectDelay
    )
    this._reconnectAttempts++
    console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`)
    setTimeout(() => this.connect(), delay)
  }
}

// Singleton instance
export const wsClient = new WebSocketClient()
