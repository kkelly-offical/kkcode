import test from "node:test"
import assert from "node:assert/strict"
import {
  subscribeSessionEvents,
  describeReplTitle,
  isUserInterruptedTurn
} from "../src/repl/event-bridge.mjs"
import { createReplUiState } from "../src/repl/ui-state.mjs"
import { EVENT_TYPES } from "../src/core/constants.mjs"
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs"

/**
 * 引擎事件 → 界面状态。此前是 startTuiRepl 闭包里 118 行的 switch，测不到 ——
 * 而它决定的是「模型正在做什么」在屏幕上如何呈现。
 */

/**
 * 假通知器。所有调用记在一条**有序**日志里 —— 「通知写完标题之后有没有人把它
 * 盖掉」这种问题，只看两个分开的数组是答不出来的。
 */
function fakeNotifier({ alertResult = { title: true, bell: false, desktop: false } } = {}) {
  const log = []
  return {
    log,
    titles: () => log.filter((entry) => entry.kind === "title").map((entry) => entry.text),
    alerts: () => log.filter((entry) => entry.kind === "alert"),
    setTitle(text) { log.push({ kind: "title", text }); return alertResult.title },
    clearTitle() { log.push({ kind: "clear" }); return true },
    alert(kind, detail) { log.push({ kind: "alert", alert: kind, detail }); return alertResult },
    setFocused() {},
    dispose() { log.push({ kind: "dispose" }) }
  }
}

const START_TIME = 1_700_000_000_000

function harness({ autoStartTurn = "turn_1", notifier = null, cwd = "/home/me/demo-project" } = {}) {
  const calls = []
  let handler = null
  const clock = { now: START_TIME }
  const eventBus = {
    subscribe(fn) { handler = fn; return () => { handler = null } }
  }
  const ui = createReplUiState()
  const unsub = subscribeSessionEvents({
    eventBus,
    ui,
    notifier,
    // cwd 是 subscribeSessionEvents 的**显式参数**，不是 ctx 的字段。
    // 0.7.2 之前这里写的是 `ctx.cwd`，而生产代码构造的 ctx 上根本没有它 ——
    // 测试自己造了一个只在测试里为真的世界，于是标题里的项目名从没显示过，
    // 而断言一直是绿的。两边现在喂的是同一个入口。
    ctx: { configState: { config: structuredClone(DEFAULT_CONFIG) } },
    cwd,
    state: { sessionId: "ses_1", mode: "agent" },
    toastStore: { dismissTopic: (topic) => calls.push(`dismiss(${topic})`) },
    textStreamBatcher: { schedule: () => calls.push("batch") },
    requestRender: () => calls.push("render"),
    appendLog: (text, options) => { calls.push(`appendLog(${options?.status || ""})`); return "log_1" },
    showToast: (message, options) => calls.push(`toast[${options?.topic}](${message})`),
    applyThinkingTransition: (transition) => { ui.thinking = transition.state },
    finalizeThinking: () => calls.push("finalizeThinking"),
    finalizeTextStream: (status) => calls.push(`finalizeStream(${status ?? "default"})`),
    now: () => clock.now
  })
  const advance = (ms) => { clock.now += ms }
  /** 发一个事件。缺省带上当前会话与回合，以通过归属判定。 */
  const emit = (type, payload = {}, extra = {}) =>
    handler({ type, payload, sessionId: "ses_1", turnId: ui.activeTurnId, ...extra })

  // 回合内的事件必须有一个已建立的活跃回合才会被接受 —— 归属判定是**默认拒绝**的：
  // 缺失关联 ID 不当通配符，否则迟到的或后台的事件能改前台对话。
  // 除非用例要验的正是这条边界，否则先把回合开起来。
  if (autoStartTurn) {
    emit(EVENT_TYPES.TURN_START, {}, { turnId: autoStartTurn })
    calls.length = 0
    notifier?.log.splice(0)
  }
  return { emit, ui, calls, unsub, advance }
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
  // 重试不是「还在想」：次数与原因进活动态，busy 行直接显示 Retrying 2/5
  assert.deepEqual(ui.currentActivity, { type: "retry", attempt: 2, max: 5, classification: "timeout" })
})

test("compaction shows a compacting activity and settles back when done", () => {
  const { emit, ui, calls } = harness()
  emit(EVENT_TYPES.SESSION_COMPACTING, {})
  assert.deepEqual(ui.currentActivity, { type: "compacting" }, "压缩进行中要有自己的状态")
  emit(EVENT_TYPES.SESSION_COMPACTED, { beforeTokens: 120000, afterTokens: 30000 })
  assert.deepEqual(ui.currentActivity, { type: "thinking" }, "压缩结束后回到思考态")
  assert.ok(calls.find((c) => c.startsWith("toast[compaction]")), "结果提示保留")
})

test("a late compacted event does not resurrect an activity after the turn ended", () => {
  const { emit, ui } = harness()
  emit(EVENT_TYPES.TURN_FINISH, {})
  emit(EVENT_TYPES.SESSION_COMPACTED, { beforeTokens: 120000, afterTokens: 30000 })
  assert.equal(ui.currentActivity, null, "回合已结束，迟到的 compacted 不该把活动改回 thinking")
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

/**
 * 通知（0.7.2）。这里只决定「什么时候值得把人叫回来」——「怎么叫」（响铃、桌面
 * 通知、min_duration_ms 阈值）全在 repl/notify.mjs，有它自己的测试。
 */

test("without a notifier the bridge behaves exactly as before", () => {
  // 不传就完全不通知。这条防的是 `notifier.setTitle(...)` 少一层保护 ——
  // 那会在没有通知器的会话里每个事件抛一次 TypeError。
  const run = (notifier) => {
    const h = harness({ notifier })
    h.emit(EVENT_TYPES.TURN_STEP_START, { step: 1 })
    h.emit(EVENT_TYPES.TOOL_START, { tool: "bash" })
    h.emit(EVENT_TYPES.STREAM_TEXT_START, {})
    h.emit(EVENT_TYPES.STREAM_TEXT_DELTA, { text: "hi" })
    h.emit(EVENT_TYPES.TURN_FINISH, { reply: "hi" })
    return h.calls
  }
  let quiet = null
  assert.doesNotThrow(() => { quiet = run(null) })
  assert.deepEqual(quiet, run(fakeNotifier()), "接上通知器不该改变界面侧的行为")
})

test("a finished turn is announced with the time it actually took", () => {
  const notifier = fakeNotifier()
  const { emit, advance } = harness({ notifier })
  advance(45_000)
  emit(EVENT_TYPES.TURN_FINISH, { reply: "改完了\n还有别的" })
  assert.deepEqual(notifier.alerts(), [{
    kind: "alert",
    alert: "turn-done",
    detail: { durationMs: 45_000, summary: "改完了" }
  }])
})

test("the duration threshold is not second-guessed here", () => {
  // 阈值判定只有一处（notify.mjs）。这里再判一次的话，配置改了阈值也不生效。
  const notifier = fakeNotifier()
  const { emit, advance } = harness({ notifier })
  advance(1_200)
  emit(EVENT_TYPES.TURN_FINISH, { reply: "秒回" })
  assert.deepEqual(notifier.alerts().map((entry) => entry.detail.durationMs), [1_200],
    "短回合也要照常上报时长，由 notify 决定弹不弹")
})

test("someone else's turn ending never notifies you", () => {
  // 通知也得在归属判定之后 —— 后台任务与子智能体共用同一条总线，判定挪到通知
  // 后面的话，别人的回合跑完会响你的铃。同时这也保证了 durationMs 一定有锚点：
  // 能被接受的 TURN_FINISH，前面必然有一个被接受的 TURN_START。
  const notifier = fakeNotifier()
  const { emit } = harness({ notifier })
  emit(EVENT_TYPES.TURN_FINISH, { reply: "别人的结果" }, { sessionId: "ses_other" })
  emit(EVENT_TYPES.TURN_FINISH, { reply: "别的回合" }, { turnId: "turn_other" })
  assert.deepEqual(notifier.alerts(), [])

  const late = harness({ notifier: fakeNotifier(), autoStartTurn: null })
  late.emit(EVENT_TYPES.TURN_FINISH, { reply: "迟到的结束" }, { turnId: "turn_old" })
  assert.deepEqual(late.calls, [], "没有活跃回合时，迟到的结束事件整条都该被挡住")
})

test("a failed turn reports the error instead of a completion", () => {
  // 两条一起发的话，一次失败会响两遍铃、弹两个窗（error 不受时长阈值约束，
  // turn-done 受）。回合终结时只发一条。
  const notifier = fakeNotifier()
  const { emit, advance } = harness({ notifier })
  advance(60_000)
  emit(EVENT_TYPES.TURN_ERROR, { error: "provider 502" })
  assert.deepEqual(notifier.alerts(), [{
    kind: "alert",
    alert: "error",
    detail: { message: "provider 502" }
  }])
})

test("a turn the user interrupted is not announced at all", () => {
  // Esc / Ctrl+C：人就在键盘前，他刚按的键。既不是完成，也不值得弹窗。
  const notifier = fakeNotifier()
  const { emit, ui, advance } = harness({ notifier })
  ui.paused = true   // 按键处理器在中断时立起来的那一位
  advance(120_000)
  emit(EVENT_TYPES.TURN_ERROR, { error: "provider stream cancelled" })
  assert.deepEqual(notifier.alerts(), [])
})

test("an interrupted turn is recognised even without the paused flag", () => {
  assert.equal(isUserInterruptedTurn({ paused: false }, { error: "provider stream cancelled" }), true)
  assert.equal(isUserInterruptedTurn({ paused: false }, { aborted: true }), true)
  assert.equal(isUserInterruptedTurn({ paused: false }, { error: "The operation was aborted" }), true)
  assert.equal(isUserInterruptedTurn({ paused: false }, { error: "provider 502" }), false)
  assert.equal(isUserInterruptedTurn({}, {}), false)
})

test("the terminal title says what is happening, and where you are when nothing is", () => {
  assert.equal(describeReplTitle({ activity: null, cwd: "/home/me/demo-project" }), "kkcode · demo-project")
  // Windows 上 cwd 是反斜杠。只切 `/` 的话整条路径会当成项目名写进标题。
  assert.equal(describeReplTitle({ activity: null, cwd: "C:\\Users\\me\\demo-project" }), "kkcode · demo-project")
  assert.equal(describeReplTitle({ activity: null, cwd: "" }), "kkcode")
  assert.equal(describeReplTitle({ activity: { type: "thinking" } }), "● kkcode · thinking")
  assert.equal(describeReplTitle({ activity: { type: "writing" } }), "● kkcode · writing")
  assert.equal(describeReplTitle({ activity: { type: "tool", tool: "bash" } }), "● kkcode · bash")
  assert.equal(describeReplTitle({ activity: { type: "retry" } }), "● kkcode · retrying")
  assert.equal(describeReplTitle({ activity: { type: "compacting" } }), "● kkcode · compacting")
})

test("a stream of deltas writes the title once, not once per token", () => {
  // 每个 delta 一条 OSC 2 会把终端刷爆 —— 而且是**在用户的终端上**刷爆。
  const notifier = fakeNotifier()
  const { emit, advance } = harness({ notifier })
  advance(300)
  emit(EVENT_TYPES.STREAM_TEXT_START, {})
  for (let i = 0; i < 100; i++) {
    advance(10)   // 100 个 token 摊在一秒里，节流窗口会开好几次
    emit(EVENT_TYPES.STREAM_TEXT_DELTA, { text: "字" })
  }
  assert.deepEqual(notifier.titles(), ["● kkcode · writing"],
    "标题内容没变就不该再写一次")
})

test("a flapping activity cannot machine-gun the title", () => {
  const notifier = fakeNotifier()
  const { emit, advance } = harness({ notifier })
  advance(300)
  // 一串快工具：tool → thinking → tool …，全发生在同一毫秒里
  for (let i = 0; i < 50; i++) {
    emit(EVENT_TYPES.TOOL_START, { tool: "bash" })
    emit(EVENT_TYPES.TOOL_FINISH, { tool: "bash" })
  }
  assert.deepEqual(notifier.titles(), ["● kkcode · bash"], "节流窗口内的横跳应当被丢掉")

  // 但节流不能变成静音：窗口过去之后，新状态必须能落地
  advance(300)
  emit(EVENT_TYPES.TOOL_START, { tool: "read" })
  assert.deepEqual(notifier.titles(), ["● kkcode · bash", "● kkcode · read"])
})

test("the completion notice is not overwritten by the idle title", () => {
  // alert() 自己会把结果写进标题。紧接着再写一次空闲标题，用户切回来就只看到项目名 ——
  // 回合结束通知的全部意义就没了。
  const notifier = fakeNotifier()
  const { emit, advance } = harness({ notifier })
  advance(45_000)
  emit(EVENT_TYPES.TURN_FINISH, { reply: "done" })
  assert.equal(notifier.log.at(-1).kind, "alert", "通知之后不该再有标题写入")

  // 也不能被回合**之后**的事件盖掉。压缩提示、MCP 心跳这些不属于任何回合，
  // 归属判定放行，会一路走到标题同步 —— 而那时用户可能还没切回窗口。
  advance(5_000)
  emit(EVENT_TYPES.SESSION_COMPACTED, { beforeTokens: 120_000, afterTokens: 30_000 })
  assert.equal(notifier.log.at(-1).kind, "alert", "回合之后的事件也不能盖掉通知文案")
})

test("when nothing was announced the title falls back to the project", () => {
  // notify 因为时长不够没弹时（alert 返回 title:false），标题得自己收回空闲态，
  // 否则会一直停在「● kkcode · thinking」。
  const notifier = fakeNotifier({ alertResult: { title: false, bell: false, desktop: false } })
  const { emit, advance } = harness({ notifier })
  advance(2_000)
  emit(EVENT_TYPES.TURN_FINISH, { reply: "done" })
  assert.equal(notifier.titles().at(-1), "kkcode · demo-project")
})

test("the idle title lands even inside the throttle window", () => {
  // 回合结束是终态：它后面可能一个事件都没有了，被节流丢掉就永远补不回来。
  const notifier = fakeNotifier({ alertResult: { title: false, bell: false, desktop: false } })
  const { emit } = harness({ notifier })
  emit(EVENT_TYPES.TOOL_START, { tool: "bash" })   // 与回合开始同一毫秒
  emit(EVENT_TYPES.TURN_FINISH, { reply: "done" })
  assert.equal(notifier.titles().at(-1), "kkcode · demo-project")
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
