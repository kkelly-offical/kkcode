import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { countTokensProvider, requestProvider, requestProviderStream } from "../src/provider/router.mjs"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"
import { upsertAuthProfile } from "../src/provider/auth-profiles.mjs"
import { EventBus } from "../src/core/events.mjs"

let home = ""

test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kkcode-provider-router-"))
  process.env.KKCODE_HOME = home
})

test.afterEach(async () => {
  delete process.env.KKCODE_HOME
  await rm(home, { recursive: true, force: true })
})

test("provider router accepts provider/model formatted model id", async () => {
  const originalFetch = global.fetch
  const originalKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = "test-key"
  let seenBody = null
  global.fetch = async (_url, options = {}) => {
    seenBody = JSON.parse(String(options.body || "{}"))
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      })
    }
  }

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
    assert.equal(seenBody.model, "gpt-4o-mini")
  } finally {
    global.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
  }
})

test("provider router preserves namespaced model ids required by provider backends", async () => {
  const originalFetch = global.fetch
  const originalKey = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = "test-key"

  let seenBody = null
  global.fetch = async (_url, options = {}) => {
    seenBody = JSON.parse(String(options.body || "{}"))
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      })
    }
  }

  try {
    const result = await requestProvider({
      configState: {
        config: DEFAULT_CONFIG
      },
      providerType: "openrouter",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.equal(result.text, "ok")
    assert.equal(seenBody.model, "openai/gpt-4.1-mini")
  } finally {
    global.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = originalKey
  }
})

test("provider router forwards configured headers for openai-compatible providers", async () => {
  const originalFetch = global.fetch
  const originalKey = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = "test-key"

  let seenHeaders = null
  global.fetch = async (_url, options = {}) => {
    seenHeaders = options.headers
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      })
    }
  }

  const configState = {
    config: DEFAULT_CONFIG
  }

  try {
    const result = await requestProvider({
      configState,
      providerType: "openrouter",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.equal(result.text, "ok")
    assert.equal(seenHeaders["HTTP-Referer"], "https://kkcode.chat")
    assert.equal(seenHeaders["X-Title"], "kkcode CLI")
  } finally {
    global.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = originalKey
  }
})

test("countTokensProvider uses direct api_key without env lookup", async () => {
  const originalFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ usage: { prompt_tokens: 42 } })
  })

  const configState = {
    config: {
      ...DEFAULT_CONFIG,
      provider: {
        ...DEFAULT_CONFIG.provider,
        directkey: {
          type: "openai-compatible",
          base_url: "https://api.example.com/v1",
          api_key: "inline-secret",
          default_model: "test-model"
        }
      }
    }
  }

  try {
    const count = await countTokensProvider({
      configState,
      providerType: "directkey",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.equal(count, 42)
  } finally {
    global.fetch = originalFetch
  }
})

test("provider router uses auth profile credential and headers when env is missing", async () => {
  const originalFetch = global.fetch
  delete process.env.OPENAI_API_KEY

  let seenHeaders = null
  global.fetch = async (_url, options = {}) => {
    seenHeaders = options.headers
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      })
    }
  }

  await upsertAuthProfile({
    providerId: "openai",
    displayName: "cli profile",
    credential: "sk-from-profile",
    headers: { "OpenAI-Organization": "org_test" },
    isDefault: true
  })

  try {
    const result = await requestProvider({
      configState: {
        config: DEFAULT_CONFIG
      },
      providerType: "openai",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.equal(result.text, "ok")
    assert.equal(seenHeaders.authorization, "Bearer sk-from-profile")
    assert.equal(seenHeaders["OpenAI-Organization"], "org_test")
  } finally {
    global.fetch = originalFetch
  }
})

test("provider router ignores expired auth profiles and falls back to env credentials", async () => {
  const originalFetch = global.fetch
  const originalKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = "env-fallback-key"

  let seenHeaders = null
  global.fetch = async (_url, options = {}) => {
    seenHeaders = options.headers
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      })
    }
  }

  await upsertAuthProfile({
    providerId: "openai",
    displayName: "expired oauth profile",
    authMode: "oauth",
    accessToken: "expired-token",
    expiresAt: Date.now() - 60_000,
    isDefault: true
  })

  try {
    const result = await requestProvider({
      configState: {
        config: DEFAULT_CONFIG
      },
      providerType: "openai",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.equal(result.text, "ok")
    assert.equal(seenHeaders.authorization, "Bearer env-fallback-key")
  } finally {
    global.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
  }
})

test("provider router projects gemini api key into x-goog-api-key without bearer auth", async () => {
  const originalFetch = global.fetch
  const originalKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = "gemini-key"

  let seenHeaders = null
  let seenBody = null
  global.fetch = async (_url, options = {}) => {
    seenHeaders = options.headers
    seenBody = JSON.parse(String(options.body || "{}"))
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      })
    }
  }

  try {
    const result = await requestProvider({
      configState: {
        config: DEFAULT_CONFIG
      },
      providerType: "gemini",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.equal(result.text, "ok")
    assert.equal(seenHeaders["x-goog-api-key"], "gemini-key")
    assert.equal("authorization" in seenHeaders || "Authorization" in seenHeaders, false)
    assert.equal(seenBody.model, "gemini-2.5-pro")
  } finally {
    global.fetch = originalFetch
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalKey
  }
})

test("provider router exchanges github-copilot token into runtime api token", async () => {
  const originalFetch = global.fetch
  const originalKey = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = "ghu_test"

  const calls = []
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options })
    if (String(url).includes("/copilot_internal/v2/token")) {
      return {
        ok: true,
        json: async () => ({
          token: "tid=1; proxy-ep=https://proxy.individual.githubcopilot.com",
          expires_at: Math.floor(Date.now() / 1000) + 3600
        })
      }
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      })
    }
  }

  try {
    const result = await requestProvider({
      configState: {
        config: DEFAULT_CONFIG
      },
      providerType: "github-copilot",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.equal(result.text, "ok")
    assert.equal(calls.length, 2)
    assert.equal(String(calls[1].url).startsWith("https://api.individual.githubcopilot.com"), true)
    assert.equal(String(calls[1].options.headers.authorization || calls[1].options.headers.Authorization).includes("proxy-ep="), true)
  } finally {
    global.fetch = originalFetch
    if (originalKey === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = originalKey
  }
})

test("provider router falls back to configured provider/model chain for non-streaming requests", async () => {
  const originalFetch = global.fetch
  const fallbackEvents = []
  const unsubscribe = EventBus.subscribe((event) => {
    if (event.type === "provider.fallback") fallbackEvents.push(event)
  })
  const calls = []
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options })
    const body = JSON.parse(String(options.body || "{}"))
    if (body.model === "primary-model") {
      return {
        ok: false,
        status: 429,
        text: async () => "rate limit"
      }
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "fallback-ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      })
    }
  }

  const configState = {
    config: {
      ...DEFAULT_CONFIG,
      provider: {
        ...DEFAULT_CONFIG.provider,
        primaryfallback: {
          type: "openai-compatible",
          base_url: "https://api.example.com/v1",
          api_key: "primary-key",
          default_model: "primary-model",
          fallback_models: ["secondary::secondary-model"]
        },
        secondary: {
          type: "openai-compatible",
          base_url: "https://api.example.com/v1",
          api_key: "secondary-key",
          default_model: "secondary-model"
        }
      }
    }
  }

  try {
    const result = await requestProvider({
      configState,
      providerType: "primaryfallback",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })
    assert.equal(result.text, "fallback-ok")
    assert.equal(calls.length, 2)
    assert.equal(fallbackEvents.length, 1)
    assert.equal(fallbackEvents[0].payload.resolved, "secondary")
    assert.equal(fallbackEvents[0].payload.runtime, "openai-compatible")
    assert.equal(fallbackEvents[0].payload.model, "secondary-model")
  } finally {
    global.fetch = originalFetch
    unsubscribe()
  }
})

test("provider router falls back during streaming before any chunks are emitted", async () => {
  const originalFetch = global.fetch
  const calls = []
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options })
    const body = JSON.parse(String(options.body || "{}"))
    if (body.model === "primary-stream-model") {
      return {
        ok: false,
        status: 503,
        text: async () => "temporary unavailable"
      }
    }
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"stream-ok"}}]}\n\n'))
          controller.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n'))
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
          controller.close()
        }
      })
    }
  }

  const configState = {
    config: {
      ...DEFAULT_CONFIG,
      provider: {
        ...DEFAULT_CONFIG.provider,
        streamfallback: {
          type: "openai-compatible",
          base_url: "https://api.example.com/v1",
          api_key: "primary-key",
          default_model: "primary-stream-model",
          fallback_models: ["secondary::secondary-stream-model"]
        },
        secondary: {
          type: "openai-compatible",
          base_url: "https://api.example.com/v1",
          api_key: "secondary-key",
          default_model: "secondary-stream-model"
        }
      }
    }
  }

  try {
    const chunks = []
    for await (const chunk of requestProviderStream({
      configState,
      providerType: "streamfallback",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: []
    })) {
      chunks.push(chunk)
    }
    assert.equal(calls.length, 2)
    assert.equal(chunks.some((chunk) => chunk.type === "text" && chunk.content === "stream-ok"), true)
  } finally {
    global.fetch = originalFetch
  }
})
