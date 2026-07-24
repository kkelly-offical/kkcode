import test, { afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  clearModelCatalogMemoryCache,
  discoverModelsForProvider,
  resolveProviderConnection
} from "../src/provider/model-catalog.mjs"
import { escapeTerminalText, validateModelId } from "../src/provider/model-id.mjs"
import { validateConfig } from "../src/config/schema.mjs"

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

function stateFor(name, provider) {
  return {
    config: { provider: { default: name, [name]: provider } },
    source: {
      userRaw: { provider: { [name]: provider } },
      projectRaw: {},
      envOverlay: {}
    }
  }
}

test("model ids reject terminal controls and rendering escapes legacy unsafe text", () => {
  assert.equal(validateModelId("anthropic/claude-sonnet"), "anthropic/claude-sonnet")
  assert.throws(
    () => validateModelId("safe\u001b]8;;https://evil.example\u0007spoof"),
    /terminal control characters/
  )
  assert.match(
    escapeTerminalText("safe\u001b[31m"),
    /safe\\u001b\[31m/
  )
})

test("live model discovery rejects terminal-injection model ids", async () => {
  const service = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      data: [
        { id: "safe/model" },
        { id: "spoof\u001b]8;;https://evil.example\u0007model" }
      ]
    }))
  })
  try {
    await assert.rejects(
      discoverModelsForProvider(stateFor("gateway-test", {
        type: "gateway",
        protocol: "openai",
        base_url: `${service.baseUrl}/v1`,
        api_key_env: ""
      }), { refresh: true }),
      /terminal control characters/
    )
  } finally {
    await service.close()
  }
})

let temporaryHome

beforeEach(async () => {
  temporaryHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-models-"))
  process.env.KKCODE_HOME = temporaryHome
  clearModelCatalogMemoryCache()
})

afterEach(async () => {
  delete process.env.KKCODE_HOME
  delete process.env.TEST_MODEL_KEY
  clearModelCatalogMemoryCache()
  await rm(temporaryHome, { recursive: true, force: true })
})

test("OpenAI discovery authenticates, paginates, and reuses the 15 minute cache", async () => {
  const requests = []
  const originalFetch = global.fetch
  global.fetch = async (url, options) => {
    const parsed = new URL(url)
    requests.push({
      url: `${parsed.pathname}${parsed.search}`,
      authorization: options.headers.Authorization,
      requestId: options.headers["X-KK-Code-Request-Id"]
    })
    if (!parsed.searchParams.has("after")) {
      return new Response(JSON.stringify({
        data: [{ id: "model-a", owned_by: "vendor" }],
        has_more: true,
        last_id: "model-a"
      }), { headers: { "content-type": "application/json" } })
    }
    return new Response(JSON.stringify({ data: [{ id: "model-b" }], has_more: false }), {
      headers: { "content-type": "application/json" }
    })
  }
  process.env.TEST_MODEL_KEY = "catalog-secret"
  const state = stateFor("custom", {
    type: "openai-compatible",
    base_url: "https://catalog.example.test/v1",
    api_key_env: "TEST_MODEL_KEY"
  })
  try {
    const first = await discoverModelsForProvider(state, { now: 1000 })
    const second = await discoverModelsForProvider(state, { now: 2000 })
    assert.deepEqual(first.models.map((model) => model.id), ["model-a", "model-b"])
    assert.equal(first.source, "network")
    assert.equal(second.source, "cache")
    assert.equal(requests.length, 2)
    assert.equal(requests[0].authorization, "Bearer catalog-secret")
    assert.match(requests[1].url, /after=model-a/)
    if (requests[0].requestId) assert.equal(requests[0].requestId, requests[1].requestId)
  } finally {
    global.fetch = originalFetch
  }
})

test("Anthropic discovery uses x-api-key, after_id, and an explicit models endpoint", async () => {
  const requests = []
  const originalFetch = global.fetch
  global.fetch = async (url, options) => {
    const parsed = new URL(url)
    requests.push({
      url: `${parsed.pathname}${parsed.search}`,
      key: options.headers["X-Api-Key"],
      version: options.headers["Anthropic-Version"]
    })
    const hasCursor = parsed.searchParams.has("after_id")
    return new Response(JSON.stringify(hasCursor
      ? { data: [{ id: "claude-b" }], has_more: false }
      : { data: [{ id: "claude-a", display_name: "Claude A" }], has_more: true, last_id: "claude-a" }), {
      headers: { "content-type": "application/json" }
    })
  }
  process.env.TEST_MODEL_KEY = "anthropic-secret"
  const state = stateFor("unified", {
    type: "gateway",
    protocol: "anthropic",
    base_url: "https://anthropic.example.test/ignored",
    endpoints: {
      anthropic: "https://anthropic.example.test/anthropic/v1",
      models: "https://anthropic.example.test/catalog"
    },
    api_key_env: "TEST_MODEL_KEY"
  })
  try {
    const result = await discoverModelsForProvider(state)
    assert.deepEqual(result.models.map((model) => model.id), ["claude-a", "claude-b"])
    assert.equal(result.models[0].displayName, "Claude A")
    assert.equal(requests[0].url, "/catalog")
    assert.match(requests[1].url, /after_id=claude-a/)
    assert.equal(requests[0].key, "anthropic-secret")
    assert.equal(requests[0].version, "2023-06-01")
  } finally {
    global.fetch = originalFetch
  }
})

test("model caches are isolated when the configured credential changes", async () => {
  let requests = 0
  const originalFetch = global.fetch
  global.fetch = async (_url, options) => {
    requests += 1
    const suffix = options.headers.Authorization === "Bearer tenant-b" ? "b" : "a"
    return new Response(JSON.stringify({ data: [{ id: `model-${suffix}` }] }), {
      headers: { "content-type": "application/json" }
    })
  }
  const state = stateFor("tenant", {
    type: "openai-compatible",
    base_url: "https://tenant.example.test/v1",
    api_key_env: "TEST_MODEL_KEY"
  })
  try {
    process.env.TEST_MODEL_KEY = "tenant-a"
    const first = await discoverModelsForProvider(state, { now: 1000 })
    process.env.TEST_MODEL_KEY = "tenant-b"
    const second = await discoverModelsForProvider(state, { now: 2000 })
    assert.deepEqual(first.models.map((model) => model.id), ["model-a"])
    assert.deepEqual(second.models.map((model) => model.id), ["model-b"])
    assert.equal(second.source, "network")
    assert.equal(requests, 2)
  } finally {
    global.fetch = originalFetch
  }
})

test("model discovery rejects oversized responses before buffering the body", async () => {
  const mock = await listen((_req, res) => {
    res.setHeader("content-type", "application/json")
    res.setHeader("content-length", String(4 * 1024 * 1024 + 1))
    res.end("{}")
  })
  try {
    await assert.rejects(
      discoverModelsForProvider(stateFor("oversized", {
        type: "openai-compatible",
        base_url: `${mock.baseUrl}/v1`,
        api_key_env: ""
      })),
      /too large/
    )
  } finally {
    await mock.close()
  }
})

test("refresh failure returns a stale recent cache instead of built-in models", async () => {
  const mock = await listen((_req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ data: [{ id: "live-only" }] }))
  })
  const state = stateFor("cached", {
    type: "openai-compatible",
    base_url: `${mock.baseUrl}/v1`,
    api_key_env: "",
    models: ["must-not-be-used"]
  })
  await discoverModelsForProvider(state, { now: 1000 })
  await mock.close()
  const fallback = await discoverModelsForProvider(state, {
    refresh: true,
    now: 2000,
    timeoutMs: 100
  })
  assert.equal(fallback.stale, true)
  assert.equal(fallback.source, "cache")
  assert.deepEqual(fallback.models.map((model) => model.id), ["live-only"])
})

test("cross-origin redirects are rejected before the target is contacted", async () => {
  let targetRequests = 0
  const target = await listen((_req, res) => {
    targetRequests++
    res.end(JSON.stringify({ data: [] }))
  })
  const redirect = await listen((_req, res) => {
    res.writeHead(302, { location: `${target.baseUrl}/models` })
    res.end()
  })
  const state = stateFor("redirecting", {
    type: "openai-compatible",
    base_url: redirect.baseUrl,
    api_key_env: ""
  })
  try {
    await assert.rejects(
      discoverModelsForProvider(state),
      /cross-origin redirect/
    )
    assert.equal(targetRequests, 0)
  } finally {
    await redirect.close()
    await target.close()
  }
})

test("disabled discovery uses only a user-provided offline model list", async () => {
  const state = stateFor("offline", {
    type: "gateway",
    protocol: "openai",
    base_url: "https://gateway.example/v1",
    models: ["manual-a", "manual-b"],
    discovery: { enabled: false }
  })
  const result = await discoverModelsForProvider(state)
  assert.equal(result.source, "config")
  assert.deepEqual(result.models.map((model) => model.id), ["manual-a", "manual-b"])
})

test("a user-provided model list remains available when live discovery has no cache", async () => {
  const state = stateFor("offline-fallback", {
    type: "openai-compatible",
    base_url: "http://127.0.0.1:1/v1",
    api_key_env: "UNSET_OFFLINE_KEY",
    models: ["explicit-a", "explicit-b"]
  })
  const result = await discoverModelsForProvider(state, { timeoutMs: 100 })
  assert.equal(result.source, "config")
  assert.equal(result.stale, true)
  assert.deepEqual(result.models.map((model) => model.id), ["explicit-a", "explicit-b"])
})

test("gateway configuration validates protocol, endpoints, and discovery settings", () => {
  const good = validateConfig({
    provider: {
      default: "my-gateway",
      "my-gateway": {
        type: "gateway",
        protocol: "openai",
        base_url: "https://gateway.example/v1",
        endpoints: { anthropic: null, models: "/models" },
        discovery: { enabled: true, cache_ttl_ms: 900000 }
      }
    }
  })
  assert.equal(good.valid, true, good.errors.join(", "))

  const bad = validateConfig({
    provider: {
      default: "my-gateway",
      "my-gateway": { type: "gateway", base_url: "https://gateway.example/v1" }
    }
  })
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((error) => error.includes("protocol")))

  const missingRoute = validateConfig({
    provider: {
      default: "my-gateway",
      "my-gateway": {
        type: "gateway",
        protocol: "anthropic",
        endpoints: { openai: "https://gateway.example/v1" }
      }
    }
  })
  assert.equal(missingRoute.valid, false)
  assert.ok(missingRoute.errors.some((error) => error.includes("endpoints.anthropic")))
})

test("connection resolution gives protocol endpoint overrides precedence", () => {
  const connection = resolveProviderConnection(stateFor("gateway-a", {
    type: "gateway",
    protocol: "openai",
    base_url: "https://fallback.example/v1",
    endpoints: {
      openai: "https://openai.example/api/v1",
      models: "catalog"
    }
  }), "gateway-a")
  assert.equal(connection.baseUrl, "https://openai.example/api/v1")
  assert.equal(connection.modelsUrl, "https://openai.example/api/v1/catalog")

  const relative = resolveProviderConnection(stateFor("gateway-relative", {
    type: "gateway",
    protocol: "anthropic",
    base_url: "https://gateway.example/root",
    endpoints: {
      anthropic: "/anthropic/v1",
      models: "models"
    }
  }), "gateway-relative")
  assert.equal(relative.baseUrl, "https://gateway.example/anthropic/v1")
  assert.equal(relative.modelsUrl, "https://gateway.example/anthropic/v1/models")
})
