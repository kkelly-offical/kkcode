import test from "node:test"
import assert from "node:assert/strict"
import { EventBus } from "../src/core/events.mjs"
import { EVENT_TYPES } from "../src/core/constants.mjs"
import { requestProvider } from "../src/provider/router.mjs"

test("provider retry events preserve correlation and expose reconnect numbering", async () => {
  const providerName = `retry-event-${Date.now()}`
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) {
      const cause = new Error("temporary network failure")
      cause.code = "ECONNRESET"
      throw new TypeError("fetch failed", { cause })
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  }

  const events = []
  const unsubscribe = EventBus.subscribe((event) => {
    if (event.type === EVENT_TYPES.PROVIDER_RETRY) events.push(event)
  })
  try {
    await requestProvider({
      configState: {
        config: {
          provider: {
            default: providerName,
            [providerName]: {
              type: "openai-compatible",
              protocol: "openai",
              base_url: "https://retry.example.test/v1",
              api_key_env: "",
              default_model: "retry-model",
              retry_attempts: 1,
              retry_base_delay_ms: 100
            }
          }
        }
      },
      providerType: providerName,
      system: "",
      messages: [],
      tools: [],
      sessionId: "session-retry",
      turnId: "turn-retry",
      traceId: "trace-retry",
      requestId: "request-retry",
      parentEventId: "event-parent"
    })
  } finally {
    unsubscribe()
    globalThis.fetch = originalFetch
  }

  assert.equal(calls, 2)
  assert.equal(events.length, 1)
  assert.equal(events[0].sessionId, "session-retry")
  assert.equal(events[0].turnId, "turn-retry")
  assert.equal(events[0].traceId, "trace-retry")
  assert.equal(events[0].requestId, "request-retry")
  assert.equal(events[0].parentEventId, "event-parent")
  assert.deepEqual(events[0].payload, {
    provider: providerName,
    model: "retry-model",
    retryAttempt: 1,
    maxRetries: 1,
    requestAttempt: 1,
    totalAttempts: 2,
    classification: "network",
    delayMs: events[0].payload.delayMs
  })
  assert.equal(Number.isFinite(events[0].payload.delayMs), true)
  assert.equal("error" in events[0].payload, false)
})

test("router preserves the final native network classification", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    const cause = new Error("connection refused")
    cause.code = "ECONNREFUSED"
    throw new TypeError("fetch failed", { cause })
  }
  try {
    await assert.rejects(
      requestProvider({
        configState: {
          config: {
            provider: {
              default: "network-final",
              "network-final": {
                type: "openai-compatible",
                protocol: "openai",
                base_url: "https://network.example.test/v1",
                api_key_env: "",
                default_model: "network-model",
                retry_attempts: 0
              }
            }
          }
        },
        providerType: "network-final",
        system: "",
        messages: [],
        tools: []
      }),
      (error) => error.errorClass === "network" && error.reason === "network"
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
