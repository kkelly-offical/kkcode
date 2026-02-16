import { getAgent } from "../agent/agent.mjs"

export function resolveSubagent({ config, subagentType = null, category = null }) {
  if (subagentType && category) {
    throw new Error("category and subagent_type are mutually exclusive")
  }

  if (subagentType) {
    const agent = config.agent?.subagents?.[subagentType]
    if (agent) {
      return {
        name: subagentType,
        ...agent
      }
    }
    // Fallback: check the agent registry for custom agents
    const registeredAgent = getAgent(subagentType)
    if (registeredAgent) {
      return {
        name: subagentType,
        mode: registeredAgent.mode || "agent",
        permission: registeredAgent.permission,
        tools: registeredAgent.tools,
        model: registeredAgent.model,
        temperature: registeredAgent.temperature
      }
    }
    // If the requested type isn't configured, fall through to default resolution
    // instead of throwing — this handles "default-subagent" and other synthetic names
    if (Object.keys(config.agent?.subagents || {}).length === 0) {
      return {
        name: subagentType,
        mode: "agent"
      }
    }
    throw new Error(`unknown subagent_type: ${subagentType}`)
  }

  if (category) {
    const route = config.agent?.routing?.categories?.[category]
    if (!route) throw new Error(`no subagent routing for category: ${category}`)
    const agent = config.agent?.subagents?.[route]
    if (!agent) throw new Error(`routed subagent not found: ${route}`)
    return {
      name: route,
      ...agent
    }
  }

  const first = Object.entries(config.agent?.subagents || {})[0]
  if (!first) {
    return {
      name: "default-subagent",
      mode: "agent"
    }
  }

  return {
    name: first[0],
    ...first[1]
  }
}
