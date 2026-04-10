import { useState, useCallback, lazy, Suspense } from 'react'
import { Loader2, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { CollectionControl, FileBrowser } from './CollectionControl'
import DataStreamViz from './DataStreamViz'

const TelemetryExplorer = lazy(() => import('./TelemetryExplorer'))

function ExplorerFallback() {
  return (
    <div className="flex items-center justify-center h-full text-zinc-500">
      <Loader2 className="w-5 h-5 animate-spin mr-2" />
      Loading…
    </div>
  )
}

/**
 * CollectPage — top-level page for live telemetry collection.
 *
 * Layout:
 *   Left sidebar (300px):
 *     - CollectionControl  (record / stop, live stats)
 *     - FileBrowser        (list of .db collection files)
 *
 *   Main panel (flex-1):
 *     - TelemetryExplorer  (catalog + tick data viewer for selected file)
 */
function CollectPage() {
  const [selectedFile, setSelectedFile] = useState(null)
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const [liveInfo, setLiveInfo] = useState({ active: false, tickCount: 0, hz: 4, label: '' })
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const handleStatusChange = useCallback((status) => {
    setLiveInfo({
      active:    status.collecting  ?? false,
      tickCount: status.tick_count  ?? 0,
      hz:        status.hz          ?? 4,
      label:     status.session_name ?? '',
    })
    if (!status.collecting) {
      setRefreshTrigger((n) => n + 1)
    }
  }, [])

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Left sidebar — collapsible ────────────────────────────────── */}
      <aside className={`shrink-0 flex flex-col border-r border-border overflow-hidden
                         bg-bg-secondary transition-all duration-200 ease-in-out
                         ${sidebarOpen ? 'w-72' : 'w-0'}`}>
        <div className="w-72 flex flex-col gap-4 p-4 overflow-y-auto h-full">
          <CollectionControl onStatusChange={handleStatusChange} />
          <FileBrowser
            selectedFile={selectedFile}
            onSelect={setSelectedFile}
            refreshTrigger={refreshTrigger}
          />
        </div>
      </aside>

      {/* ── Toggle button ────────────────────────────────────────────── */}
      <div className="shrink-0 flex flex-col border-r border-border bg-bg-secondary">
        <button
          onClick={() => setSidebarOpen(v => !v)}
          title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          className="w-7 h-full flex items-center justify-center
                     text-text-disabled hover:text-text-primary hover:bg-surface-hover
                     transition-colors"
        >
          {sidebarOpen
            ? <PanelLeftClose size={13} />
            : <PanelLeftOpen  size={13} />}
        </button>
      </div>

      {/* ── Main panel ──────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-hidden bg-bg-primary relative">

        {/* Explorer: always present when a file is selected (z-0) */}
        {selectedFile && (
          <div className="absolute inset-0">
            <Suspense fallback={<ExplorerFallback />}>
              <TelemetryExplorer file={selectedFile} />
            </Suspense>
          </div>
        )}

        {/* Viz overlay:
              - When collecting: transparent canvas floats above the explorer (pointer-events-none)
              - When no file selected: canvas fills the dark panel as an attract screen
              - When file selected & not collecting: hidden */}
        <div className={`absolute inset-0 transition-opacity duration-500 pointer-events-none ${
          liveInfo.active || !selectedFile ? 'opacity-100' : 'opacity-0'
        }`}>
          <DataStreamViz
            isCollecting={liveInfo.active}
            tickCount={liveInfo.tickCount}
            hz={liveInfo.hz}
            label={liveInfo.label}
          />
        </div>

      </main>

    </div>
  )
}

export default CollectPage
