import { requestAnthropic, requestAnthropicStream, countTokensAnthropic } from "./anthropic.mjs"
import { requestOpenAI, requestOpenAIStream, countTokensOpenAI } from "./openai.mjs"
import { request as requestOAICompat, requestStream as requestStreamOAICompat } from "./openai-compatible.mjs"
import { requestOllama, requestOllamaStream } from "./ollama.mjs"
import { requestGateway, requestGatewayStream, countTokensGateway } from "./gateway.mjs"
import { ProviderError } from "../core/errors.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { startAuditSpan } from "../audit/event.mjs"
import { createRequestContext } from "../http/identity.mjs"
import {
  assertCredentialTransport,
  assertProviderOutboundAllowed
} from "./security.mjs"
import { validateModelId } from "./model-id.mjs"

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
registerProvider("gateway", { request: requestGateway, requestStream: requestGatewayStream, countTokens: countTokensGateway })

function resolveProtocolBaseUrl(provider, protocol) {
  const endpoint = provider.endpoints?.[protocol]
  if (!endpoint) return provider.base_url
  try {
    const relativeTo = provider.base_url
      ? `${String(provider.base_url).replace(/\/+$/, "")}/`
      : undefined
    return new URL(endpoint, relativeTo).toString().replace(/\/+$/, "")
  } catch {
    return endpoint
  }
}

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
  const protocol = defaults.protocol ||
    (resolvedType === "anthropic" ? "anthropic" : resolvedType === "ollama" ? "ollama" : "openai")
  const protocolBaseUrl = resolveProtocolBaseUrl(defaults, protocol)
  const requestedModel = validateModelId(overrides.model || defaults.default_model || "", {
    label: `provider "${providerType}" model`,
    allowEmpty: true
  })
  const separator = requestedModel.indexOf("/")
  const modelPrefix = separator > 0 ? requestedModel.slice(0, separator) : ""
  const normalizedModel = separator > 0 && [providerType, resolvedType].includes(modelPrefix)
    ? requestedModel.slice(separator + 1)
    : requestedModel
  return {
    providerType: resolvedType,
    configKey: providerType,
    model: normalizedModel,
    baseUrl: overrides.baseUrl || protocolBaseUrl,
    apiKeyEnv: overrides.apiKeyEnv || defaults.api_key_env,
    apiKeyDirect: defaults.api_key || null,
    protocol
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

function safeProviderEndpoint(baseUrl, providerType, protocol, operation = "inference") {
  const suffix = operation === "token_count"
    ? (protocol === "anthropic" ? "messages/count_tokens" : "token-count")
    : providerType === "ollama"
      ? "api/chat"
      : protocol === "anthropic" ? "messages" : "chat/completions"
  try {
    const url = new URL(String(baseUrl || ""))
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${suffix}`
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return `(invalid-base-url)/${suffix}`
  }
}

function upstreamRequestId(response) {
  const headers = response?.headers
  if (!headers?.get) return null
  return headers.get("x-request-id") ||
    headers.get("request-id") ||
    headers.get("x-amzn-requestid") ||
    null
}

function auditFailureMetadata(error, signal) {
  const cancelled = Boolean(signal?.aborted)
  const classified = classifyProviderFailure(error)
  return {
    status: cancelled ? "cancelled" : "error",
    reason: cancelled ? "cancelled" : error?.name === "AbortError" && classified === "unknown" ? "timeout" : classified,
    errorClass: error?.errorClass || null,
    httpStatus: Number(error?.httpStatus || error?.status || 0) || null
  }
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
  apiKeyEnv = null,
  maxTokens = null,
  traceId = "",
  requestId = "",
  parentEventId = "",
  reviewId = "",
  signal = null
}) {
  const resolvedProviderType = providerType || configState.config.provider.default
  const settings = resolveSettings(configState, resolvedProviderType, {
    model,
    baseUrl,
    apiKeyEnv
  })
  await assertProviderOutboundAllowed(configState, {
    providerName: settings.configKey,
    protocol: settings.protocol,
    operation: "provider inference",
    baseUrlOverride: baseUrl,
    apiKeyEnvOverride: apiKeyEnv
  })
  const apiKey = settings.apiKeyDirect ||
    (settings.apiKeyEnv ? process.env[settings.apiKeyEnv] : "") ||
    ""
  assertCredentialTransport({
    baseUrl: settings.baseUrl,
    apiKey,
    providerName: settings.configKey,
    operation: "provider inference"
  })
  const providerCfg = configState.config.provider[settings.configKey] || configState.config.provider[settings.providerType] || {}
  const requestContext = createRequestContext({ traceId, requestId, parentEventId })
  let responseStatus = null
  let responseRequestId = null

  const input = {
    apiKey,
    baseUrl: settings.baseUrl,
    apiKeyEnv: settings.apiKeyEnv,
    provider: settings.configKey,
    protocol: settings.protocol,
    model: settings.model,
    system,
    messages,
    tools,
    timeoutMs: Number(providerCfg.timeout_ms || 120000),
    maxTokens: Number(maxTokens || providerCfg.max_tokens || 16384),
    retry: {
      attempts: Number(providerCfg.retry_attempts || 3),
      baseDelayMs: Number(providerCfg.retry_base_delay_ms || 800)
    },
    thinking: providerCfg.thinking || null,
    reasoningEffort: providerCfg.reasoning_effort || null,
    ...requestContext,
    onResponse(response) {
      responseStatus = Number(response?.status || 0) || null
      responseRequestId = upstreamRequestId(response)
    },
    signal
  }

  const provider = registry.get(settings.providerType)
  if (!provider) {
    throw new Error(`unknown provider: ${settings.providerType}. registered: ${listProviders().join(", ")}`)
  }
  const auditSpan = await startAuditSpan({
    type: "provider.request",
    ...requestContext,
    provider: settings.configKey,
    providerType: settings.providerType,
    protocol: settings.protocol,
    model: settings.model,
    reviewId: reviewId || null,
    endpoint: safeProviderEndpoint(settings.baseUrl, settings.providerType, settings.protocol),
    stream: false
  }).catch(() => null)
  try {
    const result = await provider.request(input)
    await auditSpan?.finish({
      status: "ok",
      httpStatus: responseStatus,
      upstreamRequestId: responseRequestId,
      usage: result?.usage || null
    })
    return result
  } catch (error) {
    const normalized = normalizeProviderError(error, settings.providerType, settings.model)
    await auditSpan?.fail(
      new Error(signal?.aborted ? "provider request cancelled" : "provider request failed"),
      {
        ...auditFailureMetadata(error, signal),
        upstreamRequestId: responseRequestId
      }
    )
    throw normalized
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
  traceId = "",
  requestId = "",
  parentEventId = "",
  reviewId = "",
  signal = null,
  compaction = null
}) {
  const resolvedProviderType = providerType || configState.config.provider.default
  const settings = resolveSettings(configState, resolvedProviderType, {
    model,
    baseUrl,
    apiKeyEnv
  })
  await assertProviderOutboundAllowed(configState, {
    providerName: settings.configKey,
    protocol: settings.protocol,
    operation: "provider inference",
    baseUrlOverride: baseUrl,
    apiKeyEnvOverride: apiKeyEnv
  })
  const apiKey = settings.apiKeyDirect ||
    (settings.apiKeyEnv ? process.env[settings.apiKeyEnv] : "") ||
    ""
  assertCredentialTransport({
    baseUrl: settings.baseUrl,
    apiKey,
    providerName: settings.configKey,
    operation: "provider inference"
  })
  const providerCfg = configState.config.provider[settings.configKey] || configState.config.provider[settings.providerType] || {}

  if (providerCfg.stream === false) {
    const result = await requestProvider({
      configState, providerType, model, system, messages, tools, baseUrl, apiKeyEnv,
      traceId, requestId, parentEventId, reviewId, signal
    })
    if (result.reasoning) {
      yield { type: "thinking", content: result.reasoning, source: "reasoning_content" }
    }
    if (result.text) yield { type: "text", content: result.text }
    for (const call of result.toolCalls) yield { type: "tool_call", call }
    yield { type: "usage", usage: result.usage }
    return
  }

  const requestContext = createRequestContext({ traceId, requestId, parentEventId })
  let responseStatus = null
  let responseRequestId = null
  const input = {
    apiKey,
    baseUrl: settings.baseUrl,
    apiKeyEnv: settings.apiKeyEnv,
    provider: settings.configKey,
    protocol: settings.protocol,
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
    reasoningEffort: providerCfg.reasoning_effort || null,
    ...requestContext,
    onResponse(response) {
      responseStatus = Number(response?.status || 0) || null
      responseRequestId = upstreamRequestId(response)
    },
    signal,
    compaction
  }

  const provider = registry.get(settings.providerType)
  if (!provider) {
    throw new Error(`unknown provider: ${settings.providerType}. registered: ${listProviders().join(", ")}`)
  }
  const auditSpan = await startAuditSpan({
    type: "provider.request",
    ...requestContext,
    provider: settings.configKey,
    providerType: settings.providerType,
    protocol: settings.protocol,
    model: settings.model,
    reviewId: reviewId || null,
    endpoint: safeProviderEndpoint(settings.baseUrl, settings.providerType, settings.protocol),
    stream: true
  }).catch(() => null)
  let auditClosed = false
  let streamCompleted = false
  let usage = null
  let stopReason = null
  try {
    for await (const chunk of provider.requestStream(input)) {
      if (chunk?.type === "usage") usage = chunk.usage || null
      if (chunk?.type === "stop") stopReason = chunk.reason || null
      yield chunk
    }
    streamCompleted = true
    if (signal?.aborted) {
      auditClosed = true
      await auditSpan?.fail(new Error("provider stream cancelled"), {
        status: "cancelled",
        reason: "cancelled",
        httpStatus: responseStatus,
        upstreamRequestId: responseRequestId,
        usage,
        stopReason
      })
      return
    }
    auditClosed = true
    await auditSpan?.finish({
      status: "ok",
      httpStatus: responseStatus,
      upstreamRequestId: responseRequestId,
      usage,
      stopReason
    })
  } catch (error) {
    auditClosed = true
    await auditSpan?.fail(
      new Error(signal?.aborted ? "provider stream cancelled" : "provider stream failed"),
      {
        ...auditFailureMetadata(error, signal),
        upstreamRequestId: responseRequestId,
        usage,
        stopReason
      }
    )
    throw normalizeProviderError(error, settings.providerType, settings.model)
  } finally {
    if (!auditClosed && !streamCompleted) {
      if (stopReason && !signal?.aborted) {
        await auditSpan?.finish({
          status: "ok",
          httpStatus: responseStatus,
          upstreamRequestId: responseRequestId,
          usage,
          stopReason
        })
      } else {
        await auditSpan?.fail(new Error("provider stream consumer closed"), {
          status: "cancelled",
          reason: "consumer_closed",
          httpStatus: responseStatus,
          upstreamRequestId: responseRequestId,
          usage,
          stopReason
        })
      }
    }
  }
}

// --- Token Counting (Anthropic only, returns null for other providers) ---
export async function countTokensProvider({
  configState, providerType, model, system, messages, tools,
  baseUrl = null, apiKeyEnv = null,
  traceId = "", requestId = "", parentEventId = "", reviewId = "", signal = null
}) {
  const resolvedProviderType = providerType || configState.config.provider.default
  const settings = resolveSettings(configState, resolvedProviderType, { model, baseUrl, apiKeyEnv })
  const provider = registry.get(settings.providerType)
  if (!provider?.countTokens) return null
  const apiKey = settings.apiKeyDirect ||
    (settings.apiKeyEnv ? process.env[settings.apiKeyEnv] : "") ||
    ""
  const requestContext = createRequestContext({ traceId, requestId, parentEventId })
  const providerCfg = configState.config.provider[settings.configKey] || {}
  let responseStatus = null
  let responseRequestId = null
  const input = {
    apiKey,
    apiKeyEnv: settings.apiKeyEnv,
    baseUrl: settings.baseUrl,
    model: settings.model,
    system,
    messages,
    tools,
    protocol: settings.protocol,
    provider: settings.configKey,
    timeoutMs: Math.min(Number(providerCfg.timeout_ms || 10000), 30000),
    signal,
    ...requestContext,
    onResponse(response) {
      responseStatus = Number(response?.status || 0) || null
      responseRequestId = upstreamRequestId(response)
    }
  }
  // OpenAI-compatible APIs have no portable count-only endpoint, so their
  // implementation is local and should not create a misleading HTTP span.
  const isRemoteCount = settings.protocol === "anthropic"
  if (!isRemoteCount) return provider.countTokens(input)
  await assertProviderOutboundAllowed(configState, {
    providerName: settings.configKey,
    protocol: settings.protocol,
    operation: "provider token count",
    baseUrlOverride: baseUrl,
    apiKeyEnvOverride: apiKeyEnv
  })
  assertCredentialTransport({
    baseUrl: settings.baseUrl,
    apiKey,
    providerName: settings.configKey,
    operation: "provider token count"
  })

  const auditSpan = await startAuditSpan({
    type: "provider.token_count",
    ...requestContext,
    provider: settings.configKey,
    providerType: settings.providerType,
    protocol: settings.protocol,
    model: settings.model,
    reviewId: reviewId || null,
    endpoint: safeProviderEndpoint(settings.baseUrl, settings.providerType, settings.protocol, "token_count")
  }).catch(() => null)
  try {
    const count = await provider.countTokens(input)
    await auditSpan?.finish({
      ok: Number.isFinite(count),
      status: Number.isFinite(count) ? "ok" : "unavailable",
      httpStatus: responseStatus,
      upstreamRequestId: responseRequestId,
      tokenCount: Number.isFinite(count) ? count : null
    })
    return count
  } catch (error) {
    await auditSpan?.fail(new Error("provider token count failed"), {
      ...auditFailureMetadata(error, signal),
      upstreamRequestId: responseRequestId
    })
    throw error
  }
}
