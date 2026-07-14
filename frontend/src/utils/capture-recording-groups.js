/**
 * Build stable capture-sidebar rows from the planned recording strategy.
 * A segment marked "continue" belongs to the same take as the segment before it.
 * Completed clip paths remain as a fallback for older persisted strategies.
 */
export function buildCaptureRecordingRows(segments = []) {
  const rows = []

  for (let index = 0; index < segments.length;) {
    const groupedSegments = [segments[index]]
    let nextIndex = index + 1
    const continuityGroupId = segments[index]?.continuity_group_id

    while (nextIndex < segments.length) {
      const nextSegment = segments[nextIndex]
      const sharesContinuityGroup = Boolean(continuityGroupId)
        && nextSegment?.continuity_group_id === continuityGroupId
      const continuesRecording = nextSegment?.strategy === 'continue'
      if (!sharesContinuityGroup && !continuesRecording) break

      groupedSegments.push(nextSegment)
      nextIndex += 1
    }

    if (groupedSegments.length === 1) {
      const sharedPath = String(segments[index]?.clip_path || '')
      if (sharedPath) {
        while (nextIndex < segments.length && segments[nextIndex]?.clip_path === sharedPath) {
          groupedSegments.push(segments[nextIndex])
          nextIndex += 1
        }
      }
    }

    if (groupedSegments.length > 1) {
      const firstId = groupedSegments[0]?.segment_id || groupedSegments[0]?.id || index
      rows.push({
        type: 'recording-group',
        key: `recording-group-${firstId}`,
        segments: groupedSegments,
      })
      index = nextIndex
      continue
    }

    rows.push({ type: 'segment', segment: segments[index] })
    index += 1
  }

  return rows
}
