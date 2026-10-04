import { resolveModelLimits } from './model-limits.mjs'
import { thinkingControl, mapThinkingRequest } from './thinking-control.mjs'
import { ProviderError } from '../core/errors.mjs'

export function modelRuntimeProfile(configState, settings) {
  const provider = configState.config.provider[settings.configKey] || {}
  const limits = resolveModelLimits({ model: settings.model, providerType: settings.configKey, configState, baseUrl: settings.baseUrl, apiKeyEnv: settings.apiKeyEnv })
  return { context: { limit: limits.limit, inputBudget: limits.inputBudget, kind: limits.windowKind, source: limits.contextSource },
    output: { reserved: limits.outputReserved, declaredLimit: limits.declaredOutput, source: limits.outputSource },
    catalog: { fetchedAt: limits.fetchedAt, stale: limits.catalogStale },
    thinking: thinkingControl({ model: settings.model, protocol: settings.protocol, metadata: limits.metadata, settings: provider, maxTokens: limits.outputReserved }) }
}

export function runtimeParameters(configState, settings, { maxTokens = null, temperature = null } = {}) {
  const provider = configState.config.provider[settings.configKey] || {}
  const limits = resolveModelLimits({ model: settings.model, providerType: settings.configKey, configState, baseUrl: settings.baseUrl, apiKeyEnv: settings.apiKeyEnv })
  const output = Math.min(maxTokens > 0 ? maxTokens : limits.outputReserved, limits.declaredOutput || Infinity, Number(provider.max_output_tokens) || Infinity)
  const control = thinkingControl({ model: settings.model, protocol: settings.protocol, metadata: limits.metadata, settings: provider, maxTokens: output })
  const params = /** @type {Record<string, any>} */ ({ maxTokens: output, ...mapThinkingRequest({ control, protocol: settings.protocol, settings: provider.model_options?.[settings.model] ? {...provider, thinking:null} : provider, maxTokens: output }) })
  const sampling = limits.metadata.sampling || {}
  for (const [name, configured] of [['temperature', temperature ?? provider.temperature], ['topP', provider.top_p], ['topK', provider.top_k]]) {
    if (configured == null) continue
    const value = Number(configured), range = sampling[name]
    if (!Number.isFinite(value) || range?.supported === false || range?.min != null && value < range.min || range?.max != null && value > range.max) {
      throw new ProviderError(`模型不支持所设置的 ${name} 参数值。`, { reason: 'invalid_sampling_parameter' })
    }
    if (name === 'topK' && settings.protocol !== 'anthropic') throw new ProviderError('当前协议适配器不支持 top_k 设置。', {reason:'invalid_sampling_parameter'})
    params[name] = value
  }
  const outputParameter = provider.output_parameter || limits.metadata.outputParameter ||
    (settings.protocol === 'openai' && /^(?:o[134](?:-|$)|gpt-5(?:-|$))/.test(settings.model) ? 'max_completion_tokens' : null)
  if (outputParameter) params.outputParameter = outputParameter
  return { params, limits, thinking: control }
}
