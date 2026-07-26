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
    const seen = new Set()
    const items = []
    for (const entry of catalog.models || []) {
      const model = String(entry?.id || "").trim()
      if (!model || seen.has(model)) continue
      seen.add(model)
      items.push({
        provider: providerName,
        model,
        label: `${escapeTerminalText(providerName)} / ${escapeTerminalText(model)}`
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
