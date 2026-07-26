import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { requestOllama, requestOllamaStream } from "../src/provider/ollama.mjs"

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` })
    })
  })
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve))
}

function defaultInput(baseUrl) {
  return {
    apiKey: "",
    baseUrl,
    model: "llama3.1",
    system: "test system",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    timeoutMs: 5000,
    retry: { attempts: 1, baseDelayMs: 0 }
  }
}

test("requestOllama: normal response parses correctly", async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      model: "llama3.1",
      message: { role: "assistant", content: "Hello back!" },
      done: true,
      prompt_eval_count: 15,
      eval_count: 8
    }))
  })
  try {
    const result = await requestOllama(defaultInput(mock.baseUrl))
    assert.equal(result.text, "Hello back!")
    assert.equal(result.usage.input, 15)
    assert.equal(result.usage.output, 8)
    assert.deepEqual(result.toolCalls, [])
  } finally {
    await stopServer(mock.server)
  }
})

test("requestOllamaStream: NDJSON streaming parses chunks", async () => {
  const ndjson = [
    JSON.stringify({ model: "llama3.1", message: { role: "assistant", content: "Hello" }, done: false }),
    JSON.stringify({ model: "llama3.1", message: { role: "assistant", content: " world" }, done: false }),
    JSON.stringify({ model: "llama3.1", message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 10, eval_count: 5 })
  ].join("\n") + "\n"

  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" })
    res.end(ndjson)
  })
  try {
    const chunks = []
    for await (const chunk of requestOllamaStream(defaultInput(mock.baseUrl))) {
      chunks.push(chunk)
    }
    const textChunks = chunks.filter((c) => c.type === "text")
    assert.equal(textChunks.map((c) => c.content).join(""), "Hello world")
    const usageChunk = chunks.find((c) => c.type === "usage")
    assert.ok(usageChunk)
    assert.equal(usageChunk.usage.input, 10)
    assert.equal(usageChunk.usage.output, 5)
  } finally {
    await stopServer(mock.server)
  }
})

test("requestOllama: tool call response parses correctly", async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      model: "llama3.1",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          function: { name: "read", arguments: { path: "test.txt" } }
        }]
      },
      done: true,
      prompt_eval_count: 20,
      eval_count: 10
    }))
  })
  try {
    const result = await requestOllama(defaultInput(mock.baseUrl))
    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0].name, "read")
    assert.deepEqual(result.toolCalls[0].args, { path: "test.txt" })
  } finally {
    await stopServer(mock.server)
  }
})

function captureRequest(handler) {
  return (req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      handler(JSON.parse(Buffer.concat(chunks).toString()))
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        model: "llava",
        message: { role: "assistant", content: "saw it" },
        done: true,
        prompt_eval_count: 1,
        eval_count: 1
      }))
    })
  }
}

test("requestOllama: 图片进入原生的 images 字段，而不是被静默丢掉", async () => {
  // 此前 content 数组的兜底分支只抽 text 块，image 块直接消失 —— 用户看不出
  // 任何异常，模型也从没收到图。Ollama 原生 API 的图片是消息级的 images 数组。
  let captured = null
  const mock = await startMockServer(captureRequest((body) => { captured = body }))
  try {
    await requestOllama({
      ...defaultInput(mock.baseUrl),
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "看看这张图" },
          { type: "image", mediaType: "image/png", data: "QUJD" }
        ]
      }]
    })
    const user = captured.messages.filter((m) => m.role === "user")
    assert.equal(user.length, 1)
    assert.equal(user[0].content, "看看这张图")
    assert.deepEqual(user[0].images, ["QUJD"], "图片必须活着进入请求")
  } finally {
    await stopServer(mock.server)
  }
})

test("requestOllama: images 只收裸 base64，data: 前缀要剥掉", async () => {
  let captured = null
  const mock = await startMockServer(captureRequest((body) => { captured = body }))
  try {
    await requestOllama({
      ...defaultInput(mock.baseUrl),
      messages: [{
        role: "user",
        content: [{ type: "image", mediaType: "image/png", data: "data:image/png;base64,QUJD" }]
      }]
    })
    const user = captured.messages.find((m) => m.role === "user")
    assert.deepEqual(user.images, ["QUJD"])
    // 只有图片时 content 是空串，不能是 "[object Object]"
    assert.equal(user.content, "")
  } finally {
    await stopServer(mock.server)
  }
})

test("requestOllama: tool_result 之后的图片另起一条 user 消息", async () => {
  // 与 openai.mjs 在 0.6.11 修掉的是同一形状：tool_result 分支处理完就 continue，
  // 把同一条消息里跟在后面的 image 块连同整条消息一起丢掉。
  let captured = null
  const mock = await startMockServer(captureRequest((body) => { captured = body }))
  try {
    await requestOllama({
      ...defaultInput(mock.baseUrl),
      messages: [
        { role: "user", content: "what colour is it" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "x.png" } }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "Image file: x.png (137 bytes, image/png)" },
            { type: "image", mediaType: "image/png", data: "QUJD" }
          ]
        }
      ]
    })
    const toolMessages = captured.messages.filter((m) => m.role === "tool")
    assert.equal(toolMessages.length, 1, "tool_result 仍要产出一条 tool 消息")
    assert.equal(typeof toolMessages[0].content, "string")
    assert.equal(toolMessages[0].images, undefined, "tool 消息装不下图片")

    const withImages = captured.messages.filter((m) => Array.isArray(m.images))
    assert.equal(withImages.length, 1, "图片必须活着进入请求")
    assert.equal(withImages[0].role, "user")
    assert.deepEqual(withImages[0].images, ["QUJD"])
  } finally {
    await stopServer(mock.server)
  }
})

test("requestOllama: 没有图片的消息不带 images 字段", async () => {
  let captured = null
  const mock = await startMockServer(captureRequest((body) => { captured = body }))
  try {
    await requestOllama({
      ...defaultInput(mock.baseUrl),
      messages: [
        { role: "user", content: [{ type: "text", text: "纯文本" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "done" }] }
      ]
    })
    for (const message of captured.messages) {
      assert.equal("images" in message, false, `${message.role} 不该带 images`)
    }
    const user = captured.messages.find((m) => m.role === "user")
    assert.equal(user.content, "纯文本")
  } finally {
    await stopServer(mock.server)
  }
})

test("requestOllamaStream: 图片同样进入流式请求的 images 字段", async () => {
  let captured = null
  const mock = await startMockServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      captured = JSON.parse(Buffer.concat(chunks).toString())
      res.writeHead(200, { "content-type": "application/x-ndjson" })
      res.end(JSON.stringify({
        model: "llava",
        message: { role: "assistant", content: "ok" },
        done: true,
        prompt_eval_count: 1,
        eval_count: 1
      }) + "\n")
    })
  })
  try {
    for await (const _chunk of requestOllamaStream({
      ...defaultInput(mock.baseUrl),
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", mediaType: "image/jpeg", data: "QUJD" }
        ]
      }]
    })) { /* drain */ }
    const user = captured.messages.find((m) => m.role === "user")
    assert.deepEqual(user.images, ["QUJD"])
  } finally {
    await stopServer(mock.server)
  }
})

test("requestOllama: server error throws ProviderError", async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(500, { "content-type": "text/plain" })
    res.end("internal error")
  })
  try {
    await assert.rejects(
      () => requestOllama(defaultInput(mock.baseUrl)),
      (err) => {
        assert.ok(err.message.includes("ollama request failed"))
        assert.ok(err.message.includes("500"))
        return true
      }
    )
  } finally {
    await stopServer(mock.server)
  }
})
