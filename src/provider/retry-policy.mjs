const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
])

const TIMEOUT_CODES = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT"
])

const CONTEXT_OVERFLOW_RE =
  /context[_\s-]*(?:length|window)|maximum context|too many (?:input )?tokens|prompt (?:is )?too long|context_length_exceeded/i

export function abortableSleep(ms, signal = null) {
  if (signal?.aborted) {
    const error = new Error("request aborted")
    error.code = "ABORT_ERR"
    return Promise.reject(error)
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      const error = new Error("request aborted")
      error.code = "ABORT_ERR"
      reject(error)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, Math.max(0, Number(ms) || 0))
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function classifyHttpError(status) {
  const value = Number(status || 0)
  if (value === 401 || value === 403) return "auth"
  if (value === 429) return "rate_limit"
  if (value === 413) return "context_overflow"
  if (value === 408 || value === 409 || value === 425) return "transient"
  if (value >= 500 && value <= 599) return "server"
  if (value >= 400 && value <= 499) return "bad_request"
  return "unknown"
}

function errorChain(error) {
  const chain = []
  const seen = new Set()
  let current = error
  while (current && (typeof current === "object" || typeof current === "function") && !seen.has(current) && chain.length < 8) {
    chain.push(current)
    seen.add(current)
    current = current.cause
  }
  return chain
}

function httpStatus(error) {
  for (const item of errorChain(error)) {
    const status = Number(item?.status || item?.httpStatus || item?.response?.status || 0)
    if (status > 0) return status
  }
  return 0
}

function hasContextOverflow(error) {
  return errorChain(error).some((item) => {
    const body = [
      item?.message,
      item?.code,
      item?.type,
      item?.error?.code,
      item?.error?.type,
      item?.error?.message
    ].filter(Boolean).join(" ")
    return CONTEXT_OVERFLOW_RE.test(body)
  })
}

/**
 * Classify failures without retrying deterministic client errors. Node fetch
 * commonly wraps socket/DNS failures in TypeError.cause, so the whole cause
 * chain is inspected instead of relying only on the top-level error.
 */
export function classifyRequestError(error, { signal = null } = {}) {
  if (signal?.aborted) return "aborted"

  const status = httpStatus(error)
  let classification = classifyHttpError(status)
  if (classification === "bad_request" && hasContextOverflow(error)) {
    classification = "context_overflow"
  }
  if (classification !== "unknown") return classification

  for (const item of errorChain(error)) {
    const explicit = String(item?.errorClass || "").toLowerCase()
    if ([
      "auth",
      "bad_request",
      "context_overflow",
      "rate_limit",
      "server",
      "transient",
      "timeout",
      "network"
    ].includes(explicit)) {
      return explicit
    }

    const code = String(item?.code || "").toUpperCase()
    const name = String(item?.name || "")
    const message = String(item?.message || "")
    if (TIMEOUT_CODES.has(code) || name === "TimeoutError" || code === "STREAM_IDLE_TIMEOUT") {
      return "timeout"
    }
    // An AbortError that did not come from the caller's signal is the
    // connection timeout controller and is safe to retry.
    if (name === "AbortError" || code === "ABORT_ERR") return "timeout"
    if (RETRYABLE_NETWORK_CODES.has(code)) return "network"
    if (
      name === "TypeError" &&
      /fetch failed|failed to fetch|networkerror|network request failed|load failed/i.test(message)
    ) {
      return "network"
    }
  }

  return "unknown"
}

export function isRetryableRequestError(error, options = {}) {
  const classification = typeof error === "string"
    ? error
    : classifyRequestError(error, options)
  return classification === "rate_limit" ||
    classification === "server" ||
    classification === "transient" ||
    classification === "timeout" ||
    classification === "network"
}

function jitter(ms) {
  return Math.max(0, Math.round(ms * (1 + (Math.random() - 0.5) * 0.4)))
}

function retryDelayMs(classification, baseDelayMs, attempt, retryAfterMs = null) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, 60000)
  }
  if (classification === "rate_limit") {
    return jitter(Math.min(baseDelayMs * Math.pow(3, attempt - 1), 60000))
  }
  return jitter(Math.min(baseDelayMs * Math.pow(2, attempt - 1), 60000))
}

function normalizeAttempts(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : 5
}

function normalizeRetries(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 5
}

function retryBudget({ retries, attempts }) {
  if (retries !== undefined && retries !== null) {
    const maxRetries = normalizeRetries(retries)
    return { maxRetries, totalAttempts: maxRetries + 1 }
  }
  if (attempts !== undefined && attempts !== null) {
    const totalAttempts = normalizeAttempts(attempts)
    return { maxRetries: totalAttempts - 1, totalAttempts }
  }
  return { maxRetries: 5, totalAttempts: 6 }
}

export function resolveRetryOptions(retry = {}, fallbackRetries = 5) {
  if (retry?.retries !== undefined && retry?.retries !== null) {
    return { retries: Number(retry.retries) }
  }
  if (retry?.attempts !== undefined && retry?.attempts !== null) {
    return { attempts: Number(retry.attempts) }
  }
  return { retries: Number(fallbackRetries) }
}

export function retryAfterMsFromHeaders(headers, now = Date.now()) {
  const raw = headers?.get?.("retry-after")
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const timestamp = Date.parse(raw)
  if (!Number.isFinite(timestamp)) return null
  return Math.max(0, timestamp - Number(now || Date.now()))
}

export function annotateRetryAfter(error, response) {
  const delay = retryAfterMsFromHeaders(response?.headers)
  if (delay !== null) {
    try { error.retryAfterMs = delay } catch { /* best effort */ }
  }
  return error
}

export async function requestWithRetry({
  execute,
  retries,
  attempts,
  baseDelayMs = 800,
  signal = null,
  onRetry = null
}) {
  const { maxRetries, totalAttempts } = retryBudget({ retries, attempts })
  const delayBase = Math.max(0, Number(baseDelayMs) || 0)
  let lastError = null

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    if (signal?.aborted) {
      const error = new Error("request aborted")
      error.code = "ABORT_ERR"
      throw error
    }
    try {
      return await execute(attempt)
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught))
      lastError = error
      const classification = classifyRequestError(error, { signal })

      try { error.errorClass = classification } catch { /* some platform errors are not extensible */ }

      if (signal?.aborted || classification === "aborted") {
        throw error
      }
      if (classification === "auth") {
        const status = httpStatus(error)
        if (!/^authentication failed\b/i.test(error.message)) {
          error.message = `authentication failed${status ? ` (${status})` : ""}: check your API key. ${error.message}`
        }
        throw error
      }
      if (classification === "context_overflow") {
        try { error.needsCompaction = true } catch { /* best-effort annotation */ }
        throw error
      }
      if (!isRetryableRequestError(classification) || attempt >= totalAttempts) {
        throw error
      }

      const delay = retryDelayMs(
        classification,
        delayBase,
        attempt,
        Number.isFinite(Number(error.retryAfterMs)) ? Number(error.retryAfterMs) : null
      )
      if (typeof onRetry === "function") {
        await onRetry({
          attempt,
          requestAttempt: attempt,
          nextAttempt: attempt + 1,
          totalAttempts,
          retryAttempt: attempt,
          maxRetries,
          classification,
          delayMs: delay,
          error
        })
      }
      await abortableSleep(delay, signal)
    }
  }

  throw lastError || new Error("request failed")
}

/**
 * Prime an async stream under the retry policy. Failures are retryable only
 * until the first outward chunk is obtained; callers then consume `iterator`
 * directly so a partially delivered response can never be replayed.
 */
export async function primeRetriableStream({
  create,
  retries,
  attempts,
  baseDelayMs = 800,
  signal = null,
  onRetry = null
}) {
  return requestWithRetry({
    retries,
    attempts,
    baseDelayMs,
    signal,
    onRetry,
    execute: async (requestAttempt) => {
      const iterable = await create(requestAttempt)
      const iterator = iterable?.[Symbol.asyncIterator]?.()
      if (!iterator) {
        const error = new Error("provider stream is not async iterable")
        error.errorClass = "bad_request"
        throw error
      }
      try {
        const first = await iterator.next()
        if (first.done) {
          const error = new Error("provider stream closed before the first event")
          error.errorClass = "transient"
          throw error
        }
        return { iterator, first }
      } catch (error) {
        try { await iterator.return?.() } catch { /* preserve original error */ }
        throw error
      }
    }
  })
}
