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
import { resolveThinkingParams } from "./thinking-effort.mjs"

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
  if (["aborted", "cancelled"].includes(cls)) return "cancelled"
  if (["auth", "authentication"].includes(cls)) return "auth"
  if (["rate_limit"].includes(cls)) return "rate_limit"
  if (["timeout"].includes(cls)) return "timeout"
  if (["network"].includes(cls)) return "network"
  if (["context_overflow", "bad_request", "bad_response"].includes(cls)) return "bad_response"
  if (["server", "transient"].includes(cls)) return "bad_response"

  const status = Number(error?.status || error?.httpStatus || 0)
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate_limit"
  if (status >= 400 && status < 500) return "bad_response"
  if (status >= 500) return "bad_response"

  const code = String(error?.code || "").toUpperCase()
  const msg = String(error?.message || "").toLowerCase()
  if (code === "ABORT_ERR") return "cancelled"
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout"
  if (code === "ETIMEDOUT") return "timeout"
  if (["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"].includes(code)) return "network"
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
  wrapped.errorClass = error?.errorClass || reason
  wrapped.httpStatus = Number(error?.httpStatus || error?.status || 0) || null
  if (error?.needsCompaction) wrapped.needsCompaction = true
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

function createRetryTelemetry({
  requestContext,
  sessionId,
  turnId,
  provider,
  model
}) {
  let retryCount = 0
  let retryBudgetAttempts = 1
  let lastRetryClass = null
  const retryClasses = new Set()

  return {
    async onRetry(retryInfo) {
      retryCount += 1
      retryBudgetAttempts = Number(retryInfo.totalAttempts || retryBudgetAttempts)
      lastRetryClass = String(retryInfo.classification || "unknown")
      retryClasses.add(lastRetryClass)
      await EventBus.emit({
        type: EVENT_TYPES.PROVIDER_RETRY,
        ...requestContext,
        sessionId,
        turnId,
        payload: {
          provider,
          model,
          retryAttempt: retryInfo.retryAttempt,
          maxRetries: retryInfo.maxRetries,
          requestAttempt: retryInfo.requestAttempt,
          totalAttempts: retryInfo.totalAttempts,
          classification: retryInfo.classification,
          delayMs: retryInfo.delayMs
        }
      })
    },
    snapshot() {
      return {
        retryCount,
        retryClasses: [...retryClasses],
        lastRetryClass,
        attemptsObserved: retryCount + 1,
        retryBudgetAttempts
      }
    }
  }
}

// --- Non-streaming Request ---
/**
 * 两条请求路径（流式 / 非流式）共用的准备段：解析设置 → 出网与凭据前置校验
 * → 取 provider 配置。0.6.0 之前这段在两个函数里各写了一遍，任何一条安全
 * 校验的调整都必须记得改两处 —— 而漏改的那一处不会有任何报错。
 */
async function prepareProviderCall(configState, { providerType, model, baseUrl, apiKeyEnv }) {
  const resolvedProviderType = providerType || configState.config.provider.default
  const settings = resolveSettings(configState, resolvedProviderType, { model, baseUrl, apiKeyEnv })
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
  const providerCfg = configState.config.provider[settings.configKey]
    || configState.config.provider[settings.providerType]
    || {}
  return { settings, apiKey, providerCfg }
}

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
  temperature = null,
  traceId = "",
  requestId = "",
  parentEventId = "",
  sessionId = null,
  turnId = null,
  reviewId = "",
  signal = null,
  // 高频的辅助调用（输入框预测、标题生成）不进审计链，否则会淹没
  // kk.audit.v1 里真正需要追溯的模型请求
  audit = true
}) {
  const { settings, apiKey, providerCfg } = await prepareProviderCall(configState, { providerType, model, baseUrl, apiKeyEnv })
  const requestContext = createRequestContext({ traceId, requestId, parentEventId })
  let responseStatus = null
  let responseRequestId = null
  const retryTelemetry = createRetryTelemetry({
    requestContext,
    sessionId,
    turnId,
    provider: settings.configKey,
    model: settings.model
  })

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
      retries: Number(providerCfg.retry_attempts ?? 5),
      baseDelayMs: Number(providerCfg.retry_base_delay_ms || 800),
      onRetry: retryTelemetry.onRetry
    },
    // 0.6.2：思考强度按档位解析，并按模型自身的输出预算算绝对值 ——
    // 此前 Anthropic 侧的 budget_tokens 是硬编码 10000，对大模型太少、
    // 对小模型可能超过它的输出上限。显式写的 thinking/reasoning_effort 仍然优先。
    ...resolveThinkingParams({
      tier: providerCfg.thinking_effort || providerCfg.reasoning_effort || "high",
      protocol: settings.protocol,
      maxOutputTokens: Number(providerCfg.max_output_tokens) || Number(providerCfg.max_tokens) || 0,
      contextLimit: Number(providerCfg.context_limit) || 0
    }),
    ...(providerCfg.thinking ? { thinking: providerCfg.thinking } : {}),
    ...(providerCfg.reasoning_effort ? { reasoningEffort: providerCfg.reasoning_effort } : {}),
    ...(Number.isFinite(temperature) ? { temperature } : {}),
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
  const auditSpan = audit
    ? await startAuditSpan({
        type: "provider.request",
        ...requestContext,
        sessionId,
        turnId,
        provider: settings.configKey,
        providerType: settings.providerType,
        protocol: settings.protocol,
        model: settings.model,
        reviewId: reviewId || null,
        endpoint: safeProviderEndpoint(settings.baseUrl, settings.providerType, settings.protocol),
        stream: false
      }).catch(() => null)
    : null
  try {
    const result = await provider.request(input)
    await auditSpan?.finish({
      status: "ok",
      httpStatus: responseStatus,
      upstreamRequestId: responseRequestId,
      usage: result?.usage || null,
      ...retryTelemetry.snapshot()
    })
    return result
  } catch (error) {
    const normalized = normalizeProviderError(error, settings.providerType, settings.model)
    await auditSpan?.fail(
      new Error(signal?.aborted ? "provider request cancelled" : "provider request failed"),
      {
        ...auditFailureMetadata(error, signal),
        upstreamRequestId: responseRequestId,
        ...retryTelemetry.snapshot()
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
  sessionId = null,
  turnId = null,
  reviewId = "",
  signal = null,
  temperature = null,
  compaction = null
}) {
  const { settings, apiKey, providerCfg } = await prepareProviderCall(configState, { providerType, model, baseUrl, apiKeyEnv })

  if (providerCfg.stream === false) {
    const result = await requestProvider({
      configState, providerType, model, system, messages, tools, baseUrl, apiKeyEnv,
      traceId, requestId, parentEventId, sessionId, turnId, reviewId, signal
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
  const retryTelemetry = createRetryTelemetry({
    requestContext,
    sessionId,
    turnId,
    provider: settings.configKey,
    model: settings.model
  })
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
      retries: Number(providerCfg.retry_attempts ?? 5),
      baseDelayMs: Number(providerCfg.retry_base_delay_ms || 800),
      onRetry: retryTelemetry.onRetry
    },
    // 0.6.2：思考强度按档位解析，并按模型自身的输出预算算绝对值 ——
    // 此前 Anthropic 侧的 budget_tokens 是硬编码 10000，对大模型太少、
    // 对小模型可能超过它的输出上限。显式写的 thinking/reasoning_effort 仍然优先。
    ...resolveThinkingParams({
      tier: providerCfg.thinking_effort || providerCfg.reasoning_effort || "high",
      protocol: settings.protocol,
      maxOutputTokens: Number(providerCfg.max_output_tokens) || Number(providerCfg.max_tokens) || 0,
      contextLimit: Number(providerCfg.context_limit) || 0
    }),
    ...(providerCfg.thinking ? { thinking: providerCfg.thinking } : {}),
    ...(providerCfg.reasoning_effort ? { reasoningEffort: providerCfg.reasoning_effort } : {}),
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
    sessionId,
    turnId,
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
      if (signal?.aborted) {
        const error = new Error("provider stream cancelled")
        error.code = "ABORT_ERR"
        error.errorClass = "aborted"
        throw error
      }
      if (chunk?.type === "usage") usage = chunk.usage || null
      if (chunk?.type === "stop") stopReason = chunk.reason || null
      yield chunk
    }
    streamCompleted = true
    if (signal?.aborted) {
      const error = new Error("provider stream cancelled")
      error.code = "ABORT_ERR"
      error.errorClass = "aborted"
      throw error
    }
    auditClosed = true
    await auditSpan?.finish({
      status: "ok",
      httpStatus: responseStatus,
      upstreamRequestId: responseRequestId,
      usage,
      stopReason,
      ...retryTelemetry.snapshot()
    })
  } catch (error) {
    auditClosed = true
    await auditSpan?.fail(
      new Error(signal?.aborted ? "provider stream cancelled" : "provider stream failed"),
      {
        ...auditFailureMetadata(error, signal),
        upstreamRequestId: responseRequestId,
        usage,
        stopReason,
        ...retryTelemetry.snapshot()
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
          stopReason,
          ...retryTelemetry.snapshot()
        })
      } else {
        await auditSpan?.fail(new Error("provider stream consumer closed"), {
          status: "cancelled",
          reason: "consumer_closed",
          httpStatus: responseStatus,
          upstreamRequestId: responseRequestId,
          usage,
          stopReason,
          ...retryTelemetry.snapshot()
        })
      }
    }
  }
}

// --- Token Counting (Anthropic only, returns null for other providers) ---
export async function countTokensProvider({
  configState, providerType, model, system, messages, tools,
  baseUrl = null, apiKeyEnv = null,
  traceId = "", requestId = "", parentEventId = "",
  sessionId = null, turnId = null, reviewId = "", signal = null
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
    sessionId,
    turnId,
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
