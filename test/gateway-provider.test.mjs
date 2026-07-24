import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { listProviders, requestProvider } from "../src/provider/router.mjs"

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done))
      })
    })
  })
}

test("authless local gateway routes OpenAI without an Authorization header", async () => {
  assert.ok(listProviders().includes("gateway"))
  let request = null
  const mock = await listen((req, res) => {
    let body = ""
    req.on("data", (chunk) => { body += chunk })
    req.on("end", () => {
      request = { url: req.url, headers: req.headers, body: JSON.parse(body) }
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({
        choices: [{ message: { content: "openai gateway" } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 }
      }))
    })
  })
  const configState = {
    config: {
      provider: {
        default: "unified",
        unified: {
          type: "gateway",
          protocol: "openai",
          base_url: mock.baseUrl,
          endpoints: { openai: "/openai/v1" },
          api_key_env: "",
          default_model: "model-openai",
          retry_attempts: 1
        }
      }
    }
  }
  try {
    const result = await requestProvider({
      configState,
      providerType: "unified",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.equal(result.text, "openai gateway")
    assert.equal(request.url, "/openai/v1/chat/completions")
    assert.equal(request.headers.authorization, undefined)
    assert.equal(request.body.model, "model-openai")
  } finally {
    await mock.close()
  }
})

test("authless local gateway routes Anthropic without an x-api-key header", async () => {
  let request = null
  const mock = await listen((req, res) => {
    let body = ""
    req.on("data", (chunk) => { body += chunk })
    req.on("end", () => {
      request = { url: req.url, headers: req.headers, body: JSON.parse(body) }
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({
        content: [{ type: "text", text: "anthropic gateway" }],
        usage: { input_tokens: 2, output_tokens: 1 }
      }))
    })
  })
  const configState = {
    config: {
      provider: {
        default: "unified",
        unified: {
          type: "gateway",
          protocol: "anthropic",
          base_url: `${mock.baseUrl}/fallback`,
          endpoints: { anthropic: `${mock.baseUrl}/anthropic/v1` },
          api_key_env: "",
          default_model: "model-anthropic",
          retry_attempts: 1
        }
      }
    }
  }
  try {
    const result = await requestProvider({
      configState,
      providerType: "unified",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.equal(result.text, "anthropic gateway")
    assert.equal(request.url, "/anthropic/v1/messages")
    assert.equal(request.headers["x-api-key"], undefined)
    assert.equal(request.body.model, "model-anthropic")
  } finally {
    await mock.close()
  }
})

test("a configured credential environment remains required when it is missing", async () => {
  let requests = 0
  const mock = await listen((_req, res) => {
    requests += 1
    res.end("{}")
  })
  try {
    await assert.rejects(
      requestProvider({
        configState: {
          config: {
            provider: {
              default: "official-style",
              "official-style": {
                type: "gateway",
                protocol: "openai",
                base_url: mock.baseUrl,
                api_key_env: "MISSING_GATEWAY_KEY",
                default_model: "model-openai",
                retry_attempts: 1
              }
            }
          }
        },
        providerType: "official-style",
        system: "",
        messages: [{ role: "user", content: "hello" }],
        tools: []
      }),
      /missing API key/
    )
    assert.equal(requests, 0)
  } finally {
    await mock.close()
  }
})
