import { createHash } from 'node:crypto'
import { object, text, integer, hash, oneOf, runStoreError } from './run-store-contracts.mjs'

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export const budgetProfileId = value => {
  const { id: _id, ...body } = value
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex')
}

/** Pure storage-side schema: no credentials, URLs, provider setup, file I/O or
 * pricing lookup can execute in the SQLite storage process. */
export function normalizeBudgetProfile(input) {
  object(input, ['version', 'id', 'provider', 'model', 'protocol', 'scopeHash', 'contextLimit', 'maxTokens', 'compaction', 'rates', 'source'], 'budgetProfile')
  if (input.version !== 1 || typeof input.compaction !== 'boolean') throw runStoreError('INVALID_BUDGET_PROFILE', 'Budget profiles require version 1 and an explicit compaction policy')
  object(input.rates, ['input', 'output', 'cacheRead', 'cacheWrite'], 'budgetProfile.rates')
  const rates = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(key => {
    const rate = input.rates[key]
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1_000_000) throw runStoreError('INVALID_BUDGET_PROFILE', 'Every pricing dimension needs an explicit finite nonnegative USD/token rate')
    return [key, rate]
  }))
  const profile = { version: 1, provider: text(input.provider, 'profile.provider', 200), model: text(input.model, 'profile.model', 256),
    protocol: oneOf(input.protocol, ['openai', 'anthropic', 'responses', 'ollama'], 'profile.protocol'), scopeHash: hash(input.scopeHash, 'profile.scopeHash'),
    contextLimit: integer(input.contextLimit, 'profile.contextLimit', 1, 10_000_000), maxTokens: integer(input.maxTokens, 'profile.maxTokens', 1, 1_000_000),
    compaction: input.compaction, rates, source: oneOf(input.source, ['manual', 'catalog', 'built-in'], 'profile.source') }
  const id = budgetProfileId(profile)
  if (hash(input.id, 'profile.id') !== id) throw runStoreError('INVALID_BUDGET_PROFILE', 'Budget profile ID does not match its frozen fields')
  return { ...profile, id }
}
