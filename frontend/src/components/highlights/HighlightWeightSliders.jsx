import { useHighlight, EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { EVENT_COLORS } from '../../context/TimelineContext'
import { Wand2 } from 'lucide-react'

/**
 * HighlightWeightSliders — Priority sliders for each event type.
 *
 * Includes: per-type weight (0–100), minimum severity threshold, target duration.
 * Changes trigger instant reprocessing via HighlightContext.
 */
export default function HighlightWeightSliders() {
  const {
    weights, setWeight, autoBalance,
    minSeverity, setMinSeverity,
    targetDuration, setTargetDuration,
  } = useHighlight()

  const eventTypes = Object.keys(EVENT_TYPE_LABELS)

  return (
    <div className="p-3 space-y-3">
      {/* Event type weights */}
      <div className="space-y-2">
        <h4 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">
          Event Priorities
        </h4>
        {eventTypes.map(type => {
          const color = EVENT_COLORS[type] || '#666'
          const label = EVENT_TYPE_LABELS[type]
          const value = weights[type] ?? 50

          return (
            <div key={type} className="flex items-center gap-2">
              <div
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: color }}
              />
              <span className="text-xxs text-text-secondary w-16 truncate" title={label}>
                {label}
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={value}
                onChange={(e) => setWeight(type, parseInt(e.target.value, 10))}
                className="flex-1 h-1 accent-accent cursor-pointer"
                style={{ accentColor: color }}
              />
              <span className="text-xxs text-text-tertiary font-mono w-7 text-right">
                {value}
              </span>
            </div>
          )
        })}

        {/* Auto-balance button */}
        <button
          onClick={autoBalance}
          className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xxs font-medium
                     text-accent bg-accent/10 hover:bg-accent/20 rounded transition-colors"
        >
          <Wand2 className="w-3 h-3" />
          Auto-balance weights
        </button>
      </div>

      {/* Minimum severity threshold */}
      <div className="pt-2 border-t border-border-subtle space-y-1.5">
        <h4 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">
          Minimum Severity
        </h4>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={10}
            value={minSeverity}
            onChange={(e) => setMinSeverity(parseInt(e.target.value, 10))}
            className="flex-1 h-1 accent-accent cursor-pointer"
          />
          <span className="text-xxs text-text-tertiary font-mono w-5 text-right">
            {minSeverity}
          </span>
        </div>
      </div>

      {/* Target duration */}
      <div className="pt-2 border-t border-border-subtle space-y-1.5">
        <h4 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">
          Target Duration
        </h4>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            step={10}
            value={targetDuration || ''}
            onChange={(e) => {
              const v = e.target.value ? parseFloat(e.target.value) : null
              setTargetDuration(v)
            }}
            placeholder="No limit"
            className="flex-1 px-2 py-1 text-xs bg-bg-primary border border-border rounded
                       text-text-primary placeholder:text-text-disabled
                       focus:outline-none focus:border-accent"
          />
          <span className="text-xxs text-text-tertiary">sec</span>
        </div>
      </div>
    </div>
  )
}
