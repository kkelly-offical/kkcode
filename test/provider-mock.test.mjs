import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { requestOpenAI, requestOpenAIStream } from "../src/provider/openai.mjs"

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
    apiKey: "test-key",
    baseUrl,
    model: "test-model",
    system: "test system",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    timeoutMs: 5000,
    retry: { attempts: 2, baseDelayMs: 50 }
  }
}

// --- Test 1: Normal 200 response ---
test("requestOpenAI: normal 200 response parses correctly", async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      choices: [{ message: { content: "Hello back!", tool_calls: null } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    }))
  })
  try {
    const result = await requestOpenAI(defaultInput(mock.baseUrl))
    assert.equal(result.text, "Hello back!")
    assert.equal(result.usage.input, 10)
    assert.equal(result.usage.output, 5)
    assert.deepEqual(result.toolCalls, [])
  } finally {
    await stopServer(mock.server)
  }
})

// --- Test 2: 429 retry then success ---
test("requestOpenAI: 429 retries then succeeds", async () => {
  let callCount = 0
  const mock = await startMockServer((req, res) => {
    callCount++
    if (callCount === 1) {
      res.writeHead(429, { "content-type": "text/plain" })
      res.end("rate limited")
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      choices: [{ message: { content: "ok after retry" } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 }
    }))
  })
  try {
    const result = await requestOpenAI(defaultInput(mock.baseUrl))
    assert.equal(result.text, "ok after retry")
    assert.equal(callCount, 2)
  } finally {
    await stopServer(mock.server)
  }
})

// --- Test 3: 401 fast fail (no retry) ---
test("requestOpenAI: 401 fails immediately without retry", async () => {
  let callCount = 0
  const mock = await startMockServer((req, res) => {
    callCount++
    res.writeHead(401, { "content-type": "text/plain" })
    res.end("unauthorized")
  })
  try {
    await assert.rejects(
      () => requestOpenAI(defaultInput(mock.baseUrl)),
      (err) => {
        assert.ok(err.message.includes("authentication failed"))
        assert.equal(err.errorClass, "auth")
        return true
      }
    )
    assert.equal(callCount, 1)
  } finally {
    await stopServer(mock.server)
  }
})

// --- Test 4: Streaming 200 response ---
test("requestOpenAIStream: streaming response parses chunks", async () => {
  const sseBody = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: {"usage":{"prompt_tokens":8,"completion_tokens":4}}\n\n',
    'data: [DONE]\n\n'
  ].join("")

  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(sseBody)
  })
  try {
    const chunks = []
    for await (const chunk of requestOpenAIStream(defaultInput(mock.baseUrl))) {
      chunks.push(chunk)
    }
    const textChunks = chunks.filter((c) => c.type === "text")
    assert.equal(textChunks.map((c) => c.content).join(""), "Hello world")
    const usageChunk = chunks.find((c) => c.type === "usage")
    assert.ok(usageChunk)
    assert.equal(usageChunk.usage.input, 8)
    assert.equal(usageChunk.usage.output, 4)
  } finally {
    await stopServer(mock.server)
  }
})

// --- Test 5: Timeout ---
test("requestOpenAI: timeout triggers error", async () => {
  const mock = await startMockServer((req, res) => {
    // Never respond — let it timeout
    setTimeout(() => {
      try { res.writeHead(200); res.end("too late") } catch {}
    }, 10000)
  })
  try {
    const input = { ...defaultInput(mock.baseUrl), timeoutMs: 500, retry: { attempts: 1, baseDelayMs: 50 } }
    await assert.rejects(
      () => requestOpenAI(input),
      (err) => {
        assert.ok(err.name === "TimeoutError" || err.name === "AbortError" || err.code === "ABORT_ERR" || err.message.includes("abort"))
        return true
      }
    )
  } finally {
    await stopServer(mock.server)
  }
})

// --- Test 6: 400 context overflow ---
test("requestOpenAI: 400 context overflow sets needsCompaction", async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { code: "context_length_exceeded", message: "too long" } }))
  })
  try {
    await assert.rejects(
      () => requestOpenAI(defaultInput(mock.baseUrl)),
      (err) => {
        assert.equal(err.needsCompaction, true)
        assert.equal(err.errorClass, "context_overflow")
        return true
      }
    )
  } finally {
    await stopServer(mock.server)
  }
})
