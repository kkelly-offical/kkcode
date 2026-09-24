import { runtimeDependency } from '../core/runtime-context.mjs'
import { requestAnthropic, requestAnthropicStream, countTokensAnthropic } from "./anthropic.mjs"
import { requestOpenAI, requestOpenAIStream, countTokensOpenAI } from "./openai.mjs"
import { request as requestOAICompat, requestStream as requestStreamOAICompat } from "./openai-compatible.mjs"
import { requestOllama, requestOllamaStream } from "./ollama.mjs"
import { requestGateway, requestGatewayStream, countTokensGateway } from "./gateway.mjs"
import { ProviderError } from "../core/errors.mjs"
import { EventBus } from "../core/events.mjs"
import { EVENT_TYPES } from "../core/constants.mjs"
import { startAuditSpan } from "../../audit/event.mjs"
import { createRequestContext } from "../../http/identity.mjs"
import {
  assertCredentialTransport,
  assertProviderOutboundAllowed
} from "./security.mjs"
import { validateModelId } from "./model-id.mjs"
import { resolveThinkingParams } from "./thinking-effort.mjs"
import { resolveModelCapabilities } from "./model-catalog.mjs"
import { enforceModelInputCapabilities } from "./model-capabilities.mjs"
import { noteDeprecation } from "../core/deprecations.mjs"
import { trimTrailingSlashes } from "./url-path.mjs"
import { prepareImageMessages } from '../media/images.mjs'
import { requestResponses, requestResponsesStream, countTokensResponses, responsesEndpoint } from './responses.mjs'
import { stripProviderState } from './responses-state.mjs'
import { assertProviderDataPolicy } from '../permission/data-policy.mjs'
import { recordModelUsage } from '../../usage/model-ledger.mjs'
import { reserveRequestBudget, hasRequestBudget, assertRequestBudgetActive } from '../../usage/request-budget.mjs'
import { strictInputTokenBound, needsTrustedInputCount, snapshotStrictInput } from '../../usage/input-token-bound.mjs'

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
    // ProviderError 实例在 provider 层会被陆续挂上 reason/errorClass/httpStatus/
    // needsCompaction 等定位字段（KkError 未声明这些开放字段），这里按扩展形状用。
    const enriched = /** @type {ProviderError & Record<string, any>} */ (error)
    enriched.reason = enriched.reason || reason
    enriched.details = {
      ...(enriched.details || {}),
      provider: providerType,
      model,
      reason: enriched.reason
    }
    return enriched
  }
  const wrapped = /** @type {ProviderError & Record<string, any>} */ (new ProviderError(error?.message || "provider request failed", {
    provider: providerType,
    model,
    reason
  }))
  wrapped.reason = reason
  wrapped.cause = error
  wrapped.errorClass = error?.errorClass || reason
  wrapped.httpStatus = Number(error?.httpStatus || error?.status || 0) || null
  if (error?.needsCompaction) wrapped.needsCompaction = true
  if (/^(?:TASK_(?:BUDGET|DEADLINE)|BUDGET_)/.test(error?.code || '')) {
    wrapped.code = error.code
    wrapped.operationNotStarted = error.operationNotStarted === true
  }
  return wrapped
}

function throwIfProviderAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('provider request cancelled'), { code: 'ABORT_ERR', errorClass: 'aborted' })
}

function safeProviderEndpoint(baseUrl, providerType, protocol, operation = "inference") {
  if (protocol === 'responses') {
    try { const url = new URL(responsesEndpoint(baseUrl)); if (operation === 'token_count') url.pathname += '/input_tokens'; url.search = ''; return url.href } catch { return '(invalid-base-url)/responses' }
  }
  const suffix = operation === "token_count"
    ? (protocol === "anthropic" ? "messages/count_tokens" : "token-count")
    : providerType === "ollama"
      ? "api/chat"
      : protocol === "anthropic" ? "messages" : "chat/completions"
  try {
    const url = new URL(String(baseUrl || ""))
    url.pathname = `${trimTrailingSlashes(url.pathname)}/${suffix}`
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


/**
 * Provider 注册表工厂（1.0.0 阶段 2a）：全局 provider 注册表收编为实例字段
 * （M3 §四.2）。每个实例预置内建 provider（openai/anthropic/openai-compatible/
 * ollama/gateway），自定义注册互不可见。
 */
export function createProviderRegistry() {
  // --- Provider Registry ---
  const registry = new Map()

  function registerProvider(name, mod) {
    if (!mod || typeof mod.request !== "function" || typeof mod.requestStream !== "function") {
      throw new Error(`provider "${name}" must export request() and requestStream()`)
    }
    registry.set(name, mod)
  }

  function listProviders() {
    return [...registry.keys()]
  }

  function getProvider(name) {
    return registry.get(name) || null
  }

  // Built-in providers
  registerProvider("openai", { request: requestOpenAI, requestStream: requestOpenAIStream, countTokens: countTokensOpenAI })
  registerProvider('openai-responses', { request: requestResponses, requestStream: requestResponsesStream, countTokens: countTokensResponses })
  registerProvider("anthropic", { request: requestAnthropic, requestStream: requestAnthropicStream, countTokens: countTokensAnthropic })
  registerProvider("openai-compatible", { request: requestOAICompat, requestStream: requestStreamOAICompat, countTokens: countTokensOpenAI })
  registerProvider("ollama", { request: requestOllama, requestStream: requestOllamaStream })
  registerProvider("gateway", { request: requestGateway, requestStream: requestGatewayStream, countTokens: countTokensGateway })

  /**
   * 能力标记 → 请求形状。每条请求都过：确知不收图的模型在出门之前被拦
   * （新输入里的图抛错、历史里的图降级占位文本），确知不收 tools 的模型
   * 摘掉工具。能力解析只读发现缓存与配置，永不触网；「未知」一律放行，
   * 与没有能力系统时的行为完全一致。
   *
   * 丢弃告警每个 provider/model/种类只报一次 —— agent 循环每一步都走
   * 这里，逐次告警会把 stderr 淹没在同一件事上。
   */
  const capabilityWarnings = new Set()
  function warnCapabilityOnce(key, message, context) {
    if (capabilityWarnings.has(key)) return
    capabilityWarnings.add(key)
    while (capabilityWarnings.size > 256) capabilityWarnings.delete(capabilityWarnings.values().next().value)
    EventBus.emit({ type: EVENT_TYPES.PROVIDER_CAPABILITY_NOTICE, ...context, payload: { message } }).catch(() => {})
    if (!process.stdout.isTTY) console.warn(message)
  }

  async function guardModelInput(configState, settings, messages, tools, context = {}) {
    if (!['responses', 'anthropic'].includes(settings.protocol)) messages = stripProviderState(messages)
    const { capabilities } = await resolveModelCapabilities(configState, settings.configKey, settings.model)
    const guarded = enforceModelInputCapabilities({
      messages,
      tools,
      capabilities,
      protocol: settings.protocol,
      provider: settings.configKey,
      model: settings.model
    })
    const warnKey = `${settings.configKey}\0${settings.model}\0${context.sessionId || ''}`
    if (guarded.droppedImages > 0) {
      warnCapabilityOnce(`${warnKey}\0image`, `[kkcode] model "${settings.model}" does not support image input; ${guarded.droppedImages} image(s) in conversation history were replaced with text placeholders`, context)
    }
    if (guarded.droppedMedia > 0) {
      warnCapabilityOnce(`${warnKey}\0media`, `[kkcode] ${guarded.droppedMedia} video/audio block(s) cannot be sent to model "${settings.model}" and were replaced with text placeholders`, context)
    }
    if (guarded.droppedTools > 0) {
      warnCapabilityOnce(`${warnKey}\0tools`, `[kkcode] model "${settings.model}" is marked as not supporting tool calling; ${guarded.droppedTools} tool(s) were omitted from the request`, context)
    }
    return { capabilities, messages: await prepareImageMessages(guarded.messages), tools: guarded.tools }
  }


  function resolveProtocolBaseUrl(provider, protocol) {
    const endpoint = provider.endpoints?.[protocol]
    if (!endpoint) return provider.base_url
    try {
      const relativeTo = provider.base_url
        ? `${trimTrailingSlashes(String(provider.base_url))}/`
        : undefined
      return trimTrailingSlashes(new URL(endpoint, relativeTo).toString())
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
    if (defaults.type === 'openai-responses' && ['openai', 'openai-compatible', 'anthropic', 'ollama', 'gateway'].includes(resolvedType)) resolvedType = 'openai-responses'
    const protocol = resolvedType === 'openai-responses' ? 'responses' : defaults.protocol ||
      (resolvedType === "anthropic" ? "anthropic" : resolvedType === "ollama" ? "ollama" : "openai")
    if (protocol === 'responses' && ['openai', 'openai-compatible'].includes(resolvedType)) resolvedType = 'openai-responses'
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

  // --- Non-streaming Request ---
  /**
   * 两条请求路径（流式 / 非流式）共用的准备段：解析设置 → 出网与凭据前置校验
   * → 取 provider 配置。0.6.0 之前这段在两个函数里各写了一遍，任何一条安全
   * 校验的调整都必须记得改两处 —— 而漏改的那一处不会有任何报错。
   */
  async function prepareProviderCall(configState, { providerType, model, baseUrl, apiKeyEnv }) {
    const resolvedProviderType = providerType || configState.config.provider.default
    // 0.7.3 起 DEFAULT_CONFIG 不再预置 provider，零配置用户会真的走到这里 ——
    // 「unknown provider type: undefined」对他没有任何可操作性，要说清下一步。
    if (!resolvedProviderType) {
      throw new Error("没有配置任何 provider。运行 kkcode 后输入 /provider add 添加一个（或手动编辑 ~/.kkcode/config.yaml）。")
    }
    const settings = resolveSettings(configState, resolvedProviderType, { model, baseUrl, apiKeyEnv })
    assertProviderDataPolicy(configState, { providerName: settings.configKey, baseUrl: settings.baseUrl })
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

  async function requestInputBound(input, request) {
    if (!hasRequestBudget()) return 0
    assertRequestBudgetActive()
    snapshotStrictInput(input)
    let trustedCount = null
    if (input.protocol === 'responses' || input.protocol === 'anthropic' && needsTrustedInputCount(input)) {
      const count = await countPreparedInput(input, request)
      // Anthropic documents its count as an estimate; do not label it exact.
      // A doubled estimate plus framing headroom is an explicit conservative
      // reserve, while Responses documents exact processed input counting.
      trustedCount = Number.isSafeInteger(count) && count > 0 ? input.protocol === 'anthropic' ? count * 2 + 4096 : count : null
    }
    return strictInputTokenBound(input, { trustedCount }).tokens
  }

  async function countPreparedInput(input, { configState, providerType, baseUrl, apiKeyEnv, sessionId, turnId }) {
    const settings = { configKey: input.provider, protocol: input.protocol, baseUrl: input.baseUrl, model: input.model,
      providerType: resolveSettings(configState, providerType || configState.config.provider.default, { model: input.model, baseUrl, apiKeyEnv }).providerType }
    const provider = registry.get(settings.providerType)
    if (!provider?.countTokens) return null
    assertProviderDataPolicy(configState, { providerName: input.provider, baseUrl: input.baseUrl })
    await assertProviderOutboundAllowed(configState, { providerName: input.provider, protocol: input.protocol, operation: 'provider token count', baseUrlOverride: baseUrl, apiKeyEnvOverride: apiKeyEnv })
    assertCredentialTransport({ baseUrl: input.baseUrl, apiKey: input.apiKey, providerName: input.provider, operation: 'provider token count' })
    const identity = createRequestContext({ traceId: input.traceId, parentEventId: input.parentEventId }), span = await startAuditSpan({ type: 'provider.token_count', ...identity,
      sessionId, turnId, provider: input.provider, model: input.model, protocol: input.protocol, endpoint: safeProviderEndpoint(input.baseUrl, settings.providerType, input.protocol, 'token_count') }).catch(() => null)
    let httpStatus = null
    try {
      const count = await provider.countTokens({ ...input, ...identity, timeoutMs: Math.min(input.timeoutMs || 10000, 30000),
        onResponse: response => { httpStatus = response.status } })
      await span?.finish({ status: Number.isSafeInteger(count) ? 'ok' : 'unavailable', httpStatus, tokenCount: Number.isSafeInteger(count) ? count : null })
      return count
    } catch (error) {
      await span?.fail(new Error('provider token count failed'), { ...auditFailureMetadata(error, input.signal), httpStatus })
      throw error
    }
  }

  async function requestProvider({
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
    const guarded = await guardModelInput(configState, settings, messages, tools, { sessionId, turnId })
    const capabilities = guarded.capabilities
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
      messages: guarded.messages,
      ...(settings.protocol === 'anthropic' && providerCfg.native_compaction === true ? { compaction: { trigger: providerCfg.compaction_trigger ?? 150000 } } : {}),
      tools: guarded.tools,
      timeoutMs: Number(providerCfg.timeout_ms || 120000),
      maxTokens: Number(maxTokens || providerCfg.max_tokens || 16384),
      retry: {
        retries: hasRequestBudget() ? 0 : Number(providerCfg.retry_attempts ?? 5),
        baseDelayMs: Number(providerCfg.retry_base_delay_ms || 800),
        onRetry: retryTelemetry.onRetry
      },
      // 0.6.2：思考强度按档位解析，并按模型自身的输出预算算绝对值 ——
      // 此前 Anthropic 侧的 budget_tokens 是硬编码 10000，对大模型太少、
      // 对小模型可能超过它的输出上限。显式写的 thinking/reasoning_effort 仍然优先。
      // 能力确知「不支持思考」时按 off 处理：给它发 reasoning_effort/thinking
      // 只会换来 400。用户显式写的 thinking 配置仍然优先于探测结论。
      ...resolveThinkingParams({
        // OpenAI-compatible servers do not share one effort vocabulary (for
        // example the local Qwen template rejects "high"). With no explicit
        // preference, let the server choose its default instead of injecting it.
        tier: providerCfg.thinking_effort || providerCfg.reasoning_effort ||
          (settings.protocol === 'anthropic' && capabilities.reasoning !== false ? 'high' : 'off'),
        protocol: settings.protocol,
        maxOutputTokens: Number(providerCfg.max_output_tokens) || Number(providerCfg.max_tokens) || 0,
        contextLimit: Number(providerCfg.context_limit) || 0
      }),
      ...(providerCfg.thinking ? { thinking: providerCfg.thinking } : {}),
      ...(providerCfg.reasoning_effort ? { reasoningEffort: providerCfg.reasoning_effort } : {}),
      ...(settings.protocol === 'responses' ? { reasoningSummary: providerCfg.reasoning_summary || (capabilities.reasoning === true ? 'auto' : null) } : {}),
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
    let budget = null
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
      throwIfProviderAborted(input.signal)
      const inputTokenBound = await requestInputBound(input, { configState, providerType, model, baseUrl, apiKeyEnv, sessionId, turnId })
      budget = await reserveRequestBudget(configState, { provider: settings.configKey, model: settings.model,
        contextLimit: Number(providerCfg.context_limit), maxTokens: input.maxTokens, inputTokenBound, compaction: Boolean(input.compaction), requestId: requestContext.requestId, baseUrl: settings.baseUrl, credential: apiKey, protocol: settings.protocol })
      if (input.signal?.aborted) { await budget?.cancelBeforeDispatch(); throwIfProviderAborted(input.signal) }
      const result = await provider.request(input)
      await budget?.settle(result?.usage, { complete: true })
      recordModelUsage({ requestId: requestContext.requestId, provider: settings.configKey, model: settings.model, usage: result?.usage })
      await auditSpan?.finish({
        status: "ok",
        httpStatus: responseStatus,
        upstreamRequestId: responseRequestId,
        usage: result?.usage || null,
        ...retryTelemetry.snapshot()
      })
      return result
    } catch (error) {
      await budget?.settle(null)
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
  async function* requestProviderStream({
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
    maxTokens = null,
    compaction = null
  }) {
    const { settings, apiKey, providerCfg } = await prepareProviderCall(configState, { providerType, model, baseUrl, apiKeyEnv })
    const guarded = await guardModelInput(configState, settings, messages, tools, { sessionId, turnId })
    const capabilities = guarded.capabilities

    // providerCfg.stream === false 是显式配置；capabilities.streaming === false
    // 是探测结论（目录枚举过能力且没有流式）。两者都走非流式通道。
    if (providerCfg.stream === false || capabilities.streaming === false) {
      const result = await requestProvider({
        configState, providerType, model, system, messages: guarded.messages, tools: guarded.tools, baseUrl, apiKeyEnv,
        traceId, requestId, parentEventId, sessionId, turnId, reviewId, signal, maxTokens
      })
      if (result.reasoning) {
        yield { type: "thinking", content: result.reasoning, source: "reasoning_content" }
      }
      if (result.text) yield { type: "text", content: result.text }
      for (const call of result.toolCalls) yield { type: "tool_call", call }
      if (result.providerState) yield { type: 'provider_state', state: result.providerState }
      yield { type: "usage", usage: result.usage, ...(result.contextUsage ? { contextUsage: result.contextUsage } : {}) }
      if (result.stopReason) yield { type: 'stop', reason: result.stopReason }
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
      messages: guarded.messages,
      tools: guarded.tools,
      timeoutMs: Number(providerCfg.timeout_ms || 120000),
      streamIdleTimeoutMs: Number(providerCfg.stream_idle_timeout_ms || 120000),
      maxTokens: Number(maxTokens || providerCfg.max_tokens || 16384),
      retry: {
        retries: hasRequestBudget() ? 0 : Number(providerCfg.retry_attempts ?? 5),
        baseDelayMs: Number(providerCfg.retry_base_delay_ms || 800),
        onRetry: retryTelemetry.onRetry
      },
      // 思考档位的能力门：与 requestProvider 同一条规则（确知不支持 → off，
      // 用户显式配置优先）。
      ...resolveThinkingParams({
        tier: providerCfg.thinking_effort || providerCfg.reasoning_effort ||
          (settings.protocol === 'anthropic' && capabilities.reasoning !== false ? 'high' : 'off'),
        protocol: settings.protocol,
        maxOutputTokens: Number(providerCfg.max_output_tokens) || Number(providerCfg.max_tokens) || 0,
        contextLimit: Number(providerCfg.context_limit) || 0
      }),
      ...(providerCfg.thinking ? { thinking: providerCfg.thinking } : {}),
      ...(providerCfg.reasoning_effort ? { reasoningEffort: providerCfg.reasoning_effort } : {}),
      ...(settings.protocol === 'responses' ? { reasoningSummary: providerCfg.reasoning_summary || (capabilities.reasoning === true ? 'auto' : null) } : {}),
      ...requestContext,
      onResponse(response) {
        responseStatus = Number(response?.status || 0) || null
        responseRequestId = upstreamRequestId(response)
      },
      signal,
      compaction: settings.protocol === 'anthropic' && providerCfg.native_compaction === true
        ? (compaction || { trigger: providerCfg.compaction_trigger ?? 150000 }) : null
    }

    const provider = registry.get(settings.providerType)
    if (!provider) {
      throw new Error(`unknown provider: ${settings.providerType}. registered: ${listProviders().join(", ")}`)
    }
    let budget = null
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
      throwIfProviderAborted(input.signal)
      const inputTokenBound = await requestInputBound(input, { configState, providerType, model, baseUrl, apiKeyEnv, sessionId, turnId })
      budget = await reserveRequestBudget(configState, { provider: settings.configKey, model: settings.model,
        contextLimit: Number(providerCfg.context_limit), maxTokens: input.maxTokens, inputTokenBound, compaction: Boolean(input.compaction), requestId: requestContext.requestId, baseUrl: settings.baseUrl, credential: apiKey, protocol: settings.protocol })
      if (input.signal?.aborted) { await budget?.cancelBeforeDispatch(); throwIfProviderAborted(input.signal) }
      for await (const chunk of provider.requestStream(input)) {
        if (signal?.aborted) {
          const error = /** @type {Error & { code?: string, errorClass?: string }} */ (new Error("provider stream cancelled"))
          error.code = "ABORT_ERR"
          error.errorClass = "aborted"
          throw error
        }
        if (chunk?.type === "usage") {
          usage = chunk.usage || null
          recordModelUsage({ requestId: requestContext.requestId, provider: settings.configKey, model: settings.model, usage })
        }
        if (chunk?.type === "stop") stopReason = chunk.reason || null
        yield chunk
      }
      streamCompleted = true
      await budget?.settle(usage, { complete: true })
      if (signal?.aborted) {
        const error = /** @type {Error & { code?: string, errorClass?: string }} */ (new Error("provider stream cancelled"))
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
      await budget?.settle(usage, { complete: streamCompleted })
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
  async function countTokensProvider({
    configState, providerType, model, system, messages, tools,
    baseUrl = null, apiKeyEnv = null,
    traceId = "", requestId = "", parentEventId = "",
    sessionId = null, turnId = null, reviewId = "", signal = null, allowRemote = false
  }) {
    const resolvedProviderType = providerType || configState.config.provider.default
    const settings = resolveSettings(configState, resolvedProviderType, { model, baseUrl, apiKeyEnv })
    assertProviderDataPolicy(configState, { providerName: settings.configKey, baseUrl: settings.baseUrl })
    const provider = registry.get(settings.providerType)
    if (!provider?.countTokens) return null
    // Existing normal conversations retain their inexpensive local estimate;
    // strict preflight and explicit SDK counting can use the current API.
    if (settings.protocol === 'responses' && !allowRemote && !hasRequestBudget()) return null
    // Count exactly the input the inference path can encode. In particular,
    // switching an audio/video conversation to Anthropic must not fail in
    // count_tokens before the inference guard can replace historical media.
    const guarded = await guardModelInput(configState, settings, messages, tools, { sessionId, turnId })
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
      messages: guarded.messages,
      tools: guarded.tools,
      protocol: settings.protocol,
      ...(settings.protocol === 'anthropic' && providerCfg.native_compaction === true ? { compaction: { trigger: providerCfg.compaction_trigger ?? 150000 } } : {}),
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
    const isRemoteCount = settings.protocol === "anthropic" || settings.protocol === 'responses'
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

  return {
    registerProvider,
    listProviders,
    getProvider,
    requestProvider,
    requestProviderStream,
    countTokensProvider
  }
}

const defaultProviderRegistry = createProviderRegistry()

const ALIAS_KEY = "kernel.singleton.provider-registry"
const ALIAS_MESSAGE = "模块级 provider 注册表已收编为 kernel 实例字段：新代码改用 createKernel() 句柄的 `providers` 命名空间"
const noteAlias = () => noteDeprecation(ALIAS_KEY, ALIAS_MESSAGE, { removal: "1.x" })

/** 兼容别名（deprecated）：注册进进程级默认注册表。旧 import 路径继续工作，调用经 deprecations.mjs 记录。 */
export function registerProvider(name, mod) {
  noteAlias()
  return runtimeDependency('providers', defaultProviderRegistry).registerProvider(name, mod)
}

/** 兼容别名（deprecated）。 */
export function listProviders() {
  noteAlias()
  return runtimeDependency('providers', defaultProviderRegistry).listProviders()
}

/** 兼容别名（deprecated）。 */
export function getProvider(name) {
  noteAlias()
  return runtimeDependency('providers', defaultProviderRegistry).getProvider(name)
}

/** 兼容别名（deprecated）。 */
export async function requestProvider(options) {
  noteAlias()
  return runtimeDependency('providers', defaultProviderRegistry).requestProvider(options)
}

/** 兼容别名（deprecated）。 */
export async function* requestProviderStream(options) {
  noteAlias()
  yield* runtimeDependency('providers', defaultProviderRegistry).requestProviderStream(options)
}

/** 兼容别名（deprecated）。 */
export async function countTokensProvider(options) {
  noteAlias()
  return runtimeDependency('providers', defaultProviderRegistry).countTokensProvider(options)
}
