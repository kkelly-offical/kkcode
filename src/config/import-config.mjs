import { DEFAULT_CONFIG } from "./defaults.mjs"
import { mergeConfigObject } from "./merge.mjs"

const mergeObject = mergeConfigObject

function normalizePermissionRules(inputRules = {}) {
  const rules = []
  for (const [tool, value] of Object.entries(inputRules)) {
    if (typeof value !== "boolean") continue
    rules.push({
      tool,
      action: value ? "allow" : "deny"
    })
  }
  return rules
}

export function importConfig(input = {}) {
  const next = structuredClone(DEFAULT_CONFIG)

  if (input.llm) {
    if (input.llm.default_provider_type) next.provider.default = input.llm.default_provider_type
    if (input.llm.max_steps) next.agent.max_steps = Number(input.llm.max_steps)

    for (const key of ["openai", "anthropic"]) {
      if (!input.llm[key]) continue
      const src = input.llm[key]
      // DEFAULT_CONFIG 从 0.7.3 起不再预置 provider 条目 —— 导入的就是
      // 用户配置的全部来源，条目在这里创建而不是覆盖预置。
      const dst = next.provider[key] ?? (next.provider[key] = {})
      if (src.base_url) dst.base_url = src.base_url
      if (src.api_key_env) dst.api_key_env = src.api_key_env
      if (src.default_model) dst.default_model = src.default_model
    }
  }

  if (input.longagent?.max_iterations !== undefined) {
    next.agent.longagent.max_iterations = Number(input.longagent.max_iterations)
  }

  if (input.usage) {
    if (input.usage.pricing_file !== undefined) next.usage.pricing_file = input.usage.pricing_file
    if (Array.isArray(input.usage.aggregation)) next.usage.aggregation = [...input.usage.aggregation]
  }

  if (input.ui) {
    if (input.ui.layout) next.ui.layout = input.ui.layout
    if (input.ui.theme?.file !== undefined) next.ui.theme_file = input.ui.theme.file
    if (input.ui.theme?.mode_colors) next.ui.mode_colors = mergeObject(next.ui.mode_colors, input.ui.theme.mode_colors)
    if (input.ui.status) next.ui.status = mergeObject(next.ui.status, input.ui.status)
    if (input.ui.review?.sort) next.review.sort = input.ui.review.sort
    if (input.ui.diff_preview?.default_lines) next.review.default_lines = Number(input.ui.diff_preview.default_lines)
    if (input.ui.diff_preview?.max_expand_lines) next.review.max_expand_lines = Number(input.ui.diff_preview.max_expand_lines)
  }

  if (input.agents && typeof input.agents === "object") {
    next.agent.subagents = mergeObject(next.agent.subagents, input.agents)
  }

  if (input.tools && typeof input.tools === "object") {
    next.permission.rules.push(...normalizePermissionRules(input.tools))
  }

  if (input.permission?.rules && Array.isArray(input.permission.rules)) {
    next.permission.rules.push(...input.permission.rules)
  }
  if (input.permission?.level) next.permission.level = input.permission.level
  if (input.permission?.mode) next.permission.mode = input.permission.mode
  if (input.permission?.default_policy) next.permission.default_policy = input.permission.default_policy
  if (input.permission?.non_tty_default) next.permission.non_tty_default = input.permission.non_tty_default

  return next
}
