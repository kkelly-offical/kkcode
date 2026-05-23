export function renderBackgroundSummaryPanel(backgroundSummary) {
  if (!backgroundSummary) return []
  const groups = Array.isArray(backgroundSummary.parallel_groups) ? backgroundSummary.parallel_groups : []
  const activeGroups = groups.filter((group) => Number(group.active || 0) > 0).length
  const activeLanes = groups.reduce((sum, group) => sum + Number(group.active || 0), 0)
  const lines = [
    `background=${backgroundSummary.active} active (pending:${backgroundSummary.counts.pending}, running:${backgroundSummary.counts.running})`,
    `background.terminal=completed:${backgroundSummary.counts.completed} interrupted:${backgroundSummary.counts.interrupted} error:${backgroundSummary.counts.error}`
  ]
  if (groups.length) lines.push(`parallel=${activeGroups} active group(s), ${activeLanes} active lane(s)`)
  return lines
}
