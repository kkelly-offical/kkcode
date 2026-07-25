import { getAgent } from "../agent/agent.mjs"

/**
 * 从注册表 agent 提取委派需要的字段。
 * maxTurns 此前不在这份提取里 —— bug-hunter 的 `maxTurns: 30` 从未生效，
 * 所有子智能体实际都被 agent.max_steps 默认的 8 步封顶（0.6.0 修复）。
 */
function fromRegistry(name, registeredAgent) {
  return {
    name,
    mode: registeredAgent.mode || "agent",
    permission: registeredAgent.permission,
    tools: registeredAgent.tools,
    model: normalizeModel(registeredAgent.model),
    temperature: registeredAgent.temperature,
    maxTurns: registeredAgent.maxTurns
  }
}

/**
 * `model: "inherit"` 意为「跟随会话模型」，不是模型名。skill 加载器一直做了
 * 这个归一化（skill/registry.mjs），agent 这边漏了 —— 字面量 "inherit" 会被
 * 原样发给 provider。
 */
function normalizeModel(model) {
  const value = String(model || "").trim()
  return !value || value.toLowerCase() === "inherit" ? null : value
}

export function resolveSubagent({ config, subagentType = null, category = null }) {
  if (subagentType && category) {
    throw new Error("category and subagent_type are mutually exclusive")
  }

  if (subagentType) {
    const override = config.agent?.subagents?.[subagentType]
    const registeredAgent = getAgent(subagentType)

    if (override) {
      // 配置覆盖与注册表定义**合并**，而不是替换。0.6.0 之前是直接替换：
      // 用户只想给 explore 换个模型（subagents.explore.model: x），就会连带
      // 丢掉它的 permission: readonly 与 tools 白名单 —— 静默升权成全量。
      const base = registeredAgent ? fromRegistry(subagentType, registeredAgent) : { name: subagentType, mode: "agent" }
      const merged = { ...base }
      for (const [key, value] of Object.entries(override)) {
        if (value !== undefined && value !== null) merged[key] = value
      }
      merged.model = normalizeModel(merged.model)
      merged.name = subagentType
      return merged
    }

    if (registeredAgent) {
      return fromRegistry(subagentType, registeredAgent)
    }
    // If the requested type isn't configured, fall through to default resolution
    // instead of throwing — this handles "default-subagent" and other synthetic names
    if (Object.keys(config.agent?.subagents || {}).length === 0) {
      return {
        name: subagentType,
        mode: "agent"
      }
    }
    // Unknown subagent type with configured subagents — return structured error fallback
    return {
      name: subagentType,
      mode: "agent",
      fallback: true,
      reason: `unknown subagent_type: ${subagentType}`
    }
  }

  if (category) {
    const route = config.agent?.routing?.categories?.[category]
    if (!route) throw new Error(`no subagent routing for category: ${category}`)
    const agent = config.agent?.subagents?.[route]
    if (!agent) throw new Error(`routed subagent not found: ${route}`)
    return {
      name: route,
      ...agent,
      model: normalizeModel(agent.model)
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
    ...first[1],
    model: normalizeModel(first[1]?.model)
  }
}
