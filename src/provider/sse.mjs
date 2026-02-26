/**
 * 将 fetch response.body (ReadableStream) 解析为 SSE 事件的 AsyncIterator。
 * 同时支持 OpenAI（纯 data: 行）和 Anthropic（event: + data: 对）格式。
 *
 * @param {ReadableStream} body
 * @param {AbortSignal} [signal]
 * @param {object} [options]
 * @param {number} [options.idleTimeoutMs] - per-chunk idle timeout (resets on each chunk)
 * @yields {{ event: string|null, data: string }}
 */
export async function* parseSSE(body, signal, options = {}) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const idleMs = options.idleTimeoutMs || 0
  let currentTimeout = null

  try {
    while (true) {
      if (signal?.aborted) break

      let readResult
      if (idleMs > 0) {
        if (currentTimeout) currentTimeout.cancel()
        currentTimeout = idleTimeout(idleMs, signal)
        readResult = await Promise.race([
          reader.read(),
          currentTimeout.promise
        ])
      } else {
        readResult = await reader.read()
      }

      const { done, value } = readResult
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const parts = buffer.split("\n\n")
      buffer = parts.pop()

      for (const part of parts) {
        const result = parsePart(part)
        if (result === null) return // [DONE]
        if (result) yield result
      }
    }
    // flush remaining buffer
    if (buffer.trim()) {
      const result = parsePart(buffer)
      if (result && result !== null) yield result
    }
  } finally {
    if (currentTimeout) currentTimeout.cancel()
    try { reader.releaseLock() } catch { /* reader may have pending read if generator was force-closed */ }
  }
}

function idleTimeout(ms, signal) {
  let timer = null
  let onAbort = null
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`stream idle timeout: no data received for ${ms}ms`)
      err.code = "STREAM_IDLE_TIMEOUT"
      reject(err)
    }, ms)
    if (signal) {
      onAbort = () => {
        clearTimeout(timer)
        const err = new Error("aborted")
        err.code = "ABORT_ERR"
        reject(err)
      }
      if (signal.aborted) { clearTimeout(timer); onAbort(); return }
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
  function cancel() {
    if (timer !== null) { clearTimeout(timer); timer = null }
    if (onAbort && signal) {
      signal.removeEventListener("abort", onAbort)
      onAbort = null
    }
  }
  return { promise, cancel }
}

function parsePart(part) {
  const trimmed = part.trim()
  if (!trimmed) return undefined
  let event = null
  let data = ""
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim()
    } else if (line.startsWith("data:")) {
      const payload = line.slice(5).trim()
      if (payload === "[DONE]") return null
      data = data ? data + "\n" + payload : payload
    }
  }
  if (!data) return undefined
  return { event, data }
}
