import { ProviderError } from "../core/errors.mjs"
import { buildRequestHeaders } from "../http/identity.mjs"
import {
  annotateRetryAfter,
  primeRetriableStream,
  requestWithRetry,
  resolveRetryOptions
} from "./retry-policy.mjs"
import { parseSSE } from "./sse.mjs"

function mapTools(tools) {
  if (!tools || !tools.length) return undefined
  const mapped = tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }))
  // Cache tool definitions — they rarely change within a session
  if (mapped.length > 0) {
    mapped[mapped.length - 1].cache_control = { type: "ephemeral" }
  }
  return mapped
}

function mapContentBlock(block) {
  if (block.type === "image" && block.data) {
    return {
      type: "image_url",
      image_url: {
        url: `data:${block.mediaType || "image/png"};base64,${block.data}`
      }
    }
  }
  return { type: "text", text: String(block.text || block.content || "") }
}

function reasoningText(content) {
  return content
    .filter((block) => block?.type === "reasoning" || block?.type === "thinking")
    .map((block) => String(block.text || block.content || block.thinking || ""))
    .filter(Boolean)
    .join("")
}

function mapMessages(messages, { preserveReasoning = false } = {}) {
  const mapped = []
  for (const message of messages) {
    const content = message.content
    if (!Array.isArray(content)) {
      mapped.push({ role: message.role, content: String(content || "") })
      continue
    }

    // Check for native tool_use blocks (assistant message with tool calls)
    const toolUseBlocks = content.filter((b) => b.type === "tool_use")
    if (toolUseBlocks.length > 0 && message.role === "assistant") {
      const textParts = content.filter((b) => b.type === "text").map((b) => b.text || "").join("\n")
      const reasoning = preserveReasoning ? reasoningText(content) : ""
      mapped.push({
        role: "assistant",
        content: textParts || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        tool_calls: toolUseBlocks.map((b) => ({
          id: b.id,
          type: "function",
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input || {})
          }
        }))
      })
      continue
    }

    // Check for tool_result blocks (user message with tool results)
    const toolResultBlocks = content.filter((b) => b.type === "tool_result")
    if (toolResultBlocks.length > 0) {
      for (const result of toolResultBlocks) {
        mapped.push({
          role: "tool",
          tool_call_id: result.tool_use_id,
          content: String(result.content || "")
        })
      }
      // 图片必须单独补一条 user 消息。OpenAI 的 role:"tool" 消息只接受字符串
      // content，装不了 image_url —— 而 0.6.8 起 read 读到的图片正是挂在
      // tool_result 之后的同一条消息里。此前这里直接 continue，把它们连同
      // 整条消息一起丢掉：图片在会话历史里完好，却从未进入请求，于是模型
      // 只看到那行 `Image file: x.png (137 bytes)`，「可视觉分析」是句空话。
      const imageBlocks = content.filter((b) => b.type === "image" && b.data)
      if (imageBlocks.length > 0) {
        mapped.push({
          role: "user",
          content: imageBlocks.map(mapContentBlock)
        })
      }
      continue
    }

    // Regular array content (images, text). Kimi reasoning is a top-level
    // assistant field, not a visible OpenAI content block.
    const visibleContent = content.filter((block) => block?.type !== "reasoning" && block?.type !== "thinking")
    const reasoning = preserveReasoning && message.role === "assistant" ? reasoningText(content) : ""
    mapped.push({
      role: message.role,
      content: visibleContent.map(mapContentBlock),
      ...(reasoning ? { reasoning_content: reasoning } : {})
    })
  }

  // Add cache_control to the last user message for multi-turn caching
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

  return mapped
}

function parseToolCalls(message) {
  if (!Array.isArray(message?.tool_calls)) return []
  return message.tool_calls
    .filter((call) => call?.function?.name)
    .map((call) => {
      const raw = call.function.arguments || "{}"
      let args = {}
      try {
        args = JSON.parse(raw)
      } catch (parseErr) {
        console.error(`[openai] tool_call JSON parse failed for "${call.function.name}": ${parseErr.message} (${raw.length} chars, first 200: ${raw.slice(0, 200)})`)
        args = { __parse_error: true, __raw_length: raw.length, __error: parseErr.message }
      }
      return {
        id: call.id || `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: call.function.name,
        args
      }
    })
}

// Build system messages from structured blocks with cache_control markers.
// Stable content gets cache_control for prompt caching (OpenAI auto-cache + Qwen/compatible explicit cache).
function buildSystemMessages(system) {
  if (!system) return []
  if (system.blocks && Array.isArray(system.blocks)) {
    const stable = []
    const dynamic = []
    for (const block of system.blocks) {
      if (block.cacheable) stable.push(block.text)
      else dynamic.push(block.text)
    }
    const msgs = []
    if (stable.length) {
      msgs.push({
        role: "system",
        content: [{
          type: "text",
          text: stable.join("\n\n"),
          cache_control: { type: "ephemeral" }
        }]
      })
    }
    if (dynamic.length) msgs.push({ role: "system", content: dynamic.join("\n\n") })
    return msgs
  }
  const text = typeof system === "string" ? system : system.text || String(system)
  if (!text) return []
  return [{
    role: "system",
    content: [{ type: "text", text, cache_control: { type: "ephemeral" } }]
  }]
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
    return await fetch(endpoint, { ...init, signal: fetchSignal })
  } catch (error) {
    if (timedOut && !signal?.aborted) {
      const timeoutError = new Error(`openai connection timeout after ${timeout}ms`, { cause: error })
      timeoutError.name = "TimeoutError"
      timeoutError.code = "ETIMEDOUT"
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function countTokensOpenAI(input) {
  // Chat Completions has no portable count-only endpoint. A one-token
  // completion adds latency and billable usage, so callers use local estimates.
  void input
  return null
}

export async function requestOpenAI(input) {
  const { apiKey, baseUrl, model, system, messages, tools, timeoutMs = 120000, maxTokens, reasoningEffort = null, retry = {}, signal = null } = input
  if (!apiKey && input.apiKeyEnv !== "") {
    throw new ProviderError(`missing API key for openai provider (env: ${input.apiKeyEnv || "unknown"})`, {
      provider: "openai"
    })
  }

  const payload = {
    model,
    messages: [
      ...buildSystemMessages(system),
      ...mapMessages(messages, { preserveReasoning: Boolean(input.provider && input.provider !== "openai") })
    ],
    tools: mapTools(tools),
    tool_choice: tools?.length ? "auto" : undefined,
    ...(reasoningEffort && reasoningEffort !== "none" ? { reasoning_effort: reasoningEffort } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(Number.isFinite(input.temperature) ? { temperature: input.temperature } : {})
  }
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`

  return requestWithRetry({
    ...resolveRetryOptions(retry),
    baseDelayMs: Number(retry.baseDelayMs ?? 800),
    signal,
    onRetry: retry.onRetry,
    execute: async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: buildRequestHeaders({
          target: "llm",
          provider: input.provider || "openai",
          protocol: input.protocol || "openai",
          requestId: input.requestId || "",
          openAIClientRequestId: true,
          accept: "application/json",
          contentType: "application/json",
          authorization: apiKey ? `Bearer ${apiKey}` : ""
        }),
        body: JSON.stringify(payload),
        signal: timeoutSignal(timeoutMs, signal)
      })
      notifyResponse(input, response)

      if (!response.ok) {
        const text = await response.text().catch(() => "")
        const error = new ProviderError(`openai request failed: ${response.status} ${text}`, {
          provider: "openai",
          model,
          endpoint
        })
        error.httpStatus = response.status
        annotateRetryAfter(error, response)
        throw error
      }

      let json
      try {
        json = await response.json()
      } catch (parseErr) {
        throw new ProviderError(`openai response JSON parse failed: ${parseErr.message}`, { provider: "openai", model, endpoint })
      }
      const message = json?.choices?.[0]?.message ?? {}
      const promptTokens = json?.usage?.prompt_tokens ?? 0
      const details = json?.usage?.prompt_tokens_details || {}
      const cachedTokens = details.cached_tokens ?? 0
      const cacheWriteTokens = details.cache_creation_input_tokens ?? 0
      const usage = {
        input: promptTokens - cachedTokens,
        output: json?.usage?.completion_tokens ?? 0,
        cacheRead: cachedTokens,
        cacheWrite: cacheWriteTokens
      }
      const toolCalls = parseToolCalls(message)
      const text = typeof message.content === "string" ? message.content : ""
      const reasoning = typeof message.reasoning_content === "string"
        ? message.reasoning_content
        : typeof message.reasoning === "string" ? message.reasoning : ""
      return { text, reasoning, usage, toolCalls }
    }
  })
}

export async function* requestOpenAIStream(input) {
  const { apiKey, baseUrl, model, system, messages, tools, timeoutMs = 120000, streamIdleTimeoutMs = 120000, maxTokens, reasoningEffort = null, retry = {}, signal = null } = input
  if (!apiKey && input.apiKeyEnv !== "") {
    throw new ProviderError(`missing API key for openai provider (env: ${input.apiKeyEnv || "unknown"})`, {
      provider: "openai"
    })
  }

  if (!retry._streamPrimed) {
    const { iterator, first } = await primeRetriableStream({
      create: () => requestOpenAIStream({
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

  const payload = {
    model,
    messages: [
      ...buildSystemMessages(system),
      ...mapMessages(messages, { preserveReasoning: Boolean(input.provider && input.provider !== "openai") })
    ],
    tools: mapTools(tools),
    tool_choice: tools?.length ? "auto" : undefined,
    ...(reasoningEffort && reasoningEffort !== "none" ? { reasoning_effort: reasoningEffort } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(Number.isFinite(input.temperature) ? { temperature: input.temperature } : {}),
    stream: true,
    stream_options: { include_usage: true }
  }
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`
  const response = await requestWithRetry({
    attempts: Number(retry.attempts ?? 5),
    baseDelayMs: Number(retry.baseDelayMs ?? 800),
    signal,
    onRetry: retry.onRetry,
    execute: async () => {
      const candidate = await fetchStreamConnection(endpoint, {
        method: "POST",
        headers: buildRequestHeaders({
          target: "llm",
          provider: input.provider || "openai",
          protocol: input.protocol || "openai",
          requestId: input.requestId || "",
          openAIClientRequestId: true,
          accept: "text/event-stream, application/json",
          contentType: "application/json",
          authorization: apiKey ? `Bearer ${apiKey}` : ""
        }),
        body: JSON.stringify(payload)
      }, timeoutMs, signal)
      notifyResponse(input, candidate)

      if (!candidate.ok) {
        const text = await candidate.text().catch(() => "")
        const error = new ProviderError(`openai stream failed: ${candidate.status} ${text}`, {
          provider: "openai", model, endpoint
        })
        error.httpStatus = candidate.status
        annotateRetryAfter(error, candidate)
        throw error
      }
      return candidate
    }
  })

  const toolBuffers = new Map()
  let finishReason = null
  let sawValidSseEvent = false

  for await (const { data } of parseSSE(response.body, signal, { idleTimeoutMs: streamIdleTimeoutMs })) {
    let json
    try { json = JSON.parse(data) } catch { continue }
    sawValidSseEvent = true

    if (json.usage) {
      const pt = json.usage.prompt_tokens ?? 0
      const details = json.usage.prompt_tokens_details || {}
      const ct = details.cached_tokens ?? 0
      const cw = details.cache_creation_input_tokens ?? 0
      yield {
        type: "usage",
        usage: { input: pt - ct, output: json.usage.completion_tokens ?? 0, cacheRead: ct, cacheWrite: cw }
      }
    }

    const choice = json.choices?.[0]
    if (choice?.finish_reason) {
      finishReason = choice.finish_reason
    }
    const delta = choice?.delta
    if (!delta) continue

    if (delta.content) {
      yield { type: "text", content: delta.content }
    }

    const reasoning = typeof delta.reasoning_content === "string"
      ? delta.reasoning_content
      : typeof delta.reasoning === "string" ? delta.reasoning
        : typeof delta.thinking === "string" ? delta.thinking : ""
    if (reasoning) {
      // Keep the established stream contract while identifying the native
      // provider field for typed transcript consumers.
      yield { type: "thinking", content: reasoning, source: "reasoning_content" }
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        if (!toolBuffers.has(idx)) {
          toolBuffers.set(idx, { id: "", name: "", argsJson: "" })
        }
        const buf = toolBuffers.get(idx)
        if (tc.id) buf.id = tc.id
        if (tc.function?.name) buf.name = tc.function.name
        if (tc.function?.arguments) buf.argsJson += tc.function.arguments
      }
    }
  }

  if (!sawValidSseEvent) {
    const error = new Error("openai stream closed before the first valid SSE event")
    error.errorClass = "transient"
    throw error
  }

  for (const [, buf] of toolBuffers) {
    const raw = buf.argsJson || "{}"
    let args = {}
    try {
      args = JSON.parse(raw)
    } catch (parseErr) {
      console.error(`[openai] tool_call JSON parse failed for "${buf.name}": ${parseErr.message} (${raw.length} chars, first 200: ${raw.slice(0, 200)})`)
      args = { __parse_error: true, __raw_length: raw.length, __error: parseErr.message }
    }
    yield {
      type: "tool_call",
      call: {
        id: buf.id || `tc_${Date.now()}`,
        name: buf.name,
        args
      }
    }
  }

  // Normalize: "stop" → "end_turn", "length" → "max_tokens", "tool_calls" → "tool_use"
  const normalizedReason = finishReason === "length" ? "max_tokens"
    : finishReason === "tool_calls" ? "tool_use"
    : finishReason === "stop" ? "end_turn"
    : finishReason || "end_turn"
  yield { type: "stop", reason: normalizedReason }
}
