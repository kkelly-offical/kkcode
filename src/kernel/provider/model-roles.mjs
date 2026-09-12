import { noteDeprecation } from "../core/deprecations.mjs"

/**
 * 模型角色解析。
 *
 * 0.3.x 有 5 套互不相通的模型覆盖机制（four_stage.separate_models、
 * hybrid.separate_models、adaptive_models、degradation.fallback_model、
 * subagents.<n>.model），默认全关全 null，且没有任何一条能表达「便宜的
 * 小模型」。0.4.0 收敛为顶层三键：
 *
 *   models:
 *     main:     主对话模型，缺省回退 provider.<default>.default_model
 *     fast:     廉价小模型，用于输入框预测、标题、压缩等辅助调用
 *     subagent: 子智能体模型，缺省 = main
 *
 * agent.subagents.<n>.model 保留，它是按子智能体名字的细粒度覆盖，
 * 与角色维度不冲突。
 */

export const MODEL_ROLES = Object.freeze(["main", "fast", "subagent"])

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

/** 从旧的分阶段/降级配置里捞出一个可用值，同时提示弃用。 */
function legacyFastModel(config) {
  const hybrid = config?.agent?.longagent?.hybrid || {}
  const fallback = firstString(
    hybrid.degradation?.fallback_model,
    hybrid.adaptive_models?.low
  )
  if (fallback) {
    noteDeprecation(
      "config.models.fast.legacy",
      "`hybrid.degradation.fallback_model` / `adaptive_models.low` 已由 `models.fast` 取代"
    )
  }
  return fallback
}

function legacyMainModel(config) {
  const hybrid = config?.agent?.longagent?.hybrid || {}
  const main = firstString(hybrid.adaptive_models?.high, hybrid.separate_models?.blueprint_model)
  if (main) {
    noteDeprecation(
      "config.models.main.legacy",
      "`hybrid.separate_models` / `adaptive_models` 已由 `models.main` 取代"
    )
  }
  return main
}

export function providerDefaultModel(config, providerType = "") {
  const providers = config?.provider || {}
  const name = providerType || providers.default
  return firstString(providers[name]?.default_model, providers[providers.default]?.default_model)
}

/**
 * 解析某个角色应使用的模型 id。
 * @returns {string} 空字符串表示未配置（调用方据此决定是否降级或关闭功能）
 */
export function resolveRoleModel(config, role, { providerType = "", fallbackToMain = true } = {}) {
  const models = config?.models || {}
  const main = firstString(models.main, legacyMainModel(config), providerDefaultModel(config, providerType))

  if (role === "main") return main
  if (role === "fast") {
    // fast 刻意不回退到 main：没配就该关掉功能，而不是拿主模型烧钱
    return firstString(models.fast, legacyFastModel(config))
  }
  if (role === "subagent") {
    const subagent = firstString(models.subagent)
    return subagent || (fallbackToMain ? main : "")
  }
  return main
}

/** models.fast 是否可用——ghost text 之类的可选功能据此开关。 */
export function hasFastModel(config) {
  return Boolean(resolveRoleModel(config, "fast"))
}
