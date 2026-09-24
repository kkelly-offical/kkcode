import { ProviderError } from '../core/errors.mjs'
import { validateModelId } from './model-id.mjs'
import { trimTrailingSlashes } from './url-path.mjs'

export const BUILTIN_PROVIDER_TYPES = Object.freeze(['openai', 'openai-responses', 'anthropic', 'openai-compatible', 'ollama', 'gateway'])

/** Shared inference-route resolution; model catalog support is unrelated to
 * whether an adapter can execute a request (notably native Ollama). */
export function resolveProviderRouteSettings(configState, providerType, overrides = {}, { registered = BUILTIN_PROVIDER_TYPES, onFallback = null } = {}) {
  const llm = configState.config.provider
  let resolvedType = providerType
  if (!registered.includes(providerType)) {
    const providerConfig = llm[providerType]
    if (providerConfig?.type && registered.includes(providerConfig.type)) resolvedType = providerConfig.type
    else {
      if (llm.strict_mode) throw new ProviderError(`unknown provider "${providerType}". registered: ${registered.join(', ')}`, { provider: providerType, reason: 'unknown_provider' })
      onFallback?.(providerType)
      resolvedType = 'openai'
    }
  }
  const defaults = llm[providerType] || llm[resolvedType] || {}
  if (defaults.type === 'openai-responses' && ['openai', 'openai-compatible', 'anthropic', 'ollama', 'gateway'].includes(resolvedType)) resolvedType = 'openai-responses'
  const protocol = resolvedType === 'openai-responses' ? 'responses' : defaults.protocol || (resolvedType === 'anthropic' ? 'anthropic' : resolvedType === 'ollama' ? 'ollama' : 'openai')
  if (protocol === 'responses' && ['openai', 'openai-compatible'].includes(resolvedType)) resolvedType = 'openai-responses'
  const dedicated = defaults.endpoints?.[protocol]
  let protocolBaseUrl = defaults.base_url
  if (dedicated) {
    try { protocolBaseUrl = trimTrailingSlashes(new URL(dedicated, defaults.base_url ? `${trimTrailingSlashes(String(defaults.base_url))}/` : undefined).toString()) }
    catch { protocolBaseUrl = dedicated }
  }
  const requestedModel = validateModelId(overrides.model || defaults.default_model || '', { label: `provider "${providerType}" model`, allowEmpty: true })
  const separator = requestedModel.indexOf('/'), prefix = separator > 0 ? requestedModel.slice(0, separator) : ''
  return { providerType: resolvedType, configKey: providerType, model: separator > 0 && [providerType, resolvedType].includes(prefix) ? requestedModel.slice(separator + 1) : requestedModel,
    baseUrl: overrides.baseUrl || protocolBaseUrl, apiKeyEnv: overrides.apiKeyEnv || defaults.api_key_env, apiKeyDirect: defaults.api_key || null, protocol }
}
