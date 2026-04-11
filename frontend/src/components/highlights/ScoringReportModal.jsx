import { useMemo, useCallback } from 'react'
import { EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { formatTime, formatDuration } from '../../utils/time'
import { Copy, X } from 'lucide-react'

function generateReportText(allEvents, chosenEvents, pipEvents, metrics, totalDuration, productionTimeline) {
  const lines = []
  const hr = '─'.repeat(60)

  lines.push('SCORING ALGORITHM REPORT')
  lines.push(hr)
  lines.push('')

  // Overview
  lines.push('## Overview')
  lines.push(`Total Events Scored: ${allEvents.length}`)
  lines.push(`Chosen for Highlight: ${chosenEvents.length}`)
  lines.push(`PIP Segments: ${pipEvents.length}`)
  lines.push(`Selected Duration: ${formatDuration(metrics.duration || 0)}`)
  lines.push(`Race Duration: ${formatDuration(totalDuration)}`)
  lines.push('')

  // Score distribution
  const scores = allEvents.map(e => e.score).filter(s => s > 0)
  if (scores.length > 0) {
    lines.push('## Score Distribution (after normalization to 0–10)')
    lines.push(`  Min: ${Math.min(...scores).toFixed(2)}`)
    lines.push(`  Max: ${Math.max(...scores).toFixed(2)}`)
    lines.push(`  Mean: ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)}`)
    const raw = allEvents.map(e => e.raw_score || e.score).filter(s => s > 0)
    if (raw.length > 0) {
      lines.push(`  Raw score range (pre-normalization): ${Math.min(...raw).toFixed(3)} – ${Math.max(...raw).toFixed(3)}`)
    }
    lines.push('')
  }

  // Tier breakdown
  const tierCounts = { S: 0, A: 0, B: 0, C: 0 }
  for (const e of allEvents) tierCounts[e.tier] = (tierCounts[e.tier] || 0) + 1
  lines.push('## Tier Breakdown (all events)')
  lines.push(`  S (>9):  ${tierCounts.S} events`)
  lines.push(`  A (≥7):  ${tierCounts.A} events`)
  lines.push(`  B (≥5):  ${tierCounts.B} events`)
  lines.push(`  C (<5):  ${tierCounts.C} events`)
  lines.push('')

  // Type breakdown
  const typeCounts = {}
  for (const e of allEvents) {
    const t = e.event_type || 'unknown'
    typeCounts[t] = (typeCounts[t] || 0) + 1
  }
  lines.push('## Event Types')
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    const chosen = chosenEvents.filter(e => e.event_type === type).length
    lines.push(`  ${EVENT_TYPE_LABELS[type] || type}: ${count} total, ${chosen} chosen`)
  }
  lines.push('')

  // Bucket allocation
  lines.push('## Timeline Bucket Allocation')
  const bucketCounts = { intro: [], early: [], mid: [], late: [] }
  for (const e of chosenEvents) {
    const b = e.bucket || 'mid'
    if (!bucketCounts[b]) bucketCounts[b] = []
    bucketCounts[b].push(e)
  }
  for (const [bucket, evts] of Object.entries(bucketCounts)) {
    const dur = evts.reduce((s, e) => s + (e.end_time_seconds - e.start_time_seconds), 0)
    lines.push(`  ${bucket}: ${evts.length} events, ${formatDuration(dur)}`)
  }
  lines.push('')

  // Quality metrics
  lines.push('## Quality Metrics')
  lines.push(`  Balance Score: ${metrics.balance ?? '—'}/100`)
  lines.push(`  Pacing Score: ${metrics.pacing ?? '—'}/100`)
  lines.push(`  Driver Coverage: ${metrics.driverCoverage ?? '—'}% (${metrics.driverCount ?? 0}/${metrics.totalDrivers ?? 0})`)
  lines.push('')

  // Production Timeline section
  if (productionTimeline?.timeline?.length > 0) {
    const pt = productionTimeline
    const pm = productionTimeline.metrics || {}
    lines.push(hr)
    lines.push('## PRODUCTION TIMELINE')
    lines.push(hr)
    lines.push('')
    lines.push('### Summary')
    lines.push(`  Total edit duration:  ${formatDuration(pm.duration || 0)}`)
    lines.push(`  Content (events):     ${formatDuration(pm.contentDuration || 0)}`)
    lines.push(`  Context fills:        ${formatDuration(pm.contextDuration || 0)}`)
    lines.push(`  B-roll cut points:    ${pm.bridgeCount || 0} (instant cuts)`)
    lines.push(`  Segments:             ${pm.segmentCount || 0} total (${pm.eventCount || 0} event, ${pm.bridgeCount || 0} bridge, ${pt.timeline.filter(s=>s.type==='context').length} context)`)
    lines.push('')
    lines.push('### Overlap Resolutions')
    lines.push(`  Merged clips:         ${pm.mergeCount || 0}`)
    lines.push(`  PIP segments:         ${pm.pipCount || 0}`)
    lines.push(`  Trimmed clips:        ${pm.trimCount || 0}`)
    lines.push(`  Absorbed overtakes:   ${pm.absorbCount || 0}`)
    lines.push(`  Demoted (dropped):    ${pm.demotedCount || 0}`)
    lines.push(`  Context fills added:  ${pm.contextFillCount || 0}`)
    lines.push('')
    lines.push('### Segment Sequence')
    for (const seg of pt.timeline) {
      const typeLabel = seg.type === 'bridge' ? 'BRIDGE'
        : seg.type === 'context' ? 'CONTEXT'
        : seg.type === 'merge' ? 'MERGE'
        : seg.type === 'pip' ? 'PIP'
        : 'EVENT'
      const evtLabel = seg.event_type ? (EVENT_TYPE_LABELS[seg.event_type] || seg.event_type) : ''
      const resolution = seg.resolution && seg.resolution !== 'placed' ? ` [${seg.resolution}]` : ''
      lines.push(`  ${typeLabel.padEnd(8)} ${formatTime(seg.clipStart)} – ${formatTime(seg.clipEnd)} (${formatDuration(seg.clipDuration)}) ${evtLabel}${resolution}`)
      if (seg.resolutionNote) lines.push(`           └ ${seg.resolutionNote}`)
    }
    lines.push('')
  }

  // Per-event detail (chosen events, sorted by time)
  lines.push(hr)
  lines.push('## CHOSEN EVENT DETAILS')
  lines.push(hr)
  const sortedChosen = [...chosenEvents].sort((a, b) => a.start_time_seconds - b.start_time_seconds)
  for (const evt of sortedChosen) {
    lines.push('')
    lines.push(`[${evt.tier}] ${EVENT_TYPE_LABELS[evt.event_type] || evt.event_type} — Score: ${evt.score}`)
    lines.push(`  Time: ${formatTime(evt.start_time_seconds)} – ${formatTime(evt.end_time_seconds)} (${formatDuration(evt.end_time_seconds - evt.start_time_seconds)})`)
    lines.push(`  Bucket: ${evt.bucket} | Severity: ${evt.severity ?? '—'}`)
    if (evt.reason) lines.push(`  Reason: ${evt.reason}`)
    if (evt.score_components) {
      const c = evt.score_components
      const parts = []
      if (c.base != null) parts.push(`base=${c.base}`)
      if (c.position != null && c.position !== 1) parts.push(`pos×${c.position}`)
      if (c.position_change != null && c.position_change !== 1) parts.push(`posΔ×${c.position_change.toFixed(1)}`)
      if (c.consequence != null && c.consequence > 0) parts.push(`cons=${c.consequence}`)
      if (c.narrative_bonus != null && c.narrative_bonus > 0) parts.push(`narr=${c.narrative_bonus}`)
      if (c.user_weight != null && c.user_weight !== 1) parts.push(`wt×${c.user_weight}`)
      if (c.normalization) {
        parts.push(`raw=${c.normalization.raw.toFixed(3)}`)
      }
      lines.push(`  Pipeline: ${parts.join(' → ')}`)
    }
    if (evt.driver_names?.length) {
      lines.push(`  Drivers: ${evt.driver_names.join(', ')}`)
    }
  }
  lines.push('')

  // Excluded events summary
  const excluded = allEvents.filter(e => e.inclusion === 'excluded')
  if (excluded.length > 0) {
    lines.push(hr)
    lines.push(`## EXCLUDED EVENTS (${excluded.length})`)
    lines.push(hr)
    for (const evt of excluded.sort((a, b) => b.score - a.score).slice(0, 20)) {
      lines.push(`  [${evt.tier}] ${EVENT_TYPE_LABELS[evt.event_type] || evt.event_type} score=${evt.score} — ${evt.reason || 'Not selected'}`)
    }
    if (excluded.length > 20) lines.push(`  ... and ${excluded.length - 20} more`)
  }

  return lines.join('\n')
}

export default function ScoringReportModal({ allEvents, chosenEvents, pipEvents, metrics, totalDuration, productionTimeline, onClose }) {
  const reportText = useMemo(() =>
    generateReportText(allEvents, chosenEvents, pipEvents, metrics, totalDuration, productionTimeline),
    [allEvents, chosenEvents, pipEvents, metrics, totalDuration, productionTimeline]
  )

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(reportText)
  }, [reportText])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-bg-tertiary border border-border rounded-2xl shadow-float w-full max-w-3xl mx-4 flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h3 className="text-lg font-semibold text-text-primary">Scoring Algorithm Report</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border-subtle
                         text-text-secondary hover:text-text-primary hover:border-border rounded transition-colors"
            >
              <Copy size={12} />
              Copy
            </button>
            <button onClick={onClose} className="p-2 rounded-xl hover:bg-surface-hover transition-colors">
              <X className="w-5 h-5 text-text-tertiary" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-6">
          <pre className="text-xs text-text-secondary font-mono whitespace-pre-wrap leading-relaxed">
            {reportText}
          </pre>
        </div>
      </div>
    </div>
  )
}
