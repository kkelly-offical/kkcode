import { ProviderError } from "../core/errors.mjs"
import { requestWithRetry } from "./retry-policy.mjs"
import { parseSSE } from "./sse.mjs"

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function mapTools(tools) {
  if (!tools || !tools.length) return undefined
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }))
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

function mapMessages(messages) {
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
      mapped.push({
        role: "assistant",
        content: textParts || null,
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
      continue
    }

    // Regular array content (images, text)
    mapped.push({ role: message.role, content: content.map(mapContentBlock) })
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

// Build system messages from structured blocks for optimal prefix caching.
// OpenAI auto-caches matching prefixes — stable content first, dynamic last.
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
    if (stable.length) msgs.push({ role: "system", content: stable.join("\n\n") })
    if (dynamic.length) msgs.push({ role: "system", content: dynamic.join("\n\n") })
    return msgs
  }
  const text = typeof system === "string" ? system : system.text || String(system)
  return text ? [{ role: "system", content: text }] : []
}

function timeoutSignal(ms, parentSignal = null) {
  const own = AbortSignal.timeout(ms)
  if (!parentSignal) return own
  return AbortSignal.any([parentSignal, own])
}

export async function requestOpenAI(input) {
  const { apiKey, baseUrl, model, system, messages, tools, timeoutMs = 120000, maxTokens, retry = {}, signal = null } = input
  if (!apiKey) {
    throw new ProviderError(`missing API key for openai provider (env: ${input.apiKeyEnv || "unknown"})`, {
      provider: "openai"
    })
  }

  const payload = {
    model,
    messages: [...buildSystemMessages(system), ...mapMessages(messages)],
    tools: mapTools(tools),
    tool_choice: tools?.length ? "auto" : undefined,
    ...(maxTokens ? { max_tokens: maxTokens } : {})
  }
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`

  return requestWithRetry({
    attempts: Number(retry.attempts ?? 3),
    baseDelayMs: Number(retry.baseDelayMs ?? 800),
    signal,
    execute: async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload),
        signal: timeoutSignal(timeoutMs, signal)
      })

      if (!response.ok) {
        const text = await response.text().catch(() => "")
        const error = new ProviderError(`openai request failed: ${response.status} ${text}`, {
          provider: "openai",
          model,
          endpoint
        })
        error.httpStatus = response.status
        throw error
      }

      const json = await response.json()
      const message = json?.choices?.[0]?.message ?? {}
      const promptTokens = json?.usage?.prompt_tokens ?? 0
      const cachedTokens = json?.usage?.prompt_tokens_details?.cached_tokens ?? 0
      const usage = {
        input: promptTokens - cachedTokens,
        output: json?.usage?.completion_tokens ?? 0,
        cacheRead: cachedTokens,
        cacheWrite: 0
      }
      const toolCalls = parseToolCalls(message)
      const text = typeof message.content === "string" ? message.content : ""
      return { text, usage, toolCalls }
    }
  })
}

export async function* requestOpenAIStream(input) {
  const { apiKey, baseUrl, model, system, messages, tools, timeoutMs = 120000, streamIdleTimeoutMs = 120000, maxTokens, retry = {}, signal = null } = input
  if (!apiKey) {
    throw new ProviderError(`missing API key for openai provider (env: ${input.apiKeyEnv || "unknown"})`, {
      provider: "openai"
    })
  }

  const payload = {
    model,
    messages: [...buildSystemMessages(system), ...mapMessages(messages)],
    tools: mapTools(tools),
    tool_choice: tools?.length ? "auto" : undefined,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    stream: true,
    stream_options: { include_usage: true }
  }
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`
  const attempts = Number(retry.attempts ?? 3)
  const baseDelayMs = Number(retry.baseDelayMs ?? 800)

  let response
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Use a connection-only timeout for the initial fetch.
      // Once headers arrive, clear it — the SSE idle timeout handles the streaming phase.
      const connController = new AbortController()
      const connTimer = setTimeout(() => connController.abort(), timeoutMs)
      const fetchSignal = signal
        ? AbortSignal.any([signal, connController.signal])
        : connController.signal

      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload),
        signal: fetchSignal
      })
      clearTimeout(connTimer)

      if (!response.ok) {
        const text = await response.text().catch(() => "")
        const error = new ProviderError(`openai stream failed: ${response.status} ${text}`, {
          provider: "openai", model, endpoint
        })
        error.httpStatus = response.status
        throw error
      }
      break
    } catch (err) {
      if (signal?.aborted) throw err
      const isNetwork = err?.code === "ETIMEDOUT" || err?.code === "ECONNRESET" || err?.name === "AbortError"
      if (!isNetwork || attempt >= attempts) throw err
      await sleep(baseDelayMs * Math.pow(2, attempt - 1))
    }
  }

  const toolBuffers = new Map()
  let finishReason = null

  for await (const { data } of parseSSE(response.body, signal, { idleTimeoutMs: streamIdleTimeoutMs })) {
    let json
    try { json = JSON.parse(data) } catch { continue }

    if (json.usage) {
      const pt = json.usage.prompt_tokens ?? 0
      const ct = json.usage.prompt_tokens_details?.cached_tokens ?? 0
      yield {
        type: "usage",
        usage: { input: pt - ct, output: json.usage.completion_tokens ?? 0, cacheRead: ct, cacheWrite: 0 }
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
