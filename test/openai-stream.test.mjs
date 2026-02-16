import test from "node:test"
import assert from "node:assert/strict"
import { requestOpenAIStream } from "../src/provider/openai.mjs"

function makeSSEStream(chunks) {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]))
      } else {
        controller.close()
      }
    }
  })
}

function mockFetch(sseChunks, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    body: makeSSEStream(sseChunks),
    text: async () => "error"
  })
}

test("requestOpenAIStream: text-only streaming", async () => {
  const sseChunks = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
    'data: [DONE]\n\n'
  ]

  const originalFetch = globalThis.fetch
  globalThis.fetch = mockFetch(sseChunks)
  try {
    const chunks = []
    for await (const chunk of requestOpenAIStream({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      system: "You are helpful.",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      timeoutMs: 5000
    })) {
      chunks.push(chunk)
    }

    const textChunks = chunks.filter((c) => c.type === "text")
    assert.equal(textChunks.length, 2)
    assert.equal(textChunks[0].content, "Hello")
    assert.equal(textChunks[1].content, " world")

    const usageChunks = chunks.filter((c) => c.type === "usage")
    assert.equal(usageChunks.length, 1)
    assert.equal(usageChunks[0].usage.input, 10)
    assert.equal(usageChunks[0].usage.output, 5)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("requestOpenAIStream: tool call delta buffering", async () => {
  const sseChunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"test.js\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":20,"completion_tokens":10}}\n\n',
    'data: [DONE]\n\n'
  ]

  const originalFetch = globalThis.fetch
  globalThis.fetch = mockFetch(sseChunks)
  try {
    const chunks = []
    for await (const chunk of requestOpenAIStream({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      system: "sys",
      messages: [{ role: "user", content: "read file" }],
      tools: [{ name: "read", description: "read file", inputSchema: {} }],
      timeoutMs: 5000
    })) {
      chunks.push(chunk)
    }

    const toolChunks = chunks.filter((c) => c.type === "tool_call")
    assert.equal(toolChunks.length, 1)
    assert.equal(toolChunks[0].call.id, "call_1")
    assert.equal(toolChunks[0].call.name, "read")
    assert.deepEqual(toolChunks[0].call.args, { path: "test.js" })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("requestOpenAIStream: missing API key throws", async () => {
  await assert.rejects(
    async () => {
      for await (const _ of requestOpenAIStream({
        apiKey: "",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
        system: "sys",
        messages: [],
        tools: []
      })) { /* consume */ }
    },
    (err) => err.message.includes("missing API key")
  )
})
