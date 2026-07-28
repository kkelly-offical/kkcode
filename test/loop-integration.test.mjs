import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { registerProvider } from "../src/provider/router.mjs"
import { ToolRegistry } from "../src/tool/registry.mjs"
import { PermissionEngine } from "../src/permission/engine.mjs"
import { processTurnLoop } from "../src/session/loop.mjs"
import { EventBus } from "../src/core/events.mjs"
import { EVENT_TYPES } from "../src/core/constants.mjs"

let tmpDir

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kkcode-test-loop-"))
  process.env.KKCODE_HOME = tmpDir
  PermissionEngine.setTrusted(true)
  await ToolRegistry.initialize({
    config: { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }
  })
})

after(async () => {
  PermissionEngine.setTrusted(false)
  delete process.env.KKCODE_HOME
  await rm(tmpDir, { recursive: true, force: true })
})

async function runLoop(opts) {
  return processTurnLoop(opts)
}

function createMockProvider(responses) {
  let callIndex = 0
  const impl = {
    async request(input) {
      const r = responses[Math.min(callIndex++, responses.length - 1)]
      return typeof r === "function" ? r(input) : r
    },
    async *requestStream(input) {
      const r = responses[Math.min(callIndex++, responses.length - 1)]
      const res = typeof r === "function" ? r(input) : r
      if (res.text) yield { type: "text", content: res.text }
      for (const call of res.toolCalls || []) yield { type: "tool_call", call }
      yield { type: "usage", usage: res.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    },
    resetIndex() { callIndex = 0 }
  }
  return impl
}

function textResponse(text) {
  return { text, toolCalls: [], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }
}

function toolCallResponse(name, args) {
  return {
    text: "",
    toolCalls: [{ id: `tc_${Date.now()}`, name, args }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }
  }
}

function baseConfig(overrides = {}) {
  return {
    config: {
      provider: { default: "mock", mock: { default_model: "test", timeout_ms: 5000, stream: false } },
      agent: { default_mode: "agent", max_steps: overrides.maxSteps || 3 },
      permission: { default_policy: overrides.permissionPolicy || "allow", rules: overrides.permissionRules || [] },
      session: { max_history: 30, recovery: false },
      tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
      usage: { aggregation: ["turn"], budget: {} },
      ui: { markdown_render: false }
    }
  }
}

// Register mock provider once
const mockProvider = createMockProvider([textResponse("hello")])
registerProvider("mock", mockProvider)

test("loop: pure text reply", async () => {
  const provider = createMockProvider([textResponse("Hello from mock!")])
  registerProvider("mock", provider)

  const result = await runLoop({
    prompt: "say hello",
    mode: "agent",
    model: "test",
    providerType: "mock",
    sessionId: `ses_text_${Date.now()}`,
    configState: baseConfig()
  })

  assert.equal(result.reply, "Hello from mock!")
  assert.equal(result.toolEvents.length, 0)
  assert.equal(result.usage.input, 10)
  assert.equal(result.usage.output, 5)
})

test("loop: alternating thinking and text emits a start boundary for every segment", async () => {
  registerProvider("mock", {
    async request() {
      return { text: "firstsecond", toolCalls: [], usage: {} }
    },
    async *requestStream() {
      yield { type: "thinking", content: "reason one" }
      yield { type: "text", content: "first" }
      yield { type: "thinking", content: "reason two" }
      yield { type: "text", content: "second" }
      yield {
        type: "usage",
        usage: { input: 4, output: 6, cacheRead: 0, cacheWrite: 0 }
      }
      yield { type: "stop", reason: "end_turn" }
    }
  })

  const sessionId = `ses_alternating_${Date.now()}`
  const observed = []
  const segmentTypes = new Set([
    EVENT_TYPES.STREAM_THINKING_START,
    EVENT_TYPES.STREAM_THINKING_DELTA,
    EVENT_TYPES.STREAM_TEXT_START,
    EVENT_TYPES.STREAM_TEXT_DELTA
  ])
  const unsubscribe = EventBus.subscribe((event) => {
    if (event.sessionId === sessionId && segmentTypes.has(event.type)) {
      observed.push(event.type)
    }
  })

  try {
    const configState = baseConfig()
    configState.config.provider.mock.stream = true
    const result = await runLoop({
      prompt: "alternate reasoning and answer segments",
      mode: "agent",
      model: "test",
      providerType: "mock",
      sessionId,
      configState
    })

    assert.equal(result.reply, "firstsecond")
    assert.deepEqual(observed, [
      EVENT_TYPES.STREAM_THINKING_START,
      EVENT_TYPES.STREAM_THINKING_DELTA,
      EVENT_TYPES.STREAM_TEXT_START,
      EVENT_TYPES.STREAM_TEXT_DELTA,
      EVENT_TYPES.STREAM_THINKING_START,
      EVENT_TYPES.STREAM_THINKING_DELTA,
      EVENT_TYPES.STREAM_TEXT_START,
      EVENT_TYPES.STREAM_TEXT_DELTA
    ])
  } finally {
    unsubscribe()
  }
})

test("loop: single tool call then text reply", async () => {
  const provider = createMockProvider([
    toolCallResponse("list", { path: "." }),
    textResponse("I listed the directory.")
  ])
  registerProvider("mock", provider)

  const result = await runLoop({
    prompt: "list current dir",
    mode: "agent",
    model: "test",
    providerType: "mock",
    sessionId: `ses_tool_${Date.now()}`,
    configState: baseConfig()
  })

  assert.equal(result.reply, "I listed the directory.")
  assert.equal(result.toolEvents.length, 1)
  assert.equal(result.toolEvents[0].name, "list")
  assert.equal(result.toolEvents[0].status, "completed")
})

test("loop: multi-step tool calls", async () => {
  const provider = createMockProvider([
    toolCallResponse("list", { path: "." }),
    toolCallResponse("list", { path: ".." }),
    textResponse("Done listing both directories.")
  ])
  registerProvider("mock", provider)

  const result = await runLoop({
    prompt: "list two dirs",
    mode: "agent",
    model: "test",
    providerType: "mock",
    sessionId: `ses_multi_${Date.now()}`,
    configState: baseConfig()
  })

  assert.equal(result.reply, "Done listing both directories.")
  assert.equal(result.toolEvents.length, 2)
})

test("loop: max steps reached", async () => {
  const provider = createMockProvider([
    toolCallResponse("list", { path: "." })
  ])
  registerProvider("mock", provider)

  const result = await runLoop({
    prompt: "keep listing forever",
    mode: "agent",
    model: "test",
    providerType: "mock",
    sessionId: `ses_max_${Date.now()}`,
    configState: baseConfig({ maxSteps: 2 })
  })

  assert.ok(result.reply.toLowerCase().includes("max steps"))
  assert.equal(result.toolEvents.length, 2)
})

test("loop: permission deny causes tool error", async () => {
  const provider = createMockProvider([
    toolCallResponse("bash", { command: "echo hi" }),
    textResponse("Could not run bash.")
  ])
  registerProvider("mock", provider)

  const result = await runLoop({
    prompt: "run echo",
    mode: "agent",
    model: "test",
    providerType: "mock",
    sessionId: `ses_deny_${Date.now()}`,
    configState: baseConfig({ permissionPolicy: "deny" })
  })

  assert.equal(result.toolEvents.length, 1)
  assert.equal(result.toolEvents[0].name, "bash")
  assert.equal(result.toolEvents[0].status, "error")
  assert.ok(result.toolEvents[0].output.includes("permission denied"))
})

test("loop: steer messages land between steps, as user messages the model sees", async () => {
  // 「排队后再按一次 Enter」的送达端：steerSource 在 step 边界被取走，
  // 文本作为 user 消息写进会话，同一 step 的模型请求立刻看到。
  const seenInputs = []
  const provider = createMockProvider([
    (input) => { seenInputs.push(input); return toolCallResponse("glob", { pattern: "*.md" }) },
    (input) => { seenInputs.push(input); return textResponse("done, and I saw your note.") }
  ])
  registerProvider("mock", provider)

  // step1 边界给空（回合刚开始，还没人插话）；step2 边界给一条
  const steerBatches = [[], ["顺便：改动别碰 legacy 目录"]]
  let steerCalls = 0
  const injected = []
  const unsub = EventBus.subscribe((event) => {
    if (event.type === EVENT_TYPES.TURN_STEER_INJECTED) injected.push(event.payload)
  })

  try {
    const result = await runLoop({
      prompt: "list markdown files",
      mode: "agent",
      model: "test",
      providerType: "mock",
      sessionId: `ses_steer_${Date.now()}`,
      configState: baseConfig({ maxSteps: 3 }),
      steerSource: () => steerBatches[Math.min(steerCalls++, steerBatches.length - 1)]
    })

    assert.ok(result.reply.includes("saw your note"))
    assert.ok(steerCalls >= 2, "每个 step 边界都要问一次 steerSource")
    // 事件：注入被广播（TUI 靠它上屏）
    assert.equal(injected.length, 1)
    assert.equal(injected[0].text, "顺便：改动别碰 legacy 目录")
    assert.equal(injected[0].step, 2, "插话在第 2 个 step 边界送达")

    // 消息序：第二次模型请求里，插话是一条 user 消息，且在 tool 结果之后 ——
    // 夹进 assistant→tool 配对中间的话部分 provider 会拒收
    const second = seenInputs[1]
    const flat = second.messages.map((m) => ({
      role: m.role,
      text: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    }))
    const steerIdx = flat.findIndex((m) => m.role === "user" && m.text.includes("legacy 目录"))
    assert.ok(steerIdx >= 0, `插话必须出现在第二次请求里，实际消息: ${JSON.stringify(flat.map((m) => m.role))}`)
    const toolIdx = flat.findIndex((m) => m.role === "tool" || m.text.includes("glob"))
    assert.ok(steerIdx > toolIdx, "插话要落在工具结果之后，不能拆开 assistant→tool 配对")
  } finally {
    unsub()
  }
})

test("loop: no steerSource means no steer machinery at all", async () => {
  // 行模式 / 子代理 / 后台任务不传 steerSource —— 这条钉住缺省路径零开销、零事件
  const provider = createMockProvider([textResponse("plain")])
  registerProvider("mock", provider)
  const injected = []
  const unsub = EventBus.subscribe((event) => {
    if (event.type === EVENT_TYPES.TURN_STEER_INJECTED) injected.push(event)
  })
  try {
    const result = await runLoop({
      prompt: "hi",
      mode: "agent",
      model: "test",
      providerType: "mock",
      sessionId: `ses_nosteer_${Date.now()}`,
      configState: baseConfig()
    })
    assert.ok(result.reply)
    assert.equal(injected.length, 0)
  } finally {
    unsub()
  }
})
