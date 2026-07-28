/**
 * 模型目录的获取与归一化。
 *
 * 三处共用：`/model` 命令、切换 provider 后的提示、以及启动时的静默预热
 * （`void loadProviderModelItems(...)`，让第一次开 `/model` 不用等网络）。
 *
 * 刻意**不抛异常**：目录不可用是常态（离线、密钥没配、接口不支持列模型），
 * 调用方要的是「拿到什么就显示什么」，而不是为一次可选的补全中断整个流程。
 * 错误以 `error` 字段返回，由调用方决定怎么说。
 */

import {
  discoverModelsForProvider,
  applyDiscoveredContextLimits,
  applyDiscoveredCapabilities
} from "../provider/model-catalog.mjs"
import { escapeTerminalText } from "../provider/model-id.mjs"
import { formatContext } from "../provider/wizard-form.mjs"
import { supportsThinking } from "../provider/thinking-effort.mjs"

/**
 * 这个模型支不支持扩展思考。三级判据，前者优先：
 *   1. 配置的 `provider.model_thinking`（/provider add 检测或用户补答的结论）
 *   2. 目录自报的 supported_parameters
 *   3. 模型名族启发式
 * 拿不准返回 null —— /model 的档位选择器把 null 当「让用户自己判断」处理。
 */
export function modelThinkingSupport({ config, model, supportedParameters = null }) {
  const configured = config?.provider?.model_thinking?.[model]
  if (typeof configured === "boolean") return configured
  return supportsThinking({ modelId: model, supportedParameters })
}

export async function loadProviderModelItems(configState, providerName, {
  refresh = false,
  discover = discoverModelsForProvider
} = {}) {
  try {
    const catalog = await discover(configState, { providerName, refresh })
    // 目录里带上下文长度的模型，顺手合并进内存里的 model_context ——
    // 上限与状态栏百分比从此不用人肉填（用户显式写过的键不覆盖）。
    applyDiscoveredContextLimits(configState, catalog.models || [])
    applyDiscoveredCapabilities(configState, providerName, catalog.models || [])
    const config = configState?.config || {}
    const seen = new Set()
    const items = []
    for (const entry of catalog.models || []) {
      const model = String(entry?.id || "").trim()
      if (!model || seen.has(model)) continue
      seen.add(model)
      // 上下文：目录报的优先，其次配置/发现累积的 model_context —— 这正是
      // 0.7.x 丢掉的那截（explorer 报告：「上下文刚被读出来，却没跟着进选择器」）
      const contextLength = Number(entry?.contextLength)
        || Number(config.provider?.model_context?.[model])
        || 0
      const thinking = modelThinkingSupport({
        config,
        model,
        supportedParameters: Array.isArray(entry?.supportedParameters) ? entry.supportedParameters : null
      })
      items.push({
        provider: providerName,
        model,
        contextLength,
        thinking,
        label: `${escapeTerminalText(providerName)} / ${escapeTerminalText(model)}`
          + (contextLength ? ` (${formatContext(contextLength)})` : "")
          + (thinking === true ? " · 思考" : "")
      })
    }
    return {
      items,
      source: catalog.source,
      stale: Boolean(catalog.stale),
      warning: catalog.warning || null,
      error: null
    }
  } catch (error) {
    return {
      items: [],
      source: null,
      stale: false,
      warning: null,
      error: error?.message || "model discovery failed"
    }
  }
}
