import { cachedModelMetadata, modelMetadataScope } from './model-catalog.mjs'

const integer = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0
const bounded = (a, b) => a && b ? Math.min(a, b) : a || b

// Legacy context knowledge remains a labelled fallback, never endpoint proof.
const BUILTIN_CONTEXT = {
  'k3-256k': 262144, k3: 1048576, 'kimi-for-coding': 262144, kimi: 262144,
  'gpt-5': 400000, o3: 200000, o1: 200000, claude: 200000,
  'gemini-2': 1048576, 'gemini-1.5': 1048576, gemini: 128000,
  'gpt-4o': 128000, 'gpt-4': 128000, 'gpt-3.5': 16000,
  'deepseek-r': 128000, deepseek: 64000, qwen3: 262144, qwen: 128000, glm: 128000
}

export function resolveModelLimits({ model = '', configState = null, providerType = '', baseUrl = null, apiKeyEnv = null } = {}) {
  const providers = configState?.config?.provider || {}, provider = providerType || providers.default
  const settings = providers[provider] || {}, id = String(model || '').toLowerCase()
  const cached = cachedModelMetadata(configState, provider, model, { baseUrl, apiKeyEnv })
  const metadata = cached?.model?.modelParameters || {}, declared = metadata.limits || {}
  const overrides = providers.model_context || {}
  const key = Object.keys(overrides).sort((a,b) => b.length - a.length).find(k => id.startsWith(k.toLowerCase()))
  const configuredContext = integer(overrides[model]) || integer(overrides[key]) || integer(settings.context_limit)
  const fallbackContext = Object.entries(BUILTIN_CONTEXT).find(([prefix]) => id.includes(prefix))?.[1] || 128000
  // Gemini-style inputTokenLimit is an input ceiling. Anthropic's
  // max_input_tokens describes its shared context window, including output.
  const inputOnly = declared.inputOnly === true && !configuredContext && !declared.context
  const apiContext = integer(declared.context) || integer(declared.input)
  const limit = bounded(configuredContext, apiContext) || fallbackContext
  const outputCap = bounded(integer(settings.max_output_tokens), integer(declared.output))
  const requested = integer(settings.max_tokens) || outputCap || Math.max(1, Math.floor(limit / 5))
  const outputReserved = Math.min(requested, outputCap || requested, inputOnly ? requested : Math.max(1, limit - 1))
  const inputBudget = Math.max(1, Math.min(inputOnly ? limit : limit - outputReserved, integer(declared.input) || Infinity))
  return { limit, outputReserved, inputBudget, windowKind: inputOnly ? 'input' : 'shared',
    routeScope:modelMetadataScope(configState,provider,{baseUrl,apiKeyEnv}),
    declaredOutput: integer(declared.output) || null,
    contextSource: configuredContext ? 'configuration' : apiContext ? 'catalog' : 'fallback',
    outputSource: integer(settings.max_tokens) || integer(settings.max_output_tokens) ? 'configuration' : outputCap ? 'catalog' : 'estimated',
    catalogStale: cached?.stale ?? false, fetchedAt: cached?.fetchedAt ?? null, metadata }
}

export function modelContextLimit(model, configState = null, providerType = '', overrides = {}) {
  return resolveModelLimits({ model, configState, providerType, ...overrides }).limit
}
