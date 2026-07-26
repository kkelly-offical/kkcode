import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { listProviders, registerProvider, requestProvider } from "../src/provider/router.mjs"

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

function openaiResponse(text = "hello") {
  return JSON.stringify({
    choices: [{ message: { role: "assistant", content: text, tool_calls: null } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  })
}

test("openai-compatible is registered", () => {
  assert.ok(listProviders().includes("openai-compatible"))
})

test("custom provider with type field resolves correctly", async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(openaiResponse("from deepseek"))
  })
  const configState = {
    config: {
      provider: {
        default: "deepseek",
        deepseek: {
          type: "openai-compatible",
          base_url: mock.baseUrl,
          api_key_env: "",
          default_model: "deepseek-chat",
          timeout_ms: 5000,
          retry_attempts: 1,
          retry_base_delay_ms: 100
        }
      }
    }
  }
  try {
    const result = await requestProvider({
      configState,
      providerType: "deepseek",
      system: "test",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.equal(result.text, "from deepseek")
    assert.equal(result.usage.input, 10)
  } finally {
    await stopServer(mock.server)
  }
})

test("unknown type falls back to openai", async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(openaiResponse("fallback"))
  })
  const configState = {
    config: {
      provider: {
        default: "custom",
        custom: {
          type: "nonexistent-type",
          base_url: mock.baseUrl,
          api_key_env: "",
          default_model: "test-model",
          timeout_ms: 5000,
          retry_attempts: 1,
          retry_base_delay_ms: 100
        }
      }
    }
  }
  try {
    const result = await requestProvider({
      configState,
      providerType: "custom",
      system: "test",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.equal(result.text, "fallback")
  } finally {
    await stopServer(mock.server)
  }
})

test("direct openai-compatible providerType works", async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(openaiResponse("direct"))
  })
  const configState = {
    config: {
      provider: {
        default: "openai-compatible",
        "openai-compatible": {
          base_url: mock.baseUrl,
          api_key_env: "",
          default_model: "test-model",
          timeout_ms: 5000,
          retry_attempts: 1,
          retry_base_delay_ms: 100
        }
      }
    }
  }
  try {
    const result = await requestProvider({
      configState,
      providerType: "openai-compatible",
      system: "test",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.equal(result.text, "direct")
  } finally {
    await stopServer(mock.server)
  }
})

test("an image alongside tool_result survives into the request", async () => {
  // 0.6.10 的真模型验收发现的缺陷：tool_result 分支处理完 tool 消息后直接
  // `continue`，把**同一条消息里跟在后面的 image 块连同整条消息一起丢掉**。
  // 而 0.6.8 起 read 读到的图片正是挂在 tool_result 之后 —— 图片在会话历史里
  // 完好无损，却从未进入请求，模型只看到一行 `Image file: x.png (137 bytes)`，
  // 「可视觉分析」是句空话。视觉模型实测确认：修好后它能直接看图作答。
  //
  // OpenAI 的 role:"tool" 消息只接受字符串 content，所以图片必须另起一条
  // user 消息，不能塞回 tool 消息里。
  let captured = null
  const mock = await startMockServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      captured = JSON.parse(Buffer.concat(chunks).toString())
      res.writeHead(200, { "content-type": "application/json" })
      res.end(openaiResponse("saw it"))
    })
  })
  const configState = {
    config: {
      provider: {
        default: "vision",
        vision: {
          type: "openai-compatible",
          base_url: mock.baseUrl,
          api_key_env: "",
          default_model: "vision-model",
          timeout_ms: 5000,
          retry_attempts: 1,
          retry_base_delay_ms: 100
        }
      }
    }
  }
  try {
    await requestProvider({
      configState,
      providerType: "vision",
      system: "test",
      messages: [
        { role: "user", content: "what colour is it" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "x.png" } }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "Image file: x.png (137 bytes, image/png)" },
            { type: "image", data: "QUJD", mediaType: "image/png" }
          ]
        }
      ],
      tools: []
    })

    const toolMessages = captured.messages.filter((m) => m.role === "tool")
    assert.equal(toolMessages.length, 1, "tool_result 仍要产出一条 tool 消息")
    assert.equal(typeof toolMessages[0].content, "string", "tool 消息的 content 必须是字符串")

    const imageParts = captured.messages
      .filter((m) => Array.isArray(m.content))
      .flatMap((m) => m.content)
      .filter((b) => b?.type === "image_url")
    assert.equal(imageParts.length, 1, "图片必须活着进入请求")
    assert.match(imageParts[0].image_url.url, /^data:image\/png;base64,QUJD/)
  } finally {
    await stopServer(mock.server)
  }
})
