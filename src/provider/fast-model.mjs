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
  signal = null,
  timeoutMs = FAST_MODEL_TIMEOUT_MS,
  deps = {}
}) {
  const model = fastModelId(configState)
  if (!model) return null
  if (!String(prompt || "").trim()) return null

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
      providerType: providerType || configState?.config?.provider?.default,
      model,
      system,
      messages: [{ role: "user", content: String(prompt) }],
      tools: [],
      maxTokens,
      signal: controller.signal,
      audit: false
    })
    return String(result?.text || "").trim() || null
  } catch {
    // 辅助调用失败一律静默：它永远不该影响主流程
    return null
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener("abort", abortOnOuter)
  }
}
