import { randomUUID } from "node:crypto"
import { PACKAGE_VERSION } from "../version.mjs"

export const KKCODE_REPOSITORY_URL = "https://github.com/kkelly-offical/kkcode"
export const KKCODE_USER_AGENT = `KK-Code/${PACKAGE_VERSION} (+${KKCODE_REPOSITORY_URL})`

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie"
])

const PROTECTED_IDENTITY_HEADERS = new Set([
  "user-agent",
  "x-kk-code-version",
  "x-kk-code-client",
  "x-kk-code-provider",
  "x-kk-code-protocol",
  "x-kk-code-target",
  "x-kk-code-request-id",
  "x-client-request-id"
])

function canonicalHeaderName(name) {
  const normalized = String(name || "").trim().toLowerCase()
  const known = {
    "user-agent": "User-Agent",
    "x-kk-code-version": "X-KK-Code-Version",
    "x-kk-code-client": "X-KK-Code-Client",
    "x-kk-code-provider": "X-KK-Code-Provider",
    "x-kk-code-protocol": "X-KK-Code-Protocol",
    "x-kk-code-target": "X-KK-Code-Target",
    "x-kk-code-request-id": "X-KK-Code-Request-Id",
    "x-client-request-id": "X-Client-Request-Id"
  }
  if (known[normalized]) return known[normalized]
  return normalized
    .split("-")
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join("-")
}

/** Create correlation identifiers for one logical upstream request. */
export function createRequestContext({ traceId = "", requestId = "", parentEventId = "" } = {}) {
  return Object.freeze({
    traceId: String(traceId || randomUUID()),
    requestId: String(requestId || randomUUID()),
    ...(parentEventId ? { parentEventId: String(parentEventId) } : {})
  })
}

/** Build headers for requests initiated by KK Code. */
export function buildRequestHeaders({
  target = "",
  provider = "",
  protocol = "",
  requestId = "",
  openAIClientRequestId = false,
  accept = "",
  contentType = "",
  authorization = "",
  customHeaders = {}
} = {}) {
  const merged = new Map()
  for (const [name, value] of Object.entries(customHeaders || {})) {
    const normalized = String(name).toLowerCase()
    if (!name || value === undefined || value === null) continue
    if (PROTECTED_IDENTITY_HEADERS.has(normalized)) continue
    merged.set(normalized, [canonicalHeaderName(name), String(value)])
  }

  if (accept) merged.set("accept", ["Accept", String(accept)])
  if (contentType) merged.set("content-type", ["Content-Type", String(contentType)])
  if (authorization) merged.set("authorization", ["Authorization", String(authorization)])
  if (provider) merged.set("x-kk-code-provider", ["X-KK-Code-Provider", String(provider)])
  if (protocol) merged.set("x-kk-code-protocol", ["X-KK-Code-Protocol", String(protocol)])
  if (target) merged.set("x-kk-code-target", ["X-KK-Code-Target", String(target)])
  const effectiveRequestId = String(requestId || randomUUID())
  merged.set("x-kk-code-request-id", ["X-KK-Code-Request-Id", effectiveRequestId])
  if (openAIClientRequestId) {
    const clientRequestId = openAIClientRequestId === true
      ? effectiveRequestId
      : String(openAIClientRequestId)
    merged.set("x-client-request-id", ["X-Client-Request-Id", clientRequestId])
  }
  merged.set("user-agent", ["User-Agent", KKCODE_USER_AGENT])
  merged.set("x-kk-code-version", ["X-KK-Code-Version", PACKAGE_VERSION])
  merged.set("x-kk-code-client", ["X-KK-Code-Client", "cli"])

  return Object.fromEntries([...merged.values()])
}

export function isSensitiveHeader(name) {
  const normalized = String(name || "").toLowerCase().replaceAll("_", "-")
  return SENSITIVE_HEADER_NAMES.has(normalized) ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("api-key")
}

function isSensitiveValueKey(name) {
  const normalized = String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replaceAll("_", "-")
  return SENSITIVE_HEADER_NAMES.has(normalized) ||
    /(?:^|-)(?:password|passwd|secret|credential|authorization)(?:-|$)/.test(normalized) ||
    /(?:^|-)(?:api-key|access-token|refresh-token|auth-token|id-token)(?:-|$)/.test(normalized) ||
    normalized === "token" ||
    normalized.endsWith("-token")
}

export function redactHeaders(headers = {}) {
  const output = {}
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers || {})
  for (const [name, value] of entries) {
    output[canonicalHeaderName(name)] = isSensitiveHeader(name) ? "[REDACTED]" : String(value)
  }
  return output
}

export function redactSensitive(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    return value
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
      .replace(/\bsk-(?:kimi-)?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, seen))
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return "[CIRCULAR]"
  seen.add(value)
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = isSensitiveValueKey(key)
      ? "[REDACTED]"
      : redactSensitive(item, seen)
  }
  seen.delete(value)
  return output
}
