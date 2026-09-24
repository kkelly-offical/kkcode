import { ProviderError } from "../core/errors.mjs"
import { buildRequestHeaders } from "../../http/identity.mjs"
import {
  annotateRetryAfter,
  primeRetriableStream,
  requestWithRetry,
  resolveRetryOptions
} from "./retry-policy.mjs"
import { parseSSE } from "./sse.mjs"
import { createAnthropicState, replayAnthropicState } from './anthropic-state.mjs'

function compactionEdit(input) {
  if (!input.compaction) return null
  const trigger = Number(input.compaction.trigger ?? 150000)
  if (!input.apiKey || !Number.isSafeInteger(trigger) || trigger < 50000) {
    throw new ProviderError('Anthropic native compaction requires an authenticated channel and an input token trigger of at least 50000', { reason: 'unsupported_capability' })
  }
  return { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: trigger } }] }
}

function nativeUsage(usage = {}) {
  // Top-level usage excludes compaction iterations. Sum the provider's full
  // iteration list when present, not the total plus its parts.
  const rows = Array.isArray(usage.iterations) && usage.iterations.length ? usage.iterations : [usage]
  return markUsageEvidence(rows.reduce((total, row) => ({
    input: total.input + (Number(row.input_tokens) || 0), output: total.output + (Number(row.output_tokens) || 0),
    cacheRead: total.cacheRead + (Number(row.cache_read_input_tokens) || 0), cacheWrite: total.cacheWrite + (Number(row.cache_creation_input_tokens) || 0)
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), rows.flatMap(row => [row.input_tokens, row.output_tokens]),
    rows.flatMap(row => [row.cache_read_input_tokens, row.cache_creation_input_tokens]))
}

function contextUsage(usage = {}) {
  const last = Array.isArray(usage.iterations) && usage.iterations.findLast(row => row.type === 'message')
  return nativeUsage(last || { ...usage, iterations: undefined })
}

function nativeError(message) {
  return new ProviderError(`anthropic invalid compaction response: ${message}`, { reason: 'invalid_provider_response' })
}

function validateCompactions(items, enabled) {
  for (const item of items) if (item?.type === 'compaction') {
    if (!enabled || typeof item.content !== 'string' || !item.content.trim()) throw nativeError('missing, empty or unsolicited summary')
  }
}

function isUnsupportedCompaction(status, text) {
  return [400, 422].includes(status) && /compact(?:ion|_20260112)|context_management|compact-2026-01-12/i.test(text)
    && /not supported|unsupported|unrecognized|unknown|not permitted|extra inputs|not allowed/i.test(text)
}

function assertNativeFallbackSafe(input) {
  if (input.messages.some((_message, index) => replayAnthropicState(input, index))) {
    // Counting used the reduced native context. Expanding retained originals
    // behind that budget would be an unbudgeted request: return to the kernel's
    // client-compaction + complete-budget path instead.
    throw Object.assign(nativeError('channel no longer accepts persisted native context; client compaction is required before retrying'), { needsCompaction: true })
  }
}

function mapTools(tools) {
  if (!tools || !tools.length) return []
  const mapped = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  }))
  // Cache the tool definitions (they rarely change within a session)
  if (mapped.length > 0) {
    mapped[mapped.length - 1].cache_control = { type: "ephemeral" }
  }
  return mapped
}

function systemWithCacheControl(system) {
  if (!system) return undefined

  // Structured format from buildSystemPromptBlocks: { text, blocks }
  // Strategy: merge all stable content into ONE block with cache_control,
  // keeping dynamic content separate. Combined with the tool breakpoint in
  // mapTools, this gives us 2 breakpoints total — well within the 4-max limit
  // and ensures the cumulative prefix easily exceeds the minimum cacheable
  // threshold (4096 tokens for Opus, 1024 for Sonnet).
  if (system.blocks && Array.isArray(system.blocks)) {
    const stableParts = []
    const dynamicParts = []
    for (const block of system.blocks) {
      if (block.cacheable === false) {
        dynamicParts.push(block.text)
      } else {
        stableParts.push(block.text)
      }
    }

    const contentBlocks = []
    if (stableParts.length) {
      contentBlocks.push({
        type: "text",
        text: stableParts.join("\n\n"),
        cache_control: { type: "ephemeral" }
      })
    }
    if (dynamicParts.length) {
      contentBlocks.push({ type: "text", text: dynamicParts.join("\n\n") })
    }
    return contentBlocks.length ? contentBlocks : undefined
  }

  // Legacy: plain string
  if (typeof system === "string") {
    return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
  }
  // Legacy: array of strings/blocks
  if (Array.isArray(system)) {
    const blocks = system.map((b) => (typeof b === "string" ? { type: "text", text: b } : { ...b }))
    if (blocks.length > 0) {
      blocks[blocks.length - 1].cache_control = { type: "ephemeral" }
    }
    return blocks
  }
  return system
}

function mapContentBlock(block) {
  if (block.type === 'audio' || block.type === 'video') {
    throw new ProviderError(`anthropic does not encode ${block.type} input; choose an OpenAI-compatible media channel`, { reason: 'unsupported_capability', capability: block.type })
  }
  if (block.type === "image" && block.data) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: block.mediaType || "image/png",
        data: block.data
      }
    }
  }
  // Native Anthropic tool_use block — pass through
  if (block.type === "tool_use") {
    return { type: "tool_use", id: block.id, name: block.name, input: block.input || {} }
  }
  // Native Anthropic tool_result block — pass through
  if (block.type === "tool_result") {
    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: String(block.content || ""),
      ...(block.is_error ? { is_error: true } : {})
    }
  }
  return { type: "text", text: String(block.text || block.content || "") }
}

function mapMessages(input) {
  const messages = input.messages
  let compactedAt = -1
  const mapped = messages.map((message, index) => {
    const role = message.role === "assistant" ? "assistant" : "user"
    const content = message.content
    const native = input.compaction && replayAnthropicState(input, index)
    if (native) {
      compactedAt = index
      const offset = native.findLastIndex(block => block.type === 'compaction')
      return { role, content: native.slice(offset) }
    }
    if (Array.isArray(content)) {
      // Provider-native reasoning cannot safely cross provider boundaries.
      // Anthropic thinking blocks require signatures, so unsigned persisted
      // reasoning is intentionally omitted rather than exposed as visible text.
      return {
        role,
        content: content
          .filter((block) => !['reasoning', 'thinking', 'provider_state', 'compaction'].includes(block?.type))
          .map(mapContentBlock)
      }
    }
    return { role, content: String(content || "") }
  })
  // Add cache_control to last user message for multi-turn caching
  for (let i = mapped.length - 1; i >= 0; i--) {
    if (mapped[i].role === "user") {
      const c = mapped[i].content
      if (Array.isArray(c) && c.length) {
        c[c.length - 1].cache_control = { type: "ephemeral" }
      } else if (typeof c === "string") {
        mapped[i].content = [{ type: "text", text: c, cache_control: { type: "ephemeral" } }]
      }
      break
    }
  }
  return (compactedAt >= 0 ? mapped.slice(compactedAt) : mapped).filter(message => !Array.isArray(message.content) || message.content.length)
}

function parseContentBlocks(content) {
  const blocks = Array.isArray(content) ? content : []
  const text = blocks.filter((block) => block.type === "text").map((block) => block.text || "").join("\n")
  const reasoning = blocks
    .filter((block) => block.type === "thinking" || block.type === "redacted_thinking")
    .map((block) => block.type === "thinking" && typeof block.thinking === "string" ? block.thinking : "")
    .filter(Boolean)
    .join("\n")
  const toolCalls = blocks
    .filter((block) => block.type === "tool_use" && block.name)
    .map((block) => ({
      id: block.id || `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: block.name,
      args: block.input || {}
    }))
  return { text, reasoning, toolCalls }
}

function timeoutSignal(ms, parentSignal = null) {
  const own = AbortSignal.timeout(ms)
  if (!parentSignal) return own
  return AbortSignal.any([parentSignal, own])
}

function notifyResponse(input, response) {
  try { input.onResponse?.(response) } catch { /* audit metadata must not affect requests */ }
}

async function fetchStreamConnection(endpoint, init, timeoutMs, signal) {
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : 120000
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)
  const fetchSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal

  try {
    return await fetch(endpoint, { ...init, redirect: 'error', signal: fetchSignal })
  } catch (error) {
    if (timedOut && !signal?.aborted) {
      const timeoutError = /** @type {Error & { code: string }} */ (new Error(`anthropic connection timeout after ${timeout}ms`, { cause: error }))
      timeoutError.name = "TimeoutError"
      timeoutError.code = "ETIMEDOUT"
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function requestAnthropic(input) {
  const { apiKey, baseUrl, model, system, messages, tools, timeoutMs = 120000, maxTokens = 16384, retry = {}, signal = null } = input
  if (!apiKey && input.apiKeyEnv !== "") {
    throw new ProviderError(`missing API key for anthropic provider (env: ${input.apiKeyEnv || "unknown"})`, {
      provider: "anthropic"
    })
  }

  const endpoint = `${baseUrl.replace(/\/$/, "")}/messages`
  const mappedTools = mapTools(tools)
  const payload = /** @type {Record<string, any>} */ ({
    model,
    max_tokens: maxTokens,
    ...(Number.isFinite(input.temperature) ? { temperature: input.temperature } : {}),
    metadata: { user_id: "kkcode" },
    system: systemWithCacheControl(system),
    messages: mapMessages(input),
    tools: mappedTools.length ? mappedTools : undefined,
    ...(input.compaction ? { context_management: compactionEdit(input) } : {})
  })
  if (input.thinking?.type) {
    payload.thinking = { type: input.thinking.type, budget_tokens: input.thinking.budget_tokens || 10000 }
  }

  return requestWithRetry({
    ...resolveRetryOptions(retry),
    baseDelayMs: Number(retry.baseDelayMs ?? 800),
    signal,
    onRetry: retry.onRetry,
    execute: async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: 'error',
        headers: buildRequestHeaders({
          target: "llm",
          provider: input.provider || "anthropic",
          protocol: input.protocol || "anthropic",
          requestId: input.requestId || "",
          accept: "application/json",
          contentType: "application/json",
          customHeaders: {
            ...(apiKey ? { "x-api-key": apiKey } : {}),
            "anthropic-version": "2023-06-01",
            "anthropic-beta": input.compaction ? "prompt-caching-2024-07-31,compact-2026-01-12" : "prompt-caching-2024-07-31"
          }
        }),
        body: JSON.stringify(payload),
        signal: timeoutSignal(timeoutMs, signal)
      })
      notifyResponse(input, response)
      if (!response.ok) {
        const text = await response.text().catch(() => "")
        const error = /** @type {ProviderError & { httpStatus?: number, nativeCompactionUnsupported?: boolean }} */ (new ProviderError(`anthropic request failed: ${response.status} ${text}`, {
          provider: "anthropic",
          model,
          endpoint
        }))
        error.httpStatus = response.status
        error.nativeCompactionUnsupported = isUnsupportedCompaction(response.status, text)
        annotateRetryAfter(error, response)
        throw error
      }
      let json
      try {
        json = await response.json()
      } catch (parseErr) {
        throw new ProviderError('anthropic response JSON parse failed: invalid JSON', { provider: "anthropic", model, endpoint })
      }
      const parsed = parseContentBlocks(json?.content)
      validateCompactions(json?.content || [], input.compaction)
      const visible = [{ type: 'text', text: parsed.text }, ...parsed.toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args }))]
      return { text: parsed.text, reasoning: parsed.reasoning, usage: markUsageIdentity(nativeUsage(json?.usage), { model: json.model, tier: json.service_tier ?? json.usage?.service_tier }), toolCalls: parsed.toolCalls,
        contextUsage: contextUsage(json?.usage), stopReason: json?.stop_reason || 'end_turn', providerState: createAnthropicState(input, json?.content || [], visible) }
    }
  }).catch(error => {
    // Only an explicit pre-response capability rejection may fall back. Never
    // reinterpret a partial stream, timeout or arbitrary 400 as safe replay.
    if (input.compaction && error.nativeCompactionUnsupported) {
      assertNativeFallbackSafe(input)
      return requestAnthropic({ ...input, compaction: null })
    }
    throw error
  })
}

export async function countTokensAnthropic(input) {
  const { apiKey, baseUrl, model, system, messages, tools, timeoutMs = 10000 } = input
  if (!apiKey && input.apiKeyEnv !== "") return null
  const endpoint = `${baseUrl.replace(/\/$/, "")}/messages/count_tokens`
  const mappedTools = mapTools(tools)
  const payload = {
    model,
    system: systemWithCacheControl(system),
    messages: mapMessages(input),
    tools: mappedTools.length ? mappedTools : undefined,
    ...(input.compaction ? { context_management: compactionEdit(input) } : {})
  }
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      redirect: 'error',
      headers: buildRequestHeaders({
        target: "llm-token-count",
        provider: input.provider || "anthropic",
        protocol: input.protocol || "anthropic",
        requestId: input.requestId || "",
        accept: "application/json",
        contentType: "application/json",
        customHeaders: {
          ...(apiKey ? { "x-api-key": apiKey } : {}),
          "anthropic-version": "2023-06-01",
          ...(input.compaction ? { 'anthropic-beta': 'compact-2026-01-12' } : {})
        }
      }),
      body: JSON.stringify(payload),
      signal: timeoutSignal(timeoutMs, input.signal || null)
    })
    notifyResponse(input, res)
    if (!res.ok) return null
    const json = await res.json()
    return json?.input_tokens ?? null
  } catch {
    return null
  }
}

export async function* requestAnthropicStream(input) {
  const { apiKey, baseUrl, model, system, messages, tools, timeoutMs = 120000, streamIdleTimeoutMs = 120000, maxTokens = 16384, retry = {}, signal = null, compaction = null } = input
  if (!apiKey && input.apiKeyEnv !== "") {
    throw new ProviderError(`missing API key for anthropic provider (env: ${input.apiKeyEnv || "unknown"})`, {
      provider: "anthropic"
    })
  }

  if (!retry._streamPrimed) {
    const { iterator, first } = await primeRetriableStream({
      create: () => requestAnthropicStream({
        ...input,
        retry: {
          attempts: 1,
          baseDelayMs: retry.baseDelayMs,
          _streamPrimed: true
        }
      }),
      ...resolveRetryOptions(retry),
      baseDelayMs: Number(retry.baseDelayMs ?? 800),
      signal,
      onRetry: retry.onRetry
    })
    try {
      yield first.value
      while (true) {
        const next = await iterator.next()
        if (next.done) break
        yield next.value
      }
    } finally {
      try { await iterator.return?.() } catch { /* stream is already closing */ }
    }
    return
  }

  const endpoint = `${baseUrl.replace(/\/$/, "")}/messages`
  const mappedTools = mapTools(tools)
  const payload = /** @type {Record<string, any>} */ ({
    model,
    max_tokens: maxTokens,
    ...(Number.isFinite(input.temperature) ? { temperature: input.temperature } : {}),
    metadata: { user_id: "kkcode" },
    system: systemWithCacheControl(system),
    messages: mapMessages(input),
    tools: mappedTools.length ? mappedTools : undefined,
    stream: true,
    ...(compaction ? { context_management: compactionEdit(input) } : {})
  })
  if (input.thinking?.type) {
    payload.thinking = { type: input.thinking.type, budget_tokens: input.thinking.budget_tokens || 10000 }
  }
  let response
  try { response = await requestWithRetry({
    attempts: Number(retry.attempts ?? 5),
    baseDelayMs: Number(retry.baseDelayMs ?? 800),
    signal,
    onRetry: retry.onRetry,
    execute: async () => {
      const candidate = await fetchStreamConnection(endpoint, {
        method: "POST",
        headers: buildRequestHeaders({
          target: "llm",
          provider: input.provider || "anthropic",
          protocol: input.protocol || "anthropic",
          requestId: input.requestId || "",
          accept: "text/event-stream, application/json",
          contentType: "application/json",
          customHeaders: {
            ...(apiKey ? { "x-api-key": apiKey } : {}),
            "anthropic-version": "2023-06-01",
            "anthropic-beta": compaction ? "prompt-caching-2024-07-31,compact-2026-01-12" : "prompt-caching-2024-07-31"
          }
        }),
        body: JSON.stringify(payload)
      }, timeoutMs, signal)
      notifyResponse(input, candidate)

      if (!candidate.ok) {
        const text = await candidate.text().catch(() => "")
        const error = /** @type {ProviderError & { httpStatus?: number, nativeCompactionUnsupported?: boolean }} */ (new ProviderError(`anthropic stream failed: ${candidate.status} ${text}`, {
          provider: "anthropic", model, endpoint
        }))
        error.httpStatus = candidate.status
        error.nativeCompactionUnsupported = isUnsupportedCompaction(candidate.status, text)
        annotateRetryAfter(error, candidate)
        throw error
      }
      return candidate
    }
  }) } catch (error) {
    if (compaction && error.nativeCompactionUnsupported) {
      assertNativeFallbackSafe(input)
      yield* requestAnthropicStream({ ...input, compaction: null })
      return
    }
    throw error
  }

  let currentBlock = null
  let inputUsage = { input: 0, cacheRead: 0, cacheWrite: 0 }
  let rawInputUsage = null, rawOutputTokens
  let billingModel, billingTier, billingIdentityChanged = false
  let outputTokens = 0
  let stopReason = null
  let stopped = false
  const nativeBlocks = []
  let responseText = ''
  const responseCalls = []
  let iterations = null

  for await (const { event, data } of parseSSE(response.body, signal, { idleTimeoutMs: streamIdleTimeoutMs })) {
    let parsed
    try { parsed = JSON.parse(data) } catch { continue }
    if (event === 'error') throw new ProviderError('anthropic stream returned an error event; incomplete response was not committed', { reason: 'invalid_provider_response' })

    if (event === "message_start") {
      const u = parsed.message?.usage
      rawInputUsage = u
      const nextModel = parsed.message?.model, nextTier = parsed.message?.service_tier ?? u?.service_tier
      if (billingModel !== undefined && billingModel !== nextModel || billingTier !== undefined && nextTier !== undefined && billingTier !== nextTier) billingIdentityChanged = true
      billingModel = nextModel; billingTier = nextTier
      inputUsage.input = u?.input_tokens ?? 0
      inputUsage.cacheRead = u?.cache_read_input_tokens ?? 0
      inputUsage.cacheWrite = u?.cache_creation_input_tokens ?? 0
    }

    if (event === "content_block_start") {
      if (currentBlock) throw nativeError('overlapping content blocks')
      const block = parsed.content_block
      currentBlock = {
        type: block?.type,
        id: block?.id || null,
        name: block?.name || null,
        jsonParts: [], native: structuredClone(block)
      }
    }

    if (event === "content_block_delta") {
      if (parsed.delta?.type === "text_delta") {
        const text = parsed.delta.text || ""
        responseText += text
        if (currentBlock?.native?.type === 'text') currentBlock.native.text = (currentBlock.native.text || '') + text
        if (text) yield { type: "text", content: text }
      }
      if (parsed.delta?.type === "thinking_delta" && currentBlock?.type !== "redacted_thinking") {
        const thinking = parsed.delta.thinking || ""
        if (currentBlock?.native?.type === 'thinking') currentBlock.native.thinking = (currentBlock.native.thinking || '') + thinking
        if (thinking) yield { type: "thinking", content: thinking }
      }
      if (parsed.delta?.type === "input_json_delta") {
        if (currentBlock) currentBlock.jsonParts.push(parsed.delta.partial_json || "")
      }
      if (parsed.delta?.type === "compaction_delta") {
        // Threshold compaction sends exactly ONE complete-summary delta.
        if (currentBlock?.type !== 'compaction' || currentBlock.compactionReceived) throw nativeError('unexpected or duplicate summary delta')
        currentBlock.compactionReceived = true
        currentBlock.native.content = parsed.delta.content
      }
      if (parsed.delta?.type === 'signature_delta' && currentBlock?.type === 'thinking') currentBlock.native.signature = (currentBlock.native.signature || '') + (parsed.delta.signature || '')
    }

    if (event === "content_block_stop" && currentBlock) {
      if (currentBlock.type === "tool_use") {
        const raw = currentBlock.jsonParts.join("") || "{}"
        let args = {}
        try {
          args = JSON.parse(raw)
        } catch (parseErr) {
          console.error(`[anthropic] tool_call JSON parse failed (${raw.length} chars; argument contents omitted)`)
          args = { __parse_error: true, __raw_length: raw.length, __error: 'invalid JSON arguments' }
        }
        currentBlock.native.input = args
        responseCalls.push({ type: 'tool_use', id: currentBlock.id, name: currentBlock.name, input: args })
        yield {
          type: "tool_call",
          call: {
            id: currentBlock.id || `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: currentBlock.name,
            args
          }
        }
      }
      if (currentBlock.type === "compaction") {
        validateCompactions([currentBlock.native], compaction)
        yield { type: "compaction", content: currentBlock.native.content }
      }
      nativeBlocks.push(currentBlock.native)
      currentBlock = null
    }

    if (event === "message_delta") {
      outputTokens = parsed.usage?.output_tokens ?? outputTokens
      if (parsed.usage?.output_tokens !== undefined) rawOutputTokens = parsed.usage.output_tokens
      if (parsed.usage?.service_tier !== undefined) { if (billingTier !== undefined && billingTier !== parsed.usage.service_tier) billingIdentityChanged = true; billingTier = parsed.usage.service_tier }
      if (Array.isArray(parsed.usage?.iterations)) iterations = parsed.usage.iterations
      // 与 openai 侧同一条纪律：第一个非空 stop_reason 为准，迟到的重复帧
      // 不得把 end_turn 改写成 max_tokens（那会误触发 auto-continue）。
      if (parsed.delta?.stop_reason && stopReason === null) {
        stopReason = parsed.delta.stop_reason
      }
    }

    if (event === "message_stop") {
      if (stopped) continue
      if (currentBlock) {
        // Some established Anthropic-compatible gateways use message_stop as
        // the final text block terminator. Preserve that text-only behavior,
        // but never infer completion of tools, signatures or native state.
        if (currentBlock.type !== 'text' || nativeBlocks.some(block => block?.type === 'compaction')) {
          throw nativeError('message ended with an incomplete block')
        }
        currentBlock = null
      }
      stopped = true
      const state = createAnthropicState(input, nativeBlocks, [{ type: 'text', text: responseText }, ...responseCalls])
      if (state) yield { type: 'provider_state', state }
      yield {
        type: "usage",
        ...(iterations ? { contextUsage: contextUsage({ iterations }) } : {}),
        usage: markUsageIdentity(iterations ? nativeUsage({ iterations }) : markUsageEvidence({
          input: inputUsage.input,
          output: outputTokens,
          cacheRead: inputUsage.cacheRead,
          cacheWrite: inputUsage.cacheWrite
        }, [rawInputUsage?.input_tokens, rawOutputTokens], [rawInputUsage?.cache_read_input_tokens, rawInputUsage?.cache_creation_input_tokens]), { model: billingIdentityChanged ? null : billingModel, tier: billingTier })
      }
      // Normalize: "end_turn" → "end_turn", "max_tokens" → "max_tokens", "tool_use" → "tool_use"
      yield { type: "stop", reason: stopReason || "end_turn" }
    }
  }
  if (!stopped) throw new ProviderError('anthropic stream ended before message_stop; response is incomplete', { reason: 'incomplete_response' })
}
import { markUsageEvidence, markUsageIdentity } from '../../usage/usage-evidence.mjs'
