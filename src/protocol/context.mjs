/** Public projection: never include prompts, tool arguments or credentials. */
export function publicContext(value) {
  if (!value || !Number.isFinite(value.tokens) || value.tokens < 0 || !Number.isFinite(value.limit) || value.limit <= 0) return null
  const result = { tokens: Math.ceil(value.tokens), limit: Math.ceil(value.limit), percent: Math.min(100, Math.max(0, Math.round(value.tokens * 100 / value.limit))) }
  for (const key of ['outputReserved', 'inputBudget', 'requiredTokens', 'updatedAt']) if (Number.isFinite(value[key]) && value[key] >= 0) result[key] = Math.ceil(value[key])
  result.source = ['count-api', 'provider-usage'].includes(value.source) ? value.source : 'estimated'
  result.estimated = result.source === 'estimated'
  result.components = {}
  for (const key of ['system', 'tools', 'messages']) if (Number.isFinite(value.components?.[key]) && value.components[key] >= 0) result.components[key] = Math.ceil(value.components[key])
  return result
}
