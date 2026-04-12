export const MODE_CYCLE_ORDER = ["longagent", "plan", "ask", "agent"]

export function nextMode(currentMode, order = MODE_CYCLE_ORDER) {
  const idx = order.indexOf(currentMode)
  const nextIdx = idx >= 0 ? (idx + 1) % order.length : 0
  return order[nextIdx]
}
