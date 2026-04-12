export async function buildCapabilitySnapshot({
  mode,
  cwd = process.cwd(),
  configState,
  customCommands = [],
  skillRegistry,
  toolRegistry,
  mcpRegistry,
  listAgents = () => []
}) {
  const skills = skillRegistry.isReady() ? skillRegistry.list() : []
  const tools = await toolRegistry.list({
    mode,
    cwd,
    config: configState?.config
  }).catch(() => [])
  const mcpEntries = mcpRegistry.healthSnapshot()
  const healthyMcp = mcpEntries.filter((entry) => entry.ok).length
  const agents = listAgents() || []

  return {
    mode,
    customCommands: customCommands.length,
    skills: skills.length,
    tools: tools.length,
    mcpServers: mcpEntries.length,
    healthyMcp,
    agents: agents.length
  }
}
