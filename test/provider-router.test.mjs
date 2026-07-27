import test from "node:test"
import assert from "node:assert/strict"
import { requestProvider } from "../src/provider/router.mjs"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"

test("provider router accepts provider/model formatted model id", async () => {
  const originalFetch = global.fetch
  const originalKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = "test-key"
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    })
  })

  // 0.7.3 起 DEFAULT_CONFIG 不再预置 provider —— 测试像真实用户一样自带条目。
  // 此前直接用 DEFAULT_CONFIG，测的其实是「预置恰好存在」而不是路由本身。
  const configState = {
    config: {
      ...DEFAULT_CONFIG,
      provider: {
        ...DEFAULT_CONFIG.provider,
        default: "openai",
        openai: {
          base_url: "https://api.openai.com/v1",
          api_key_env: "OPENAI_API_KEY",
          default_model: "gpt-4o-mini"
        }
      }
    }
  }
  try {
    const result = await requestProvider({
      configState,
      providerType: "openai",
      model: "openai/gpt-4o-mini",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.ok(typeof result.text === "string")
  } finally {
    global.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
  }
})

test("provider router preserves slash-containing opaque gateway model ids", async () => {
  const originalFetch = global.fetch
  let receivedModel = null
  global.fetch = async (_url, init) => {
    receivedModel = JSON.parse(init.body).model
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      })
    }
  }
  const configState = {
    config: {
      provider: {
        default: "company-gateway",
        strict_mode: true,
        "company-gateway": {
          type: "gateway",
          protocol: "openai",
          base_url: "http://127.0.0.1:12345/v1",
          api_key_env: "",
          default_model: "anthropic/claude-sonnet"
        }
      }
    }
  }
  try {
    await requestProvider({
      configState,
      providerType: "company-gateway",
      model: "anthropic/claude-sonnet",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.equal(receivedModel, "anthropic/claude-sonnet")
  } finally {
    global.fetch = originalFetch
  }
})
