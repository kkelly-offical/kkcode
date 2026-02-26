import { requestAnthropic, requestAnthropicStream, countTokensAnthropic } from "./anthropic.mjs"
import { requestOpenAI, requestOpenAIStream, countTokensOpenAI } from "./openai.mjs"
import { request as requestOAICompat, requestStream as requestStreamOAICompat } from "./openai-compatible.mjs"
import { requestOllama, requestOllamaStream } from "./ollama.mjs"
import { ProviderError } from "../core/errors.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"

// --- Provider Registry ---
const registry = new Map()

export function registerProvider(name, mod) {
  if (!mod || typeof mod.request !== "function" || typeof mod.requestStream !== "function") {
    throw new Error(`provider "${name}" must export request() and requestStream()`)
  }
  registry.set(name, mod)
}

export function listProviders() {
  return [...registry.keys()]
}

export function getProvider(name) {
  return registry.get(name) || null
}

// Built-in providers
registerProvider("openai", { request: requestOpenAI, requestStream: requestOpenAIStream, countTokens: countTokensOpenAI })
registerProvider("anthropic", { request: requestAnthropic, requestStream: requestAnthropicStream, countTokens: countTokensAnthropic })
registerProvider("openai-compatible", { request: requestOAICompat, requestStream: requestStreamOAICompat, countTokens: countTokensOpenAI })
registerProvider("ollama", { request: requestOllama, requestStream: requestOllamaStream })

// --- Settings Resolution ---
function resolveSettings(configState, providerType, overrides = {}) {
  const llm = configState.config.provider

  // Resolve registry key: direct match → config type field → fallback to openai
  let resolvedType = providerType
  if (!registry.has(providerType)) {
    const providerConfig = llm[providerType]
    if (providerConfig?.type && registry.has(providerConfig.type)) {
      resolvedType = providerConfig.type
    } else {
      if (llm.strict_mode) {
        throw new ProviderError(
          `unknown provider "${providerType}". registered: ${listProviders().join(", ")}`,
          { provider: providerType, reason: "unknown_provider" }
        )
      }
      console.warn(`[kkcode] unknown provider "${providerType}", falling back to openai`)
      EventBus.emit({
        type: EVENT_TYPES.PROVIDER_FALLBACK,
        payload: { requested: providerType, resolved: "openai" }
      }).catch(() => {})
      resolvedType = "openai"
    }
  }

  // Read config from original provider name (e.g. "deepseek"), not resolved type
  const defaults = llm[providerType] || llm[resolvedType] || {}
  const normalizedModel = String(overrides.model || defaults.default_model || "").includes("/")
    ? String(overrides.model || defaults.default_model).split("/").slice(1).join("/")
    : String(overrides.model || defaults.default_model || "")
  return {
    providerType: resolvedType,
    configKey: providerType,
    model: normalizedModel,
    baseUrl: overrides.baseUrl || defaults.base_url,
    apiKeyEnv: overrides.apiKeyEnv || defaults.api_key_env,
    apiKeyDirect: defaults.api_key || null
  }
}

function classifyProviderFailure(error) {
  const cls = String(error?.errorClass || "").toLowerCase()
  if (["auth", "authentication"].includes(cls)) return "auth"
  if (["rate_limit"].includes(cls)) return "rate_limit"
  if (["context_overflow", "bad_response"].includes(cls)) return "bad_response"
  if (["server", "transient"].includes(cls)) return "bad_response"

  const status = Number(error?.status || error?.httpStatus || 0)
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate_limit"
  if (status >= 400 && status < 500) return "bad_response"
  if (status >= 500) return "bad_response"

  const code = String(error?.code || "").toUpperCase()
  const msg = String(error?.message || "").toLowerCase()
  if (code === "ABORT_ERR" || msg.includes("timeout") || msg.includes("timed out")) return "timeout"
  if (code === "ETIMEDOUT" || code === "ECONNRESET") return "timeout"
  if (msg.includes("invalid json") || msg.includes("parse")) return "bad_response"
  return "unknown"
}

function normalizeProviderError(error, providerType, model) {
  const reason = classifyProviderFailure(error)
  if (error instanceof ProviderError) {
    error.reason = error.reason || reason
    error.details = {
      ...(error.details || {}),
      provider: providerType,
      model,
      reason: error.reason
    }
    return error
  }
  const wrapped = new ProviderError(error?.message || "provider request failed", {
    provider: providerType,
    model,
    reason
  })
  wrapped.reason = reason
  wrapped.cause = error
  return wrapped
}

// --- Non-streaming Request ---
export async function requestProvider({
  configState,
  providerType,
  model,
  system,
  messages,
  tools,
  baseUrl = null,
  apiKeyEnv = null
}) {
  const resolvedProviderType = providerType || configState.config.provider.default
  const settings = resolveSettings(configState, resolvedProviderType, {
    model,
    baseUrl,
    apiKeyEnv
  })
  const apiKey = settings.apiKeyDirect || process.env[settings.apiKeyEnv] || ""
  const providerCfg = configState.config.provider[settings.configKey] || configState.config.provider[settings.providerType] || {}

  const input = {
    apiKey,
    baseUrl: settings.baseUrl,
    apiKeyEnv: settings.apiKeyEnv,
    model: settings.model,
    system,
    messages,
    tools,
    timeoutMs: Number(providerCfg.timeout_ms || 120000),
    maxTokens: Number(providerCfg.max_tokens || 16384),
    retry: {
      attempts: Number(providerCfg.retry_attempts || 3),
      baseDelayMs: Number(providerCfg.retry_base_delay_ms || 800)
    },
    thinking: providerCfg.thinking || null
  }

  const provider = registry.get(settings.providerType)
  if (!provider) {
    throw new Error(`unknown provider: ${settings.providerType}. registered: ${listProviders().join(", ")}`)
  }
  try {
    return await provider.request(input)
  } catch (error) {
    throw normalizeProviderError(error, settings.providerType, settings.model)
  }
}

// --- Streaming Request ---
export async function* requestProviderStream({
  configState,
  providerType,
  model,
  system,
  messages,
  tools,
  baseUrl = null,
  apiKeyEnv = null,
  signal = null,
  compaction = null
}) {
  const resolvedProviderType = providerType || configState.config.provider.default
  const settings = resolveSettings(configState, resolvedProviderType, {
    model,
    baseUrl,
    apiKeyEnv
  })
  const apiKey = settings.apiKeyDirect || process.env[settings.apiKeyEnv] || ""
  const providerCfg = configState.config.provider[settings.configKey] || configState.config.provider[settings.providerType] || {}

  if (providerCfg.stream === false) {
    const result = await requestProvider({
      configState, providerType, model, system, messages, tools, baseUrl, apiKeyEnv
    })
    if (result.text) yield { type: "text", content: result.text }
    for (const call of result.toolCalls) yield { type: "tool_call", call }
    yield { type: "usage", usage: result.usage }
    return
  }

  const input = {
    apiKey,
    baseUrl: settings.baseUrl,
    apiKeyEnv: settings.apiKeyEnv,
    model: settings.model,
    system,
    messages,
    tools,
    timeoutMs: Number(providerCfg.timeout_ms || 120000),
    streamIdleTimeoutMs: Number(providerCfg.stream_idle_timeout_ms || 120000),
    maxTokens: Number(providerCfg.max_tokens || 16384),
    retry: {
      attempts: Number(providerCfg.retry_attempts || 3),
      baseDelayMs: Number(providerCfg.retry_base_delay_ms || 800)
    },
    thinking: providerCfg.thinking || null,
    signal,
    compaction
  }

  const provider = registry.get(settings.providerType)
  if (!provider) {
    throw new Error(`unknown provider: ${settings.providerType}. registered: ${listProviders().join(", ")}`)
  }
  try {
    yield* provider.requestStream(input)
  } catch (error) {
    throw normalizeProviderError(error, settings.providerType, settings.model)
  }
}

// --- Token Counting (Anthropic only, returns null for other providers) ---
export async function countTokensProvider({
  configState, providerType, model, system, messages, tools,
  baseUrl = null, apiKeyEnv = null
}) {
  const resolvedProviderType = providerType || configState.config.provider.default
  const settings = resolveSettings(configState, resolvedProviderType, { model, baseUrl, apiKeyEnv })
  const provider = registry.get(settings.providerType)
  if (!provider?.countTokens) return null
  const apiKey = process.env[settings.apiKeyEnv] || ""
  return provider.countTokens({
    apiKey, baseUrl: settings.baseUrl, model: settings.model,
    system, messages, tools
  })
}
