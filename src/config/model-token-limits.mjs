import { PROVIDER_META_KEYS } from './schema.mjs'

const object = value => value && typeof value === 'object' && !Array.isArray(value)
const LIMIT_KEYS = ['context_limit', 'max_tokens', 'max_output_tokens']

// File configuration stores connection details and user preferences. Numeric
// model limits belong to the route-scoped catalog and runtime calculation.
// Explicit SDK request limits and frozen host budgets are separate contracts.
export function withoutModelTokenLimits(config) {
  const next = structuredClone(config)
  if (!object(next?.provider)) return next
  delete next.provider.model_context
  for (const [name, settings] of Object.entries(next.provider)) {
    if (PROVIDER_META_KEYS.includes(name) || !object(settings)) continue
    for (const key of LIMIT_KEYS) delete settings[key]
    if (object(settings.thinking)) delete settings.thinking.budget_tokens
  }
  return next
}

export function isModelTokenLimitPath(key) {
  const parts = key.split('.')
  return parts[0] === 'provider' && (parts[1] === 'model_context'
    || parts.length === 3 && LIMIT_KEYS.includes(parts[2])
    || parts.length === 4 && parts[2] === 'thinking' && parts[3] === 'budget_tokens')
}
