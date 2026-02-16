import test from "node:test"
import assert from "node:assert/strict"
import { requestAnthropicStream } from "../src/provider/anthropic.mjs"

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

test("requestAnthropicStream: text-only streaming", async () => {
  const sseChunks = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":15}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":8}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ]

  const originalFetch = globalThis.fetch
  globalThis.fetch = mockFetch(sseChunks)
  try {
    const chunks = []
    for await (const chunk of requestAnthropicStream({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      model: "claude-3-5-sonnet-latest",
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
    assert.equal(usageChunks[0].usage.input, 15)
    assert.equal(usageChunks[0].usage.output, 8)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("requestAnthropicStream: tool_use block with input_json_delta", async () => {
  const sseChunks = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"read"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"path\\""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":":\\"test.js\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":12}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ]

  const originalFetch = globalThis.fetch
  globalThis.fetch = mockFetch(sseChunks)
  try {
    const chunks = []
    for await (const chunk of requestAnthropicStream({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      model: "claude-3-5-sonnet-latest",
      system: "sys",
      messages: [{ role: "user", content: "read file" }],
      tools: [{ name: "read", description: "read file", inputSchema: {} }],
      timeoutMs: 5000
    })) {
      chunks.push(chunk)
    }

    const toolChunks = chunks.filter((c) => c.type === "tool_call")
    assert.equal(toolChunks.length, 1)
    assert.equal(toolChunks[0].call.id, "toolu_1")
    assert.equal(toolChunks[0].call.name, "read")
    assert.deepEqual(toolChunks[0].call.args, { path: "test.js" })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("requestAnthropicStream: mixed text + tool_use blocks", async () => {
  const sseChunks = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Let me read that."}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_2","name":"bash"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"ls\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":20}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ]

  const originalFetch = globalThis.fetch
  globalThis.fetch = mockFetch(sseChunks)
  try {
    const chunks = []
    for await (const chunk of requestAnthropicStream({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      model: "claude-3-5-sonnet-latest",
      system: "sys",
      messages: [{ role: "user", content: "list files" }],
      tools: [{ name: "bash", description: "run command", inputSchema: {} }],
      timeoutMs: 5000
    })) {
      chunks.push(chunk)
    }

    const textChunks = chunks.filter((c) => c.type === "text")
    assert.equal(textChunks.length, 1)
    assert.equal(textChunks[0].content, "Let me read that.")

    const toolChunks = chunks.filter((c) => c.type === "tool_call")
    assert.equal(toolChunks.length, 1)
    assert.equal(toolChunks[0].call.name, "bash")
    assert.deepEqual(toolChunks[0].call.args, { cmd: "ls" })

    const usageChunks = chunks.filter((c) => c.type === "usage")
    assert.equal(usageChunks[0].usage.cacheRead, 5)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("requestAnthropicStream: missing API key throws", async () => {
  await assert.rejects(
    async () => {
      for await (const _ of requestAnthropicStream({
        apiKey: "",
        baseUrl: "https://api.example.com/v1",
        model: "claude-3-5-sonnet-latest",
        system: "sys",
        messages: [],
        tools: []
      })) { /* consume */ }
    },
    (err) => err.message.includes("missing API key")
  )
})
