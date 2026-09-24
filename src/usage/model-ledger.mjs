import { AsyncLocalStorage } from 'node:async_hooks'
import { loadPricing, calculateCost } from './pricing.mjs'

const scopes = new AsyncLocalStorage()
const counters = ['input', 'output', 'cacheRead', 'cacheWrite']
export const emptyModelUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const normalize = usage => Object.fromEntries(counters.map(key => [key, Number.isSafeInteger(Number(usage?.[key])) && Number(usage[key]) >= 0 ? Number(usage[key]) : 0]))
const invalidUsage = usage => counters.some(key => usage?.[key] != null && (typeof usage[key] !== 'number' || !Number.isSafeInteger(usage[key]) || usage[key] < 0))
export const hasModelUsageScope = () => Boolean(scopes.getStore())

/** Internal receipt only: never attach model routing data to stable JSONL rows.
 * Streaming usage is cumulative, so replace the previous receipt for that
 * request rather than adding every intermediate frame. */
export function recordModelUsage({ requestId, provider, model, usage }) {
  const scope = scopes.getStore()
  if (!scope || !requestId || !usage) return
  scope.set(`${requestId}\0${provider}\0${model}`, { provider, model, usage: normalize(usage), estimated: invalidUsage(usage) })
}

export function addModelUsage(groups, provider, model, usage, estimated = false) {
  const key = JSON.stringify([provider || '', model || ''])
  const entry = groups.get(key) || { provider, model, usage: emptyModelUsage(), estimated: false }
  const delta = normalize(usage)
  for (const counter of counters) entry.usage[counter] += delta[counter]
  entry.estimated ||= estimated || invalidUsage(usage)
  groups.set(key, entry)
}

export async function collectModelUsage(run) {
  const scope = new Map()
  const result = await scopes.run(scope, run)
  const groups = new Map(), usage = emptyModelUsage()
  for (const entry of scope.values()) {
    addModelUsage(groups, entry.provider, entry.model, entry.usage, entry.estimated)
    for (const counter of counters) usage[counter] += entry.usage[counter]
  }
  return { result, groups: [...groups.values()], usage }
}

export async function priceModelUsage(configState, groups) {
  const total = { amount: 0, savings: 0, unknown: false, currency: 'USD', errors: [], items: [] }
  for (const entry of groups) {
    const info = await loadPricing(configState, { providerName: entry.provider, model: entry.model })
    const price = calculateCost(info.pricing, entry.model, entry.usage)
    total.amount += price.amount; total.savings += price.savings; total.unknown ||= price.unknown || entry.estimated === true
    total.errors.push(...info.errors)
    if (entry.estimated) total.errors.push('Provider usage contained invalid or non-numeric counters; cost is an estimate, not a billing receipt')
    total.items.push({ provider: entry.provider, model: entry.model, usage: { ...entry.usage }, amount: price.amount, estimated: price.unknown || entry.estimated === true })
  }
  total.errors = [...new Set(total.errors)]
  return total
}
