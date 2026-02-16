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
          api_key_env: "TEST_DEEPSEEK_KEY",
          default_model: "deepseek-chat",
          timeout_ms: 5000,
          retry_attempts: 1,
          retry_base_delay_ms: 100
        }
      }
    }
  }
  process.env.TEST_DEEPSEEK_KEY = "test-key"
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
    delete process.env.TEST_DEEPSEEK_KEY
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
          api_key_env: "TEST_CUSTOM_KEY",
          default_model: "test-model",
          timeout_ms: 5000,
          retry_attempts: 1,
          retry_base_delay_ms: 100
        }
      }
    }
  }
  process.env.TEST_CUSTOM_KEY = "test-key"
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
    delete process.env.TEST_CUSTOM_KEY
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
          api_key_env: "TEST_OAI_COMPAT_KEY",
          default_model: "test-model",
          timeout_ms: 5000,
          retry_attempts: 1,
          retry_base_delay_ms: 100
        }
      }
    }
  }
  process.env.TEST_OAI_COMPAT_KEY = "test-key"
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
    delete process.env.TEST_OAI_COMPAT_KEY
    await stopServer(mock.server)
  }
})
