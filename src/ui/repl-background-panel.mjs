export function renderBackgroundSummaryPanel(backgroundSummary) {
  if (!backgroundSummary) return []
  return [
    `background=${backgroundSummary.active} active (pending:${backgroundSummary.counts.pending}, running:${backgroundSummary.counts.running})`,
    `background.terminal=completed:${backgroundSummary.counts.completed} interrupted:${backgroundSummary.counts.interrupted} error:${backgroundSummary.counts.error}`
  ]
}
