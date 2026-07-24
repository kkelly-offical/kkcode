import { createHash } from "node:crypto"
import { createRequestContext, redactSensitive } from "../http/identity.mjs"
import { appendAuditEntry, safeAppendAuditEntry } from "../storage/audit-store.mjs"

const CONTENT_KEYS = /^(?:args|body|content|messages?|new_string|old_string|output|prompt|response|system|tool_args)$/i
const SPAN_IDENTITY_KEYS = new Set([
  "sessionId",
  "turnId",
  "provider",
  "providerType",
  "protocol",
  "model",
  "reviewId",
  "reviewSource",
  "diffHash",
  "tool",
  "endpoint",
  "stream"
])

export function summarizeAuditContent(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? null)
  return {
    length: Buffer.byteLength(serialized, "utf8"),
    sha256: createHash("sha256").update(serialized).digest("hex")
  }
}

export function sanitizeAuditMetadata(value, seen = new WeakSet()) {
  const redacted = redactSensitive(value)
  if (!redacted || typeof redacted !== "object") return redacted
  if (seen.has(redacted)) return "[CIRCULAR]"
  seen.add(redacted)
  if (Array.isArray(redacted)) {
    const list = redacted.map((item) => sanitizeAuditMetadata(item, seen))
    seen.delete(redacted)
    return list
  }
  const output = {}
  for (const [key, item] of Object.entries(redacted)) {
    const isContentValue = typeof item === "string" || (item && typeof item === "object")
    output[key] = CONTENT_KEYS.test(key) && isContentValue
      ? summarizeAuditContent(item)
      : sanitizeAuditMetadata(item, seen)
  }
  seen.delete(redacted)
  return output
}

export async function startAuditSpan({
  type,
  traceId = "",
  requestId = "",
  parentEventId = "",
  ...metadata
}) {
  const context = createRequestContext({ traceId, requestId, parentEventId })
  const startedAt = Date.now()
  const sanitizedMetadata = sanitizeAuditMetadata(metadata)
  const spanIdentity = Object.fromEntries(
    Object.entries(sanitizedMetadata).filter(([key]) => SPAN_IDENTITY_KEYS.has(key))
  )
  const start = await appendAuditEntry({
    type: `${type}.start`,
    ...context,
    ...sanitizedMetadata
  })
  let closed = false

  return {
    ...context,
    eventId: start.eventId,
    async finish(result = {}) {
      if (closed) return null
      closed = true
      return safeAppendAuditEntry({
        type: `${type}.finish`,
        ...context,
        parentEventId: start.eventId,
        ...spanIdentity,
        durationMs: Date.now() - startedAt,
        ok: result.ok !== false,
        status: result.status || (result.ok === false ? "error" : "ok"),
        ...sanitizeAuditMetadata(result)
      })
    },
    async fail(error, result = {}) {
      if (closed) return null
      closed = true
      return safeAppendAuditEntry({
        type: `${type}.error`,
        ...context,
        parentEventId: start.eventId,
        ...spanIdentity,
        durationMs: Date.now() - startedAt,
        ok: false,
        status: result.status || "error",
        error: String(error?.message || error || "unknown error"),
        ...sanitizeAuditMetadata(result)
      })
    }
  }
}
