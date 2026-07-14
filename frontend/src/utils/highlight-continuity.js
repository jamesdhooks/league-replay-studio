export const CONTINUITY_RUN_COLORS = [
  '#14b8a6',
  '#f59e0b',
  '#8b5cf6',
  '#e11d48',
  '#06b6d4',
  '#84cc16',
]

const segmentGroupId = (segment) => (
  segment?.continuity_group_id ?? segment?.continuityGroupId ?? null
)

const segmentStart = (segment) => Number(
  segment?.clipStartTime ?? segment?.start_time_seconds ?? 0
)

const segmentEnd = (segment) => Number(
  segment?.clipEndTime ?? segment?.end_time_seconds ?? segmentStart(segment)
)

export function buildContinuityRuns(editSegments, adjacencyTolerance = 0.05) {
  const runs = []
  let fallbackGroup = 0
  let previous = null

  for (const segment of editSegments || []) {
    const isRace = (segment?.section || 'race') === 'race'
    const isPlayable = Number(segment?.editDur || 0) > 0
      && segment?.type !== 'bridge'
      && segment?.type !== 'transition'

    if (!isRace || !isPlayable) {
      previous = null
      continue
    }

    const explicitGroup = segmentGroupId(segment)
    const start = segmentStart(segment)
    const end = segmentEnd(segment)
    const continuesExplicitGroup = explicitGroup != null
      && previous?.explicitGroup != null
      && String(explicitGroup) === String(previous.explicitGroup)
    const continuesByAdjacency = explicitGroup == null
      && previous?.explicitGroup == null
      && previous != null
      && start <= previous.end + adjacencyTolerance

    if (!continuesExplicitGroup && !continuesByAdjacency) fallbackGroup += 1
    const groupKey = explicitGroup != null ? `group:${explicitGroup}` : `fallback:${fallbackGroup}`
    const lastRun = runs[runs.length - 1]
    const clipIncrement = segment.type === 'continuity' ? 0 : 1

    if (lastRun?.groupKey === groupKey) {
      lastRun.editEnd = Math.max(lastRun.editEnd, segment.editEnd)
      lastRun.duration += Number(segment.editDur || 0)
      lastRun.clipCount += clipIncrement
    } else {
      runs.push({
        groupKey,
        groupId: explicitGroup,
        editStart: segment.editStart,
        editEnd: segment.editEnd,
        duration: Number(segment.editDur || 0),
        clipCount: clipIncrement,
      })
    }

    previous = { explicitGroup, end }
  }

  return runs.map((run, index) => ({
    ...run,
    color: CONTINUITY_RUN_COLORS[index % CONTINUITY_RUN_COLORS.length],
  }))
}
