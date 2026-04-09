import { useState, useCallback, lazy, Suspense } from 'react'
import { Loader2 } from 'lucide-react'
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

      {/* ── Left sidebar ────────────────────────────────────────────────── */}
      <aside className="w-72 shrink-0 flex flex-col gap-4 p-4 border-r border-border overflow-y-auto bg-bg-secondary">
        <CollectionControl onStatusChange={handleStatusChange} />
        <FileBrowser
          selectedFile={selectedFile}
          onSelect={setSelectedFile}
          refreshTrigger={refreshTrigger}
        />
      </aside>

      {/* ── Main panel ──────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-hidden bg-bg-primary relative">
        {/* Viz: always visible when collecting, or as idle attract when no file selected */}
        {(liveInfo.active || !selectedFile) && (
          <div className={`absolute inset-0 transition-opacity duration-500 ${
            !liveInfo.active && selectedFile ? 'opacity-0 pointer-events-none' : 'opacity-100'
          }`}>
            <DataStreamViz
              isCollecting={liveInfo.active}
              tickCount={liveInfo.tickCount}
              hz={liveInfo.hz}
              label={liveInfo.label}
            />
          </div>
        )}

        {/* Explorer: slides in over the viz when a file is selected and not recording */}
        {selectedFile && !liveInfo.active && (
          <div className="absolute inset-0">
            <Suspense fallback={<ExplorerFallback />}>
              <TelemetryExplorer file={selectedFile} />
            </Suspense>
          </div>
        )}
      </main>

    </div>
  )
}

export default CollectPage
