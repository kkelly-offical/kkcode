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

  const configState = {
    config: DEFAULT_CONFIG
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
