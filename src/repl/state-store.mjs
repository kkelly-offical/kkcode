export function collectMcpSummary(registry) {
  const snapshot = registry.healthSnapshot()
  const tools = registry.listTools()
  const byServer = {}
  for (const tool of tools) {
    const server = tool.server || "unknown"
    byServer[server] = (byServer[server] || 0) + 1
  }
  const healthy = snapshot.filter((item) => item.ok).length
  return {
    configured: snapshot.length,
    healthy,
    unhealthy: snapshot.length - healthy,
    tools: tools.length,
    byServer,
    entries: snapshot
  }
}

export function collectSkillSummary(registry) {
  const list = registry.isReady() ? registry.list() : []
  return {
    total: list.length,
    template: list.filter((s) => s.type === "template").length,
    skillMd: list.filter((s) => s.type === "skill_md").length,
    mcpPrompt: list.filter((s) => s.type === "mcp_prompt").length,
    programmable: list.filter((s) => s.type === "mjs").length
  }
}
