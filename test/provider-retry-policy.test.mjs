import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"
import {
  classifyHttpError,
  classifyRequestError,
  isRetryableRequestError,
  requestWithRetry,
  retryAfterMsFromHeaders
} from "../src/provider/retry-policy.mjs"

function httpError(status, message = `HTTP ${status}`) {
  const error = new Error(message)
  error.httpStatus = status
  return error
}

test("provider retry defaults reconnect five times after the initial request", async () => {
  // 0.7.3 起 DEFAULT_CONFIG 不再预置 provider 条目。「默认重试 5 次」的载体
  // 是 router 读取点的 `retry_attempts ?? 5` —— 用户自建的 provider 从来没有
  // 这个字段，走的一直是这条路。这里断言源码里的缺省仍是 5：
  const routerSrc = await readFile(new URL("../src/provider/router.mjs", import.meta.url), "utf8")
  const defaults = [...routerSrc.matchAll(/retry_attempts \?\? (\d+)/g)].map((m) => m[1])
  assert.ok(defaults.length >= 2, "router 里应有 retry_attempts ?? N 的缺省")
  assert.ok(defaults.every((n) => n === "5"), `代码级缺省应为 5，实际 ${defaults}`)

  let calls = 0
  const retries = []
  await assert.rejects(
    requestWithRetry({
      baseDelayMs: 0,
      onRetry: async (info) => retries.push(info),
      execute: async () => {
        calls++
        throw httpError(503)
      }
    }),
    (error) => error.errorClass === "server"
  )
  assert.equal(calls, 6)
  assert.deepEqual(retries.map((info) => [info.retryAttempt, info.maxRetries]), [
    [1, 5],
    [2, 5],
    [3, 5],
    [4, 5],
    [5, 5]
  ])
})

test("HTTP retry classification covers transient statuses and fast-fail client errors", () => {
  for (const status of [408, 409, 425]) {
    assert.equal(classifyHttpError(status), "transient")
    assert.equal(isRetryableRequestError(httpError(status)), true)
  }
  assert.equal(classifyHttpError(429), "rate_limit")
  assert.equal(classifyHttpError(500), "server")
  assert.equal(classifyHttpError(599), "server")
  assert.equal(isRetryableRequestError(httpError(429)), true)
  assert.equal(isRetryableRequestError(httpError(503)), true)

  assert.equal(classifyHttpError(401), "auth")
  assert.equal(classifyHttpError(403), "auth")
  assert.equal(classifyHttpError(400), "bad_request")
  assert.equal(classifyHttpError(404), "bad_request")
  assert.equal(classifyHttpError(422), "bad_request")
  assert.equal(classifyHttpError(413), "context_overflow")
  assert.equal(isRetryableRequestError(httpError(401)), false)
  assert.equal(isRetryableRequestError(httpError(400)), false)
  assert.equal(isRetryableRequestError(httpError(413)), false)
})

test("nested fetch causes and connection timeouts are retryable", () => {
  const socketError = new Error("socket closed")
  socketError.code = "ECONNRESET"
  const fetchError = new TypeError("fetch failed", { cause: socketError })
  assert.equal(classifyRequestError(fetchError), "network")
  assert.equal(isRetryableRequestError(fetchError), true)

  const timeout = new Error("connection expired")
  timeout.name = "TimeoutError"
  assert.equal(classifyRequestError(timeout), "timeout")
  assert.equal(isRetryableRequestError(timeout), true)

  const browserFetchError = new TypeError("Failed to fetch")
  assert.equal(classifyRequestError(browserFetchError), "network")
})

test("network causes retry until a later attempt succeeds", async () => {
  let calls = 0
  const result = await requestWithRetry({
    attempts: 5,
    baseDelayMs: 0,
    execute: async () => {
      calls++
      if (calls < 4) {
        const cause = new Error("connection reset")
        cause.code = "ECONNRESET"
        throw new TypeError("fetch failed", { cause })
      }
      return "connected"
    }
  })
  assert.equal(result, "connected")
  assert.equal(calls, 4)
})

test("auth, bad request, and context overflow fail immediately", async () => {
  for (const status of [401, 400, 404, 422]) {
    let calls = 0
    await assert.rejects(
      requestWithRetry({
        attempts: 5,
        baseDelayMs: 0,
        execute: async () => {
          calls++
          throw httpError(status)
        }
      }),
      (error) => {
        if (status === 401) {
          assert.equal(error.errorClass, "auth")
          assert.match(error.message, /authentication failed/)
        } else {
          assert.equal(error.errorClass, "bad_request")
        }
        return true
      }
    )
    assert.equal(calls, 1)
  }

  let contextCalls = 0
  await assert.rejects(
    requestWithRetry({
      attempts: 5,
      baseDelayMs: 0,
      execute: async () => {
        contextCalls++
        throw httpError(400, "context_length_exceeded: prompt is too long")
      }
    }),
    (error) => error.errorClass === "context_overflow" && error.needsCompaction === true
  )
  assert.equal(contextCalls, 1)
})

test("an explicit caller abort is never classified as a reconnectable timeout", async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await assert.rejects(
    requestWithRetry({
      attempts: 5,
      baseDelayMs: 0,
      signal: controller.signal,
      execute: async () => {
        calls++
        throw new DOMException("aborted", "AbortError")
      }
    }),
    (error) => error.code === "ABORT_ERR"
  )
  assert.equal(calls, 0)
})

test("Retry-After supports delta seconds and HTTP dates", () => {
  assert.equal(retryAfterMsFromHeaders(new Headers({ "retry-after": "1.5" })), 1500)
  assert.equal(retryAfterMsFromHeaders(
    new Headers({ "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }),
    Date.parse("Wed, 21 Oct 2015 07:27:58 GMT")
  ), 2000)
  assert.equal(retryAfterMsFromHeaders(new Headers({ "retry-after": "invalid" })), null)
})
