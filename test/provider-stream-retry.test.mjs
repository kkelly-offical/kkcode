import test from "node:test"
import assert from "node:assert/strict"
import { requestOpenAIStream } from "../src/provider/openai.mjs"
import { requestAnthropicStream } from "../src/provider/anthropic.mjs"

function bodyStream(text) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    }
  })
}

function response(status, text = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: bodyStream(text),
    text: async () => text
  }
}

function failingBody(firstChunk) {
  const encoder = new TextEncoder()
  let step = 0
  return new ReadableStream({
    async pull(controller) {
      if (step === 0) {
        step++
        controller.enqueue(encoder.encode(firstChunk))
        await new Promise((resolve) => setTimeout(resolve, 5))
        return
      }
      const error = new Error("stream socket reset")
      error.code = "ECONNRESET"
      controller.error(error)
    }
  })
}

function openAIInput(extra = {}) {
  return {
    apiKey: "test-key",
    baseUrl: "https://api.example.test/v1",
    model: "test-model",
    system: "system",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    timeoutMs: 5000,
    retry: { attempts: 5, baseDelayMs: 0 },
    ...extra
  }
}

function anthropicInput(extra = {}) {
  return {
    ...openAIInput(extra),
    maxTokens: 100
  }
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test("OpenAI streaming retries retryable HTTP responses before consuming SSE", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) {
      const cause = new Error("DNS lookup temporarily failed")
      cause.code = "EAI_AGAIN"
      throw new TypeError("fetch failed", { cause })
    }
    if (calls === 2) return response(503, "temporarily unavailable")
    return response(200, [
      'data: {"choices":[{"delta":{"content":"connected"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n"
    ].join(""))
  }
  try {
    const chunks = await collect(requestOpenAIStream(openAIInput()))
    assert.equal(calls, 3)
    assert.equal(chunks.find((chunk) => chunk.type === "text")?.content, "connected")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("OpenAI streaming defaults to an initial request plus five reconnects", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return response(503, "temporarily unavailable")
  }
  try {
    await assert.rejects(
      collect(requestOpenAIStream(openAIInput({ retry: { baseDelayMs: 0 } }))),
      (error) => error.errorClass === "server"
    )
    assert.equal(calls, 6)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("OpenAI streaming retries a body failure before the first outward chunk", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) {
      return {
        ok: true,
        status: 200,
        body: failingBody('data: {"choices":'),
        text: async () => ""
      }
    }
    return response(200, [
      'data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n"
    ].join(""))
  }
  try {
    const chunks = await collect(requestOpenAIStream(openAIInput()))
    assert.equal(calls, 2)
    assert.equal(chunks.find((chunk) => chunk.type === "text")?.content, "recovered")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("OpenAI streaming retries a clean EOF before the first SSE event", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) return response(200, "")
    return response(200, [
      'data: {"choices":[{"delta":{"content":"after-empty"},"finish_reason":"stop"}]}\r\n\r\n',
      "data: [DONE]\r\n\r\n"
    ].join(""))
  }
  try {
    const chunks = await collect(requestOpenAIStream(openAIInput()))
    assert.equal(calls, 2)
    assert.equal(chunks.find((chunk) => chunk.type === "text")?.content, "after-empty")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Anthropic streaming accepts CRLF-framed SSE", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => response(200, [
    'event: content_block_start\r\ndata: {"content_block":{"type":"text"}}\r\n\r\n',
    'event: content_block_delta\r\ndata: {"delta":{"type":"text_delta","text":"valid-crlf"}}\r\n\r\n',
    'event: message_stop\r\ndata: {}\r\n\r\n'
  ].join(""))
  try {
    const chunks = await collect(requestAnthropicStream(anthropicInput()))
    assert.equal(chunks.find((chunk) => chunk.type === "text")?.content, "valid-crlf")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Anthropic streaming retries a body failure before the first outward chunk", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) {
      return {
        ok: true,
        status: 200,
        body: failingBody('event: content_block_delta\ndata: {"delta":'),
        text: async () => ""
      }
    }
    return response(200, [
      'event: content_block_start\ndata: {"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"recovered"}}\n\n',
      'event: message_stop\ndata: {}\n\n'
    ].join(""))
  }
  try {
    const chunks = await collect(requestAnthropicStream(anthropicInput()))
    assert.equal(calls, 2)
    assert.equal(chunks.find((chunk) => chunk.type === "text")?.content, "recovered")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Anthropic streaming retries rate limits but fast-fails authentication", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) return response(429, "rate limited")
    return response(200, [
      'event: content_block_start\ndata: {"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"connected"}}\n\n',
      'event: message_stop\ndata: {}\n\n'
    ].join(""))
  }
  try {
    const chunks = await collect(requestAnthropicStream(anthropicInput()))
    assert.equal(calls, 2)
    assert.equal(chunks.find((chunk) => chunk.type === "text")?.content, "connected")

    calls = 0
    globalThis.fetch = async () => {
      calls++
      return response(401, "unauthorized")
    }
    await assert.rejects(
      collect(requestAnthropicStream(anthropicInput())),
      (error) => error.errorClass === "auth"
    )
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("OpenAI streaming never replays a request after content starts", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return {
      ok: true,
      status: 200,
      body: failingBody('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
      text: async () => ""
    }
  }
  try {
    const seen = []
    await assert.rejects(
      async () => {
        for await (const chunk of requestOpenAIStream(openAIInput())) seen.push(chunk)
      },
      /stream socket reset/
    )
    assert.equal(calls, 1)
    assert.equal(seen.find((chunk) => chunk.type === "text")?.content, "partial")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Anthropic streaming never replays a request after content starts", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return {
      ok: true,
      status: 200,
      body: failingBody([
        'event: content_block_start\ndata: {"content_block":{"type":"text"}}\n\n',
        'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"partial"}}\n\n'
      ].join("")),
      text: async () => ""
    }
  }
  try {
    const seen = []
    await assert.rejects(
      async () => {
        for await (const chunk of requestAnthropicStream(anthropicInput())) seen.push(chunk)
      },
      /stream socket reset/
    )
    assert.equal(calls, 1)
    assert.equal(seen.find((chunk) => chunk.type === "text")?.content, "partial")
  } finally {
    globalThis.fetch = originalFetch
  }
})
