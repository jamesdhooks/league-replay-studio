import { useState, useCallback, useEffect } from 'react'
import {
  Youtube,
  CheckCircle,
  AlertTriangle,
  XCircle,
  RefreshCw,
  Link2Off,
  ExternalLink,
} from 'lucide-react'
import { useYouTube } from '../../context/YouTubeContext'
import { useToast } from '../../context/ToastContext'

/**
 * YouTubeSettings — YouTube integration settings section.
 *
 * Shows connection status with connect/disconnect capability,
 * and configurable upload defaults (privacy, templates, tags).
 *
 * @param {Object} props
 * @param {(key: string) => any} props.value — get a setting value
 * @param {(key: string, value: any) => void} props.onChange — update a setting
 */
function YouTubeSettings({ value, onChange }) {
  const {
    connectionStatus,
    isConnected,
    channel,
    disconnect,
    refreshConnection,
    getAuthUrl,
    handleAuthCallback,
  } = useYouTube()
  const { showSuccess, showError } = useToast()

  const [oauthForm, setOauthForm] = useState({
    clientId: '',
    clientSecret: '',
    code: '',
  })
  const [authUrl, setAuthUrl] = useState('')
  const [connecting, setConnecting] = useState(false)

  // ── Generate auth URL ───────────────────────────────────────────────────
  const handleGetAuthUrl = useCallback(async () => {
    if (!oauthForm.clientId) {
      showError('Client ID is required')
      return
    }
    try {
      const url = await getAuthUrl(oauthForm.clientId, 'urn:ietf:wg:oauth:2.0:oob')
      setAuthUrl(url)
    } catch (err) {
      showError(err.message)
    }
  }, [oauthForm.clientId, getAuthUrl, showError])

  // ── Complete OAuth2 ─────────────────────────────────────────────────────
  const handleConnect = useCallback(async () => {
    if (!oauthForm.clientId || !oauthForm.clientSecret || !oauthForm.code) {
      showError('All fields are required')
      return
    }
    setConnecting(true)
    try {
      await handleAuthCallback(
        oauthForm.clientId,
        oauthForm.clientSecret,
        oauthForm.code,
        'urn:ietf:wg:oauth:2.0:oob'
      )
      showSuccess('YouTube connected successfully!')
      setOauthForm({ clientId: '', clientSecret: '', code: '' })
      setAuthUrl('')
    } catch (err) {
      showError(err.message || 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }, [oauthForm, handleAuthCallback, showSuccess, showError])

  const handleDisconnect = useCallback(async () => {
    try {
      await disconnect()
      showSuccess('YouTube disconnected')
    } catch (err) {
      showError(err.message)
    }
  }, [disconnect, showSuccess, showError])

  const handleRefresh = useCallback(async () => {
    try {
      await refreshConnection()
      showSuccess('Connection refreshed')
    } catch (err) {
      showError(err.message)
    }
  }, [refreshConnection, showSuccess, showError])

  return (
    <div className="space-y-6 max-w-xl">
      <div className="pb-2 border-b border-border">
        <h3 className="text-base font-semibold text-text-primary">YouTube</h3>
        <p className="mt-1 text-sm text-text-tertiary">
          Connect your YouTube channel for direct video uploads.
        </p>
      </div>

      {/* Connection status */}
      <div className="p-4 bg-surface rounded-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Youtube className={`w-6 h-6 ${isConnected ? 'text-red-500' : 'text-text-disabled'}`} />
            <div>
              <div className="flex items-center gap-2">
                {connectionStatus.state === 'connected' && (
                  <>
                    <CheckCircle className="w-4 h-4 text-green-400" />
                    <span className="text-sm font-medium text-green-400">Connected</span>
                  </>
                )}
                {connectionStatus.state === 'expired' && (
                  <>
                    <AlertTriangle className="w-4 h-4 text-yellow-400" />
                    <span className="text-sm font-medium text-yellow-400">Token Expired</span>
                  </>
                )}
                {connectionStatus.state === 'disconnected' && (
                  <>
                    <XCircle className="w-4 h-4 text-text-disabled" />
                    <span className="text-sm font-medium text-text-secondary">Not Connected</span>
                  </>
                )}
                {connectionStatus.state === 'error' && (
                  <>
                    <AlertTriangle className="w-4 h-4 text-red-400" />
                    <span className="text-sm font-medium text-red-400">Error</span>
                  </>
                )}
              </div>
              {channel && (
                <p className="text-xs text-text-tertiary mt-0.5">{channel.title}</p>
              )}
            </div>
          </div>

          {isConnected && (
            <div className="flex items-center gap-1">
              <button
                onClick={handleRefresh}
                className="p-1.5 text-text-secondary hover:text-text-primary
                           hover:bg-surface-hover rounded transition-colors"
                title="Refresh"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
              <button
                onClick={handleDisconnect}
                className="p-1.5 text-red-400 hover:text-red-300
                           hover:bg-surface-hover rounded transition-colors"
                title="Disconnect"
              >
                <Link2Off className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* OAuth2 connection form (when disconnected) */}
      {!isConnected && (
        <div className="space-y-4 p-4 bg-surface rounded-lg">
          <p className="text-sm text-text-secondary">
            To connect, create a YouTube Data API v3 project in the{' '}
            <a
              href="https://console.cloud.google.com/apis/dashboard"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline inline-flex items-center gap-0.5"
            >
              Google Cloud Console <ExternalLink className="w-3 h-3" />
            </a>
            {' '}and enter your OAuth2 credentials below.
          </p>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Client ID</label>
            <input
              type="text"
              value={oauthForm.clientId}
              onChange={(e) => setOauthForm(f => ({ ...f, clientId: e.target.value }))}
              placeholder="Your OAuth2 Client ID"
              className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                         text-text-primary placeholder:text-text-disabled
                         focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Client Secret</label>
            <input
              type="password"
              value={oauthForm.clientSecret}
              onChange={(e) => setOauthForm(f => ({ ...f, clientSecret: e.target.value }))}
              placeholder="Your OAuth2 Client Secret"
              className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                         text-text-primary placeholder:text-text-disabled
                         focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </div>

          {!authUrl ? (
            <button
              onClick={handleGetAuthUrl}
              disabled={!oauthForm.clientId}
              className={`w-full py-2 text-sm font-medium rounded-lg transition-colors ${
                oauthForm.clientId
                  ? 'bg-accent hover:bg-accent-hover text-white'
                  : 'bg-surface text-text-disabled cursor-not-allowed'
              }`}
            >
              Generate Authorization URL
            </button>
          ) : (
            <>
              <div className="p-3 bg-bg-primary rounded-lg">
                <p className="text-xs text-text-tertiary mb-1">
                  Open this URL, authorize, and paste the code below:
                </p>
                <a
                  href={authUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent break-all hover:underline"
                >
                  {authUrl.substring(0, 80)}...
                </a>
              </div>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">
                  Authorization Code
                </label>
                <input
                  type="text"
                  value={oauthForm.code}
                  onChange={(e) => setOauthForm(f => ({ ...f, code: e.target.value }))}
                  placeholder="Paste the authorization code here"
                  className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                             text-text-primary placeholder:text-text-disabled
                             focus:outline-none focus:ring-2 focus:ring-accent/40"
                />
              </div>

              <button
                onClick={handleConnect}
                disabled={connecting || !oauthForm.code}
                className={`w-full py-2 text-sm font-medium rounded-lg transition-colors ${
                  !connecting && oauthForm.code
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-surface text-text-disabled cursor-not-allowed'
                }`}
              >
                {connecting ? 'Connecting...' : 'Connect YouTube Channel'}
              </button>
            </>
          )}
        </div>
      )}

      {/* Upload defaults */}
      <div className="space-y-4">
        <div className="pb-2 border-b border-border">
          <h4 className="text-sm font-semibold text-text-primary">Upload Defaults</h4>
          <p className="mt-0.5 text-xs text-text-tertiary">
            Default settings for YouTube uploads. Jinja2 variables are supported in templates.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-primary">Default Privacy</label>
          <select
            value={value('youtube_default_privacy')}
            onChange={(e) => onChange('youtube_default_privacy', e.target.value)}
            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                       text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40
                       appearance-none cursor-pointer"
          >
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
            <option value="private">Private</option>
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-primary">Default Playlist</label>
          <input
            type="text"
            value={value('youtube_default_playlist') || ''}
            onChange={(e) => onChange('youtube_default_playlist', e.target.value)}
            placeholder="Playlist ID (optional)"
            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                       text-text-primary placeholder:text-text-disabled
                       focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-primary">Title Template</label>
          <p className="text-xs text-text-tertiary">
            Variables: {'{{ track_name }}'}, {'{{ series_name }}'}, {'{{ drivers }}'}, {'{{ date }}'}, {'{{ car }}'}
          </p>
          <input
            type="text"
            value={value('youtube_title_template') || ''}
            onChange={(e) => onChange('youtube_title_template', e.target.value)}
            placeholder="{{ track_name }} - {{ series_name }} Race Highlights"
            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                       text-text-primary placeholder:text-text-disabled
                       focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-primary">Description Template</label>
          <textarea
            value={value('youtube_description_template') || ''}
            onChange={(e) => onChange('youtube_description_template', e.target.value)}
            placeholder="Race highlights from {{ track_name }}..."
            rows={3}
            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                       text-text-primary placeholder:text-text-disabled
                       focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-primary">Default Tags</label>
          <input
            type="text"
            value={value('youtube_default_tags') || ''}
            onChange={(e) => onChange('youtube_default_tags', e.target.value)}
            placeholder="iracing, sim racing, highlights"
            className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                       text-text-primary placeholder:text-text-disabled
                       focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-primary">Auto-Upload</label>
          <p className="text-xs text-text-tertiary">Automatically upload after export completes.</p>
          <button
            type="button"
            role="switch"
            aria-checked={value('youtube_auto_upload')}
            onClick={() => onChange('youtube_auto_upload', !value('youtube_auto_upload'))}
            className={`relative w-10 h-5 rounded-full transition-colors ${
              value('youtube_auto_upload') ? 'bg-accent' : 'bg-surface-active'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm
                          transition-transform ${value('youtube_auto_upload') ? 'translate-x-5' : 'translate-x-0'}`}
            />
          </button>
        </div>
      </div>
    </div>
  )
}

export default YouTubeSettings
