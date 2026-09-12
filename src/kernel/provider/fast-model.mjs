import { requestProvider } from "./router.mjs"
import { resolveRoleModel } from "./model-roles.mjs"

/**
 * 廉价小模型通道。
 *
 * 用于输入框下一句预测、会话标题这类高频、低价值、可失败的辅助调用。
 * 与主对话调用的三点区别：
 *   - 只走非流式：maxTokens 仅在非流式路径生效（router.mjs 的流式版本
 *     根本不接受这个参数），预测必须能被严格限长
 *   - 旁路审计：否则每次按键停顿都会往 kk.audit.v1 里写一条 provider.request
 *   - 不记账：辅助调用不计入 usage/成本统计
 *
 * models.fast 未配置时返回 null，调用方据此关闭对应功能，绝不静默回退到
 * 主模型——那会让用户拿最贵的模型做补全。
 */

export const FAST_MODEL_TIMEOUT_MS = 4000

/**
 * 连续多少次「请求成功但正文为空」判定该模型不适合当 fast 模型。
 *
 * thinking-only 的模型（kimi 的 coding 系列、各家的 reasoning 模型）会把
 * 32–48 token 的预算全花在思考上，正文恒为空。没有这个断路器时，ghost text
 * 会在每次打字停顿后继续发请求 —— 用户看不到任何东西，调用又刻意不进审计
 * 与成本统计，于是变成一条完全无声的烧钱通道。
 */
const FAST_EMPTY_STRIKES = 3

/** key = `${providerType}/${model}` → { emptyStreak, reasoningSeen, disabled } */
const fastHealth = new Map()

function healthKey(providerType, model) {
  return `${providerType || "default"}/${model}`
}

/**
 * fast 通道的运行时健康状态，供 preflight / doctor 展示。
 * @returns {Array<{model, reason}>} 已被停用的 fast 模型
 */
export function fastModelIssues() {
  const issues = []
  for (const [key, state] of fastHealth) {
    if (!state.disabled) continue
    issues.push({
      model: key,
      reason: state.reasoningSeen
        ? "只输出思考内容、正文为空（thinking-only 模型不适合 fast 通道）"
        : "连续多次返回空正文"
    })
  }
  return issues
}

/** 测试与 `/provider` 切换后重置断路器。 */
export function resetFastModelHealth() {
  fastHealth.clear()
}

export function fastModelId(configState) {
  return resolveRoleModel(configState?.config, "fast")
}

export function isFastModelConfigured(configState) {
  return Boolean(fastModelId(configState))
}

export async function requestFast({
  configState,
  prompt,
  system = "",
  maxTokens = 48,
  providerType = null,
  // 调用方可覆盖模型（如 models.ultra.report）；同样支持 provider/model 限定
  model: modelOverride = null,
  signal = null,
  timeoutMs = FAST_MODEL_TIMEOUT_MS,
  deps = {}
}) {
  let model = modelOverride || fastModelId(configState)
  if (!model) return null
  if (!String(prompt || "").trim()) return null

  // fast 模型支持 "provider/model" 跨渠道限定：快模型经常不在主渠道上
  // （例如主渠道是 kimi —— 其 coding 模型全是 thinking-only，小 token 预算下
  // 正文为空 —— 而便宜的即答模型在 qwen 渠道）。前缀命中已配置的 provider
  // 才拆分，否则按字面模型名走默认渠道。
  let resolvedProviderType = providerType
  const slash = model.indexOf("/")
  if (slash > 0) {
    const prefix = model.slice(0, slash)
    if (configState?.config?.provider?.[prefix]) {
      resolvedProviderType = prefix
      model = model.slice(slash + 1)
    }
  }

  const key = healthKey(resolvedProviderType || configState?.config?.provider?.default, model)
  const health = fastHealth.get(key)
  // 已判定不可用的模型直接短路：不再发请求，也就不再无声烧钱
  if (health?.disabled) return null

  const request = deps.requestProvider || requestProvider
  const controller = new AbortController()
  const abortOnOuter = () => controller.abort()
  if (signal) {
    if (signal.aborted) return null
    signal.addEventListener("abort", abortOnOuter, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || FAST_MODEL_TIMEOUT_MS))

  try {
    const result = await request({
      configState,
      providerType: resolvedProviderType || configState?.config?.provider?.default,
      model,
      system,
      messages: [{ role: "user", content: String(prompt) }],
      tools: [],
      maxTokens,
      signal: controller.signal,
      audit: false
    })
    const text = String(result?.text || "").trim()
    if (text) {
      fastHealth.delete(key)
      return text
    }

    // 请求成功但没有正文。累计到阈值就停用这个模型 —— 区别于 catch 分支的
    // 网络失败：那是暂时的，这是模型本身产不出可用输出。
    const state = fastHealth.get(key) || { emptyStreak: 0, reasoningSeen: false, disabled: false }
    state.emptyStreak += 1
    if (String(result?.reasoning || "").trim()) state.reasoningSeen = true
    if (state.emptyStreak >= FAST_EMPTY_STRIKES) state.disabled = true
    fastHealth.set(key, state)
    return null
  } catch {
    // 网络/超时/取消一律静默且不计入断路器：它永远不该影响主流程
    return null
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener("abort", abortOnOuter)
  }
}
