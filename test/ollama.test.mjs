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
    timeoutMs: 5000
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
