export function renderCapabilityPanel(snapshot) {
  if (!snapshot) return []
  return [
    "capability surface:",
    `  mode=${snapshot.mode}`,
    `  commands=${snapshot.customCommands} skills=${snapshot.skills} tools=${snapshot.tools}`,
    `  mcp=${snapshot.healthyMcp}/${snapshot.mcpServers} healthy agents=${snapshot.agents}`
  ]
}
