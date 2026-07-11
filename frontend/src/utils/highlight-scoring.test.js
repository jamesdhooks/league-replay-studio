import { describe, expect, it } from 'vitest'
import {
  buildProductionTimeline,
  computeHighlightSelection,
  getContinuitySettings,
} from './highlight-scoring'

function event(id, eventType, start, end, severity = 5) {
  return {
    id,
    event_type: eventType,
    start_time_seconds: start,
    end_time_seconds: end,
    severity,
    involved_drivers: [id],
    driver_names: [`Driver ${id}`],
    metadata: {},
  }
}

describe('continuity-aware highlight planning', () => {
  it('maps the continuity slider to bounded planning values', () => {
    expect(getContinuitySettings({ continuityPreference: 0 })).toMatchObject({ enabled: false, maxGap: 1 })
    expect(getContinuitySettings({ continuityPreference: 100 })).toMatchObject({
      enabled: true,
      maxGap: 15,
      maxSequenceDuration: 180,
    })
  })

  it('emits retained continuity footage only when enabled', () => {
    const scoredEvents = [
      { ...event(1, 'battle', 10, 15), inclusion: 'highlight', score: 8, tier: 'A', bucket: 'intro' },
      { ...event(2, 'overtake', 20, 25), inclusion: 'highlight', score: 7, tier: 'A', bucket: 'early' },
    ]
    const selection = { scoredEvents, fullVideoIds: [], metrics: {} }
    const base = { paddingBefore: 0, paddingAfter: 0, pipThreshold: 9 }

    const cutFocused = buildProductionTimeline(selection, 60, { ...base, continuityPreference: 0 }, 100)
    const continuous = buildProductionTimeline(selection, 60, { ...base, continuityPreference: 100 }, 100)

    expect(cutFocused.timeline.some(segment => segment.type === 'continuity')).toBe(false)
    expect(continuous.timeline.filter(segment => segment.type === 'continuity')).toHaveLength(1)
    expect(continuous.metrics.continuityDuration).toBe(5)
    expect(continuous.metrics.continuitySequenceCount).toBe(1)
  })

  it('never retains a gap that would exceed the target', () => {
    const scoredEvents = [
      { ...event(1, 'battle', 10, 15), inclusion: 'highlight', score: 8, tier: 'A', bucket: 'intro' },
      { ...event(2, 'overtake', 20, 25), inclusion: 'highlight', score: 7, tier: 'A', bucket: 'early' },
    ]
    const result = buildProductionTimeline(
      { scoredEvents, fullVideoIds: [], metrics: {} },
      12,
      { paddingBefore: 0, paddingAfter: 0, continuityPreference: 100, pipThreshold: 9 },
      100,
    )

    expect(result.metrics.duration).toBeLessThanOrEqual(12)
    expect(result.metrics.continuityDuration).toBe(0)
  })

  it('prefers an adjacent event when the duration budget only fits one alternative', () => {
    const events = [
      event(1, 'leader_change', 0, 20),
      event(3, 'overtake', 70, 130),
      event(2, 'overtake', 25, 85),
    ]
    const params = {
      paddingBefore: 0,
      paddingAfter: 0,
      continuityPreference: 100,
      diversityStrength: 0,
      driverCoverageStrength: 0,
      lateRaceMultiplier: 1,
    }
    const selection = computeHighlightSelection(
      events,
      { leader_change: 100, overtake: 50 },
      100,
      0,
      { '1': 'highlight' },
      100,
      [],
      params,
    )

    expect(selection.selectedIds).toContain(1)
    expect(selection.selectedIds).toContain(2)
    expect(selection.selectedIds).not.toContain(3)
  })
})
