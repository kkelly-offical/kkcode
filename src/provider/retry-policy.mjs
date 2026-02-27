function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function classifyHttpError(status) {
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate_limit"
  if (status === 413) return "context_overflow"
  if (status === 400) return "bad_request"
  if (status >= 500) return "server"
  if (status === 408 || status === 409 || status === 425) return "transient"
  return "unknown"
}

function isRetryable(classification) {
  return classification === "rate_limit" || classification === "server" || classification === "transient"
}

function jitter(ms) {
  return Math.round(ms * (1 + (Math.random() - 0.5) * 0.4))
}

function retryDelayMs(classification, baseDelayMs, attempt) {
  if (classification === "rate_limit") {
    return jitter(Math.min(baseDelayMs * Math.pow(3, attempt - 1), 60000))
  }
  return jitter(baseDelayMs * Math.pow(2, attempt - 1))
}

export async function requestWithRetry({ execute, attempts = 3, baseDelayMs = 800, signal = null }) {
  let lastError = null
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    if (signal?.aborted) {
      const error = new Error("request aborted")
      error.code = "ABORT_ERR"
      throw error
    }
    try {
      return await execute(attempt)
    } catch (error) {
      lastError = error
      const status = Number(error?.status || error?.httpStatus || 0)
      let classification = classifyHttpError(status)

      // HTTP 400 with context_length_exceeded in body → treat as context_overflow
      if (classification === "bad_request" && /context_length_exceeded/i.test(error.message)) {
        classification = "context_overflow"
      }

      error.errorClass = classification

      if (classification === "auth") {
        error.message = `authentication failed (${status}): check your API key. ${error.message}`
        throw error
      }

      if (classification === "context_overflow") {
        error.needsCompaction = true
        throw error
      }

      const networkRetryable = error?.code === "ETIMEDOUT" || error?.code === "ECONNRESET" || error?.code === "ECONNREFUSED" || error?.code === "ENOTFOUND" || error?.code === "EHOSTUNREACH"
      if ((!isRetryable(classification) && !networkRetryable) || attempt >= attempts) {
        throw error
      }

      const delay = networkRetryable
        ? jitter(baseDelayMs * Math.pow(2, attempt - 1))
        : retryDelayMs(classification, baseDelayMs, attempt)
      await sleep(delay)
    }
  }
  throw lastError || new Error("request failed")
}
