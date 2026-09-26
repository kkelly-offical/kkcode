import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { registerProvider } from "../src/kernel/provider/router.mjs"
import { ToolRegistry } from "../src/kernel/tool/registry.mjs"
import { PermissionEngine } from "../src/kernel/permission/engine.mjs"
import { processTurnLoop } from "../src/kernel/session/loop.mjs"
import { flushNow, getSession } from "../src/kernel/session/store.mjs"
import { EventBus } from "../src/kernel/core/events.mjs"
import { EVENT_TYPES } from "../src/kernel/core/constants.mjs"
import { createRenderStream } from "../src/kernel/session/render-stream.mjs"
import { requestOpenAIStream } from "../src/kernel/provider/openai.mjs"
import { requestAnthropicStream } from "../src/kernel/provider/anthropic.mjs"

/**
 * 「回合结束后又进入思考中」的内核侧回归测试。
 *
 * 三条结构性保证：
 *   1. TURN_FINISH / TURN_ERROR 之后，这个 turnId 不再产出任何流式/thinking/
 *      step/auto_continue 事件（render stream 的 close 终态闸）。
 *   2. 回合结束（含失败）后 retryMeta.inProgress 确定性归零。
 *   3. auto-continue 需要截断证据：谎报 max_tokens 的 provider（答案完整、
 *      usage 远未到预算）不得再触发续写 —— 那是「结束后又思考」的内核根因。
 */

let tmpDir
let previousKkcodeHome

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kkcode-test-turn-lifecycle-"))
  previousKkcodeHome = process.env.KKCODE_HOME
  process.env.KKCODE_HOME = tmpDir
  PermissionEngine.setTrusted(true)
  await ToolRegistry.initialize({
    config: { tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } } }
  })
})

after(async () => {
  try { await flushNow() } finally {
    PermissionEngine.setTrusted(false)
    if (previousKkcodeHome === undefined) delete process.env.KKCODE_HOME
    else process.env.KKCODE_HOME = previousKkcodeHome
  }
  await rm(tmpDir, { recursive: true, force: true })
})

/** 记录一个回合的全部事件；返回停止订阅前的只读视图。 */
function captureEvents() {
  const events = []
  const unsubscribe = EventBus.subscribe((event) => {
    events.push({ type: event.type, turnId: event.turnId || null, payload: event.payload })
  })
  return { events, unsubscribe }
}

/** 终态之后不得出现的事件家族。 */
const FORBIDDEN_AFTER_TERMINAL = new Set([
  EVENT_TYPES.STREAM_TEXT_START,
  EVENT_TYPES.STREAM_TEXT_DELTA,
  EVENT_TYPES.STREAM_THINKING_START,
  EVENT_TYPES.STREAM_THINKING_DELTA,
  EVENT_TYPES.STREAM_TOOL_CALL,
  EVENT_TYPES.STREAM_END,
  EVENT_TYPES.TURN_STEP_START,
  EVENT_TYPES.TURN_STEP_FINISH,
  EVENT_TYPES.TURN_AUTO_CONTINUE
])

function assertNoStreamEventsAfterTerminal(events, terminalTypes) {
  const terminalIndex = events.findIndex((event) => terminalTypes.includes(event.type))
  assert.ok(terminalIndex >= 0, `expected one of ${terminalTypes.join("/")} to be emitted`)
  const late = events.slice(terminalIndex + 1).filter((event) => FORBIDDEN_AFTER_TERMINAL.has(event.type))
  assert.deepEqual(late, [], `no stream/thinking/step events may follow ${events[terminalIndex].type}`)
}

function createStreamProvider(responses) {
  let callIndex = 0
  return {
    calls: [],
    async request(input) {
      this.calls.push(input)
      const r = responses[Math.min(callIndex++, responses.length - 1)]
      return typeof r === "function" ? r(input) : r
    },
    async *requestStream(input) {
      this.calls.push(input)
      const r = responses[Math.min(callIndex++, responses.length - 1)]
      const res = typeof r === "function" ? r(input) : r
      if (res.error) throw res.error
      for (const chunk of res.chunks || []) yield chunk
    }
  }
}

function textChunks(text, { output = 5, stopReason = "end_turn", thinking = "" } = {}) {
  const chunks = []
  if (thinking) chunks.push({ type: "thinking", content: thinking })
  chunks.push({ type: "text", content: text })
  chunks.push({ type: "usage", usage: { input: 10, output, cacheRead: 0, cacheWrite: 0 } })
  chunks.push({ type: "stop", reason: stopReason })
  return chunks
}

function baseConfig(providerExtra = {}) {
  return {
    config: {
      provider: {
        default: "mock-lifecycle",
        "mock-lifecycle": { default_model: "test", timeout_ms: 5000, ...providerExtra }
      },
      agent: { default_mode: "agent", max_steps: 3, verify_completion: false },
      permission: { default_policy: "allow", rules: [] },
      session: { max_history: 30, recovery: true },
      tool: { sources: { builtin: true, local: false, plugin: false, mcp: false } },
      usage: { aggregation: ["turn"], budget: {} },
      ui: { markdown_render: false }
    }
  }
}

let sessionCounter = 0
function nextSessionId() {
  sessionCounter += 1
  return `ses_lifecycle_${Date.now()}_${sessionCounter}`
}

test("turn lifecycle: no stream/thinking events after turn.finish, inProgress zeroed", async () => {
  const provider = createStreamProvider([{ chunks: textChunks("done", { thinking: "考虑一下" }) }])
  registerProvider("mock-lifecycle", provider)
  const { events, unsubscribe } = captureEvents()
  const sessionId = nextSessionId()
  try {
    const result = await processTurnLoop({
      prompt: "say hi",
      mode: "agent",
      model: "test",
      providerType: "mock-lifecycle",
      sessionId,
      configState: baseConfig()
    })
    assert.equal(result.reply, "done")
    assertNoStreamEventsAfterTerminal(events, [EVENT_TYPES.TURN_FINISH])
    const session = await getSession(sessionId)
    assert.equal(session?.session?.retryMeta?.inProgress, false, "running state deterministically reset")
  } finally {
    unsubscribe()
  }
})

test("turn lifecycle: error path emits turn.error, zeroes inProgress, and stays silent afterwards", async () => {
  const provider = createStreamProvider([{ error: new Error("boom") }])
  registerProvider("mock-lifecycle", provider)
  const { events, unsubscribe } = captureEvents()
  const sessionId = nextSessionId()
  try {
    const result = await processTurnLoop({
      prompt: "explode",
      mode: "agent",
      model: "test",
      providerType: "mock-lifecycle",
      sessionId,
      configState: baseConfig()
    })
    assert.equal(result.error, "boom")
    assertNoStreamEventsAfterTerminal(events, [EVENT_TYPES.TURN_ERROR])
    const session = await getSession(sessionId)
    assert.equal(session?.session?.retryMeta?.inProgress, false, "failure path must also reset the running flag")
  } finally {
    unsubscribe()
  }
})

test("auto-continue: a spurious max_tokens (usage far below the known cap) does not continue", async () => {
  const provider = createStreamProvider([
    { chunks: textChunks("完整的答案", { output: 50, stopReason: "max_tokens" }) }
  ])
  registerProvider("mock-lifecycle", provider)
  const { events, unsubscribe } = captureEvents()
  try {
    const result = await processTurnLoop({
      prompt: "answer fully",
      mode: "agent",
      model: "test",
      providerType: "mock-lifecycle",
      sessionId: nextSessionId(),
      configState: baseConfig({ max_output_tokens: 4096 })
    })
    assert.equal(result.reply, "完整的答案")
    assert.equal(provider.calls.length, 1, "no second request may be issued for a fabricated truncation")
    assert.ok(!events.some((event) => event.type === EVENT_TYPES.TURN_AUTO_CONTINUE))
  } finally {
    unsubscribe()
  }
})

test("auto-continue: empty max_tokens response (no text/tools/thinking) does not continue", async () => {
  const provider = createStreamProvider([
    { chunks: [{ type: "usage", usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }, { type: "stop", reason: "max_tokens" }] }
  ])
  registerProvider("mock-lifecycle", provider)
  const { events, unsubscribe } = captureEvents()
  try {
    const result = await processTurnLoop({
      prompt: "return nothing",
      mode: "agent",
      model: "test",
      providerType: "mock-lifecycle",
      sessionId: nextSessionId(),
      configState: baseConfig()
    })
    assert.equal(provider.calls.length, 1, "an empty 'truncated' response has no anchor to continue from")
    assert.match(result.error, /空内容.*本轮未完成/)
    assert.match(result.error, /输出达到上限/)
    assert.ok(!events.some(event => event.type === EVENT_TYPES.TURN_FINISH))
    assertNoStreamEventsAfterTerminal(events, [EVENT_TYPES.TURN_ERROR])
    assert.ok(!events.some((event) => event.type === EVENT_TYPES.TURN_AUTO_CONTINUE))
  } finally {
    unsubscribe()
  }
})

test("auto-continue: usage at the known cap is credible truncation and still continues", async () => {
  const provider = createStreamProvider([
    { chunks: textChunks("前半", { output: 4000, stopReason: "max_tokens" }) },
    { chunks: textChunks("后半", { output: 20, stopReason: "end_turn" }) }
  ])
  registerProvider("mock-lifecycle", provider)
  const { events, unsubscribe } = captureEvents()
  try {
    const result = await processTurnLoop({
      prompt: "write something long",
      mode: "agent",
      model: "test",
      providerType: "mock-lifecycle",
      sessionId: nextSessionId(),
      configState: baseConfig({ max_output_tokens: 4096 })
    })
    assert.equal(provider.calls.length, 2, "real truncation still stitches")
    assert.equal(result.reply, "后半")
    assert.equal(events.filter((event) => event.type === EVENT_TYPES.TURN_AUTO_CONTINUE).length, 1)
    assertNoStreamEventsAfterTerminal(events, [EVENT_TYPES.TURN_FINISH])
  } finally {
    unsubscribe()
  }
})

test("render stream close() is a terminal gate: late emissions produce nothing", async () => {
  const emitted = []
  const render = createRenderStream({
    output: null,
    eventBus: { emit: async (event) => { emitted.push(event.type); return event } },
    sessionId: "ses_render_gate",
    turnId: "turn_render_gate"
  })
  render.beginStep(1)
  await render.thinkingDelta(1, "思考")
  assert.deepEqual(emitted, [EVENT_TYPES.STREAM_THINKING_START, EVENT_TYPES.STREAM_THINKING_DELTA])
  render.close()
  await render.thinkingDelta(1, "迟到")
  await render.textDelta(1, "迟到")
  await render.streamEnd(1)
  await render.autoContinue(1, { continueCount: 1, maxContinues: 8 })
  render.beginStep(2)
  assert.equal(emitted.length, 2, "nothing may be emitted after close()")
})

// ── provider 流解析：第一个非空 finish/stop reason 为准 ──────────────

function sseResponse(frames) {
  const text = frames.map((frame) => frame).join("")
  const encoder = new TextEncoder()
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text))
        controller.close()
      }
    }),
    text: async () => text
  }
}

function streamInput(extra = {}) {
  return {
    apiKey: "test-key",
    baseUrl: "https://api.example.test/v1",
    model: "test-model",
    system: "system",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    timeoutMs: 5000,
    retry: { attempts: 1, baseDelayMs: 0, _streamPrimed: true },
    ...extra
  }
}

test("openai stream: a trailing bogus finish_reason cannot rewrite stop to length", async () => {
  const originalFetch = global.fetch
  global.fetch = async () => sseResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    // 收尾之后又追一帧 length —— 兼容网关的真实怪癖；它不得改写终态
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
    "data: [DONE]\n\n"
  ])
  try {
    const events = []
    for await (const chunk of requestOpenAIStream(streamInput())) events.push(chunk)
    const stop = events.find((chunk) => chunk.type === "stop")
    assert.equal(stop.reason, "end_turn", "the first finish_reason is authoritative")
  } finally {
    global.fetch = originalFetch
  }
})

test("openai stream: a genuine truncation keeps its length reason", async () => {
  const originalFetch = global.fetch
  global.fetch = async () => sseResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "cut" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 4096 } })}\n\n`,
    "data: [DONE]\n\n"
  ])
  try {
    const events = []
    for await (const chunk of requestOpenAIStream(streamInput())) events.push(chunk)
    assert.equal(events.find((chunk) => chunk.type === "stop").reason, "max_tokens")
  } finally {
    global.fetch = originalFetch
  }
})

test("anthropic stream: a duplicate stop_reason frame cannot rewrite end_turn", async () => {
  const frames = [
    { event: "message_start", data: { message: { usage: { input_tokens: 10 } } } },
    { event: "content_block_start", data: { content_block: { type: "text" } } },
    { event: "content_block_delta", data: { delta: { type: "text_delta", text: "hi" } } },
    { event: "message_delta", data: { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } },
    // 迟到的重复帧：不得改写第一个 stop_reason
    { event: "message_delta", data: { delta: { stop_reason: "max_tokens" } } },
    { event: "message_stop", data: {} }
  ]
  const originalFetch = global.fetch
  global.fetch = async () => sseResponse(
    frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)
  )
  try {
    const events = []
    for await (const chunk of requestAnthropicStream(streamInput({ maxTokens: 100 }))) events.push(chunk)
    assert.equal(events.find((chunk) => chunk.type === "stop").reason, "end_turn")
  } finally {
    global.fetch = originalFetch
  }
})
