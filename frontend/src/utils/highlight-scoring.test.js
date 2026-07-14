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
      maxGap: 180,
      maxSequenceDuration: 420,
      maxSequences: 3,
    })
  })

  it('supports explicit continuity rhythm overrides', () => {
    expect(getContinuitySettings({
      continuityPreference: 55,
      continuityBlockDuration: 75,
      continuityBlockCount: 8,
      continuityGapReach: 35,
    })).toMatchObject({
      preferredSequenceDuration: 75,
      maxSequenceDuration: 101.25,
      preferredSequences: 8,
      maxSequences: 10,
      maxGap: 35,
    })
  })

  it('keeps balanced continuity in the medium-block range', () => {
    const balanced = getContinuitySettings({ continuityPreference: 55 })

    expect(balanced.maxGap).toBe(25)
    expect(balanced.preferredSequenceDuration).toBe(60)
    expect(balanced.maxSequenceDuration).toBe(81)
    expect(balanced.preferredSequences).toBe(12)
  })

  it('keeps events distinct while joining their clip boundaries', () => {
    const scoredEvents = [
      { ...event(1, 'battle', 10, 15), inclusion: 'highlight', score: 8, tier: 'A', bucket: 'intro' },
      { ...event(2, 'overtake', 20, 25), inclusion: 'highlight', score: 7, tier: 'A', bucket: 'early' },
    ]
    const selection = { scoredEvents, fullVideoIds: [], metrics: {} }
    const base = { paddingBefore: 0, paddingAfter: 0, pipThreshold: 9 }

    const cutFocused = buildProductionTimeline(selection, 24, { ...base, continuityPreference: 0 }, 100)
    const continuous = buildProductionTimeline(selection, 24, { ...base, continuityPreference: 100 }, 100)

    expect(cutFocused.timeline.some(segment => segment.type === 'sequence')).toBe(false)
    const continuousEvents = continuous.timeline.filter(segment => segment.type !== 'bridge')
    expect(continuous.timeline.some(segment => segment.type === 'sequence')).toBe(false)
    expect(continuousEvents).toHaveLength(2)
    expect(continuousEvents[0].continuityGroupId).toBe(continuousEvents[1].continuityGroupId)
    expect(continuousEvents[0].clipEnd).toBe(continuousEvents[1].clipStart)
    expect(continuous.metrics.continuityDuration).toBeGreaterThanOrEqual(4)
    expect(continuous.metrics.continuitySequenceCount).toBe(1)
  })

  it('never retains a gap that would exceed the target', () => {
    const scoredEvents = [
      { ...event(1, 'race_start', 10, 15), inclusion: 'highlight', score: 8, tier: 'A', bucket: 'intro' },
      { ...event(2, 'race_finish', 20, 25), inclusion: 'highlight', score: 7, tier: 'A', bucket: 'early' },
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

  it('demotes overlap fragments shorter than the hard clip floor', () => {
    const scoredEvents = [
      { ...event(1, 'battle', 10, 20), inclusion: 'highlight', score: 8, tier: 'A', bucket: 'intro' },
      { ...event(2, 'incident', 18, 21), inclusion: 'highlight', score: 7, tier: 'A', bucket: 'early' },
    ]
    const result = buildProductionTimeline(
      { scoredEvents, fullVideoIds: [], metrics: {} },
      60,
      { paddingBefore: 0, paddingAfter: 0, continuityPreference: 100, pipThreshold: 9 },
      100,
    )

    const clips = result.timeline.filter(segment => segment.type !== 'bridge')
    expect(clips.every(segment => segment.clipDuration >= 6)).toBe(true)
    expect(result.demotedIds).toContain(2)
  })

  it('extends an instantaneous event to the hard clip floor', () => {
    const scoredEvents = [
      { ...event(1, 'overtake', 10, 11), inclusion: 'highlight', score: 8, tier: 'A', bucket: 'intro' },
    ]
    const result = buildProductionTimeline(
      { scoredEvents, fullVideoIds: [], metrics: {} },
      6,
      { paddingBefore: 0, paddingAfter: 0, continuityPreference: 100, pipThreshold: 9 },
      100,
    )

    expect(result.timeline.find(segment => segment.type !== 'bridge')?.clipDuration).toBe(6)
  })

  it('prefers an adjacent event when the duration budget only fits one alternative', () => {
    const events = [
      event(1, 'leader_change', 0, 20),
      event(3, 'overtake', 70, 130, 10),
      event(2, 'overtake', 25, 85, 1),
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

  it('fills the target by extending existing runs without adding cuts', () => {
    const scoredEvents = [
      { ...event(1, 'battle', 100, 120), inclusion: 'highlight', score: 8, tier: 'A', bucket: 'early' },
      { ...event(2, 'overtake', 500, 520), inclusion: 'highlight', score: 7, tier: 'A', bucket: 'late' },
    ]
    const result = buildProductionTimeline(
      { scoredEvents, fullVideoIds: [], metrics: {} },
      180,
      { paddingBefore: 0, paddingAfter: 0, continuityPreference: 100, pipThreshold: 9 },
      700,
    )

    const clips = result.timeline.filter(segment => segment.type !== 'bridge')
    expect(result.metrics.duration).toBe(180)
    expect(clips).toHaveLength(2)
    expect(result.metrics.hardCutCount).toBe(1)
    expect(clips.every(segment => segment.type !== 'sequence')).toBe(true)
    expect(clips[0].continuityGroupId).not.toBe(clips[1].continuityGroupId)
  })
})
