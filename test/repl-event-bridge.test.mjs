import test from "node:test"
import assert from "node:assert/strict"
import { subscribeSessionEvents } from "../src/repl/event-bridge.mjs"
import { createReplUiState } from "../src/repl/ui-state.mjs"
import { EVENT_TYPES } from "../src/core/constants.mjs"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"

/**
 * 引擎事件 → 界面状态。此前是 startTuiRepl 闭包里 118 行的 switch，测不到 ——
 * 而它决定的是「模型正在做什么」在屏幕上如何呈现。
 */

function harness({ autoStartTurn = "turn_1" } = {}) {
  const calls = []
  let handler = null
  const eventBus = {
    subscribe(fn) { handler = fn; return () => { handler = null } }
  }
  const ui = createReplUiState()
  const unsub = subscribeSessionEvents({
    eventBus,
    ui,
    ctx: { configState: { config: structuredClone(DEFAULT_CONFIG) } },
    state: { sessionId: "ses_1", mode: "agent" },
    toastStore: { dismissTopic: (topic) => calls.push(`dismiss(${topic})`) },
    textStreamBatcher: { schedule: () => calls.push("batch") },
    requestRender: () => calls.push("render"),
    appendLog: (text, options) => { calls.push(`appendLog(${options?.status || ""})`); return "log_1" },
    showToast: (message, options) => calls.push(`toast[${options?.topic}](${message})`),
    applyThinkingTransition: (transition) => { ui.thinking = transition.state },
    finalizeThinking: () => calls.push("finalizeThinking"),
    finalizeTextStream: (status) => calls.push(`finalizeStream(${status ?? "default"})`),
    now: () => 1_700_000_000_000
  })
  /** 发一个事件。缺省带上当前会话与回合，以通过归属判定。 */
  const emit = (type, payload = {}, extra = {}) =>
    handler({ type, payload, sessionId: "ses_1", turnId: ui.activeTurnId, ...extra })

  // 回合内的事件必须有一个已建立的活跃回合才会被接受 —— 归属判定是**默认拒绝**的：
  // 缺失关联 ID 不当通配符，否则迟到的或后台的事件能改前台对话。
  // 除非用例要验的正是这条边界，否则先把回合开起来。
  if (autoStartTurn) {
    emit(EVENT_TYPES.TURN_START, {}, { turnId: autoStartTurn })
    calls.length = 0
  }
  return { emit, ui, calls, unsub }
}

test("events from another session are ignored", () => {
  // 后台任务与子智能体共用同一条总线。不判定归属的话，它们的流式增量会画进
  // 当前对话 —— 用户看到的是别人的输出。
  const { emit, ui, calls } = harness()
  ui.streamRaw = ""
  emit(EVENT_TYPES.STREAM_TEXT_DELTA, { text: "别人的输出" }, { sessionId: "ses_other" })
  assert.equal(ui.streamRaw, "")
  assert.deepEqual(calls, [])
})

test("a turn start records the active turn id", () => {
  const { emit, ui } = harness({ autoStartTurn: null })
  emit(EVENT_TYPES.TURN_START, {}, { turnId: "turn_9" })
  assert.equal(ui.activeTurnId, "turn_9")
})

test("a turn-scoped event without an active turn fails closed", () => {
  // 迟到的事件（上一轮已结束、id 已清空）不该改动前台状态
  const { emit, ui, calls } = harness({ autoStartTurn: null })
  emit(EVENT_TYPES.STREAM_TEXT_DELTA, { text: "迟到的增量" }, { turnId: "turn_old" })
  assert.equal(ui.streamRaw, "")
  assert.deepEqual(calls, [])
})

test("an overlapping turn start cannot steal the foreground", () => {
  const { emit, ui } = harness()
  emit(EVENT_TYPES.TURN_START, {}, { turnId: "turn_other" })
  assert.equal(ui.activeTurnId, "turn_1", "另一个回合的 start 不该抢走前台")
})

test("a step start switches to thinking and picks up max_steps from config", () => {
  const { emit, ui, calls } = harness()
  emit(EVENT_TYPES.TURN_STEP_START, { step: 3 })
  assert.equal(ui.currentStep, 3)
  assert.ok(ui.maxSteps > 0, "步数上限来自配置，不该是 0")
  assert.deepEqual(ui.currentActivity, { type: "thinking" })
  assert.ok(calls.includes("render"))
})

test("a tool start shows the tool and its arguments", () => {
  const { emit, ui, calls } = harness()
  emit(EVENT_TYPES.TOOL_START, { tool: "bash", args: { command: "npm test" } })
  assert.deepEqual(ui.currentActivity, { type: "tool", tool: "bash", args: { command: "npm test" } })
  // 工具开始前必须收掉思考与流式文本，否则两个活动指示会同时亮着
  assert.ok(calls.includes("finalizeThinking"))
  assert.ok(calls.some((c) => c.startsWith("finalizeStream")))
})

test("a tool finishing returns to thinking, whether it succeeded or not", () => {
  for (const type of [EVENT_TYPES.TOOL_FINISH, EVENT_TYPES.TOOL_ERROR]) {
    const { emit, ui } = harness()
    emit(EVENT_TYPES.TOOL_START, { tool: "read" })
    emit(type, { tool: "read" })
    assert.deepEqual(ui.currentActivity, { type: "thinking" }, `${type} 之后应回到思考态`)
  }
})

test("text deltas accumulate without repainting per token", () => {
  // 每个 token 一帧会把终端刷爆；重绘由 batcher 按帧节流
  const { emit, ui, calls } = harness()
  emit(EVENT_TYPES.STREAM_TEXT_START, {})
  const renderCountAfterStart = calls.filter((c) => c === "render").length
  for (const chunk of ["一", "二", "三"]) emit(EVENT_TYPES.STREAM_TEXT_DELTA, { text: chunk })
  assert.equal(ui.streamRaw, "一二三")
  assert.equal(calls.filter((c) => c === "batch").length, 3)
  assert.equal(calls.filter((c) => c === "render").length, renderCountAfterStart,
    "增量本身不该直接触发重绘")
})

test("a delta accepts either text or content", () => {
  // 不同渠道的字段名不一致
  const { emit, ui } = harness()
  emit(EVENT_TYPES.STREAM_TEXT_DELTA, { content: "来自 content 字段" })
  assert.equal(ui.streamRaw, "来自 content 字段")
})

test("a text stream opens a streaming transcript entry", () => {
  const { emit, ui, calls } = harness()
  emit(EVENT_TYPES.STREAM_TEXT_START, {})
  assert.equal(ui.streamLogId, "log_1")
  assert.equal(ui.streamRaw, "")
  assert.ok(calls.includes("appendLog(streaming)"))
})

test("thinking deltas grow the thinking state", () => {
  const { emit, ui } = harness()
  emit(EVENT_TYPES.STREAM_THINKING_START, {})
  emit(EVENT_TYPES.STREAM_THINKING_DELTA, { text: "在想" })
  emit(EVENT_TYPES.STREAM_THINKING_DELTA, { text: "一件事" })
  assert.equal(ui.thinking.phase, "streaming")
  assert.match(ui.thinking.raw || "", /在想一件事/, "增量要累积到 raw 上")
})

test("compaction is reported as a toast with the token delta", () => {
  const { emit, calls } = harness()
  emit(EVENT_TYPES.SESSION_COMPACTED, { beforeTokens: 120000, afterTokens: 30000 })
  const toast = calls.find((c) => c.startsWith("toast[compaction]"))
  assert.ok(toast, "压缩应当有提示")
  assert.match(toast, /→/, "要报出前后对比，而不只是「已压缩」")
})

test("compaction without token counts still says something useful", () => {
  const { emit, calls } = harness()
  emit(EVENT_TYPES.SESSION_COMPACTED, { summarizedCount: 42 })
  assert.match(calls.find((c) => c.startsWith("toast[compaction]")), /42 messages/)
})

test("a live usage update never shows a made-up cost", () => {
  // 渠道与模型的计价要等回合结束才确定。把写死的费率当实时估算会给出一个
  // 看起来精确、实际是编的数字。
  const { emit, ui } = harness()
  ui.metrics.cost = 1.23
  emit(EVENT_TYPES.TURN_USAGE_UPDATE, { usage: { input: 100, output: 50 }, context: { percent: 40 } })
  assert.equal(ui.metrics.cost, null, "回合中的费用必须是空，不能是估算值")
  assert.equal(ui.metrics.tokenMeter.estimated, true)
  assert.deepEqual(ui.metrics.tokenMeter.turn, { input: 100, output: 50 })
  assert.deepEqual(ui.metrics.context, { percent: 40 })
})

test("a provider retry is announced and shown as still working", () => {
  const { emit, ui, calls } = harness()
  emit(EVENT_TYPES.PROVIDER_RETRY, { retryAttempt: 2, maxRetries: 5, classification: "timeout", delayMs: 800 })
  const toast = calls.find((c) => c.startsWith("toast[provider-retry]"))
  assert.match(toast, /2\/5/)
  assert.match(toast, /timeout/, "要说明为什么在重试")
  assert.deepEqual(ui.currentActivity, { type: "thinking" })
})

test("finishing a turn clears the activity and dismisses the retry toast", () => {
  // 重连提示要主动撤掉：回合已经结束，留着它会让人以为还在重试
  const { emit, ui, calls } = harness()
  emit(EVENT_TYPES.TOOL_START, { tool: "read" })
  emit(EVENT_TYPES.TURN_FINISH, {})
  assert.equal(ui.currentActivity, null)
  assert.equal(ui.currentStep, 0)
  assert.equal(ui.activeTurnId, null)
  assert.ok(calls.includes("dismiss(provider-retry)"))
  assert.ok(calls.includes("finalizeStream(default)"), "正常结束按完成态收流")
})

test("a turn error closes the stream in the error state", () => {
  const { emit, ui, calls } = harness()
  emit(EVENT_TYPES.TURN_ERROR, {})
  assert.ok(calls.includes("finalizeStream(error)"), "出错时收流的状态与正常结束不同")
  assert.equal(ui.activeTurnId, null)
  assert.ok(calls.includes("dismiss(provider-retry)"))
})

test("an unknown event type is ignored rather than throwing", () => {
  const { emit } = harness()
  assert.doesNotThrow(() => emit("some.future.event", {}))
})

test("the bridge no longer maintains a state nobody reads", async () => {
  // 这里原本有 `ui.appState = reduceAppState(ui.appState, event)` —— 一套完整的
  // reducer，全代码库零读取方，每个流式增量都全量复制数组。实测 200 轮之后持有
  // 2.8 MB、200 个 block，无上限。
  const { readFile } = await import("node:fs/promises")
  const src = await readFile(new URL("../src/repl/event-bridge.mjs", import.meta.url), "utf8")
  const uiState = await readFile(new URL("../src/repl/ui-state.mjs", import.meta.url), "utf8")
  for (const [name, text] of [["event-bridge", src], ["ui-state", uiState]]) {
    const calls = text.split("\n").filter((line) => {
      const trimmed = line.trim()
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) return false
      return /reduceAppState|createAppState|ui\.appState/.test(trimmed)
    })
    assert.deepEqual(calls, [], `${name} 里又出现了没人读的并行状态:\n${calls.join("\n")}`)
  }
})
