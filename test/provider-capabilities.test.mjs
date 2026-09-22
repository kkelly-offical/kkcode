import test, { afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import {
  MODEL_CAPABILITY_KEYS,
  enforceModelInputCapabilities,
  inferCapabilitiesFromName,
  normalizeCapabilities,
  parseCatalogEntryCapabilities,
  parseCatalogEntryPricing
} from "../src/kernel/provider/model-capabilities.mjs"
import {
  clearModelCatalogMemoryCache,
  discoverModelsForProvider,
  resolveModelCapabilities
} from "../src/kernel/provider/model-catalog.mjs"
import { requestProvider, requestProviderStream } from "../src/kernel/provider/router.mjs"

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

function stateFor(name, provider, extra = {}) {
  return {
    config: { provider: { default: name, [name]: provider, ...extra } },
    source: {
      userRaw: { provider: { [name]: provider } },
      projectRaw: {},
      envOverlay: {}
    }
  }
}

let temporaryHome

beforeEach(async () => {
  temporaryHome = await mkdtemp(path.join(os.tmpdir(), "kkcode-caps-"))
  process.env.KKCODE_HOME = temporaryHome
  clearModelCatalogMemoryCache()
})

afterEach(async () => {
  delete process.env.KKCODE_HOME
  clearModelCatalogMemoryCache()
  await rm(temporaryHome, { recursive: true, force: true })
})

// ── 目录条目解析 ─────────────────────────────────────────────────────

test("catalog parsing reads OpenRouter-style modalities, supported_parameters and pricing", () => {
  const capabilities = parseCatalogEntryCapabilities({
    id: "vendor/model",
    architecture: { modality: "text+image->text", input_modalities: ["text", "image"] },
    supported_parameters: ["temperature", "tools", "tool_choice", "reasoning"]
  })
  assert.deepEqual(capabilities, { image: true, video: false, audio: false, tools: true, reasoning: true })

  const pricing = parseCatalogEntryPricing({
    pricing: { prompt: "0.0000025", completion: "0.00001" }
  })
  assert.deepEqual(pricing, { input: 2.5, output: 10, currency: "USD", perTokens: 1000000 })
})

test("catalog parsing reads the modality string and vendor capability objects", () => {
  // 只有 modality 字符串（没有 input_modalities 数组）的形态
  assert.deepEqual(
    parseCatalogEntryCapabilities({ architecture: { modality: "text->text" } }),
    { image: false, video: false, audio: false }
  )
  // 各家自报的 capabilities 对象（含别名拼写）
  assert.deepEqual(
    parseCatalogEntryCapabilities({ capabilities: { vision: true, function_calling: true, stream: false } }),
    { image: true, tools: true, streaming: false }
  )
})

test("catalog parsing returns null when nothing is evidenced, and survives malformed entries", () => {
  assert.equal(parseCatalogEntryCapabilities({ id: "plain-model" }), null)
  assert.equal(parseCatalogEntryCapabilities(null), null)
  assert.equal(parseCatalogEntryCapabilities({ capabilities: "yes", supported_parameters: "tools", architecture: 42 }), null)
  assert.equal(parseCatalogEntryPricing({ id: "no-pricing" }), null)
  assert.equal(parseCatalogEntryPricing({ pricing: "cheap" }), null)
  assert.equal(parseCatalogEntryPricing({ pricing: { prompt: "soon" } }), null)
  // 负数与非法数字同样不接受
  assert.equal(parseCatalogEntryPricing({ pricing: { prompt: "-1", completion: "2" } }), null)
})

test("normalized capabilities and pricing survive the cache round trip", () => {
  const normalized = {
    id: "cached/model",
    capabilities: { image: true, tools: false },
    pricing: { input: 1.5, output: 6, currency: "USD", perTokens: 1000000 }
  }
  assert.deepEqual(parseCatalogEntryCapabilities(normalized), { image: true, tools: false })
  assert.deepEqual(parseCatalogEntryPricing(normalized), normalized.pricing)
})

test("normalizeCapabilities keeps only known boolean keys", () => {
  assert.deepEqual(
    normalizeCapabilities({ image: true, video: false, hologram: true, tools: "yes" }),
    { image: true, video: false }
  )
  assert.deepEqual(normalizeCapabilities("image"), {})
  assert.deepEqual(normalizeCapabilities(null), {})
  assert.ok(MODEL_CAPABILITY_KEYS.includes("image") && MODEL_CAPABILITY_KEYS.includes("reasoning"))
})

// ── 名字族启发式 ─────────────────────────────────────────────────────

test("name-family heuristics only answer for families it is sure about", () => {
  assert.deepEqual(inferCapabilitiesFromName("deepseek-chat"), { image: false })
  assert.deepEqual(inferCapabilitiesFromName("deepseek-v4-pro"), { image: false })
  assert.deepEqual(inferCapabilitiesFromName("moonshot-v1-128k"), { image: false })
  assert.deepEqual(inferCapabilitiesFromName("gpt-4o"), { image: true })
  assert.deepEqual(inferCapabilitiesFromName("claude-sonnet-4-6"), { image: true })
  assert.deepEqual(inferCapabilitiesFromName("gemini-3.5-flash"), { image: true })
  // 拿不准的一律未知 —— 未知 = 放行，猜错 false 会拦住用户本来能用的图
  assert.deepEqual(inferCapabilitiesFromName("mystery-model-9000"), {})
  assert.deepEqual(inferCapabilitiesFromName(""), {})
})

// ── 发现链路：能力/定价随目录走 ───────────────────────────────────────

test("discovery entries carry capabilities and pricing, cache replays keep them", async () => {
  const service = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      data: [{
        id: "vision/model",
        context_length: 131072,
        architecture: { input_modalities: ["text", "image"] },
        supported_parameters: ["tools", "reasoning"],
        pricing: { prompt: "0.000001", completion: "0.000004" }
      }]
    }))
  })
  try {
    const state = stateFor("probe", {
      type: "openai-compatible",
      base_url: `${service.baseUrl}/v1`,
      api_key_env: ""
    })
    const live = await discoverModelsForProvider(state, { refresh: true, now: 1000 })
    assert.equal(live.models[0].origin, "auto")
    assert.deepEqual(live.models[0].capabilities, { image: true, video: false, audio: false, tools: true, reasoning: true })
    assert.deepEqual(live.models[0].pricing, { input: 1, output: 4, currency: "USD", perTokens: 1000000 })

    // 缓存回放（normalizeModels 二次过手）不能丢能力/定价
    const cached = await discoverModelsForProvider(state, { now: 2000 })
    assert.equal(cached.source, "cache")
    assert.deepEqual(cached.models[0].capabilities, live.models[0].capabilities)
    assert.deepEqual(cached.models[0].pricing, live.models[0].pricing)
  } finally {
    await service.close()
  }
})

// ── 能力解析的优先级合并 ──────────────────────────────────────────────

test("resolveModelCapabilities merges config over discovery cache over heuristics", async () => {
  const service = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      data: [
        { id: "probe/a", architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["tools"] },
        { id: "probe/b", supported_parameters: ["temperature"] }
      ]
    }))
  })
  try {
    const provider = { type: "openai-compatible", base_url: `${service.baseUrl}/v1`, api_key_env: "" }
    const state = stateFor("probe", provider, {
      model_capabilities: { "probe/a": { image: false } }, // 用户显式否决：配置赢
      model_thinking: { "probe/b": true }                  // 既有的思考落点折进 reasoning
    })
    await discoverModelsForProvider(state, { refresh: true, now: 1000 })

    const a = await resolveModelCapabilities(state, "probe", "probe/a")
    assert.equal(a.capabilities.image, false, "config wins over the catalog's image:true")
    assert.equal(a.sources.image, "config")
    assert.equal(a.capabilities.tools, true, "catalog still fills the keys config does not set")
    assert.equal(a.sources.tools, "discovered")

    const b = await resolveModelCapabilities(state, "probe", "probe/b")
    assert.equal(b.capabilities.reasoning, true, "model_thinking folds into reasoning")
    assert.equal(b.sources.reasoning, "config")
    assert.equal(b.capabilities.tools, false, "catalog enumerated supported_parameters without tools")

    const heuristic = await resolveModelCapabilities(stateFor("probe", provider), "probe", "probe/deepseek-chat")
    assert.equal(heuristic.capabilities.image, false)
    assert.equal(heuristic.sources.image, "heuristic")

    const unknown = await resolveModelCapabilities(stateFor("probe", provider), "probe", "probe/mystery")
    assert.deepEqual(unknown.capabilities, {}, "unknown stays permissive-empty, never a fabricated false")
  } finally {
    await service.close()
  }
})

test("capability resolution never touches the network and never throws on broken config", async () => {
  // 没有缓存、endpoint 不可达：解析必须安静落到启发式/未知，而不是把请求弄挂
  const state = stateFor("down", {
    type: "openai-compatible",
    base_url: "http://127.0.0.1:1/v1",
    api_key_env: ""
  })
  const result = await resolveModelCapabilities(state, "down", "gpt-4o")
  assert.deepEqual(result.capabilities, { image: true })
  assert.equal(result.sources.image, "heuristic")

  const broken = await resolveModelCapabilities({ config: { provider: {} } }, "missing", "gpt-4o")
  assert.equal(broken.capabilities.image, true, "heuristic still applies when the provider entry is gone")
})

// ── 请求路径执行（纯函数层） ──────────────────────────────────────────

const imageBlock = { type: "image", data: "aGVsbG8=", mediaType: "image/png" }

test("enforce throws on fresh user images when the model is known not to see them", () => {
  assert.throws(
    () => enforceModelInputCapabilities({
      messages: [{ role: "user", content: [{ type: "text", text: "看这张图" }, imageBlock] }],
      capabilities: { image: false },
      provider: "p",
      model: "text-only"
    }),
    (error) => error?.details?.reason === "unsupported_capability" && /does not support image input/.test(error.message)
  )
})

test("enforce degrades history and tool-result images to placeholders instead of throwing", () => {
  const history = [
    { role: "user", content: [{ type: "text", text: "old" }, imageBlock] },
    { role: "assistant", content: "看到了" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }, imageBlock] }
  ]
  const guarded = enforceModelInputCapabilities({
    messages: history,
    capabilities: { image: false },
    model: "text-only"
  })
  assert.equal(guarded.droppedImages, 2)
  const flat = guarded.messages.flatMap((m) => m.content)
  assert.ok(flat.every((block) => block.type !== "image"), "no image block survives")
  assert.ok(flat.some((block) => /image withheld/.test(block.text || "")))
  // 输入数组不被改写
  assert.equal(history[0].content[1].type, "image")
})

test("enforce passes images through when supported or unknown, and placeholders video/audio", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "hi" }, imageBlock] }]
  const supported = enforceModelInputCapabilities({ messages, capabilities: { image: true }, model: "m" })
  assert.equal(supported.messages, messages, "supported = untouched")
  const unknown = enforceModelInputCapabilities({ messages, capabilities: {}, model: "m" })
  assert.equal(unknown.messages, messages, "unknown = permissive (pre-capability behavior)")

  const video = enforceModelInputCapabilities({
    messages: [{ role: "user", content: [{ type: "video", data: "e30=", mediaType: "video/mp4" }] }],
    capabilities: { video: true },
    model: "m"
  })
  assert.equal(video.droppedMedia, 1)
  assert.match(video.messages[0].content[0].text, /cannot encode video input yet/)
})

test("enforce drops tools only when tool calling is known-unsupported", () => {
  const tools = [{ name: "read", description: "", inputSchema: {} }]
  const dropped = enforceModelInputCapabilities({ messages: [], tools, capabilities: { tools: false }, model: "m" })
  assert.deepEqual(dropped.tools, [])
  assert.equal(dropped.droppedTools, 1)
  const kept = enforceModelInputCapabilities({ messages: [], tools, capabilities: {}, model: "m" })
  assert.equal(kept.tools, tools)
})

// ── 路由层集成：能力标记真实驱动请求形状 ──────────────────────────────

function routerState(capabilities = {}, providerExtra = {}) {
  return {
    config: {
      provider: {
        default: "p",
        model_capabilities: capabilities,
        p: {
          type: "openai-compatible",
          base_url: "https://capability.example.test/v1",
          api_key: "sk-test",
          default_model: "m",
          ...providerExtra
        }
      }
    }
  }
}

function mockJsonResponse(body) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
}

test("router blocks a fresh image before any network call when image:false", async () => {
  let fetchCalls = 0
  const originalFetch = global.fetch
  global.fetch = async () => { fetchCalls += 1; return mockJsonResponse({}) }
  try {
    await assert.rejects(
      requestProvider({
        configState: routerState({ m: { image: false } }),
        providerType: "p",
        model: "m",
        system: "",
        messages: [{ role: "user", content: [{ type: "text", text: "看图" }, imageBlock] }],
        tools: []
      }),
      /does not support image input/
    )
    assert.equal(fetchCalls, 0, "the block happens before the request leaves the process")
  } finally {
    global.fetch = originalFetch
  }
})

test("router replaces history images with placeholders and still completes the request", async () => {
  let sentBody = null
  const originalFetch = global.fetch
  global.fetch = async (_url, init) => {
    sentBody = JSON.parse(init.body)
    return mockJsonResponse({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    })
  }
  try {
    const result = await requestProvider({
      configState: routerState({ m: { image: false } }),
      providerType: "p",
      model: "m",
      system: "",
      messages: [
        { role: "user", content: [{ type: "text", text: "old image" }, imageBlock] },
        { role: "assistant", content: "noted" },
        { role: "user", content: "continue" }
      ],
      tools: []
    })
    assert.equal(result.text, "ok")
    const serialized = JSON.stringify(sentBody)
    assert.ok(!serialized.includes("image_url"), "no multimodal block reaches the wire")
    assert.ok(serialized.includes("image withheld"), "the placeholder keeps the turn honest")
  } finally {
    global.fetch = originalFetch
  }
})

test("router omits reasoning params when reasoning:false, keeps them otherwise", async () => {
  const bodies = []
  const originalFetch = global.fetch
  global.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return mockJsonResponse({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    })
  }
  try {
    const base = {
      providerType: "p",
      model: "m",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      tools: []
    }
    await requestProvider({ configState: routerState({ m: { reasoning: false } }), ...base })
    assert.ok(!("reasoning_effort" in bodies[0]), "known-unsupported reasoning stays off the wire")

    await requestProvider({ configState: routerState({}), ...base })
    assert.equal(bodies[1].reasoning_effort, "high", "unknown capability keeps the established default")

    // 用户显式写的 thinking 配置优先于探测结论
    await requestProvider({
      configState: routerState({ m: { reasoning: false } }, { reasoning_effort: "low" }),
      ...base
    })
    assert.equal(bodies[2].reasoning_effort, "low", "explicit config beats the probed verdict")
  } finally {
    global.fetch = originalFetch
  }
})

test("streaming:false capability routes the stream API through the non-streaming lane", async () => {
  const bodies = []
  const originalFetch = global.fetch
  global.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return mockJsonResponse({
      choices: [{ message: { content: "plain answer" } }],
      usage: { prompt_tokens: 1, completion_tokens: 2 }
    })
  }
  try {
    const events = []
    for await (const event of requestProviderStream({
      configState: routerState({ m: { streaming: false } }),
      providerType: "p",
      model: "m",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      tools: []
    })) {
      events.push(event)
    }
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].stream, undefined, "no streaming request was attempted")
    assert.deepEqual(events.map((e) => e.type), ["text", "usage"])
    assert.equal(events[0].content, "plain answer")
  } finally {
    global.fetch = originalFetch
  }
})
