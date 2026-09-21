import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  clearModelCatalogMemoryCache,
  discoverModelsForProvider
} from "../src/kernel/provider/model-catalog.mjs"

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) })
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

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "kkcode-model-origin-"))
  const previous = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = home
  clearModelCatalogMemoryCache()
  t.after(async () => {
    if (previous === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previous
    clearModelCatalogMemoryCache()
    await rm(home, { recursive: true, force: true })
  })
  return home
}

test("network-discovered catalog entries carry origin:auto", async t => {
  await fixture(t)
  const service = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: [{ id: "auto/model-a", context_length: 131072 }, { id: "auto/model-b" }] }))
  })
  t.after(() => service.close())

  const result = await discoverModelsForProvider(stateFor("openai-test", {
    type: "openai-compatible",
    base_url: `${service.baseUrl}/v1`,
    api_key_env: ""
  }), { refresh: true })

  assert.equal(result.source, "network")
  assert.deepEqual(result.models.map((m) => m.origin), ["auto", "auto"], "every entry is marked auto")
  assert.equal(result.models[0].contextLength, 131072, "discovered config (context window) rides along")
})

test("the manual fallback marks entries origin:manual and stays distinguishable", async t => {
  await fixture(t)
  const state = stateFor("offline", {
    type: "openai-compatible",
    base_url: "http://127.0.0.1:1/v1",
    api_key_env: "",
    models: ["manual/model-x", "manual/model-y"]
  })

  // discovery enabled but the endpoint is unreachable -> stale manual fallback
  const stale = await discoverModelsForProvider(state, { refresh: true, timeoutMs: 2000 })
  assert.equal(stale.source, "config")
  assert.equal(stale.stale, true)
  assert.ok(stale.warning, "fallback explains itself")
  assert.deepEqual(stale.models.map((m) => m.origin), ["manual", "manual"])

  // discovery disabled entirely -> pure manual lane, still marked
  const disabled = await discoverModelsForProvider(stateFor("offline", {
    type: "openai-compatible",
    base_url: "http://127.0.0.1:1/v1",
    api_key_env: "",
    discovery: { enabled: false },
    models: ["manual/model-x"]
  }))
  assert.equal(disabled.source, "config")
  assert.equal(disabled.stale, false)
  assert.deepEqual(disabled.models.map((m) => m.origin), ["manual"])
})

test("served-from-cache entries keep origin:auto", async t => {
  await fixture(t)
  const service = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: [{ id: "cached/model" }] }))
  })
  t.after(() => service.close())
  const state = stateFor("cacheable", {
    type: "openai-compatible",
    base_url: `${service.baseUrl}/v1`,
    api_key_env: ""
  })

  const live = await discoverModelsForProvider(state, { refresh: true })
  assert.equal(live.source, "network")
  const cached = await discoverModelsForProvider(state, {})
  assert.equal(cached.source, "cache")
  assert.equal(cached.models[0].origin, "auto", "cache replays are still auto-sourced, not mistaken for manual config")
})
