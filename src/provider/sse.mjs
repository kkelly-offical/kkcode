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

  function throwIfAborted() {
    if (!signal?.aborted) return
    const error = new Error("stream aborted")
    error.code = "ABORT_ERR"
    throw error
  }

  try {
    while (true) {
      throwIfAborted()

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

      // SSE permits CRLF, LF, or CR line endings. CRLF must be treated as one
      // logical ending even when its two bytes arrive in separate chunks.
      const split = splitCompleteFrames(buffer)
      buffer = split.remaining

      for (const part of split.frames) {
        throwIfAborted()
        const result = parsePart(part)
        if (result === null) return // [DONE]
        if (result) yield result
      }
    }
    // flush remaining buffer
    throwIfAborted()
    buffer += decoder.decode()
    const split = splitCompleteFrames(buffer, { final: true })
    buffer = split.remaining
    for (const part of split.frames) {
      throwIfAborted()
      const result = parsePart(part)
      if (result === null) return
      if (result) yield result
    }
    if (buffer.trim()) {
      const result = parsePart(buffer)
      if (result && result !== null) yield result
    }
  } finally {
    if (currentTimeout) currentTimeout.cancel()
    // A timed-out read may still be pending. Cancelling first closes the old
    // response body so a reconnect cannot accumulate orphaned SSE sockets.
    try { await reader.cancel() } catch { /* body may already be closed or errored */ }
    try { reader.releaseLock() } catch { /* best effort after cancellation */ }
  }
}

function splitCompleteFrames(source, { final = false } = {}) {
  const frames = []
  let remaining = String(source || "")

  while (remaining) {
    let previousEnding = null
    let boundary = null

    for (let index = 0; index < remaining.length;) {
      let endingLength = 0
      if (remaining[index] === "\r") {
        if (index + 1 >= remaining.length && !final) break
        endingLength = remaining[index + 1] === "\n" ? 2 : 1
      } else if (remaining[index] === "\n") {
        endingLength = 1
      }

      if (!endingLength) {
        previousEnding = null
        index += 1
        continue
      }

      if (previousEnding?.end === index) {
        boundary = {
          frameEnd: previousEnding.start,
          separatorEnd: index + endingLength
        }
        break
      }
      previousEnding = { start: index, end: index + endingLength }
      index += endingLength
    }

    if (!boundary) break
    frames.push(remaining.slice(0, boundary.frameEnd))
    remaining = remaining.slice(boundary.separatorEnd)
  }

  return { frames, remaining }
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
  for (const line of trimmed.split(/\r\n|\r|\n/)) {
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
