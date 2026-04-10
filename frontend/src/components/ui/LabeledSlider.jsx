import { useMemo } from 'react'
import { Info } from 'lucide-react'
import Tooltip from './Tooltip'

/**
 * LabeledSlider — shared slider with label, tooltip, ticks, and value display.
 *
 * Used in both Detection Tuning (TuningPanel) and Direction Tuning (HighlightWeightSliders).
 * Layout: label + slider + value on one row, tick marks below the slider.
 */
export default function LabeledSlider({
  label,
  tooltip,
  value,
  min,
  max,
  step,
  format = v => v,
  onChange,
  labelWidth = '5.5rem',
}) {
  const range = max - min
  const valuePct = range > 0 ? ((value - min) / range) * 100 : 0

  const ticks = useMemo(() => {
    const count = Math.min(5, Math.round(range / step))
    if (count <= 1) return [min, max]
    const tickStep = range / count
    const result = []
    for (let i = 0; i <= count; i++) {
      const v = min + Math.round((tickStep * i) / step) * step
      if (v <= max) result.push(v)
    }
    if (result[result.length - 1] !== max) result.push(max)
    return [...new Set(result)]
  }, [min, max, step, range])

  return (
    <div className="pb-3.5">
      <div className="flex items-center gap-2">
        <Tooltip content={tooltip} position="top" delay={200}>
          <span
            className="text-xxs text-text-secondary shrink-0 flex items-center gap-1 cursor-help"
            style={{ minWidth: labelWidth }}
          >
            {label}
            <Info className="w-3 h-3 text-text-disabled shrink-0" />
          </span>
        </Tooltip>
        <div className="flex-1 relative">
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            className="w-full h-1 accent-accent cursor-pointer block"
          />
          {/* Tick marks: absolutely positioned below slider, outside flex row height.
              The browser positions the range thumb so its CENTER is at
              calc(pct * (100% - thumbWidth) + thumbWidth/2), not at raw pct%.
              We correct for a 16px thumb so ticks align with the thumb center. */}
          <div className="absolute left-0 right-0 pointer-events-none" style={{ top: '100%', marginTop: 2, height: 12 }}>
            {ticks.map(v => {
              const pct = range > 0 ? ((v - min) / range) : 0
              return (
                <div key={v} className="absolute flex flex-col items-center"
                     style={{ left: `calc(${pct} * (100% - 16px) + 8px)`, transform: 'translateX(-50%)' }}>
                  <div className="w-px h-1 bg-text-disabled/40" />
                  <span className="text-[8px] text-text-disabled font-mono leading-none mt-px">{format(v)}</span>
                </div>
              )
            })}
            <div className="absolute flex flex-col items-center"
                 style={{ left: `calc(${valuePct / 100} * (100% - 16px) + 8px)`, transform: 'translateX(-50%)', top: -2 }}>
              <div className="w-px h-1.5 bg-accent" />
            </div>
          </div>
        </div>
        <span
          className="text-xxs text-accent font-mono shrink-0 font-semibold"
          style={{ minWidth: '2.5rem', textAlign: 'right' }}
        >
          {format(value)}
        </span>
      </div>
    </div>
  )
}
