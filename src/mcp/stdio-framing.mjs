const CRLFCRLF = Buffer.from("\r\n\r\n", "utf8")
const NEWLINE = 0x0a

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8")
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  return Buffer.from(String(chunk || ""), "utf8")
}

function parseContentLengthHeader(headerText) {
  const match = /(?:^|\r?\n)content-length:\s*(\d+)\s*(?:\r?\n|$)/i.exec(headerText)
  if (!match) return null
  const len = Number(match[1])
  if (!Number.isFinite(len) || len < 0) return null
  return len
}

function consumeContentLengthFrame(buffer, maxFrameBytes) {
  const headerEnd = buffer.indexOf(CRLFCRLF)
  if (headerEnd === -1) return { type: "need_more" }
  const headerText = buffer.subarray(0, headerEnd).toString("utf8")
  const length = parseContentLengthHeader(headerText)
  if (length === null) return { type: "invalid_header" }
  if (length > maxFrameBytes) return { type: "invalid_size", size: length }
  const total = headerEnd + CRLFCRLF.length + length
  if (buffer.length < total) return { type: "need_more" }
  const payload = buffer
    .subarray(headerEnd + CRLFCRLF.length, total)
    .toString("utf8")
  const rest = buffer.subarray(total)
  return { type: "ok", payload, rest }
}

function consumeNewlineFrame(buffer) {
  const newlineIdx = buffer.indexOf(NEWLINE)
  if (newlineIdx === -1) return { type: "need_more" }
  const rawLine = buffer.subarray(0, newlineIdx).toString("utf8")
  const rest = buffer.subarray(newlineIdx + 1)
  const payload = rawLine.trim()
  if (!payload) return { type: "empty", rest }
  return { type: "ok", payload, rest }
}

function dropLeadingCrlf(buffer) {
  let cursor = 0
  while (cursor < buffer.length) {
    const c = buffer[cursor]
    if (c !== 0x0d && c !== 0x0a) break
    cursor += 1
  }
  return cursor > 0 ? buffer.subarray(cursor) : buffer
}

function seemsContentLength(buffer) {
  if (!buffer.length) return false
  const probe = buffer.subarray(0, Math.min(buffer.length, 32)).toString("ascii").toLowerCase()
  return probe.startsWith("content-length:")
}

export function encodeRpcMessage(message, framing = "content-length") {
  const payload = JSON.stringify(message)
  if (framing === "newline") return `${payload}\n`
  const size = Buffer.byteLength(payload, "utf8")
  return `Content-Length: ${size}\r\n\r\n${payload}`
}

export function createStdioFramingDecoder({ framing = "auto", maxFrameBytes = 8 * 1024 * 1024, maxBufferBytes = 16 * 1024 * 1024 } = {}) {
  let buffer = Buffer.alloc(0)

  function push(chunk) {
    const incoming = toBuffer(chunk)
    if (buffer.length + incoming.length > maxBufferBytes) {
      buffer = Buffer.alloc(0)
      throw new Error(`stdio framing buffer exceeded limit: ${maxBufferBytes} bytes`)
    }
    buffer = Buffer.concat([buffer, incoming])
    const messages = []

    while (true) {
      if (!buffer.length) break

      if (framing === "content-length") {
        const parsed = consumeContentLengthFrame(buffer, maxFrameBytes)
        if (parsed.type === "need_more") break
        if (parsed.type === "invalid_header") throw new Error("invalid content-length header")
        if (parsed.type === "invalid_size") throw new Error(`content-length exceeds limit: ${parsed.size}`)
        messages.push(parsed.payload)
        buffer = parsed.rest
        continue
      }

      if (framing === "newline") {
        const parsed = consumeNewlineFrame(buffer)
        if (parsed.type === "need_more") break
        buffer = parsed.rest
        if (parsed.type === "ok") messages.push(parsed.payload)
        continue
      }

      // auto mode: prefer standard content-length frames, then fallback to newline JSON
      buffer = dropLeadingCrlf(buffer)
      if (!buffer.length) break

      if (seemsContentLength(buffer)) {
        const parsed = consumeContentLengthFrame(buffer, maxFrameBytes)
        if (parsed.type === "need_more") break
        if (parsed.type === "invalid_header") throw new Error("invalid content-length header")
        if (parsed.type === "invalid_size") throw new Error(`content-length exceeds limit: ${parsed.size}`)
        messages.push(parsed.payload)
        buffer = parsed.rest
        continue
      }

      const parsed = consumeNewlineFrame(buffer)
      if (parsed.type === "need_more") break
      buffer = parsed.rest
      if (parsed.type === "ok") messages.push(parsed.payload)
    }

    return messages
  }

  function reset() {
    buffer = Buffer.alloc(0)
  }

  return {
    push,
    reset,
    bufferSize() { return buffer.length }
  }
}
