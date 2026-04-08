import {
  Youtube,
  RefreshCw,
  Link2Off,
  AlertTriangle,
} from 'lucide-react'

/**
 * ConnectionStatus — shows YouTube channel connection state.
 *
 * When disconnected, renders a full-pane placeholder prompting the user
 * to connect via Settings.  When connected, renders the compact header
 * bar with channel name, refresh, and disconnect controls.
 */
function ConnectionStatus({
  channel,
  isConnected,
  connectionStatus,
  onDisconnect,
  onRefresh,
}) {
  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
        <Youtube className="w-12 h-12 text-text-disabled" />
        <h3 className="text-lg font-semibold text-text-primary">YouTube Not Connected</h3>
        <p className="text-sm text-text-tertiary max-w-sm">
          Connect your YouTube channel in Settings → YouTube to enable
          video uploading and channel management.
        </p>
        {connectionStatus?.state === 'expired' && (
          <div className="flex items-center gap-2 text-yellow-400 text-sm">
            <AlertTriangle className="w-4 h-4" />
            <span>Token expired — reconnect in Settings</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
      <div className="flex items-center gap-2">
        <Youtube className="w-5 h-5 text-red-500" />
        <h2 className="text-base font-semibold text-text-primary">YouTube</h2>
        {channel && (
          <span className="text-xs text-text-tertiary">• {channel.title}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onRefresh}
          className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary
                     hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
          title="Refresh connection"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onDisconnect}
          className="flex items-center gap-1 px-2 py-1 text-xs text-red-400
                     hover:text-red-300 hover:bg-surface-hover rounded transition-colors"
          title="Disconnect"
        >
          <Link2Off className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

export default ConnectionStatus
