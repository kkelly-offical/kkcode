export function buildOperatorSnapshot({ runtimeSummary = null, backgroundSummary = null } = {}) {
  const actions = []
  if (runtimeSummary?.recoverableCount) {
    actions.push(`recoverable sessions available: ${runtimeSummary.recoverableCount}`)
  }
  const recentTerminal = backgroundSummary?.recent_terminal || []
  for (const item of recentTerminal.slice(0, 2)) {
    if (item?.next_action) actions.push(`${item.id}: ${item.next_action}`)
  }
  return {
    recoverableCount: Number(runtimeSummary?.recoverableCount || 0),
    activeBackground: Number(backgroundSummary?.active || 0),
    actions
  }
}
