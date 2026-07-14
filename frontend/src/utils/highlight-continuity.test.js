import { describe, expect, it } from 'vitest'
import { buildContinuityRuns } from './highlight-continuity.js'

const segment = (id, editStart, editEnd, groupId, start = editStart, end = editEnd) => ({
  id,
  section: 'race',
  type: 'event',
  editStart,
  editEnd,
  editDur: editEnd - editStart,
  start_time_seconds: start,
  end_time_seconds: end,
  continuity_group_id: groupId,
})

describe('buildContinuityRuns', () => {
  it('joins clips that share an authoritative continuity group', () => {
    const runs = buildContinuityRuns([
      segment('a', 0, 10, 'group_1', 100, 110),
      segment('b', 10, 18, 'group_1', 110, 118),
      segment('c', 18, 24, 'group_2', 200, 206),
    ])

    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ editStart: 0, editEnd: 18, clipCount: 2 })
    expect(runs[1].color).not.toBe(runs[0].color)
  })

  it('keeps explicit continuity footage inside the same run without counting it as a clip', () => {
    const bridge = {
      ...segment('flow', 10, 13, 'group_1', 110, 113),
      type: 'continuity',
    }
    const runs = buildContinuityRuns([
      segment('a', 0, 10, 'group_1', 100, 110),
      bridge,
      segment('b', 13, 20, 'group_1', 113, 120),
    ])

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ editStart: 0, editEnd: 20, duration: 20, clipCount: 2 })
  })

  it('falls back to session-time adjacency for older scripts', () => {
    const runs = buildContinuityRuns([
      segment('a', 0, 10, null, 100, 110),
      segment('b', 10, 16, null, 110.04, 116),
      segment('c', 16, 22, null, 130, 136),
    ])

    expect(runs).toHaveLength(2)
    expect(runs[0].clipCount).toBe(2)
    expect(runs[1].clipCount).toBe(1)
  })
})
