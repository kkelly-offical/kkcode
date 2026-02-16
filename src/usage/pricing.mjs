import path from "node:path"
import { access, readFile } from "node:fs/promises"
import YAML from "yaml"

const DEFAULT_PRICING = {
  currency: "USD",
  per_tokens: 1000000,
  models: {
    "gpt-5.3-codex": {
      input: 15,
      output: 60,
      cache_read: 1.5,
      cache_write: 18.75
    },
    "claude-opus-4-6": {
      input: 15,
      output: 75,
      cache_read: 1.5,
      cache_write: 18.75
    }
  },
  default: {
    input: 5,
    output: 20,
    cache_read: 0.5,
    cache_write: 6
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

export function calculateCost(pricing, model, usage) {
  const entry = pricing.models[model] ?? pricing.default
  const per = pricing.per_tokens || 1000000
  const amount =
    ((usage.input || 0) * (entry.input || 0) +
      (usage.output || 0) * (entry.output || 0) +
      (usage.cacheRead || 0) * (entry.cache_read || 0) +
      (usage.cacheWrite || 0) * (entry.cache_write || 0)) /
    per
  const unknown = pricing.models[model] === undefined
  return { amount, unknown, currency: pricing.currency }
}
