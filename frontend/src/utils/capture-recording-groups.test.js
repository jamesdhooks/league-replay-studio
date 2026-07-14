import { describe, expect, it } from 'vitest'
import { buildCaptureRecordingRows } from './capture-recording-groups.js'

const segment = (id, strategy = 'new_recording', extra = {}) => ({
  id,
  segment_id: id,
  strategy,
  ...extra,
})

describe('buildCaptureRecordingRows', () => {
  it('uses authoritative continuity groups before capture strategies exist', () => {
    const rows = buildCaptureRecordingRows([
      segment('a', undefined, { continuity_group_id: 'flow-1' }),
      segment('b', undefined, { continuity_group_id: 'flow-1' }),
      segment('c', undefined, { continuity_group_id: 'flow-2' }),
      segment('d', undefined, { continuity_group_id: 'flow-2' }),
    ])

    expect(rows.map((row) => row.segments?.map((item) => item.segment_id))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('groups planned continuation segments before capture', () => {
    const rows = buildCaptureRecordingRows([
      segment('a'),
      segment('b', 'continue'),
      segment('c', 'continue'),
      segment('d'),
    ])

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      type: 'recording-group',
      segments: [{ segment_id: 'a' }, { segment_id: 'b' }, { segment_id: 'c' }],
    })
    expect(rows[1]).toMatchObject({ type: 'segment', segment: { segment_id: 'd' } })
  })

  it('starts a new group at every recording cut', () => {
    const rows = buildCaptureRecordingRows([
      segment('a'),
      segment('b', 'continue'),
      segment('c'),
      segment('d', 'continue'),
    ])

    expect(rows.map((row) => row.segments?.map((item) => item.segment_id))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('keeps the executor continuation inside the visible take', () => {
    const rows = buildCaptureRecordingRows([
      segment('a', 'new_recording', { continuity_group_id: 'flow-1' }),
      segment('b', 'continue', { continuity_group_id: null }),
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0].segments.map((item) => item.segment_id)).toEqual(['a', 'b'])
  })

  it('falls back to completed shared paths for older strategies', () => {
    const rows = buildCaptureRecordingRows([
      segment('a', undefined, { clip_path: 'clips/shared.mp4' }),
      segment('b', undefined, { clip_path: 'clips/shared.mp4' }),
      segment('c', undefined, { clip_path: 'clips/single.mp4' }),
    ])

    expect(rows[0].type).toBe('recording-group')
    expect(rows[0].segments).toHaveLength(2)
    expect(rows[1].type).toBe('segment')
  })
})
