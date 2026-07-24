import test, { afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  countTokensProvider,
  registerProvider,
  requestProvider,
  requestProviderStream
} from "../src/provider/router.mjs"
import {
  configureAuditStore,
  listAuditEntries,
  verifyAuditChain
} from "../src/storage/audit-store.mjs"

let tmpDir

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "provider-audit-"))
  process.env.KKCODE_HOME = tmpDir
  configureAuditStore({ reset: true })
})

afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(tmpDir, { recursive: true, force: true })
})

function configFor(name, provider) {
  return {
    config: {
      provider: {
        default: name,
        [name]: {
          default_model: "audit-model",
          timeout_ms: 1000,
          retry_attempts: 1,
          ...provider
        }
      }
    }
  }
}

function responseJson(body, { status = 200, requestId = "upstream-request-1" } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId
    }
  })
}

test("OpenAI and Anthropic inference reuse caller correlation identity", async () => {
  const originalFetch = global.fetch
  const requests = []
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), headers: options.headers })
    if (String(url).endsWith("/messages")) {
      return responseJson({
        content: [{ type: "text", text: "anthropic private output" }],
        usage: { input_tokens: 3, output_tokens: 2 }
      }, { requestId: "anthropic-upstream" })
    }
    return responseJson({
      choices: [{ message: { content: "openai private output" } }],
      usage: { prompt_tokens: 4, completion_tokens: 2 }
    }, { requestId: "openai-upstream" })
  }

  const traceId = "trace-provider-identity"
  const reviewId = "review-provider-identity"
  const openaiRequestId = "11111111-1111-4111-8111-111111111111"
  const anthropicRequestId = "22222222-2222-4222-8222-222222222222"
  try {
    await requestProvider({
      configState: configFor("openai-gateway", {
        type: "openai-compatible",
        protocol: "openai",
        base_url: "https://openai.example.test/v1",
        api_key: "openai-test-secret"
      }),
      providerType: "openai-gateway",
      system: "private system prompt",
      messages: [{ role: "user", content: "private user prompt" }],
      tools: [],
      traceId,
      reviewId,
      requestId: openaiRequestId
    })
    await requestProvider({
      configState: configFor("anthropic-gateway", {
        type: "anthropic",
        protocol: "anthropic",
        base_url: "https://anthropic.example.test/v1",
        api_key: "anthropic-test-secret"
      }),
      providerType: "anthropic-gateway",
      system: "another private system prompt",
      messages: [{ role: "user", content: "another private user prompt" }],
      tools: [],
      traceId,
      reviewId,
      requestId: anthropicRequestId
    })

    assert.equal(requests[0].headers["X-KK-Code-Protocol"], "openai")
    assert.equal(requests[0].headers["X-KK-Code-Request-Id"], openaiRequestId)
    assert.equal(requests[0].headers["X-Client-Request-Id"], openaiRequestId)
    assert.equal(requests[1].headers["X-KK-Code-Protocol"], "anthropic")
    assert.equal(requests[1].headers["X-KK-Code-Request-Id"], anthropicRequestId)
    assert.equal(requests[1].headers["X-Client-Request-Id"], undefined)

    const entries = await listAuditEntries({ traceId, limit: 20 })
    const serialized = JSON.stringify(entries)
    assert.equal(entries.filter((entry) => entry.type === "provider.request.finish").length, 2)
    assert.ok(entries.every((entry) => entry.reviewId === reviewId))
    assert.ok(entries.some((entry) => entry.upstreamRequestId === "openai-upstream"))
    assert.ok(entries.some((entry) => entry.upstreamRequestId === "anthropic-upstream"))
    assert.doesNotMatch(serialized, /private (?:system|user|output)|test-secret/)
    assert.equal((await verifyAuditChain()).ok, true)
  } finally {
    global.fetch = originalFetch
  }
})

test("provider failures are audited without upstream bodies or prompt text", async () => {
  const driver = `audit-error-${Date.now()}`
  registerProvider(driver, {
    async request() {
      throw new Error("upstream echoed private-prompt-body and " + "sk-kimi-" + "abcdefghijklmnopqrstuvwxyz")
    },
    async *requestStream() {}
  })
  const traceId = "trace-provider-error"

  await assert.rejects(
    requestProvider({
      configState: configFor("failing-gateway", {
        type: driver,
        protocol: "openai",
        base_url: "https://user:password@example.test/v1?api_key=secret",
        api_key: "provider-secret"
      }),
      providerType: "failing-gateway",
      system: "private-prompt-body",
      messages: [{ role: "user", content: "private-prompt-body" }],
      tools: [],
      traceId
    }),
    /private-prompt-body/
  )

  const entries = await listAuditEntries({ traceId })
  const failed = entries.find((entry) => entry.type === "provider.request.error")
  const serialized = JSON.stringify(entries)
  assert.equal(failed.status, "error")
  assert.equal(failed.reason, "unknown")
  assert.equal(failed.error, "provider request failed")
  assert.match(entries.find((entry) => entry.type === "provider.request.start").endpoint, /^https:\/\/example\.test\/v1\/chat\/completions$/)
  assert.doesNotMatch(serialized, /private-prompt-body|provider-secret|password|api_key=secret|abcdefghijklmnopqrstuvwxyz/)
})

test("Anthropic token counting reuses identity and emits a body-free audit span", async () => {
  const originalFetch = global.fetch
  let observedHeaders = null
  global.fetch = async (_url, options) => {
    observedHeaders = options.headers
    return responseJson({ input_tokens: 17 }, { requestId: "count-upstream" })
  }
  const traceId = "trace-token-count"
  const requestId = "33333333-3333-4333-8333-333333333333"
  try {
    const count = await countTokensProvider({
      configState: configFor("anthropic-count", {
        type: "anthropic",
        base_url: "https://anthropic.example.test/v1",
        api_key: "count-secret"
      }),
      providerType: "anthropic-count",
      system: "private count system",
      messages: [{ role: "user", content: "private count prompt" }],
      tools: [],
      traceId,
      requestId
    })
    assert.equal(count, 17)
    assert.equal(observedHeaders["X-KK-Code-Request-Id"], requestId)
    assert.equal(observedHeaders["X-KK-Code-Protocol"], "anthropic")
    const entries = await listAuditEntries({ traceId })
    const finished = entries.find((entry) => entry.type === "provider.token_count.finish")
    assert.equal(finished.tokenCount, 17)
    assert.equal(finished.upstreamRequestId, "count-upstream")
    assert.doesNotMatch(JSON.stringify(entries), /private count|count-secret/)
  } finally {
    global.fetch = originalFetch
  }
})

test("authless Anthropic token counting remains a guarded, audited remote request", async () => {
  const originalFetch = global.fetch
  let observed = null
  global.fetch = async (url, options) => {
    observed = { url: String(url), headers: options.headers }
    return responseJson({ input_tokens: 9 }, { requestId: "authless-count-upstream" })
  }
  const traceId = "trace-authless-token-count"
  try {
    const count = await countTokensProvider({
      configState: configFor("local-anthropic", {
        type: "anthropic",
        base_url: "http://127.0.0.1:11434/v1",
        api_key_env: ""
      }),
      providerType: "local-anthropic",
      system: "",
      messages: [{ role: "user", content: "count this" }],
      tools: [],
      traceId
    })
    assert.equal(count, 9)
    assert.equal(observed.url, "http://127.0.0.1:11434/v1/messages/count_tokens")
    assert.equal(observed.headers["X-Api-Key"], undefined)
    const entries = await listAuditEntries({ traceId })
    assert.ok(entries.some((entry) => entry.type === "provider.token_count.finish"))
  } finally {
    global.fetch = originalFetch
  }
})

test("completed provider streams audit usage without streamed content", async () => {
  const driver = `audit-stream-${Date.now()}`
  registerProvider(driver, {
    async request() {
      return { text: "", usage: {}, toolCalls: [] }
    },
    async *requestStream(input) {
      input.onResponse(new Response(null, {
        status: 200,
        headers: { "x-request-id": "stream-upstream" }
      }))
      yield { type: "text", content: "private streamed output" }
      yield { type: "usage", usage: { input: 8, output: 5, cacheRead: 2, cacheWrite: 0 } }
      yield { type: "stop", reason: "end_turn" }
    }
  })
  const traceId = "trace-provider-stream"
  const chunks = []
  for await (const chunk of requestProviderStream({
    configState: configFor("stream-gateway", {
      type: driver,
      protocol: "openai",
      base_url: "https://stream.example.test/v1",
      api_key: "stream-secret"
    }),
    providerType: "stream-gateway",
    system: "private system",
    messages: [{ role: "user", content: "private prompt" }],
    tools: [],
    traceId
  })) {
    chunks.push(chunk)
  }

  assert.equal(chunks[0].content, "private streamed output")
  const entries = await listAuditEntries({ traceId })
  const finished = entries.find((entry) => entry.type === "provider.request.finish")
  assert.deepEqual(finished.usage, { input: 8, output: 5, cacheRead: 2, cacheWrite: 0 })
  assert.equal(finished.stopReason, "end_turn")
  assert.equal(finished.upstreamRequestId, "stream-upstream")
  assert.doesNotMatch(JSON.stringify(entries), /private streamed output|private prompt|stream-secret/)
})

test("closing a provider stream early records cancellation without changing iterator semantics", async () => {
  const driver = `audit-cancel-${Date.now()}`
  let providerFinallyRan = false
  registerProvider(driver, {
    async request() {
      return { text: "", usage: {}, toolCalls: [] }
    },
    async *requestStream() {
      try {
        yield { type: "text", content: "first private chunk" }
        yield { type: "text", content: "second private chunk" }
      } finally {
        providerFinallyRan = true
      }
    }
  })
  const traceId = "trace-provider-cancel"
  const iterator = requestProviderStream({
    configState: configFor("cancel-gateway", {
      type: driver,
      protocol: "openai",
      base_url: "https://cancel.example.test/v1",
      api_key: "cancel-secret"
    }),
    providerType: "cancel-gateway",
    system: "private system",
    messages: [{ role: "user", content: "private prompt" }],
    tools: [],
    traceId
  })

  assert.equal((await iterator.next()).value.content, "first private chunk")
  const closed = await iterator.return()
  assert.equal(closed.done, true)
  assert.equal(providerFinallyRan, true)

  const entries = await listAuditEntries({ traceId })
  const cancelled = entries.find((entry) => entry.type === "provider.request.error")
  assert.equal(cancelled.status, "cancelled")
  assert.equal(cancelled.reason, "consumer_closed")
  assert.doesNotMatch(JSON.stringify(entries), /first private chunk|private prompt|cancel-secret/)
})
