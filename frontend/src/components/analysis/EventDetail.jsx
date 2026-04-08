import { useState } from 'react'
import { Check, Clipboard } from 'lucide-react'
import { EVENT_CONFIG, formatTime, scoreColor } from './analysisConstants'
import { tierColor } from '../../context/HighlightContext'

/**
 * EventDetail — expanded view showing all captured data for an event.
 */
export default function EventDetail({ event }) {
  const driverNames = event.driver_names || []
  const involvedDrivers = event.involved_drivers || []
  const metadata = event.metadata || {}
  const components = event.score_components || {}
  const [copied, setCopied] = useState(false)

  const handleCopyJson = (e) => {
    e.stopPropagation()
    navigator.clipboard.writeText(JSON.stringify(event, null, 2)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  return (
    <div className="space-y-2 text-xxs">
      {/* Core fields */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-2">
        <div className="space-y-1.5">
          <DetailRow label="Type" value={EVENT_CONFIG[event.event_type]?.label || event.event_type} />
          <DetailRow label="Score" value={
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block w-4 h-4 rounded text-white font-bold text-center leading-4"
                style={{ backgroundColor: scoreColor(event.severity), fontSize: '8px' }}
              >
                {event.severity}
              </span>
              {event.tier && (
                <span
                  className="inline-block w-4 h-4 rounded text-white font-bold text-center leading-4"
                  style={{ backgroundColor: tierColor(event.tier), fontSize: '8px' }}
                >
                  {event.tier}
                </span>
              )}
            </span>
          } />
          <DetailRow label="Time" value={`${formatTime(event.start_time_seconds)} — ${formatTime(event.end_time_seconds)}`} />
          <DetailRow label="Duration" value={`${((event.end_time_seconds - event.start_time_seconds) || 0).toFixed(1)}s`} />
          {event.lap_number > 0 && (
            <DetailRow label="Lap" value={event.lap_number} />
          )}
        </div>
        <div className="space-y-1.5">
          {event.detector && (
            <DetailRow label="Detected by" value={event.detector} />
          )}
          {involvedDrivers.length > 0 && (
            <DetailRow label="Car Indices" value={involvedDrivers.join(', ')} />
          )}
          {event.bucket && (
            <DetailRow label="Bucket" value={event.bucket} />
          )}
        </div>
      </div>

      {/* Scoring breakdown */}
      {Object.keys(components).length > 0 && (
        <div className="pt-1.5 border-t border-border-subtle">
          <span className="text-text-disabled font-medium block mb-1">Scoring Breakdown</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {components.base != null && (
              <span className="text-text-secondary">Base: <span className="font-mono text-text-primary">{components.base}</span></span>
            )}
            {components.position != null && components.position !== 1 && (
              <span className="text-text-secondary">Pos: <span className="font-mono text-text-primary">×{components.position}</span></span>
            )}
            {components.position_change != null && components.position_change !== 1 && (
              <span className="text-text-secondary">Δ Pos: <span className="font-mono text-text-primary">×{components.position_change.toFixed(1)}</span></span>
            )}
            {components.consequence != null && components.consequence > 0 && (
              <span className="text-text-secondary">Cons: <span className="font-mono text-text-primary">+{components.consequence}</span></span>
            )}
            {components.narrative_bonus != null && components.narrative_bonus > 0 && (
              <span className="text-text-secondary">Narr: <span className="font-mono text-text-primary">+{components.narrative_bonus}</span></span>
            )}
            {components.exposure_adj != null && components.exposure_adj !== 1 && (
              <span className="text-text-secondary">Exp: <span className="font-mono text-text-primary">×{components.exposure_adj}</span></span>
            )}
            {components.user_weight != null && (
              <span className="text-text-secondary">Wt: <span className="font-mono text-text-primary">×{components.user_weight}</span></span>
            )}
          </div>
          <div className="mt-1 text-text-disabled">
            Final: <span className="font-mono text-text-primary font-bold">{event.score ?? event.severity}</span>
          </div>
        </div>
      )}

      {/* Drivers */}
      {driverNames.length > 0 && (
        <div className="pt-1.5 border-t border-border-subtle">
          <span className="text-text-disabled font-medium block mb-1">Drivers</span>
          <div className="flex flex-wrap gap-1">
            {driverNames.map((name, i) => (
              <span key={i} className="px-1.5 py-0.5 bg-surface rounded text-text-secondary">
                {name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Metadata */}
      {Object.keys(metadata).length > 0 && (
        <div className="pt-1.5 border-t border-border-subtle">
          <span className="text-text-disabled font-medium block mb-1">Metadata</span>
          <div className="space-y-1">
            {Object.entries(metadata).map(([key, value]) => (
              <div key={key} className="flex flex-col gap-0.5">
                <span className="text-text-disabled capitalize">{key.replace(/_/g, ' ')}</span>
                <span className="text-text-secondary break-all">
                  {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Copy JSON */}
      <div className="pt-1.5 border-t border-border-subtle">
        <button
          onClick={handleCopyJson}
          className="flex items-center gap-1 px-2 py-1 rounded text-xxs
                     bg-surface hover:bg-surface-active text-text-secondary
                     hover:text-text-primary transition-colors"
        >
          {copied ? <Check size={10} className="text-success" /> : <Clipboard size={10} />}
          {copied ? 'Copied!' : 'Copy Event JSON'}
        </button>
      </div>
    </div>
  )
}

function DetailRow({ label, value }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="text-text-disabled capitalize shrink-0">{label}</span>
      <span className="text-text-secondary break-words">{value}</span>
    </div>
  )
}
