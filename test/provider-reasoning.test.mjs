import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import {
  countTokensOpenAI,
  requestOpenAI,
  requestOpenAIStream
} from "../src/provider/openai.mjs"
import { requestAnthropic } from "../src/provider/anthropic.mjs"
import { requestOllama } from "../src/provider/ollama.mjs"
import { requestWithRetry } from "../src/provider/retry-policy.mjs"

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`
      })
    })
  })
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve))
}

function input(baseUrl, extra = {}) {
  return {
    apiKey: "test-key",
    baseUrl,
    provider: "kimi-code",
    model: "k3",
    system: "system",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    timeoutMs: 5000,
    retry: { attempts: 1, baseDelayMs: 10 },
    ...extra
  }
}

test("OpenAI-compatible response preserves Kimi reasoning and KK Code identity", async () => {
  let receivedHeaders
  let receivedBody
  const mock = await startServer((req, res) => {
    receivedHeaders = req.headers
    let body = ""
    req.on("data", (chunk) => { body += chunk })
    req.on("end", () => {
      receivedBody = JSON.parse(body)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: "final answer",
            reasoning_content: "private reasoning"
          }
        }],
        usage: { prompt_tokens: 4, completion_tokens: 2 }
      }))
    })
  })
  try {
    const result = await requestOpenAI(input(mock.baseUrl, { reasoningEffort: "high" }))
    assert.equal(result.text, "final answer")
    assert.equal(result.reasoning, "private reasoning")
    assert.match(receivedHeaders["user-agent"], /^KK-Code\//)
    assert.equal(receivedHeaders["x-kk-code-provider"], "kimi-code")
    assert.equal(receivedHeaders.accept, "application/json")
    assert.equal(receivedBody.reasoning_effort, "high")
  } finally {
    await stopServer(mock.server)
  }
})

test("Anthropic response preserves readable thinking without exposing protected fields", async () => {
  let receivedBody
  const mock = await startServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => { body += chunk })
    req.on("end", () => {
      receivedBody = JSON.parse(body)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        content: [
          { type: "thinking", thinking: "first thought", signature: "secret-signature-1" },
          { type: "redacted_thinking", data: "encrypted-redacted-thinking" },
          { type: "thinking", thinking: "second thought", signature: "secret-signature-2" },
          { type: "text", text: "final answer" },
          { type: "tool_use", id: "toolu_1", name: "read", input: { path: "README.md" } }
        ],
        usage: { input_tokens: 4, output_tokens: 2 }
      }))
    })
  })
  try {
    const result = await requestAnthropic({
      ...input(mock.baseUrl),
      provider: "anthropic",
      thinking: { type: "enabled", budget_tokens: 2048 }
    })
    assert.equal(result.text, "final answer")
    assert.equal(result.reasoning, "first thought\nsecond thought")
    assert.deepEqual(result.toolCalls, [{
      id: "toolu_1",
      name: "read",
      args: { path: "README.md" }
    }])
    assert.deepEqual(receivedBody.thinking, { type: "enabled", budget_tokens: 2048 })
    assert.doesNotMatch(JSON.stringify(result), /secret-signature|encrypted-redacted-thinking/)
  } finally {
    await stopServer(mock.server)
  }
})

test("Anthropic and Ollama requests use the same KK Code identity", async () => {
  const captured = []
  const mock = await startServer((req, res) => {
    captured.push({ url: req.url, headers: req.headers })
    res.writeHead(200, { "content-type": "application/json" })
    if (req.url === "/messages") {
      res.end(JSON.stringify({
        content: [{ type: "text", text: "anthropic" }],
        usage: { input_tokens: 1, output_tokens: 1 }
      }))
      return
    }
    res.end(JSON.stringify({
      message: { content: "ollama" },
      prompt_eval_count: 1,
      eval_count: 1
    }))
  })
  try {
    await requestAnthropic({
      ...input(mock.baseUrl),
      provider: "anthropic",
      maxTokens: 100
    })
    await requestOllama({
      baseUrl: mock.baseUrl,
      provider: "ollama",
      model: "local-model",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.equal(captured.length, 2)
    for (const request of captured) {
      assert.match(request.headers["user-agent"], /^KK-Code\//)
      assert.equal(request.headers["x-kk-code-client"], "cli")
      assert.equal(request.headers.accept, "application/json")
    }
    assert.equal(captured[0].headers["x-api-key"], "test-key")
    assert.equal(captured[1].headers["x-kk-code-provider"], "ollama")
  } finally {
    await stopServer(mock.server)
  }
})

test("OpenAI-compatible history replays reasoning_content without visible duplication", async () => {
  let payload
  const mock = await startServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => { body += chunk })
    req.on("end", () => {
      payload = JSON.parse(body)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 4, completion_tokens: 1 }
      }))
    })
  })
  try {
    await requestOpenAI(input(mock.baseUrl, {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "reasoned before" },
            { type: "text", text: "previous answer" }
          ]
        },
        { role: "user", content: "continue" }
      ]
    }))
    const assistant = payload.messages.find((message) => message.role === "assistant")
    assert.equal(assistant.reasoning_content, "reasoned before")
    assert.deepEqual(assistant.content, [{ type: "text", text: "previous answer" }])
    assert.doesNotMatch(JSON.stringify(assistant.content), /reasoned before/)
  } finally {
    await stopServer(mock.server)
  }
})

test("OpenAI-compatible stream emits typed thinking chunks for reasoning_content", async () => {
  const mock = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end([
      'data: {"choices":[{"delta":{"reasoning_content":"step one"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":" step two"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n"
    ].join(""))
  })
  try {
    const chunks = []
    for await (const chunk of requestOpenAIStream(input(mock.baseUrl))) chunks.push(chunk)
    const thinking = chunks.filter((chunk) => chunk.type === "thinking")
    assert.equal(thinking.map((chunk) => chunk.content).join(""), "step one step two")
    assert.ok(thinking.every((chunk) => chunk.source === "reasoning_content"))
    assert.equal(chunks.find((chunk) => chunk.type === "text")?.content, "answer")
  } finally {
    await stopServer(mock.server)
  }
})

test("OpenAI token counting never creates a billable completion", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw new Error("fetch must not be called")
  }
  try {
    assert.equal(await countTokensOpenAI(input("https://api.example.test/v1")), null)
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("provider retry delay reacts immediately to AbortSignal", async () => {
  const controller = new AbortController()
  let attempts = 0
  const started = Date.now()
  const pending = requestWithRetry({
    attempts: 3,
    baseDelayMs: 10000,
    signal: controller.signal,
    execute: async () => {
      attempts++
      const error = new Error("server error")
      error.httpStatus = 500
      throw error
    }
  })
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(pending, (error) => error.code === "ABORT_ERR")
  assert.equal(attempts, 1)
  assert.ok(Date.now() - started < 1000)
})
