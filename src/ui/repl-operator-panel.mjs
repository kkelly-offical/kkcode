export function renderOperatorPanel(snapshot) {
  if (!snapshot) return []
  const lines = [
    "operator surface:",
    `  recoverable=${snapshot.recoverableCount}`,
    `  background.active=${snapshot.activeBackground}`
  ]
  for (const action of snapshot.actions || []) {
    lines.push(`  next: ${action}`)
  }
  return lines
}
