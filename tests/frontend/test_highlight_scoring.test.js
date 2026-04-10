/**
 * test_highlight_scoring.test.js
 * ------------------------------
 * Tests for the pure scoring functions extracted from HighlightContext.
 * Run with: npx vitest run tests/frontend/
 */

import { describe, it, expect } from 'vitest'
import {
  BASE_SCORES,
  MANDATORY_TYPES,
  TIER_S_THRESHOLD,
  TIER_A_THRESHOLD,
  TIER_B_THRESHOLD,
  BUCKET_BOUNDARIES,
  TIER_COLORS,
  tierColor,
  computeEventScore,
  computeHighlightSelection,
  autoBalanceWeights,
  normalizeOverride,
} from '../../frontend/src/utils/highlight-scoring.js'


// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides = {}) {
  return {
    id: 1,
    event_type: 'incident',
    severity: 5,
    position: 5,
    start_time_seconds: 60,
    end_time_seconds: 65,
    metadata: {},
    involved_drivers: [],
    driver_names: [],
    ...overrides,
  }
}

const DEFAULT_WEIGHTS = {
  incident: 80, battle: 60, overtake: 70, pit_stop: 20,
  leader_change: 90, first_lap: 100,
  last_lap: 100,
  // SessionLog-sourced
  car_contact: 85, contact: 65, lost_control: 55, off_track: 25, turn_cutting: 15,
  // Legacy
  crash: 80, spinout: 60, close_call: 40,
}


// ── Constants ────────────────────────────────────────────────────────────────

describe('Shared Constants', () => {
  it('BASE_SCORES has expected event types', () => {
    // SessionLog-sourced types must be present
    const newTypes = ['car_contact', 'contact', 'lost_control', 'off_track', 'turn_cutting']
    const legacyTypes = ['crash', 'incident', 'battle', 'spinout', 'overtake',
      'leader_change', 'pit_stop', 'close_call']
    const required = [...newTypes, ...legacyTypes]
    const keys = Object.keys(BASE_SCORES)
    required.forEach(k => expect(keys).toContain(k))
  })

  it('MANDATORY_TYPES includes first_lap and last_lap', () => {
    expect(MANDATORY_TYPES.has('first_lap')).toBe(true)
    expect(MANDATORY_TYPES.has('last_lap')).toBe(true)
    expect(MANDATORY_TYPES.has('incident')).toBe(false)
  })

  it('tier thresholds are ordered correctly', () => {
    expect(TIER_S_THRESHOLD).toBeGreaterThan(TIER_A_THRESHOLD)
    expect(TIER_A_THRESHOLD).toBeGreaterThan(TIER_B_THRESHOLD)
  })

  it('bucket boundaries cover 0.0–1.0', () => {
    const allBounds = Object.values(BUCKET_BOUNDARIES).sort((a, b) => a[0] - b[0])
    expect(allBounds[0][0]).toBe(0.0)
    expect(allBounds[allBounds.length - 1][1]).toBe(1.0)
  })

  it('TIER_COLORS has S/A/B/C', () => {
    expect(Object.keys(TIER_COLORS)).toEqual(['S', 'A', 'B', 'C'])
  })

  it('tierColor returns correct color for known tier', () => {
    expect(tierColor('S')).toBe('#ef4444')
    expect(tierColor('C')).toBe('#6b7280')
  })

  it('tierColor returns gray for unknown tier', () => {
    expect(tierColor('X')).toBe('#6b7280')
  })
})


// ── computeEventScore ────────────────────────────────────────────────────────

describe('computeEventScore', () => {
  it('returns score, tier, bucket, components', () => {
    const result = computeEventScore(makeEvent(), DEFAULT_WEIGHTS)
    expect(result).toHaveProperty('score')
    expect(result).toHaveProperty('tier')
    expect(result).toHaveProperty('bucket')
    expect(result).toHaveProperty('components')
  })

  it('mandatory types always get score 10 base', () => {
    const event = makeEvent({ event_type: 'first_lap' })
    const result = computeEventScore(event, DEFAULT_WEIGHTS)
    expect(result.components.base).toBe(10.0)
    expect(result.tier).toBe('S')
  })

  it('unknown event type gets 0.5 base', () => {
    const event = makeEvent({ event_type: 'custom_thing' })
    const result = computeEventScore(event, DEFAULT_WEIGHTS)
    expect(result.components.base).toBe(0.5)
  })

  it('position <= 3 gets 2x multiplier', () => {
    const event = makeEvent({ position: 2 })
    const result = computeEventScore(event, DEFAULT_WEIGHTS)
    expect(result.components.position).toBe(2.0)
  })

  it('position 4-10 gets 1.5x multiplier', () => {
    const event = makeEvent({ position: 8 })
    const result = computeEventScore(event, DEFAULT_WEIGHTS)
    expect(result.components.position).toBe(1.5)
  })

  it('position > 10 gets 1.0x multiplier', () => {
    const event = makeEvent({ position: 15 })
    const result = computeEventScore(event, DEFAULT_WEIGHTS)
    expect(result.components.position).toBe(1.0)
  })

  it('late-race events get narrative bonus', () => {
    const event = makeEvent({ start_time_seconds: 950 })
    const result = computeEventScore(event, DEFAULT_WEIGHTS, {}, 1000)
    expect(result.components.narrative_bonus).toBeGreaterThan(0)
  })

  it('user weight scales score', () => {
    const eventFull = makeEvent({ event_type: 'incident' })
    const resultFull = computeEventScore(eventFull, { ...DEFAULT_WEIGHTS, incident: 100 })
    const resultHalf = computeEventScore(eventFull, { ...DEFAULT_WEIGHTS, incident: 50 })
    expect(resultFull.score).toBeGreaterThan(resultHalf.score)
  })

  it('handles string metadata (JSON parse)', () => {
    const event = makeEvent({ metadata: JSON.stringify({ position_delta: 3 }) })
    const result = computeEventScore(event, DEFAULT_WEIGHTS)
    expect(result.components.position_change).toBeGreaterThan(1.0)
  })

  it('bucket classification works with race duration', () => {
    const earlyEvent = makeEvent({ start_time_seconds: 10 })
    const lateEvent = makeEvent({ start_time_seconds: 900 })

    const earlyResult = computeEventScore(earlyEvent, DEFAULT_WEIGHTS, {}, 1000)
    const lateResult = computeEventScore(lateEvent, DEFAULT_WEIGHTS, {}, 1000)

    expect(earlyResult.bucket).toBe('intro')
    expect(lateResult.bucket).toBe('late')
  })
})


// ── normalizeOverride ────────────────────────────────────────────────────────

describe('normalizeOverride', () => {
  it('converts "include" to "highlight"', () => {
    expect(normalizeOverride('include')).toBe('highlight')
  })

  it('passes through "highlight"', () => {
    expect(normalizeOverride('highlight')).toBe('highlight')
  })

  it('returns null for undefined', () => {
    expect(normalizeOverride(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(normalizeOverride('')).toBeNull()
  })
})


// ── computeHighlightSelection ────────────────────────────────────────────────

describe('computeHighlightSelection', () => {
  it('returns expected structure', () => {
    const events = [makeEvent()]
    const result = computeHighlightSelection(
      events, DEFAULT_WEIGHTS, 300, 0, {}, 600, [], {}
    )
    expect(result).toHaveProperty('scoredEvents')
    expect(result).toHaveProperty('selectedIds')
    expect(result).toHaveProperty('fullVideoIds')
    expect(result).toHaveProperty('excludedIds')
    expect(result).toHaveProperty('metrics')
  })

  it('handles empty events', () => {
    const result = computeHighlightSelection([], DEFAULT_WEIGHTS, 300, 0, {}, 600, [], {})
    expect(result.scoredEvents).toEqual([])
    expect(result.metrics.totalEvents).toBe(0)
  })

  it('mandatory events always included', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'first_lap', start_time_seconds: 0, end_time_seconds: 10 }),
      makeEvent({ id: 2, event_type: 'pit_stop', start_time_seconds: 100, end_time_seconds: 105 }),
    ]
    const result = computeHighlightSelection(events, DEFAULT_WEIGHTS, 15, 0, {}, 600, [], {})
    const included = result.scoredEvents.filter(e => e.inclusion === 'highlight')
    const types = included.map(e => e.event_type)
    expect(types).toContain('first_lap')
  })

  it('manual exclude overrides scoring', () => {
    const events = [makeEvent({ id: 1 })]
    const overrides = { '1': 'exclude' }
    const result = computeHighlightSelection(events, DEFAULT_WEIGHTS, 300, 0, overrides, 600, [], {})
    expect(result.scoredEvents[0].inclusion).toBe('excluded')
  })

  it('manual highlight overrides scoring', () => {
    const events = [makeEvent({ id: 1, event_type: 'pit_stop' })]
    const overrides = { '1': 'highlight' }
    const result = computeHighlightSelection(events, DEFAULT_WEIGHTS, 300, 0, overrides, 600, [], {})
    expect(result.scoredEvents[0].inclusion).toBe('highlight')
  })

  it('metrics include tier distribution', () => {
    const events = [
      makeEvent({ id: 1, event_type: 'first_lap' }),
      makeEvent({ id: 2, event_type: 'pit_stop', position: 20 }),
    ]
    const result = computeHighlightSelection(events, DEFAULT_WEIGHTS, 300, 0, {}, 600, [], {})
    expect(result.metrics.tierCounts).toHaveProperty('S')
    expect(result.metrics.tierCounts).toHaveProperty('C')
  })
})


// ── autoBalanceWeights ───────────────────────────────────────────────────────

describe('autoBalanceWeights', () => {
  it('returns weights for all event types', () => {
    const events = [
      makeEvent({ event_type: 'car_contact' }),
      makeEvent({ event_type: 'car_contact' }),
      makeEvent({ event_type: 'overtake' }),
    ]
    const result = autoBalanceWeights(events, DEFAULT_WEIGHTS)
    expect(result).toHaveProperty('car_contact')
    expect(result).toHaveProperty('overtake')
  })

  it('gives higher weight to rarer events', () => {
    const events = [
      makeEvent({ event_type: 'car_contact' }),
      makeEvent({ event_type: 'car_contact' }),
      makeEvent({ event_type: 'car_contact' }),
      makeEvent({ event_type: 'overtake' }),
    ]
    const result = autoBalanceWeights(events, DEFAULT_WEIGHTS)
    expect(result.overtake).toBeGreaterThan(result.car_contact)
  })
})
