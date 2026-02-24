import { ProviderError } from "../core/errors.mjs"
import { requestWithRetry } from "./retry-policy.mjs"
import { parseSSE } from "./sse.mjs"

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function mapMessages(messages) {
  const mapped = messages.map((message) => {
    const role = message.role === "assistant" ? "assistant" : "user"
    const content = message.content
    if (Array.isArray(content)) {
      return { role, content: content.map(mapContentBlock) }
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
  return mapped
}

function parseContentBlocks(content) {
  const blocks = Array.isArray(content) ? content : []
  const text = blocks.filter((block) => block.type === "text").map((block) => block.text || "").join("\n")
  const toolCalls = blocks
    .filter((block) => block.type === "tool_use" && block.name)
    .map((block) => ({
      id: block.id || `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: block.name,
      args: block.input || {}
    }))
  return { text, toolCalls }
}

function timeoutSignal(ms, parentSignal = null) {
  const own = AbortSignal.timeout(ms)
  if (!parentSignal) return own
  return AbortSignal.any([parentSignal, own])
}

export async function requestAnthropic(input) {
  const { apiKey, baseUrl, model, system, messages, tools, timeoutMs = 120000, maxTokens = 16384, retry = {}, signal = null } = input
  if (!apiKey) {
    throw new ProviderError(`missing API key for anthropic provider (env: ${input.apiKeyEnv || "unknown"})`, {
      provider: "anthropic"
    })
  }

  const endpoint = `${baseUrl.replace(/\/$/, "")}/messages`
  const mappedTools = mapTools(tools)
  const payload = {
    model,
    max_tokens: maxTokens,
    metadata: { user_id: "kkcode" },
    system: systemWithCacheControl(system),
    messages: mapMessages(messages),
    tools: mappedTools.length ? mappedTools : undefined
  }
  if (input.thinking?.type) {
    payload.thinking = { type: input.thinking.type, budget_tokens: input.thinking.budget_tokens || 10000 }
  }

  return requestWithRetry({
    attempts: Number(retry.attempts ?? 3),
    baseDelayMs: Number(retry.baseDelayMs ?? 800),
    signal,
    execute: async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31"
        },
        body: JSON.stringify(payload),
        signal: timeoutSignal(timeoutMs, signal)
      })
      if (!response.ok) {
        const text = await response.text().catch(() => "")
        const error = new ProviderError(`anthropic request failed: ${response.status} ${text}`, {
          provider: "anthropic",
          model,
          endpoint
        })
        error.httpStatus = response.status
        throw error
      }
      const json = await response.json()
      const parsed = parseContentBlocks(json?.content)
      const usage = {
        input: json?.usage?.input_tokens ?? 0,
        output: json?.usage?.output_tokens ?? 0,
        cacheRead: json?.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: json?.usage?.cache_creation_input_tokens ?? 0
      }
      return { text: parsed.text, usage, toolCalls: parsed.toolCalls }
    }
  })
}

export async function countTokensAnthropic(input) {
  const { apiKey, baseUrl, model, system, messages, tools, timeoutMs = 10000 } = input
  if (!apiKey) return null
  const endpoint = `${baseUrl.replace(/\/$/, "")}/messages/count_tokens`
  const mappedTools = mapTools(tools)
  const payload = {
    model,
    system: systemWithCacheControl(system),
    messages: mapMessages(messages),
    tools: mappedTools.length ? mappedTools : undefined
  }
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) return null
    const json = await res.json()
    return json?.input_tokens ?? null
  } catch {
    return null
  }
}

export async function* requestAnthropicStream(input) {
  const { apiKey, baseUrl, model, system, messages, tools, timeoutMs = 120000, streamIdleTimeoutMs = 120000, maxTokens = 16384, retry = {}, signal = null, compaction = null } = input
  if (!apiKey) {
    throw new ProviderError(`missing API key for anthropic provider (env: ${input.apiKeyEnv || "unknown"})`, {
      provider: "anthropic"
    })
  }

  const endpoint = `${baseUrl.replace(/\/$/, "")}/messages`
  const mappedTools = mapTools(tools)
  const payload = {
    model,
    max_tokens: maxTokens,
    metadata: { user_id: "kkcode" },
    system: systemWithCacheControl(system),
    messages: mapMessages(messages),
    tools: mappedTools.length ? mappedTools : undefined,
    stream: true,
    ...(compaction ? { context_management: { edits: [{ type: "compact_20260112", trigger: { tokens: compaction.trigger || 150000 } }] } } : {})
  }
  if (input.thinking?.type) {
    payload.thinking = { type: input.thinking.type, budget_tokens: input.thinking.budget_tokens || 10000 }
  }
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
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": compaction ? "prompt-caching-2024-07-31,compact-2026-01-12" : "prompt-caching-2024-07-31"
        },
        body: JSON.stringify(payload),
        signal: fetchSignal
      })
      clearTimeout(connTimer)

      if (!response.ok) {
        const text = await response.text().catch(() => "")
        const error = new ProviderError(`anthropic stream failed: ${response.status} ${text}`, {
          provider: "anthropic", model, endpoint
        })
        error.httpStatus = response.status
        throw error
      }
      break
    } catch (err) {
      clearTimeout(connTimer)
      if (signal?.aborted) throw err
      const isNetwork = err?.code === "ETIMEDOUT" || err?.code === "ECONNRESET" || err?.name === "AbortError"
      if (!isNetwork || attempt >= attempts) throw err
      await sleep(baseDelayMs * Math.pow(2, attempt - 1))
    }
  }

  let currentBlock = null
  let inputUsage = { input: 0, cacheRead: 0, cacheWrite: 0 }
  let outputTokens = 0
  let stopReason = null

  for await (const { event, data } of parseSSE(response.body, signal, { idleTimeoutMs: streamIdleTimeoutMs })) {
    let parsed
    try { parsed = JSON.parse(data) } catch { continue }

    if (event === "message_start") {
      const u = parsed.message?.usage
      inputUsage.input = u?.input_tokens ?? 0
      inputUsage.cacheRead = u?.cache_read_input_tokens ?? 0
      inputUsage.cacheWrite = u?.cache_creation_input_tokens ?? 0
    }

    if (event === "content_block_start") {
      const block = parsed.content_block
      currentBlock = {
        type: block?.type,
        id: block?.id || null,
        name: block?.name || null,
        jsonParts: []
      }
    }

    if (event === "content_block_delta") {
      if (parsed.delta?.type === "text_delta") {
        const text = parsed.delta.text || ""
        if (text) yield { type: "text", content: text }
      }
      if (parsed.delta?.type === "thinking_delta" && currentBlock?.type !== "redacted_thinking") {
        const thinking = parsed.delta.thinking || ""
        if (thinking) yield { type: "thinking", content: thinking }
      }
      if (parsed.delta?.type === "input_json_delta") {
        if (currentBlock) currentBlock.jsonParts.push(parsed.delta.partial_json || "")
      }
      if (parsed.delta?.type === "compaction_delta") {
        if (currentBlock) currentBlock.compactionContent = parsed.delta.content || ""
      }
    }

    if (event === "content_block_stop" && currentBlock) {
      if (currentBlock.type === "tool_use") {
        const raw = currentBlock.jsonParts.join("") || "{}"
        let args = {}
        try {
          args = JSON.parse(raw)
        } catch (parseErr) {
          console.error(`[anthropic] tool_call JSON parse failed for "${currentBlock.name}": ${parseErr.message} (${raw.length} chars, first 200: ${raw.slice(0, 200)})`)
          args = { __parse_error: true, __raw_length: raw.length, __error: parseErr.message }
        }
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
        yield { type: "compaction", content: currentBlock.compactionContent || "" }
      }
      currentBlock = null
    }

    if (event === "message_delta") {
      outputTokens = parsed.usage?.output_tokens ?? outputTokens
      if (parsed.delta?.stop_reason) {
        stopReason = parsed.delta.stop_reason
      }
    }

    if (event === "message_stop") {
      yield {
        type: "usage",
        usage: {
          input: inputUsage.input,
          output: outputTokens,
          cacheRead: inputUsage.cacheRead,
          cacheWrite: inputUsage.cacheWrite
        }
      }
      // Normalize: "end_turn" → "end_turn", "max_tokens" → "max_tokens", "tool_use" → "tool_use"
      yield { type: "stop", reason: stopReason || "end_turn" }
    }
  }
}
