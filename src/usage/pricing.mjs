import path from "node:path"
import { access, readFile } from "node:fs/promises"
import YAML from "yaml"

const DEFAULT_PRICING = {
  currency: "USD",
  per_tokens: 1000000,
  models: {
    "claude-opus-4-6": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-1": { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
    "claude-opus-4": { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
    "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    "claude-sonnet-4-5": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    "claude-sonnet-4": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
    "claude-haiku-3-5": { input: 0.8, output: 4, cache_read: 0.08, cache_write: 1 },
    "gpt-5.3-codex": { input: 15, output: 60, cache_read: 7.5, cache_write: 15 },
    "gpt-4o": { input: 2.5, output: 10, cache_read: 1.25, cache_write: 2.5 },
    "gpt-4o-mini": { input: 0.15, output: 0.6, cache_read: 0.075, cache_write: 0.15 },
    "deepseek-chat": { input: 0.27, output: 1.1, cache_read: 0.07, cache_write: 0.27 },
    "deepseek-coder": { input: 0.27, output: 1.1, cache_read: 0.07, cache_write: 0.27 }
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
  const projectPath = configState.source.projectRaw?.usage?.pricing_file
  if (typeof projectPath === "string" && projectPath.trim()) {
    return path.resolve(configState.source.projectDir ?? process.cwd(), projectPath)
  }
  const userPath = configState.source.userRaw?.usage?.pricing_file
  if (typeof userPath === "string" && userPath.trim()) {
    return path.resolve(configState.source.userDir ?? process.cwd(), userPath)
  }
  return null
}

export async function loadPricing(configState) {
  const file = resolvePricingPath(configState)
  if (!file || !(await exists(file))) {
    return { pricing: DEFAULT_PRICING, source: "default", errors: [] }
  }
  try {
    const raw = await readFile(file, "utf8")
    const parsed = parse(file, raw)
    const pricing = {
      ...DEFAULT_PRICING,
      ...parsed,
      default: { ...DEFAULT_PRICING.default, ...(parsed.default ?? {}) }
    }
    return { pricing, source: file, errors: [] }
  } catch (error) {
    return { pricing: DEFAULT_PRICING, source: "default", errors: [`${file}: ${error.message}`] }
  }
}

function findPricingEntry(models, model) {
  if (models[model]) return models[model]
  // Fuzzy: try prefix match (e.g. "claude-opus-4-6-20250601" → "claude-opus-4-6")
  const m = String(model).toLowerCase()
  for (const key of Object.keys(models)) {
    if (m.startsWith(key)) return models[key]
  }
  return null
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
  const unknown = !findPricingEntry(pricing.models, model)
  return { amount, unknown, currency: pricing.currency }
}
