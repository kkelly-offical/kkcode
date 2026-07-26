import test from "node:test"
import assert from "node:assert/strict"
import { requestAnthropic } from "../src/provider/anthropic.mjs"

function stubFetch(capture) {
  return async (_url, options) => {
    capture(JSON.parse(options.body))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: "text", text: "saw it" }],
        usage: { input_tokens: 1, output_tokens: 1 }
      }),
      text: async () => ""
    }
  }
}

async function captureRequest(messages) {
  const original = globalThis.fetch
  let captured = null
  globalThis.fetch = stubFetch((body) => { captured = body })
  try {
    await requestAnthropic({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      model: "claude-sonnet-5",
      system: "test",
      messages,
      tools: [],
      timeoutMs: 5000,
      retry: { attempts: 1, baseDelayMs: 0 }
    })
  } finally {
    globalThis.fetch = original
  }
  return captured
}

test("Anthropic: image block 映射成 source.base64", async () => {
  const body = await captureRequest([{
    role: "user",
    content: [
      { type: "text", text: "什么颜色" },
      { type: "image", mediaType: "image/jpeg", data: "QUJD" }
    ]
  }])

  const blocks = body.messages[0].content
  assert.equal(blocks[0].type, "text")
  assert.equal(blocks[1].type, "image")
  assert.deepEqual(blocks[1].source, { type: "base64", media_type: "image/jpeg", data: "QUJD" })
  // 裸 base64，不能带 data: 前缀
  assert.equal(blocks[1].source.data.startsWith("data:"), false)
})

test("Anthropic: 缺 mediaType 时退回 image/png", async () => {
  const body = await captureRequest([{
    role: "user",
    content: [{ type: "image", data: "QUJD" }]
  }])
  assert.equal(body.messages[0].content[0].source.media_type, "image/png")
})

test("Anthropic: tool_result 与其后的图片都活着进入请求", async () => {
  // Anthropic 的 tool_result 与 image 可以同处一条 user 消息，
  // 不像 OpenAI/Ollama 需要另起一条 —— 但两者都不能丢。
  const body = await captureRequest([
    { role: "user", content: "what colour is it" },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "x.png" } }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "Image file: x.png (137 bytes, image/png)" },
        { type: "image", mediaType: "image/png", data: "QUJD" }
      ]
    }
  ])

  const last = body.messages.at(-1).content
  assert.equal(last.length, 2)
  assert.equal(last[0].type, "tool_result")
  assert.equal(last[0].tool_use_id, "call_1")
  assert.equal(last[1].type, "image")
  assert.equal(last[1].source.data, "QUJD")

  const toolUse = body.messages[1].content[0]
  assert.equal(toolUse.type, "tool_use")
  assert.deepEqual(toolUse.input, { path: "x.png" })
})

test("Anthropic: 缺 data 的 image block 不会伪装成图片发出去", async () => {
  const body = await captureRequest([{
    role: "user",
    content: [{ type: "image", mediaType: "image/png" }]
  }])
  const block = body.messages[0].content[0]
  assert.equal(block.type, "text", "没有 base64 的 image block 只能降级成文本")
})
