import { ProviderError } from "../core/errors.mjs"
import { buildRequestHeaders } from "../http/identity.mjs"
import {
  annotateRetryAfter,
  primeRetriableStream,
  requestWithRetry,
  resolveRetryOptions
} from "./retry-policy.mjs"

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

function resolveSystemText(system) {
  if (!system) return ""
  if (typeof system === "string") return system
  if (system.text) return system.text
  return String(system)
}

// Ollama 原生的图片字段是消息级的 `images: [base64]`，而且只收裸 base64 —— 带
// `data:image/png;base64,` 前缀会被当成图片字节直接解码失败。
function collectImages(content) {
  return content
    .filter((block) => block?.type === "image" && block.data)
    .map((block) => String(block.data).replace(/^data:[^;,]*;base64,/i, ""))
    .filter(Boolean)
}

function mapMessages(system, messages) {
  const mapped = [{ role: "system", content: resolveSystemText(system) }]
  for (const msg of messages) {
    const content = msg.content
    if (!Array.isArray(content)) {
      mapped.push({ role: msg.role, content: String(content || "") })
      continue
    }

    // Assistant message with tool_use blocks → tool_calls format
    const toolUseBlocks = content.filter((b) => b.type === "tool_use")
    if (toolUseBlocks.length > 0 && msg.role === "assistant") {
      const textParts = content.filter((b) => b.type === "text").map((b) => b.text || "").join("\n")
      mapped.push({
        role: "assistant",
        content: textParts || "",
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

    // User message with tool_result blocks → role:"tool" messages
    const toolResultBlocks = content.filter((b) => b.type === "tool_result")
    if (toolResultBlocks.length > 0) {
      for (const result of toolResultBlocks) {
        mapped.push({
          role: "tool",
          tool_call_id: result.tool_use_id,
          content: String(result.content || "")
        })
      }
      // 与 openai.mjs 在 0.6.11 修掉的是同一个缺陷：read 读到的图片挂在
      // tool_result 之后的同一条消息里，而这里直接 continue，把它们连同整条
      // 消息一起丢掉。role:"tool" 消息装不下图片，所以另起一条 user 消息。
      const images = collectImages(content)
      if (images.length > 0) {
        mapped.push({ role: "user", content: "", images })
      }
      continue
    }

    // Fallback: plain text extraction + 同级的 images 字段
    const text = content.filter((b) => b.type === "text").map((b) => b.text || "").join("\n")
    const images = collectImages(content)
    const message = { role: msg.role, content: text || (images.length ? "" : String(content)) }
    if (images.length > 0) message.images = images
    mapped.push(message)
  }
  return mapped
}

function parseToolCalls(message) {
  if (!Array.isArray(message?.tool_calls)) return []
  return message.tool_calls
    .filter((call) => call?.function?.name)
    .map((call) => {
      let args = {}
      if (typeof call.function.arguments === "string") {
        try { args = JSON.parse(call.function.arguments) } catch { args = {} }
      } else if (typeof call.function.arguments === "object" && call.function.arguments !== null) {
        args = call.function.arguments
      }
      return {
        id: call.id || `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: call.function.name,
        args
      }
    })
}

function timeoutSignal(ms, parentSignal = null) {
  const own = AbortSignal.timeout(ms)
  if (!parentSignal) return own
  return AbortSignal.any([parentSignal, own])
}

function notifyResponse(input, response) {
  try { input.onResponse?.(response) } catch { /* audit metadata must not affect requests */ }
}

// --- Non-streaming ---
export async function requestOllama(input) {
  const { baseUrl, model, system, messages, tools, timeoutMs = 300000, retry = {}, signal = null } = input

  if (!retry._requestRetried) {
    return requestWithRetry({
      execute: () => requestOllama({
        ...input,
        retry: { _requestRetried: true }
      }),
      ...resolveRetryOptions(retry),
      baseDelayMs: Number(retry.baseDelayMs ?? 800),
      signal,
      onRetry: retry.onRetry
    })
  }

  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/chat`
  const payload = {
    model,
    messages: mapMessages(system, messages),
    stream: false
  }
  const mappedTools = mapTools(tools)
  if (mappedTools) payload.tools = mappedTools

  const response = await fetch(endpoint, {
    method: "POST",
    headers: buildRequestHeaders({
      target: "llm",
      provider: input.provider || "ollama",
      protocol: input.protocol || "ollama",
      requestId: input.requestId || "",
      accept: "application/json",
      contentType: "application/json"
    }),
    body: JSON.stringify(payload),
    signal: timeoutSignal(timeoutMs, signal)
  })
  notifyResponse(input, response)

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    const error = new ProviderError(`ollama request failed: ${response.status} ${text}`, {
      provider: "ollama", model, endpoint
    })
    error.httpStatus = response.status
    annotateRetryAfter(error, response)
    throw error
  }

  let json
  try {
    json = await response.json()
  } catch (parseErr) {
    throw new ProviderError(`ollama response JSON parse failed: ${parseErr.message}`, { provider: "ollama", model, endpoint })
  }
  const message = json.message || {}
  const text = typeof message.content === "string" ? message.content : ""
  const toolCalls = parseToolCalls(message)

  return {
    text,
    usage: {
      input: json.prompt_eval_count ?? 0,
      output: json.eval_count ?? 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    toolCalls
  }
}

// --- Streaming (NDJSON) ---
export async function* requestOllamaStream(input) {
  const { baseUrl, model, system, messages, tools, timeoutMs = 300000, retry = {}, signal = null } = input

  if (!retry._streamPrimed) {
    const { iterator, first } = await primeRetriableStream({
      create: () => requestOllamaStream({
        ...input,
        retry: { _streamPrimed: true }
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

  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/chat`
  const payload = {
    model,
    messages: mapMessages(system, messages),
    stream: true
  }
  const mappedTools = mapTools(tools)
  if (mappedTools) payload.tools = mappedTools

  const response = await fetch(endpoint, {
    method: "POST",
    headers: buildRequestHeaders({
      target: "llm",
      provider: input.provider || "ollama",
      protocol: input.protocol || "ollama",
      requestId: input.requestId || "",
      accept: "application/x-ndjson, application/json",
      contentType: "application/json"
    }),
    body: JSON.stringify(payload),
    signal: timeoutSignal(timeoutMs, signal)
  })
  notifyResponse(input, response)

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    const error = new ProviderError(`ollama stream failed: ${response.status} ${text}`, {
      provider: "ollama", model, endpoint
    })
    error.httpStatus = response.status
    annotateRetryAfter(error, response)
    throw error
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      if (signal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split("\n")
      buffer = lines.pop()

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let json
        try { json = JSON.parse(trimmed) } catch { continue }

        if (json.message?.content) {
          yield { type: "text", content: json.message.content }
        }

        if (json.done) {
          const toolCalls = parseToolCalls(json.message)
          for (const call of toolCalls) {
            yield { type: "tool_call", call }
          }
          yield {
            type: "usage",
            usage: {
              input: json.prompt_eval_count ?? 0,
              output: json.eval_count ?? 0,
              cacheRead: 0,
              cacheWrite: 0
            }
          }
        }
      }
    }

    if (buffer.trim()) {
      try {
        const json = JSON.parse(buffer.trim())
        if (json.message?.content) yield { type: "text", content: json.message.content }
        if (json.done) {
          const toolCalls = parseToolCalls(json.message)
          for (const call of toolCalls) {
            yield { type: "tool_call", call }
          }
          yield {
            type: "usage",
            usage: {
              input: json.prompt_eval_count ?? 0,
              output: json.eval_count ?? 0,
              cacheRead: 0,
              cacheWrite: 0
            }
          }
        }
      } catch { /* ignore incomplete JSON */ }
    }
  } finally {
    try { await reader.cancel() } catch { /* stream may already be closed */ }
    try { reader.releaseLock() } catch { /* reader may have pending read if generator was force-closed */ }
  }
}
