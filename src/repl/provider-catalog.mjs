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
  applyDiscoveredCapabilities,
  escapeTerminalText,
  formatContext,
  supportsThinking,
  normalizeCapabilities,
  parseCatalogEntryCapabilities,
  inferCapabilitiesFromName
} from "../kernel/index.mjs"

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

/**
 * 能力标记（M33 探测面 `resolveModelCapabilities` 的返回值）→ 附件门的决断。
 *
 * 三级语义：true 支持 / false 不支持 / null 未知。未知时 image 放行
 * （既有行为，内核还会按字节嗅探兜底），video/audio 按未知处理 ——
 * 调用方据此拒绝未知音视频并提示发现/配置能力，不插入虚假的成功标记。
 */
export function mediaSupportFromCapabilities(capabilities, kind) {
  const value = capabilities?.[kind]
  if (typeof value === "boolean") return value
  return kind === "image" ? true : null
}

export function modelCapabilityBadges(entry, config = {}, protocol = 'openai') {
  const id = String(entry?.id || '')
  const discovered = parseCatalogEntryCapabilities(entry) || {}
  const configured = normalizeCapabilities(config.provider?.model_capabilities?.[id])
  const heuristic = inferCapabilitiesFromName(id)
  const capabilities = { ...heuristic, ...discovered, ...configured }
  const sources = Object.fromEntries(Object.keys(capabilities).map(key => [key, key in configured ? 'config' : key in discovered ? 'discovered' : 'heuristic']))
  if (protocol !== 'openai') for (const key of ['audio', 'video']) { capabilities[key] = false; sources[key] = 'protocol' }
  const labels = { image: '图像', audio: '音频', video: '视频', tools: '工具', streaming: '流式' }
  const badges = Object.entries(labels).filter(([key]) => capabilities[key] === true)
    .map(([key, label]) => `${label}${sources[key] === 'heuristic' ? '?' : ''}`)
  if (capabilities.tools === false) badges.push('无工具')
  if (capabilities.streaming === false) badges.push('非流式')
  return { capabilities, capabilitySources: sources, badges }
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
      const provider = config.provider?.[providerName] || {}
      const protocol = catalog.protocol || provider.protocol || (['anthropic', 'ollama'].includes(provider.type) ? provider.type : 'openai')
      const capabilityInfo = modelCapabilityBadges(entry, config, protocol)
      items.push({
        provider: providerName,
        model,
        contextLength,
        thinking,
        ...capabilityInfo,
        pricing: entry.pricing || null,
        origin: entry.origin || (catalog.source === 'config' ? 'manual' : 'auto'),
        stale: Boolean(catalog.stale),
        label: `${escapeTerminalText(providerName)} / ${escapeTerminalText(model)}`
          + (contextLength ? ` (${formatContext(contextLength)})` : "")
          + (thinking === true ? " · 思考" : "")
          + (capabilityInfo.badges.length ? ` · ${capabilityInfo.badges.join(' / ')}` : '')
          + (catalog.stale ? ' · 缓存过期' : '')
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
