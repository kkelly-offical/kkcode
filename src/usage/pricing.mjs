import path from "node:path"
import { access, readFile } from "node:fs/promises"
import YAML from "yaml"
import { readCachedModelCatalog, resolveProviderConnection } from '../kernel/provider/model-catalog.mjs'
import { parseCatalogEntryPricing } from '../kernel/provider/model-capabilities.mjs'

const DEFAULT_PRICING = {
  currency: "USD",
  per_tokens: 1000000,
  models: {
    // Claude 5 家族。cache_read = 0.1×input，cache_write = 1.25×input（5 分钟 TTL）。
    "claude-fable-5": { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
    "claude-opus-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    // Sonnet 5 的挂牌价是 3/15；2026-08-31 前有 2/10 的introductory 价。
    // 这里记挂牌价 —— 优惠会过期，而成本高估比低估安全。
    "claude-sonnet-5": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    "claude-opus-4-8": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-6": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-7": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-1": { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
    "claude-opus-4": { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
    "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    "claude-sonnet-4-5": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    "claude-sonnet-4": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
    "claude-haiku-3-5": { input: 0.8, output: 4, cache_read: 0.08, cache_write: 1 },
    "gpt-5.6-sol": { input: 5, output: 30, cache_read: 0.5, cache_write: 5 },
    "gpt-5.6-terra": { input: 2, output: 12, cache_read: 0.2, cache_write: 2 },
    "gpt-5.6-luna": { input: 0.2, output: 1.2, cache_read: 0.02, cache_write: 0.2 },
    // 曾经记成 15/60 —— 高了 8.6 倍。2026-08-06 对着官方定价页核过。
    "gpt-5.3-codex": { input: 1.75, output: 14, cache_read: 0.175, cache_write: 1.75 },
    "gpt-5.5": { input: 5, output: 30, cache_read: 0.5, cache_write: 5 },
    "gpt-5.4": { input: 2.5, output: 15, cache_read: 1.25, cache_write: 2.5 },
    "gpt-5.4-mini": { input: 0.75, output: 4.5, cache_read: 0.375, cache_write: 0.75 },
    "gpt-4o": { input: 2.5, output: 10, cache_read: 1.25, cache_write: 2.5 },
    "gpt-4o-mini": { input: 0.15, output: 0.6, cache_read: 0.075, cache_write: 0.15 },
    "deepseek-chat": { input: 0.27, output: 1.1, cache_read: 0.07, cache_write: 0.27 },
    "deepseek-coder": { input: 0.27, output: 1.1, cache_read: 0.07, cache_write: 0.27 },
    "deepseek-v3.1-terminus": { input: 0.55, output: 1.65, cache_read: 0.07, cache_write: 0.55 },
    "deepseek-v3.2": { input: 0.28, output: 0.41, cache_read: 0.03, cache_write: 0.28 },
    "deepseek-v4-flash": { input: 0.14, output: 0.28, cache_read: 0.0028, cache_write: 0.14 },
    "deepseek-v4-pro": { input: 0.435, output: 0.87, cache_read: 0.003625, cache_write: 0.435 },
    "gemini-3.6-flash": { input: 1.5, output: 7.5, cache_read: 0.15, cache_write: 1.5 },
    "gemini-3.5-flash": { input: 1.5, output: 9, cache_read: 0.15, cache_write: 1.5 },
    "gemini-3.1-pro": { input: 2, output: 12, cache_read: 0.2, cache_write: 2 },
    "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cache_read: 0.025, cache_write: 0.25 },
    "kimi-k2.5": { input: 0.55, output: 2.9, cache_read: 0, cache_write: 0 },
    "kimi-k2.6": { input: 0.55, output: 2.9, cache_read: 0, cache_write: 0 },
    "kimi-k2-0905": { input: 0.55, output: 2.2, cache_read: 0.14, cache_write: 0 },
    "qwen-plus": { input: 0.11, output: 1.11, cache_read: 0.02, cache_write: 0 },
    "qwen3.5-plus": { input: 0.115, output: 0.688, cache_read: 0.02, cache_write: 0 },
    "qwen3.5-flash": { input: 0.029, output: 0.287, cache_read: 0.01, cache_write: 0 },
    "qwen-max": { input: 0.33, output: 1.33, cache_read: 0.07, cache_write: 0 },
    "qwen-turbo": { input: 0.04, output: 0.08, cache_read: 0.01, cache_write: 0 },
    "qwen3-coder-plus": { input: 0.55, output: 2.2, cache_read: 0.11, cache_write: 0 },
    "qwen3-coder-flash": { input: 0.14, output: 0.55, cache_read: 0.03, cache_write: 0 },
    "qwen3-coder-480b-a35b": { input: 0.83, output: 3.3, cache_read: 0.17, cache_write: 0 },
    "doubao-seed-2.0-code": { input: 0.44, output: 2.2, cache_read: 0, cache_write: 0 },
    "doubao-seed-2.0-pro": { input: 0.44, output: 2.2, cache_read: 0, cache_write: 0 },
    "doubao-seed-1.8": { input: 0.11, output: 1.1, cache_read: 0, cache_write: 0 },
    "doubao-seed-code": { input: 0.17, output: 1.1, cache_read: 0, cache_write: 0 },
    "minimax-m2.5": { input: 0.29, output: 1.16, cache_read: 0.03, cache_write: 0 },
    "minimax-m2.5-highspeed": { input: 0.58, output: 2.32, cache_read: 0.03, cache_write: 0 },
    "minimax-m2.1": { input: 0.29, output: 1.16, cache_read: 0.03, cache_write: 0 },
    "minimax-m2": { input: 0.29, output: 1.16, cache_read: 0.03, cache_write: 0 },
    "glm-5": { input: 0.55, output: 3.05, cache_read: 0, cache_write: 0 },
    "glm-5.1": { input: 0.55, output: 3.05, cache_read: 0, cache_write: 0 },
    "glm-4.7": { input: 0.41, output: 1.93, cache_read: 0, cache_write: 0 },
    "glm-4.6": { input: 0.28, output: 1.1, cache_read: 0, cache_write: 0 },
    "grok-4.5": { input: 2, output: 6, cache_read: 0, cache_write: 0 },
    "grok-4.3": { input: 1.25, output: 2.5, cache_read: 0, cache_write: 0 }
  },
  default: {
    input: 3,
    output: 15,
    cache_read: 0.3,
    cache_write: 3.75
  }
}

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function parse(file, raw) {
  if (file.endsWith(".json")) return JSON.parse(raw)
  return YAML.parse(raw)
}

function resolvePricingPath(configState) {
  const projectPath = configState?.source?.projectRaw?.usage?.pricing_file
  if (typeof projectPath === "string" && projectPath.trim()) {
    return path.resolve(configState.source.projectDir ?? process.cwd(), projectPath)
  }
  const userPath = configState?.source?.userRaw?.usage?.pricing_file
  if (typeof userPath === "string" && userPath.trim()) {
    return path.resolve(configState.source.userDir ?? process.cwd(), userPath)
  }
  return null
}

export async function loadPricing(configState, { providerName = configState?.config?.provider?.default, model = '', now = Date.now(), skipCatalog = false } = {}) {
  const file = resolvePricingPath(configState)
  let pricing = DEFAULT_PRICING, source = 'default', manual = null
  const errors = []
  if (file) try {
    if (!(await exists(file))) throw new Error('pricing file does not exist')
    manual = parse(file, await readFile(file, 'utf8'))
    if (!manual || typeof manual !== 'object' || Array.isArray(manual)) throw new Error('expected a pricing object')
    if (manual.currency && manual.currency !== 'USD') throw new Error('cost/budget accounting requires USD; no currency conversion is implied')
    if (manual.per_tokens != null && (!Number.isFinite(manual.per_tokens) || manual.per_tokens <= 0)) throw new Error('per_tokens must be positive')
    for (const entry of [...Object.values(manual.models || {}), ...(manual.default ? [manual.default] : [])]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('model prices must be objects')
      for (const key of ['input', 'output', 'cache_read', 'cache_write']) {
        if (entry[key] !== undefined && (!Number.isFinite(entry[key]) || entry[key] < 0)) throw new Error('rates must be finite non-negative numbers')
      }
    }
    const factor = (manual.per_tokens || 1000000) / 1000000
    const scale = entry => Object.fromEntries(Object.entries(entry).map(([key, rate]) => [key, rate * factor]))
    const fallback = { ...scale(DEFAULT_PRICING.default), ...(manual.default || {}) }
    const defaults = Object.fromEntries(Object.entries(DEFAULT_PRICING.models).map(([key, entry]) => [key, scale(entry)]))
    const overrides = Object.fromEntries(Object.entries(manual.models || {}).map(([key, entry]) => [key, { ...(defaults[key] || fallback), ...entry }]))
    pricing = {
      ...DEFAULT_PRICING,
      ...manual,
      models: { ...defaults, ...overrides },
      default: fallback
    }
    source = file
  } catch (error) {
    manual = null; errors.push(`${file}: ${error.message}`)
  }
  // Explicit file overrides win. Catalog lookups are provider/URL/credential
  // scoped and never cause inference to fetch a model directory over HTTP.
  if (!skipCatalog && model && !manual?.default && !findPricingEntry(manual?.models || {}, model)) {
    const cached = await readCachedModelCatalog(configState, providerName)
    const rates = parseCatalogEntryPricing(cached?.models?.find(entry => entry.id === model))
    if (rates && rates.currency !== 'USD') errors.push(`Discovered ${rates.currency} prices are not used for USD budgets`)
    else if (rates) {
      const ttl = resolveProviderConnection(configState, providerName).discovery.cacheTtlMs
      const stale = now - cached.fetchedAt > ttl
      const factor = (pricing.per_tokens || 1000000) / 1000000
      const entry = { input: rates.input * factor, output: rates.output * factor,
        cache_read: (rates.cache_read ?? rates.input) * factor,
        cache_write: (rates.cache_write ?? rates.input) * factor,
        estimated: stale, cache_read_estimated: rates.cache_read == null, cache_write_estimated: rates.cache_write == null }
      pricing = { ...pricing, models: { ...pricing.models, [model]: entry } }
      source = stale ? 'catalog-stale' : 'catalog'
      if (stale) errors.push('Model catalog pricing is stale; refresh /model before relying on this estimate')
    }
  }
  // Ordinary estimates retain partial-file override compatibility. A strict
  // financial reservation must not mistake inherited fallback cache rates for
  // complete user-supplied pricing for a custom model.
  const declared = findPricingEntry(manual?.models || {}, model) || manual?.default
  const strictPriceComplete = !declared || ['input', 'output', 'cache_read', 'cache_write'].every(key => Number.isFinite(declared[key]) && declared[key] >= 0)
  return { pricing: errors.length ? { ...pricing, estimated: true } : pricing, source, errors, strictPriceComplete, strictModelExact: Object.hasOwn(pricing.models, model) }
}

function findPricingEntry(models, model) {
  if (Object.hasOwn(models, model)) return models[model]
  // 前缀回落（"claude-opus-5-20260101" → "claude-opus-5"）。
  //
  // 必须取**最长**匹配，不能拿遍历到的第一个：价目表里有互为前缀的键
  // （gpt-5.4 / gpt-5.4-mini、minimax-m2.5 / minimax-m2.5-highspeed、
  // glm-5 / glm-5.1）。按插入顺序返回首个匹配时，`gpt-5.4-mini-2026`
  // 会落到 gpt-5.4 上 —— 单价高 3.3 倍，而且是静默的：算出来的钱看着
  // 完全正常，只是错的。
  const m = String(model).toLowerCase()
  let best = null
  for (const key of Object.keys(models)) {
    if (!m.startsWith(key)) continue
    if (best === null || key.length > best.length) best = key
  }
  return best === null ? null : models[best]
}

export function calculateCost(pricing, model, usage) {
  const entry = findPricingEntry(pricing.models, model) ?? pricing.default
  const per = pricing.per_tokens || 1000000
  // All providers normalize input to non-cached tokens only (see provider/*.mjs)
  const amount =
    ((usage.input || 0) * (entry.input || 0) +
      (usage.output || 0) * (entry.output || 0) +
      (usage.cacheRead || 0) * (entry.cache_read || 0) +
      (usage.cacheWrite || 0) * (entry.cache_write || 0)) /
    per
  const savings = ((usage.cacheRead || 0) * ((entry.input || 0) - (entry.cache_read || 0))) / per
  const unknown = !findPricingEntry(pricing.models, model) || entry.estimated === true || pricing.estimated === true
    || Boolean(usage.cacheRead && entry.cache_read_estimated) || Boolean(usage.cacheWrite && entry.cache_write_estimated)
  return { amount, savings, unknown, currency: pricing.currency }
}
