/** Normalize declared metadata only. Missing values stay unknown; this module
 * neither discovers models nor infers limits from a model's generated text. */
const numeric = value => typeof value === 'number' || typeof value === 'string' && value.trim() !== ''
const positive = (...values) => values.filter(numeric).map(Number).find(n => Number.isSafeInteger(n) && n > 0) || null
const number = value => numeric(value) && Number.isFinite(Number(value)) ? Number(value) : null
const supported = value => typeof value === 'boolean' ? value : typeof value?.supported === 'boolean' ? value.supported : null
const names = value => Array.isArray(value) ? [...new Set(value.filter(v => typeof v === 'string' && /^[a-z][a-z0-9_-]{0,39}$/i.test(v)).map(v => v.toLowerCase()))].slice(0, 32) : null
export const EFFORT_ORDER = ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function parseModelParameters(item = {}) {
  const old = item.modelParameters || {}
  const limits = {
    inputOnly: old.limits?.inputOnly === true || item.inputTokenLimit != null || item.context_includes_output === false,
    context: positive(old.limits?.context, item.context_length, item.contextLength, item.context_window, item.contextWindow, item.max_context_window_tokens, item.max_context_length),
    input: positive(old.limits?.input, item.max_input_tokens, item.input_token_limit, item.inputTokenLimit),
    output: positive(old.limits?.output, item.max_output_tokens, item.maxOutputTokens, item.max_completion_tokens, item.output_token_limit, item.outputTokenLimit, item.top_provider?.max_completion_tokens,
      // Anthropic's Models API uses max_tokens for the output ceiling.
      item.max_input_tokens != null || item.capabilities?.thinking ? item.max_tokens : null)
  }
  const cap = item.capabilities || {}, thinking = cap.thinking || {}, effort = cap.effort || {}
  const rawLevels = old.reasoning?.levels ?? item.reasoning_effort_levels ?? item.supported_reasoning_efforts ?? item.reasoning?.effort_levels ?? item.parameters?.reasoning_effort?.enum
  const explicitLevels = names(rawLevels)
  const effortKeys = Object.entries(effort).filter(([key, value]) => key !== 'supported' && supported(value) === true).map(([key]) => key)
  let levels = explicitLevels ?? (effortKeys.length ? names(effortKeys) : null)
  const nativeLevels = Object.fromEntries((Array.isArray(rawLevels) ? rawLevels : effortKeys).filter(value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/i.test(value)).map(value => [value.toLowerCase(), /^[a-z][a-z0-9_-]{0,39}$/i.test(old.reasoning?.nativeLevels?.[value.toLowerCase()] || '') ? old.reasoning.nativeLevels[value.toLowerCase()] : value]))
  if (levels?.every(level => EFFORT_ORDER.includes(level))) levels.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))
  const types = names(old.reasoning?.types) ?? (thinking.types ? names(Object.entries(thinking.types).filter(([,v]) => supported(v) === true).map(([k]) => k)) : null)
  const defaultLevel = old.reasoning?.defaultLevel ?? item.default_reasoning_effort ?? item.default_parameters?.reasoning_effort ?? item.reasoning?.default_effort
  const rawParams = item.supported_parameters ?? item.supportedParameters
  const params = names(rawParams)
  const toggleParameter = old.reasoning?.toggleParameter ?? item.thinking_parameter ??
    (item.parameters?.enable_thinking?.type === 'boolean' ? 'enable_thinking' : item.parameters?.chat_template_kwargs?.properties?.enable_thinking?.type === 'boolean' ? 'chat_template_kwargs.enable_thinking' : null)
  const reasoning = {
    toggleParameter: ['enable_thinking','chat_template_kwargs.enable_thinking'].includes(toggleParameter) ? toggleParameter : null,
    supported: supported(old.reasoning?.supported) ?? supported(cap.reasoning) ?? supported(thinking) ?? supported(item.thinking) ?? (levels?.length ? true : null),
    levels, nativeLevels, types,
    defaultLevel: typeof defaultLevel === 'string' && /^[a-z][a-z0-9_-]{0,39}$/i.test(defaultLevel) ? defaultLevel.toLowerCase() : null,
    switchable: supported(old.reasoning?.switchable) ?? supported(item.reasoning?.switchable) ?? (toggleParameter || levels?.some(x => ['none','off'].includes(x)) || types?.includes('disabled') ? true : null),
    alwaysOn: supported(old.reasoning?.alwaysOn) ?? supported(item.reasoning?.always_on),
    minBudget: positive(old.reasoning?.minBudget, thinking.min_budget_tokens, item.thinking_min_tokens),
    maxBudget: positive(old.reasoning?.maxBudget, thinking.max_budget_tokens, item.thinking_max_tokens)
  }
  const sampling = {}
  for (const [key, rawKey, maxKey] of [['temperature','temperature','maxTemperature'], ['topP','topP','maxTopP'], ['topK','topK','maxTopK']]) {
    const raw = old.sampling?.[key] || {}, spec = item.parameters?.[rawKey] || {}
    const value = number(raw.default ?? item[rawKey] ?? item.default_parameters?.[rawKey] ?? spec.default)
    const min = number(raw.min ?? spec.minimum), max = number(raw.max ?? item[maxKey] ?? spec.maximum)
    const advertised = supported(raw.supported) ?? (params ? params.includes(key === 'topP' ? 'top_p' : key === 'topK' ? 'top_k' : key) : null)
    if (value != null || min != null || max != null || advertised != null) sampling[key] = { default: value, min, max, supported: advertised }
  }
  const outputParameter = old.outputParameter ?? item.output_parameter ?? (params?.includes('max_completion_tokens') ? 'max_completion_tokens' : params?.includes('max_tokens') ? 'max_tokens' : null)
  return { limits, reasoning, sampling,
    ...(params ? { supportedParameters: params } : {}),
    ...(['max_tokens','max_completion_tokens','max_output_tokens'].includes(outputParameter) ? { outputParameter } : {}) }
}
