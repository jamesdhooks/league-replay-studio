import { useMemo } from 'react'
import { formatTime } from '../../utils/time'

export function TimeGutter({ totalDuration, contentHeight, compress, onClick }) {
  const markers = useMemo(() => {
    if (compress || totalDuration <= 0) return []
    const interval =
      totalDuration > 7200 ? 600 :
      totalDuration > 3600 ? 300 :
      totalDuration > 600  ? 60  : 30
    const marks = []
    for (let t = 0; t <= totalDuration; t += interval) {
      marks.push({ time: t, pct: (t / totalDuration) * 100 })
    }
    return marks
  }, [totalDuration, compress])

  return (
    <div
      className="shrink-0 relative border-r border-border-subtle bg-bg-primary/50 cursor-pointer"
      style={{ width: 52 }}
      onClick={onClick}
    >
      {markers.map(m => (
        <div key={m.time} className="absolute left-0 right-0" style={{ top: `${m.pct}%` }}>
          <span
            className="block text-center text-text-disabled font-mono leading-none"
            style={{ fontSize: 10 }}
          >
            {formatTime(m.time)}
          </span>
          <div className="absolute right-0 top-2 bg-border-subtle" style={{ width: 8, height: 1 }} />
        </div>
      ))}
    </div>
  )
}

/** Horizontal time ruler — time markers placed left→right at percentage positions. */
export function TimeGutterH({ totalDuration, onClick }) {
  const markers = useMemo(() => {
    if (totalDuration <= 0) return []
    const interval =
      totalDuration > 7200 ? 600 :
      totalDuration > 3600 ? 300 :
      totalDuration > 600  ? 60  : 30
    const marks = []
    for (let t = 0; t <= totalDuration; t += interval) {
      marks.push({ time: t, pct: (t / totalDuration) * 100 })
    }
    return marks
  }, [totalDuration])

  return (
    <div
      className="relative border-b border-border-subtle bg-bg-primary/50 cursor-pointer shrink-0 select-none"
      style={{ height: 24 }}
      onClick={onClick}
    >
      {markers.map(m => (
        <div key={m.time}
             className="absolute top-0 bottom-0 flex items-end justify-center pb-0.5"
             style={{ left: `${m.pct}%`, transform: 'translateX(-50%)' }}>
          <span className="text-text-disabled font-mono leading-none" style={{ fontSize: 9 }}>
            {formatTime(m.time)}
          </span>
        </div>
      ))}
    </div>
  )
}
